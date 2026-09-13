"""Wardrobe advice: gaps for everyone, purchase pressure for nobody who'd rather not."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from workers.styling.economics import Evidence, Tone, decide_tone


async def _price(engine, user_id, name, price, currency="USD"):
    async with engine.begin() as conn:
        await conn.execute(text("""
            update public.garments set purchase_price = :p, purchase_currency = :c
             where user_id = :u and name = :n
        """), {"p": price, "c": currency, "u": str(user_id), "n": name})


async def _brand(engine, user_id, name, brand):
    async with engine.begin() as conn:
        await conn.execute(text(
            "update public.garments set brand = :b where user_id = :u and name = :n"),
            {"b": brand, "u": str(user_id), "n": name})


# ── the policy, in isolation ────────────────────────────────────────────────
@pytest.mark.parametrize(("band", "expected"), [
    (1, Tone.ESSENTIALS_ONLY),
    (2, Tone.ESSENTIALS_ONLY),
    (3, Tone.SUGGEST_GAPS),
    (4, Tone.SUGGEST_UPGRADES),
    (5, Tone.SUGGEST_UPGRADES),
])
def test_modest_wardrobes_are_never_sold_to(band, expected):
    assert decide_tone(band, Evidence(items=30), allow_purchases=True) is expected


def test_opting_out_silences_every_suggestion():
    for band in range(1, 6):
        assert decide_tone(band, Evidence(items=50), allow_purchases=False) \
            is Tone.USE_WHAT_YOU_HAVE


# ── inference from real evidence ────────────────────────────────────────────
async def test_prices_drive_the_band(engine, wardrobe, make_user):
    from workers.styling.economics import spend_guidance

    thrifty = await make_user()
    await wardrobe(thrifty)
    for name, price in [("Navy shirt", 18), ("White tee", 9), ("Camel chinos", 24),
                        ("Blue jeans", 30), ("White sneakers", 35)]:
        await _price(engine, thrifty, name, price)

    lavish = await make_user()
    await wardrobe(lavish)
    for name, price in [("Navy shirt", 420), ("Burgundy blouse", 780),
                        ("Tailored trousers", 650), ("Navy blazer", 1900),
                        ("Brown derbies", 900)]:
        await _price(engine, lavish, name, price)

    async with engine.connect() as conn:
        low = await spend_guidance(conn, thrifty)
        high = await spend_guidance(conn, lavish)

    assert low.source == "prices" and high.source == "prices"
    assert low.band < high.band, f"{low.band} should be below {high.band}"
    assert low.suggest_purchases is False, "a thrifty wardrobe gets no shopping list"
    assert high.suggest_purchases is True
    assert low.tone is Tone.ESSENTIALS_ONLY
    assert high.tone is Tone.SUGGEST_UPGRADES


async def test_brands_are_the_fallback_when_no_prices_were_recorded(
        engine, wardrobe, make_user):
    from workers.styling.economics import spend_guidance

    user = await make_user()
    await wardrobe(user)
    for name, brand in [("Navy shirt", "Gucci"), ("Burgundy blouse", "Prada"),
                        ("Tailored trousers", "Saint Laurent"),
                        ("Navy blazer", "Max Mara"), ("Brown derbies", "Hermès")]:
        await _brand(engine, user, name, brand)

    async with engine.connect() as conn:
        guidance = await spend_guidance(conn, user)

    assert guidance.source == "brands"
    assert guidance.band >= 4
    assert guidance.suggest_purchases is True


async def test_brand_matching_ignores_case_and_punctuation(engine, wardrobe, make_user):
    user = await make_user()
    await wardrobe(user)
    async with engine.connect() as conn:
        for written, expected in [("ZARA", "zara"), (" Zara ", "zara"),
                                  ("Saint Laurent", "saintlaurent"),
                                  ("A.P.C.", "apc"), ("", None)]:
            key = (await conn.execute(text("select public.brand_key(:b) as k"),
                                      {"b": written})).scalar_one()
            assert key == expected, written


async def test_a_tiny_wardrobe_says_nothing_about_money(engine, wardrobe, make_user):
    from workers.styling.economics import spend_guidance

    user = await make_user()
    await wardrobe(user, [
        {"name": "Navy shirt", "category": "shirt", "hex": "#1B2A4A",
         "family": "navy", "neutral": True},
    ])
    async with engine.connect() as conn:
        guidance = await spend_guidance(conn, user)

    assert guidance.source == "default"
    assert guidance.confidence < 0.3
    assert guidance.suggest_purchases is False


async def test_the_user_setting_beats_every_inference(engine, wardrobe, make_user):
    from workers.styling.economics import spend_guidance

    user = await make_user()
    await wardrobe(user)
    for name in ["Navy shirt", "Burgundy blouse", "Navy blazer", "Brown derbies"]:
        await _price(engine, user, name, 1500)

    async with engine.connect() as conn:
        inferred = await spend_guidance(conn, user)
        declared = await spend_guidance(conn, user, user_band=1)

    assert inferred.band >= 4
    assert declared.band == 1 and declared.source == "user"
    assert declared.suggest_purchases is False


# ── coverage and colour opportunity ─────────────────────────────────────────
async def test_coverage_names_the_blocking_slot(engine, wardrobe, make_user):
    user = await make_user()
    await wardrobe(user, [
        {"name": "Navy shirt", "category": "shirt", "hex": "#1B2A4A",
         "family": "navy", "neutral": True},
        {"name": "Tailored trousers", "category": "tailored_trousers",
         "hex": "#36393F", "family": "charcoal", "neutral": True,
         "material": ["wool"]},
    ])
    from workers.styling.advice import load_coverage

    async with engine.connect() as conn:
        coverage = await load_coverage(conn, user)

    business = next(c for c in coverage if c.slug == "business_meeting")
    assert business.wearable is False
    assert "footwear" in business.missing_roles
    assert "base_top" not in business.missing_roles, "they do own a shirt"


async def test_colour_opportunity_is_ranked_by_what_it_would_unlock(
        engine, wardrobe, make_user):
    from workers.styling.advice import color_opportunities
    from workers.styling.engine import StylingEngine

    user = await make_user()
    await wardrobe(user)
    async with engine.connect() as conn:
        rules = await StylingEngine().color_rules(conn)
        opportunities = await color_opportunities(conn, user, rules)

    assert opportunities, "a real wardrobe always has an unexplored colour"
    counts = [o.pairs_with for o in opportunities]
    assert counts == sorted(counts, reverse=True)
    assert all(o.coverage <= 1.0 for o in opportunities)


# ── the endpoint ────────────────────────────────────────────────────────────
async def test_advice_reports_gaps_but_sells_nothing_to_a_modest_wardrobe(
        client, wardrobe, user_id, engine):
    await wardrobe(user_id)
    for name, price in [("Navy shirt", 15), ("White tee", 8), ("Blue jeans", 25),
                        ("Grey hoodie", 20), ("White sneakers", 30)]:
        await _price(engine, user_id, name, price)

    body = (await client.get("/v1/wardrobe/advice")).json()

    assert body["tone"] == "essentials_only"
    assert body["coverage"], "gaps are reported to everyone"
    assert body["headline"]
    assert body["basis"].startswith("what you paid")
    optional = [s for s in body["suggestions"] if not s["blocking"]]
    assert optional == [], "no optional shopping for a budget-conscious wardrobe"


async def test_advice_suggests_gaps_for_a_wardrobe_that_wants_them(
        client, wardrobe, user_id, engine):
    await wardrobe(user_id)
    for name, price in [("Navy shirt", 380), ("Burgundy blouse", 640),
                        ("Tailored trousers", 520), ("Navy blazer", 1500),
                        ("Brown derbies", 880), ("Black clutch", 900)]:
        await _price(engine, user_id, name, price)

    body = (await client.get("/v1/wardrobe/advice")).json()

    assert body["tone"] == "suggest_upgrades"
    optional = [s for s in body["suggestions"] if not s["blocking"]]
    assert optional, "this wardrobe is being built; say what would help"
    for suggestion in optional:
        assert suggestion["price_low"] is not None
        assert suggestion["price_high"] >= suggestion["price_low"]
        assert suggestion["reason"]


async def test_opting_out_of_purchases_is_honoured_end_to_end(
        client, wardrobe, user_id, engine):
    await wardrobe(user_id)
    for name in ["Navy shirt", "Navy blazer", "Brown derbies", "Black clutch"]:
        await _price(engine, user_id, name, 1200)
    async with engine.begin() as conn:
        await conn.execute(text("""
            insert into public.style_preferences (user_id, allow_new_purchases)
            values (:u, false)
            on conflict (user_id) do update set allow_new_purchases = false
        """), {"u": str(user_id)})

    body = (await client.get("/v1/wardrobe/advice")).json()
    assert body["tone"] == "use_what_you_have"
    assert body["suggestions"] == []
    assert "what you have" in body["headline"].lower()


async def test_advice_never_labels_the_person(client, wardrobe, user_id, engine):
    """The band is a routing decision, not something to tell someone about themselves."""
    await wardrobe(user_id)
    for name in ["Navy shirt", "Navy blazer", "Brown derbies", "Black clutch"]:
        await _price(engine, user_id, name, 40)

    body = (await client.get("/v1/wardrobe/advice")).json()
    blob = str(body).lower()
    for word in ("tier", "band", "affluen", "wealth", "income", "class",
                 "budget_tier", "segment", "low-income", "rich", "poor"):
        assert word not in blob, f"advice leaked the word {word!r}"


# ── coverage asks the occasion what it needs ────────────────────────────────
async def test_lounging_at_home_does_not_require_shoes(engine, wardrobe, make_user):
    """The occasions table says home_lounge requires no footwear. Believe it."""
    from workers.styling.advice import load_coverage

    user = await make_user()
    await wardrobe(user, [
        {"name": "Grey hoodie", "category": "hoodie", "hex": "#9AA0A6",
         "family": "grey", "neutral": True},
        {"name": "Joggers", "category": "joggers", "hex": "#36393F",
         "family": "charcoal", "neutral": True},
    ])
    async with engine.connect() as conn:
        coverage = await load_coverage(conn, user)

    home = next(c for c in coverage if c.slug == "home_lounge")
    assert home.wearable is True, "a hoodie and joggers are enough to be at home"
    assert home.missing_roles == []

    # The same wardrobe genuinely cannot do a formal event.
    formal = next(c for c in coverage if c.slug == "formal_event")
    assert formal.wearable is False


async def test_a_full_length_garment_covers_top_and_bottom(engine, wardrobe, make_user):
    """One jilbab or dress satisfies both halves — it is a complete outfit."""
    from workers.styling.advice import load_coverage

    user = await make_user()
    await wardrobe(user, [
        {"name": "Black cocktail dress", "category": "cocktail_dress",
         "hex": "#111111", "family": "black", "neutral": True, "material": ["silk"]},
        {"name": "Brown derbies", "category": "dress_shoes", "hex": "#6B4A2F",
         "family": "brown", "neutral": True, "material": ["leather"]},
    ])
    async with engine.connect() as conn:
        coverage = await load_coverage(conn, user)

    formal = next(c for c in coverage if c.slug == "formal_event")
    assert formal.wearable is True
    assert formal.missing_roles == []


async def test_a_colour_already_owned_is_not_offered_as_a_gap(
        engine, wardrobe, make_user):
    from workers.styling.advice import color_opportunities
    from workers.styling.engine import StylingEngine

    user = await make_user()
    await wardrobe(user)
    async with engine.connect() as conn:
        owned = {r["color_family"] for r in (await conn.execute(text("""
            select distinct c.color_family
              from public.garment_colors c
              join public.garments g on g.id = c.garment_id
             where g.user_id = :u and c.rank = 1
        """), {"u": str(user)})).mappings().all()}
        rules = await StylingEngine().color_rules(conn)
        opportunities = await color_opportunities(conn, user, rules)

    suggested = {o.family for o in opportunities}
    assert not (suggested & owned), \
        f"suggested colours already in the wardrobe: {sorted(suggested & owned)}"


async def test_the_headline_counts_the_gaps_honestly(client, wardrobe, user_id):
    await wardrobe(user_id, [
        {"name": "Grey hoodie", "category": "hoodie", "hex": "#9AA0A6",
         "family": "grey", "neutral": True},
    ])
    body = (await client.get("/v1/wardrobe/advice")).json()
    blocked = [c for c in body["coverage"] if not c["wearable"]]
    headline = body["headline"]

    if len(blocked) > 1:
        assert "the one thing missing" not in headline
        assert "cannot dress" in headline
    assert str(len(body["coverage"]) - len(blocked)) in headline
