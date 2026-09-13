"""Virtual try-on: consent, rendering, layering, cache, quota, licensing."""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image
from sqlalchemy import text

from tests.factories import body_image, outfit_image, sha256


async def upload_wardrobe_photo(client, data=None):
    data = data or outfit_image()
    r = await client.post("/v1/uploads/presign", json={
        "files": [{"filename": "look.jpg", "mime_type": "image/jpeg",
                   "byte_size": len(data), "sha256": sha256(data)}]})
    entry = r.json()["uploads"][0]
    await client.put(entry["upload_url"], content=data,
                     headers={"Content-Type": "image/jpeg"})
    return entry["media_id"]


@pytest.fixture
async def closet_with_cutouts(client, run_worker):
    """A real wardrobe built by the CV pipeline, so garments have real cutouts."""
    media_id = await upload_wardrobe_photo(client)
    await client.post("/v1/ingest/jobs", json={"media_ids": [media_id]})
    await run_worker()
    return (await client.get("/v1/garments")).json()["items"]


# ── consent gate ────────────────────────────────────────────────────────────
async def test_body_photo_requires_vton_consent(client):
    data = body_image()
    r = await client.post("/v1/uploads/presign", json={
        "purpose": "body_reference",
        "files": [{"filename": "me.jpg", "mime_type": "image/jpeg",
                   "byte_size": len(data), "sha256": sha256(data)}]})
    entry = r.json()["uploads"][0]
    await client.put(entry["upload_url"], content=data,
                     headers={"Content-Type": "image/jpeg"})

    created = await client.post("/v1/me/body-photos", json={"media_id": entry["media_id"]})
    assert created.status_code == 403
    assert created.json()["required_consent"] == "vton_processing"


async def test_body_photo_registration_and_short_lived_url(client, body_photo, settings):
    photo_id = await body_photo()
    photos = (await client.get("/v1/me/body-photos")).json()
    assert len(photos) == 1
    assert photos[0]["id"] == photo_id
    assert photos[0]["is_primary"] is True
    assert photos[0]["url"]
    assert settings.body_read_url_ttl_seconds == 300, "body photos get the shortest TTL"

    r = await client.get(photos[0]["url"])
    assert r.status_code == 200


async def test_body_photo_is_not_reachable_without_the_accessor(engine, user_id):
    """The API role has no grant on the private table — only the audited functions."""
    from sqlalchemy.exc import DBAPIError

    async with engine.connect() as conn, conn.begin():
        await conn.execute(text("select set_config('app.current_user_id', :u, true)"),
                           {"u": str(user_id)})
        await conn.execute(text('set local role "authenticated"'))
        with pytest.raises(DBAPIError, match="permission denied"):
            await conn.execute(text("select * from private.body_reference_photos"))


# ── rendering ───────────────────────────────────────────────────────────────
async def test_try_on_produces_a_real_image_with_the_face_preserved(
        client, body_photo, closet_with_cutouts, run_vton_worker, settings):
    photo_id = await body_photo()
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")

    r = await client.post("/v1/vton/jobs", json={
        "garment_ids": [top["id"]], "body_photo_id": photo_id})
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["status"] == "queued"
    assert job["queue_position"] >= 1
    assert job["poll_after_ms"] > 0

    assert await run_vton_worker() == 1

    done = (await client.get(f"/v1/vton/jobs/{job['id']}")).json()
    assert done["status"] == "succeeded", done
    assert done["result_url"]
    assert done["duration_ms"] is not None
    assert done["expires_at"], "renders must expire"
    assert done["poll_after_ms"] == 0
    assert done["qa_score"] >= 0.5
    assert "face_altered" not in done["qa_flags"]

    render = await client.get(done["result_url"])
    assert render.status_code == 200
    image = np.asarray(Image.open(io.BytesIO(render.content)).convert("RGB"))
    assert image.shape[0] > 100 and image.shape[1] > 50

    # The face pixels must be byte-identical to the source photo.
    photos = (await client.get("/v1/me/body-photos")).json()
    source = np.asarray(Image.open(io.BytesIO(
        (await client.get(photos[0]["url"])).content)).convert("RGB"))
    h, w = image.shape[:2]
    face = source[int(h * .07):int(h * .16), int(w * .40):int(w * .60)]
    face_after = image[int(h * .07):int(h * .16), int(w * .40):int(w * .60)]
    assert np.array_equal(face, face_after), "the face must never be regenerated"

    # The torso must actually have changed.
    torso_before = source[int(h * .25):int(h * .45), int(w * .40):int(w * .60)]
    torso_after = image[int(h * .25):int(h * .45), int(w * .40):int(w * .60)]
    assert not np.array_equal(torso_before, torso_after), "the garment was not applied"


async def test_layered_outfit_renders_one_pass_per_garment(
        client, body_photo, closet_with_cutouts, run_vton_worker, engine):
    photo_id = await body_photo()
    ids = [g["id"] for g in closet_with_cutouts
           if g["role"] in ("base_top", "bottom", "footwear")][:3]
    assert len(ids) >= 2

    job = (await client.post("/v1/vton/jobs", json={
        "garment_ids": ids, "body_photo_id": photo_id,
        "model_id": "composite@1"})).json()
    await run_vton_worker()

    done = (await client.get(f"/v1/vton/jobs/{job['id']}")).json()
    assert done["status"] == "succeeded"
    # composite@1 declares multi-garment support, so one pass covers the look.
    assert done["total_passes"] == 1
    assert set(done["garment_ids"]) == set(ids)


async def test_try_on_from_a_saved_outfit(client, body_photo, closet_with_cutouts,
                                          run_vton_worker):
    photo_id = await body_photo()
    items = [{"garment_id": g["id"]} for g in closet_with_cutouts
             if g["role"] in ("base_top", "bottom")][:2]
    outfit = (await client.post("/v1/outfits", json={"name": "Test", "items": items})).json()

    job = (await client.post("/v1/vton/jobs", json={
        "outfit_id": outfit["id"], "body_photo_id": photo_id})).json()
    await run_vton_worker()

    done = (await client.get(f"/v1/vton/jobs/{job['id']}")).json()
    assert done["status"] == "succeeded"
    assert done["outfit_id"] == outfit["id"]


# ── cost controls ───────────────────────────────────────────────────────────
async def test_identical_request_is_served_from_cache_and_costs_no_quota(
        client, body_photo, closet_with_cutouts, run_vton_worker, engine, user_id):
    photo_id = await body_photo()
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    payload = {"garment_ids": [top["id"]], "body_photo_id": photo_id}

    first = await client.post("/v1/vton/jobs", json=payload)
    assert first.status_code == 202
    await run_vton_worker()

    async with engine.connect() as conn:
        used_before = (await conn.execute(text(
            "select used from public.usage_counters "
            "where user_id = :u and metric = 'vton_renders'"),
            {"u": str(user_id)})).scalar_one()

    second = await client.post("/v1/vton/jobs", json=payload)
    assert second.status_code == 200, "an identical render is a cache hit"
    assert second.json()["cache_hit"] is True
    assert second.json()["result_url"]

    async with engine.connect() as conn:
        used_after = (await conn.execute(text(
            "select used from public.usage_counters "
            "where user_id = :u and metric = 'vton_renders'"),
            {"u": str(user_id)})).scalar_one()
    assert used_after == used_before, "a cache hit must not consume quota"


async def test_quota_exhaustion_returns_402(client, body_photo, closet_with_cutouts,
                                            engine, user_id):
    photo_id = await body_photo()
    async with engine.begin() as conn:
        await conn.execute(text("""
            insert into public.usage_counters (user_id, period_start, metric, used, quota)
            values (:u, date_trunc('month', now())::date, 'vton_renders', 5, 5)
            on conflict (user_id, period_start, metric)
              do update set used = 5, quota = 5
        """), {"u": str(user_id)})

    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    r = await client.post("/v1/vton/jobs", json={
        "garment_ids": [top["id"]], "body_photo_id": photo_id,
        "params": {"seed": 7}})
    assert r.status_code == 402
    assert r.json()["metric"] == "vton_renders"


async def test_idempotency_key_does_not_start_a_second_render(
        client, body_photo, closet_with_cutouts):
    photo_id = await body_photo()
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    payload = {"garment_ids": [top["id"]], "body_photo_id": photo_id}
    headers = {"Idempotency-Key": "tryon-1"}

    a = await client.post("/v1/vton/jobs", json=payload, headers=headers)
    b = await client.post("/v1/vton/jobs", json=payload, headers=headers)
    assert a.status_code == 202 and b.status_code == 200
    assert a.json()["id"] == b.json()["id"]


# ── licensing ───────────────────────────────────────────────────────────────
async def test_non_commercial_model_is_refused(client, body_photo, closet_with_cutouts,
                                               engine):
    photo_id = await body_photo()
    async with engine.begin() as conn:
        await conn.execute(text(
            "update public.vton_models set is_enabled = true where id = 'idm-vton@1'"))

    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    r = await client.post("/v1/vton/jobs", json={
        "garment_ids": [top["id"]], "body_photo_id": photo_id, "model_id": "idm-vton@1"})
    assert r.status_code == 400
    assert "not licensed" in r.json()["detail"]

    models = (await client.get("/v1/vton/models")).json()
    idm = next(m for m in models if m["id"] == "idm-vton@1")
    assert idm["available_to_user"] is False

    async with engine.begin() as conn:
        await conn.execute(text(
            "update public.vton_models set is_enabled = false where id = 'idm-vton@1'"))


# ── consent withdrawal ──────────────────────────────────────────────────────
async def test_revoking_consent_erases_body_photos_and_renders(
        client, body_photo, closet_with_cutouts, run_vton_worker, engine, user_id):
    """Withdrawing consent must delete the pictures, not merely stop new ones."""
    photo_id = await body_photo()
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    job = (await client.post("/v1/vton/jobs", json={
        "garment_ids": [top["id"]], "body_photo_id": photo_id})).json()
    await run_vton_worker()
    assert (await client.get(f"/v1/vton/jobs/{job['id']}")).json()["status"] == "succeeded"

    await client.post("/v1/me/consents", json={
        "consent_type": "vton_processing", "granted": False,
        "policy_version": "privacy-2026-04-01"})

    assert (await client.get("/v1/me/body-photos")).json() == []
    assert (await client.get(f"/v1/vton/jobs/{job['id']}")).status_code == 404

    # The rendered bytes are queued for deletion, not orphaned in storage.
    async with engine.connect() as conn:
        purgeable = (await conn.execute(text(
            "select count(*) from public.v_purgeable_media where user_id = :u"),
            {"u": str(user_id)})).scalar_one()
    assert purgeable >= 1

    blocked = await client.post("/v1/vton/jobs", json={"garment_ids": [top["id"]]})
    assert blocked.status_code == 403


async def test_deleting_a_body_photo_erases_its_renders(
        client, body_photo, closet_with_cutouts, run_vton_worker, engine, user_id):
    photo_id = await body_photo()
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    job = (await client.post("/v1/vton/jobs", json={
        "garment_ids": [top["id"]], "body_photo_id": photo_id})).json()
    await run_vton_worker()

    assert (await client.delete(f"/v1/me/body-photos/{photo_id}")).status_code == 204
    assert (await client.get(f"/v1/vton/jobs/{job['id']}")).status_code == 404
    assert (await client.delete(f"/v1/me/body-photos/{photo_id}")).status_code == 404

    async with engine.connect() as conn:
        purgeable = (await conn.execute(text(
            "select count(*) from public.v_purgeable_media where user_id = :u"),
            {"u": str(user_id)})).scalar_one()
    assert purgeable >= 1, "the rendered bytes must be queued for deletion"


# ── validation, isolation, worker ───────────────────────────────────────────
async def test_try_on_without_a_body_photo_is_a_clear_error(client, closet_with_cutouts):
    await client.post("/v1/me/consents", json={
        "consent_type": "vton_processing", "granted": True,
        "policy_version": "privacy-2026-04-01"})
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    r = await client.post("/v1/vton/jobs", json={"garment_ids": [top["id"]]})
    assert r.status_code == 400
    assert "body photo" in r.json()["detail"].lower()


async def test_neither_outfit_nor_garments_is_rejected(client, body_photo):
    await body_photo()
    r = await client.post("/v1/vton/jobs", json={})
    assert r.status_code == 400


async def test_renders_are_private(client_factory, make_user, run_worker, run_vton_worker):
    from tests.factories import body_image, outfit_image, sha256

    alice, bob = await make_user(), await make_user()
    async with client_factory(alice) as ac:
        media = await upload_wardrobe_photo(ac, outfit_image(seed=4))
        await ac.post("/v1/ingest/jobs", json={"media_ids": [media]})
        await run_worker()
        garments = (await ac.get("/v1/garments")).json()["items"]

        await ac.post("/v1/me/consents", json={
            "consent_type": "vton_processing", "granted": True,
            "policy_version": "privacy-2026-04-01"})
        data = body_image()
        entry = (await ac.post("/v1/uploads/presign", json={
            "purpose": "body_reference",
            "files": [{"filename": "me.jpg", "mime_type": "image/jpeg",
                       "byte_size": len(data), "sha256": sha256(data)}]})).json()["uploads"][0]
        await ac.put(entry["upload_url"], content=data,
                     headers={"Content-Type": "image/jpeg"})
        photo = (await ac.post("/v1/me/body-photos",
                               json={"media_id": entry["media_id"]})).json()
        job = (await ac.post("/v1/vton/jobs", json={
            "garment_ids": [garments[0]["id"]], "body_photo_id": photo["id"]})).json()

    await run_vton_worker()

    async with client_factory(bob) as bc:
        assert (await bc.get("/v1/vton/jobs")).json() == []
        assert (await bc.get(f"/v1/vton/jobs/{job['id']}")).status_code == 404
        assert (await bc.delete(f"/v1/vton/jobs/{job['id']}")).status_code == 404
        assert (await bc.get("/v1/me/body-photos")).json() == []


async def test_concurrent_vton_workers_claim_each_job_once(
        client, body_photo, closet_with_cutouts, settings, engine):
    import asyncio

    from workers.vton.runner import build_pipeline, process_once

    photo_id = await body_photo()
    tops = list(closet_with_cutouts)[:3]
    for index, g in enumerate(tops):
        await client.post("/v1/vton/jobs", json={
            "garment_ids": [g["id"]], "body_photo_id": photo_id,
            "params": {"seed": index}})

    pipeline = build_pipeline(settings)
    results = await asyncio.gather(*[
        process_once(pipeline, f"gpu-{n}", settings) for n in range(3)
    ])
    assert sum(results) == len(tops)

    async with engine.connect() as conn:
        rows = (await conn.execute(text(
            "select attempts, status::text as status from public.vton_jobs"))).mappings().all()
    assert all(r["attempts"] == 1 for r in rows)
    assert all(r["status"] in ("succeeded", "partial") for r in rows)


async def test_stuck_job_is_reclaimed_after_its_ttl(
        client, body_photo, closet_with_cutouts, settings, run_vton_worker, engine):
    photo_id = await body_photo()
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    job = (await client.post("/v1/vton/jobs", json={
        "garment_ids": [top["id"]], "body_photo_id": photo_id})).json()

    async with engine.begin() as conn:
        await conn.execute(text("""
            update public.vton_jobs
               set status='running', attempts=1, started_at = now() - interval '2 hours'
             where id = :i
        """), {"i": job["id"]})

    assert await run_vton_worker() == 1
    assert (await client.get(f"/v1/vton/jobs/{job['id']}")).json()["status"] == "succeeded"


async def test_cancelling_a_queued_job(client, body_photo, closet_with_cutouts,
                                       run_vton_worker):
    photo_id = await body_photo()
    top = next(g for g in closet_with_cutouts if g["role"] == "base_top")
    job = (await client.post("/v1/vton/jobs", json={
        "garment_ids": [top["id"]], "body_photo_id": photo_id})).json()

    assert (await client.delete(f"/v1/vton/jobs/{job['id']}")).status_code == 204
    assert (await client.get(f"/v1/vton/jobs/{job['id']}")).json()["status"] == "cancelled"
    assert await run_vton_worker() == 0, "a cancelled job must not be picked up"
