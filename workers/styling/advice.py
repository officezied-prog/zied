"""Wardrobe advice: what is missing, and whether to say anything about buying.

Two questions, answered separately and then combined:

  * What does this wardrobe actually fail at? Which occasions cannot be dressed,
    and which colour would unlock the most new combinations. Both are facts
    about the clothes, true regardless of anyone's budget.
  * Should any of that be phrased as something to buy? That is
    `economics.spend_guidance`, and for most wardrobes the answer is no.

Keeping them apart matters. The gaps are always computed and always shown —
knowing you have nothing to wear on your feet to a formal event is useful to
everyone. Only the *purchase framing* is gated.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.db import fetch_all

from .economics import SpendGuidance, Tone, spend_guidance
from .scoring import ColorRules

#: A colour counts as an opportunity only when the wardrobe has none of it.
#: Owning one navy shirt does not make navy a gap — that would be advising
#: someone to buy what they already have.
SCARCE_THRESHOLD = 0
#: A pair at or above this scores as "these work together".
PAIRS_WELL = 0.70


@dataclass(frozen=True)
class OccasionCoverage:
    slug: str
    display_name: str
    wearable: bool
    missing_roles: list[str]
    option_count: int


@dataclass(frozen=True)
class ColorOpportunity:
    family: str
    #: How many owned pieces this colour would pair well with.
    pairs_with: int
    #: Share of the wardrobe it would work alongside.
    coverage: float
    is_neutral: bool


@dataclass(frozen=True)
class Suggestion:
    """Something to acquire. Only ever produced when the tone allows it."""
    role: str
    color_family: str | None
    reason: str
    blocking: bool
    price_low: float | None = None
    price_high: float | None = None
    currency: str = "USD"


@dataclass
class WardrobeAdvice:
    coverage: list[OccasionCoverage] = field(default_factory=list)
    color_opportunities: list[ColorOpportunity] = field(default_factory=list)
    suggestions: list[Suggestion] = field(default_factory=list)
    headline: str = ""
    tone: Tone = Tone.USE_WHAT_YOU_HAVE
    #: Never rendered as a label — carried so the API can explain its own advice.
    guidance: SpendGuidance | None = None

    @property
    def blocked_occasions(self) -> list[OccasionCoverage]:
        return [c for c in self.coverage if not c.wearable]


async def load_coverage(conn: AsyncConnection, user_id: UUID) -> list[OccasionCoverage]:
    rows = await fetch_all(conn, "select * from public.wardrobe_coverage(:u)",
                           {"u": str(user_id)})
    return [
        OccasionCoverage(
            slug=r["occasion_slug"], display_name=r["display_name"],
            wearable=bool(r["wearable"]),
            missing_roles=list(r["missing_roles"] or []),
            option_count=r["option_count"] or 0,
        )
        for r in rows
    ]


async def color_opportunities(conn: AsyncConnection, user_id: UUID, rules: ColorRules,
                              *, limit: int = 3) -> list[ColorOpportunity]:
    """Which absent colour would unlock the most combinations.

    Marginal value, not taste: for every colour the wardrobe barely has, count
    the owned pieces it would pair well with. A neutral usually wins, which is
    the right answer — and it is derived, not asserted.
    """
    owned = await fetch_all(conn, """
        select c.color_family, count(*)::int as n, avg(c.lch_h) as hue, avg(c.lch_c) as chroma
          from public.garment_colors c
          join public.garments g on g.id = c.garment_id
         where g.user_id = :u and g.deleted_at is null and g.is_archived = false
           and c.rank = 1
         group by c.color_family
    """, {"u": str(user_id)})
    if not owned:
        return []

    have = {r["color_family"]: r["n"] for r in owned}
    total = sum(have.values())

    scored: list[ColorOpportunity] = []
    for candidate, meta in rules.families.items():
        if have.get(candidate, 0) > SCARCE_THRESHOLD:
            continue
        pairs = 0
        for r in owned:
            family = r["color_family"]
            if family == candidate:
                continue
            score, _ = rules.pair_score(
                candidate, family,
                None, float(r["hue"]) if r["hue"] is not None else None,
                None, float(r["chroma"]) if r["chroma"] is not None else None,
            )
            if score >= PAIRS_WELL:
                pairs += r["n"]
        if pairs == 0:
            continue
        scored.append(ColorOpportunity(
            family=candidate, pairs_with=pairs,
            coverage=round(pairs / total, 3),
            is_neutral=bool(meta.get("is_neutral")),
        ))

    # A neutral that pairs with as much as a hero colour is the better advice.
    scored.sort(key=lambda o: (-o.pairs_with, not o.is_neutral, o.family))
    return scored[:limit]


async def build_advice(conn: AsyncConnection, user_id: UUID, rules: ColorRules, *,
                       user_band: int | None = None,
                       allow_purchases: bool = True) -> WardrobeAdvice:
    coverage = await load_coverage(conn, user_id)
    opportunities = await color_opportunities(conn, user_id, rules)
    guidance = await spend_guidance(conn, user_id, user_band=user_band,
                                    allow_purchases=allow_purchases)

    advice = WardrobeAdvice(coverage=coverage, color_opportunities=opportunities,
                            tone=guidance.tone, guidance=guidance)
    blocked = advice.blocked_occasions

    def band_for(role: str) -> tuple[float | None, float | None]:
        rng = guidance.price_range.get(role)
        return (rng[0], rng[1]) if rng else (None, None)

    # A blocking gap is stated to everyone: it is not a sales pitch, it is the
    # reason the app cannot dress them for something they asked about.
    if guidance.tone is not Tone.USE_WHAT_YOU_HAVE:
        seen: set[tuple[str, str | None]] = set()
        for occasion in blocked:
            for role in occasion.missing_roles:
                if (role, None) in seen:
                    continue
                seen.add((role, None))
                low, high = band_for(role)
                advice.suggestions.append(Suggestion(
                    role=role, color_family=None,
                    reason=f"nothing you own works as {role.replace('_', ' ')} "
                           f"for {occasion.display_name.lower()}",
                    blocking=True, price_low=low, price_high=high,
                    currency=guidance.currency,
                ))

    # Everything beyond that is optional, and only for wardrobes where a
    # suggestion is welcome rather than a reminder of what someone cannot buy.
    if guidance.suggest_purchases:
        for opportunity in opportunities[:2]:
            low, high = band_for("base_top")
            advice.suggestions.append(Suggestion(
                role="base_top", color_family=opportunity.family,
                reason=f"a {opportunity.family.replace('_', ' ')} piece would work "
                       f"with {opportunity.pairs_with} things you already own",
                blocking=False, price_low=low, price_high=high,
                currency=guidance.currency,
            ))

    advice.headline = _headline(advice, guidance)
    return advice


def _headline(advice: WardrobeAdvice, guidance: SpendGuidance) -> str:
    blocked = advice.blocked_occasions
    wearable = len(advice.coverage) - len(blocked)

    if guidance.tone is Tone.USE_WHAT_YOU_HAVE:
        return (f"Your wardrobe covers {wearable} of {len(advice.coverage)} occasions. "
                "Here are more ways to wear what you have.")
    if blocked:
        names = ", ".join(o.display_name.lower() for o in blocked[:2])
        # Say how many are actually missing. Calling eight gaps "the one thing"
        # is the kind of cheerful inaccuracy that makes advice untrustworthy.
        if len(blocked) == 1:
            tail = f"{names.capitalize()} is the one it cannot."
        else:
            more = f" and {len(blocked) - 2} more" if len(blocked) > 2 else ""
            tail = f"It cannot dress {names}{more} yet."
        return f"Your wardrobe covers {wearable} of {len(advice.coverage)} occasions. {tail}"
    if guidance.suggest_purchases and advice.color_opportunities:
        best = advice.color_opportunities[0]
        return (f"Every occasion is covered. Adding {best.family.replace('_', ' ')} "
                f"would open up {best.pairs_with} more combinations.")
    return "Every occasion is covered by what you already own."
