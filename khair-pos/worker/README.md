# Khair Mart Jumla (الخير مارت جملة) — code backend (Cloudflare Workers + D1)

This is **Khair Mart Jumla**, the direct-code backend that replaces the n8n Cloud workflows.
The old n8n workflows are kept **as a reference** (not deleted, not modified); this code is the
new version the apps will point to after cut-over.
Goal: a strong, always-on backend with **no monthly execution wall** that can halt the
shop (the n8n Starter plan's quota caused the 2026-10-10 outage). Owner's standing rule:
reliability first, then cost. Cloudflare Workers free tier = 100k requests/day (far above
the shop's needs); D1 (SQLite) free tier = 5 GB + 5M row-reads/day. No per-month cap that
stops everything.

## How it preserves the existing behaviour exactly

The live n8n flow is: `webhook → Parse Request → (25 "Get X" table loaders) → Process
(all business logic) → per-table Ops/Has/Upsert → Finalize → Respond`.

We reuse the **same business logic verbatim**:

- `../backend/process.js` is the single source of truth (byte-identical to the live n8n
  "Process" code node — verified by diff). It is a function of one argument `$` (an n8n
  node accessor). We do **not** rewrite it.
- Cloudflare Workers forbid `eval` / `new Function` at runtime, so `build.js` wraps
  `process.js` into a real function at **build time** (strip its `const STORE_KEY` line,
  wrap the body in `export function runProcess($, STORE_KEY){ … }`). The top-level
  `return` statements become function returns. Mechanical, auditable, no transcription.
- `src/parse.js` and `src/finalize.js` are ports of the live "Parse Request" / "Finalize"
  nodes (the repo's old `../backend/parse-request.js` was stale — the live one computes
  extra fields like `pay_from`, `party_cid`, …; we ported the **live** version).
- `src/db.js` + `tables.js` reproduce the 25 loaders as SQL (exact same filters pulled
  from the live workflow) and the Upsert nodes as insert/update (`_id === -1` → insert,
  else update by `id`; only known columns written). Booleans are coerced to real
  `true/false` on read and `0/1` on write, so `process.js` boolean checks behave as under
  n8n.

So the Worker runs the identical logic over identical data, with a thin HTTP + SQL shell.

## Layout

| File | Role |
|------|------|
| `tables.js` | Column names + types for every `pos_*` table (source of truth for schema + coercion) |
| `schema.sql` | Generated D1 `CREATE TABLE` statements (via `build.js`) |
| `build.js` | Generates `schema.sql` and `src/generated/process.gen.js` from `tables.js` + `../backend/process.js` |
| `src/parse.js` | Port of live "Parse Request" |
| `src/finalize.js` | Port of live "Finalize" |
| `src/db.js` | D1 loaders (25 `Get X` queries) + `applyOps` writer |
| `src/index.js` | Worker `fetch` handler: CORS, route, parse → load → process → write → finalize → respond |
| `src/generated/process.gen.js` | Generated wrapped `process.js` (committed for reproducible deploys) |
| `test/` | Local parity tests: run the existing harness suites through `runProcess` + a `node:sqlite` D1 shim and compare |
| `wrangler.toml` | Worker config + D1 binding |

## Safe cut-over (no downtime, instant rollback)

1. Build + pass the full local parity suite (`npm test`) — must match n8n byte-for-byte.
2. Owner creates a free Cloudflare account; `wrangler d1 create khair_mart_jumla`; apply `schema.sql`.
3. Export live n8n data tables → import into D1; verify row counts + money/stock totals.
4. Run the Worker **in parallel** with n8n (apps still on n8n); mirror real requests and
   diff responses for a few days.
5. Flip the apps' `CONFIG` backend URL to the Worker. Keep n8n frozen as instant rollback
   for a week, then decommission.

Phase 2 (later): WhatsApp (official Cloud API) + cold-storage → Lalamove dispatch, built
directly on this backend.

## Status — all five workflows ported (28/28 parity tests pass)

One Worker routes every endpoint by path (`src/index.js`), all on one D1 database:

| Endpoint | Path | Notes |
|----------|------|-------|
| POS      | `/webhook/khair-pos`       | login, sales, inventory, payments, approvals, returns, shifts |
| Field    | `/webhook/khair-field`     | rep bootstrap, day start/end, tracks, check-in, orders, product images |
| Chat     | `/webhook/khair-chat`      | bootstrap, poll, send, retention |
| Attendance | `/webhook/khair-att`     | worker save/enroll, tamper-proof hash chain (pure-JS sha256) |
| Photo    | `/webhook/khair-pos-photo` | supplier notes / exit receipts / payment slips |

Secrets: `STORE_KEY` (required). `ANTHROPIC_API_KEY` (optional) enables the photo AI reader;
without it, photos still save for manual check (`perlu_cek`) — exactly as the n8n workflow
behaved when its AI step failed. The photo image itself is kept in Cloudflare R2 (v36, see
"Photo storage" below) instead of Google Drive.

**Not yet deployed. Live service is still on n8n and untouched.** Cut-over steps are in
`migrate/README.md` (parallel run + instant rollback, no downtime).

## Automatic deploy (GitHub Actions) — v36

Since v36 nobody runs `wrangler deploy` by hand. `.github/workflows/worker-deploy.yml` runs on every
push to `main` that touches `khair-pos/backend/**` or `khair-pos/worker/**` (and on demand: GitHub →
Actions → "Deploy Worker" → Run workflow):

1. `npm ci && npm test` (build + the full Worker suite). A red test never deploys.
2. Photo storage: creates the R2 bucket `khair-mart-photos` if it is missing and, **only if the bucket
   exists**, adds the `PHOTOS` binding to `wrangler.toml` for that deploy (the committed `wrangler.toml`
   has no binding, because a deploy that binds a missing bucket fails). A token without R2 permission
   still deploys everything else — photos are then simply not kept.
3. `npx wrangler deploy` — `keep_vars = true` keeps the secrets/variables set in the Cloudflare dashboard
   (`STORE_KEY`, `GOOGLE_PLACES_KEY`, `ANTHROPIC_API_KEY`).
4. Smoke test of the live Worker (a request with a wrong store key must answer `BAD_KEY`); if it does not
   answer, `wrangler rollback` restores the previous version at once and the run turns red (GitHub e-mails
   the owner).

Two deploys never overlap (`concurrency: worker-deploy`). Without the token secret the workflow tests
the code and skips the deploy with a notice (no red failure). `.github/workflows/tests.yml` runs the
Worker suite and the three Playwright suites (owner, kasir, sales — one job each) on every pull request
and push to `main`, and checks that the committed `src/generated/*` and `schema.sql` match `backend/*`.

### Owner's one-time setup (about 5 minutes)

**A. Turn on R2 (photo storage, free up to 10 GB)** — skip if R2 is already on.
1. Open https://dash.cloudflare.com and log in.
2. Left menu → **R2 Object Storage** → **Overview**.
3. If you see **Purchase R2 Plan** / **Enable R2**, press it and confirm the free plan
   (Cloudflare may ask for a card; the free tier is 10 GB storage, 1M writes, 10M reads per month,
   and the shop uses far less — the bill stays 0).

**B. Create the API token.**
1. Cloudflare dashboard → top-right person icon → **My Profile** → **API Tokens** → **Create Token**.
2. Next to **Edit Cloudflare Workers** press **Use template**.
3. Under **Permissions** make sure these rows exist (press **+ Add more** for missing ones):
   - Account · **Workers Scripts** · **Edit**
   - Account · **D1** · **Edit**
   - Account · **Workers R2 Storage** · **Edit**
   (the template's other rows can stay).
4. **Account Resources**: Include · *the Khair Mart account*. **Zone Resources**: All zones (or leave as the template sets).
5. **Continue to summary** → **Create Token** → press **Copy** (the token is shown only once).

**C. Give the token to GitHub.**
1. Open https://github.com/officezied-prog/zied → **Settings** (top bar of the repo).
2. Left menu → **Secrets and variables** → **Actions**.
3. **New repository secret** → Name: `CLOUDFLARE_API_TOKEN` → Secret: paste the token → **Add secret**.
4. (Optional) Another secret `CLOUDFLARE_ACCOUNT_ID` = `c82e2561b81c97de7c59166d7a915924` — the
   workflow already uses this value when the secret is missing.

**D. First run.** Repo → **Actions** → **Deploy Worker** → **Run workflow** → **Run workflow**. A green
tick = deployed. The "Photo storage" step says either "Photos will be stored in R2 bucket
khair-mart-photos" or a yellow warning explaining why not (R2 off / token without R2 permission).

If the token expires or is revoked, deploys are skipped with a notice until a new one is saved in step C.

## Photo storage (Cloudflare R2) — v36

Owner asked to keep the photos ("فعّل حفظ الصور عبر Google Drive"). Chosen: **Cloudflare R2 in this same
Worker** — most reliable (no extra login or Google credential to expire, and kept apart from the D1
database, so photos can never fill the POS database and stop sales) and cheapest (free up to 10 GB;
the apps already shrink photos to ±200–500 KB, i.e. ~20,000+ photos). Google Drive would match the
words of the request but needs a Google service account / OAuth token that can expire and stop uploads.

- Binding `PHOTOS` (bucket `khair-mart-photos`), added at deploy time by the workflow (see above).
- Each scan (`scan_purchase`, `scan_exit`, `scan_payment`, `scan_supplier_return`, `scan_expense`) stores
  the image as uploaded under `photos/YYYY-MM/<photo_id>.<jpg|png|webp>`; the row gets
  `drive_file_id = "r2:<key>"`, `drive_url = https://<worker>/webhook/khair-pos-photo/file/<photo_id>`.
  A storage error never fails the scan (the row is saved without a link). No binding → exactly as before.
- `GET /webhook/khair-pos-photo/file/<photo_id>` streams it to **owner / manager / akuntan** only, with the
  usual credentials as headers (`X-Khair-Key`, `X-Khair-User`, `X-Khair-Pin`), `Cache-Control: private,
  max-age=31536000, immutable`. The owner app opens it with "📷 Lihat foto".
- Field visit photos (`pos_visits.photo_thumb`, ≤ 45 KB) and chat images (`pos_chat.image`, ≤ 130 KB) are
  already stored whole in D1 as the app sends them (the apps shrink them before sending), so nothing is lost there.
- Tests: `test/photo-store.test.js` (R2 mocked in `test/shim.js`).
