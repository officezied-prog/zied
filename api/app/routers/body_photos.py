"""Body reference photos — the person image the try-on engine draws onto.

Every operation goes through the SECURITY DEFINER accessors from migration 0015;
the API role has no direct grant on `private.body_reference_photos`.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, status
from sqlalchemy.exc import DBAPIError

from ..db import fetch_all, fetch_one
from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..errors import ConsentRequired, InvalidRequest, NotFound
from ..schemas import BodyPhoto, BodyPhotoCreate
from ..storage import get_store

router = APIRouter(prefix="/v1/me/body-photos", tags=["Consent & Biometrics"])


@router.get("", response_model=list[BodyPhoto])
async def list_body_photos(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep):
    rows = await fetch_all(conn, "select * from public.list_body_photos()")
    store = get_store(settings)
    return [
        BodyPhoto(
            id=r["id"], pose=r["pose"], is_primary=r["is_primary"],
            status=r["prep_status"],
            quality_score=float(r["quality_score"]) if r["quality_score"] is not None else None,
            quality_issues=list(r["quality_issues"] or []),
            # Deliberately the shortest TTL in the system.
            url=store.presign_get(r["bucket"], r["storage_key"],
                                  ttl=settings.body_read_url_ttl_seconds),
            created_at=r["created_at"],
        )
        for r in rows
    ]


@router.post("", response_model=BodyPhoto, status_code=status.HTTP_202_ACCEPTED)
async def create_body_photo(body: BodyPhotoCreate, conn: ConnDep, principal: PrincipalDep,
                            settings: SettingsDep):
    try:
        row = await fetch_one(conn, """
            select public.register_body_photo(:m, :pose, :primary) as id
        """, {"m": str(body.media_id), "pose": body.pose, "primary": body.is_primary})
    except DBAPIError as exc:
        message = str(exc.orig)
        if "consent required" in message:
            raise ConsentRequired("vton_processing") from exc
        if "media asset not found" in message:
            raise NotFound("Media", str(body.media_id)) from exc
        if "invalid pose" in message:
            raise InvalidRequest(f"Invalid pose: {body.pose}") from exc
        raise

    photos = await list_body_photos(conn, principal, settings)
    return next(p for p in photos if p.id == row["id"])


@router.delete("/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_body_photo(photo_id: UUID, conn: ConnDep, principal: PrincipalDep):
    row = await fetch_one(conn, "select public.delete_body_photo(:i) as deleted",
                          {"i": str(photo_id)})
    if not row["deleted"]:
        raise NotFound("Body photo", str(photo_id))
