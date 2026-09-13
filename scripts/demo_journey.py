#!/usr/bin/env python
"""End-to-end demonstration of all four backend phases.

Photos in -> tagged wardrobe -> occasion-aware outfits -> a try-on render.
Runs the real API in-process, the real workers, and a real database.

    .venv/bin/python scripts/demo_journey.py
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
from tests.factories import (  # noqa: E402
    BURGUNDY, CAMEL, CHARCOAL, NAVY, WHITE, body_image, outfit_image, sha256,
)
from workers.vision.runner import build_pipeline as build_vision  # noqa: E402
from workers.vision.runner import process_once as run_vision  # noqa: E402
from workers.vton.runner import build_pipeline as build_vton  # noqa: E402
from workers.vton.runner import process_once as run_vton  # noqa: E402

RULE = "─" * 62


def header(text_: str) -> None:
    print(f"\n{RULE}\n  {text_}\n{RULE}")


async def upload(client, data, name, purpose="wardrobe"):
    entry = (await client.post("/v1/uploads/presign", json={
        "purpose": purpose,
        "files": [{"filename": name, "mime_type": "image/jpeg",
                   "byte_size": len(data), "sha256": sha256(data)}],
    })).json()["uploads"][0]
    if entry["upload_url"]:
        await client.put(entry["upload_url"], content=data,
                         headers={"Content-Type": "image/jpeg"})
    return entry["media_id"]


async def main() -> None:
    settings = get_settings()
    app = create_app(settings)
    engine = get_engine(settings)

    user_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text("insert into public.users (id, email, display_name) values (:i,:e,'Demo')"),
            {"i": str(user_id), "e": f"demo-{user_id}@example.com"})

    token = issue_dev_token(user_id, settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://testserver",
                                 headers={"Authorization": f"Bearer {token}"},
                                 timeout=120) as client:

        # ── Phase 2: photos become a wardrobe ────────────────────────────────
        header("PHASE 2 — photos in, tagged wardrobe out")
        looks = {
            "navy + camel": outfit_image(NAVY, CAMEL, WHITE, seed=1),
            "burgundy + charcoal": outfit_image(BURGUNDY, CHARCOAL, WHITE, seed=2),
            "white + navy": outfit_image(WHITE, NAVY, CHARCOAL, seed=3),
        }
        media = [await upload(client, data, f"{name}.jpg") for name, data in looks.items()]
        job = (await client.post("/v1/ingest/jobs", json={"media_ids": media})).json()
        print(f"  queued ingest job {job['id'][:8]}… over {job['items_discovered']} photos")

        handled = await run_vision(build_vision(settings), "demo", settings)
        done = (await client.get(f"/v1/ingest/jobs/{job['id']}")).json()
        print(f"  worker handled {handled} item(s) -> status={done['status']} "
              f"garments={done['garments_created']} review={done['needs_review']}")

        garments = (await client.get("/v1/garments")).json()["items"]
        print(f"\n  {'item':26s} {'category':14s} {'role':10s} {'colour':20s} form warm")
        for g in garments:
            colour = f"{g['colors'][0]['color_family']} {g['colors'][0]['hex']}" if g["colors"] else "—"
            print(f"  {str(g['name'])[:25]:26s} {g['category']:14s} {g['role']:10s} "
                  f"{colour:20s} {g['formality']:^4} {g['warmth']:^4}")

        # ── Phase 3: the styling engine ──────────────────────────────────────
        header("PHASE 3 — occasion + weather -> ranked outfits")
        # The pipeline tagged everything business-formal, so a casual request has
        # nothing to work with — and the 422 names the empty slots.
        refused = await client.post("/v1/outfits/recommend", json={
            "occasion": "casual_gathering", "count": 2,
            "weather_override": {"temp_c": 33, "feels_like_c": 36}})
        print(f"\n  casual_gathering -> HTTP {refused.status_code}: "
              f"{refused.json()['detail']}")
        print(f"    missing roles: {refused.json()['missing_roles']}")

        for occasion, weather in [
            ("conference", {"temp_c": 19, "feels_like_c": 18, "precip_prob": 0.1}),
            ("business_meeting", {"temp_c": 12, "feels_like_c": 9, "precip_prob": 0.6}),
        ]:
            result = (await client.post("/v1/outfits/recommend", json={
                "occasion": occasion, "count": 2, "weather_override": weather})).json()
            if "outfits" not in result:
                print(f"\n  {occasion}: {result.get('detail')}")
                continue
            print(f"\n  {occasion}  ·  {weather['temp_c']}°C  ·  "
                  f"{result['candidate_count']} pieces considered  ·  {result['latency_ms']} ms")
            for outfit in result["outfits"]:
                pieces = " + ".join(i["garment"]["name"] for i in outfit["items"])
                print(f"    [{outfit['total_score']:.3f}] {pieces}")
                print(f"            {outfit['rationale']}")
                top = sorted(((k, v) for k, v in outfit["score_breakdown"].items()
                              if k != "completeness"), key=lambda kv: -kv[1])[:3]
                print("            " + "  ".join(f"{k}={v:.2f}" for k, v in top))

        # The user corrects two auto-tags (the Phase-2 edit path) and the same
        # casual request now succeeds — no retraining, no deploy.
        casual_edits = 0
        for g in garments:
            if g["role"] in ("base_top", "bottom") and casual_edits < 4:
                await client.patch(f"/v1/garments/{g['id']}", json={"formality": 2})
                casual_edits += 1
        retry = (await client.post("/v1/outfits/recommend", json={
            "occasion": "casual_gathering", "count": 1,
            "weather_override": {"temp_c": 33, "feels_like_c": 36}})).json()
        print(f"\n  user re-tags {casual_edits} pieces as casual -> casual_gathering now "
              f"returns {len(retry.get('outfits', []))} look(s)")
        for outfit in retry.get("outfits", []):
            print("    " + " + ".join(i["garment"]["name"] for i in outfit["items"]))

        # Feedback moves the taste vector.
        first = (await client.post("/v1/outfits/recommend", json={
            "occasion": "conference", "count": 1,
            "weather_override": {"temp_c": 24, "feels_like_c": 24}})).json()["outfits"][0]
        fb = (await client.post(f"/v1/outfits/{first['id']}/feedback",
                                json={"kind": "like"})).json()
        print(f"\n  liked that look -> taste vector updated: {fb['taste_updated']}")

        # ── Phase 4: virtual try-on ──────────────────────────────────────────
        header("PHASE 4 — see it on me")
        await client.post("/v1/me/consents", json={
            "consent_type": "vton_processing", "granted": True,
            "policy_version": "privacy-2026-04-01"})
        photo_media = await upload(client, body_image(), "me.jpg", purpose="body_reference")
        photo = (await client.post("/v1/me/body-photos",
                                   json={"media_id": photo_media})).json()
        print(f"  body photo {photo['id'][:8]}… registered (5-minute signed URL)")

        tryon = (await client.post("/v1/vton/jobs", json={
            "outfit_id": first["id"], "body_photo_id": photo["id"]})).json()
        print(f"  queued render {tryon['id'][:8]}… on {tryon['model_id']}")

        await run_vton(build_vton(settings), "demo-gpu", settings)
        rendered = (await client.get(f"/v1/vton/jobs/{tryon['id']}")).json()
        print(f"  status={rendered['status']} in {rendered['duration_ms']} ms  "
              f"qa={rendered['qa_score']} flags={rendered['qa_flags'] or 'none'}")

        cached = await client.post("/v1/vton/jobs", json={
            "outfit_id": first["id"], "body_photo_id": photo["id"]})
        print(f"  identical request -> HTTP {cached.status_code} "
              f"cache_hit={cached.json()['cache_hit']} (no quota consumed)")

        # ── Privacy ──────────────────────────────────────────────────────────
        header("PRIVACY — withdrawing consent erases the pictures")
        await client.post("/v1/me/consents", json={
            "consent_type": "vton_processing", "granted": False,
            "policy_version": "privacy-2026-04-01"})
        photos_left = (await client.get("/v1/me/body-photos")).json()
        job_after = await client.get(f"/v1/vton/jobs/{tryon['id']}")
        async with engine.connect() as conn:
            purgeable = (await conn.execute(text(
                "select count(*) from public.v_purgeable_media where user_id = :u"),
                {"u": str(user_id)})).scalar_one()
        print(f"  body photos remaining: {len(photos_left)}")
        print(f"  render still readable: HTTP {job_after.status_code} (404 = erased)")
        print(f"  media objects queued for deletion from storage: {purgeable}")

        stats = (await client.get("/v1/wardrobe/stats")).json()
        print(f"\n  wardrobe: {stats['items']} pieces, {stats['never_worn']} never worn, "
              f"gaps: {stats['gaps'] or 'none'}")

    await engine.dispose()
    print()


if __name__ == "__main__":
    asyncio.run(main())
