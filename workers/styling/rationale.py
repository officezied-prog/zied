"""One-line explanations, generated from the score breakdown.

Deliberately template-based rather than model-written: the sentence must be
*true*, and it is assembled from the same numbers the UI shows. An optional LLM
pass can rewrite the phrasing later, but it may only reorder and reword — it
never sees the wardrobe and cannot invent an item.
"""
from __future__ import annotations

from .models import Look
from .scoring import ColorRules, OccasionContext
from .weather import Weather

_HARMONY_PHRASE = {
    "complementary": "a complementary pairing",
    "analogous": "a tonal, analogous pairing",
    "monochromatic": "a tonal, single-hue look",
    "neutral_anchor": "a neutral anchor",
    "split_complementary": "a softened complementary pairing",
    "triadic": "a triadic mix",
    "accent_pop": "an accent pop",
}


def describe(look: Look, *, occasion: OccasionContext, weather: Weather | None,
             rules: ColorRules) -> str:
    parts: list[str] = []

    # Lead with the pair a person actually notices — the top and the bottom (or
    # the one-piece and its layer) — not whichever item happens to be first.
    priority = ("full_body", "base_top", "bottom", "outerwear", "mid_layer", "footwear")
    core = sorted(
        (c for c in look.garments if not c.is_accessory and c.color_family),
        key=lambda c: priority.index(c.role) if c.role in priority else len(priority),
    )
    if len(core) >= 2:
        a, b = core[0], core[1]
        _, harmony = rules.pair_score(a.color_family, b.color_family,
                                      a.lch_h, b.lch_h, a.lch_c, b.lch_c)
        parts.append(
            f"{_pretty(a)} with {_pretty(b)} — {_HARMONY_PHRASE.get(harmony, 'a considered pairing')}"
        )
    elif core:
        parts.append(_pretty(core[0]).capitalize())

    if weather is not None:
        temp = round(weather.effective_temp_c)
        if look.breakdown.get("weather_fit", 0) >= 0.75:
            parts.append(f"right weight for {temp}°C")
        elif look.total_warmth > 6:
            parts.append(f"warm enough for {temp}°C")
        else:
            parts.append(f"light for {temp}°C")
        if weather.precip_prob >= 0.5:
            parts.append("and rain-ready")

    if look.breakdown.get("formality_fit", 0) >= 0.99:
        parts.append(f"pitched right for {occasion.slug.replace('_', ' ')}")

    freshest = max((c for c in look.garments if not c.is_accessory),
                   key=lambda c: c.days_since_worn, default=None)
    if freshest is not None and 14 <= freshest.days_since_worn < 9999:
        weeks = freshest.days_since_worn // 7
        parts.append(f"and you haven't worn the {_noun(freshest)} in {weeks} weeks")
    elif freshest is not None and freshest.days_since_worn >= 9999:
        parts.append(f"and the {_noun(freshest)} is still unworn")

    sentence = ", ".join(parts[:1] + parts[1:])
    return sentence[0].upper() + sentence[1:] if sentence else "A solid option."


def _pretty(c) -> str:
    colour = (c.color_family or "").replace("_", " ")
    return f"the {colour} {_noun(c)}".replace("the  ", "the ")


def _noun(c) -> str:
    return (c.category or c.role).replace("_", " ")
