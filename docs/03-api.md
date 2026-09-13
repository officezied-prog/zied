# SmartStylist — API Contract (Phase 1)

Machine-readable source of truth: **`api/openapi/openapi.yaml`**
(OpenAPI 3.1, validated with `openapi-spec-validator` — 42 paths, 59 operations,
38 schemas, all `$ref`s resolving).

```bash
# regenerate clients from the contract
openapi-generator-cli generate -i api/openapi/openapi.yaml -g dart-dio     -o mobile/lib/api
openapi-generator-cli generate -i api/openapi/openapi.yaml -g python-fastapi -o api/app/generated
```

---

## 1. Cross-cutting rules

| Concern | Rule |
|---|---|
| **Auth** | `Authorization: Bearer <JWT>` (RS256). `sub` = user id, and it is the same claim PostgreSQL RLS reads — one identity, enforced twice. |
| **Async** | Anything model-bound returns `202` + a job resource carrying `poll_after_ms`. Never block a mobile request on a GPU. |
| **Idempotency** | `Idempotency-Key` on every job-creating `POST`. Replaying a key returns the original job (enforced by a unique index, not application logic). |
| **Pagination** | Opaque cursors. `?limit=&cursor=` → `next_cursor`. No `OFFSET` — a 4 000-item closet must not get slower at the bottom. |
| **Errors** | RFC 9457 `application/problem+json`, always with `trace_id`. Domain problems carry extra fields (`required_consent`, `missing_roles`). |
| **Uploads** | Presign → client PUTs to storage → confirm. The API never touches image bytes. |
| **Caching** | Reference data (`/taxonomy/*`) is `ETag`-cacheable; the client ships a bundled copy and refreshes on `304`-miss. |
| **Rate limits** | `RateLimit-*` headers on every response; `429` with `Retry-After`. |
| **Versioning** | Path-versioned (`/v1`). Additive changes only within a version; the enum vocabularies come from `/taxonomy/*` so new categories don't need a client release. |

### Status codes that carry meaning

| Code | When |
|---|---|
| `202` | Work queued — poll the returned job |
| `304` | Reference data unchanged |
| `402` | Monthly render quota exhausted |
| `403` + `required_consent` | The user hasn't granted (or has revoked) a purpose |
| `409` | A conflicting sync/render is already in flight |
| `422` + `missing_roles` | The closet cannot produce a valid outfit for that occasion/weather |

---

## 2. Endpoints

### Account

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/v1/me` | Current user profile | 200 401 |
| `PATCH` | `/v1/me` | updateMe | 200 |
| `DELETE` | `/v1/me` | Request account erasure (GDPR Art. 17) | 202 |
| `POST` | `/v1/me/devices` | Register a push token | 201 |
| `GET` | `/v1/me/style-preferences` | getStylePreferences | 200 |
| `PUT` | `/v1/me/style-preferences` | putStylePreferences | 200 |

### Consent & Biometrics

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/v1/me/consents` | Current consent state per purpose | 200 |
| `POST` | `/v1/me/consents` | Grant or revoke a consent (append-only) | 201 |
| `GET` | `/v1/me/biometrics` | Read the biometric profile (audited) | 200 403 |
| `PUT` | `/v1/me/biometrics` | Create or patch the biometric profile (audited) | 200 403 |
| `DELETE` | `/v1/me/biometrics` | deleteBiometrics | 204 |
| `GET` | `/v1/me/body-photos` | listBodyPhotos | 200 |
| `POST` | `/v1/me/body-photos` | Register an uploaded photo as a try-on body reference | 202 403 |
| `DELETE` | `/v1/me/body-photos/{photoId}` | deleteBodyPhoto | 204 |

### Uploads & Media

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `POST` | `/v1/uploads/presign` | Reserve media rows and get presigned PUT URLs | 200 |
| `GET` | `/v1/media/{mediaId}` | Media metadata with a short-lived signed URL | 200 404 |
| `DELETE` | `/v1/media/{mediaId}` | deleteMedia | 204 |

### Social ingestion

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/v1/social/providers` | Providers enabled for this build, with their requirements | 200 |
| `POST` | `/v1/social/{provider}/authorize` | Begin the OAuth flow | 200 |
| `GET` | `/v1/social/{provider}/callback` | OAuth redirect target | 302 |
| `DELETE` | `/v1/social/{provider}` | Disconnect and delete provider-derived data | 202 |
| `POST` | `/v1/social/{provider}/sync` | Pull the authorised account's own recent posts | 202 409 |
| `GET` | `/v1/ingest/jobs` | listIngestJobs | 200 |
| `POST` | `/v1/ingest/jobs` | Run the CV pipeline over uploaded media | 202 |
| `GET` | `/v1/ingest/jobs/{jobId}` | getIngestJob | 200 404 |
| `GET` | `/v1/detections` | Detections awaiting review | 200 |
| `POST` | `/v1/detections/{detectionId}/accept` | Promote a detection to a wardrobe item, with corrections | 201 |
| `POST` | `/v1/detections/{detectionId}/reject` | rejectDetection | 204 |

### Taxonomy

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/v1/taxonomy/categories` | listCategories | 200 304 |
| `GET` | `/v1/taxonomy/occasions` | listOccasions | 200 |
| `GET` | `/v1/taxonomy/color-families` | listColorFamilies | 200 |

### Wardrobe

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/v1/garments` | listGarments | 200 |
| `POST` | `/v1/garments` | Add an item manually | 201 |
| `PATCH` | `/v1/garments/bulk` | Bulk edit (laundry, archive, season retag) | 200 |
| `GET` | `/v1/garments/{garmentId}` | getGarment | 200 404 |
| `PATCH` | `/v1/garments/{garmentId}` | updateGarment | 200 |
| `DELETE` | `/v1/garments/{garmentId}` | deleteGarment | 204 |
| `POST` | `/v1/garments/{garmentId}/wear` | Log that the item was worn | 201 |
| `GET` | `/v1/garments/{garmentId}/similar` | Nearest neighbours in embedding space | 200 |
| `GET` | `/v1/wardrobe/stats` | wardrobeStats | 200 |

### Styling

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `POST` | `/v1/outfits/recommend` | Rank outfits for an occasion, place and time | 200 422 |
| `GET` | `/v1/outfits` | listOutfits | 200 |
| `POST` | `/v1/outfits` | Save a user-composed outfit | 201 |
| `GET` | `/v1/outfits/{outfitId}` | getOutfit | 200 |
| `PATCH` | `/v1/outfits/{outfitId}` | updateOutfit | 200 |
| `DELETE` | `/v1/outfits/{outfitId}` | deleteOutfit | 204 |
| `POST` | `/v1/outfits/{outfitId}/feedback` | Like / dislike / save / worn — updates the taste vector | 201 |
| `POST` | `/v1/outfits/{outfitId}/swap` | Ask for alternatives for one slot, keeping the rest fixed | 200 |
| `GET` | `/v1/weather` | getWeather | 200 |

### Virtual try-on

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/v1/vton/models` | Try-on engines available to this user's tier | 200 |
| `GET` | `/v1/vton/jobs` | listVtonJobs | 200 |
| `POST` | `/v1/vton/jobs` | Render an outfit (or single garment) on the user's body photo | 200 202 402 403 |
| `GET` | `/v1/vton/jobs/{jobId}` | getVtonJob | 200 404 |
| `DELETE` | `/v1/vton/jobs/{jobId}` | Cancel a queued job or delete a finished render | 204 |

### Webhooks

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `POST` | `/webhooks/vton/{provider}` | Hosted VTON completion callback | 204 |
| `POST` | `/webhooks/meta/deauthorize` | Meta deauthorize callback | 200 |
| `POST` | `/webhooks/meta/data-deletion` | Meta data-deletion request callback | 200 |

### Ops

| Method | Path | Purpose | Responses |
|---|---|---|---|
| `GET` | `/healthz` | health | 200 |
| `GET` | `/readyz` | ready | 200 503 |

---

## 3. The three flows end to end

### 3.1 Onboarding → first wardrobe

```
POST /v1/me/consents            {terms_of_service, privacy_policy}          201
PUT  /v1/me/style-preferences   {archetypes, avoided colours, modesty}      200
POST /v1/me/consents            {biometric_processing: true}                201
PUT  /v1/me/biometrics          {height_cm, waist_cm, undertone, palette}   200
POST /v1/uploads/presign        {30 files + sha256}                         200 → 27 URLs, 3 duplicates
PUT  <presigned>                (direct to storage, parallel)
POST /v1/ingest/jobs            {media_ids, auto_accept:true}               202 {job_id}
GET  /v1/ingest/jobs/{id}       poll / push                                 200 {garments_created: 41, needs_review: 6}
GET  /v1/detections?status=pending                                          200 → swipe-review UI
POST /v1/detections/{id}/accept {category_id, name}                         201
```

### 3.2 "What do I wear tonight?"

```http
POST /v1/outfits/recommend
{
  "occasion": "date_night",
  "scheduled_for": "2026-09-13T19:30:00+04:00",
  "location": { "lat": 25.20, "lon": 55.27 },
  "count": 5,
  "explain": true
}
```
```jsonc
200 OK
{
  "run_id": "…", "engine_version": "styling-1.0.0",
  "weather": { "temp_c": 31.4, "feels_like_c": 35.1, "precip_prob": 0.02, "condition": "clear" },
  "candidate_count": 218, "latency_ms": 640,
  "outfits": [{
    "id": "…", "total_score": 0.8934,
    "score_breakdown": { "color_harmony": 0.91, "formality_fit": 0.95,
                          "weather_fit": 0.88, "personal_taste": 0.86, "novelty": 0.74 },
    "rationale": "Navy linen shirt with the camel chinos — a complementary pairing that reads polished without a jacket at 31°C, and you haven't worn the chinos in three weeks.",
    "items": [ { "role": "base_top", "garment": { … } }, … ]
  }]
}
```
Then: `POST /v1/outfits/{id}/swap {role:"footwear"}` to change one slot,
`POST /v1/outfits/{id}/feedback {kind:"like"}` to train the taste vector,
`POST /v1/outfits/{id}/feedback {kind:"worn"}` to write the wear log.

### 3.3 Try it on

```
POST /v1/me/consents      {vton_processing: true}                    201
POST /v1/uploads/presign  {purpose:"body_reference"}                 200
POST /v1/me/body-photos   {media_id, pose:"front_full"}              202  (parsing + moderation)
POST /v1/vton/jobs        {outfit_id, Idempotency-Key: …}            202  {job_id, poll_after_ms: 4000, total_passes: 3}
GET  /v1/vton/jobs/{id}                                              200  {status:"running", pass_index:2}
GET  /v1/vton/jobs/{id}                                              200  {status:"succeeded", result_url, qa_flags:[]}
```
A repeat of the same request returns `200` from cache and costs no quota.

---

## 4. Push notifications

The client registers via `POST /v1/me/devices`; the server pushes on
`ingest.completed`, `ingest.needs_review`, `vton.succeeded`, `vton.failed`,
`outfit.daily_suggestion`. Every payload carries the resource id so the app can
deep-link, and every event is also discoverable by polling — push is an
optimisation, never the only delivery path.

---

## 5. What is deliberately *not* in v1

* No public/social feed, no following, no sharing of other users' wardrobes.
* No third-party profile scraping endpoint — only the authenticated user's own
  authorised content (see `docs/01-architecture.md` §2, C1).
* No sync endpoint for garment *bytes*; clients hold ids + signed URLs and
  re-request URLs on expiry.
