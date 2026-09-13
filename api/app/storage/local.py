"""Filesystem-backed store with HMAC-signed URLs.

Behaves like S3 presigning — signature plus expiry, verified on use — so the
client code path is identical in local development, CI and production.
"""
from __future__ import annotations

import hashlib
import hmac
import shutil
import time
from pathlib import Path
from urllib.parse import quote, urlencode

from .base import ObjectStore, PresignedUpload


class LocalObjectStore(ObjectStore):
    def __init__(self, root: str, public_base_url: str, secret: str) -> None:
        self.root = Path(root)
        self.base_url = public_base_url.rstrip("/")
        self.secret = secret.encode()
        self.root.mkdir(parents=True, exist_ok=True)

    # ── signing ────────────────────────────────────────────────────────────
    def _sign(self, method: str, bucket: str, key: str, expires: int) -> str:
        msg = f"{method}\n{bucket}\n{key}\n{expires}".encode()
        return hmac.new(self.secret, msg, hashlib.sha256).hexdigest()

    def verify(self, method: str, bucket: str, key: str, expires: int, signature: str) -> bool:
        if expires < int(time.time()):
            return False
        return hmac.compare_digest(self._sign(method, bucket, key, expires), signature)

    def _url(self, method: str, bucket: str, key: str, ttl: int) -> tuple[str, int]:
        expires = int(time.time()) + ttl
        qs = urlencode({"expires": expires, "sig": self._sign(method, bucket, key, expires)})
        return f"{self.base_url}/{bucket}/{quote(key)}?{qs}", expires

    # ── contract ───────────────────────────────────────────────────────────
    def presign_put(self, bucket: str, key: str, *, content_type: str,
                    max_bytes: int, ttl: int) -> PresignedUpload:
        url, _ = self._url("PUT", bucket, key, ttl)
        return PresignedUpload(
            url=url, method="PUT",
            headers={"Content-Type": content_type, "X-Max-Bytes": str(max_bytes)},
            expires_in=ttl,
        )

    def presign_get(self, bucket: str, key: str, *, ttl: int) -> str:
        url, _ = self._url("GET", bucket, key, ttl)
        return url

    def _path(self, bucket: str, key: str) -> Path:
        p = (self.root / bucket / key).resolve()
        base = (self.root / bucket).resolve()
        if not str(p).startswith(str(base)):        # path traversal guard
            raise ValueError("invalid storage key")
        return p

    def put_bytes(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None:
        p = self._path(bucket, key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def get_bytes(self, bucket: str, key: str) -> bytes:
        return self._path(bucket, key).read_bytes()

    def exists(self, bucket: str, key: str) -> bool:
        return self._path(bucket, key).is_file()

    def delete(self, bucket: str, key: str) -> None:
        self._path(bucket, key).unlink(missing_ok=True)

    def delete_prefix(self, bucket: str, prefix: str) -> int:
        target = self._path(bucket, prefix)
        if not target.exists():
            return 0
        count = sum(1 for _ in target.rglob("*") if _.is_file())
        shutil.rmtree(target)
        return count
