"""GPU try-on worker.

Same claiming discipline as the vision worker (migration 0014): exactly-once via
FOR UPDATE SKIP LOCKED, priority-ordered so paid tiers jump the queue, and a
claim TTL that recovers work from a worker that died. That last property matters
more here than anywhere else in the system — a lost job is paid GPU seconds.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import socket

from api.app.config import Settings, get_settings
from api.app.db import dispose_engine, execute, fetch_all, service_session
from api.app.storage import get_store

from .pipeline import VtonPipeline

log = logging.getLogger("smartstylist.vton.worker")


def build_pipeline(settings: Settings) -> VtonPipeline:
    return VtonPipeline(settings=settings, store=get_store(settings))


async def process_once(pipeline: VtonPipeline, worker_id: str,
                       settings: Settings | None = None) -> int:
    s = settings or get_settings()
    async with service_session() as conn:
        jobs = await fetch_all(conn, """
            select * from public.claim_vton_jobs(:w, :batch, :ttl, :max)
        """, {"w": worker_id, "batch": s.vton_batch_size, "ttl": s.vton_claim_ttl_s,
              "max": s.worker_max_attempts})

    handled = 0
    for job in jobs:
        async with service_session() as conn:
            try:
                outcome = await pipeline.run(conn, dict(job))
                log.info("job=%s status=%s passes=%d %dms qa=%s %s",
                         outcome.job_id, outcome.status, outcome.passes,
                         outcome.duration_ms, outcome.qa_score, outcome.qa_flags)
            except Exception as exc:
                log.exception("vton job %s crashed", job["id"])
                await execute(conn, """
                    update public.vton_jobs
                       set status = case when attempts >= :max then 'failed'::public.job_status
                                         else 'queued'::public.job_status end,
                           error_code = 'worker_exception', error_detail = :detail,
                           finished_at = case when attempts >= :max then now() else null end
                     where id = :id
                """, {"max": s.worker_max_attempts, "detail": str(exc)[:2000],
                      "id": str(job["id"])})
        handled += 1
    return handled


async def reap(settings: Settings | None = None) -> int:
    """Fail jobs that exhausted their attempts instead of leaving them 'running'."""
    s = settings or get_settings()
    async with service_session() as conn:
        rows = await fetch_all(conn, "select public.expire_stuck_vton_jobs(:m) as n",
                               {"m": s.worker_max_attempts})
    return int(rows[0]["n"]) if rows else 0


async def run_forever(settings: Settings | None = None) -> None:
    s = settings or get_settings()
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    pipeline = build_pipeline(s)
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info("vton worker %s started", worker_id)
    ticks = 0
    while not stop.is_set():
        try:
            handled = await process_once(pipeline, worker_id, s)
            ticks += 1
            if ticks % 60 == 0:
                await reap(s)
        except Exception:
            log.exception("vton claim loop error")
            handled = 0
        if handled == 0:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=s.worker_poll_interval_s)
    await dispose_engine()
    log.info("vton worker %s stopped", worker_id)


def main() -> None:
    parser = argparse.ArgumentParser(description="SmartStylist try-on worker")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    if args.once:
        n = asyncio.run(process_once(build_pipeline(settings), f"cli:{os.getpid()}", settings))
        print(f"processed {n} job(s)")
    else:
        asyncio.run(run_forever(settings))


if __name__ == "__main__":
    main()
