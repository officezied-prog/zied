"""Shop mode: judging a garment on the rack against the wardrobe at home.

The question in a shop is never "is this nice". It is "will I wear it", and the
only honest way to answer that is to count. Three numbers decide it:

  duplicates    pieces already owned that are close enough to be the same thing
  new pairings  pieces already owned that this would newly work with
  unlocked      occasions the wardrobe cannot dress today and could with this

A garment that duplicates what is in the wardrobe and unlocks nothing gets a
plain "you have three of these" — and then, because that alone is unhelpful,
the colours and shapes that *are* missing, so the trip is not wasted.

None of this needs a price, a shop or a brand. It is arithmetic over clothes
the user already owns.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from uuid import UUID

import numpy as np
from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.db import fetch_all, fetch_one
from workers.vision.color import ciede2000

from .advice import ColorOpportunity, color_opportunities, load_coverage
from .scoring import ColorRules

#: Two garments closer than this in CIEDE2000, in the same category, are the
#: same purchase. Around 8 is "a person would call these the same colour".
DUPLICATE_DELTA_E = 8.0
#: A looser threshold for "you already own this colour in this role".
SAME_FAMILY_ROLES = frozenset({"base_top", "bottom", "full_body", "outerwear", "footwear"})
#: A pair at or above this can be worn together. The colour catalogue scores a
#: neutral anchor at exactly 0.65 — "safe with anything" — so the bar sits here:
#: above it and the count was calling an olive jacket unwearable against a
#: wardrobe of navy, grey and camel, which is nonsense.
WEARABLE = 0.65
#: A pair at or above this is actively good, and worth naming as an outfit.
PAIRS_WELL = 0.75
#: Above this share of a role, a colour is saturated.
SATURATED_SHARE = 0.40

#: Roles that combine with each other into an outfit.
COMPLEMENTS: dict[str, frozenset[str]] = {
    "base_top": frozenset({"bottom", "outerwear", "footwear", "bag"}),
    "mid_layer": frozenset({"bottom", "outerwear", "footwear"}),
    "bottom": frozenset({"base_top", "mid_layer", "outerwear", "footwear", "bag"}),
    "full_body": frozenset({"outerwear", "footwear", "bag", "belt"}),
    "outerwear": frozenset({"base_top", "bottom", "full_body", "footwear"}),
    "footwear": frozenset({"base_top", "bottom", "full_body", "outerwear", "bag"}),
    "bag": frozenset({"base_top", "bottom", "full_body", "footwear"}),
}


class Verdict(StrEnum):
    FILLS_A_GAP = "fills_a_gap"
    ADDS_VARIETY = "adds_variety"
    HAVE_SIMILAR = "have_similar"
    HARD_TO_WEAR = "hard_to_wear"


@dataclass(frozen=True)
class Candidate:
    """The thing in the shop, as the camera saw it."""
    role: str
    category: str
    category_id: int | None
    color_family: str
    primary_hex: str
    lab: tuple[float, float, float]
    pattern: str = "solid"
    formality: int = 3
    confidence: float = 0.0


@dataclass(frozen=True)
class OwnedMatch:
    garment_id: UUID
    name: str
    hex: str
    delta_e: float


@dataclass(frozen=True)
class WearWith:
    """A piece at home this would go with — the outfit it would join."""
    garment_id: UUID
    name: str
    role: str
    hex: str
    score: float


@dataclass
class ScanResult:
    candidate: Candidate
    verdict: Verdict
    duplicates: list[OwnedMatch] = field(default_factory=list)
    new_pairings: int = 0
    total_complements: int = 0
    unlocked_occasions: list[str] = field(default_factory=list)
    #: The outfit this would make out of clothes already at home.
    wear_with: list[WearWith] = field(default_factory=list)
    role_family_share: float = 0.0
    headline: str = ""
    detail: str = ""
    #: What to look for instead, when this one is a duplicate.
    look_for_colors: list[ColorOpportunity] = field(default_factory=list)
    look_for_roles: list[str] = field(default_factory=list)

    @property
    def pairing_share(self) -> float:
        return round(self.new_pairings / self.total_complements, 3) \
            if self.total_complements else 0.0


async def _owned(conn: AsyncConnection, user_id: UUID) -> list[dict]:
    rows = await fetch_all(conn, """
        select g.id, g.name, g.role::text as role, g.category_id, g.formality,
               cat.slug as category,
               pc.hex, pc.color_family, pc.lab_l, pc.lab_a, pc.lab_b,
               pc.lch_h, pc.lch_c, pc.is_neutral
          from public.garments g
          join public.garment_categories cat on cat.id = g.category_id
          left join public.v_garment_primary_color pc on pc.garment_id = g.id
         where g.user_id = :u and g.deleted_at is null and g.is_archived = false
           and g.ownership in ('owned','borrowed')
    """, {"u": str(user_id)})
    return [dict(r) for r in rows]


def _duplicates(candidate: Candidate, owned: list[dict]) -> list[OwnedMatch]:
    """Same category, and a colour a person would call the same."""
    target = np.array(candidate.lab, dtype=float)
    matches: list[OwnedMatch] = []
    for item in owned:
        if item["category"] != candidate.category:
            continue
        if item["lab_l"] is None:
            continue
        other = np.array([float(item["lab_l"]), float(item["lab_a"]),
                          float(item["lab_b"])])
        delta = float(ciede2000(target, other))
        if delta <= DUPLICATE_DELTA_E:
            matches.append(OwnedMatch(
                garment_id=item["id"], name=item["name"] or item["category"],
                hex=item["hex"] or "#000000", delta_e=round(delta, 2)))
    return sorted(matches, key=lambda m: m.delta_e)


def _pairings(candidate: Candidate, owned: list[dict], rules: ColorRules
              ) -> tuple[int, int, list[WearWith]]:
    """How many pieces in complementary roles this would work with — and which.

    Counting alone answers "should I buy it". The shopper standing in the shop
    also wants the other half: what at home they would actually wear it with.
    """
    complements = COMPLEMENTS.get(candidate.role, frozenset())
    total = works = 0
    matches: list[WearWith] = []
    for item in owned:
        if item["role"] not in complements or not item["color_family"]:
            continue
        total += 1
        score, _ = rules.pair_score(
            candidate.color_family, item["color_family"],
            None, float(item["lch_h"]) if item["lch_h"] is not None else None,
            None, float(item["lch_c"]) if item["lch_c"] is not None else None,
        )
        if score < WEARABLE:
            continue
        works += 1
        if score >= PAIRS_WELL:
            matches.append(WearWith(
                garment_id=item["id"], name=item["name"] or item["category"],
                role=item["role"], hex=item["hex"] or "#000000",
                score=round(float(score), 3)))
    return works, total, _one_per_role(matches)


def _one_per_role(matches: list[WearWith], limit: int = 3) -> list[WearWith]:
    """An outfit, not a list: the best of each role, in the order worn."""
    order = ("base_top", "full_body", "bottom", "mid_layer", "outerwear",
             "footwear", "bag", "belt", "scarf", "headwear")
    best: dict[str, WearWith] = {}
    for match in sorted(matches, key=lambda m: (-m.score, m.name)):
        best.setdefault(match.role, match)
    ranked = sorted(best.values(),
                    key=lambda m: order.index(m.role) if m.role in order else 99)
    return ranked[:limit]


async def _unlocked(conn: AsyncConnection, user_id: UUID, candidate: Candidate
                    ) -> list[str]:
    """Occasions blocked today that this garment would make wearable.

    Exact rather than simulated: coverage already reports which slot blocks each
    occasion, so the test is whether this garment fills the last one and its
    formality is inside the occasion's band.
    """
    coverage = await load_coverage(conn, user_id)
    blocked = [c for c in coverage if not c.wearable]
    if not blocked:
        return []

    bands = {
        r["slug"]: (r["formality_min"], r["formality_max"])
        for r in await fetch_all(conn, """
            select slug, formality_min, formality_max from public.occasions
             where is_active and (user_id is null or user_id = :u)
        """, {"u": str(user_id)})
    }

    fills = {candidate.role}
    if candidate.role == "full_body":
        fills |= {"base_top", "bottom"}

    unlocked = []
    for occasion in blocked:
        low, high = bands.get(occasion.slug, (1, 5))
        if not (low <= candidate.formality <= high):
            continue
        # It has to be the *only* thing missing, otherwise nothing is unlocked.
        if set(occasion.missing_roles) <= fills:
            unlocked.append(occasion.display_name)
    return unlocked


def _decide(duplicates: int, unlocked: list[str], pairing_share: float,
            role_family_share: float) -> Verdict:
    if unlocked:
        return Verdict.FILLS_A_GAP
    if duplicates or role_family_share >= SATURATED_SHARE:
        return Verdict.HAVE_SIMILAR
    if pairing_share < 0.25:
        return Verdict.HARD_TO_WEAR
    return Verdict.ADDS_VARIETY


async def scan(conn: AsyncConnection, user_id: UUID, candidate: Candidate,
               rules: ColorRules) -> ScanResult:
    owned = await _owned(conn, user_id)
    duplicates = _duplicates(candidate, owned)
    works, total, wear_with = _pairings(candidate, owned, rules)
    unlocked = await _unlocked(conn, user_id, candidate)

    saturation = await fetch_one(conn, """
        select * from public.wardrobe_saturation(
            :u, cast(:role as public.garment_role), :fam)
    """, {"u": str(user_id), "role": candidate.role, "fam": candidate.color_family})
    role_family_share = float(saturation["role_family_share"] or 0) if saturation else 0.0

    result = ScanResult(
        candidate=candidate, verdict=Verdict.ADDS_VARIETY, duplicates=duplicates,
        new_pairings=works, total_complements=total, unlocked_occasions=unlocked,
        wear_with=wear_with, role_family_share=role_family_share,
    )
    result.verdict = _decide(len(duplicates), unlocked, result.pairing_share,
                             role_family_share)

    # When the answer is "you have this already", say what is missing instead —
    # otherwise the app has told a shopper standing in a shop precisely nothing.
    if result.verdict in (Verdict.HAVE_SIMILAR, Verdict.HARD_TO_WEAR):
        result.look_for_colors = await color_opportunities(conn, user_id, rules, limit=3)
        result.look_for_roles = await _thin_roles(conn, user_id)

    result.headline, result.detail = _describe(result)
    return result


async def _thin_roles(conn: AsyncConnection, user_id: UUID, limit: int = 3) -> list[str]:
    """Shapes the wardrobe is short of, commonest first among the missing."""
    rows = await fetch_all(conn, """
        with owned as (
          select role::text as role, count(*)::int as n
            from public.garments
           where user_id = :u and deleted_at is null and is_archived = false
             and ownership in ('owned','borrowed')
           group by role
        )
        select r.role, coalesce(o.n, 0) as n
          from unnest(array['base_top','bottom','full_body','outerwear',
                            'footwear','bag']) as r(role)
          left join owned o on o.role = r.role
         order by n asc, r.role
    """, {"u": str(user_id)})
    return [r["role"] for r in rows if r["n"] <= 1][:limit]


#: Roles named the way a person names them, and always plural so the sentences
#: they land in stay grammatical.
ROLE_PHRASE: dict[str, str] = {
    "base_top": "tops",
    "mid_layer": "mid layers",
    "bottom": "bottoms",
    "full_body": "one-pieces",
    "outerwear": "outer layers",
    "footwear": "shoes",
    "bag": "bags",
    "belt": "belts",
    "hosiery": "hosiery",
    "scarf": "scarves",
    "headwear": "hats",
}


def _join(parts: list[str], conjunction: str = "or") -> str:
    if len(parts) <= 1:
        return "".join(parts)
    return f"{', '.join(parts[:-1])} {conjunction} {parts[-1]}"


def _describe(result: ScanResult) -> tuple[str, str]:
    c = result.candidate
    colour = c.color_family.replace("_", " ")

    if result.verdict is Verdict.FILLS_A_GAP:
        return ("This fills a real gap.",
                f"{_blocked_sentence(result)} This would fix that, and it works "
                f"with {result.new_pairings} pieces you already own."
                f"{_wear_with_sentence(result)}")

    if result.verdict is Verdict.HAVE_SIMILAR:
        if result.duplicates:
            owned_names = _join([d.name for d in result.duplicates[:2]], "and")
            have = (f"You already own {len(result.duplicates)} almost exactly "
                    f"like it ({owned_names}).")
        else:
            phrase = ROLE_PHRASE.get(c.role, c.role.replace("_", " "))
            have = (f"Of the {phrase} you own, "
                    f"{int(result.role_family_share * 100)}% are already {colour}.")
        return "You have this covered.", f"{have} {_missing_sentence(result)}".strip()

    if result.verdict is Verdict.HARD_TO_WEAR:
        return ("This would be hard to wear.",
                f"It works with only {result.new_pairings} of "
                f"{result.total_complements} pieces you own. "
                f"{_missing_sentence(result)}".strip())

    return ("This would earn its place.",
            f"It works with {result.new_pairings} of {result.total_complements} "
            f"pieces you already own.{_wear_with_sentence(result)}")


def _blocked_sentence(result: ScanResult) -> str:
    """Name what is blocked without pretending two of nine is the whole list."""
    names = [o.lower() for o in result.unlocked_occasions]
    if len(names) <= 2:
        return f"You cannot dress {_join(names)} today."
    return (f"You cannot dress {len(names)} occasions today, "
            f"{_join(names[:2], 'and')} among them.")


def _wear_with_sentence(result: ScanResult) -> str:
    """Name the outfit, not just the count. Empty when there is nothing to name."""
    if not result.wear_with:
        return ""
    return f" Wear it with your {_join([w.name for w in result.wear_with], 'and')}."


def _missing_sentence(result: ScanResult) -> str:
    parts = []
    if result.look_for_colors:
        colours = _join([o.family.replace("_", " ")
                         for o in result.look_for_colors[:3]])
        parts.append(f"What you are short of is {colours}")
    if result.look_for_roles:
        shapes = _join([ROLE_PHRASE.get(r, r.replace("_", " "))
                        for r in result.look_for_roles])
        parts.append(f"and you own almost no {shapes}")
    return (" ".join(parts) + ".") if parts else ""
