"""What to suggest buying — and, more often, what not to.

The product knows what someone owns, and that is enough to tell whether a
purchase suggestion would be useful or insulting. Someone with forty designer
pieces is served by "your wardrobe has no camel outerwear"; someone with nine
high-street pieces is served by "here are four more looks from what you have",
and is not served at all by being told to go shopping.

How the judgement is made, in order of how much it is trusted:

  1. What the user set themselves. Always wins, no inference on top.
  2. What they actually paid. Each priced garment is matched against the price
     band for its own role, so a $200 coat and a $200 t-shirt are not read as
     the same thing. The median of those matches is the band.
  3. What brands they own, when prices are missing.
  4. Nothing — in which case the answer is the safe middle and the tone is
     conservative.

Three constraints hold throughout:

  * The band is computed on demand and never written down. There is no
    affluence column, no segment, nothing to leak or to show the user.
  * It is never shown as a label. "You look like a tier 2 customer" is
    demeaning, frequently wrong, and useless to the person reading it.
  * It never changes a price. It decides what gets suggested, full stop.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from enum import StrEnum
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.db import fetch_all, fetch_one


class Tone(StrEnum):
    """How the advice should read."""

    #: Suggest nothing to buy. Show more ways to wear what is already owned.
    USE_WHAT_YOU_HAVE = "use_what_you_have"
    #: Name only the gaps that actually block an occasion, at the lowest band.
    ESSENTIALS_ONLY = "essentials_only"
    #: Suggest filling gaps that would unlock new looks.
    SUGGEST_GAPS = "suggest_gaps"
    #: Suggest gaps and upgrades; this wardrobe is being actively built.
    SUGGEST_UPGRADES = "suggest_upgrades"


@dataclass(frozen=True)
class Evidence:
    items: int = 0
    priced_items: int = 0
    median_price: float | None = None
    p75_price: float | None = None
    max_price: float | None = None
    currency: str = "USD"
    branded_items: int = 0
    known_brand_items: int = 0
    mean_brand_tier: float | None = None
    max_brand_tier: int | None = None
    luxury_items: int = 0
    value_items: int = 0
    distinct_brands: int = 0
    premium_materials: int = 0
    roles_covered: int = 0


@dataclass(frozen=True)
class SpendGuidance:
    """The decision. `band` never reaches the user; `tone` and `reason` do."""

    band: int                      # 1..5, internal only
    confidence: float              # 0..1
    source: str                    # user | prices | brands | default
    tone: Tone
    suggest_purchases: bool
    currency: str = "USD"
    reason: str = ""
    #: Per-role price range to suggest within, when suggesting at all.
    price_range: dict[str, tuple[float, float]] = field(default_factory=dict)

    @property
    def is_inferred(self) -> bool:
        return self.source != "user"


# A wardrobe this small has no signal in it worth acting on.
MIN_ITEMS_FOR_INFERENCE = 6
MIN_PRICED_FOR_PRICE_SIGNAL = 4
MIN_BRANDED_FOR_BRAND_SIGNAL = 4


async def load_evidence(conn: AsyncConnection, user_id: UUID) -> Evidence:
    row = await fetch_one(conn, "select * from public.wardrobe_evidence(:u)",
                          {"u": str(user_id)})
    if row is None:
        return Evidence()
    return Evidence(
        items=row["items"] or 0,
        priced_items=row["priced_items"] or 0,
        median_price=float(row["median_price"]) if row["median_price"] else None,
        p75_price=float(row["p75_price"]) if row["p75_price"] else None,
        max_price=float(row["max_price"]) if row["max_price"] else None,
        currency=row["currency"] or "USD",
        branded_items=row["branded_items"] or 0,
        known_brand_items=row["known_brand_items"] or 0,
        mean_brand_tier=float(row["mean_brand_tier"]) if row["mean_brand_tier"] else None,
        max_brand_tier=row["max_brand_tier"],
        luxury_items=row["luxury_items"] or 0,
        value_items=row["value_items"] or 0,
        distinct_brands=row["distinct_brands"] or 0,
        premium_materials=row["premium_materials"] or 0,
        roles_covered=row["roles_covered"] or 0,
    )


async def _price_bands(conn: AsyncConnection, currency: str = "USD"
                       ) -> dict[tuple[int, str], tuple[float, float]]:
    rows = await fetch_all(conn, """
        select tier, role::text as role, low, high
          from public.price_bands where currency = :c
    """, {"c": currency})
    return {(r["tier"], r["role"]): (float(r["low"]), float(r["high"])) for r in rows}


async def _band_from_prices(conn: AsyncConnection, user_id: UUID,
                            currency: str) -> tuple[int, int] | None:
    """Median band across priced garments, each matched against its own role.

    Returns (band, sample size). A single expensive coat does not move it; a
    consistent pattern of spending does.
    """
    bands = await _price_bands(conn, currency)
    if not bands:
        return None

    rows = await fetch_all(conn, """
        select role::text as role, purchase_price
          from public.garments
         where user_id = :u and deleted_at is null and is_archived = false
           and purchase_price is not null and purchase_price > 0
           and (purchase_currency is null or purchase_currency = :c)
    """, {"u": str(user_id), "c": currency})
    if len(rows) < MIN_PRICED_FOR_PRICE_SIGNAL:
        return None

    matched: list[int] = []
    for r in rows:
        price = float(r["purchase_price"])
        role = r["role"]
        candidates = [(tier, low, high) for (tier, band_role), (low, high) in bands.items()
                      if band_role == role]
        if not candidates:
            continue
        inside = [tier for tier, low, high in candidates if low <= price <= high]
        if inside:
            matched.append(min(inside))
        else:
            # Outside every band: snap to the nearest one rather than discard.
            matched.append(min(candidates, key=lambda c: min(abs(price - c[1]),
                                                             abs(price - c[2])))[0])
    if len(matched) < MIN_PRICED_FOR_PRICE_SIGNAL:
        return None
    return round(statistics.median(matched)), len(matched)


def _band_from_brands(evidence: Evidence) -> tuple[int, float] | None:
    if evidence.known_brand_items < MIN_BRANDED_FOR_BRAND_SIGNAL:
        return None
    if evidence.mean_brand_tier is None:
        return None
    band = round(evidence.mean_brand_tier)
    # Confidence grows with how much of the wardrobe we can actually read.
    coverage = evidence.known_brand_items / max(evidence.items, 1)
    return band, min(0.8, 0.35 + coverage * 0.5)


def decide_tone(band: int, evidence: Evidence, *, allow_purchases: bool) -> Tone:
    """The heart of it.

    A wardrobe that reads as budget-conscious gets no shopping list. It gets
    told only about a gap that actually stops it working — no shoes for a
    formal event is information; "you could use another blazer" is pressure.
    """
    if not allow_purchases:
        return Tone.USE_WHAT_YOU_HAVE
    if band <= 2:
        return Tone.ESSENTIALS_ONLY
    if band == 3:
        return Tone.SUGGEST_GAPS
    return Tone.SUGGEST_UPGRADES


async def spend_guidance(
    conn: AsyncConnection,
    user_id: UUID,
    *,
    user_band: int | None = None,
    allow_purchases: bool = True,
) -> SpendGuidance:
    evidence = await load_evidence(conn, user_id)
    currency = evidence.currency or "USD"

    # 1. What the user said about themselves.
    if user_band is not None:
        band, confidence, source = user_band, 1.0, "user"
        reason = "you set this yourself"
    elif evidence.items < MIN_ITEMS_FOR_INFERENCE:
        # 4. Too little to read. Say nothing about money.
        band, confidence, source = 2, 0.1, "default"
        reason = "not enough in the wardrobe to judge"
    else:
        priced = await _band_from_prices(conn, user_id, currency)
        if priced is not None:
            band, sample = priced
            confidence = min(0.95, 0.5 + sample / max(evidence.items, 1) * 0.45)
            source, reason = "prices", f"what you paid for {sample} pieces"
        else:
            branded = _band_from_brands(evidence)
            if branded is not None:
                band, confidence = branded
                source = "brands"
                reason = f"the brands on {evidence.known_brand_items} pieces"
            else:
                band, confidence, source = 2, 0.15, "default"
                reason = "no prices or known brands recorded"

    band = max(1, min(5, band))

    # A low-confidence inference must not be the thing that starts a sales
    # pitch: err toward saying nothing.
    effective = band if (confidence >= 0.45 or source == "user") else min(band, 2)
    tone = decide_tone(effective, evidence, allow_purchases=allow_purchases)

    bands = await _price_bands(conn, currency)
    price_range = {role: rng for (tier, role), rng in bands.items() if tier == effective}

    return SpendGuidance(
        band=effective,
        confidence=round(confidence, 2),
        source=source,
        tone=tone,
        suggest_purchases=tone in (Tone.SUGGEST_GAPS, Tone.SUGGEST_UPGRADES),
        currency=currency,
        reason=reason,
        price_range=price_range,
    )
