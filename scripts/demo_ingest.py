#!/usr/bin/env python
"""End-to-end demo: a photo becomes a tagged wardrobe.

Runs the real API in-process, the real presigned-upload round trip and the real
worker against whatever SS_DATABASE_URL points at.

    .venv/bin/python scripts/demo_ingest.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SS_DATABASE_URL",
                      "postgresql+asyncpg://pgtest@/smartstylist?host=/tmp&port=55432")
os.environ.setdefault("SS_STORAGE_LOCAL_ROOT", "/tmp/smartstylist-demo-storage")
os.environ.setdefault("SS_STORAGE_PUBLIC_BASE_URL", "http://testserver/_storage")
os.environ.setdefault("SS_JWT_SECRET", "demo-secret-at-least-32-bytes-long!!")

import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402

from api.app.config import get_settings  # noqa: E402
from api.app.db import get_engine  # noqa: E402
from api.app.main import create_app  # noqa: E402
from api.app.security import issue_dev_token  # noqa: E402
from tests.factories import BURGUNDY, CAMEL, CHARCOAL, NAVY, WHITE, outfit_image, sha256  # noqa: E402
from workers.vision.runner import build_pipeline, process_once  # noqa: E402


async def main() -> None:
    settings = get_settings()
    app = create_app(settings)
    engine = get_engine(settings)

    user_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(text("insert into public.users (id, email, display_name) "
                                "values (:i, :e, 'Demo user')"),
                           {"i": str(user_id), "e": f"demo-{user_id}@example.com"})

    token = issue_dev_token(user_id, settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://testserver",
                                 headers={"Authorization": f"Bearer {token}"},
                                 timeout=60) as client:
        photos = {
            "look-1 navy + camel":      outfit_image(NAVY, CAMEL, WHITE, seed=1),
            "look-2 burgundy + charcoal": outfit_image(BURGUNDY, CHARCOAL, WHITE, seed=2),
        }

        media_ids = []
        print("── upload ─────────────────────────────────────────────")
        for name, data in photos.items():
            r = await client.post("/v1/uploads/presign", json={"files": [{
                "filename": f"{name}.jpg", "mime_type": "image/jpeg",
                "byte_size": len(data), "sha256": sha256(data)}]})
            entry = r.json()["uploads"][0]
            await client.put(entry["upload_url"], content=data,
                             headers={"Content-Type": "image/jpeg"})
            media_ids.append(entry["media_id"])
            print(f"  {name:28s} {len(data):>6} bytes -> media {entry['media_id'][:8]}…")

        job = (await client.post("/v1/ingest/jobs",
                                 json={"media_ids": media_ids})).json()
        print(f"\n  ingest job {job['id'][:8]}… status={job['status']} "
              f"items={job['items_discovered']}")

        print("\n── worker ─────────────────────────────────────────────")
        pipeline = build_pipeline(settings)
        handled = await process_once(pipeline, "demo-worker", settings)
        print(f"  processed {handled} item(s)")

        done = (await client.get(f"/v1/ingest/jobs/{job['id']}")).json()
        print(f"  job status={done['status']} garments={done['garments_created']} "
              f"review={done['needs_review']} failed={done['items_failed']}")

        print("\n── wardrobe ───────────────────────────────────────────")
        items = (await client.get("/v1/garments")).json()["items"]
        print(f"  {'name':26s} {'category':16s} {'role':10s} {'colour':22s} form warm")
        for g in items:
            colour = (f"{g['colors'][0]['color_family']} {g['colors'][0]['hex']}"
                      if g["colors"] else "—")
            print(f"  {str(g['name'])[:25]:26s} {g['category']:16s} {g['role']:10s} "
                  f"{colour:22s} {g['formality']:^4} {g['warmth']:^4}")

        stats = (await client.get("/v1/wardrobe/stats")).json()
        print(f"\n  stats: {stats['items']} items · never worn {stats['never_worn']} "
              f"· by role {stats['by_role']} · gaps {stats['gaps'] or 'none'}")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
