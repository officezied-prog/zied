"""The styling engine: scoring terms, combination, persistence, feedback."""
from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text

from workers.styling.models import Candidate, Look
from workers.styling.scoring import (
    BASE_WEIGHTS,
    OccasionContext,
    color_harmony,
    formality_fit,
    novelty,
    pattern_balance,
    weather_fit,
)
from workers.styling.weather import StaticWeatherProvider, Weather, WeatherService


def make_candidate(**kw) -> Candidate:
    base = {
        "garment_id": uuid4(), "role": "base_top", "category_id": 1, "category": "shirt",
        "formality": 3, "warmth": 1, "pattern": "solid", "material": ["cotton"],
        "is_layerable": True, "primary_hex": "#1B2A4A", "color_family": "navy",
        "lab": (17.4, 5.1, -21.8), "lch_h": 283.0, "lch_c": 22.4, "is_neutral": True,
        "wear_count": 0, "days_since_worn": 30,
    }
    base.update(kw)
    return Candidate(**base)


@pytest.fixture
async def rules(engine):
    from workers.styling.engine import StylingEngine

    async with engine.connect() as conn:
        return await StylingEngine().color_rules(conn)


# ── colour scoring, pinned to the SQL implementation ────────────────────────
async def test_python_and_sql_colour_pairing_agree(engine, rules):
    """The engine scores pairs in Python; SQL has the same rules. Keep them equal."""
    families = ["navy", "camel", "white", "black", "red", "green", "olive",
                "burgundy", "pink", "teal", "mustard", "grey"]
    async with engine.connect() as conn:
        for a in families:
            for b in families:
                if a == b:
                    continue
                hue_a = 283.0 if a == "navy" else 60.0
                hue_b = 283.0 if b == "navy" else 60.0
                sql = (await conn.execute(text(
                    "select score, harmony::text as harmony "
                    "from public.score_color_pair(:a, :b, :ha, :hb, null, null)"),
                    {"a": a, "b": b, "ha": hue_a, "hb": hue_b})).mappings().one()
                py_score, py_harmony = rules.pair_score(a, b, hue_a, hue_b)
                assert float(sql["score"]) == pytest.approx(py_score, abs=1e-6), (a, b)
                assert sql["harmony"] == py_harmony, (a, b)


def test_curated_pairing_beats_awkward_hue_gap(rules):
    navy_camel, _ = rules.pair_score("navy", "camel")
    red_green, _ = rules.pair_score("red", "green")
    assert navy_camel > 0.9
    assert red_green < 0.3


def test_color_harmony_penalises_three_hero_colours(rules):
    calm = Look(items={
        "base_top": make_candidate(color_family="navy", is_neutral=True, lch_c=22),
        "bottom": make_candidate(role="bottom", color_family="camel", is_neutral=True, lch_c=35),
    })
    loud = Look(items={
        "base_top": make_candidate(color_family="red", is_neutral=False, lch_c=80, lch_h=35),
        "bottom": make_candidate(role="bottom", color_family="green", is_neutral=False,
                                 lch_c=70, lch_h=145),
        "footwear": make_candidate(role="footwear", color_family="purple", is_neutral=False,
                                   lch_c=75, lch_h=310),
    })
    assert color_harmony(calm, rules) > color_harmony(loud, rules)


# ── other terms ─────────────────────────────────────────────────────────────
def test_formality_fit_is_symmetric_around_the_band():
    occ = OccasionContext(slug="business_meeting", formality_min=4, formality_max=5)
    inside = Look(items={"base_top": make_candidate(formality=4)})
    too_casual = Look(items={"base_top": make_candidate(formality=2)})
    assert formality_fit(inside, occ) == 1.0
    assert formality_fit(too_casual, occ) == pytest.approx(0.0, abs=1e-9)


@pytest.mark.parametrize(("temp", "warmth", "expect_good"), [
    (32.0, 2, True), (32.0, 11, False), (-2.0, 12, True), (-2.0, 2, False),
])
def test_weather_fit_tracks_temperature(temp, warmth, expect_good):
    look = Look(items={"base_top": make_candidate(warmth=warmth)})
    value = weather_fit(look, Weather(temp_c=temp, feels_like_c=temp))
    assert (value > 0.7) is expect_good


def test_rain_penalises_suede_footwear():
    dry = Weather(temp_c=15, feels_like_c=15, precip_prob=0.0)
    wet = Weather(temp_c=15, feels_like_c=15, precip_prob=0.8)
    look = Look(items={
        "base_top": make_candidate(warmth=3),
        "footwear": make_candidate(role="footwear", material=["suede"], warmth=2),
        "outerwear": make_candidate(role="outerwear", warmth=2),
    })
    assert weather_fit(look, wet) < weather_fit(look, dry) * 0.6


def test_pattern_balance_prefers_one_focal_point():
    solid = Look(items={"base_top": make_candidate(pattern="solid"),
                        "bottom": make_candidate(role="bottom", pattern="solid")})
    one = Look(items={"base_top": make_candidate(pattern="floral"),
                      "bottom": make_candidate(role="bottom", pattern="solid")})
    two = Look(items={"base_top": make_candidate(pattern="floral"),
                      "bottom": make_candidate(role="bottom", pattern="plaid")})
    assert pattern_balance(one) > pattern_balance(solid) > pattern_balance(two)


def test_novelty_rewards_neglected_items():
    fresh = Look(items={"base_top": make_candidate(days_since_worn=45)})
    stale = Look(items={"base_top": make_candidate(days_since_worn=1)})
    assert novelty(fresh) == 1.0
    assert novelty(stale) < 0.1


def test_occasion_weights_override_the_base():
    occ = OccasionContext(slug="x", formality_min=1, formality_max=5,
                          weights={"novelty": 0.1, "formality_fit": 2.0})
    assert occ.weight("novelty") == pytest.approx(BASE_WEIGHTS["novelty"] * 0.1)
    assert occ.weight("formality_fit") == pytest.approx(BASE_WEIGHTS["formality_fit"] * 2.0)
    assert occ.weight("color_harmony") == BASE_WEIGHTS["color_harmony"]


# ── weather service ─────────────────────────────────────────────────────────
async def test_weather_is_cached_per_cell(engine, user_id):
    provider = StaticWeatherProvider(Weather(temp_c=31.0, feels_like_c=35.0, precip_prob=0.0))
    service = WeatherService(provider)
    at = datetime(2026, 9, 13, 15, 0, tzinfo=UTC)

    async with engine.begin() as conn:
        await conn.execute(text("select set_config('app.current_user_id', :u, true)"),
                           {"u": str(user_id)})
        first, id1 = await service.resolve(conn, 25.2048, 55.2708, at)
        _, id2 = await service.resolve(conn, 25.2049, 55.2709, at)   # same cell
        _, id3 = await service.resolve(conn, 51.5074, -0.1278, at)   # different cell

    assert first.temp_c == 31.0 and id1 == id2
    assert provider.calls == 2, "the second lookup must be served from cache"
    assert id3 != id1


async def test_weather_failure_does_not_break_recommendation(engine, user_id):
    class Broken:
        name = "broken"

        async def fetch(self, lat, lon, at):
            return None

    async with engine.begin() as conn:
        await conn.execute(text("select set_config('app.current_user_id', :u, true)"),
                           {"u": str(user_id)})
        weather, snapshot = await WeatherService(Broken()).resolve(conn, 10.0, 10.0)
    assert weather is None and snapshot is None


async def test_weather_cache_rejects_unauthenticated_and_absurd_writes(engine, user_id):
    """The cache is shared, so a client must not be able to poison a whole map cell."""
    from datetime import timedelta

    from sqlalchemy.exc import DBAPIError

    call = text("""
        select public.upsert_weather_snapshot(
            cast(:cell as char(5)), :at, 'test', :temp, null, null, null,
            null, null, :pop, null, 'clear', true)
    """)
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)

    async with engine.begin() as conn:                      # no identity set
        with pytest.raises(DBAPIError, match="not authenticated"):
            await conn.execute(call, {"cell": "thrr3", "at": now, "temp": 20, "pop": 0.1})

    async with engine.begin() as conn:
        await conn.execute(text("select set_config('app.current_user_id', :u, true)"),
                           {"u": str(user_id)})
        for params, message in [
            ({"cell": "THRR!", "at": now, "temp": 20, "pop": 0.1}, "invalid geohash"),
            ({"cell": "thrr3", "at": now, "temp": 250, "pop": 0.1}, "out of range"),
            ({"cell": "thrr3", "at": now, "temp": 20, "pop": 4}, "out of range"),
            ({"cell": "thrr3", "at": now + timedelta(days=30), "temp": 20, "pop": 0.1},
             "forecast window"),
        ]:
            # Each rejection aborts its own savepoint, not the whole transaction.
            savepoint = await conn.begin_nested()
            with pytest.raises(DBAPIError, match=message):
                await conn.execute(call, params)
            await savepoint.rollback()
