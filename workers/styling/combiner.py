"""Outfit construction.

A closet of 200 items has ~10^7 naive combinations, so the engine never
enumerates: it fills roles hardest-first with a **beam search**, scoring partial
looks and keeping only the best `beam_width`. Cost is linear in the number of
roles, and the result is stable and explainable.

Two skeletons are built in parallel — separates (top + bottom) and one-piece
(dress/jumpsuit/suit) — because a dress is not a substitute for a top.
"""
from __future__ import annotations

from collections.abc import Iterable

from .models import Candidate, Look
from .scoring import ColorRules, OccasionContext, UserContext, score_look
from .weather import Weather

CORE_SEPARATES = ("base_top", "bottom", "footwear")
CORE_ONE_PIECE = ("full_body", "footwear")
LAYER_ROLES = ("mid_layer", "outerwear")
ACCESSORY_ROLES = ("bag", "belt", "headwear", "eyewear", "jewelry", "watch", "scarf")

# Total warmth below which the engine starts adding layers.
LAYER_TEMPERATURE_C = 18.0


class OutfitCombiner:
    def __init__(self, *, occasion: OccasionContext, weather: Weather | None,
                 rules: ColorRules, user: UserContext,
                 beam_width: int = 24, max_accessories: int = 3) -> None:
        self.occasion = occasion
        self.weather = weather
        self.rules = rules
        self.user = user
        self.beam_width = beam_width
        self.max_accessories = max_accessories

    # ── public ──────────────────────────────────────────────────────────────
    def build(self, candidates: Iterable[Candidate], *, count: int = 5,
              must_include: frozenset[str] = frozenset()) -> list[Look]:
        pool = self._by_role(candidates)
        looks: list[Look] = []

        for skeleton in (CORE_SEPARATES, CORE_ONE_PIECE):
            if all(pool.get(role) for role in skeleton):
                looks.extend(self._beam(pool, skeleton, must_include))

        looks = self._diversify(sorted(looks, key=lambda look: -look.score), count)
        return looks

    # ── internals ───────────────────────────────────────────────────────────
    def _by_role(self, candidates: Iterable[Candidate]) -> dict[str, list[Candidate]]:
        pool: dict[str, list[Candidate]] = {}
        for c in candidates:
            if c.role in self.occasion.banned_roles:
                continue
            if c.category in self.occasion.banned_categories:
                continue
            if c.pattern in self.occasion.banned_patterns:
                continue
            if c.category in self.user.avoided_categories:
                continue
            pool.setdefault(c.role, []).append(c)
        return pool

    def _roles_for(self, skeleton: tuple[str, ...],
                   pool: dict[str, list[Candidate]]) -> list[str]:
        roles = list(skeleton)

        cold = self.weather is None or self.weather.effective_temp_c < LAYER_TEMPERATURE_C
        if cold:
            roles += [r for r in LAYER_ROLES if pool.get(r)]

        roles += [r for r in self.occasion.required_roles
                  if r not in roles and pool.get(r)]
        roles += [r for r in self.occasion.optional_roles
                  if r not in roles and pool.get(r)][:self.max_accessories]
        if len(roles) < len(skeleton) + self.max_accessories:
            roles += [r for r in ACCESSORY_ROLES if r not in roles and pool.get(r)][
                :self.max_accessories]

        # Hardest first: a role with two candidates constrains everything after it.
        core = set(skeleton)
        return sorted(roles, key=lambda r: (r not in core, len(pool.get(r, []))))

    def _beam(self, pool: dict[str, list[Candidate]], skeleton: tuple[str, ...],
              must_include: frozenset[str]) -> list[Look]:
        roles = self._roles_for(skeleton, pool)
        beam: list[Look] = [Look()]

        for index, role in enumerate(roles):
            options = pool.get(role, [])
            if not options:
                continue
            optional = role not in skeleton and role not in self.occasion.required_roles

            expanded: list[Look] = []
            for look in beam:
                for candidate in options[: self.beam_width]:
                    expanded.append(look.with_item(role, candidate))
                if optional:
                    expanded.append(look)          # wearing nothing there is allowed

            scored = [
                score_look(look, occasion=self.occasion, weather=self.weather,
                           rules=self.rules, user=self.user)
                for look in expanded
            ]
            # Keep the beam wide while core roles are still unfilled.
            width = self.beam_width if index < len(skeleton) else max(8, self.beam_width // 2)
            beam = sorted(scored, key=lambda look: -look.score)[:width]

        final = [
            look for look in beam
            if all(r in look.items for r in skeleton)
            and (not must_include
                 or must_include <= {str(c.garment_id) for c in look.garments})
        ]
        return final

    def _diversify(self, looks: list[Look], count: int) -> list[Look]:
        """Five variations on one shirt is one suggestion, not five."""
        chosen: list[Look] = []
        seen_signatures: set[tuple] = set()
        for look in looks:
            if look.signature in seen_signatures:
                continue
            core = {str(c.garment_id) for c in look.garments if not c.is_accessory}
            if any(len(core & prev) >= max(1, len(core) - 1) for prev in
                   ({str(c.garment_id) for c in p.garments if not c.is_accessory}
                    for p in chosen)):
                continue
            chosen.append(look)
            seen_signatures.add(look.signature)
            if len(chosen) >= count:
                break

        # If the near-duplicate rule was too strict for a small closet, relax it —
        # but an *exactly* identical core is never a second suggestion.
        if len(chosen) < count:
            seen_cores = {frozenset(str(c.garment_id) for c in p.garments
                                    if not c.is_accessory) for p in chosen}
            for look in looks:
                core = frozenset(str(c.garment_id) for c in look.garments
                                 if not c.is_accessory)
                if look.signature in seen_signatures or core in seen_cores:
                    continue
                chosen.append(look)
                seen_signatures.add(look.signature)
                seen_cores.add(core)
                if len(chosen) >= count:
                    break
        return chosen
