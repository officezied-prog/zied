# SmartStylist — Phases 3, 4 and 5

> Delivered and executed. **131 Python tests** against a real PostgreSQL
> database, real workers and a real HTTP surface; **31 Dart tests** and
> `flutter analyze` clean on the mobile app. Both sides lint clean.

---

## Phase 3 — the styling engine

`workers/styling/`. Three stages, cheapest first:

```
retrieve (SQL)  ->  combine (beam search)  ->  score & explain
```

**1. Retrieve.** `public.wardrobe_candidates()` filters the closet in the
database: availability, occasion formality band, role/category/pattern bans, a
temperature-derived warmth ceiling, season adjacency and rain rules. A 400-item
closet never crosses the wire.

**2. Combine.** A 200-piece wardrobe has ~10⁷ naive combinations, so the engine
never enumerates. It fills roles **hardest-first** with a beam search (width 24),
scoring partial looks and keeping the best. Two skeletons are built in parallel —
separates and one-piece — because a dress is not a substitute for a top. Layers
are added only when the felt temperature calls for them.

**3. Score.** Ten terms, each 0-1 and independently explainable, weighted by
`BASE_WEIGHTS` and multiplied by the occasion's `scoring_weights` — so "date
night cares more about colour" is an UPDATE, not a deploy.

| Term | What it measures |
|---|---|
| `color_harmony` | pairwise `score_color_pair` across the look; accessories weighted lower; three saturated heroes penalised |
| `palette_fit` | the user's 12-season palette against each garment's colour family |
| `formality_fit` | distance from the occasion's formality band |
| `weather_fit` | total warmth vs. the felt temperature, plus rain, UV and diurnal-swing rules |
| `pattern_balance` | one focal pattern is ideal; two compete |
| `proportion_fit` | body-shape rules (consented biometrics only) |
| `personal_taste` | cosine against the user's taste vector |
| `novelty` | days since worn, saturating at 30 |
| `preference_fit` | avoided colours, categories and patterns |
| `completeness` | are the occasion's required roles filled |

**Explanations are assembled, not generated.** `rationale.py` builds the sentence
from the same numbers the UI shows, leading with the pair a person actually
notices. It cannot claim something the score does not support. An LLM pass may
later reword it, but never sees the wardrobe and cannot invent an item.

**Embeddings without a GPU.** `FeatureEmbedder` encodes what the stylist reasons
about — CIELAB colour, hue on the unit circle, formality, warmth, hashed
role/category/pattern — into the same 768-d column the production
FashionCLIP encoder uses, distinguished by the `model` column so the two spaces
never mix. Cosine behaves correctly (two navy shirts 0.96, navy shirt vs. orange
shorts 0.35), so the taste vector genuinely learns from feedback today.

**Feedback is asymmetric on purpose.** A like moves the taste vector twice as far
as a dislike: people reject outfits for reasons that have nothing to do with
taste ("wrong for the weather", "it's in the wash"), so a negative signal is
weaker evidence.

Every call writes a `recommendation_runs` row with inputs, weights, engine
version and latency, so any suggestion is replayable and any experiment
attributable.

---

## Phase 4 — virtual try-on

`workers/vton/`.

```
prepare body photo (cached)  ->  plan passes  ->  render  ->  QA  ->  store
```

**Preparation is cached per photo,** not per render: subject detection and body
zones are computed once and reused, which is most of the latency of the second
and every later try-on.

**Layering is sequential** in the order clothes are actually put on — base layer,
bottom, mid layer, outerwear, accessories. A coat rendered under a shirt looks
wrong in a way no amount of model quality fixes.

**The face is never generated.** It is masked out of the render target and
composited back verbatim, and QA measures the difference: a `face_altered` flag
fails the render outright. A try-on that changes someone's face is worse than no
try-on.

**Three providers behind one interface.** `CompositeProvider` (`composite@1`)
warps and composites cutouts onto body zones — deterministic, commercially
unencumbered, and honest about what it is; it is the default, the free tier and
the fallback when GPU capacity runs out. `DiffusionVtonProvider` and
`HostedVtonProvider` are the production paths, lazily imported so the API image
never loads torch.

**Licensing is enforced in code.** `vton_models.commercial_ok` gates the router;
a non-commercial checkpoint returns `400 not licensed for this deployment`, and
`/v1/vton/models` marks it unavailable. Tested.

**Cost control.** A cache key over (body photo, garment set, model, params, seed)
means an identical request returns `200` with the existing render and consumes
no quota. `consume_quota()` is atomic, so parallel taps cannot overshoot.

---

## Phase 5 — the mobile app

`mobile/`. Flutter 3.47 · Riverpod · no code generation.

| Screen | What it does |
|---|---|
| Wardrobe | Cursor-paginated grid of cutouts, role and availability filters, batch import with live progress, unconfirmed-item badges |
| Quick check | The review queue — one decision per card, each one a training label |
| Occasion | The 15 seeded occasions as a grid; the whole engine hangs off this one question |
| Results | Ranked looks with the assembled rationale and the top two reasons; like/dislike inline |
| Look detail | Pieces head-to-toe, the full score breakdown as bars, per-slot swap, "see it on me" |
| Try on | Consent → body photo → render, with layer-by-layer progress and queue position |
| Profile | Wardrobe stats and wardrobe gaps; every consent as its own switch |

**Decisions worth defending**

* **Errors are typed, not generic.** `ApiException` parses the RFC 9457 problem
  document, so a missing consent renders a "Give permission" button, an
  exhausted quota says so, and a 422 lists the roles the wardrobe is missing.
* **The API never proxies bytes.** The client presigns, PUTs to storage and
  confirms — the same path in local development, CI and production.
* **Polling follows the server.** `pollJob` honours `poll_after_ms` instead of
  guessing, and gives up after three minutes so a wedged job cannot hold the
  user's battery.
* **Consent is explained before it is asked.** The try-on screen states what
  happens to the photo — encrypted, never public, face untouched, deleted on
  withdrawal — before the button appears.
* **Optimistic where it is safe.** Laundry toggles apply immediately and revert
  on failure; nothing destructive is optimistic.

---

## Two defects these phases found

**The temperature filter made cold weather unwearable.** Candidate retrieval
filtered each garment into a two-sided warmth *band*, which excluded every light
top and bottom below 2°C — leaving a pool of nothing but outerwear and no
buildable outfit at all. Wrong model: in cold weather you still wear a light
shirt, *as a base layer under a coat*. Migration **0013** replaces the band with
a warmth **ceiling** plus season adjacency, and leaves the floor to the total
warmth of the assembled look, which the scorer already handles. Found by a test
asserting that sub-zero weather produces a layered outfit.

**Deleting a body photo orphaned the renders.** The foreign key cascaded, so the
job rows vanished — but the rendered images stayed in object storage with
nothing pointing at them. A try-on render is a picture of the user's body;
deleting the source photo, or withdrawing consent, must erase them too.
Migration **0016** makes the erasure explicit and complete, and
`v_purgeable_media` tells the retention worker what bytes to delete.

Two more were caught before they shipped: writing to the shared weather cache
needed a validating `SECURITY DEFINER` writer (migration **0012**) so one client
could not poison a whole map cell, and the 422 for an unbuildable outfit was
*guessing* which roles were missing instead of computing them.

---

## Test coverage across all phases

| Suite | Tests | Focus |
|---|---|---|
| `db/tests/smoke_test.sql` | 20 | consent gate, RLS isolation, triggers, quotas, colour maths |
| `test_color.py` | 13 | CIEDE2000 vs. the published reference set; Python ↔ SQL agreement |
| `test_phash.py` | 7 | scale, brightness, contrast and quantisation invariance |
| `test_labels.py` | 22 | DeepFashion2 / ModaNet / natural-language label mapping |
| `test_ingest_flow.py` | 16 | upload → wardrobe, three dedupe layers, review queue, tenant isolation |
| `test_uploads_and_consent.py` | 11 | signed-URL tampering and expiry, append-only consent ledger |
| `test_worker.py` | 6 | concurrent claiming, crash recovery, failure isolation |
| `test_styling.py` | 15 | scoring terms, Python ↔ SQL colour pairing, weather cache and its validator |
| `test_recommend_api.py` | 20 | occasion/weather/laundry filtering, diversity, feedback loop, swap, 422 diagnostics |
| `test_vton.py` | 18 | consent gate, real render with face preserved, cache, quota, licensing, erasure |
| `test_contract.py` | 4 | the live routes never drift from the published OpenAPI contract |
| `mobile/test/*` | 31 | model parsing, typed errors, polling, six widget tests over stubbed transport |
| **Total** | **182** | |

---

## What is still open

1. **The production detector and encoder are unexercised here** — no GPU and no
   weights in this environment. Interfaces, mapping and persistence are tested;
   accuracy is not. First task before launch: a held-out accuracy run against
   the 85 %-category target, and the same for the diffusion try-on quality.
2. **Social connectors remain unimplemented, deliberately** (see
   `docs/01-architecture.md` §2, C1).
3. **Moderation is still a column.** `media_assets.moderation_status` is written
   as `pending`; the NSFW/minor classifier must be wired before any body photo
   reaches a diffusion provider in production.
4. **The retention worker is specified, not written.** `v_purgeable_media` and
   `v_expired_vton_renders` define exactly what it must delete.
5. **Push notifications** are contracted but not implemented; every job is
   discoverable by polling, so push is an optimisation.
