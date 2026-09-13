"""Wardrobe-level analytics."""
from __future__ import annotations

from fastapi import APIRouter

from ..db import fetch_all, fetch_one
from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..schemas import WardrobeAdvice

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


@router.get("/advice", response_model=WardrobeAdvice)
async def wardrobe_advice(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep):
    """What the wardrobe cannot do yet — and, only sometimes, what to buy.

    Gaps are reported to everyone: knowing you have nothing to wear on your feet
    to a formal event is useful regardless of budget. Whether any of it is
    phrased as a purchase depends on what the wardrobe itself says about how
    welcome that would be, and the user's own setting always overrides it.
    """
    from workers.styling.advice import build_advice

    from ..styling_service import get_engine

    prefs = await fetch_one(conn, """
        select budget_tier, allow_new_purchases
          from public.style_preferences where user_id = :u
    """, {"u": str(principal.user_id)})

    rules = await get_engine(settings).color_rules(conn)
    advice = await build_advice(
        conn, principal.user_id, rules,
        user_band=prefs["budget_tier"] if prefs else None,
        allow_purchases=bool(prefs["allow_new_purchases"]) if prefs else True,
    )

    guidance = advice.guidance
    return WardrobeAdvice(
        headline=advice.headline,
        tone=advice.tone.value,
        coverage=[
            {"slug": c.slug, "display_name": c.display_name, "wearable": c.wearable,
             "missing_roles": c.missing_roles, "option_count": c.option_count}
            for c in advice.coverage
        ],
        color_opportunities=[
            {"family": o.family, "pairs_with": o.pairs_with,
             "coverage": o.coverage, "is_neutral": o.is_neutral}
            for o in advice.color_opportunities
        ],
        suggestions=[
            {"role": s.role, "color_family": s.color_family, "reason": s.reason,
             "blocking": s.blocking, "price_low": s.price_low,
             "price_high": s.price_high, "currency": s.currency}
            for s in advice.suggestions
        ],
        # Says what the advice was based on, never what the person is.
        basis=guidance.reason if guidance else "no wardrobe yet",
    )
