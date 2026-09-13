"""Runtime configuration. Everything comes from the environment — no secrets in code."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="SS_", extra="ignore")

    environment: Literal["local", "test", "staging", "production"] = "local"
    debug: bool = False

    # ── Database ────────────────────────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://localhost/smartstylist"
    db_pool_size: int = 10
    db_max_overflow: int = 20
    # The role every request runs as. RLS policies are written for it, so the
    # pool's login role must be a member of it (and must NOT be the table owner).
    db_request_role: str = "authenticated"

    # ── Auth ────────────────────────────────────────────────────────────────
    jwt_algorithm: Literal["RS256", "HS256"] = "HS256"
    jwt_secret: str = "dev-only-change-me"  # noqa: S105 — overridden in every real env
    jwt_public_key: str | None = None               # RS256 production
    jwt_issuer: str | None = None
    jwt_audience: str | None = None
    # Local/dev escape hatch: trust an X-Debug-User header instead of a JWT.
    allow_debug_user_header: bool = False

    # ── Storage ─────────────────────────────────────────────────────────────
    storage_backend: Literal["local", "s3"] = "local"
    storage_local_root: str = "/tmp/smartstylist-storage"  # noqa: S108 — local backend only
    storage_public_base_url: str = "http://localhost:8000/_storage"
    s3_region: str = "eu-central-1"
    s3_endpoint_url: str | None = None
    bucket_source: str = "ss-user-source"
    bucket_cutouts: str = "ss-cutouts"
    bucket_body: str = "ss-body"
    bucket_vton: str = "ss-vton"
    bucket_public: str = "ss-public"

    upload_url_ttl_seconds: int = 900        # 15 min
    read_url_ttl_seconds: int = 3600         # 1 h
    body_read_url_ttl_seconds: int = 300     # 5 min — body photos are stricter
    max_upload_bytes: int = 25 * 1024 * 1024
    allowed_mime_types: tuple[str, ...] = (
        "image/jpeg", "image/png", "image/heic", "image/webp",
    )

    # ── Vision pipeline ─────────────────────────────────────────────────────
    segmenter: Literal["stub", "yolo"] = "stub"
    yolo_weights: str = "yolo11x-seg.pt"
    detector_model_name: str = "stub-segmenter"
    detector_model_version: str = "0.1.0"
    classifier_model_name: str = "synonym-mapper"
    classifier_model_version: str = "0.1.0"
    pipeline_version: str = "vision-1.0.0"

    # Promotion thresholds — a detection below any of these goes to review.
    auto_accept_confidence: float = 0.60
    min_area_ratio: float = 0.02
    max_occlusion: float = 0.40
    phash_duplicate_distance: int = 6
    max_colors_per_garment: int = 5
    max_image_side: int = 2048

    # ── Worker ──────────────────────────────────────────────────────────────
    worker_batch_size: int = 8
    worker_poll_interval_s: float = 1.0
    worker_claim_ttl_s: int = 600
    worker_max_attempts: int = 3

    # ── Styling ─────────────────────────────────────────────────────────────
    weather_api_key: str | None = None      # unset -> deterministic static provider
    weather_cache_minutes: int = 60
    recommendation_beam_width: int = 24

    # ── Virtual try-on ──────────────────────────────────────────────────────
    vton_default_model: str = "composite@1"
    vton_batch_size: int = 1
    vton_claim_ttl_s: int = 900
    vton_render_ttl_days: int = 30
    vton_monthly_quota: int = 30
    vton_allow_noncommercial_models: bool = False

    consent_policy_version: str = "privacy-2026-04-01"

    @property
    def sync_database_url(self) -> str:
        return self.database_url.replace("+asyncpg", "")


@lru_cache
def get_settings() -> Settings:
    return Settings()
