# SmartStylist

AI smart wardrobe, occasion-aware styling engine and virtual try-on, for iOS and
Android.

**All five phases are delivered and executed — verified against a real
PostgreSQL database and a real Flutter toolchain, not just written.**

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Architecture, schema, API contract | ✅ 20/20 SQL assertions |
| 2 | Upload → segmentation → tagged wardrobe | ✅ |
| 3 | Occasion- and weather-aware styling engine | ✅ |
| 4 | Virtual try-on pipeline | ✅ |
| 5 | Flutter app (iOS + Android) | ✅ `flutter analyze` clean |
| 6 | Wardrobe advice, one-call styling, shop mode | ✅ |

**286 tests pass in total:** 20 SQL assertions, 192 Python tests against a real
database, 74 Dart tests. `ruff` and `flutter analyze` both clean.

## Two capabilities worth naming

### One call: occasion in, a picture of you wearing it out

`POST /v1/outfits/style-and-wear` takes an occasion and returns the best outfit
the wardrobe can produce, with a try-on render already queued on the user's own
photo. Runners-up come back scored, so switching to the second choice costs a
render and no re-scoring.

Placement is a rule per garment role rather than one bounding box: a jilbab,
abaya, thobe or maxi dress hangs from the shoulders to the ankles and suppresses
the separates underneath; a coat sits wider than the shirt it covers; a bag is
small and at one hip; shoes rest on the ground. The face is never regenerated.

### Shop mode: an answer before the money is spent

`POST /v1/shop/scan` takes a photograph of something on a rail and judges it
against the wardrobe at home. Three numbers decide it: pieces already owned
that are close enough to be the same purchase (CIEDE2000 under 8, same
category), pieces it would newly go with, and occasions the wardrobe cannot
dress today that it would unlock.

`wear_with` returns the outfit it would join — the best piece of each role, in
the order they are worn — so the answer is not just yes or no but *what to wear
it with*. When the verdict is negative, `look_for_colors` and `look_for_roles`
name what **is** missing, so a wasted trip becomes a useful one.

The photograph is stored and identified; nothing about the shop is. No
retailer, no location, no scraped price — the question is "does this go with
what I own", and collecting where somebody shops would answer a different one.

### Advice that knows when to say nothing

`GET /v1/wardrobe/advice` answers two questions separately.

*What the wardrobe cannot do* — which occasions are unwearable and which slot
blocks each one, plus the absent colour that would unlock the most combinations.
Returned to everyone.

*Whether to phrase any of it as shopping* — inferred from what the user recorded
paying for what they own, or failing that the brands they have. A wardrobe that
reads as budget-conscious is told only about a gap that actually blocks an
occasion; one being actively built is offered gaps and upgrades. Three
guarantees hold: the derived band is **never stored**, **never shown as a label
for the person**, and **never changes a price**. The user's own
`budget_tier` and `allow_new_purchases` settings override the inference
entirely.

| Artefact | Status |
|---|---|
| `docs/01-architecture.md` | System architecture, pipelines, model stack, security, cost, phase plan |
| `docs/02-data-model.md` | 39 tables across 3 schemas, ER diagrams, design rationale |
| `docs/03-api.md` | Conventions, endpoint reference, end-to-end flows |
| `docs/04-phase2-backend.md` | Ingestion + CV service: decisions, defects found, test coverage |
| `docs/05-styling-tryon-app.md` | Styling engine, try-on pipeline and mobile app |
| `api/openapi/openapi.yaml` | OpenAPI 3.1 — **validates clean**, 48 paths / 65 operations / 51 schemas |
| `db/migrations/0001…0019` | **Apply clean** on PostgreSQL 16.13 + pgvector 0.6.0 |
| `db/seeds/0001…0007` | 71 categories · 15 occasions · 29 colour families · 34 pairing rules · 39 palette affinities · 6 try-on models · detector vocabularies |
| `db/tests/smoke_test.sql` | **20/20 assertions passing** |
| `api/app/`, `workers/` | FastAPI service, vision worker, styling engine, try-on worker — **192 tests** |
| `mobile/` | Flutter app — **74 tests**, analyze clean |

## Verify it yourself

```bash
createdb smartstylist
make venv
make verify   # migrations + seeds + SQL smoke test, 192 python tests, ruff,
              # OpenAPI validation, flutter analyze, 74 dart tests
```

Or one piece at a time:

```bash
./scripts/db_bootstrap.sh "postgresql://localhost/smartstylist"
make test            # python
make mobile-test     # dart
make demo            # end-to-end walkthrough of all four backend phases
```

Requires the `vector` extension (`apt install postgresql-16-pgvector`, or use
Supabase where it is built in). The Python tests build their own database from
`db/migrations` + `db/seeds`, so they need a reachable PostgreSQL and nothing else
— no cloud account, no GPU, no model weights.

## Run it

### With Docker — one command, nothing else to install

```bash
docker compose up --build
```

Then open **http://localhost:8000/docs**. The stack brings up PostgreSQL with
pgvector, applies all migrations and seeds, creates a demo user, and starts the
API together with both workers.

To call the endpoints straight from that page, click the green **Authorize**
button at the top right, paste `00000000-0000-4000-8000-000000000001` into
**Debug user (local only)**, and press Authorize. That is the demo user the
stack creates, with its consents already granted. Every endpoint on the page is
then callable with "Try it out".

> `docker-compose.yml` sets `SS_ALLOW_DEBUG_USER_HEADER=true` so the docs page is
> usable without minting a JWT by hand. It is a **development-only** switch and
> must never be set in a deployed environment.

### Without Docker

```bash
make api           # uvicorn on :8000, interactive docs at /docs
make worker        # vision worker  (ingest → segmentation → tagging)
make worker-vton   # try-on worker  (GPU queue)
cd mobile && flutter run --dart-define=SS_API_BASE_URL=http://10.0.2.2:8000
```

### The app with no backend at all

```bash
cd mobile
flutter run --dart-define=SS_DEMO=true          # phone, emulator or desktop
flutter build web --dart-define=SS_DEMO=true    # a browser build
```

Demo mode swaps only the transport: the screens, state machines and models are
the shipping ones, and the scores and rationales are copied from a real run of
the styling engine rather than invented. A banner says so on every screen, so a
sample closet is never mistaken for the user's own. Useful for design reviews,
store screenshots, and showing the app before the backend is up.

## Layout

```
db/migrations/  0001 extensions+enums · 0002 identity/consent/biometrics
                0003 media/ingest/CV  · 0004 wardrobe · 0005 styling/outfits
                0006 VTON             · 0007 embeddings (pgvector)
                0008 RLS+audit        · 0009 colour maths + candidate retrieval
                0010 ingest work queue (SKIP LOCKED) · 0011 view security_invoker
                0012 weather-cache writer · 0013 candidate warmth model
                0014 try-on queue · 0015 body-photo accessors · 0016 render erasure
                0017 wardrobe economics · 0018 coverage by body region
db/seeds/       taxonomy · occasions · colour theory · try-on registry · detector
                labels · brand tiers and price bands
db/tests/       smoke_test.sql
api/app/        FastAPI: config · db · security · storage · 11 routers
workers/vision/ pipeline · colour · phash · labels · segmenters · runner
workers/styling/ engine · scoring · combiner · rationale · embeddings · weather ·
                geo · economics · advice
workers/vton/   pipeline · preprocess · placement · providers · qa · runner
mobile/         Flutter app: core · models · data · providers · screens · widgets
tests/          192 python tests   ·   mobile/test/  74 dart tests
infra/          Dockerfile.api · Dockerfile.worker (cpu + gpu stages)
docs/           01 architecture · 02 data model · 03 API · 04 phase 2 · 05 phases 3-5
scripts/        db_bootstrap.sh · demo_journey.py
```

What remains before launch is listed in `docs/05-styling-tryon-app.md` §"What is
still open" — chiefly a held-out accuracy run for the production detector and
try-on checkpoints, the content-moderation classifier, and the retention worker.

## Two things to decide before Phase 2

1. **Social ingestion is a bonus, not the backbone.** Instagram's Basic Display
   API is retired; the replacement covers professional accounts only, Facebook
   `user_photos` needs App Review, and TikTok returns only the authenticated
   user's own posts. Manual/camera-roll upload is the primary path and the
   product must be complete without any connector. No third-party scraping.
2. **Virtual try-on licensing.** The strongest open checkpoints commonly ship
   under non-commercial terms. `vton_models.commercial_ok` exists so the router
   can't dispatch one to a paying user — but the licence review itself is a
   launch gate.
