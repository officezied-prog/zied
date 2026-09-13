from __future__ import annotations

from ..config import Settings, get_settings
from .base import ObjectStore, PresignedUpload
from .local import LocalObjectStore
from .s3 import S3ObjectStore

__all__ = [
    "LocalObjectStore",
    "ObjectStore",
    "PresignedUpload",
    "S3ObjectStore",
    "get_store",
    "reset_store",
]


_store: ObjectStore | None = None


def get_store(settings: Settings | None = None) -> ObjectStore:
    """Process-wide singleton. Not lru_cache'd — Settings is a mutable model and
    therefore unhashable, and the store is stateless anyway."""
    global _store
    if _store is None:
        s = settings or get_settings()
        if s.storage_backend == "s3":
            _store = S3ObjectStore(region=s.s3_region, endpoint_url=s.s3_endpoint_url)
        else:
            _store = LocalObjectStore(
                root=s.storage_local_root,
                public_base_url=s.storage_public_base_url,
                secret=s.jwt_secret,
            )
    return _store


def reset_store() -> None:
    """Test hook: drop the cached instance so a new configuration takes effect."""
    global _store
    _store = None
