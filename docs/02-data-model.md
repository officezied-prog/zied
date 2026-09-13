# SmartStylist — Data Model (Phase 1)

35 tables across three schemas, validated on **PostgreSQL 16.13 with pgvector
0.6.0**. Every migration in `db/migrations/` applies cleanly from an empty
database, and `db/tests/smoke_test.sql` exercises the consent gate, category
inheritance, colour maths, candidate filtering, wear-log triggers, quotas and
RLS isolation (20 assertions, all passing).

| Schema | Purpose | Client access |
|---|---|---|
| `public` | application data | RLS-protected, role `authenticated` |
| `private` | biometrics, body photos, OAuth token references | **none** — service role + `SECURITY DEFINER` accessors only |
| `audit` | append-only access trail for special-category data | service role only |

---

## 1. Identity, consent and biometrics

```mermaid
erDiagram
    users ||--o{ user_devices : "push targets"
    users ||--o{ user_consents : "append-only ledger"
    users ||--|| style_preferences : "taste settings"
    users ||--o{ social_accounts : "linked platforms"
    users ||--|| biometric_profiles : "PRIVATE"
    users ||--o{ body_reference_photos : "PRIVATE"
    users ||--o{ deletion_requests : "DSR / platform callbacks"
    social_accounts ||--|| social_credentials : "PRIVATE token refs"

    users {
        uuid id PK
        citext email UK
        unit_system units
        text onboarding_stage
        timestamptz deleted_at "soft delete"
        timestamptz purge_after "hard-delete deadline"
    }
    user_consents {
        uuid id PK
        consent_type consent_type "biometric_processing, vton_processing, …"
        boolean granted
        text policy_version
        timestamptz created_at "never updated — revoke = new row"
    }
    biometric_profiles {
        uuid user_id PK
        numeric height_cm "+ 12 more measurements"
        body_shape body_shape
        char7 skin_tone_hex
        smallint skin_tone_monk "Monk Skin Tone 1-10"
        skin_undertone skin_undertone
        seasonal_palette seasonal_palette "12-season system"
        face_shape face_shape
        real_array smpl_betas "parametric body model"
    }
    body_reference_photos {
        uuid id PK
        text pose
        boolean is_primary "one per user (partial UK)"
        text parsing_map_key "cached SCHP output"
        text densepose_key
        jsonb pose_keypoints
        text agnostic_key "cloth-agnostic person repr."
    }
```

**Design notes**

* `user_consents` is **append-only**. `has_consent(user, type)` reads the latest
  row; `upsert_biometric_profile()` raises `42501` without it (smoke test 1).
* Measurements are stored in **metric only**; `users.units` controls display, so
  no unit ambiguity ever reaches the database.
* `smpl_betas` lets a photo-estimated body model feed both size advice and VTON
  warping later, without changing the schema.
* `social_credentials` holds a **reference** to a secrets-manager entry, not the
  token itself.

---

## 2. Ingestion and computer vision

```mermaid
erDiagram
    users ||--o{ media_assets : "owns"
    users ||--o{ ingest_jobs : "requests"
    ingest_jobs ||--o{ social_posts : "discovers"
    social_accounts ||--o{ social_posts : "source"
    media_assets ||--o{ detections : "analysed into"
    media_assets ||--o{ media_assets : "derived (cutout, render)"
    ingest_jobs ||--o{ detections : ""
    garment_categories ||--o{ detections : "mapped label"

    media_assets {
        uuid id PK
        text bucket "5 buckets by sensitivity"
        text storage_key UK
        media_source source "manual_upload | instagram | …"
        char64 sha256 "exact dedupe (partial UK per user)"
        bigint phash "near-duplicate detection"
        boolean exif_stripped
        moderation_status moderation_status
        uuid parent_asset_id FK
    }
    ingest_jobs {
        uuid id PK
        job_status status
        text cursor "provider pagination — incremental re-runs"
        int items_discovered
        int garments_created
        text idempotency_key UK
    }
    detections {
        uuid id PK
        text detector_model "+ version — reproducible inference"
        text classifier_model
        numeric confidence
        numeric_array bbox "normalised x,y,w,h"
        jsonb mask_rle "COCO RLE"
        uuid cutout_asset_id FK
        text status "pending | accepted | rejected | duplicate"
        uuid garment_id FK
    }
```

**Design notes**

* A detection is **not** a wardrobe item. It is model output with provenance;
  promotion to `garments` happens on a confidence gate or a user tap, and the
  link is kept so you can retrain on corrections.
* Model name **and** version on every row: when the detector is upgraded you can
  re-run only the items tagged by the old version.
* Dedupe is two-layer — `sha256` for byte-identical re-uploads, `phash` +
  embedding cosine for the same shirt photographed twice.

---

## 3. Wardrobe, colour and styling

```mermaid
erDiagram
    garment_categories ||--o{ garment_categories : "3-level tree"
    garment_categories ||--o{ garments : "typed by"
    users ||--o{ garments : "owns"
    garments ||--o{ garment_colors : "dominant palette"
    garments ||--|| garment_embeddings : "768-d FashionCLIP"
    garments ||--o{ outfit_items : ""
    garments ||--o{ wear_log : "usage truth"
    outfits ||--o{ outfit_items : ""
    outfits ||--o{ outfit_feedback : "taste signal"
    occasions ||--o{ outfits : ""
    recommendation_runs ||--o{ outfits : "replayable"
    weather_snapshots ||--o{ recommendation_runs : "shared cache"
    color_families ||--o{ color_pair_rules : "curated harmony"
    color_families ||--o{ palette_affinity : "season fit"

    garments {
        uuid id PK
        int category_id FK
        garment_role role "outfit slot, inherited from category"
        smallint formality "1 lounge … 5 black tie"
        smallint warmth "0 … 5, matched to temperature band"
        season_array seasons
        pattern_type pattern
        text_array material
        boolean in_laundry "availability"
        int wear_count "trigger-maintained"
        date last_worn_at
        uuid cutout_media_id FK "flat PNG for VTON"
    }
    garment_colors {
        bigint id PK
        char7 hex
        numeric ratio "share of masked pixels"
        numeric lab_l "CIELAB — what the engine compares"
        numeric lch_h "hue for harmony rules"
        text color_family FK
        boolean is_neutral
    }
    occasions {
        int id PK
        text slug "date_night, business_meeting, …"
        smallint formality_min
        smallint formality_max
        garment_role_array required_roles
        text_array banned_categories
        jsonb scoring_weights "per-occasion engine overrides"
    }
    outfits {
        uuid id PK
        numeric total_score
        jsonb score_breakdown "explainability"
        text rationale
        date planned_for
    }
```

**Design notes**

* **Category priors flow into garments.** Insert a garment with only a category
  and the `BEFORE INSERT` trigger fills `role`, `formality`, `warmth`, `seasons`
  and `is_layerable` from `garment_categories` — the CV pipeline supplies what it
  is confident about and inherits the rest (smoke test 5).
* **Colour lives in CIELAB, not hex.** `lab_*` for perceptual distance
  (CIEDE2000), `lch_h` for harmony geometry, `color_family` for the curated rule
  table. `hex_to_lab()`, `lab_to_lch()` and `ciede2000()` are implemented in SQL
  and validated against Sharma et al.'s reference pairs — all five match to four
  decimals.
* **Occasion rules are data, not code.** Adding "Eid gathering" or "gallery
  opening" is an INSERT, not a deploy.
* `outfit_items` has a partial unique index enforcing single-occupancy roles —
  one pair of trousers, many rings (smoke test 11).
* `wear_log` triggers keep `wear_count` / `last_worn_at` correct on insert *and*
  delete, which the novelty term and cost-per-wear analytics depend on.

---

## 4. Virtual try-on and metering

```mermaid
erDiagram
    users ||--o{ vton_jobs : "requests"
    vton_models ||--o{ vton_jobs : "routed to"
    body_reference_photos ||--o{ vton_jobs : "person input"
    outfits ||--o{ vton_jobs : "what to render"
    vton_jobs ||--o{ vton_jobs : "layer passes"
    media_assets ||--o{ vton_jobs : "result"
    users ||--o{ usage_counters : "quota"

    vton_models {
        text id PK "idm-vton@1"
        vton_provider provider
        text license
        boolean commercial_ok "gates paid-tier routing"
        garment_role_array supports_roles
        numeric cost_per_call_usd
    }
    vton_jobs {
        uuid id PK
        uuid_array garment_ids "1-5"
        uuid parent_job_id FK "sequential layering"
        smallint pass_index
        jsonb params "steps, guidance, seed"
        job_status status
        smallint priority "queue ordering by tier"
        numeric cost_usd
        numeric qa_score "artefact / identity check"
        timestamptz expires_at "renders are ephemeral"
        text idempotency_key UK
    }
    usage_counters {
        uuid user_id PK
        date period_start PK
        text metric PK
        bigint used
        bigint quota
    }
```

`consume_quota()` does the check-and-increment in one `SELECT … FOR UPDATE`
transaction, so parallel taps can't overshoot the limit (smoke test 14).

---

## 5. Functions the application layer calls

| Function | Purpose |
|---|---|
| `current_user_id()` | JWT `sub` or `app.current_user_id` GUC — the basis of every RLS policy |
| `has_consent(user, type)` | consent gate |
| `get_biometric_profile()` / `upsert_biometric_profile(jsonb)` | the only sanctioned path into `private.biometric_profiles`; audited |
| `hex_to_lab(hex)` / `lab_to_lch(a,b)` / `hex_to_color_row(hex)` | colour conversion (hue normalised to `[0,360)`) |
| `ciede2000(l1,a1,b1,l2,a2,b2)` | perceptual colour difference |
| `score_color_pair(a, b, …)` | curated rule → neutral rule → hue geometry fallback |
| `wardrobe_candidates(user, occasion, temp_c, precip, roles, limit)` | stage-1 retrieval for the styling engine |
| `consume_quota(user, metric, n)` | atomic quota check-and-increment |
| `category_descendants(slug)` | recursive taxonomy expansion |

## 6. Views

`v_user_consent_state` · `v_garment_primary_color` · `v_wardrobe_stats`
(items, never-worn count, worn in last 30 days, average cost-per-wear, closet value)

---

## 7. Seed data shipped

| Seed | Rows |
|---|---|
| Garment taxonomy | 71 categories (7 supercategories, 45 categories, 19 subcategories) with synonyms for detector-label mapping |
| Occasions | 15, incl. Date Night, Business Meeting, Job Interview, Formal Event, Wedding Guest, Religious Service, Funeral, Workout, Travel Day |
| Colour families | 29 with LCh bounds and warm/cool classification |
| Curated colour pairings | 34 (navy+camel 0.95, black+white 0.92, red+green 0.25 …) |
| Palette affinity | 39 rows across the four core seasonal palettes |
| VTON model registry | 5 entries incl. a deterministic `mock@1` for CI |
