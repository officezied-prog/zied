# Khair POS — code backend (Cloudflare Workers + D1)

This is the **direct-code backend** that replaces the n8n Cloud workflow for the POS API.
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
2. Owner creates a free Cloudflare account; `wrangler d1 create khair_pos`; apply `schema.sql`.
3. Export live n8n data tables → import into D1; verify row counts + money/stock totals.
4. Run the Worker **in parallel** with n8n (apps still on n8n); mirror real requests and
   diff responses for a few days.
5. Flip the apps' `CONFIG` backend URL to the Worker. Keep n8n frozen as instant rollback
   for a week, then decommission.

Phase 2 (later): WhatsApp (official Cloud API) + cold-storage → Lalamove dispatch, built
directly on this backend.

## Status

- **POS API** (`/webhook/khair-pos`): ported + tested (login, sales, inventory, payments,
  approvals, returns, shifts). 16/16 parity tests pass.
- **Field API** (`/webhook/khair-field`): ported + tested (bootstrap, day start/end, tracks,
  check-in, orders, product images). Routed in `src/index.js` by path.
- Remaining to be fully off n8n: chat, attendance, photo (AI) workflows.
- Not yet deployed. Live service is still on n8n and untouched.
