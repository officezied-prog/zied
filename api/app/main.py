"""SmartStylist API — application factory."""
from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from .config import Settings, get_settings
from .db import dispose_engine
from .errors import install_error_handlers
from .routers import (
    body_photos,
    detections,
    garments,
    health,
    ingest,
    me,
    outfits,
    storage_dev,
    taxonomy,
    uploads,
    vton,
    wardrobe,
    weather,
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await dispose_engine()


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or get_settings()
    app = FastAPI(
        title="SmartStylist API",
        version="1.0.0-phase2",
        summary="AI smart wardrobe, styling engine and virtual try-on",
        lifespan=lifespan,
        docs_url="/docs" if s.environment != "production" else None,
    )

    @app.middleware("http")
    async def trace_id(request: Request, call_next):
        request.state.trace_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.trace_id
        return response

    install_error_handlers(app)

    for module in (health, me, taxonomy, uploads, ingest, detections, garments,
                   wardrobe, outfits, weather, body_photos, vton):
        app.include_router(module.router)
    if s.storage_backend == "local":
        app.include_router(storage_dev.router)

    return app


app = create_app()
