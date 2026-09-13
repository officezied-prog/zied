"""FastAPI dependencies: authentication, per-request DB transaction, idempotency."""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncConnection

from .config import Settings, get_settings
from .db import user_session
from .errors import NotAuthenticated
from .security import Principal, decode_token

SettingsDep = Annotated[Settings, Depends(get_settings)]


async def current_principal(
    request: Request,
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
    x_debug_user: Annotated[str | None, Header()] = None,
) -> Principal:
    if settings.allow_debug_user_header and x_debug_user:
        try:
            return Principal(user_id=UUID(x_debug_user), claims={"sub": x_debug_user, "debug": True})
        except ValueError as exc:
            raise NotAuthenticated("X-Debug-User is not a uuid.") from exc

    if not authorization or not authorization.lower().startswith("bearer "):
        raise NotAuthenticated()
    return decode_token(authorization.split(" ", 1)[1].strip(), settings)


PrincipalDep = Annotated[Principal, Depends(current_principal)]


async def db_conn(principal: PrincipalDep) -> AsyncIterator[AsyncConnection]:
    """One transaction per request, pinned to the caller's identity."""
    async with user_session(principal.user_id) as conn:
        yield conn


ConnDep = Annotated[AsyncConnection, Depends(db_conn)]


async def idempotency_key(
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> str | None:
    return idempotency_key


IdempotencyDep = Annotated[str | None, Depends(idempotency_key)]
