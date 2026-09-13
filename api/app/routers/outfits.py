"""Styling: recommendations, saved outfits, feedback."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Query, Response, status

from ..db import execute, fetch_all, fetch_one
from ..deps import ConnDep, IdempotencyDep, PrincipalDep, SettingsDep
from ..errors import Conflict, InvalidRequest, NotFound, ProblemError
from ..schemas import (
    Outfit,
    OutfitCreate,
    OutfitFeedback,
    OutfitUpdate,
    RecommendationRequest,
    RecommendationResponse,
    ScoredGarment,
    StyleAndWearRequest,
    StyleAndWearResponse,
    SwapRequest,
    VtonJobCreate,
    Weather,
)
from ..storage import get_store
from ..styling_service import get_engine as get_styling_engine
from .garments import _SELECT, _row_to_garment

router = APIRouter(prefix="/v1/outfits", tags=["Styling"])


class InsufficientWardrobe(ProblemError):
    def __init__(self, occasion: str, missing: list[str]) -> None:
        pretty = ", ".join(m.replace("_", " ") for m in missing)
        detail = (f"Nothing in your wardrobe works as {pretty} for "
                  f"{occasion.replace('_', ' ')}." if missing else
                  f"Your wardrobe cannot produce an outfit for {occasion}.")
        super().__init__(
            status_code=422, title="Not enough items", detail=detail,
            problem_type="insufficient-wardrobe", missing_roles=missing,
        )


@router.post("/recommend", response_model=RecommendationResponse)
async def recommend(body: RecommendationRequest, conn: ConnDep, principal: PrincipalDep,
                    settings: SettingsDep):
    from workers.styling.engine import ENGINE_VERSION, UnknownOccasion
    from workers.styling.weather import Weather as EngineWeather

    engine = get_styling_engine(settings)
    override = EngineWeather(**body.weather_override.model_dump()) if body.weather_override else None

    try:
        result = await engine.recommend(
            conn, principal.user_id,
            occasion=body.occasion,
            lat=body.location.lat if body.location else None,
            lon=body.location.lon if body.location else None,
            at=body.scheduled_for or datetime.now(UTC),
            count=body.count,
            weather_override=override,
            must_include=frozenset(str(g) for g in body.must_include_garment_ids),
            exclude=frozenset(str(g) for g in body.exclude_garment_ids),
        )
    except UnknownOccasion as exc:
        raise InvalidRequest(f"Unknown occasion: {body.occasion}") from exc

    if not result.outfit_ids:
        raise InsufficientWardrobe(body.occasion, result.missing_roles)

    outfits = [await _load_outfit(conn, principal.user_id, oid, settings)
               for oid in result.outfit_ids]
    if not body.explain:
        for o in outfits:
            o.rationale = None

    return RecommendationResponse(
        run_id=result.run_id, engine_version=ENGINE_VERSION,
        weather=Weather(**result.weather.as_dict()) if result.weather else None,
        candidate_count=result.candidate_count, latency_ms=result.latency_ms,
        outfits=outfits,
    )


@router.post("/style-and-wear", response_model=StyleAndWearResponse,
             status_code=status.HTTP_202_ACCEPTED)
async def style_and_wear(body: StyleAndWearRequest, conn: ConnDep,
                         principal: PrincipalDep, settings: SettingsDep,
                         idempotency: IdempotencyDep, response: Response):
    """The whole point of the product, in one call.

    Occasion in; the best outfit the wardrobe can produce, already queued as a
    render on the user's own photo, out. Doing this as one call rather than
    three matters: the alternative makes the client pick a winner, and a client
    that picks differently from the engine produces a picture of an outfit
    nobody recommended.

    Runners-up come back too, so swapping to the second choice needs no
    re-scoring — only a new render.
    """
    from workers.styling.engine import ENGINE_VERSION, UnknownOccasion
    from workers.styling.weather import Weather as EngineWeather

    from .vton import create_job as create_render

    engine = get_styling_engine(settings)
    override = (EngineWeather(**body.weather_override.model_dump())
                if body.weather_override else None)

    try:
        result = await engine.recommend(
            conn, principal.user_id,
            occasion=body.occasion,
            lat=body.location.lat if body.location else None,
            lon=body.location.lon if body.location else None,
            at=body.scheduled_for or datetime.now(UTC),
            count=3,
            weather_override=override,
            exclude=frozenset(str(g) for g in body.exclude_garment_ids),
        )
    except UnknownOccasion as exc:
        raise InvalidRequest(f"Unknown occasion: {body.occasion}") from exc

    if not result.outfit_ids:
        raise InsufficientWardrobe(body.occasion, result.missing_roles)

    outfits = [await _load_outfit(conn, principal.user_id, oid, settings)
               for oid in result.outfit_ids]
    best = outfits[0]

    render = await create_render(
        VtonJobCreate(outfit_id=UUID(str(best.id)), body_photo_id=body.body_photo_id,
                      model_id=body.model_id),
        conn, principal, settings, idempotency, response,
    )
    # create_job sets 200 on a cache hit; a fresh look is still 202.
    if response.status_code == status.HTTP_200_OK and not render.cache_hit:
        response.status_code = status.HTTP_202_ACCEPTED

    _ = ENGINE_VERSION
    return StyleAndWearResponse(
        outfit=best,
        render=render,
        weather=Weather(**result.weather.as_dict()) if result.weather else None,
        alternatives=outfits[1:],
    )


@router.get("")
async def list_outfits(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep,
                       favorite: bool | None = None, occasion: str | None = None,
                       limit: int = Query(20, ge=1, le=100)):
    where = ["o.user_id = :uid", "o.is_archived = false"]
    params: dict = {"uid": str(principal.user_id), "limit": limit}
    if favorite is not None:
        where.append("o.is_favorite = :fav")
        params["fav"] = favorite
    if occasion:
        where.append("oc.slug = :occ")
        params["occ"] = occasion

    rows = await fetch_all(conn, f"""
        select o.id from public.outfits o
          left join public.occasions oc on oc.id = o.occasion_id
         where {' and '.join(where)}
         order by o.created_at desc limit :limit
    """, params)  # noqa: S608 — fragments are literals, values are bound
    items = [await _load_outfit(conn, principal.user_id, r["id"], settings) for r in rows]
    return {"items": items, "next_cursor": None}


@router.post("", response_model=Outfit, status_code=status.HTTP_201_CREATED)
async def create_outfit(body: OutfitCreate, conn: ConnDep, principal: PrincipalDep,
                        settings: SettingsDep):
    garments = await fetch_all(conn, """
        select id, role::text as role from public.garments
         where user_id = :uid and id = any(cast(:ids as uuid[])) and deleted_at is null
    """, {"uid": str(principal.user_id), "ids": [str(i.garment_id) for i in body.items]})
    known = {r["id"]: r["role"] for r in garments}
    if len(known) != len(body.items):
        raise InvalidRequest("One or more garments do not exist in your wardrobe.")

    occasion_id = None
    if body.occasion:
        row = await fetch_one(conn, """
            select id from public.occasions
             where slug = :s and (user_id is null or user_id = :u)
             order by user_id nulls last limit 1
        """, {"s": body.occasion, "u": str(principal.user_id)})
        occasion_id = row["id"] if row else None

    row = await fetch_one(conn, """
        insert into public.outfits (user_id, occasion_id, name, origin, planned_for)
        values (:uid, :oid, :name, 'user', :planned)
        returning id
    """, {"uid": str(principal.user_id), "oid": occasion_id, "name": body.name,
          "planned": body.planned_for})
    outfit_id = row["id"]

    for item in body.items:
        try:
            await execute(conn, """
                insert into public.outfit_items (outfit_id, garment_id, role, layer_order)
                values (:o, :g, cast(:r as public.garment_role), :n)
            """, {"o": str(outfit_id), "g": str(item.garment_id),
                  "r": item.role or known[item.garment_id], "n": item.layer_order})
        except Exception as exc:
            if "outfit_items_single_role" in str(exc):
                raise Conflict("Two garments were given the same single-occupancy role.") from exc
            raise
    return await _load_outfit(conn, principal.user_id, outfit_id, settings)


@router.get("/{outfit_id}", response_model=Outfit)
async def get_outfit(outfit_id: UUID, conn: ConnDep, principal: PrincipalDep,
                     settings: SettingsDep):
    return await _load_outfit(conn, principal.user_id, outfit_id, settings)


@router.patch("/{outfit_id}", response_model=Outfit)
async def update_outfit(outfit_id: UUID, body: OutfitUpdate, conn: ConnDep,
                        principal: PrincipalDep, settings: SettingsDep):
    patch = body.model_dump(exclude_unset=True, exclude_none=True)
    if not patch:
        raise InvalidRequest("Empty patch.")
    allowed = {"name": "name = :name", "is_favorite": "is_favorite = :is_favorite",
               "planned_for": "planned_for = :planned_for",
               "is_archived": "is_archived = :is_archived"}
    sets = [allowed[k] for k in patch if k in allowed]
    params = {k: v for k, v in patch.items() if k in allowed}
    params |= {"id": str(outfit_id), "uid": str(principal.user_id)}
    result = await execute(conn, f"""
        update public.outfits set {', '.join(sets)}
         where id = :id and user_id = :uid
    """, params)  # noqa: S608 — allow-listed fragments only
    if result.rowcount == 0:
        raise NotFound("Outfit", str(outfit_id))
    return await _load_outfit(conn, principal.user_id, outfit_id, settings)


@router.delete("/{outfit_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_outfit(outfit_id: UUID, conn: ConnDep, principal: PrincipalDep):
    result = await execute(conn, """
        update public.outfits set is_archived = true where id = :id and user_id = :uid
    """, {"id": str(outfit_id), "uid": str(principal.user_id)})
    if result.rowcount == 0:
        raise NotFound("Outfit", str(outfit_id))


@router.post("/{outfit_id}/feedback", status_code=status.HTTP_201_CREATED)
async def submit_feedback(outfit_id: UUID, body: OutfitFeedback, conn: ConnDep,
                          principal: PrincipalDep, settings: SettingsDep):
    owned = await fetch_one(conn, "select 1 from public.outfits where id=:i and user_id=:u",
                            {"i": str(outfit_id), "u": str(principal.user_id)})
    if owned is None:
        raise NotFound("Outfit", str(outfit_id))

    await execute(conn, """
        insert into public.outfit_feedback (user_id, outfit_id, kind, reason, garment_id, rating)
        values (:u, :o, cast(:k as public.feedback_kind), :r, :g, :rating)
        on conflict (user_id, outfit_id, kind, garment_id) do update
            set reason = excluded.reason, rating = excluded.rating
    """, {"u": str(principal.user_id), "o": str(outfit_id), "k": body.kind,
          "r": body.reason, "g": str(body.garment_id) if body.garment_id else None,
          "rating": body.rating})

    # "worn" is also a wardrobe fact, not just a preference signal.
    if body.kind == "worn":
        await execute(conn, """
            insert into public.wear_log (user_id, garment_id, outfit_id, worn_on)
            select :u, oi.garment_id, :o, current_date
              from public.outfit_items oi where oi.outfit_id = :o
            on conflict do nothing
        """, {"u": str(principal.user_id), "o": str(outfit_id)})

    engine = get_styling_engine(settings)
    taste_updated = await engine.apply_feedback(conn, principal.user_id, outfit_id, body.kind)
    return {"recorded": True, "taste_updated": taste_updated}


@router.post("/{outfit_id}/swap", response_model=list[ScoredGarment])
async def swap_item(outfit_id: UUID, body: SwapRequest, conn: ConnDep,
                    principal: PrincipalDep, settings: SettingsDep):
    from workers.styling.engine import OutfitNotFound

    engine = get_styling_engine(settings)
    try:
        options = await engine.alternatives(
            conn, principal.user_id, outfit_id, body.role,
            exclude=frozenset(str(g) for g in body.exclude_garment_ids))
    except OutfitNotFound as exc:
        raise NotFound("Outfit", str(outfit_id)) from exc

    out = []
    for candidate, score in options:
        garment = await _garment(conn, principal.user_id, candidate.garment_id, settings)
        out.append(ScoredGarment(garment=garment, score=round(score, 4),
                                 reason=f"scores {score:.2f} in this look"))
    return out


# ── loaders ─────────────────────────────────────────────────────────────────
async def _load_outfit(conn, user_id: UUID, outfit_id: UUID, settings) -> Outfit:
    row = await fetch_one(conn, """
        select o.id, o.name, oc.slug as occasion, o.origin, o.total_score,
               o.score_breakdown, o.rationale, o.formality, o.dominant_colors,
               o.planned_for, o.is_favorite, o.created_at
          from public.outfits o
          left join public.occasions oc on oc.id = o.occasion_id
         where o.id = :id and o.user_id = :uid
    """, {"id": str(outfit_id), "uid": str(user_id)})
    if row is None:
        raise NotFound("Outfit", str(outfit_id))

    item_rows = await fetch_all(conn, f"""
        {_SELECT}
          join public.outfit_items oi on oi.garment_id = g.id
         where oi.outfit_id = :o and g.user_id = :uid
         order by oi.layer_order, oi.role
    """, {"o": str(outfit_id), "uid": str(user_id)})
    roles = {r["garment_id"]: r for r in await fetch_all(
        conn, "select garment_id, role::text as role, layer_order from public.outfit_items "
              "where outfit_id = :o", {"o": str(outfit_id)})}

    store = get_store(settings)
    items = []
    for r in item_rows:
        meta = roles.get(r["id"], {"role": r["role"], "layer_order": 0})
        items.append({"role": meta["role"], "layer_order": meta["layer_order"],
                      "garment": _row_to_garment(r, store, settings)})

    breakdown = row["score_breakdown"]
    if isinstance(breakdown, str):
        breakdown = json.loads(breakdown)

    return Outfit(
        id=row["id"], name=row["name"], occasion=row["occasion"], origin=row["origin"],
        total_score=float(row["total_score"]) if row["total_score"] is not None else None,
        score_breakdown={k: float(v) for k, v in (breakdown or {}).items()},
        rationale=row["rationale"], formality=row["formality"],
        dominant_colors=list(row["dominant_colors"] or []),
        planned_for=row["planned_for"], is_favorite=row["is_favorite"],
        items=items, created_at=row["created_at"],
    )


async def _garment(conn, user_id: UUID, garment_id, settings):
    row = await fetch_one(conn, f"{_SELECT} where g.id = :id and g.user_id = :uid",
                          {"id": str(garment_id), "uid": str(user_id)})
    if row is None:
        raise NotFound("Garment", str(garment_id))
    return _row_to_garment(row, get_store(settings), settings)

