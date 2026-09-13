"""End-to-end recommendations through the API, against a real closet."""
from __future__ import annotations

import pytest
from sqlalchemy import text


async def recommend(client, occasion, **kw):
    body = {"occasion": occasion, **kw}
    r = await client.post("/v1/outfits/recommend", json=body)
    return r


@pytest.fixture
async def closet(wardrobe, user_id):
    return await wardrobe(user_id)


async def test_recommendation_returns_wearable_outfits(client, closet):
    r = await recommend(client, "casual_gathering",
                        weather_override={"temp_c": 22, "feels_like_c": 22, "precip_prob": 0})
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["engine_version"].startswith("styling-")
    assert body["candidate_count"] > 0
    assert 1 <= len(body["outfits"]) <= 5

    for outfit in body["outfits"]:
        roles = {i["role"] for i in outfit["items"]}
        assert "footwear" in roles, "every outfit needs shoes"
        assert ("full_body" in roles) or {"base_top", "bottom"} <= roles
        assert 0 < outfit["total_score"] <= 1
        assert outfit["rationale"]
        assert set(outfit["score_breakdown"]) >= {
            "color_harmony", "formality_fit", "weather_fit", "novelty"}
        assert outfit["origin"] == "ai"


async def test_business_meeting_excludes_casual_items(client, closet):
    body = (await recommend(client, "business_meeting",
                            weather_override={"temp_c": 20, "feels_like_c": 20})).json()
    picked = {i["garment"]["name"] for o in body["outfits"] for i in o["items"]}
    assert "Grey hoodie" not in picked
    assert "Linen shorts" not in picked
    assert "White sneakers" not in picked, "sneakers are below the formality floor"
    assert picked & {"Navy shirt", "Tailored trousers", "Brown derbies", "Navy blazer"}


async def test_hot_weather_drops_the_puffer_and_cold_weather_adds_a_layer(client, closet):
    hot = (await recommend(client, "casual_gathering",
                           weather_override={"temp_c": 34, "feels_like_c": 36})).json()
    hot_items = {i["garment"]["name"] for o in hot["outfits"] for i in o["items"]}
    assert "Arctic puffer" not in hot_items

    cold = (await recommend(client, "casual_gathering",
                            weather_override={"temp_c": -2, "feels_like_c": -6})).json()
    layered = [o for o in cold["outfits"]
               if {"outerwear", "mid_layer"} & {i["role"] for i in o["items"]}]
    assert layered, "sub-zero weather must produce at least one layered look"


async def test_rain_avoids_suede(client, closet):
    body = (await recommend(client, "casual_gathering",
                            weather_override={"temp_c": 16, "feels_like_c": 15,
                                              "precip_prob": 0.9})).json()
    shoes = {i["garment"]["name"] for o in body["outfits"]
             for i in o["items"] if i["role"] == "footwear"}
    assert "Suede sandals" not in shoes


async def test_laundry_and_archive_remove_items_from_consideration(client, closet):
    navy = str(closet["Navy shirt"])
    await client.patch("/v1/garments/bulk", json={"ids": [navy], "patch": {"in_laundry": True}})
    body = (await recommend(client, "business_meeting",
                            weather_override={"temp_c": 20, "feels_like_c": 20})).json()
    picked = {i["garment"]["id"] for o in body["outfits"] for i in o["items"]}
    assert navy not in picked


async def test_must_include_and_exclude_are_honoured(client, closet):
    burgundy = str(closet["Burgundy blouse"])
    body = (await recommend(client, "date_night", count=3,
                            must_include_garment_ids=[burgundy],
                            weather_override={"temp_c": 24, "feels_like_c": 24})).json()
    assert body["outfits"]
    for outfit in body["outfits"]:
        assert burgundy in {i["garment"]["id"] for i in outfit["items"]}

    body2 = (await recommend(client, "date_night", count=5,
                             exclude_garment_ids=[burgundy],
                             weather_override={"temp_c": 24, "feels_like_c": 24})).json()
    assert burgundy not in {i["garment"]["id"] for o in body2["outfits"] for i in o["items"]}


async def test_outfits_are_diverse(client, closet):
    body = (await recommend(client, "casual_gathering", count=5,
                            weather_override={"temp_c": 22, "feels_like_c": 22})).json()
    cores = [
        frozenset(i["garment"]["id"] for i in o["items"]
                  if i["role"] in ("base_top", "bottom", "full_body", "footwear"))
        for o in body["outfits"]
    ]
    assert len(set(cores)) == len(cores), "no two suggestions may share the same core"


async def test_empty_wardrobe_returns_a_useful_422(client):
    r = await recommend(client, "formal_event",
                        weather_override={"temp_c": 20, "feels_like_c": 20})
    assert r.status_code == 422
    body = r.json()
    assert body["type"].endswith("/insufficient-wardrobe")
    assert body["missing_roles"]


async def test_unknown_occasion_is_a_400(client, closet):
    r = await recommend(client, "moon_landing")
    assert r.status_code == 400


async def test_run_is_recorded_for_replay(client, closet, engine, user_id):
    body = (await recommend(client, "brunch",
                            weather_override={"temp_c": 25, "feels_like_c": 25})).json()
    async with engine.connect() as conn:
        row = (await conn.execute(text("""
            select engine_version, occasion_slug, candidate_count, returned_count,
                   weights, latency_ms, status::text as status
              from public.recommendation_runs where id = :i
        """), {"i": body["run_id"]})).mappings().one()
    assert row["occasion_slug"] == "brunch"
    assert row["returned_count"] == len(body["outfits"])
    assert row["candidate_count"] == body["candidate_count"]
    assert row["weights"], "weights must be stored so a run can be replayed"
    assert row["status"] == "succeeded"


# ── feedback loop ───────────────────────────────────────────────────────────
async def test_feedback_updates_the_taste_vector(client, closet, engine, user_id):
    body = (await recommend(client, "casual_gathering",
                            weather_override={"temp_c": 22, "feels_like_c": 22})).json()
    outfit_id = body["outfits"][0]["id"]

    r = await client.post(f"/v1/outfits/{outfit_id}/feedback", json={"kind": "like"})
    assert r.status_code == 201
    assert r.json()["taste_updated"] is True

    async with engine.connect() as conn:
        row = (await conn.execute(text(
            "select sample_count, model from public.user_style_embeddings where user_id = :u"),
            {"u": str(user_id)})).mappings().one()
    assert row["sample_count"] >= 1


async def test_worn_feedback_also_writes_the_wear_log(client, closet):
    body = (await recommend(client, "casual_gathering",
                            weather_override={"temp_c": 22, "feels_like_c": 22})).json()
    outfit = body["outfits"][0]
    garment_id = outfit["items"][0]["garment"]["id"]

    before = (await client.get(f"/v1/garments/{garment_id}")).json()["wear_count"]
    await client.post(f"/v1/outfits/{outfit['id']}/feedback", json={"kind": "worn"})
    after = (await client.get(f"/v1/garments/{garment_id}")).json()["wear_count"]
    assert after == before + 1

    stats = (await client.get("/v1/wardrobe/stats")).json()
    assert stats["worn_last_30d"] >= 1


async def test_likes_shift_later_rankings(client, closet):
    """Ten likes for burgundy looks should raise burgundy's taste term."""

    first = (await recommend(client, "date_night", count=5,
                             weather_override={"temp_c": 24, "feels_like_c": 24})).json()
    burgundy_looks = [o for o in first["outfits"]
                      if any(i["garment"]["name"] == "Burgundy blouse" for i in o["items"])]
    if not burgundy_looks:
        pytest.skip("burgundy not surfaced in the first pass")

    baseline = burgundy_looks[0]["score_breakdown"]["personal_taste"]
    for _ in range(5):
        await client.post(f"/v1/outfits/{burgundy_looks[0]['id']}/feedback",
                          json={"kind": "like"})

    second = (await recommend(client, "date_night", count=5,
                              weather_override={"temp_c": 24, "feels_like_c": 24})).json()
    after = [o for o in second["outfits"]
             if any(i["garment"]["name"] == "Burgundy blouse" for i in o["items"])]
    assert after, "the liked look should still be offered"
    assert after[0]["score_breakdown"]["personal_taste"] > baseline


# ── swap, save, isolation ───────────────────────────────────────────────────
async def test_swap_offers_scored_alternatives(client, closet):
    body = (await recommend(client, "casual_gathering",
                            weather_override={"temp_c": 22, "feels_like_c": 22})).json()
    outfit = body["outfits"][0]
    current = next(i["garment"]["id"] for i in outfit["items"] if i["role"] == "footwear")

    r = await client.post(f"/v1/outfits/{outfit['id']}/swap",
                          json={"role": "footwear", "exclude_garment_ids": [current]})
    assert r.status_code == 200
    options = r.json()
    assert options
    assert current not in {o["garment"]["id"] for o in options}
    assert all(o["garment"]["role"] == "footwear" for o in options)
    scores = [o["score"] for o in options]
    assert scores == sorted(scores, reverse=True), "alternatives come back ranked"


async def test_saving_and_favouriting_an_outfit(client, closet):
    items = [{"garment_id": str(closet["Navy shirt"])},
             {"garment_id": str(closet["Camel chinos"])},
             {"garment_id": str(closet["Brown derbies"])}]
    r = await client.post("/v1/outfits", json={"name": "Friday", "occasion": "brunch",
                                               "items": items})
    assert r.status_code == 201
    outfit = r.json()
    assert outfit["origin"] == "user" and len(outfit["items"]) == 3

    fav = await client.patch(f"/v1/outfits/{outfit['id']}", json={"is_favorite": True})
    assert fav.json()["is_favorite"] is True

    listed = (await client.get("/v1/outfits", params={"favorite": True})).json()["items"]
    assert outfit["id"] in {o["id"] for o in listed}

    assert (await client.delete(f"/v1/outfits/{outfit['id']}")).status_code == 204
    assert outfit["id"] not in {o["id"] for o in (await client.get("/v1/outfits")).json()["items"]}


async def test_two_bottoms_in_one_outfit_is_rejected(client, closet):
    items = [{"garment_id": str(closet["Camel chinos"])},
             {"garment_id": str(closet["Blue jeans"])},
             {"garment_id": str(closet["Brown derbies"])}]
    r = await client.post("/v1/outfits", json={"items": items})
    assert r.status_code == 409


async def test_outfits_are_private(client_factory, make_user, wardrobe):
    alice, bob = await make_user(), await make_user()
    await wardrobe(alice)
    async with client_factory(alice) as ac:
        body = (await ac.post("/v1/outfits/recommend", json={
            "occasion": "casual_gathering",
            "weather_override": {"temp_c": 22, "feels_like_c": 22}})).json()
        outfit_id = body["outfits"][0]["id"]

    async with client_factory(bob) as bc:
        assert (await bc.get("/v1/outfits")).json()["items"] == []
        assert (await bc.get(f"/v1/outfits/{outfit_id}")).status_code == 404
        assert (await bc.post(f"/v1/outfits/{outfit_id}/feedback",
                              json={"kind": "like"})).status_code == 404
        assert (await bc.post(f"/v1/outfits/{outfit_id}/swap",
                              json={"role": "footwear"})).status_code == 404


async def test_weather_endpoint(client):
    r = await client.get("/v1/weather", params={"lat": 25.2048, "lon": 55.2708})
    assert r.status_code == 200
    assert "temp_c" in r.json()


async def test_422_names_the_roles_the_wardrobe_cannot_fill(client, wardrobe, user_id):
    """A closet of formal pieces should be told *what* is missing, not just 'no'."""
    await wardrobe(user_id, [
        {"name": "Navy blazer", "category": "blazer", "hex": "#1B2A4A", "family": "navy",
         "neutral": True, "material": ["wool"]},
        {"name": "Tailored trousers", "category": "tailored_trousers", "hex": "#36393F",
         "family": "charcoal", "neutral": True, "material": ["wool"]},
    ])
    r = await client.post("/v1/outfits/recommend", json={
        "occasion": "business_meeting",
        "weather_override": {"temp_c": 20, "feels_like_c": 20}})
    assert r.status_code == 422
    body = r.json()
    assert "footwear" in body["missing_roles"]
    assert "footwear" in body["detail"]


async def test_422_reports_only_genuinely_missing_roles(client, wardrobe, user_id):
    """Everything present except shoes: the message must not blame the tops."""
    await wardrobe(user_id, [
        {"name": "Navy shirt", "category": "shirt", "hex": "#1B2A4A", "family": "navy",
         "neutral": True},
        {"name": "Tailored trousers", "category": "tailored_trousers", "hex": "#36393F",
         "family": "charcoal", "neutral": True, "material": ["wool"]},
    ])
    body = (await client.post("/v1/outfits/recommend", json={
        "occasion": "business_meeting",
        "weather_override": {"temp_c": 20, "feels_like_c": 20}})).json()
    assert body["missing_roles"] == ["footwear"]
