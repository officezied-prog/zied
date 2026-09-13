"""Wardrobe-level analytics."""
from __future__ import annotations

from fastapi import APIRouter

from ..db import fetch_all, fetch_one
from ..deps import ConnDep, PrincipalDep

router = APIRouter(prefix="/v1/wardrobe", tags=["Wardrobe"])

# Roles the styling engine needs before it can build anything at all.
_ESSENTIAL_ROLES = ("base_top", "bottom", "footwear")


@router.get("/stats")
async def wardrobe_stats(conn: ConnDep, principal: PrincipalDep):
    stats = await fetch_one(conn, """
        select coalesce(items, 0) as items, coalesce(never_worn, 0) as never_worn,
               coalesce(worn_last_30d, 0) as worn_last_30d,
               avg_cost_per_wear, closet_value
          from public.v_wardrobe_stats where user_id = :uid
    """, {"uid": str(principal.user_id)})

    by_role = await fetch_all(conn, """
        select role::text as role, count(*) as n
          from public.garments
         where user_id = :uid and deleted_at is null and is_archived = false
         group by role
    """, {"uid": str(principal.user_id)})

    counts = {r["role"]: r["n"] for r in by_role}
    gaps = [f"no_{r}" for r in _ESSENTIAL_ROLES if counts.get(r, 0) == 0]

    return {
        "items": stats["items"] if stats else 0,
        "never_worn": stats["never_worn"] if stats else 0,
        "worn_last_30d": stats["worn_last_30d"] if stats else 0,
        "avg_cost_per_wear": float(stats["avg_cost_per_wear"]) if stats and stats["avg_cost_per_wear"] else None,
        "closet_value": float(stats["closet_value"]) if stats and stats["closet_value"] else None,
        "by_role": counts,
        "gaps": gaps,
    }
