"""Presigned uploads.

The API reserves a media row and hands back a URL; bytes go straight to object
storage. Re-uploading a file the user already has costs one hash comparison and
no transfer at all.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter

from ..config import Settings
from ..db import execute, fetch_one
from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..errors import InvalidRequest
from ..schemas import PresignedUploadOut, PresignRequest, PresignResponse
from ..storage import get_store

router = APIRouter(prefix="/v1/uploads", tags=["Uploads & Media"])


def _bucket_for(purpose: str, settings: Settings) -> str:
    return {
        "wardrobe": settings.bucket_source,
        "body_reference": settings.bucket_body,
        "avatar": settings.bucket_source,
    }[purpose]


@router.post("/presign", response_model=PresignResponse)
async def presign(body: PresignRequest, conn: ConnDep, principal: PrincipalDep,
                  settings: SettingsDep):
    store = get_store(settings)
    bucket = _bucket_for(body.purpose, settings)
    now = datetime.now(UTC)
    out: list[PresignedUploadOut] = []

    for f in body.files:
        if f.mime_type not in settings.allowed_mime_types:
            raise InvalidRequest(f"Unsupported media type: {f.mime_type}",
                                 allowed=list(settings.allowed_mime_types))
        if f.byte_size > settings.max_upload_bytes:
            raise InvalidRequest(f"{f.filename} exceeds the {settings.max_upload_bytes} byte limit")

        existing = await fetch_one(conn, """
            select id from public.media_assets
             where user_id = :uid and sha256 = :sha and deleted_at is null
        """, {"uid": str(principal.user_id), "sha": f.sha256})
        if existing:
            out.append(PresignedUploadOut(
                media_id=existing["id"], upload_url=None,
                expires_at=now, duplicate_of=existing["id"]))
            continue

        media_id = uuid4()
        ext = {"image/jpeg": "jpg", "image/png": "png",
               "image/heic": "heic", "image/webp": "webp"}[f.mime_type]
        key = f"{principal.user_id}/{now:%Y/%m}/{media_id}.{ext}"

        await execute(conn, """
            insert into public.media_assets
                (id, user_id, bucket, storage_key, mime_type, byte_size, width, height,
                 sha256, source, moderation_status)
            values (:id, :uid, :bucket, :key, :mime, :size, :w, :h, :sha,
                    'manual_upload', 'pending')
        """, {"id": str(media_id), "uid": str(principal.user_id), "bucket": bucket,
              "key": key, "mime": f.mime_type, "size": f.byte_size,
              "w": f.width, "h": f.height, "sha": f.sha256})

        presigned = store.presign_put(
            bucket, key, content_type=f.mime_type,
            max_bytes=settings.max_upload_bytes, ttl=settings.upload_url_ttl_seconds)
        out.append(PresignedUploadOut(
            media_id=media_id, upload_url=presigned.url, method=presigned.method,
            headers=presigned.headers,
            expires_at=now + timedelta(seconds=presigned.expires_in)))

    return PresignResponse(uploads=out)
