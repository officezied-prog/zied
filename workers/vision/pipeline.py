"""The ingestion pipeline: an uploaded image becomes tagged wardrobe items.

One image in, N garments (or review-queue detections) out:

    normalise -> perceptual hash -> duplicate check -> segment
      -> per instance: quality gate, cutout, colour palette, category mapping
      -> persist detection -> promote to garment when confident and not a dupe

Every inference records the model name and version on the row, so upgrading a
detector means "re-run the rows tagged by the old version", not "re-run
everything and hope".
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from uuid import UUID, uuid4

import numpy as np
from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.config import Settings
from api.app.db import execute, fetch_all, fetch_one
from api.app.storage import ObjectStore

from .color import extract_palette, lab_to_lch, nearest_family
from .images import cutout_png, load_normalised, mask_to_rle, to_grayscale
from .labels import CategoryMapper, build_mapper
from .phash import from_signed_64, hamming, phash, to_signed_64
from .segmenters.base import Segment, SegmentationBackend

log = logging.getLogger("smartstylist.vision")


@dataclass
class ImageResult:
    media_id: UUID
    detections: int = 0
    garments: int = 0
    needs_review: int = 0
    duplicates: int = 0
    skipped_reason: str | None = None
    errors: list[str] = field(default_factory=list)


class VisionPipeline:
    def __init__(self, *, settings: Settings, store: ObjectStore,
                 segmenter: SegmentationBackend) -> None:
        self.settings = settings
        self.store = store
        self.segmenter = segmenter
        self._mapper: CategoryMapper | None = None
        self._families: list[dict] | None = None

    # ── reference data (cached per worker process) ──────────────────────────
    async def _mapper_for(self, conn: AsyncConnection) -> CategoryMapper:
        if self._mapper is None:
            rows = await fetch_all(conn, """
                select id, slug, display_name, level, default_role::text as default_role, synonyms
                  from public.garment_categories
                 where is_active
            """)
            self._mapper = build_mapper(rows)
        return self._mapper

    async def _families_for(self, conn: AsyncConnection) -> list[dict]:
        if self._families is None:
            rows = await fetch_all(
                conn, "select slug, anchor_hex, is_neutral from public.color_families")
            self._families = [dict(r) for r in rows]
        return self._families

    # ── shop mode: identify without keeping ─────────────────────────────────
    async def identify_one(self, conn: AsyncConnection, *, image_bytes: bytes
                           ) -> dict | None:
        """Read one garment out of a photo, and write nothing.

        Shop mode photographs something the user does not own. Running the full
        ingest would file it in their wardrobe, which is exactly wrong: they are
        deciding whether to buy it. This does the same detection, mapping and
        colour work and hands the result back.
        """
        image = load_normalised(image_bytes, max_side=self.settings.max_image_side)
        segments = self.segmenter.segment(image.rgb)
        if not segments:
            return None

        # The subject of a rack photo is the largest confident thing in it.
        segment = max(segments, key=lambda s: s.area_ratio * s.confidence)
        mapper = await self._mapper_for(conn)
        families = await self._families_for(conn)

        match = mapper.map(segment.label)
        palette = extract_palette(
            image.rgb, segment.mask,
            max_colors=self.settings.max_colors_per_garment,
            seed=abs(hash(segment.label)) % 10_000,
        )
        if not palette:
            return None
        colors = [self._describe_color(hex_value, ratio, lab, families)
                  for hex_value, ratio, lab in palette]

        defaults = None
        if match is not None:
            defaults = await fetch_one(conn, """
                select slug, display_name, default_role::text as role,
                       default_formality, default_warmth
                  from public.garment_categories where id = :id
            """, {"id": match.category.id})

        return {
            "category_id": match.category.id if match else None,
            "category": defaults["slug"] if defaults else segment.label,
            "role": defaults["role"] if defaults else "base_top",
            "formality": defaults["default_formality"] if defaults else 3,
            "pattern": segment.attributes.get("pattern", "solid"),
            "label": segment.label,
            "confidence": round(min(segment.confidence,
                                    match.score if match else segment.confidence), 3),
            "colors": colors,
            "area_ratio": round(segment.area_ratio, 4),
        }

    # ── main entry point ────────────────────────────────────────────────────
    async def process_media(
        self, conn: AsyncConnection, *, media_id: UUID, user_id: UUID,
        ingest_job_id: UUID | None = None, auto_accept: bool = True,
    ) -> ImageResult:
        result = ImageResult(media_id=media_id)
        media = await fetch_one(conn, """
            select id, user_id, bucket, storage_key, mime_type, source::text as source
              from public.media_assets
             where id = :id and user_id = :uid and deleted_at is null
        """, {"id": str(media_id), "uid": str(user_id)})
        if media is None:
            result.skipped_reason = "media_not_found"
            return result

        try:
            raw = self.store.get_bytes(media["bucket"], media["storage_key"])
        except Exception as exc:
            result.errors.append(f"storage_read_failed: {exc}")
            return result

        image = load_normalised(raw, max_side=self.settings.max_image_side)
        signed_hash = to_signed_64(phash(to_grayscale(image.rgb)))

        await execute(conn, """
            update public.media_assets
               set width = :w, height = :h, byte_size = :size,
                   sha256 = coalesce(sha256, :sha), phash = :ph, exif_stripped = true
             where id = :id
        """, {"w": image.width, "h": image.height, "size": len(raw),
              "sha": image.sha256, "ph": signed_hash, "id": str(media_id)})

        if await self._is_duplicate_image(conn, user_id, media_id, signed_hash):
            result.skipped_reason = "duplicate_image"
            result.duplicates += 1
            return result

        segments = self.segmenter.segment(image.rgb)
        log.info("media=%s segments=%d backend=%s", media_id, len(segments), self.segmenter.name)

        mapper = await self._mapper_for(conn)
        families = await self._families_for(conn)

        for segment in segments:
            try:
                outcome = await self._process_segment(
                    conn, image=image, segment=segment, media=media, user_id=user_id,
                    ingest_job_id=ingest_job_id, auto_accept=auto_accept,
                    mapper=mapper, families=families,
                )
            except Exception as exc:
                log.exception("segment failed on media %s", media_id)
                result.errors.append(str(exc))
                continue
            result.detections += 1
            if outcome == "garment":
                result.garments += 1
            elif outcome == "review":
                result.needs_review += 1
            elif outcome == "duplicate":
                result.duplicates += 1
        return result

    # ── one detected instance ───────────────────────────────────────────────
    async def _process_segment(
        self, conn: AsyncConnection, *, image, segment: Segment, media, user_id: UUID,
        ingest_job_id: UUID | None, auto_accept: bool,
        mapper: CategoryMapper, families: list[dict],
    ) -> str:
        s = self.settings
        area_ratio = segment.area_ratio
        match = mapper.map(segment.label)

        # Quality gate. Anything that fails goes to the review queue rather than
        # the wardrobe — a wrong item in the closet poisons every later
        # recommendation, while a review card costs one swipe.
        reasons: list[str] = []
        if segment.confidence < s.auto_accept_confidence:
            reasons.append("low_confidence")
        if area_ratio < s.min_area_ratio:
            reasons.append("too_small")
        if segment.attributes.get("occlusion", 0.0) > s.max_occlusion:
            reasons.append("occluded")
        if match is None:
            reasons.append("unmapped_label")

        cutout_id = await self._store_cutout(conn, image=image, segment=segment,
                                             media=media, user_id=user_id)
        palette = extract_palette(
            image.rgb, segment.mask, max_colors=s.max_colors_per_garment,
            seed=abs(hash(segment.label)) % 10_000,
        )
        colors = [
            self._describe_color(hex_value, ratio, lab, families)
            for hex_value, ratio, lab in palette
        ]

        detection_id = uuid4()
        await execute(conn, """
            insert into public.detections
                (id, user_id, media_asset_id, ingest_job_id, detector_model, detector_version,
                 classifier_model, classifier_version, label, category_id, confidence, bbox,
                 mask_rle, cutout_asset_id, area_ratio, attributes, status)
            values (:id, :uid, :media, :job, :dm, :dv, :cm, :cv, :label, :cat, :conf,
                    :bbox, cast(:rle as jsonb), :cutout, :area, cast(:attrs as jsonb), :status)
        """, {
            "id": str(detection_id), "uid": str(user_id), "media": str(media["id"]),
            "job": str(ingest_job_id) if ingest_job_id else None,
            "dm": self.segmenter.name, "dv": self.segmenter.version,
            "cm": s.classifier_model_name, "cv": s.classifier_model_version,
            "label": segment.label, "cat": match.category.id if match else None,
            "conf": round(segment.confidence, 3), "bbox": list(segment.bbox),
            "rle": _json(mask_to_rle(segment.mask)), "cutout": str(cutout_id) if cutout_id else None,
            "area": round(area_ratio, 4),
            "attrs": _json({**segment.attributes,
                            "colors": colors,
                            "mapped_on": match.matched_on if match else None,
                            "mapping_score": match.score if match else None,
                            "gate_failures": reasons}),
            "status": "pending",
        })

        if reasons or not auto_accept:
            return "review"

        assert match is not None
        dupe = await self._duplicate_garment(conn, user_id, match.category.id, colors)
        if dupe:
            await execute(conn, "update public.detections set status='duplicate', garment_id=:g where id=:id",
                          {"g": str(dupe), "id": str(detection_id)})
            return "duplicate"

        garment_id = await self._create_garment(
            conn, user_id=user_id, detection_id=detection_id, media=media,
            cutout_id=cutout_id, match=match, segment=segment, colors=colors,
        )
        await execute(conn, "update public.detections set status='accepted', garment_id=:g where id=:id",
                      {"g": str(garment_id), "id": str(detection_id)})
        return "garment"

    # ── helpers ─────────────────────────────────────────────────────────────
    def _describe_color(self, hex_value: str, ratio: float, lab, families) -> dict:
        family, is_neutral = nearest_family(np.array(lab), families)
        chroma, hue = (float(v) for v in lab_to_lch(np.array(lab)))
        return {"hex": hex_value, "ratio": ratio, "lab": list(lab),
                "lch_c": round(chroma, 3), "lch_h": round(hue, 2),
                "family": family, "is_neutral": is_neutral}

    async def _store_cutout(self, conn, *, image, segment, media, user_id) -> UUID | None:
        try:
            png, w, h = cutout_png(image.rgb, segment.mask)
        except ValueError:
            return None
        cutout_id = uuid4()
        key = f"{user_id}/cutouts/{cutout_id}.png"
        self.store.put_bytes(self.settings.bucket_cutouts, key, png, content_type="image/png")
        await execute(conn, """
            insert into public.media_assets
                (id, user_id, bucket, storage_key, mime_type, byte_size, width, height,
                 source, parent_asset_id, exif_stripped, moderation_status)
            values (:id, :uid, :bucket, :key, 'image/png', :size, :w, :h,
                    'segmentation_output', :parent, true, 'approved')
        """, {"id": str(cutout_id), "uid": str(user_id), "bucket": self.settings.bucket_cutouts,
              "key": key, "size": len(png), "w": w, "h": h, "parent": str(media["id"])})
        return cutout_id

    async def _is_duplicate_image(self, conn, user_id, media_id, signed_hash) -> bool:
        rows = await fetch_all(conn, """
            select id, phash from public.media_assets
             where user_id = :uid and id <> :id and phash is not null
               and source <> 'segmentation_output' and deleted_at is null
             order by created_at desc limit 500
        """, {"uid": str(user_id), "id": str(media_id)})
        target = from_signed_64(signed_hash)
        return any(
            hamming(target, from_signed_64(r["phash"])) <= self.settings.phash_duplicate_distance
            for r in rows
        )

    async def _duplicate_garment(self, conn, user_id, category_id, colors) -> UUID | None:
        """Same category and a primary colour within ΔE2000 5 — the same shirt, twice."""
        if not colors:
            return None
        rows = await fetch_all(conn, """
            select g.id, c.lab_l, c.lab_a, c.lab_b
              from public.garments g
              join public.garment_colors c on c.garment_id = g.id and c.rank = 1
             where g.user_id = :uid and g.category_id = :cat
               and g.deleted_at is null and g.is_archived = false
        """, {"uid": str(user_id), "cat": category_id})
        if not rows:
            return None
        from .color import ciede2000

        target = np.array(colors[0]["lab"], dtype=float)
        for r in rows:
            existing = np.array([float(r["lab_l"]), float(r["lab_a"]), float(r["lab_b"])])
            if float(ciede2000(target, existing)) < 5.0:
                return r["id"]
        return None

    async def _create_garment(self, conn, *, user_id, detection_id, media, cutout_id,
                              match, segment, colors) -> UUID:
        garment_id = uuid4()
        name = _auto_name(colors, match.category.display_name)
        await execute(conn, """
            insert into public.garments
                (id, user_id, category_id, role, source_media_id, cutout_media_id,
                 detection_id, name, pattern, source, auto_tagged, tag_confidence)
            values (:id, :uid, :cat, null, :src, :cut, :det, :name, 'solid',
                    cast(:source as public.media_source), true, :conf)
        """, {"id": str(garment_id), "uid": str(user_id), "cat": match.category.id,
              "src": str(media["id"]), "cut": str(cutout_id) if cutout_id else None,
              "det": str(detection_id), "name": name, "source": media["source"],
              "conf": round(min(segment.confidence, match.score), 3)})

        for rank, c in enumerate(colors, start=1):
            await execute(conn, """
                insert into public.garment_colors
                    (garment_id, rank, hex, ratio, lab_l, lab_a, lab_b, lch_h, lch_c,
                     color_family, is_neutral)
                values (:g, :rank, :hex, :ratio, :l, :a, :b, :h, :c, :fam, :neutral)
            """, {"g": str(garment_id), "rank": rank, "hex": c["hex"], "ratio": c["ratio"],
                  "l": c["lab"][0], "a": c["lab"][1], "b": c["lab"][2],
                  "h": c["lch_h"], "c": c["lch_c"], "fam": c["family"],
                  "neutral": c["is_neutral"]})
        return garment_id


# ── small helpers ───────────────────────────────────────────────────────────
_COLOR_WORDS = {
    "black": "Black", "white": "White", "grey": "Grey", "charcoal": "Charcoal",
    "navy": "Navy", "blue": "Blue", "light_blue": "Light blue", "denim": "Denim",
    "teal": "Teal", "green": "Green", "olive": "Olive", "forest": "Forest",
    "mint": "Mint", "yellow": "Yellow", "mustard": "Mustard", "orange": "Orange",
    "coral": "Coral", "red": "Red", "burgundy": "Burgundy", "pink": "Pink",
    "blush": "Blush", "purple": "Purple", "lavender": "Lavender", "brown": "Brown",
    "camel": "Camel", "beige": "Beige", "cream": "Cream", "gold": "Gold", "silver": "Silver",
}


def _auto_name(colors: list[dict], category_name: str) -> str:
    if not colors:
        return category_name
    word = _COLOR_WORDS.get(colors[0]["family"], colors[0]["family"].replace("_", " ").title())
    return f"{word} {category_name.lower()}"


def _json(value) -> str:
    import json

    return json.dumps(value, default=float)
