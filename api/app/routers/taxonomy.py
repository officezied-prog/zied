"""Reference data. Cacheable, identical for every user."""
from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, Response

from ..db import fetch_all
from ..deps import ConnDep
from ..schemas import Category, ColorFamily

router = APIRouter(prefix="/v1/taxonomy", tags=["Taxonomy"])


def _etag(payload) -> str:
    return '"' + hashlib.sha256(json.dumps(payload, default=str, sort_keys=True).encode()).hexdigest()[:32] + '"'


@router.get("/categories", response_model=list[Category])
async def list_categories(conn: ConnDep, response: Response):
    rows = await fetch_all(conn, """
        select id, parent_id, slug, display_name, level,
               default_role::text as default_role, default_formality, default_warmth, size_system
          from public.garment_categories
         where is_active
         order by level, sort_order, slug
    """)
    data = [dict(r) for r in rows]
    response.headers["ETag"] = _etag(data)
    response.headers["Cache-Control"] = "private, max-age=3600"
    return data


@router.get("/color-families", response_model=list[ColorFamily])
async def list_color_families(conn: ConnDep, response: Response):
    rows = await fetch_all(conn, """
        select slug, display_name, anchor_hex, is_neutral, warm_cool
          from public.color_families order by slug
    """)
    data = [dict(r) for r in rows]
    response.headers["ETag"] = _etag(data)
    return data


@router.get("/occasions")
async def list_occasions(conn: ConnDep):
    rows = await fetch_all(conn, """
        select id, slug, display_name, description, formality_min, formality_max,
               required_roles::text[] as required_roles, icon,
               (user_id is not null) as is_custom
          from public.occasions
         where is_active
         order by sort_order, slug
    """)
    return [dict(r) for r in rows]
