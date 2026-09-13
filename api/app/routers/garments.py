"""The wardrobe itself."""
from __future__ import annotations

import base64
import json
from datetime import date, datetime
from uuid import UUID

from fastapi import APIRouter, Query, status

from ..db import execute, fetch_all, fetch_one
from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..errors import InvalidRequest, NotFound
from ..schemas import BulkGarmentUpdate, Garment, GarmentCreate, GarmentUpdate
from ..storage import get_store

router = APIRouter(prefix="/v1/garments", tags=["Wardrobe"])

_SELECT = """
    select g.id, g.category_id, cat.slug as category, g.role::text as role,
           g.name, g.brand, g.pattern::text as pattern, g.material, g.fit::text as fit,
           g.size_label, g.formality, g.warmth,
           array(select unnest(g.seasons)::text) as seasons,
           g.occasion_tags, g.ownership, g.in_laundry, g.wear_count, g.last_worn_at,
           g.auto_tagged, g.user_verified, g.tag_confidence, g.created_at,
           src.bucket as src_bucket, src.storage_key as src_key,
           cut.bucket as cut_bucket, cut.storage_key as cut_key,
           coalesce(
             (select json_agg(json_build_object(
                        'hex', c.hex, 'ratio', c.ratio,
                        'color_family', c.color_family, 'is_neutral', c.is_neutral)
                      order by c.rank)
                from public.garment_colors c where c.garment_id = g.id), '[]'::json
           ) as colors
      from public.garments g
      join public.garment_categories cat on cat.id = g.category_id
      left join public.media_assets src on src.id = g.source_media_id
      left join public.media_assets cut on cut.id = g.cutout_media_id
"""


def _encode_cursor(created_at, gid) -> str:
    return base64.urlsafe_b64encode(json.dumps([created_at.isoformat(), str(gid)]).encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        ts, gid = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        # asyncpg binds by inferred type: a timestamptz parameter must be a real
        # datetime, and a uuid parameter a real UUID — strings are rejected.
        return datetime.fromisoformat(ts), UUID(gid)
    except InvalidRequest:
        raise
    except Exception as exc:
        raise InvalidRequest("Malformed cursor.") from exc


def _row_to_garment(r, store, settings) -> Garment:
    d = dict(r)
    src_bucket, src_key = d.pop("src_bucket", None), d.pop("src_key", None)
    cut_bucket, cut_key = d.pop("cut_bucket", None), d.pop("cut_key", None)
    ttl = settings.read_url_ttl_seconds
    d["image_url"] = store.presign_get(src_bucket, src_key, ttl=ttl) if src_key else None
    d["cutout_url"] = store.presign_get(cut_bucket, cut_key, ttl=ttl) if cut_key else None
    d["colors"] = d["colors"] if isinstance(d["colors"], list) else json.loads(d["colors"])
    d["tag_confidence"] = float(d["tag_confidence"]) if d["tag_confidence"] is not None else None
    return Garment(**d)


@router.get("")
async def list_garments(
    conn: ConnDep, principal: PrincipalDep, settings: SettingsDep,
    role: str | None = None,
    category: str | None = None,
    color_family: str | None = None,
    season: str | None = None,
    formality_min: int | None = Query(None, ge=1, le=5),
    formality_max: int | None = Query(None, ge=1, le=5),
    available_only: bool = False,
    q: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
):
    where = ["g.user_id = :uid", "g.deleted_at is null"]
    params: dict = {"uid": str(principal.user_id), "limit": limit + 1}

    if role:
        where.append("g.role = cast(:role as public.garment_role)")
        params["role"] = role
    if category:
        # Include the whole subtree: filtering by "tops" must return t-shirts.
        where.append("g.category_id in (select id from public.category_descendants(:cat))")
        params["cat"] = category
    if color_family:
        where.append("""exists (select 1 from public.garment_colors c
                                 where c.garment_id = g.id and c.color_family = :fam)""")
        params["fam"] = color_family
    if season:
        where.append("(cast(:season as public.season) = any(g.seasons) or 'all_season' = any(g.seasons))")
        params["season"] = season
    if formality_min is not None:
        where.append("g.formality >= :fmin")
        params["fmin"] = formality_min
    if formality_max is not None:
        where.append("g.formality <= :fmax")
        params["fmax"] = formality_max
    if available_only:
        where.append("g.is_archived = false and g.in_laundry = false "
                     "and g.ownership in ('owned','borrowed')")
    if q:
        where.append("(g.name ilike :q or g.brand ilike :q)")
        params["q"] = f"%{q}%"
    if cursor:
        ts, gid = _decode_cursor(cursor)
        where.append("(g.created_at, g.id) < (:cts, :cid)")
        params["cts"], params["cid"] = ts, gid

    # Every fragment in `where` is a module-level literal and every user value is
    # a bound parameter — no request data reaches the SQL string.
    sql = (f"{_SELECT} where {' and '.join(where)} "
           "order by g.created_at desc, g.id desc limit :limit")
    rows = await fetch_all(conn, sql, params)

    store = get_store(settings)
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [_row_to_garment(r, store, settings) for r in rows]
    next_cursor = _encode_cursor(rows[-1]["created_at"], rows[-1]["id"]) if has_more and rows else None
    return {"items": items, "next_cursor": next_cursor}


@router.post("", response_model=Garment, status_code=status.HTTP_201_CREATED)
async def create_garment(body: GarmentCreate, conn: ConnDep, principal: PrincipalDep,
                         settings: SettingsDep):
    row = await fetch_one(conn, """
        insert into public.garments
            (user_id, category_id, role, source_media_id, name, brand, pattern, material,
             size_label, formality, warmth, seasons, purchase_price, purchase_currency,
             ownership, source, user_verified)
        values (:uid, :cat, null, :media, :name, :brand,
                cast(:pattern as public.pattern_type), coalesce(cast(:material as text[]), '{}'),
                :size, :formality, :warmth, cast(:seasons as public.season[]),
                :price, :currency, :ownership, 'manual_upload', true)
        returning id
    """, {"uid": str(principal.user_id), "cat": body.category_id,
          "media": str(body.media_id) if body.media_id else None,
          "name": body.name, "brand": body.brand, "pattern": body.pattern,
          "material": body.material, "size": body.size_label,
          "formality": body.formality, "warmth": body.warmth, "seasons": body.seasons,
          "price": body.purchase_price, "currency": body.purchase_currency,
          "ownership": body.ownership})
    return await get_garment(row["id"], conn, principal, settings)


@router.patch("/bulk")
async def bulk_update(body: BulkGarmentUpdate, conn: ConnDep, principal: PrincipalDep):
    patch = body.patch.model_dump(exclude_unset=True, exclude_none=True)
    sets = [_PATCHABLE[k] for k in patch if k in _PATCHABLE]
    if not sets:
        raise InvalidRequest("No updatable fields in patch.")
    params = {k: v for k, v in patch.items() if k in _PATCHABLE}
    params |= {"ids": [str(i) for i in body.ids], "uid": str(principal.user_id)}
    result = await execute(conn, f"""
        update public.garments set {', '.join(sets)}
         where id = any(cast(:ids as uuid[])) and user_id = :uid and deleted_at is null
    """, params)  # noqa: S608
    return {"updated": result.rowcount}


@router.get("/{garment_id}", response_model=Garment)
async def get_garment(garment_id: UUID, conn: ConnDep, principal: PrincipalDep,
                      settings: SettingsDep):
    row = await fetch_one(conn, f"{_SELECT} where g.id = :id and g.user_id = :uid and g.deleted_at is null",
                          {"id": str(garment_id), "uid": str(principal.user_id)})
    if row is None:
        raise NotFound("Garment", str(garment_id))
    return _row_to_garment(row, get_store(settings), settings)


_PATCHABLE = {
    "category_id": "category_id = :category_id",
    "name": "name = :name",
    "brand": "brand = :brand",
    "pattern": "pattern = cast(:pattern as public.pattern_type)",
    "material": "material = cast(:material as text[])",
    "size_label": "size_label = :size_label",
    "formality": "formality = :formality",
    "warmth": "warmth = :warmth",
    "seasons": "seasons = cast(:seasons as public.season[])",
    "in_laundry": "in_laundry = :in_laundry",
    "is_archived": "is_archived = :is_archived",
    "user_verified": "user_verified = :user_verified",
    "condition": "condition = :condition",
    "ownership": "ownership = :ownership",
}


@router.patch("/{garment_id}", response_model=Garment)
async def update_garment(garment_id: UUID, body: GarmentUpdate, conn: ConnDep,
                         principal: PrincipalDep, settings: SettingsDep):
    patch = body.model_dump(exclude_unset=True, exclude_none=True)
    if not patch:
        raise InvalidRequest("Empty patch.")
    sets = [_PATCHABLE[k] for k in patch if k in _PATCHABLE]
    if not sets:
        raise InvalidRequest("No updatable fields in patch.")
    params = {k: v for k, v in patch.items() if k in _PATCHABLE}
    params |= {"id": str(garment_id), "uid": str(principal.user_id)}
    # A human edit is ground truth: it clears the auto-tag flag.
    # `sets` comes only from the _PATCHABLE allow-list; values stay bound.
    result = await execute(conn, f"""
        update public.garments set {', '.join(sets)}, user_verified = true
         where id = :id and user_id = :uid and deleted_at is null
    """, params)  # noqa: S608
    if result.rowcount == 0:
        raise NotFound("Garment", str(garment_id))
    return await get_garment(garment_id, conn, principal, settings)


@router.delete("/{garment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_garment(garment_id: UUID, conn: ConnDep, principal: PrincipalDep):
    result = await execute(conn, """
        update public.garments set deleted_at = now()
         where id = :id and user_id = :uid and deleted_at is null
    """, {"id": str(garment_id), "uid": str(principal.user_id)})
    if result.rowcount == 0:
        raise NotFound("Garment", str(garment_id))


@router.post("/{garment_id}/wear", status_code=status.HTTP_201_CREATED)
async def log_wear(garment_id: UUID, conn: ConnDep, principal: PrincipalDep,
                   worn_on: date | None = None, outfit_id: UUID | None = None):
    owned = await fetch_one(conn, "select 1 from public.garments where id=:id and user_id=:uid",
                            {"id": str(garment_id), "uid": str(principal.user_id)})
    if owned is None:
        raise NotFound("Garment", str(garment_id))
    await execute(conn, """
        insert into public.wear_log (user_id, garment_id, outfit_id, worn_on)
        values (:uid, :g, :o, coalesce(:d, current_date))
        on conflict do nothing
    """, {"uid": str(principal.user_id), "g": str(garment_id),
          "o": str(outfit_id) if outfit_id else None, "d": worn_on})
    return {"ok": True}
