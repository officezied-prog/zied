"""Try-on rendering pipeline.

    prepare body photo (cached)  ->  plan passes  ->  render  ->  QA  ->  store

Layering is sequential: most try-on checkpoints drape one garment, so pass *n*
takes pass *n-1*'s output as its person image. The pass order follows how
clothes are actually put on — base layer, bottom, mid layer, outerwear,
accessories — because a coat rendered under a shirt looks wrong in a way no
amount of model quality fixes.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
from dataclasses import dataclass, field
from uuid import UUID, uuid4

import numpy as np
from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.config import Settings
from api.app.db import execute, fetch_all, fetch_one
from api.app.storage import ObjectStore
from workers.vision.images import load_normalised

from .preprocess import BodyZones, GeometricBodyParser
from .providers import GarmentLayer, RenderRequest, build_provider
from .qa import inspect

log = logging.getLogger("smartstylist.vton")

# The order garments are put on. Anything unlisted goes last.
PASS_ORDER = ["hosiery", "base_top", "full_body", "bottom", "belt", "mid_layer",
              "outerwear", "footwear", "scarf", "bag", "headwear", "eyewear",
              "jewelry", "watch"]


@dataclass
class VtonOutcome:
    job_id: UUID
    status: str
    result_media_id: UUID | None = None
    passes: int = 0
    duration_ms: int = 0
    cost_usd: float = 0.0
    qa_score: float | None = None
    qa_flags: list[str] = field(default_factory=list)
    error_code: str | None = None
    error_detail: str | None = None
    cache_hit: bool = False


def cache_key(*, body_photo_id: UUID, garment_ids: list[UUID], model_id: str,
              params: dict, seed: int | None) -> str:
    payload = json.dumps({
        "body": str(body_photo_id),
        "garments": sorted(str(g) for g in garment_ids),
        "model": model_id,
        "params": {k: params[k] for k in sorted(params)},
        "seed": seed,
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


class VtonPipeline:
    def __init__(self, *, settings: Settings, store: ObjectStore,
                 parser: GeometricBodyParser | None = None) -> None:
        self.settings = settings
        self.store = store
        self.parser = parser or GeometricBodyParser()

    # ── body photo preparation ──────────────────────────────────────────────
    async def prepare_body_photo(self, conn: AsyncConnection, photo_id: UUID) -> BodyZones:
        row = await fetch_one(conn, """
            select p.id, p.zones, p.prep_status::text as prep_status,
                   m.bucket, m.storage_key
              from private.body_reference_photos p
              join public.media_assets m on m.id = p.media_asset_id
             where p.id = :id
        """, {"id": str(photo_id)})
        if row is None:
            raise BodyPhotoMissing(str(photo_id))

        if row["prep_status"] == "succeeded" and row["zones"]:
            return BodyZones.from_dict(row["zones"])

        image = load_normalised(self.store.get_bytes(row["bucket"], row["storage_key"]),
                                max_side=self.settings.max_image_side)
        _, zones = self.parser.parse(image.rgb)

        await execute(conn, """
            update private.body_reference_photos
               set prep_status = :status, zones = cast(:zones as jsonb),
                   person_bbox = :bbox, quality_score = :quality,
                   quality_issues = cast(:issues as text[]), prep_error = :err
             where id = :id
        """, {"status": "succeeded" if zones.quality_score > 0 else "failed",
              "zones": json.dumps(zones.as_dict()), "bbox": list(zones.person),
              "quality": zones.quality_score, "issues": zones.issues,
              "err": None if zones.quality_score > 0 else "no_person_detected",
              "id": str(photo_id)})

        if zones.quality_score <= 0:
            raise UnusableBodyPhoto(", ".join(zones.issues) or "unusable")
        return zones

    # ── main entry point ────────────────────────────────────────────────────
    async def run(self, conn: AsyncConnection, job: dict) -> VtonOutcome:
        job_id = UUID(str(job["id"]))
        user_id = UUID(str(job["user_id"]))
        outcome = VtonOutcome(job_id=job_id, status="failed")

        try:
            zones = await self.prepare_body_photo(conn, UUID(str(job["body_photo_id"])))
            person = await self._load_person(conn, UUID(str(job["body_photo_id"])))
            layers = await self._load_layers(conn, user_id, job["garment_ids"])
            if not layers:
                raise NoRenderableGarments("no garment has a cutout image")

            model = await fetch_one(conn, """
                select id, provider::text as provider, supports_multi_garment,
                       cost_per_call_usd, config, commercial_ok
                  from public.vton_models where id = :id and is_enabled
            """, {"id": job["model_id"]})
            if model is None:
                raise ModelUnavailable(job["model_id"])

            provider = build_provider(model["id"], dict(model["config"] or {}))
            params = dict(job["params"] or {})
            seed = job["seed"] if job["seed"] is not None else 0

            groups = _plan_passes(layers, multi=bool(model["supports_multi_garment"]))
            canvas = person
            total_ms = total_cost = 0.0
            mask, _ = self.parser.parse(person)

            await execute(conn, "update public.vton_jobs set pass_total = :n where id = :id",
                          {"n": len(groups), "id": str(job_id)})

            for index, group in enumerate(groups):
                result = provider.render(RenderRequest(
                    person_rgb=canvas, person_mask=mask, zones=zones, layers=group,
                    params=params, seed=seed + index,
                    preserve_face=bool(params.get("preserve_face", True)),
                ))
                canvas = result.image_rgb
                total_ms += result.duration_ms
                total_cost += result.cost_usd
                await execute(conn, "update public.vton_jobs set pass_index = :i where id = :id",
                              {"i": index + 1, "id": str(job_id)})

            report = inspect(person, canvas, zones, [item.role for item in layers])
            media_id = await self._store_render(conn, user_id, canvas, job_id)

            outcome = VtonOutcome(
                job_id=job_id,
                status="succeeded" if report.passed else "partial",
                result_media_id=media_id, passes=len(groups),
                duration_ms=int(total_ms),
                cost_usd=round(total_cost or float(model["cost_per_call_usd"] or 0), 4),
                qa_score=report.score, qa_flags=report.flags,
            )
            await self._finish(conn, outcome, moderation=(
                "approved" if report.passed else "needs_review"))
        except VtonError as exc:
            outcome.error_code = type(exc).__name__
            outcome.error_detail = str(exc)
            await self._finish(conn, outcome)
        return outcome

    # ── helpers ─────────────────────────────────────────────────────────────
    async def _load_person(self, conn: AsyncConnection, photo_id: UUID) -> np.ndarray:
        row = await fetch_one(conn, """
            select m.bucket, m.storage_key from private.body_reference_photos p
              join public.media_assets m on m.id = p.media_asset_id
             where p.id = :id
        """, {"id": str(photo_id)})
        if row is None:
            raise BodyPhotoMissing(str(photo_id))
        return load_normalised(self.store.get_bytes(row["bucket"], row["storage_key"]),
                               max_side=self.settings.max_image_side).rgb

    async def _load_layers(self, conn: AsyncConnection, user_id: UUID,
                           garment_ids) -> list[GarmentLayer]:
        rows = await fetch_all(conn, """
            select g.id, g.role::text as role, cat.slug as category,
                   m.bucket, m.storage_key
              from public.garments g
              join public.garment_categories cat on cat.id = g.category_id
              left join public.media_assets m on m.id = g.cutout_media_id
             where g.user_id = :uid and g.id = any(cast(:ids as uuid[]))
               and g.deleted_at is null
        """, {"uid": str(user_id), "ids": [str(g) for g in garment_ids]})

        from PIL import Image

        layers: list[GarmentLayer] = []
        for r in rows:
            if not r["storage_key"]:
                log.warning("garment %s has no cutout; skipping", r["id"])
                continue
            raw = self.store.get_bytes(r["bucket"], r["storage_key"])
            rgba = np.asarray(Image.open(io.BytesIO(raw)).convert("RGBA"), dtype=np.uint8)
            layers.append(GarmentLayer(garment_id=str(r["id"]), role=r["role"],
                                       cutout_rgba=rgba, category=r["category"]))
        return layers

    async def _store_render(self, conn: AsyncConnection, user_id: UUID,
                            image: np.ndarray, job_id: UUID) -> UUID:
        from PIL import Image

        buf = io.BytesIO()
        Image.fromarray(image).save(buf, format="PNG", optimize=True)
        data = buf.getvalue()

        media_id = uuid4()
        key = f"{user_id}/vton/{job_id}.png"
        self.store.put_bytes(self.settings.bucket_vton, key, data, content_type="image/png")
        await execute(conn, """
            insert into public.media_assets
                (id, user_id, bucket, storage_key, mime_type, byte_size, width, height,
                 source, exif_stripped, moderation_status)
            values (:id, :uid, :bucket, :key, 'image/png', :size, :w, :h,
                    'vton_output', true, 'pending')
        """, {"id": str(media_id), "uid": str(user_id), "bucket": self.settings.bucket_vton,
              "key": key, "size": len(data), "w": image.shape[1], "h": image.shape[0]})
        return media_id

    async def _finish(self, conn: AsyncConnection, outcome: VtonOutcome,
                      moderation: str = "pending") -> None:
        await execute(conn, """
            update public.vton_jobs
               set status = cast(:status as public.job_status),
                   result_media_id = :media, duration_ms = :ms, cost_usd = :cost,
                   qa_score = :qa, qa_flags = cast(:flags as text[]),
                   moderation_status = cast(:mod as public.moderation_status),
                   error_code = :code, error_detail = :detail,
                   pass_index = coalesce(:passes, pass_index),
                   finished_at = now(),
                   expires_at = case when :status in ('succeeded','partial')
                                     then now() + interval '30 days' else expires_at end
             where id = :id
        """, {"status": outcome.status, "media": str(outcome.result_media_id)
              if outcome.result_media_id else None, "ms": outcome.duration_ms,
              "cost": outcome.cost_usd, "qa": outcome.qa_score, "flags": outcome.qa_flags,
              "mod": moderation, "code": outcome.error_code, "detail": outcome.error_detail,
              "passes": outcome.passes or None, "id": str(outcome.job_id)})


def _plan_passes(layers: list[GarmentLayer], *, multi: bool) -> list[list[GarmentLayer]]:
    ordered = sorted(layers, key=lambda item: (
        PASS_ORDER.index(item.role) if item.role in PASS_ORDER else len(PASS_ORDER)))
    return [ordered] if multi else [[item] for item in ordered]


# ── errors ──────────────────────────────────────────────────────────────────
class VtonError(Exception):
    pass


class BodyPhotoMissing(VtonError):
    pass


class UnusableBodyPhoto(VtonError):
    pass


class NoRenderableGarments(VtonError):
    pass


class ModelUnavailable(VtonError):
    pass
