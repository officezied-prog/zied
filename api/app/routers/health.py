from __future__ import annotations

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from ..db import get_engine

router = APIRouter(tags=["Ops"])


@router.get("/healthz")
async def healthz():
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(response: Response):
    checks: dict[str, str] = {}
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("select 1"))
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {exc}"
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"checks": checks}
