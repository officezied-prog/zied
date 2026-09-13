"""Request/response models. Mirrors api/openapi/openapi.yaml for the Phase-2 surface."""
from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

Hex = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
Sha256 = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


# ── account & consent ───────────────────────────────────────────────────────
class User(Model):
    id: UUID
    email: str | None = None
    display_name: str | None = None
    locale: str = "en"
    country_code: str | None = None
    timezone: str = "UTC"
    units: Literal["metric", "imperial"] = "metric"
    onboarding_stage: str = "created"
    created_at: datetime


class ConsentDecision(Model):
    consent_type: Literal[
        "terms_of_service", "privacy_policy", "biometric_processing",
        "social_ingest", "vton_processing", "model_training", "marketing",
    ]
    granted: bool
    policy_version: str


class ConsentState(Model):
    consent_type: str
    granted: bool
    policy_version: str
    decided_at: datetime


# ── uploads & media ─────────────────────────────────────────────────────────
class UploadFile(Model):
    filename: str
    mime_type: str
    byte_size: int = Field(gt=0)
    sha256: Sha256
    width: int | None = None
    height: int | None = None


class PresignRequest(Model):
    purpose: Literal["wardrobe", "body_reference", "avatar"] = "wardrobe"
    files: list[UploadFile] = Field(min_length=1, max_length=50)


class PresignedUploadOut(Model):
    media_id: UUID
    upload_url: str | None
    method: str = "PUT"
    headers: dict[str, str] = Field(default_factory=dict)
    expires_at: datetime
    duplicate_of: UUID | None = None


class PresignResponse(Model):
    uploads: list[PresignedUploadOut]


class Media(Model):
    id: UUID
    url: str | None = None
    mime_type: str
    width: int | None = None
    height: int | None = None
    source: str
    moderation_status: str
    created_at: datetime


# ── ingestion ───────────────────────────────────────────────────────────────
class IngestJobCreate(Model):
    media_ids: list[UUID] = Field(min_length=1, max_length=200)
    auto_accept: bool = True


class IngestJob(Model):
    id: UUID
    source: str
    status: str
    items_discovered: int = 0
    items_processed: int = 0
    items_failed: int = 0
    garments_created: int = 0
    needs_review: int = 0
    poll_after_ms: int = 2000
    error_code: str | None = None
    queued_at: datetime
    finished_at: datetime | None = None


# ── taxonomy ────────────────────────────────────────────────────────────────
class Category(Model):
    id: int
    parent_id: int | None
    slug: str
    display_name: str
    level: int
    default_role: str
    default_formality: int
    default_warmth: int
    size_system: str | None = None


class ColorFamily(Model):
    slug: str
    display_name: str
    anchor_hex: str
    is_neutral: bool
    warm_cool: str | None = None


# ── wardrobe ────────────────────────────────────────────────────────────────
class GarmentColor(Model):
    hex: str
    ratio: float
    color_family: str
    is_neutral: bool


class Garment(Model):
    id: UUID
    category: str
    category_id: int
    role: str
    name: str | None
    brand: str | None
    pattern: str
    material: list[str] = Field(default_factory=list)
    fit: str
    size_label: str | None = None
    formality: int
    warmth: int
    seasons: list[str] = Field(default_factory=list)
    occasion_tags: list[str] = Field(default_factory=list)
    colors: list[GarmentColor] = Field(default_factory=list)
    image_url: str | None = None
    cutout_url: str | None = None
    ownership: str
    in_laundry: bool
    wear_count: int
    last_worn_at: date | None = None
    auto_tagged: bool
    user_verified: bool
    tag_confidence: float | None = None
    created_at: datetime


class GarmentCreate(Model):
    category_id: int
    media_id: UUID | None = None
    name: str | None = None
    brand: str | None = None
    pattern: str = "solid"
    material: list[str] = Field(default_factory=list)
    size_label: str | None = None
    formality: int | None = Field(default=None, ge=1, le=5)
    warmth: int | None = Field(default=None, ge=0, le=5)
    seasons: list[str] | None = None
    purchase_price: float | None = None
    purchase_currency: str | None = None
    ownership: str = "owned"


class GarmentUpdate(Model):
    category_id: int | None = None
    name: str | None = None
    brand: str | None = None
    pattern: str | None = None
    material: list[str] | None = None
    size_label: str | None = None
    formality: int | None = Field(default=None, ge=1, le=5)
    warmth: int | None = Field(default=None, ge=0, le=5)
    seasons: list[str] | None = None
    in_laundry: bool | None = None
    is_archived: bool | None = None
    user_verified: bool | None = None
    condition: int | None = Field(default=None, ge=1, le=5)
    ownership: str | None = None

    @field_validator("material", "seasons")
    @classmethod
    def _no_empty_strings(cls, v: list[str] | None) -> list[str] | None:
        return [s for s in v if s.strip()] if v is not None else None


class BulkGarmentUpdate(Model):
    ids: list[UUID] = Field(min_length=1, max_length=200)
    patch: GarmentUpdate


class Detection(Model):
    id: UUID
    media_id: UUID
    cutout_url: str | None
    label: str
    suggested_category: str | None
    suggested_category_id: int | None
    confidence: float
    bbox: list[float]
    colors: list[dict[str, Any]] = Field(default_factory=list)
    gate_failures: list[str] = Field(default_factory=list)
    status: str


class Page(Model):
    items: list[Any]
    next_cursor: str | None = None


# ── styling (Phase 3) ───────────────────────────────────────────────────────
class Weather(Model):
    temp_c: float
    feels_like_c: float | None = None
    temp_min_c: float | None = None
    temp_max_c: float | None = None
    humidity_pct: int | None = None
    wind_kph: float | None = None
    precip_prob: float = 0.0
    uv_index: float | None = None
    condition: str | None = None
    is_daylight: bool | None = None
    valid_at: datetime | None = None


class LatLon(Model):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class RecommendationRequest(Model):
    occasion: str
    scheduled_for: datetime | None = None
    location: LatLon | None = None
    weather_override: Weather | None = None
    count: int = Field(default=5, ge=1, le=20)
    must_include_garment_ids: list[UUID] = Field(default_factory=list)
    exclude_garment_ids: list[UUID] = Field(default_factory=list)
    explain: bool = True
    strategy: Literal["rules", "embedding", "hybrid", "llm_reranked"] = "hybrid"


class OutfitItem(Model):
    role: str
    layer_order: int
    garment: Garment


class Outfit(Model):
    id: UUID
    name: str | None = None
    occasion: str | None = None
    origin: str
    total_score: float | None = None
    score_breakdown: dict[str, float] = Field(default_factory=dict)
    rationale: str | None = None
    formality: int | None = None
    dominant_colors: list[str] = Field(default_factory=list)
    planned_for: date | None = None
    is_favorite: bool = False
    items: list[OutfitItem] = Field(default_factory=list)
    created_at: datetime


class RecommendationResponse(Model):
    run_id: UUID
    engine_version: str
    weather: Weather | None = None
    candidate_count: int
    latency_ms: int
    outfits: list[Outfit]


class OutfitItemCreate(Model):
    garment_id: UUID
    role: str | None = None
    layer_order: int = 0


class OutfitCreate(Model):
    name: str | None = None
    occasion: str | None = None
    planned_for: date | None = None
    items: list[OutfitItemCreate] = Field(min_length=1)


class OutfitUpdate(Model):
    name: str | None = None
    is_favorite: bool | None = None
    planned_for: date | None = None
    is_archived: bool | None = None


class OutfitFeedback(Model):
    kind: Literal["like", "dislike", "save", "worn", "skip", "shared", "purchase_intent"]
    reason: str | None = None
    garment_id: UUID | None = None
    rating: int | None = Field(default=None, ge=1, le=5)


class SwapRequest(Model):
    role: str
    exclude_garment_ids: list[UUID] = Field(default_factory=list)


class ScoredGarment(Model):
    garment: Garment
    score: float
    reason: str | None = None


# ── virtual try-on (Phase 4) ────────────────────────────────────────────────
class BodyPhoto(Model):
    id: UUID
    pose: str
    is_primary: bool
    status: str
    quality_score: float | None = None
    quality_issues: list[str] = Field(default_factory=list)
    url: str | None = None
    created_at: datetime


class BodyPhotoCreate(Model):
    media_id: UUID
    pose: Literal["front_full", "front_half", "side", "back", "custom"] = "front_full"
    is_primary: bool = True


class VtonModel(Model):
    id: str
    display_name: str
    family: str
    supports_roles: list[str] = Field(default_factory=list)
    supports_multi_garment: bool
    avg_latency_ms: int | None = None
    available_to_user: bool


class VtonParams(Model):
    steps: int | None = Field(default=None, ge=10, le=60)
    guidance: float | None = None
    seed: int | None = None
    preserve_face: bool = True


class VtonJobCreate(Model):
    outfit_id: UUID | None = None
    garment_ids: list[UUID] = Field(default_factory=list, max_length=5)
    body_photo_id: UUID | None = None
    model_id: str | None = None
    params: VtonParams = Field(default_factory=VtonParams)

    @field_validator("garment_ids")
    @classmethod
    def _dedupe(cls, v: list[UUID]) -> list[UUID]:
        return list(dict.fromkeys(v))


class VtonJob(Model):
    id: UUID
    status: str
    model_id: str
    outfit_id: UUID | None = None
    garment_ids: list[UUID] = Field(default_factory=list)
    pass_index: int = 0
    total_passes: int = 1
    queue_position: int | None = None
    poll_after_ms: int = 3000
    result_url: str | None = None
    qa_score: float | None = None
    qa_flags: list[str] = Field(default_factory=list)
    duration_ms: int | None = None
    error_code: str | None = None
    expires_at: datetime | None = None
    queued_at: datetime
    cache_hit: bool = False


# ── wardrobe advice & one-call styling (Phase 6) ────────────────────────────
class OccasionCoverage(Model):
    slug: str
    display_name: str
    wearable: bool
    missing_roles: list[str] = Field(default_factory=list)
    option_count: int


class ColorOpportunity(Model):
    family: str
    pairs_with: int
    coverage: float
    is_neutral: bool


class Suggestion(Model):
    role: str
    color_family: str | None = None
    reason: str
    blocking: bool
    price_low: float | None = None
    price_high: float | None = None
    currency: str = "USD"


class WardrobeAdvice(Model):
    headline: str
    tone: Literal["use_what_you_have", "essentials_only", "suggest_gaps",
                  "suggest_upgrades"]
    coverage: list[OccasionCoverage] = Field(default_factory=list)
    color_opportunities: list[ColorOpportunity] = Field(default_factory=list)
    suggestions: list[Suggestion] = Field(default_factory=list)
    #: Why the advice reads the way it does. Never a label for the person.
    basis: str


class StyleAndWearRequest(Model):
    occasion: str
    scheduled_for: datetime | None = None
    location: LatLon | None = None
    weather_override: Weather | None = None
    body_photo_id: UUID | None = None
    model_id: str | None = None
    exclude_garment_ids: list[UUID] = Field(default_factory=list)


class StyleAndWearResponse(Model):
    outfit: Outfit
    render: VtonJob
    weather: Weather | None = None
    alternatives: list[Outfit] = Field(default_factory=list)


# ── shop mode (Phase 7) ─────────────────────────────────────────────────────
Verdict = Literal["fills_a_gap", "adds_variety", "have_similar", "hard_to_wear"]


class ScanRequest(Model):
    media_id: UUID
    #: Override the detected role when the camera reads it wrong on a hanger.
    role: str | None = None


class OwnedMatch(Model):
    """A piece already in the wardrobe that is close enough to be the same buy."""
    garment_id: UUID
    name: str
    hex: str
    delta_e: float


class WearWith(Model):
    """A piece already at home that this would go with."""
    garment_id: UUID
    name: str
    role: str
    hex: str
    score: float


class ScanResult(Model):
    scan_id: UUID
    category: str
    role: str
    pattern: str
    primary_hex: str
    color_family: str
    confidence: float
    verdict: Verdict
    headline: str
    detail: str
    new_pairings: int
    total_complements: int
    pairing_share: float
    duplicates: list[OwnedMatch] = Field(default_factory=list)
    unlocked_occasions: list[str] = Field(default_factory=list)
    #: The outfit this would make out of clothes already owned.
    wear_with: list[WearWith] = Field(default_factory=list)
    #: Filled when the verdict is negative: what to look for instead.
    look_for_colors: list[ColorOpportunity] = Field(default_factory=list)
    look_for_roles: list[str] = Field(default_factory=list)


class ShopScan(Model):
    id: UUID
    category: str
    role: str
    color_family: str
    primary_hex: str
    verdict: Verdict
    headline: str
    new_pairings: int
    duplicate_count: int
    unlocked_occasions: list[str] = Field(default_factory=list)
    photo_url: str | None = None
    created_at: datetime


class ScanPurchase(Model):
    scan_id: UUID
    garment_id: UUID
