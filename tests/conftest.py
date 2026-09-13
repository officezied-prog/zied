"""Test harness.

Builds a real database from db/migrations + db/seeds, runs the real FastAPI app
over ASGI, and drives the real worker. Nothing important is mocked: the only
substitution is the segmentation backend, which is the stub rather than a
multi-gigabyte checkpoint — and the stub really segments.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from uuid import UUID, uuid4

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PG_BIN = os.environ.get("SS_TEST_PG_BIN", "/usr/lib/postgresql/16/bin")
PG_HOST = os.environ.get("SS_TEST_PG_HOST", "/tmp")
PG_PORT = os.environ.get("SS_TEST_PG_PORT", "55432")
PG_USER = os.environ.get("SS_TEST_PG_USER", "pgtest")
TEST_DB = os.environ.get("SS_TEST_DB", "ss_pytest")

DSN = f"postgresql+asyncpg://{PG_USER}@/{TEST_DB}?host={PG_HOST}&port={PG_PORT}"


def _psql(db: str, *args: str) -> None:
    subprocess.run(
        [f"{PG_BIN}/psql", "-h", PG_HOST, "-p", PG_PORT, "-U", PG_USER, "-d", db,
         "-v", "ON_ERROR_STOP=1", "-q", *args],
        check=True, capture_output=True, text=True,
    )


@pytest.fixture(scope="session", autouse=True)
def database(tmp_path_factory) -> str:
    _psql("postgres", "-c", f'drop database if exists "{TEST_DB}"')
    _psql("postgres", "-c", f'create database "{TEST_DB}"')
    for sql in sorted((ROOT / "db" / "migrations").glob("*.sql")):
        _psql(TEST_DB, "-f", str(sql))
    for sql in sorted((ROOT / "db" / "seeds").glob("*.sql")):
        _psql(TEST_DB, "-f", str(sql))

    storage_root = tmp_path_factory.mktemp("storage")
    os.environ.update({
        "SS_ENVIRONMENT": "test",
        "SS_DATABASE_URL": DSN,
        "SS_STORAGE_BACKEND": "local",
        "SS_STORAGE_LOCAL_ROOT": str(storage_root),
        "SS_STORAGE_PUBLIC_BASE_URL": "http://testserver/_storage",
        "SS_JWT_SECRET": "test-secret-at-least-32-bytes-long!!",
        "SS_SEGMENTER": "stub",
    })
    from api.app.config import get_settings
    from api.app.storage import reset_store
    get_settings.cache_clear()
    reset_store()
    return DSN


@pytest.fixture(scope="session")
def settings(database):
    from api.app.config import get_settings

    return get_settings()


@pytest.fixture(scope="session")
def app(settings):
    from api.app.main import create_app

    return create_app(settings)


@pytest.fixture
async def engine(settings):
    from api.app.db import dispose_engine, get_engine

    yield get_engine(settings)
    await dispose_engine()


@pytest.fixture
async def make_user(engine):
    """Create a user directly (signup lives in the auth provider, not this service)."""
    from sqlalchemy import text

    created: list[UUID] = []

    async def _make(email: str | None = None) -> UUID:
        uid = uuid4()
        async with engine.begin() as conn:
            await conn.execute(
                text("insert into public.users (id, email, display_name) "
                     "values (:id, :email, :name)"),
                {"id": str(uid), "email": email or f"{uid}@example.com", "name": "Test"},
            )
        created.append(uid)
        return uid

    return _make


@pytest.fixture
async def user_id(make_user) -> UUID:
    return await make_user()


@pytest.fixture
def client_factory(app, settings):
    import httpx

    from api.app.security import issue_dev_token

    def _factory(uid: UUID) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": f"Bearer {issue_dev_token(uid, settings)}"},
            timeout=30,
        )

    return _factory


@pytest.fixture
async def client(client_factory, user_id):
    async with client_factory(user_id) as c:
        yield c


@pytest.fixture
def pipeline(settings):
    from workers.vision.runner import build_pipeline

    return build_pipeline(settings)


@pytest.fixture
def run_worker(pipeline, settings):
    from workers.vision.runner import process_once

    async def _run(max_batches: int = 10) -> int:
        total = 0
        for _ in range(max_batches):
            handled = await process_once(pipeline, "pytest-worker", settings)
            if handled == 0:
                break
            total += handled
        return total

    return _run


@pytest.fixture
async def wardrobe(engine):
    """Insert a realistic closet directly, so styling tests are not gated on CV."""
    from sqlalchemy import text

    from workers.vision.color import hex_to_lab, lab_to_lch

    async def _build(uid: UUID, items: list[dict] | None = None) -> dict[str, UUID]:
        items = items or DEFAULT_WARDROBE
        created: dict[str, UUID] = {}
        async with engine.begin() as conn:
            for item in items:
                cat = (await conn.execute(
                    text("select id from public.garment_categories where slug = :s"),
                    {"s": item["category"]})).scalar_one()
                gid = uuid4()
                await conn.execute(text("""
                    insert into public.garments
                        (id, user_id, category_id, role, name, brand, pattern, material,
                         formality, warmth, seasons, source, user_verified, last_worn_at,
                         wear_count, in_laundry)
                    values (:id, :uid, :cat, null, :name, :brand,
                            cast(:pattern as public.pattern_type),
                            cast(:material as text[]), :formality, :warmth,
                            cast(:seasons as public.season[]), 'manual_upload', true,
                            case when cast(:days as int) is null then null
                                 else current_date - cast(:days as int) end,
                            :worn, :laundry)
                """), {
                    "id": str(gid), "uid": str(uid), "cat": cat, "name": item["name"],
                    "brand": item.get("brand"), "pattern": item.get("pattern", "solid"),
                    "material": item.get("material", ["cotton"]),
                    "formality": item.get("formality"), "warmth": item.get("warmth"),
                    "seasons": item.get("seasons"), "days": item.get("days_since_worn"),
                    "worn": item.get("wear_count", 0), "laundry": item.get("in_laundry", False),
                })
                lab = hex_to_lab(item["hex"])
                chroma, hue = (float(v) for v in lab_to_lch(lab))
                await conn.execute(text("""
                    insert into public.garment_colors
                        (garment_id, rank, hex, ratio, lab_l, lab_a, lab_b, lch_h, lch_c,
                         color_family, is_neutral)
                    values (:g, 1, :hex, 0.85, :l, :a, :b, :h, :c, :fam, :neutral)
                """), {"g": str(gid), "hex": item["hex"], "l": float(lab[0]),
                       "a": float(lab[1]), "b": float(lab[2]), "h": hue, "c": chroma,
                       "fam": item["family"], "neutral": item.get("neutral", False)})
                created[item["name"]] = gid
        return created

    return _build


DEFAULT_WARDROBE: list[dict] = [
    # tops
    {"name": "Navy shirt", "category": "shirt", "hex": "#1B2A4A", "family": "navy",
     "neutral": True, "material": ["cotton"], "days_since_worn": 30},
    {"name": "White tee", "category": "t_shirt", "hex": "#F7F7F7", "family": "white",
     "neutral": True, "days_since_worn": 3},
    {"name": "Burgundy blouse", "category": "blouse", "hex": "#6E1B2E", "family": "burgundy",
     "material": ["silk"], "days_since_worn": 60},
    {"name": "Grey hoodie", "category": "hoodie", "hex": "#9AA0A6", "family": "grey",
     "neutral": True, "days_since_worn": 2},
    # bottoms
    {"name": "Camel chinos", "category": "chinos", "hex": "#B08245", "family": "camel",
     "neutral": True, "days_since_worn": 21},
    {"name": "Tailored trousers", "category": "tailored_trousers", "hex": "#36393F",
     "family": "charcoal", "neutral": True, "material": ["wool"], "days_since_worn": 14},
    {"name": "Blue jeans", "category": "jeans", "hex": "#4A6FA5", "family": "denim",
     "neutral": True, "material": ["denim"], "days_since_worn": 1},
    {"name": "Linen shorts", "category": "shorts", "hex": "#F5EFE0", "family": "cream",
     "neutral": True, "material": ["linen"], "days_since_worn": 90},
    # one-piece
    {"name": "Black cocktail dress", "category": "cocktail_dress", "hex": "#111111",
     "family": "black", "neutral": True, "material": ["silk"], "days_since_worn": 120},
    # footwear
    {"name": "Brown derbies", "category": "dress_shoes", "hex": "#6B4A2F", "family": "brown",
     "neutral": True, "material": ["leather"], "days_since_worn": 10},
    {"name": "White sneakers", "category": "minimal_sneakers", "hex": "#FFFFFF",
     "family": "white", "neutral": True, "material": ["leather"], "days_since_worn": 1},
    {"name": "Suede sandals", "category": "sandals", "hex": "#B08245", "family": "camel",
     "neutral": True, "material": ["suede"], "days_since_worn": 200},
    # layers
    {"name": "Navy blazer", "category": "blazer", "hex": "#1B2A4A", "family": "navy",
     "neutral": True, "material": ["wool"], "days_since_worn": 25},
    {"name": "Arctic puffer", "category": "puffer", "hex": "#36393F", "family": "charcoal",
     "neutral": True, "material": ["nylon"], "days_since_worn": 300},
    # accessories
    {"name": "Tan leather belt", "category": "belt", "hex": "#B08245", "family": "camel",
     "neutral": True, "material": ["leather"], "days_since_worn": 5},
    {"name": "Black clutch", "category": "clutch", "hex": "#111111", "family": "black",
     "neutral": True, "days_since_worn": 150},
]


@pytest.fixture
def run_vton_worker(settings):
    from workers.vton.runner import build_pipeline, process_once

    pipeline = build_pipeline(settings)

    async def _run(max_batches: int = 10) -> int:
        total = 0
        for _ in range(max_batches):
            handled = await process_once(pipeline, "pytest-vton", settings)
            if handled == 0:
                break
            total += handled
        return total

    return _run


@pytest.fixture
async def body_photo(client):
    """Grant vton consent, upload a body photo, register it. Returns its id."""
    from tests.factories import body_image, sha256

    async def _make(pose: str = "front_full") -> str:
        await client.post("/v1/me/consents", json={
            "consent_type": "vton_processing", "granted": True,
            "policy_version": "privacy-2026-04-01"})
        data = body_image()
        r = await client.post("/v1/uploads/presign", json={
            "purpose": "body_reference",
            "files": [{"filename": "me.jpg", "mime_type": "image/jpeg",
                       "byte_size": len(data), "sha256": sha256(data)}]})
        entry = r.json()["uploads"][0]
        await client.put(entry["upload_url"], content=data,
                         headers={"Content-Type": "image/jpeg"})
        created = await client.post("/v1/me/body-photos",
                                    json={"media_id": entry["media_id"], "pose": pose})
        assert created.status_code == 202, created.text
        return created.json()["id"]

    return _make
