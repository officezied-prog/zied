"""Ingestion jobs: turn uploaded media into wardrobe items."""
from __future__ import annotations

from uuid import UUID, uuid4

from fastapi import APIRouter, Response, status

from ..db import execute, fetch_all, fetch_one
from ..deps import ConnDep, IdempotencyDep, PrincipalDep
from ..errors import InvalidRequest, NotFound
from ..schemas import IngestJob, IngestJobCreate

router = APIRouter(prefix="/v1/ingest", tags=["Social ingestion"])

# Constant projection interpolated into the queries below; never user input.
_JOB_COLUMNS = """
    id, source::text as source, status::text as status, items_discovered,
    items_processed, items_failed, garments_created, needs_review,
    error_code, queued_at, finished_at
"""


@router.post("/jobs", response_model=IngestJob, status_code=status.HTTP_202_ACCEPTED)
async def create_ingest_job(body: IngestJobCreate, conn: ConnDep, principal: PrincipalDep,
                            idempotency: IdempotencyDep, response: Response):
    if idempotency:
        existing = await fetch_one(conn, f"""
            select {_JOB_COLUMNS} from public.ingest_jobs
             where user_id = :uid and idempotency_key = :key
        """, {"uid": str(principal.user_id), "key": idempotency})  # noqa: S608
        if existing:
            # Replaying a key must never start a second run.
            response.status_code = status.HTTP_200_OK
            return dict(existing)

    ids = [str(m) for m in body.media_ids]
    owned = await fetch_all(conn, """
        select id from public.media_assets
         where user_id = :uid and id = any(cast(:ids as uuid[])) and deleted_at is null
    """, {"uid": str(principal.user_id), "ids": ids})
    owned_ids = [r["id"] for r in owned]
    if not owned_ids:
        raise InvalidRequest("None of the supplied media ids belong to this user.")

    job_id = uuid4()
    row = await fetch_one(conn, f"""
        insert into public.ingest_jobs
            (id, user_id, source, status, items_discovered, items_downloaded,
             auto_accept, idempotency_key)
        values (:id, :uid, 'manual_upload', 'queued', :n, :n, :auto, :key)
        returning {_JOB_COLUMNS}
    """, {"id": str(job_id), "uid": str(principal.user_id), "n": len(owned_ids),  # noqa: S608
          "auto": body.auto_accept, "key": idempotency})

    await execute(conn, """
        insert into public.ingest_job_items (job_id, user_id, media_asset_id)
        select :job, :uid, unnest(cast(:ids as uuid[]))
        on conflict do nothing
    """, {"job": str(job_id), "uid": str(principal.user_id),
          "ids": [str(i) for i in owned_ids]})

    return dict(row)


@router.get("/jobs/{job_id}", response_model=IngestJob)
async def get_ingest_job(job_id: UUID, conn: ConnDep, principal: PrincipalDep):
    row = await fetch_one(conn, f"""
        select {_JOB_COLUMNS} from public.ingest_jobs where id = :id and user_id = :uid
    """, {"id": str(job_id), "uid": str(principal.user_id)})  # noqa: S608
    if row is None:
        raise NotFound("Ingest job", str(job_id))
    data = dict(row)
    data["poll_after_ms"] = 1500 if data["status"] in ("queued", "running") else 0
    return data


@router.get("/jobs")
async def list_ingest_jobs(conn: ConnDep, principal: PrincipalDep, limit: int = 50):
    rows = await fetch_all(conn, f"""
        select {_JOB_COLUMNS} from public.ingest_jobs
         where user_id = :uid order by queued_at desc limit :limit
    """, {"uid": str(principal.user_id), "limit": min(limit, 200)})  # noqa: S608
    return {"items": [dict(r) for r in rows], "next_cursor": None}
