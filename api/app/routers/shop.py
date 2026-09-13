"""Shop mode — judge something on the rack against the wardrobe at home.

Synchronous on purpose. Someone is standing in a shop holding the garment; a
job id to poll is the wrong answer.
"""
from __future__ import annotations

import json
from uuid import UUID, uuid4

from fastapi import APIRouter, Query, status

from ..db import execute, fetch_all, fetch_one
from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..errors import InvalidRequest, NotFound
from ..schemas import ScanPurchase, ScanRequest, ScanResult, ShopScan
from ..storage import get_store

router = APIRouter(prefix="/v1/shop", tags=["Shop"])


@router.post("/scan", response_model=ScanResult)
async def scan_garment(body: ScanRequest, conn: ConnDep, principal: PrincipalDep,
                       settings: SettingsDep):
    """Photograph something in a shop; find out whether it is worth buying."""
    from workers.styling.shopping import Candidate, scan
    from workers.vision.runner import build_pipeline

    from ..styling_service import get_engine

    media = await fetch_one(conn, """
        select id, bucket, storage_key from public.media_assets
         where id = :m and user_id = :u and deleted_at is null
    """, {"m": str(body.media_id), "u": str(principal.user_id)})
    if media is None:
        raise NotFound("Media", str(body.media_id))

    store = get_store(settings)
    pipeline = build_pipeline(settings)
    identified = await pipeline.identify_one(
        conn, image_bytes=store.get_bytes(media["bucket"], media["storage_key"]))
    if identified is None:
        raise InvalidRequest(
            "No garment found in that photo. Try filling more of the frame with "
            "the item, against a plainer background.")

    primary = identified["colors"][0]
    candidate = Candidate(
        role=body.role or identified["role"],
        category=identified["category"],
        category_id=identified["category_id"],
        color_family=primary["family"],
        primary_hex=primary["hex"],
        lab=tuple(primary["lab"]),
        pattern=identified["pattern"],
        formality=identified["formality"],
        confidence=identified["confidence"],
    )

    rules = await get_engine(settings).color_rules(conn)
    result = await scan(conn, principal.user_id, candidate, rules)

    scan_id = uuid4()
    await execute(conn, """
        insert into public.shop_scans
            (id, user_id, media_asset_id, category_id, role, pattern, primary_hex,
             color_family, confidence, verdict, new_pairings, duplicate_count,
             unlocked, headline, detail)
        values (:id, :u, :m, :cat, cast(:role as public.garment_role),
                cast(:pattern as public.pattern_type), :hex, :fam, :conf,
                cast(:verdict as public.scan_verdict), :pairs, :dupes,
                cast(:unlocked as text[]), :headline, cast(:detail as jsonb))
    """, {
        "id": str(scan_id), "u": str(principal.user_id), "m": str(body.media_id),
        "cat": candidate.category_id, "role": candidate.role,
        "pattern": candidate.pattern, "hex": candidate.primary_hex,
        "fam": candidate.color_family, "conf": candidate.confidence,
        "verdict": result.verdict.value, "pairs": result.new_pairings,
        "dupes": len(result.duplicates), "unlocked": result.unlocked_occasions,
        "headline": result.headline,
        "detail": json.dumps({
            "detail": result.detail,
            "pairing_share": result.pairing_share,
            "wear_with": [
                {"garment_id": str(w.garment_id), "name": w.name, "role": w.role,
                 "hex": w.hex, "score": w.score}
                for w in result.wear_with
            ],
            "role_family_share": result.role_family_share,
            "total_complements": result.total_complements,
        }),
    })

    return ScanResult(
        scan_id=scan_id,
        category=candidate.category,
        role=candidate.role,
        pattern=candidate.pattern,
        primary_hex=candidate.primary_hex,
        color_family=candidate.color_family,
        confidence=candidate.confidence,
        verdict=result.verdict.value,
        headline=result.headline,
        detail=result.detail,
        new_pairings=result.new_pairings,
        total_complements=result.total_complements,
        pairing_share=result.pairing_share,
        duplicates=[
            {"garment_id": d.garment_id, "name": d.name, "hex": d.hex,
             "delta_e": d.delta_e}
            for d in result.duplicates
        ],
        unlocked_occasions=result.unlocked_occasions,
        wear_with=[
            {"garment_id": w.garment_id, "name": w.name, "role": w.role,
             "hex": w.hex, "score": w.score}
            for w in result.wear_with
        ],
        look_for_colors=[
            {"family": o.family, "pairs_with": o.pairs_with,
             "coverage": o.coverage, "is_neutral": o.is_neutral}
            for o in result.look_for_colors
        ],
        look_for_roles=result.look_for_roles,
    )


@router.get("/scans", response_model=list[ShopScan])
async def list_scans(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep,
                     open_only: bool = True, limit: int = Query(20, ge=1, le=100)):
    """Things photographed and not yet decided on."""
    where = ["s.user_id = :u"]
    if open_only:
        where.append("s.purchased_at is null and s.dismissed_at is null")
    rows = await fetch_all(conn, f"""
        select s.id, s.role::text as role, s.color_family, s.primary_hex,
               s.verdict::text as verdict, s.headline, s.new_pairings,
               s.duplicate_count, s.unlocked, s.created_at,
               cat.slug as category, m.bucket, m.storage_key
          from public.shop_scans s
          left join public.garment_categories cat on cat.id = s.category_id
          left join public.media_assets m on m.id = s.media_asset_id
         where {' and '.join(where)}
         order by s.created_at desc limit :limit
    """, {"u": str(principal.user_id), "limit": limit})  # noqa: S608

    store = get_store(settings)
    return [
        ShopScan(
            id=r["id"], category=r["category"] or "unknown", role=r["role"] or "base_top",
            color_family=r["color_family"] or "", primary_hex=r["primary_hex"] or "#000000",
            verdict=r["verdict"] or "adds_variety", headline=r["headline"] or "",
            new_pairings=r["new_pairings"], duplicate_count=r["duplicate_count"],
            unlocked_occasions=list(r["unlocked"] or []),
            photo_url=(store.presign_get(r["bucket"], r["storage_key"],
                                         ttl=settings.read_url_ttl_seconds)
                       if r["storage_key"] else None),
            created_at=r["created_at"],
        )
        for r in rows
    ]


@router.post("/scans/{scan_id}/bought", response_model=ScanPurchase,
             status_code=status.HTTP_201_CREATED)
async def mark_bought(scan_id: UUID, conn: ConnDep, principal: PrincipalDep):
    """They bought it: turn the scan into a wardrobe item, colour and all."""
    row = await fetch_one(conn, """
        select * from public.shop_scans
         where id = :id and user_id = :u and purchased_at is null
    """, {"id": str(scan_id), "u": str(principal.user_id)})
    if row is None:
        raise NotFound("Open scan", str(scan_id))
    if row["category_id"] is None:
        raise InvalidRequest("This scan was never identified; add the item manually.")

    category = await fetch_one(conn, """
        select display_name from public.garment_categories where id = :cat
    """, {"cat": row["category_id"]})
    colour = (row["color_family"] or "new").replace("_", " ").title()
    name = f"{colour} {category['display_name']}"

    # role, formality, warmth and seasons stay null: the category-prior trigger
    # fills them from the taxonomy, exactly as a manual add would.
    garment = await fetch_one(conn, """
        insert into public.garments
            (user_id, category_id, role, source_media_id, name, pattern,
             ownership, source, user_verified)
        values (:u, :cat, null, cast(:media as uuid), :name,
                cast(:pattern as public.pattern_type),
                'owned', 'manual_upload', true)
        returning id
    """, {"u": str(principal.user_id), "cat": row["category_id"],
          "media": str(row["media_asset_id"]) if row["media_asset_id"] else None,
          "name": name, "pattern": row["pattern"] or "solid"})

    await execute(conn, """
        insert into public.garment_colors
            (garment_id, rank, hex, ratio, lab_l, lab_a, lab_b, lch_h, lch_c,
             color_family, is_neutral)
        select cast(:g as uuid), 1, :hex, 1.0,
               c.lab_l, c.lab_a, c.lab_b, c.lch_h, c.lch_c,
               cast(:fam as text), coalesce(f.is_neutral, false)
          from public.hex_to_color_row(:hex) c
          left join public.color_families f on f.slug = cast(:fam as text)
    """, {"g": str(garment["id"]), "hex": row["primary_hex"] or "#808080",
          "fam": row["color_family"]})

    await execute(conn, """
        update public.shop_scans set purchased_at = now(), garment_id = :g
         where id = :id
    """, {"g": str(garment["id"]), "id": str(scan_id)})
    return ScanPurchase(scan_id=scan_id, garment_id=garment["id"])


@router.post("/scans/{scan_id}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
async def dismiss_scan(scan_id: UUID, conn: ConnDep, principal: PrincipalDep):
    result = await execute(conn, """
        update public.shop_scans set dismissed_at = now()
         where id = :id and user_id = :u and dismissed_at is null
    """, {"id": str(scan_id), "u": str(principal.user_id)})
    if result.rowcount == 0:
        raise NotFound("Open scan", str(scan_id))
