"""FastAPI dependencies: authentication, per-request DB transaction, idempotency."""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Request
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncConnection

from .config import Settings, get_settings
from .db import user_session
from .errors import NotAuthenticated
from .security import Principal, decode_token

SettingsDep = Annotated[Settings, Depends(get_settings)]

# Declared as security schemes rather than plain headers so the interactive docs
# render an Authorize button that applies to every request, instead of making
# the reader paste a header into all 40 endpoints by hand.
bearer_scheme = HTTPBearer(
    scheme_name="Bearer token",
    description="A signed JWT. Its `sub` claim is the user id, and it is the "
                "same claim PostgreSQL row-level security keys on.",
    auto_error=False,
)

debug_user_scheme = APIKeyHeader(
    name="X-Debug-User",
    scheme_name="Debug user (local only)",
    description="A user UUID, accepted **instead of** a token. Works only when "
                "the server sets `SS_ALLOW_DEBUG_USER_HEADER=true`, which the "
                "Docker Compose stack does for local evaluation. It bypasses "
                "signature verification and must never be enabled in a "
                "deployed environment. The compose stack's demo user is "
                "`00000000-0000-4000-8000-000000000001`.",
    auto_error=False,
)


async def current_principal(
    request: Request,
    settings: SettingsDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)] = None,
    debug_user: Annotated[str | None, Depends(debug_user_scheme)] = None,
) -> Principal:
    if settings.allow_debug_user_header and debug_user:
        try:
            return Principal(user_id=UUID(debug_user), claims={"sub": debug_user, "debug": True})
        except ValueError as exc:
            raise NotAuthenticated("X-Debug-User is not a uuid.") from exc

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise NotAuthenticated()
    return decode_token(credentials.credentials.strip(), settings)


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
