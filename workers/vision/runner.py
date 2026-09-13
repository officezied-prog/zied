"""Vision worker.

Claims image work with ``SELECT … FOR UPDATE SKIP LOCKED`` (see migration 0010),
runs the pipeline, and records the outcome. Two properties matter:

* **Exactly-once claiming** across any number of worker processes, with no queue
  broker to run or lose messages to.
* **Crash recovery for free** — a claim carries a TTL, so work from a worker that
  died is re-claimable instead of stuck. `attempts` caps the retry loop so a
  poison image fails loudly rather than spinning forever.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import socket
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.config import Settings, get_settings
from api.app.db import dispose_engine, execute, fetch_all, service_session
from api.app.storage import get_store

from .pipeline import VisionPipeline
from .segmenters import build_segmenter

log = logging.getLogger("smartstylist.worker")


def build_pipeline(settings: Settings) -> VisionPipeline:
    return VisionPipeline(
        settings=settings,
        store=get_store(settings),
        segmenter=build_segmenter(settings.segmenter, weights=settings.yolo_weights),
    )


async def claim_batch(conn: AsyncConnection, worker_id: str, settings: Settings):
    return await fetch_all(conn, """
        select * from public.claim_ingest_items(:worker, :batch, :ttl, :max_attempts)
    """, {"worker": worker_id, "batch": settings.worker_batch_size,
          "ttl": settings.worker_claim_ttl_s, "max_attempts": settings.worker_max_attempts})


async def process_once(pipeline: VisionPipeline, worker_id: str,
                       settings: Settings | None = None) -> int:
    """Claim and process one batch. Returns how many items were handled."""
    s = settings or get_settings()
    async with service_session() as conn:
        items = await claim_batch(conn, worker_id, s)

    handled = 0
    for item in items:
        # One transaction per item: a failure rolls back that item's writes only,
        # and the batch keeps going.
        async with service_session() as conn:
            auto = await _auto_accept_for(conn, item["job_id"])
            try:
                result = await pipeline.process_media(
                    conn,
                    media_id=UUID(str(item["media_asset_id"])),
                    user_id=UUID(str(item["user_id"])),
                    ingest_job_id=UUID(str(item["job_id"])),
                    auto_accept=auto,
                )
                await execute(conn, """
                    update public.ingest_job_items
                       set status = case when :errs then 'failed'::public.job_status
                                         else 'succeeded'::public.job_status end,
                           detections = :det, garments_created = :g, needs_review = :r,
                           duplicates = :d, error_detail = :err, finished_at = now()
                     where id = :id
                """, {"errs": bool(result.errors), "det": result.detections,
                      "g": result.garments, "r": result.needs_review,
                      "d": result.duplicates,
                      "err": "; ".join(result.errors)[:2000] or None, "id": item["id"]})
                log.info("item=%s media=%s detections=%d garments=%d review=%d dupes=%d %s",
                         item["id"], item["media_asset_id"], result.detections,
                         result.garments, result.needs_review, result.duplicates,
                         result.skipped_reason or "")
            except Exception as exc:
                log.exception("item %s failed", item["id"])
                await execute(conn, """
                    update public.ingest_job_items
                       set status = case when attempts >= :max then 'failed'::public.job_status
                                         else 'queued'::public.job_status end,
                           error_detail = :err,
                           finished_at = case when attempts >= :max then now() else null end
                     where id = :id
                """, {"max": s.worker_max_attempts, "err": str(exc)[:2000], "id": item["id"]})
        handled += 1
    return handled


async def run_forever(settings: Settings | None = None) -> None:
    s = settings or get_settings()
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    pipeline = build_pipeline(s)
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info("vision worker %s started (segmenter=%s)", worker_id, s.segmenter)
    while not stop.is_set():
        try:
            handled = await process_once(pipeline, worker_id, s)
        except Exception:
            log.exception("claim loop error")
            handled = 0
        if handled == 0:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=s.worker_poll_interval_s)
    await dispose_engine()
    log.info("vision worker %s stopped", worker_id)


async def _auto_accept_for(conn: AsyncConnection, job_id) -> bool:
    rows = await fetch_all(conn, "select auto_accept from public.ingest_jobs where id = :id",
                           {"id": str(job_id)})
    return bool(rows[0]["auto_accept"]) if rows else True


def main() -> None:
    parser = argparse.ArgumentParser(description="SmartStylist vision worker")
    parser.add_argument("--once", action="store_true", help="process a single batch and exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    if args.once:
        pipeline = build_pipeline(settings)
        n = asyncio.run(process_once(pipeline, f"cli:{os.getpid()}", settings))
        print(f"processed {n} item(s)")
    else:
        asyncio.run(run_forever(settings))


if __name__ == "__main__":
    main()
