# SmartStylist — Phase 2: Ingestion, Segmentation and Tagging

> Delivered and executed. `74/74` Python tests pass against a real PostgreSQL
> database, real presigned uploads, the real worker claim loop and the real
> pipeline. Lint clean (`ruff`, 8 rule families incl. `S` security).

What Phase 2 builds: **a photo goes in, correctly categorised and
colour-profiled wardrobe items come out.**

```
presign → client PUTs to storage → ingest job → worker claims → normalise →
pHash dedupe → segment → per instance: quality gate · cutout · palette ·
category → detection row → promote to garment (or review queue)
```

---

## 1. What runs where

| Component | Path | Notes |
|---|---|---|
| API (stateless) | `api/app/` | FastAPI. Never loads a model, never proxies image bytes. |
| Vision worker | `workers/vision/` | Claims work from Postgres, runs the pipeline. |
| Segmentation backends | `workers/vision/segmenters/` | `stub` (weight-free, real) and `yolo` (production, lazy import). |
| Colour science | `workers/vision/color.py` | LAB k-means + CIEDE2000, mirrored by the SQL in migration 0009. |
| Perceptual hashing | `workers/vision/phash.py` | DCT-II, no scipy. |
| Label mapping | `workers/vision/labels.py` | Detector vocabulary → taxonomy, driven by `synonyms`. |

---

## 2. Decisions worth defending

### The database is the queue

`SELECT … FOR UPDATE SKIP LOCKED` in `public.claim_ingest_items()`
(migration 0010) gives exactly-once claiming across any number of workers with
no broker to operate, and — because the claim carries a TTL — work from a
crashed worker becomes re-claimable instead of stranded. `attempts` caps the
retry loop so a poison image fails loudly.

Proven, not asserted: `tests/test_worker.py` runs **four concurrent workers over
six queued items** and checks every item was claimed exactly once, that an
expired claim is recovered by a healthy worker, that a live claim is not stolen,
and that one unreadable image fails its own item without touching the other
five. Swapping in Redis Streams or SQS later replaces one function.

### The stub segmenter really segments

It is not a mock returning canned data: it finds horizontal bands of
perceptually uniform colour (ΔE2000-based) and assigns a garment label from
vertical position. That means the entire pipeline — cutouts, palettes, tagging,
dedupe, promotion, review — is exercised end to end in CI with no model
download, and the production swap is one factory call.

### Two implementations of colour maths, pinned to each other

The worker extracts colour in Python; the styling engine (Phase 3) scores it in
SQL. If they drift, a garment's stored family stops matching what the
recommender computes. `test_python_and_sql_colour_maths_agree` compares both
implementations across 36 colour pairs and every LAB/LCh conversion, and both
match Sharma et al.'s published CIEDE2000 reference pairs to four decimals.

### Nothing uncertain enters the wardrobe

A detection is promoted only if confidence ≥ 0.60, mask area ≥ 2 % of frame,
occlusion ≤ 0.4, the label maps to a category, and it is not a near-duplicate of
an item already owned. Everything else goes to a **review queue**. A wrong item
in the closet poisons every later recommendation; a review card costs one swipe
— and each swipe is the cheapest training label the product will ever collect.

### Dedupe at two layers

`sha256` catches byte-identical re-uploads before a single byte is transferred.
pHash (Hamming ≤ 6) catches the same photo resized, re-encoded or re-brightened
— verified invariant under half/third scale, ±20 brightness, ×1.15 contrast and
JPEG-like quantisation. A third layer compares category + primary colour under
ΔE2000 < 5, so the same shirt photographed twice does not become two garments.

---

## 3. Two real defects this phase found

**A cross-tenant leak in the views.** PostgreSQL evaluates a view with its
*owner's* privileges unless `security_invoker` is set. `v_wardrobe_stats` and
friends are owned by the table owner, so a client reading through them would
have bypassed row-level security and seen **every user's rows** — the exact leak
RLS exists to prevent. Migration **0011** sets `security_invoker = true` on all
three views and adds a guard that fails any future migration introducing a view
without it. `test_users_cannot_see_each_others_wardrobes` now asserts the stats
endpoint returns zero for a second user.

**Parent categories were stealing their children's names.** `boots` carried
`chelsea boots` in its synonyms while the `ankle_boots` subcategory existed, so
"chelsea boots" mapped to the generic parent. Nine such synonyms were moved onto
the specific rows they belong to. Found by a parametrised mapping test over the
real seeded taxonomy, not by reading the seed file.

---

## 4. Test coverage

| File | Tests | What it proves |
|---|---|---|
| `test_color.py` | 13 | CIEDE2000 vs. the published reference set; Python ↔ SQL agreement; masked extraction; cluster merging; shadow/highlight trimming; family assignment |
| `test_phash.py` | 7 | Scale, brightness, contrast and quantisation invariance; separation of distinct images; signed-bigint round trip |
| `test_labels.py` | 22 | DeepFashion2, ModaNet and natural-language labels against the real taxonomy; specific beats generic; unknown → review |
| `test_ingest_flow.py` | 16 | Full upload→wardrobe flow, real RGBA cutouts, three dedupe layers, review queue, idempotency, filters, cursor pagination, stats, soft delete, tenant isolation, anonymous rejection |
| `test_uploads_and_consent.py` | 11 | MIME/size/hash validation, tampered and expired signed URLs, per-user key scoping, append-only consent ledger, DB-level consent gate |
| `test_worker.py` | 6 | Concurrent claiming, crash recovery, live-claim protection, per-item failure isolation, attempt cap, idempotent re-runs |
| **Total** | **74** | |

---

## 5. Running it

```bash
make venv                     # virtualenv + dependencies
make db DB=postgresql://localhost/smartstylist
make test                     # 74 tests
make api                      # uvicorn on :8000, docs at /docs
make worker                   # vision worker
```

Local development uses a filesystem object store with **HMAC-signed URLs and
expiry**, so the client's upload path is byte-for-byte the one it will use
against S3 — no cloud account needed to run the whole flow.

---

## 6. Known limits going into Phase 3

1. **`SS_SEGMENTER=yolo` is written but unexercised here** — no GPU and no
   weights in this environment. The interface and the mapping layer are tested;
   the checkpoint's accuracy is not. First Phase-3 task on the CV side is a
   held-out accuracy run against the 85 %-category-accuracy exit criterion.
2. **Embeddings are not populated yet.** `garment_embeddings` exists and is
   indexed (HNSW); the FashionCLIP worker that fills it lands with the styling
   engine, which is its first consumer.
3. **Social connectors are not implemented** — deliberately. Manual upload is
   the primary path (see `docs/01-architecture.md` §2, C1); connectors are
   plugins behind `IngestSource` and should follow proven CV accuracy, not
   precede it.
4. **Moderation is a column, not a service yet.** `media_assets.moderation_status`
   is written as `pending`; the NSFW/minor classifier must be wired before any
   body photo can reach the VTON pipeline in Phase 4.
