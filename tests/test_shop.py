"""Shop mode: judging something on a rack against the wardrobe at home.

Runs the real API, the real vision pipeline (stub segmenter, real colour maths)
and a real database. What is asserted here is the arithmetic a shopper is
standing in a shop waiting for: is this a duplicate, what would it unlock, and
if the answer is no, what should they look for instead.
"""
from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text

from tests.factories import BURGUNDY, CAMEL, NAVY, sha256, single_garment_image

# The stub segmenter reads a single-garment photo as a `trousers` band, so every
# scan below is a pair of trousers. That is incidental to what is being tested.
SCANNED_CATEGORY = "trousers"


async def upload(client, data: bytes, filename="rack.jpg") -> str:
    r = await client.post("/v1/uploads/presign", json={
        "purpose": "wardrobe",
        "files": [{"filename": filename, "mime_type": "image/jpeg",
                   "byte_size": len(data), "sha256": sha256(data)}],
    })
    assert r.status_code == 200, r.text
    entry = r.json()["uploads"][0]
    put = await client.put(entry["upload_url"], content=data,
                           headers={"Content-Type": "image/jpeg"})
    assert put.status_code == 200, put.text
    return entry["media_id"]


async def scan(client, colour=NAVY, *, seed: int = 0, **body) -> dict:
    media_id = await upload(client, single_garment_image(colour, seed=seed))
    r = await client.post("/v1/shop/scan", json={"media_id": media_id, **body})
    assert r.status_code == 200, r.text
    return r.json()


def item(name: str, category: str, hex_: str, family: str, **kw) -> dict:
    return {"name": name, "category": category, "hex": hex_, "family": family, **kw}


#: A wardrobe with three navy pairs of trousers already in it.
SATURATED = [
    item("Navy trousers", "trousers", "#1B2A4A", "navy", neutral=True),
    item("Navy work trousers", "trousers", "#1D2C4C", "navy", neutral=True),
    item("Navy cords", "trousers", "#192848", "navy", neutral=True),
    item("White shirt", "shirt", "#F7F7F7", "white", neutral=True),
    item("Grey shirt", "shirt", "#9AA0A6", "grey", neutral=True),
    item("Brown derbies", "dress_shoes", "#6B4A2F", "brown", neutral=True),
]

#: Tops and shoes, nothing at all for the legs.
NO_BOTTOMS = [
    item("White shirt", "shirt", "#F7F7F7", "white", neutral=True),
    item("Navy shirt", "shirt", "#1B2A4A", "navy", neutral=True),
    item("Navy blazer", "blazer", "#1B2A4A", "navy", neutral=True),
    item("Brown derbies", "dress_shoes", "#6B4A2F", "brown", neutral=True),
    item("White sneakers", "minimal_sneakers", "#FFFFFF", "white", neutral=True),
]


# ── the duplicate case, which is the whole point of the feature ─────────────
async def test_owning_three_already_reads_as_have_similar(client, wardrobe, user_id):
    await wardrobe(user_id, SATURATED)
    result = await scan(client, NAVY)

    assert result["verdict"] == "have_similar"
    assert result["category"] == SCANNED_CATEGORY
    assert result["color_family"] == "navy"
    assert len(result["duplicates"]) == 3
    assert all(d["delta_e"] <= 8.0 for d in result["duplicates"])
    assert "already own 3" in result["detail"]


async def test_a_duplicate_is_told_what_to_look_for_instead(client, wardrobe, user_id):
    """A shopper told only 'you have this' has been told nothing useful."""
    await wardrobe(user_id, SATURATED)
    result = await scan(client, NAVY)

    assert result["look_for_colors"], "no alternative colours offered"
    assert "navy" not in [c["family"] for c in result["look_for_colors"]]
    assert "short of" in result["detail"]
    # And the shapes the wardrobe barely has, named in the same breath.
    assert set(result["look_for_roles"]) <= {"base_top", "bottom", "full_body",
                                             "outerwear", "footwear", "bag"}


async def test_a_saturated_colour_is_flagged_without_an_exact_duplicate(
        client, wardrobe, user_id):
    """Same colour, different category: no duplicate, but the colour is spent."""
    await wardrobe(user_id, [
        item("Navy chinos", "chinos", "#1B2A4A", "navy", neutral=True),
        item("Navy jeans", "jeans", "#1D2C4C", "navy", neutral=True),
        item("White shirt", "shirt", "#F7F7F7", "white", neutral=True),
    ])
    result = await scan(client, NAVY)

    assert result["duplicates"] == []
    assert result["verdict"] == "have_similar"
    assert "Of the bottoms you own, 100% are already navy" in result["detail"]


# ── the gap case ────────────────────────────────────────────────────────────
async def test_the_only_missing_slot_unlocks_occasions(client, wardrobe, user_id):
    await wardrobe(user_id, NO_BOTTOMS)
    result = await scan(client, CAMEL)

    assert result["verdict"] == "fills_a_gap"
    assert result["unlocked_occasions"], "nothing reported as unlocked"
    assert "cannot dress" in result["detail"]


async def test_a_wardrobe_that_dresses_everything_unlocks_nothing(client, wardrobe,
                                                                  user_id):
    await wardrobe(user_id)                      # the full default closet
    result = await scan(client, BURGUNDY)

    assert result["unlocked_occasions"] == []
    assert result["verdict"] in ("adds_variety", "hard_to_wear")
    assert result["total_complements"] > 0


# ── the counting the verdict rests on ───────────────────────────────────────
async def test_pairings_are_counted_against_complementary_roles_only(client, wardrobe,
                                                                     user_id):
    """Trousers are judged against tops, shoes and bags — never other trousers."""
    await wardrobe(user_id, SATURATED)
    result = await scan(client, NAVY)

    # SATURATED holds 2 shirts and 1 pair of shoes that a bottom can pair with;
    # the three other trousers are not candidates for pairing with trousers.
    assert result["total_complements"] == 3
    assert 0 <= result["new_pairings"] <= 3
    assert result["pairing_share"] == pytest.approx(
        result["new_pairings"] / 3, abs=0.001)


async def test_saturation_is_measured_per_role_not_across_the_wardrobe(engine, user_id,
                                                                       wardrobe):
    """Owning a navy blazer says nothing about whether to buy navy trousers."""
    await wardrobe(user_id, [
        item("Navy blazer", "blazer", "#1B2A4A", "navy", neutral=True),
        item("Navy shirt", "shirt", "#1B2A4A", "navy", neutral=True),
        item("Camel chinos", "chinos", "#B08245", "camel", neutral=True),
    ])
    async with engine.begin() as conn:
        row = (await conn.execute(text("""
            select * from public.wardrobe_saturation(
                :u, cast('bottom' as public.garment_role), 'navy')
        """), {"u": str(user_id)})).mappings().one()

    assert row["items_total"] == 3
    assert row["items_in_family"] == 2          # blazer and shirt
    assert row["items_in_role"] == 1            # the chinos
    assert row["items_role_family"] == 0        # no navy bottom
    assert float(row["role_family_share"]) == 0.0


# ── the scan itself ─────────────────────────────────────────────────────────
async def test_a_scan_files_nothing_in_the_wardrobe(client, wardrobe, user_id, engine):
    """They have not bought it yet. Filing it would be a lie about what they own."""
    await wardrobe(user_id, SATURATED)
    async with engine.begin() as conn:
        before = (await conn.execute(
            text("select count(*) from public.garments where user_id = :u"),
            {"u": str(user_id)})).scalar_one()

    await scan(client, NAVY)

    async with engine.begin() as conn:
        after = (await conn.execute(
            text("select count(*) from public.garments where user_id = :u"),
            {"u": str(user_id)})).scalar_one()
    assert after == before


async def test_a_scan_is_kept_so_the_decision_can_wait(client, wardrobe, user_id):
    """People photograph three things, walk around, and come back."""
    await wardrobe(user_id, SATURATED)
    result = await scan(client, NAVY)

    listed = await client.get("/v1/shop/scans")
    assert listed.status_code == 200
    rows = listed.json()
    assert [r["id"] for r in rows] == [result["scan_id"]]
    assert rows[0]["verdict"] == result["verdict"]
    assert rows[0]["headline"] == result["headline"]
    assert rows[0]["photo_url"], "the card cannot show the thing without its photo"


async def test_the_detected_role_can_be_overridden(client, wardrobe, user_id):
    """Cameras misread garments on a hanger; the user gets the last word."""
    await wardrobe(user_id, SATURATED)
    result = await scan(client, NAVY, role="outerwear")
    assert result["role"] == "outerwear"


async def test_buying_it_puts_it_in_the_wardrobe(client, wardrobe, user_id):
    await wardrobe(user_id, NO_BOTTOMS)
    result = await scan(client, CAMEL)

    bought = await client.post(f"/v1/shop/scans/{result['scan_id']}/bought")
    assert bought.status_code == 201, bought.text
    garment_id = bought.json()["garment_id"]

    got = await client.get(f"/v1/garments/{garment_id}")
    assert got.status_code == 200
    garment = got.json()
    assert garment["category"] == SCANNED_CATEGORY
    assert garment["role"] == "bottom"           # inherited from the taxonomy
    assert garment["colors"][0]["color_family"] == result["color_family"]
    assert garment["colors"][0]["hex"] == result["primary_hex"]

    # It is out of the open list, and the next scan of the same thing knows it.
    assert await open_scan_ids(client) == []
    again = await scan(client, CAMEL, seed=1)
    assert [d["garment_id"] for d in again["duplicates"]] == [garment_id]


async def test_buying_the_same_scan_twice_is_refused(client, wardrobe, user_id):
    await wardrobe(user_id, NO_BOTTOMS)
    result = await scan(client, CAMEL)
    assert (await client.post(f"/v1/shop/scans/{result['scan_id']}/bought")
            ).status_code == 201
    assert (await client.post(f"/v1/shop/scans/{result['scan_id']}/bought")
            ).status_code == 404


async def test_walking_away_closes_the_card(client, wardrobe, user_id):
    await wardrobe(user_id, SATURATED)
    result = await scan(client, NAVY)

    dismissed = await client.post(f"/v1/shop/scans/{result['scan_id']}/dismiss")
    assert dismissed.status_code == 204
    assert await open_scan_ids(client) == []

    everything = await client.get("/v1/shop/scans", params={"open_only": False})
    assert [r["id"] for r in everything.json()] == [result["scan_id"]]


async def open_scan_ids(client) -> list[str]:
    return [r["id"] for r in (await client.get("/v1/shop/scans")).json()]


# ── boundaries ──────────────────────────────────────────────────────────────
async def test_scanning_someone_elses_photo_is_a_404(client, client_factory, make_user,
                                                     wardrobe, user_id):
    await wardrobe(user_id, SATURATED)
    stranger = await make_user()
    async with client_factory(stranger) as other:
        media_id = await upload(other, single_garment_image(NAVY))

    r = await client.post("/v1/shop/scan", json={"media_id": media_id})
    assert r.status_code == 404


async def test_scans_are_not_visible_across_accounts(client, client_factory, make_user,
                                                     wardrobe, user_id):
    await wardrobe(user_id, SATURATED)
    result = await scan(client, NAVY)

    stranger = await make_user()
    async with client_factory(stranger) as other:
        assert (await other.get("/v1/shop/scans")).json() == []
        assert (await other.post(f"/v1/shop/scans/{result['scan_id']}/dismiss")
                ).status_code == 404


async def test_a_missing_photo_is_a_404(client):
    r = await client.post("/v1/shop/scan", json={"media_id": str(uuid4())})
    assert r.status_code == 404


async def test_shop_mode_records_nothing_about_the_shop(engine):
    """The feature answers 'does this go with what I own'.

    Where somebody shops, what the shop charges and which retailer it was serve
    a different purpose than the one asked for, so there is nowhere to put them.
    """
    async with engine.begin() as conn:
        columns = {r[0] for r in (await conn.execute(text("""
            select column_name from information_schema.columns
             where table_schema = 'public' and table_name = 'shop_scans'
        """))).all()}

    forbidden = {"price", "currency", "retailer", "retailer_url", "store_name",
                 "shop_name", "latitude", "longitude", "location", "geohash",
                 "barcode", "sku", "url"}
    assert not (columns & forbidden), f"shop mode is storing {columns & forbidden}"


# ── the other half of the answer: what to wear it with ──────────────────────
async def test_a_good_buy_names_the_outfit_it_would_join(client, wardrobe, user_id):
    """Counting pairings answers 'should I buy it'. Naming them answers 'why'."""
    await wardrobe(user_id, NO_BOTTOMS)
    result = await scan(client, CAMEL)

    assert result["wear_with"], "no outfit offered"
    names = {w["name"] for w in result["wear_with"]}
    assert names <= {i["name"] for i in NO_BOTTOMS}
    assert all(w["hex"].startswith("#") for w in result["wear_with"])
    assert f"Wear it with your {result['wear_with'][0]['name']}" in result["detail"] \
        or "Wear it with your" in result["detail"]


async def test_the_outfit_takes_the_best_of_each_role_in_wearing_order(client,
                                                                      wardrobe,
                                                                      user_id):
    """Three shirts is not an outfit. A shirt, a jacket and shoes is."""
    await wardrobe(user_id, NO_BOTTOMS)
    result = await scan(client, CAMEL)

    roles = [w["role"] for w in result["wear_with"]]
    assert len(roles) == len(set(roles)), f"more than one of a role: {roles}"
    order = ["base_top", "full_body", "bottom", "mid_layer", "outerwear",
             "footwear", "bag", "belt"]
    assert roles == sorted(roles, key=order.index)
    assert len(roles) <= 3


async def test_pieces_it_clashes_with_are_left_out_of_the_outfit(client, wardrobe,
                                                                 user_id):
    await wardrobe(user_id, NO_BOTTOMS)
    result = await scan(client, CAMEL)

    assert len(result["wear_with"]) <= result["new_pairings"]
    assert all(w["score"] >= 0.75 for w in result["wear_with"])


async def test_a_neutral_that_goes_with_everything_is_not_called_hard_to_wear(
        client, wardrobe, user_id):
    """The catalogue scores a neutral anchor 0.65 — that means safe, not bad.

    Found by reading real output: an olive jacket came back as "works with 0 of
    11 pieces" against a wardrobe of navy, grey and camel, because the bar for
    counting a pairing sat above the neutral-anchor score.
    """
    await wardrobe(user_id, [
        item("Navy shirt", "shirt", "#1B2A4A", "navy", neutral=True),
        item("Grey shirt", "shirt", "#9AA0A6", "grey", neutral=True),
        item("White tee", "t_shirt", "#F7F7F7", "white", neutral=True),
        item("Brown derbies", "dress_shoes", "#6B4A2F", "brown", neutral=True),
    ])
    media_id = await upload(client, single_garment_image((107, 114, 56)))
    r = await client.post("/v1/shop/scan",
                          json={"media_id": media_id, "role": "outerwear"})
    assert r.status_code == 200, r.text
    result = r.json()

    assert result["color_family"] == "olive"
    assert result["new_pairings"] == result["total_complements"] > 0
    assert result["verdict"] != "hard_to_wear"


async def test_a_genuine_clash_is_still_called_out(client, wardrobe, user_id):
    """The bar moved for neutrals, not for colours that actually fight."""
    await wardrobe(user_id, [
        item("Green shirt", "shirt", "#16A34A", "green"),
        item("Green tee", "t_shirt", "#12903F", "green"),
    ])
    media_id = await upload(client, single_garment_image((220, 38, 38)))
    r = await client.post("/v1/shop/scan",
                          json={"media_id": media_id, "role": "bottom"})
    assert r.status_code == 200, r.text
    result = r.json()

    assert result["color_family"] == "red"
    assert result["new_pairings"] == 0
    assert result["verdict"] == "hard_to_wear"
    assert result["wear_with"] == []
