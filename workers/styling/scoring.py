"""Outfit scoring.

Every term returns 0..1 and is explainable on its own — the UI shows the
breakdown, so "why this outfit" is data, not a generated story. Occasions
multiply the base weights via `occasions.scoring_weights`, which means tuning
"date night cares more about colour" is an UPDATE, not a deploy.

The colour-pair logic mirrors `public.score_color_pair` in migration 0009; the
two are pinned to each other by a test, because the engine scores in Python
while candidate retrieval and any SQL-side analytics use the database version.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .embeddings import cosine
from .models import Look
from .weather import Weather

# Base weights. Occasion overrides are multiplicative.
BASE_WEIGHTS: dict[str, float] = {
    "color_harmony": 1.00,
    "palette_fit": 0.55,
    "formality_fit": 1.10,
    "weather_fit": 0.95,
    "pattern_balance": 0.60,
    "proportion_fit": 0.45,
    "personal_taste": 0.85,
    "novelty": 0.50,
    "preference_fit": 0.70,
    "completeness": 1.20,
}

BUSY_PATTERNS = frozenset({
    "floral", "animal", "graphic", "paisley", "abstract", "tie_dye",
    "camouflage", "polka_dot", "plaid", "logo",
})

# Target total warmth of the non-accessory layers, by felt temperature.
WARMTH_TARGETS: tuple[tuple[float, float], ...] = (
    (30.0, 2.0), (26.0, 3.0), (22.0, 4.0), (18.0, 5.0),
    (12.0, 7.0), (6.0, 9.0), (0.0, 11.0), (-100.0, 13.0),
)

# Body-shape guidance, kept as data so a stylist can revise it without code.
PROPORTION_RULES: dict[str, dict[str, float]] = {
    "pear":              {"prefer_top_pattern": 0.1, "prefer_dark_bottom": 0.15},
    "apple":             {"prefer_dark_top": 0.12, "prefer_layered": 0.1},
    "inverted_triangle": {"prefer_dark_top": 0.12, "prefer_pattern_bottom": 0.1},
    "hourglass":         {"prefer_belt": 0.12},
    "rectangle":         {"prefer_belt": 0.1, "prefer_layered": 0.08},
}


@dataclass
class ColorRules:
    """Preloaded colour reference data (families + curated pairings)."""
    families: dict[str, dict] = field(default_factory=dict)
    pairs: dict[tuple[str, str], tuple[float, str]] = field(default_factory=dict)
    palette_affinity: dict[tuple[str, str], float] = field(default_factory=dict)

    def pair_score(self, a: str | None, b: str | None,
                   hue_a: float | None = None, hue_b: float | None = None,
                   chroma_a: float | None = None, chroma_b: float | None = None
                   ) -> tuple[float, str]:
        if not a or not b:
            return 0.30, "accent_pop"

        rule = self.pairs.get((a, b)) or self.pairs.get((b, a))
        if rule:
            return rule

        if self.families.get(a, {}).get("is_neutral") or \
           self.families.get(b, {}).get("is_neutral"):
            return 0.65, "neutral_anchor"

        if hue_a is None or hue_b is None:
            return 0.30, "accent_pop"

        dh = abs(hue_a - hue_b)
        if dh > 180:
            dh = 360 - dh

        if dh <= 12:
            score, harmony = 0.80, "monochromatic"
        elif dh <= 45:
            score, harmony = 0.75, "analogous"
        elif dh <= 95:
            score, harmony = 0.35, "accent_pop"
        elif dh <= 135:
            score, harmony = 0.60, "triadic"
        elif dh <= 165:
            score, harmony = 0.70, "split_complementary"
        else:
            score, harmony = 0.78, "complementary"

        if (chroma_a or 0) > 55 and (chroma_b or 0) > 55 and dh > 45:
            score -= 0.25
        return score, harmony


@dataclass
class UserContext:
    seasonal_palette: str | None = None
    body_shape: str | None = None
    taste_vector: np.ndarray | None = None
    preferred_colors: tuple[str, ...] = ()
    avoided_colors: tuple[str, ...] = ()
    avoided_categories: frozenset[str] = frozenset()
    avoided_patterns: frozenset[str] = frozenset()
    favourite_brands: frozenset[str] = frozenset()
    modesty_rules: dict = field(default_factory=dict)


@dataclass
class OccasionContext:
    slug: str
    formality_min: int
    formality_max: int
    required_roles: tuple[str, ...] = ()
    optional_roles: tuple[str, ...] = ()
    banned_roles: frozenset[str] = frozenset()
    banned_categories: frozenset[str] = frozenset()
    banned_patterns: frozenset[str] = frozenset()
    weights: dict[str, float] = field(default_factory=dict)

    def weight(self, term: str) -> float:
        return BASE_WEIGHTS.get(term, 0.0) * float(self.weights.get(term, 1.0))


# ── individual terms ────────────────────────────────────────────────────────
def color_harmony(look: Look, rules: ColorRules) -> float:
    core = [c for c in look.garments if c.color_family]
    if len(core) < 2:
        return 0.7
    scores, weights = [], []
    for i, a in enumerate(core):
        for b in core[i + 1:]:
            score, _ = rules.pair_score(a.color_family, b.color_family,
                                        a.lch_h, b.lch_h, a.lch_c, b.lch_c)
            # Accessories carry less visual weight than a coat.
            w = 0.4 if (a.is_accessory or b.is_accessory) else 1.0
            scores.append(max(0.0, score))
            weights.append(w)
    value = float(np.average(scores, weights=weights))

    # More than two saturated hero colours reads as chaos regardless of pairing.
    heroes = sum(1 for c in core if not c.is_neutral and (c.lch_c or 0) > 45)
    if heroes > 2:
        value *= 0.75
    return min(1.0, value)


def palette_fit(look: Look, rules: ColorRules, user: UserContext) -> float:
    if not user.seasonal_palette or user.seasonal_palette == "unspecified":
        return 0.5                                   # unknown, so neutral
    values = [
        rules.palette_affinity.get((user.seasonal_palette, c.color_family))
        for c in look.garments if c.color_family
    ]
    known = [v for v in values if v is not None]
    if not known:
        return 0.5
    return float(np.clip((np.mean(known) + 1) / 2, 0, 1))


def formality_fit(look: Look, occasion: OccasionContext) -> float:
    mean = look.mean_formality
    if occasion.formality_min <= mean <= occasion.formality_max:
        return 1.0
    distance = (occasion.formality_min - mean if mean < occasion.formality_min
                else mean - occasion.formality_max)
    return float(max(0.0, 1.0 - distance / 2.0))


def _warmth_target(temp_c: float) -> float:
    for threshold, target in WARMTH_TARGETS:
        if temp_c >= threshold:
            return target
    return WARMTH_TARGETS[-1][1]


def weather_fit(look: Look, weather: Weather | None) -> float:
    if weather is None:
        return 0.6
    target = _warmth_target(weather.effective_temp_c)
    delta = abs(look.total_warmth - target)
    value = float(max(0.0, 1.0 - delta / 6.0))

    if weather.precip_prob >= 0.4:
        footwear = look.items.get("footwear")
        outer = look.items.get("outerwear")
        if footwear and "suede" in (footwear.material or []):
            value *= 0.4
        if weather.precip_prob >= 0.6 and not (outer or look.items.get("mid_layer")):
            value *= 0.75
    if (weather.uv_index or 0) >= 8 and not look.items.get("headwear"):
        value *= 0.9

    # Big diurnal swing: a look you cannot adjust is the wrong look.
    if (weather.temp_min_c is not None and weather.temp_max_c is not None
            and (weather.temp_max_c - weather.temp_min_c) >= 12
            and not any(c.is_layerable for c in look.garments)):
        value *= 0.85
    return min(1.0, value)


def pattern_balance(look: Look) -> float:
    busy = [c for c in look.garments if c.pattern in BUSY_PATTERNS]
    if len(busy) == 0:
        return 0.85           # all-solid is safe but not remarkable
    if len(busy) == 1:
        return 1.0            # one focal point is the ideal
    if len(busy) == 2 and all(c.is_accessory for c in busy[1:]):
        return 0.7
    return max(0.15, 1.0 - 0.3 * (len(busy) - 1))


def proportion_fit(look: Look, user: UserContext) -> float:
    rules = PROPORTION_RULES.get(user.body_shape or "")
    if not rules:
        return 0.5
    value = 0.5
    top, bottom = look.items.get("base_top"), look.items.get("bottom")
    if "prefer_dark_bottom" in rules and bottom and (bottom.lab or (100,))[0] < 45:
        value += rules["prefer_dark_bottom"]
    if "prefer_dark_top" in rules and top and (top.lab or (100,))[0] < 45:
        value += rules["prefer_dark_top"]
    if "prefer_top_pattern" in rules and top and top.pattern != "solid":
        value += rules["prefer_top_pattern"]
    if "prefer_pattern_bottom" in rules and bottom and bottom.pattern != "solid":
        value += rules["prefer_pattern_bottom"]
    if "prefer_belt" in rules and look.items.get("belt"):
        value += rules["prefer_belt"]
    if "prefer_layered" in rules and (look.items.get("mid_layer") or look.items.get("outerwear")):
        value += rules["prefer_layered"]
    return float(min(1.0, value))


def personal_taste(look: Look, user: UserContext) -> float:
    if user.taste_vector is None:
        return 0.5
    vectors = [c.embedding for c in look.garments if c.embedding is not None]
    if not vectors:
        return 0.5
    mean = np.mean(vectors, axis=0)
    return float(np.clip((cosine(mean, user.taste_vector) + 1) / 2, 0, 1))


def novelty(look: Look) -> float:
    core = [c for c in look.garments if not c.is_accessory]
    if not core:
        return 0.5
    # Saturates at 30 days: something unworn for a year is not twice as fresh
    # as something unworn for six months.
    return float(np.mean([min(c.days_since_worn, 30) / 30 for c in core]))


def preference_fit(look: Look, user: UserContext) -> float:
    value = 0.7
    for c in look.garments:
        if c.color_family in user.avoided_colors:
            value -= 0.25
        elif c.color_family in user.preferred_colors:
            value += 0.08
        if c.category in user.avoided_categories:
            value -= 0.35
        if c.pattern in user.avoided_patterns:
            value -= 0.2
    return float(np.clip(value, 0.0, 1.0))


def completeness(look: Look, occasion: OccasionContext) -> float:
    required = set(occasion.required_roles) | {"footwear"}
    has_body = "full_body" in look.items or (
        "base_top" in look.items and "bottom" in look.items)
    missing = [r for r in required if r not in look.items]
    value = 1.0 if has_body else 0.3
    if missing:
        value *= max(0.2, 1.0 - 0.4 * len(missing))
    return value


# ── aggregation ─────────────────────────────────────────────────────────────
def score_look(look: Look, *, occasion: OccasionContext, weather: Weather | None,
               rules: ColorRules, user: UserContext) -> Look:
    terms = {
        "color_harmony": color_harmony(look, rules),
        "palette_fit": palette_fit(look, rules, user),
        "formality_fit": formality_fit(look, occasion),
        "weather_fit": weather_fit(look, weather),
        "pattern_balance": pattern_balance(look),
        "proportion_fit": proportion_fit(look, user),
        "personal_taste": personal_taste(look, user),
        "novelty": novelty(look),
        "preference_fit": preference_fit(look, user),
        "completeness": completeness(look, occasion),
    }
    weights = {k: occasion.weight(k) for k in terms}
    total = sum(weights.values()) or 1.0
    look.score = round(sum(terms[k] * weights[k] for k in terms) / total, 4)
    look.breakdown = {k: round(v, 4) for k, v in terms.items()}
    return look
