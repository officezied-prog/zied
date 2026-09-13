"""The styling engine.

    retrieve (SQL)  ->  combine (beam search)  ->  score  ->  persist

Stage 1 happens in the database (`public.wardrobe_candidates`) so a 400-item
closet never crosses the wire; stages 2-3 are pure functions over value objects,
which is what makes them testable without a database at all.

Every run writes a `recommendation_runs` row with its inputs, weights and engine
version, so any suggestion can be replayed and any experiment attributed.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID, uuid4

import numpy as np
from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.db import execute, fetch_all, fetch_one

from .combiner import OutfitCombiner
from .embeddings import DIM, Embedder, FeatureEmbedder, update_taste_vector
from .models import Candidate, Look
from .rationale import describe
from .scoring import BASE_WEIGHTS, ColorRules, OccasionContext, UserContext, score_look
from .weather import Weather, WeatherService

log = logging.getLogger("smartstylist.styling")

ENGINE_VERSION = "styling-1.0.0"

# Feedback that should move the taste vector, and in which direction.
POSITIVE_FEEDBACK = frozenset({"like", "save", "worn", "shared", "purchase_intent"})
NEGATIVE_FEEDBACK = frozenset({"dislike", "skip"})


# Roles an outfit cannot be built without.
ESSENTIAL_ROLES: tuple[str, ...] = ("footwear",)
BODY_ROLE_SETS: tuple[tuple[str, ...], ...] = (("base_top", "bottom"), ("full_body",))


@dataclass
class RecommendationResult:
    run_id: UUID
    looks: list[Look]
    weather: Weather | None
    candidate_count: int
    latency_ms: int
    outfit_ids: list[UUID]
    #: Roles the occasion needed for which the wardrobe offered nothing wearable.
    #: Computed, not guessed — it is what the 422 tells the user to go and fix.
    missing_roles: list[str] = field(default_factory=list)


class StylingEngine:
    def __init__(self, *, weather_service: WeatherService | None = None,
                 embedder: Embedder | None = None) -> None:
        self.weather_service = weather_service
        self.embedder = embedder or FeatureEmbedder()
        self._color_rules: ColorRules | None = None

    # ── reference data ──────────────────────────────────────────────────────
    async def color_rules(self, conn: AsyncConnection) -> ColorRules:
        if self._color_rules is None:
            families = {
                r["slug"]: dict(r)
                for r in await fetch_all(conn, """
                    select slug, anchor_hex, is_neutral, is_hero, warm_cool
                      from public.color_families
                """)
            }
            pairs = {
                (r["family_a"], r["family_b"]): (float(r["score"]), r["harmony"])
                for r in await fetch_all(conn, """
                    select family_a, family_b, score, harmony::text as harmony
                      from public.color_pair_rules
                """)
            }
            affinity = {
                (r["palette"], r["family"]): float(r["affinity"])
                for r in await fetch_all(conn, """
                    select palette::text as palette, family, affinity
                      from public.palette_affinity
                """)
            }
            self._color_rules = ColorRules(families=families, pairs=pairs,
                                           palette_affinity=affinity)
        return self._color_rules

    async def load_occasion(self, conn: AsyncConnection, slug: str,
                            user_id: UUID) -> OccasionContext | None:
        row = await fetch_one(conn, """
            select id, slug, formality_min, formality_max,
                   required_roles::text[] as required_roles,
                   optional_roles::text[] as optional_roles,
                   banned_roles::text[]   as banned_roles,
                   banned_categories, banned_patterns::text[] as banned_patterns,
                   scoring_weights
              from public.occasions
             where slug = :slug and (user_id is null or user_id = :uid) and is_active
             order by user_id nulls last
             limit 1
        """, {"slug": slug, "uid": str(user_id)})
        if row is None:
            return None
        ctx = OccasionContext(
            slug=row["slug"],
            formality_min=row["formality_min"], formality_max=row["formality_max"],
            required_roles=tuple(row["required_roles"] or ()),
            optional_roles=tuple(row["optional_roles"] or ()),
            banned_roles=frozenset(row["banned_roles"] or ()),
            banned_categories=frozenset(row["banned_categories"] or ()),
            banned_patterns=frozenset(row["banned_patterns"] or ()),
            weights={k: float(v) for k, v in (row["scoring_weights"] or {}).items()
                     if k in BASE_WEIGHTS},
        )
        ctx.occasion_id = row["id"]                      # type: ignore[attr-defined]
        return ctx

    async def load_user_context(self, conn: AsyncConnection, user_id: UUID) -> UserContext:
        prefs = await fetch_one(conn, """
            select style_archetypes, preferred_colors, avoided_colors, avoided_categories,
                   avoided_patterns::text[] as avoided_patterns, favourite_brands,
                   modesty_rules
              from public.style_preferences where user_id = :uid
        """, {"uid": str(user_id)})

        # Biometrics only through the audited accessor, and only with consent.
        palette = body_shape = None
        bio = await fetch_one(conn, """
            select (public.get_biometric_profile(:uid)).seasonal_palette::text as palette,
                   (public.get_biometric_profile(:uid)).body_shape::text       as body_shape
        """, {"uid": str(user_id)})
        if bio:
            palette, body_shape = bio["palette"], bio["body_shape"]

        taste = await fetch_one(conn, """
            select taste_vector::text as vec from public.user_style_embeddings
             where user_id = :uid and model = :model
        """, {"uid": str(user_id), "model": self.embedder.name})

        return UserContext(
            seasonal_palette=palette if palette and palette != "unspecified" else None,
            body_shape=body_shape if body_shape and body_shape != "unspecified" else None,
            taste_vector=_parse_vector(taste["vec"]) if taste else None,
            preferred_colors=tuple((prefs or {}).get("preferred_colors") or ()),
            avoided_colors=tuple((prefs or {}).get("avoided_colors") or ()),
            avoided_categories=frozenset((prefs or {}).get("avoided_categories") or ()),
            avoided_patterns=frozenset((prefs or {}).get("avoided_patterns") or ()),
            favourite_brands=frozenset((prefs or {}).get("favourite_brands") or ()),
            modesty_rules=(prefs or {}).get("modesty_rules") or {},
        )

    # ── candidates ──────────────────────────────────────────────────────────
    async def load_candidates(self, conn: AsyncConnection, user_id: UUID, *,
                              occasion: str, weather: Weather | None,
                              exclude: frozenset[str] = frozenset(),
                              limit: int = 400) -> list[Candidate]:
        rows = await fetch_all(conn, """
            select c.*, g.name, g.material, g.is_layerable, cat.slug as category
              from public.wardrobe_candidates(:uid, :occ, :temp, :precip, null, :limit) c
              join public.garments g on g.id = c.garment_id
              join public.garment_categories cat on cat.id = c.category_id
        """, {"uid": str(user_id), "occ": occasion,
              "temp": weather.effective_temp_c if weather else None,
              "precip": weather.precip_prob if weather else 0,
              "limit": limit})

        candidates = [
            Candidate(
                garment_id=r["garment_id"], role=str(r["role"]), category_id=r["category_id"],
                category=r["category"], formality=r["formality"], warmth=r["warmth"],
                pattern=str(r["pattern"]), material=list(r["material"] or []),
                is_layerable=bool(r["is_layerable"]), primary_hex=r["primary_hex"],
                color_family=r["color_family"],
                lab=None, lch_h=float(r["lch_h"]) if r["lch_h"] is not None else None,
                lch_c=float(r["lch_c"]) if r["lch_c"] is not None else None,
                is_neutral=bool(r["is_neutral"]), wear_count=r["wear_count"],
                days_since_worn=r["days_since_worn"], name=r["name"],
            )
            for r in rows
            if str(r["garment_id"]) not in exclude
        ]
        await self._attach_lab(conn, candidates)
        await self._attach_embeddings(conn, user_id, candidates)
        return candidates

    async def _attach_lab(self, conn: AsyncConnection, candidates: list[Candidate]) -> None:
        if not candidates:
            return
        rows = await fetch_all(conn, """
            select garment_id, lab_l, lab_a, lab_b from public.garment_colors
             where garment_id = any(cast(:ids as uuid[])) and rank = 1
        """, {"ids": [str(c.garment_id) for c in candidates]})
        lab = {r["garment_id"]: (float(r["lab_l"]), float(r["lab_a"]), float(r["lab_b"]))
               for r in rows}
        for c in candidates:
            c.lab = lab.get(c.garment_id)

    async def _attach_embeddings(self, conn: AsyncConnection, user_id: UUID,
                                 candidates: list[Candidate]) -> None:
        if not candidates:
            return
        rows = await fetch_all(conn, """
            select garment_id, image_embedding::text as vec
              from public.garment_embeddings
             where garment_id = any(cast(:ids as uuid[])) and model = :model
        """, {"ids": [str(c.garment_id) for c in candidates], "model": self.embedder.name})
        known = {r["garment_id"]: _parse_vector(r["vec"]) for r in rows}

        missing: list[Candidate] = []
        for c in candidates:
            if c.garment_id in known:
                c.embedding = known[c.garment_id]
            else:
                c.embedding = self.embedder.embed(_as_feature_dict(c))
                missing.append(c)

        for c in missing:                        # backfill so the next run is a read
            await execute(conn, """
                insert into public.garment_embeddings
                    (garment_id, user_id, model, model_version, image_embedding)
                values (:g, :u, :m, :v, cast(:vec as vector))
                on conflict (garment_id) do update
                    set image_embedding = excluded.image_embedding,
                        model = excluded.model, model_version = excluded.model_version
            """, {"g": str(c.garment_id), "u": str(user_id), "m": self.embedder.name,
                  "v": self.embedder.version, "vec": _format_vector(c.embedding)})

    # ── main entry point ────────────────────────────────────────────────────
    async def recommend(self, conn: AsyncConnection, user_id: UUID, *, occasion: str,
                        lat: float | None = None, lon: float | None = None,
                        at: datetime | None = None, count: int = 5,
                        weather_override: Weather | None = None,
                        must_include: frozenset[str] = frozenset(),
                        exclude: frozenset[str] = frozenset(),
                        persist: bool = True) -> RecommendationResult:
        started = time.perf_counter()
        at = at or datetime.now(UTC)

        occ = await self.load_occasion(conn, occasion, user_id)
        if occ is None:
            raise UnknownOccasion(occasion)

        weather, snapshot_id = weather_override, None
        if weather is None and self.weather_service and lat is not None and lon is not None:
            weather, snapshot_id = await self.weather_service.resolve(conn, lat, lon, at)

        rules = await self.color_rules(conn)
        user = await self.load_user_context(conn, user_id)
        candidates = await self.load_candidates(conn, user_id, occasion=occasion,
                                                weather=weather, exclude=exclude)

        combiner = OutfitCombiner(occasion=occ, weather=weather, rules=rules, user=user)
        looks = combiner.build(candidates, count=count, must_include=must_include)
        missing = _missing_roles(candidates, occ) if not looks else []
        for look in looks:
            look.rationale = describe(look, occasion=occ, weather=weather, rules=rules)

        latency = int((time.perf_counter() - started) * 1000)
        run_id = uuid4()
        outfit_ids: list[UUID] = []

        if persist:
            await execute(conn, """
                insert into public.recommendation_runs
                    (id, user_id, occasion_id, occasion_slug, scheduled_for, geohash5,
                     weather_snapshot_id, engine_version, strategy, weights, filters,
                     candidate_count, returned_count, latency_ms, status)
                values (:id, :uid, :oid, :slug, :at, :cell, :snap, :ver, 'hybrid',
                        cast(:weights as jsonb), cast(:filters as jsonb),
                        :cand, :ret, :ms, 'succeeded')
            """, {"id": str(run_id), "uid": str(user_id),
                  "oid": getattr(occ, "occasion_id", None), "slug": occ.slug, "at": at,
                  "cell": _cell(lat, lon), "snap": snapshot_id, "ver": ENGINE_VERSION,
                  "weights": _json({k: occ.weight(k) for k in BASE_WEIGHTS}),
                  "filters": _json({"exclude": sorted(exclude),
                                    "must_include": sorted(must_include)}),
                  "cand": len(candidates), "ret": len(looks), "ms": latency})
            for look in looks:
                outfit_ids.append(await self._persist_look(
                    conn, user_id, look, run_id=run_id, occasion=occ,
                    snapshot_id=snapshot_id))

        return RecommendationResult(run_id=run_id, looks=looks, weather=weather,
                                    candidate_count=len(candidates), latency_ms=latency,
                                    outfit_ids=outfit_ids, missing_roles=missing)

    async def _persist_look(self, conn: AsyncConnection, user_id: UUID, look: Look, *,
                            run_id: UUID, occasion: OccasionContext,
                            snapshot_id: int | None) -> UUID:
        outfit_id = uuid4()
        colours = [c.primary_hex for c in look.garments if c.primary_hex][:5]
        await execute(conn, """
            insert into public.outfits
                (id, user_id, recommendation_run_id, occasion_id, origin, total_score,
                 score_breakdown, rationale, weather_snapshot_id, formality, dominant_colors)
            values (:id, :uid, :run, :oid, 'ai', :score, cast(:breakdown as jsonb),
                    :why, :snap, :form, cast(:colors as char(7)[]))
        """, {"id": str(outfit_id), "uid": str(user_id), "run": str(run_id),
              "oid": getattr(occasion, "occasion_id", None), "score": look.score,
              "breakdown": _json(look.breakdown), "why": look.rationale,
              "snap": snapshot_id, "form": round(look.mean_formality),
              "colors": colours})

        for order, (role, candidate) in enumerate(look.items.items()):
            await execute(conn, """
                insert into public.outfit_items (outfit_id, garment_id, role, layer_order)
                values (:o, :g, cast(:r as public.garment_role), :n)
            """, {"o": str(outfit_id), "g": str(candidate.garment_id), "r": role,
                  "n": _layer_order(role, order)})

        vectors = [c.embedding for c in look.garments if c.embedding is not None]
        if vectors:
            await execute(conn, """
                insert into public.outfit_embeddings (outfit_id, user_id, embedding)
                values (:o, :u, cast(:vec as vector))
                on conflict (outfit_id) do update set embedding = excluded.embedding
            """, {"o": str(outfit_id), "u": str(user_id),
                  "vec": _format_vector(np.mean(vectors, axis=0))})
        return outfit_id

    # ── swap one slot ───────────────────────────────────────────────────────
    async def alternatives(self, conn: AsyncConnection, user_id: UUID, outfit_id: UUID,
                           role: str, *, exclude: frozenset[str] = frozenset(),
                           limit: int = 5) -> list[tuple[Candidate, float]]:
        outfit = await fetch_one(conn, """
            select o.id, coalesce(oc.slug, 'casual_gathering') as occasion_slug,
                   o.weather_snapshot_id
              from public.outfits o
              left join public.occasions oc on oc.id = o.occasion_id
             where o.id = :id and o.user_id = :uid
        """, {"id": str(outfit_id), "uid": str(user_id)})
        if outfit is None:
            raise OutfitNotFound(str(outfit_id))

        occ = await self.load_occasion(conn, outfit["occasion_slug"], user_id)
        rules = await self.color_rules(conn)
        user = await self.load_user_context(conn, user_id)
        weather = await self._weather_for_snapshot(conn, outfit["weather_snapshot_id"])

        current = await fetch_all(conn, """
            select garment_id, role::text as role from public.outfit_items
             where outfit_id = :o
        """, {"o": str(outfit_id)})
        keep_ids = [str(r["garment_id"]) for r in current if r["role"] != role]

        pool = await self.load_candidates(conn, user_id, occasion=outfit["occasion_slug"],
                                          weather=weather, exclude=exclude)
        fixed = {c.role: c for c in pool if str(c.garment_id) in keep_ids}
        options = [c for c in pool if c.role == role and str(c.garment_id) not in exclude]

        scored: list[tuple[Candidate, float]] = []
        for option in options:
            look = Look(items={**fixed, role: option})
            score_look(look, occasion=occ, weather=weather, rules=rules, user=user)
            scored.append((option, look.score))
        return sorted(scored, key=lambda t: -t[1])[:limit]

    async def _weather_for_snapshot(self, conn: AsyncConnection,
                                    snapshot_id: int | None) -> Weather | None:
        if snapshot_id is None:
            return None
        from .weather import _from_row

        row = await fetch_one(conn, "select * from public.weather_snapshots where id = :i",
                              {"i": snapshot_id})
        return _from_row(row) if row else None

    # ── feedback ────────────────────────────────────────────────────────────
    async def apply_feedback(self, conn: AsyncConnection, user_id: UUID, outfit_id: UUID,
                             kind: str) -> bool:
        """Move the taste vector. Returns True when the vector actually changed."""
        if kind not in POSITIVE_FEEDBACK and kind not in NEGATIVE_FEEDBACK:
            return False

        row = await fetch_one(conn, """
            select embedding::text as vec from public.outfit_embeddings
             where outfit_id = :o and user_id = :u
        """, {"o": str(outfit_id), "u": str(user_id)})
        if row is None:
            return False

        sample = _parse_vector(row["vec"])
        existing = await fetch_one(conn, """
            select taste_vector::text as vec, sample_count
              from public.user_style_embeddings where user_id = :u and model = :m
        """, {"u": str(user_id), "m": self.embedder.name})

        updated = update_taste_vector(
            _parse_vector(existing["vec"]) if existing else None,
            sample, liked=kind in POSITIVE_FEEDBACK)

        await execute(conn, """
            insert into public.user_style_embeddings
                (user_id, model, model_version, taste_vector, sample_count, updated_at)
            values (:u, :m, :v, cast(:vec as vector), 1, now())
            on conflict (user_id) do update
                set taste_vector = excluded.taste_vector,
                    sample_count = public.user_style_embeddings.sample_count + 1,
                    model = excluded.model, model_version = excluded.model_version,
                    updated_at = now()
        """, {"u": str(user_id), "m": self.embedder.name, "v": self.embedder.version,
              "vec": _format_vector(updated)})
        return True


# ── errors ──────────────────────────────────────────────────────────────────
class UnknownOccasion(Exception):
    pass


class OutfitNotFound(Exception):
    pass


# ── helpers ─────────────────────────────────────────────────────────────────
def _missing_roles(candidates: list[Candidate], occasion: OccasionContext) -> list[str]:
    """Which required slots the wardrobe could not fill for this occasion.

    Only counts garments that survived every filter — formality band, weather,
    bans — so the answer is "nothing you own works here", which is actionable,
    rather than "nothing found", which is not.
    """
    available = {c.role for c in candidates}
    missing = [r for r in (*ESSENTIAL_ROLES, *occasion.required_roles)
               if r not in available]
    if not any(set(group) <= available for group in BODY_ROLE_SETS):
        missing.extend(r for r in ("base_top", "bottom") if r not in available)
    # Preserve order, drop repeats.
    return list(dict.fromkeys(missing))


def _as_feature_dict(c: Candidate) -> dict:
    return {"lab": c.lab, "lch_h": c.lch_h, "lch_c": c.lch_c, "is_neutral": c.is_neutral,
            "formality": c.formality, "warmth": c.warmth, "is_layerable": c.is_layerable,
            "role": c.role, "category": c.category, "pattern": c.pattern,
            "material": c.material}


def _parse_vector(text: str | None) -> np.ndarray | None:
    if not text:
        return None
    return np.fromstring(text.strip("[]"), sep=",", dtype=np.float32)


def _format_vector(vec: np.ndarray) -> str:
    if len(vec) != DIM:
        raise ValueError(f"expected a {DIM}-d vector, got {len(vec)}")
    return "[" + ",".join(f"{float(x):.6g}" for x in vec) + "]"


def _layer_order(role: str, fallback: int) -> int:
    return {"base_top": 0, "bottom": 0, "full_body": 0,
            "mid_layer": 1, "outerwear": 2, "footwear": 0}.get(role, fallback + 3)


def _cell(lat: float | None, lon: float | None) -> str | None:
    if lat is None or lon is None:
        return None
    from .geo import geohash_encode

    return geohash_encode(lat, lon, 5)


def _json(value) -> str:
    import json

    return json.dumps(value, default=float)
