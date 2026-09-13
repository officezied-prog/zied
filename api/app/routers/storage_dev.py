"""Local-development object store endpoints.

Serves the HMAC-signed PUT/GET URLs that `LocalObjectStore` mints, so the exact
client upload flow used against S3 works with no cloud account. Never mounted
when the storage backend is s3.
"""
from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from ..config import get_settings
from ..errors import InvalidRequest, NotFound
from ..storage import LocalObjectStore, get_store

router = APIRouter(prefix="/_storage", tags=["Ops"], include_in_schema=False)


def _store() -> LocalObjectStore:
    store = get_store()
    if not isinstance(store, LocalObjectStore):
        raise InvalidRequest("Local storage endpoints are disabled.")
    return store


@router.put("/{bucket}/{key:path}", status_code=status.HTTP_200_OK)
async def put_object(bucket: str, key: str, request: Request):
    store = _store()
    expires = int(request.query_params.get("expires", 0))
    sig = request.query_params.get("sig", "")
    if not store.verify("PUT", bucket, key, expires, sig):
        raise InvalidRequest("Upload URL is invalid or has expired.")

    body = await request.body()
    settings = get_settings()
    if len(body) > settings.max_upload_bytes:
        raise InvalidRequest("Payload too large.")
    store.put_bytes(bucket, key, body,
                    content_type=request.headers.get("content-type", "application/octet-stream"))
    return {"bytes": len(body)}


@router.get("/{bucket}/{key:path}")
async def get_object(bucket: str, key: str, request: Request):
    store = _store()
    expires = int(request.query_params.get("expires", 0))
    sig = request.query_params.get("sig", "")
    if not store.verify("GET", bucket, key, expires, sig):
        raise InvalidRequest("Download URL is invalid or has expired.")
    if not store.exists(bucket, key):
        raise NotFound("Object", key)
    return Response(content=store.get_bytes(bucket, key), media_type="application/octet-stream")
