"""Worker claim semantics — the properties that keep a fleet correct."""
from __future__ import annotations

import asyncio

from sqlalchemy import text

from tests.factories import outfit_image, sha256
from workers.vision.runner import process_once


async def _queue_one(client, data=None):
    data = data or outfit_image()
    r = await client.post("/v1/uploads/presign", json={
        "files": [{"filename": "x.jpg", "mime_type": "image/jpeg",
                   "byte_size": len(data), "sha256": sha256(data)}]})
    entry = r.json()["uploads"][0]
    await client.put(entry["upload_url"], content=data, headers={"Content-Type": "image/jpeg"})
    job = await client.post("/v1/ingest/jobs", json={"media_ids": [entry["media_id"]]})
    return job.json(), entry["media_id"]


async def test_concurrent_workers_never_claim_the_same_item(client, pipeline, settings, engine):
    """SKIP LOCKED is the whole reason a broker isn't needed. Prove it holds."""
    for i in range(6):
        await _queue_one(client, outfit_image(seed=i, size=(200 + i, 340)))

    results = await asyncio.gather(*[
        process_once(pipeline, f"worker-{n}", settings) for n in range(4)
    ])
    assert sum(results) == 6, f"each item exactly once, got {results}"

    async with engine.connect() as conn:
        rows = (await conn.execute(text(
            "select attempts, status::text as status, claimed_by "
            "from public.ingest_job_items"))).mappings().all()
    assert all(r["attempts"] == 1 for r in rows), "no item was claimed twice"
    assert all(r["status"] == "succeeded" for r in rows)
    assert len({r["claimed_by"] for r in rows}) >= 1


async def test_expired_claim_is_recovered(client, pipeline, settings, engine):
    """A worker that dies mid-item must not strand the work."""
    job, _ = await _queue_one(client)

    async with engine.begin() as conn:
        await conn.execute(text("""
            update public.ingest_job_items
               set status = 'running', claimed_by = 'dead-worker', attempts = 1,
                   claimed_at = now() - interval '2 hours',
                   claim_expires_at = now() - interval '1 hour'
             where job_id = :j
        """), {"j": job["id"]})

    assert await process_once(pipeline, "healthy-worker", settings) == 1

    async with engine.connect() as conn:
        row = (await conn.execute(text(
            "select status::text as status, claimed_by, attempts "
            "from public.ingest_job_items where job_id = :j"), {"j": job["id"]})).mappings().one()
    assert row["status"] == "succeeded"
    assert row["claimed_by"] == "healthy-worker"
    assert row["attempts"] == 2


async def test_live_claim_is_not_stolen(client, pipeline, settings, engine):
    job, _ = await _queue_one(client)
    async with engine.begin() as conn:
        await conn.execute(text("""
            update public.ingest_job_items
               set status='running', claimed_by='busy-worker', attempts=1,
                   claimed_at=now(), claim_expires_at=now() + interval '10 minutes'
             where job_id = :j
        """), {"j": job["id"]})

    assert await process_once(pipeline, "other-worker", settings) == 0


async def test_missing_object_fails_the_item_not_the_batch(client, pipeline, settings, engine):
    """One unreadable image must not take down the other five."""
    bad_job, bad_media = await _queue_one(client)
    async with engine.begin() as conn:      # simulate an object lost in storage
        await conn.execute(text(
            "update public.media_assets set storage_key = 'missing/nope.jpg' where id = :m"),
            {"m": bad_media})
    good_job, _ = await _queue_one(client, outfit_image(seed=99))

    assert await process_once(pipeline, "w", settings) == 2

    async with engine.connect() as conn:
        bad = (await conn.execute(text(
            "select status::text as status, items_failed, garments_created "
            "from public.ingest_jobs where id = :j"), {"j": bad_job["id"]})).mappings().one()
        good = (await conn.execute(text(
            "select status::text as status, items_failed, garments_created "
            "from public.ingest_jobs where id = :j"), {"j": good_job["id"]})).mappings().one()

    assert bad["status"] == "failed" and bad["items_failed"] == 1
    assert good["status"] == "succeeded" and good["garments_created"] >= 2


async def test_attempt_cap_stops_a_poison_item(client, pipeline, settings, engine):
    job, _ = await _queue_one(client)
    async with engine.begin() as conn:
        await conn.execute(text("""
            update public.ingest_job_items
               set attempts = :max where job_id = :j
        """), {"max": settings.worker_max_attempts, "j": job["id"]})

    assert await process_once(pipeline, "w", settings) == 0, "capped items are not re-claimed"


async def test_worker_is_idempotent_on_a_finished_job(client, pipeline, settings):
    await _queue_one(client)
    assert await process_once(pipeline, "w", settings) == 1
    assert await process_once(pipeline, "w", settings) == 0
