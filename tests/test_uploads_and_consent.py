"""Upload guards, signed-URL integrity, and the consent ledger."""
from __future__ import annotations

import time

import pytest

from tests.factories import outfit_image, sha256


async def test_rejects_unsupported_media_type(client):
    r = await client.post("/v1/uploads/presign", json={
        "files": [{"filename": "x.gif", "mime_type": "image/gif",
                   "byte_size": 100, "sha256": "a" * 64}]})
    assert r.status_code == 400
    body = r.json()
    assert body["type"].endswith("/invalid-request")
    assert "image/jpeg" in body["allowed"]


async def test_rejects_oversized_file(client, settings):
    r = await client.post("/v1/uploads/presign", json={
        "files": [{"filename": "big.jpg", "mime_type": "image/jpeg",
                   "byte_size": settings.max_upload_bytes + 1, "sha256": "b" * 64}]})
    assert r.status_code == 400


async def test_rejects_malformed_sha256(client):
    r = await client.post("/v1/uploads/presign", json={
        "files": [{"filename": "x.jpg", "mime_type": "image/jpeg",
                   "byte_size": 10, "sha256": "not-a-hash"}]})
    assert r.status_code == 422
    assert r.json()["type"].endswith("/validation-error")


async def test_tampered_upload_url_is_refused(client):
    data = outfit_image()
    r = await client.post("/v1/uploads/presign", json={
        "files": [{"filename": "a.jpg", "mime_type": "image/jpeg",
                   "byte_size": len(data), "sha256": sha256(data)}]})
    url = r.json()["uploads"][0]["upload_url"]

    tampered = url.replace("sig=", "sig=0")
    assert (await client.put(tampered, content=data)).status_code == 400

    other_key = url.replace(url.split("/_storage/")[1].split("?")[0], "someone-else/evil.jpg")
    assert (await client.put(other_key, content=data)).status_code == 400


async def test_expired_upload_url_is_refused(client, settings):
    from api.app.storage import get_store

    store = get_store(settings)
    expires = int(time.time()) - 10
    sig = store._sign("PUT", settings.bucket_source, "u/expired.jpg", expires)
    url = f"/_storage/{settings.bucket_source}/u/expired.jpg?expires={expires}&sig={sig}"
    assert (await client.put(url, content=b"x")).status_code == 400


async def test_presign_is_scoped_to_the_caller(client, client_factory, make_user):
    """Two users uploading identical bytes get separate media rows and keys."""
    data = outfit_image()
    payload = {"files": [{"filename": "same.jpg", "mime_type": "image/jpeg",
                          "byte_size": len(data), "sha256": sha256(data)}]}
    mine = (await client.post("/v1/uploads/presign", json=payload)).json()["uploads"][0]

    other = await make_user()
    async with client_factory(other) as oc:
        theirs = (await oc.post("/v1/uploads/presign", json=payload)).json()["uploads"][0]

    assert mine["media_id"] != theirs["media_id"]
    assert theirs["duplicate_of"] is None
    assert mine["upload_url"].split("?")[0] != theirs["upload_url"].split("?")[0]


# ── consent ─────────────────────────────────────────────────────────────────
async def test_consent_is_an_append_only_ledger(client):
    assert (await client.get("/v1/me/consents")).json() == []

    grant = await client.post("/v1/me/consents", json={
        "consent_type": "biometric_processing", "granted": True,
        "policy_version": "privacy-2026-04-01"})
    assert grant.status_code == 201
    assert grant.json()["granted"] is True

    revoke = await client.post("/v1/me/consents", json={
        "consent_type": "biometric_processing", "granted": False,
        "policy_version": "privacy-2026-04-01"})
    assert revoke.status_code == 201

    state = (await client.get("/v1/me/consents")).json()
    assert len(state) == 1, "the view shows current state, one row per purpose"
    assert state[0]["granted"] is False, "the latest decision wins"


async def test_consent_history_survives_revocation(client, engine, user_id):
    from sqlalchemy import text

    for granted in (True, False, True):
        await client.post("/v1/me/consents", json={
            "consent_type": "vton_processing", "granted": granted,
            "policy_version": "privacy-2026-04-01"})

    async with engine.connect() as conn:
        rows = (await conn.execute(
            text("select granted from public.user_consents "
                 "where user_id = :u and consent_type = 'vton_processing' order by created_at"),
            {"u": str(user_id)})).scalars().all()
    assert rows == [True, False, True], "every decision must remain auditable"


async def test_biometric_write_requires_consent_at_the_database_level(engine, user_id):
    """Defence in depth: even a bug in the API cannot write without consent."""
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    async with engine.connect() as conn, conn.begin():
        await conn.execute(text("select set_config('app.current_user_id', :u, true)"),
                           {"u": str(user_id)})
        await conn.execute(text('set local role "authenticated"'))
        with pytest.raises(DBAPIError, match="consent required"):
            # `:` inside a literal would be read as a bind marker — pass JSON as a parameter.
            await conn.execute(
                text("select public.upsert_biometric_profile(cast(:patch as jsonb))"),
                {"patch": '{"height_cm": 170}'},
            )


async def test_me_returns_the_authenticated_user(client, user_id):
    body = (await client.get("/v1/me")).json()
    assert body["id"] == str(user_id)
    assert body["units"] == "metric"


async def test_taxonomy_is_cacheable(client):
    r = await client.get("/v1/taxonomy/categories")
    assert r.status_code == 200 and r.headers["ETag"]
    cats = r.json()
    assert len(cats) > 60
    assert {c["slug"] for c in cats} >= {"tops", "shirt", "denim_jacket", "hijab", "abaya"}

    occasions = (await client.get("/v1/taxonomy/occasions")).json()
    assert {o["slug"] for o in occasions} >= {"date_night", "business_meeting", "formal_event"}

    families = (await client.get("/v1/taxonomy/color-families")).json()
    assert {f["slug"] for f in families} >= {"navy", "camel", "burgundy"}
