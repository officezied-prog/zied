"""Object-storage abstraction.

The API never proxies image bytes: it hands the client a presigned URL and the
client talks to storage directly. Both backends implement the same contract so
tests and local development exercise the real upload flow.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class PresignedUpload:
    url: str
    method: str = "PUT"
    headers: dict[str, str] = field(default_factory=dict)
    expires_in: int = 900


class ObjectStore(Protocol):
    def presign_put(self, bucket: str, key: str, *, content_type: str,
                    max_bytes: int, ttl: int) -> PresignedUpload: ...

    def presign_get(self, bucket: str, key: str, *, ttl: int) -> str: ...

    def put_bytes(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None: ...

    def get_bytes(self, bucket: str, key: str) -> bytes: ...

    def exists(self, bucket: str, key: str) -> bool: ...

    def delete(self, bucket: str, key: str) -> None: ...

    def delete_prefix(self, bucket: str, prefix: str) -> int: ...
