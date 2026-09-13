"""Bearer-token authentication.

The JWT ``sub`` claim is the user id, and it is the same value PostgreSQL RLS
keys on — one identity, enforced in two places.
"""
from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

import jwt

from .config import Settings
from .errors import NotAuthenticated


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    claims: dict


def decode_token(token: str, settings: Settings) -> Principal:
    key = settings.jwt_public_key if settings.jwt_algorithm == "RS256" else settings.jwt_secret
    if not key:
        raise NotAuthenticated("Server is not configured to verify tokens.")
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            options={
                "require": ["sub", "exp"],
                "verify_aud": settings.jwt_audience is not None,
                "verify_iss": settings.jwt_issuer is not None,
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise NotAuthenticated("Token has expired.") from exc
    except jwt.InvalidTokenError as exc:
        raise NotAuthenticated("Token is invalid.") from exc

    try:
        user_id = UUID(str(claims["sub"]))
    except (KeyError, ValueError) as exc:
        raise NotAuthenticated("Token subject is not a user id.") from exc

    return Principal(user_id=user_id, claims=claims)


def issue_dev_token(user_id: UUID | str, settings: Settings, ttl_seconds: int = 3600) -> str:
    """HS256 token for local development and tests. Never used in production."""
    import time

    payload = {"sub": str(user_id), "iat": int(time.time()), "exp": int(time.time()) + ttl_seconds}
    if settings.jwt_audience:
        payload["aud"] = settings.jwt_audience
    if settings.jwt_issuer:
        payload["iss"] = settings.jwt_issuer
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
