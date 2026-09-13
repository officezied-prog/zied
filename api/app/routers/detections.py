"""The review queue.

Anything the pipeline was not confident about lands here instead of silently
entering the wardrobe. Each accept/reject is also the cheapest training label
the product will ever collect.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, status

from ..db import execute, fetch_all, fetch_one
from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..errors import Conflict, InvalidRequest, NotFound
from ..schemas import Detection, GarmentUpdate
from ..storage import get_store

router = APIRouter(prefix="/v1/detections", tags=["Social ingestion"])


@router.get("", response_model=list[Detection])
async def list_detections(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep,
                          status_filter: str = "pending", limit: int = 50):
    rows = await fetch_all(conn, """
        select d.id, d.media_asset_id as media_id, d.label, d.confidence, d.bbox,
               d.attributes, d.status, d.category_id,
               c.display_name as suggested_category,
               m.bucket as cutout_bucket, m.storage_key as cutout_key
          from public.detections d
          left join public.garment_categories c on c.id = d.category_id
          left join public.media_assets m on m.id = d.cutout_asset_id
         where d.user_id = :uid and d.status = :st
         order by d.confidence desc, d.created_at desc
         limit :limit
    """, {"uid": str(principal.user_id), "st": status_filter, "limit": min(limit, 200)})

    store = get_store(settings)
    out = []
    for r in rows:
        attrs = r["attributes"] or {}
        out.append(Detection(
            id=r["id"], media_id=r["media_id"],
            cutout_url=(store.presign_get(r["cutout_bucket"], r["cutout_key"],
                                          ttl=settings.read_url_ttl_seconds)
                        if r["cutout_key"] else None),
            label=r["label"], suggested_category=r["suggested_category"],
            suggested_category_id=r["category_id"],
            confidence=float(r["confidence"]), bbox=[float(b) for b in r["bbox"]],
            colors=attrs.get("colors", []), gate_failures=attrs.get("gate_failures", []),
            status=r["status"],
        ))
    return out


@router.post("/{detection_id}/accept", status_code=status.HTTP_201_CREATED)
async def accept_detection(detection_id: UUID, body: GarmentUpdate, conn: ConnDep,
                           principal: PrincipalDep):
    """Promote a detection, applying the user's corrections as the ground truth."""
    det = await fetch_one(conn, """
        select d.*, m.source::text as media_source
          from public.detections d
          join public.media_assets m on m.id = d.media_asset_id
         where d.id = :id and d.user_id = :uid
    """, {"id": str(detection_id), "uid": str(principal.user_id)})
    if det is None:
        raise NotFound("Detection", str(detection_id))
    if det["status"] == "accepted":
        raise Conflict("Detection has already been accepted.")

    category_id = body.category_id or det["category_id"]
    if category_id is None:
        raise InvalidRequest("This detection has no category; supply category_id.")

    attrs = det["attributes"] or {}
    colors = attrs.get("colors", [])
    name = body.name or _auto_name(conn, colors)

    row = await fetch_one(conn, """
        insert into public.garments
            (user_id, category_id, role, source_media_id, cutout_media_id, detection_id,
             name, brand, pattern, material, size_label, formality, warmth, seasons,
             source, auto_tagged, user_verified, tag_confidence)
        values (:uid, :cat, null, :src, :cut, :det, :name, :brand,
                coalesce(cast(:pattern as public.pattern_type), 'solid'),
                coalesce(cast(:material as text[]), '{}'),
                :size, :formality, :warmth, cast(:seasons as public.season[]),
                cast(:source as public.media_source), true, true, :conf)
        returning id
    """, {"uid": str(principal.user_id), "cat": category_id,
          "src": str(det["media_asset_id"]),
          "cut": str(det["cutout_asset_id"]) if det["cutout_asset_id"] else None,
          "det": str(detection_id), "name": name, "brand": body.brand,
          "pattern": body.pattern, "material": body.material, "size": body.size_label,
          "formality": body.formality, "warmth": body.warmth, "seasons": body.seasons,
          "source": det["media_source"], "conf": float(det["confidence"])})
    garment_id = row["id"]

    for rank, c in enumerate(colors[:5], start=1):
        await execute(conn, """
            insert into public.garment_colors
                (garment_id, rank, hex, ratio, lab_l, lab_a, lab_b, lch_h, lch_c,
                 color_family, is_neutral)
            values (:g, :rank, :hex, :ratio, :l, :a, :b, :h, :c, :fam, :neutral)
            on conflict (garment_id, rank) do nothing
        """, {"g": str(garment_id), "rank": rank, "hex": c["hex"], "ratio": c["ratio"],
              "l": c["lab"][0], "a": c["lab"][1], "b": c["lab"][2],
              "h": c["lch_h"], "c": c["lch_c"], "fam": c["family"],
              "neutral": c["is_neutral"]})

    await execute(conn, "update public.detections set status='accepted', garment_id=:g where id=:id",
                  {"g": str(garment_id), "id": str(detection_id)})
    return {"garment_id": garment_id, "detection_id": detection_id}


@router.post("/{detection_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
async def reject_detection(detection_id: UUID, conn: ConnDep, principal: PrincipalDep):
    result = await execute(conn, """
        update public.detections set status = 'rejected'
         where id = :id and user_id = :uid and status = 'pending'
    """, {"id": str(detection_id), "uid": str(principal.user_id)})
    if result.rowcount == 0:
        raise NotFound("Pending detection", str(detection_id))


def _auto_name(conn, colors) -> str | None:
    return None if not colors else f"{colors[0]['family'].replace('_', ' ').title()} item"
