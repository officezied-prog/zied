"""Async database access.

Two session flavours, and the difference is a security boundary:

* :func:`user_session` runs as the ``authenticated`` role with
  ``app.current_user_id`` set, so **every** statement is filtered by the
  row-level security policies from migration 0008. Request handlers use this.
* :func:`service_session` runs with the pool's own (service) role and bypasses
  RLS. Only workers and webhook processors use it, and they always filter by
  user id explicitly.

Repositories take a connection, never open one. That keeps a whole request in a
single transaction, which is what makes ``SET LOCAL`` correct.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from .config import Settings, get_settings

_engine: AsyncEngine | None = None


def get_engine(settings: Settings | None = None) -> AsyncEngine:
    global _engine
    if _engine is None:
        s = settings or get_settings()
        _engine = create_async_engine(
            s.database_url,
            pool_size=s.db_pool_size,
            max_overflow=s.db_max_overflow,
            pool_pre_ping=True,
            echo=s.debug,
        )
    return _engine


async def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None


@asynccontextmanager
async def user_session(user_id: UUID | str) -> AsyncIterator[AsyncConnection]:
    """Transaction scoped to one user, with RLS enforced."""
    settings = get_settings()
    engine = get_engine(settings)
    async with engine.connect() as conn, conn.begin():
        # set_config(..., true) is LOCAL: it reverts when the transaction ends,
        # so a pooled connection can never leak one user's identity to another.
        await conn.execute(
            text("select set_config('app.current_user_id', :uid, true)"),
            {"uid": str(user_id)},
        )
        await conn.execute(text(f'set local role "{settings.db_request_role}"'))
        yield conn


@asynccontextmanager
async def service_session() -> AsyncIterator[AsyncConnection]:
    """Transaction with the service role — RLS bypassed. Workers only."""
    engine = get_engine()
    async with engine.connect() as conn, conn.begin():
        yield conn


async def fetch_all(conn: AsyncConnection, sql: str, params: dict[str, Any] | None = None):
    return (await conn.execute(text(sql), params or {})).mappings().all()


async def fetch_one(conn: AsyncConnection, sql: str, params: dict[str, Any] | None = None):
    return (await conn.execute(text(sql), params or {})).mappings().first()


async def execute(conn: AsyncConnection, sql: str, params: dict[str, Any] | None = None):
    return await conn.execute(text(sql), params or {})
