"""End-to-end: photos in, tagged wardrobe out.

Runs the real API over ASGI, the real presigned-upload round trip, the real
worker claim loop and the real pipeline against a real PostgreSQL database.
"""
from __future__ import annotations

import pytest

from tests.factories import BURGUNDY, CAMEL, CHARCOAL, NAVY, WHITE, outfit_image, sha256

pytestmark = pytest.mark.anyio if False else []


async def upload(client, data: bytes, filename="look.jpg", purpose="wardrobe"):
    """presign -> PUT bytes -> return the media id (the real client flow)."""
    r = await client.post("/v1/uploads/presign", json={
        "purpose": purpose,
        "files": [{"filename": filename, "mime_type": "image/jpeg",
                   "byte_size": len(data), "sha256": sha256(data)}],
    })
    assert r.status_code == 200, r.text
    entry = r.json()["uploads"][0]
    if entry["upload_url"]:
        put = await client.put(entry["upload_url"], content=data,
                               headers={"Content-Type": "image/jpeg"})
        assert put.status_code == 200, put.text
    return entry


async def ingest(client, media_ids, *, auto_accept=True, idempotency=None):
    headers = {"Idempotency-Key": idempotency} if idempotency else {}
    r = await client.post("/v1/ingest/jobs",
                          json={"media_ids": [str(m) for m in media_ids],
                                "auto_accept": auto_accept},
                          headers=headers)
    return r


# ── the happy path ──────────────────────────────────────────────────────────
async def test_photo_becomes_tagged_wardrobe_items(client, run_worker):
    entry = await upload(client, outfit_image())
    job = (await ingest(client, [entry["media_id"]])).json()
    assert job["status"] == "queued" and job["items_discovered"] == 1

    assert await run_worker() == 1

    done = (await client.get(f"/v1/ingest/jobs/{job['id']}")).json()
    assert done["status"] == "succeeded"
    assert done["items_processed"] == 1
    assert done["garments_created"] >= 2, done

    items = (await client.get("/v1/garments")).json()["items"]
    assert len(items) == done["garments_created"]

    by_role = {g["role"]: g for g in items}
    assert "base_top" in by_role and "bottom" in by_role

    top = by_role["base_top"]
    assert top["colors"], "no colour extracted"
    assert top["colors"][0]["color_family"] == "navy"
    assert top["auto_tagged"] is True
    assert top["user_verified"] is False
    assert 0 < top["tag_confidence"] <= 1
    assert top["cutout_url"] and top["image_url"]
    assert top["name"] == "Navy t-shirt" or "navy" in (top["name"] or "").lower()

    bottom = by_role["bottom"]
    assert bottom["colors"][0]["color_family"] == "camel"

    # Category priors flowed in from the taxonomy, not from the detector.
    assert top["formality"] >= 1 and top["warmth"] >= 0
    assert top["seasons"]


async def test_cutout_is_a_real_rgba_image(client, run_worker, settings):
    import io

    from PIL import Image

    entry = await upload(client, outfit_image())
    await ingest(client, [entry["media_id"]])
    await run_worker()

    garment = (await client.get("/v1/garments")).json()["items"][0]
    r = await client.get(garment["cutout_url"])
    assert r.status_code == 200
    im = Image.open(io.BytesIO(r.content))
    assert im.mode == "RGBA"
    assert im.getchannel("A").getextrema()[0] == 0     # genuinely cut out


# ── dedupe ──────────────────────────────────────────────────────────────────
async def test_identical_upload_is_deduplicated_before_transfer(client):
    data = outfit_image()
    first = await upload(client, data)
    second = await upload(client, data)
    assert second["duplicate_of"] == first["media_id"]
    assert second["upload_url"] is None       # nothing to re-transfer


async def test_visually_identical_photo_does_not_duplicate_the_wardrobe(client, run_worker):
    """The same look re-encoded at another size must not clone the closet."""
    import io

    from PIL import Image

    original = outfit_image()
    im = Image.open(io.BytesIO(original)).resize((180, 300))
    buf = io.BytesIO(); im.save(buf, format="JPEG", quality=80)

    a = await upload(client, original, "a.jpg")
    await ingest(client, [a["media_id"]])
    await run_worker()
    first_count = len((await client.get("/v1/garments")).json()["items"])

    b = await upload(client, buf.getvalue(), "b.jpg")
    assert b["duplicate_of"] is None          # different bytes, so sha256 differs
    await ingest(client, [b["media_id"]])
    await run_worker()

    assert len((await client.get("/v1/garments")).json()["items"]) == first_count


async def test_same_garment_in_a_new_photo_is_not_added_twice(client, run_worker):
    """Different photo, same navy top and camel trousers: no duplicate garments."""
    a = await upload(client, outfit_image(seed=1), "a.jpg")
    await ingest(client, [a["media_id"]])
    await run_worker()
    before = len((await client.get("/v1/garments")).json()["items"])

    b = await upload(client, outfit_image(seed=2, size=(220, 380)), "b.jpg")
    await ingest(client, [b["media_id"]])
    await run_worker()
    after = (await client.get("/v1/garments")).json()["items"]

    assert len(after) == before
    dupes = (await client.get("/v1/detections", params={"status_filter": "duplicate"})).json()
    assert dupes, "duplicate detections should be recorded, not silently dropped"


# ── review queue ────────────────────────────────────────────────────────────
async def test_auto_accept_off_sends_everything_to_review(client, run_worker):
    entry = await upload(client, outfit_image())
    job = (await ingest(client, [entry["media_id"]], auto_accept=False)).json()
    await run_worker()

    done = (await client.get(f"/v1/ingest/jobs/{job['id']}")).json()
    assert done["garments_created"] == 0
    assert done["needs_review"] >= 2

    assert (await client.get("/v1/garments")).json()["items"] == []

    pending = (await client.get("/v1/detections")).json()
    assert len(pending) == done["needs_review"]
    card = pending[0]
    assert card["cutout_url"] and card["colors"] and card["suggested_category"]

    accepted = await client.post(f"/v1/detections/{card['id']}/accept",
                                 json={"name": "My favourite shirt", "brand": "Uniqlo"})
    assert accepted.status_code == 201

    items = (await client.get("/v1/garments")).json()["items"]
    assert len(items) == 1
    assert items[0]["name"] == "My favourite shirt"
    assert items[0]["user_verified"] is True
    assert items[0]["colors"], "colours must carry over from the detection"

    # Accepting twice is a conflict, not a second garment.
    again = await client.post(f"/v1/detections/{card['id']}/accept", json={})
    assert again.status_code == 409
    assert again.headers["content-type"].startswith("application/problem+json")


async def test_rejecting_a_detection_creates_nothing(client, run_worker):
    entry = await upload(client, outfit_image())
    await ingest(client, [entry["media_id"]], auto_accept=False)
    await run_worker()
    pending = (await client.get("/v1/detections")).json()

    assert (await client.post(f"/v1/detections/{pending[0]['id']}/reject")).status_code == 204
    assert (await client.post(f"/v1/detections/{pending[0]['id']}/reject")).status_code == 404
    assert (await client.get("/v1/garments")).json()["items"] == []


# ── job semantics ───────────────────────────────────────────────────────────
async def test_idempotency_key_does_not_start_a_second_job(client):
    entry = await upload(client, outfit_image())
    first = await ingest(client, [entry["media_id"]], idempotency="import-42")
    second = await ingest(client, [entry["media_id"]], idempotency="import-42")
    assert first.status_code == 202
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]


async def test_job_rolls_up_multiple_images(client, run_worker):
    ids = []
    for i, (top, bottom) in enumerate([(NAVY, CAMEL), (BURGUNDY, CHARCOAL), (WHITE, NAVY)]):
        entry = await upload(client, outfit_image(top, bottom, seed=i), f"{i}.jpg")
        ids.append(entry["media_id"])

    job = (await ingest(client, ids)).json()
    assert job["items_discovered"] == 3
    await run_worker()

    done = (await client.get(f"/v1/ingest/jobs/{job['id']}")).json()
    assert done["status"] == "succeeded"
    assert done["items_processed"] == 3
    assert done["finished_at"] is not None
    assert done["poll_after_ms"] == 0


async def test_media_belonging_to_another_user_is_rejected(client, client_factory, make_user):
    other = await make_user()
    async with client_factory(other) as other_client:
        entry = await upload(other_client, outfit_image())
    r = await ingest(client, [entry["media_id"]])
    assert r.status_code == 400
    assert r.json()["type"].endswith("/invalid-request")


# ── wardrobe surface ────────────────────────────────────────────────────────
async def test_filters_pagination_and_stats(client, run_worker):
    for i, (top, bottom) in enumerate([(NAVY, CAMEL), (BURGUNDY, CHARCOAL)]):
        entry = await upload(client, outfit_image(top, bottom, seed=10 + i), f"{i}.jpg")
        await ingest(client, [entry["media_id"]])
    await run_worker()

    all_items = (await client.get("/v1/garments")).json()["items"]
    assert len(all_items) >= 4

    tops = (await client.get("/v1/garments", params={"role": "base_top"})).json()["items"]
    assert tops and all(g["role"] == "base_top" for g in tops)

    navy = (await client.get("/v1/garments", params={"color_family": "navy"})).json()["items"]
    assert navy and all(any(c["color_family"] == "navy" for c in g["colors"]) for g in navy)

    # Category filter must include the subtree.
    subtree = (await client.get("/v1/garments", params={"category": "footwear"})).json()["items"]
    assert all(g["role"] == "footwear" for g in subtree)

    page1 = (await client.get("/v1/garments", params={"limit": 2})).json()
    assert len(page1["items"]) == 2 and page1["next_cursor"]
    page2 = (await client.get("/v1/garments",
                              params={"limit": 2, "cursor": page1["next_cursor"]})).json()
    ids1 = {g["id"] for g in page1["items"]}
    ids2 = {g["id"] for g in page2["items"]}
    assert not (ids1 & ids2), "cursor pages must not overlap"

    stats = (await client.get("/v1/wardrobe/stats")).json()
    assert stats["items"] == len(all_items)
    assert stats["never_worn"] == len(all_items)
    assert set(stats["by_role"]) <= {"base_top", "bottom", "footwear", "headwear", "outerwear"}

    # Wear log moves the counters.
    garment_id = all_items[0]["id"]
    assert (await client.post(f"/v1/garments/{garment_id}/wear")).status_code == 201
    assert (await client.get(f"/v1/garments/{garment_id}")).json()["wear_count"] == 1
    assert (await client.get("/v1/wardrobe/stats")).json()["worn_last_30d"] == 1


async def test_editing_a_garment_marks_it_verified(client, run_worker):
    entry = await upload(client, outfit_image())
    await ingest(client, [entry["media_id"]])
    await run_worker()
    garment = (await client.get("/v1/garments")).json()["items"][0]
    assert garment["user_verified"] is False

    r = await client.patch(f"/v1/garments/{garment['id']}",
                           json={"brand": "COS", "formality": 4, "material": ["linen"]})
    assert r.status_code == 200
    body = r.json()
    assert body["brand"] == "COS" and body["formality"] == 4 and body["material"] == ["linen"]
    assert body["user_verified"] is True, "a human edit is ground truth"


async def test_bulk_update_and_availability_filter(client, run_worker):
    entry = await upload(client, outfit_image())
    await ingest(client, [entry["media_id"]])
    await run_worker()
    items = (await client.get("/v1/garments")).json()["items"]

    r = await client.patch("/v1/garments/bulk",
                           json={"ids": [g["id"] for g in items], "patch": {"in_laundry": True}})
    assert r.json()["updated"] == len(items)
    assert (await client.get("/v1/garments",
                             params={"available_only": True})).json()["items"] == []


async def test_soft_delete_hides_the_garment(client, run_worker):
    entry = await upload(client, outfit_image())
    await ingest(client, [entry["media_id"]])
    await run_worker()
    garment = (await client.get("/v1/garments")).json()["items"][0]

    assert (await client.delete(f"/v1/garments/{garment['id']}")).status_code == 204
    assert (await client.get(f"/v1/garments/{garment['id']}")).status_code == 404
    assert garment["id"] not in {g["id"] for g in (await client.get("/v1/garments")).json()["items"]}


# ── tenant isolation ────────────────────────────────────────────────────────
async def test_users_cannot_see_each_others_wardrobes(client_factory, make_user, run_worker):
    alice, bob = await make_user("alice@example.com"), await make_user("bob@example.com")

    async with client_factory(alice) as ac:
        entry = await upload(ac, outfit_image())
        await ingest(ac, [entry["media_id"]])
    await run_worker()

    async with client_factory(alice) as ac:
        alice_items = (await ac.get("/v1/garments")).json()["items"]
        alice_stats = (await ac.get("/v1/wardrobe/stats")).json()
    assert alice_items and alice_stats["items"] == len(alice_items)

    async with client_factory(bob) as bc:
        assert (await bc.get("/v1/garments")).json()["items"] == []
        assert (await bc.get("/v1/detections")).json() == []
        # The stats view must not leak across tenants either — it is
        # security_invoker, so RLS applies inside it (migration 0011).
        assert (await bc.get("/v1/wardrobe/stats")).json()["items"] == 0
        assert (await bc.get(f"/v1/garments/{alice_items[0]['id']}")).status_code == 404
        assert (await bc.patch(f"/v1/garments/{alice_items[0]['id']}",
                               json={"brand": "stolen"})).status_code == 404
        assert (await bc.delete(f"/v1/garments/{alice_items[0]['id']}")).status_code == 404

    async with client_factory(alice) as ac:
        assert (await ac.get(f"/v1/garments/{alice_items[0]['id']}")).json()["brand"] is None


async def test_requests_without_a_token_are_rejected(app, settings):
    import httpx

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://testserver") as anon:
        r = await anon.get("/v1/garments")
        assert r.status_code == 401
        assert r.headers["content-type"].startswith("application/problem+json")
        assert r.json()["type"].endswith("/unauthorized")

        bad = await anon.get("/v1/garments", headers={"Authorization": "Bearer not-a-jwt"})
        assert bad.status_code == 401
