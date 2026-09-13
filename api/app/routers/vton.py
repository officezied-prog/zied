"""Virtual try-on."""
from __future__ import annotations

from uuid import UUID, uuid4

from fastapi import APIRouter, Query, Response, status

from ..db import execute, fetch_all, fetch_one
from ..deps import ConnDep, IdempotencyDep, PrincipalDep, SettingsDep
from ..errors import ConsentRequired, InvalidRequest, NotFound, QuotaExceeded
from ..schemas import VtonJob, VtonJobCreate, VtonModel
from ..storage import get_store

router = APIRouter(prefix="/v1/vton", tags=["Virtual try-on"])

_JOB_COLUMNS = """
    j.id, j.status::text as status, j.model_id, j.outfit_id, j.garment_ids,
    j.pass_index, j.pass_total, j.qa_score, j.qa_flags, j.duration_ms,
    j.error_code, j.expires_at, j.queued_at, j.result_media_id,
    m.bucket as result_bucket, m.storage_key as result_key
"""


@router.get("/models", response_model=list[VtonModel])
async def list_models(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep):
    rows = await fetch_all(conn, """
        select id, display_name, family, supports_roles::text[] as supports_roles,
               supports_multi_garment, avg_latency_ms, commercial_ok
          from public.vton_models where is_enabled order by quality_score desc nulls last
    """)
    return [
        VtonModel(**{k: v for k, v in dict(r).items() if k != "commercial_ok"},
                  available_to_user=bool(r["commercial_ok"])
                  or settings.vton_allow_noncommercial_models)
        for r in rows
    ]


@router.post("/jobs", response_model=VtonJob, status_code=status.HTTP_202_ACCEPTED)
async def create_job(body: VtonJobCreate, conn: ConnDep, principal: PrincipalDep,
                     settings: SettingsDep, idempotency: IdempotencyDep,
                     response: Response):
    from workers.vton.pipeline import cache_key

    if not await _has_consent(conn, principal.user_id, "vton_processing"):
        raise ConsentRequired("vton_processing")

    if idempotency:
        existing = await fetch_one(conn, f"""
            select {_JOB_COLUMNS} from public.vton_jobs j
              left join public.media_assets m on m.id = j.result_media_id
             where j.user_id = :uid and j.idempotency_key = :key
        """, {"uid": str(principal.user_id), "key": idempotency})  # noqa: S608
        if existing:
            response.status_code = status.HTTP_200_OK
            return _to_job(existing, settings)

    garment_ids = await _resolve_garments(conn, principal.user_id, body)
    body_photo_id = await _resolve_body_photo(conn, principal.user_id, body.body_photo_id)
    model_id = await _resolve_model(conn, body.model_id, settings)

    params = body.params.model_dump(exclude_none=True)
    seed = params.pop("seed", 0)
    key = cache_key(body_photo_id=body_photo_id, garment_ids=garment_ids,
                    model_id=model_id, params=params, seed=seed)

    cached = await fetch_one(conn, f"""
        select {_JOB_COLUMNS} from public.vton_jobs j
          left join public.media_assets m on m.id = j.result_media_id
         where j.user_id = :uid and j.cache_key = :key and j.status = 'succeeded'
           and (j.expires_at is null or j.expires_at > now())
         order by j.finished_at desc limit 1
    """, {"uid": str(principal.user_id), "key": key})  # noqa: S608
    if cached:
        # An identical render already exists: return it, and charge nothing.
        response.status_code = status.HTTP_200_OK
        job = _to_job(cached, settings)
        job.cache_hit = True
        return job

    allowed = await fetch_one(conn, "select public.consume_quota(:u, 'vton_renders', 1) as ok",
                              {"u": str(principal.user_id)})
    if not allowed["ok"]:
        raise QuotaExceeded("vton_renders")

    job_id = uuid4()
    await execute(conn, """
        insert into public.vton_jobs
            (id, user_id, outfit_id, model_id, body_photo_id, garment_ids, params, seed,
             status, priority, idempotency_key, cache_key)
        values (:id, :uid, :outfit, :model, :photo, cast(:garments as uuid[]),
                cast(:params as jsonb), :seed, 'queued', 5, :key, :cache)
    """, {"id": str(job_id), "uid": str(principal.user_id),
          "outfit": str(body.outfit_id) if body.outfit_id else None, "model": model_id,
          "photo": str(body_photo_id), "garments": [str(g) for g in garment_ids],
          "params": _json(params), "seed": seed, "key": idempotency, "cache": key})

    row = await fetch_one(conn, f"""
        select {_JOB_COLUMNS} from public.vton_jobs j
          left join public.media_assets m on m.id = j.result_media_id
         where j.id = :id
    """, {"id": str(job_id)})  # noqa: S608
    job = _to_job(row, settings)
    job.queue_position = await _queue_position(conn, job_id)
    return job


@router.get("/jobs", response_model=list[VtonJob])
async def list_jobs(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep,
                    status_filter: str | None = None, limit: int = Query(20, ge=1, le=100)):
    where = ["j.user_id = :uid"]
    params: dict = {"uid": str(principal.user_id), "limit": limit}
    if status_filter:
        where.append("j.status = cast(:st as public.job_status)")
        params["st"] = status_filter
    rows = await fetch_all(conn, f"""
        select {_JOB_COLUMNS} from public.vton_jobs j
          left join public.media_assets m on m.id = j.result_media_id
         where {' and '.join(where)}
         order by j.queued_at desc limit :limit
    """, params)  # noqa: S608
    return [_to_job(r, settings) for r in rows]


@router.get("/jobs/{job_id}", response_model=VtonJob)
async def get_job(job_id: UUID, conn: ConnDep, principal: PrincipalDep,
                  settings: SettingsDep):
    row = await fetch_one(conn, f"""
        select {_JOB_COLUMNS} from public.vton_jobs j
          left join public.media_assets m on m.id = j.result_media_id
         where j.id = :id and j.user_id = :uid
    """, {"id": str(job_id), "uid": str(principal.user_id)})  # noqa: S608
    if row is None:
        raise NotFound("Try-on job", str(job_id))
    job = _to_job(row, settings)
    if job.status in ("queued", "running"):
        job.queue_position = await _queue_position(conn, job_id)
    return job


@router.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_job(job_id: UUID, conn: ConnDep, principal: PrincipalDep):
    result = await execute(conn, """
        update public.vton_jobs
           set status = case when status in ('queued','running')
                             then 'cancelled'::public.job_status else status end,
               expires_at = now()
         where id = :id and user_id = :uid
    """, {"id": str(job_id), "uid": str(principal.user_id)})
    if result.rowcount == 0:
        raise NotFound("Try-on job", str(job_id))


# ── helpers ─────────────────────────────────────────────────────────────────
async def _has_consent(conn, user_id: UUID, consent: str) -> bool:
    row = await fetch_one(conn, "select public.has_consent(:u, cast(:c as public.consent_type)) as ok",
                          {"u": str(user_id), "c": consent})
    return bool(row["ok"])


async def _resolve_garments(conn, user_id: UUID, body: VtonJobCreate) -> list[UUID]:
    if body.outfit_id:
        rows = await fetch_all(conn, """
            select oi.garment_id from public.outfit_items oi
              join public.outfits o on o.id = oi.outfit_id
             where oi.outfit_id = :o and o.user_id = :u
               and oi.role in ('base_top','mid_layer','outerwear','bottom','full_body','footwear')
        """, {"o": str(body.outfit_id), "u": str(user_id)})
        if not rows:
            raise NotFound("Outfit", str(body.outfit_id))
        return [r["garment_id"] for r in rows][:5]

    if not body.garment_ids:
        raise InvalidRequest("Provide either outfit_id or garment_ids.")

    rows = await fetch_all(conn, """
        select id from public.garments
         where user_id = :u and id = any(cast(:ids as uuid[])) and deleted_at is null
    """, {"u": str(user_id), "ids": [str(g) for g in body.garment_ids]})
    if len(rows) != len(body.garment_ids):
        raise InvalidRequest("One or more garments do not exist in your wardrobe.")
    return [r["id"] for r in rows]


async def _resolve_body_photo(conn, user_id: UUID, photo_id: UUID | None) -> UUID:
    photos = await fetch_all(conn, "select * from public.list_body_photos()")
    if not photos:
        raise InvalidRequest("Upload a body photo before requesting a try-on.")
    if photo_id is None:
        return photos[0]["id"]                       # list is primary-first
    if photo_id not in {p["id"] for p in photos}:
        raise NotFound("Body photo", str(photo_id))
    return photo_id


async def _resolve_model(conn, requested: str | None, settings) -> str:
    row = await fetch_one(conn, """
        select id, commercial_ok from public.vton_models
         where is_enabled and (cast(:req as text) is null or id = :req)
         order by (id = :req) desc, quality_score desc nulls last limit 1
    """, {"req": requested})
    if row is None:
        raise InvalidRequest(f"Unknown try-on model: {requested}")
    if not row["commercial_ok"] and not settings.vton_allow_noncommercial_models:
        # Licence gate: a non-commercial checkpoint must not serve paid traffic.
        raise InvalidRequest(
            f"Model {row['id']} is not licensed for this deployment.",
            model_id=row["id"])
    return row["id"]


async def _queue_position(conn, job_id: UUID) -> int | None:
    row = await fetch_one(conn, """
        select count(*) + 1 as pos from public.vton_jobs ahead
         where ahead.status = 'queued'
           and (ahead.priority, ahead.queued_at) <
               (select j.priority, j.queued_at from public.vton_jobs j where j.id = :id)
    """, {"id": str(job_id)})
    return int(row["pos"]) if row else None


def _to_job(row, settings) -> VtonJob:
    d = dict(row)
    url = None
    if d.get("result_key"):
        url = get_store(settings).presign_get(d["result_bucket"], d["result_key"],
                                              ttl=settings.read_url_ttl_seconds)
    return VtonJob(
        id=d["id"], status=d["status"], model_id=d["model_id"], outfit_id=d["outfit_id"],
        garment_ids=list(d["garment_ids"] or []), pass_index=d["pass_index"],
        total_passes=d["pass_total"], result_url=url,
        qa_score=float(d["qa_score"]) if d["qa_score"] is not None else None,
        qa_flags=list(d["qa_flags"] or []), duration_ms=d["duration_ms"],
        error_code=d["error_code"], expires_at=d["expires_at"], queued_at=d["queued_at"],
        poll_after_ms=0 if d["status"] not in ("queued", "running") else 3000,
    )


def _json(value) -> str:
    import json

    return json.dumps(value)
