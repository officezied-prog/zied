# Khair Mart POS — project notes

Self-contained HTML PWAs under `khair-pos/` (owner `index.html`, cashier `kasir/`,
field-sales `sales/`, cold-storage `gudang/`), served via GitHub Pages from `main`.
Tests: Playwright under `khair-pos/tests*`.

**Live app links (GitHub Pages):**
- Owner / manager / accountant (المالك/المدير/المحاسب): https://officezied-prog.github.io/zied/khair-pos/
- Cashier (الكاشير): https://officezied-prog.github.io/zied/khair-pos/kasir/
- Field sales rep (المندوب): https://officezied-prog.github.io/zied/khair-pos/sales/
- Cold storage (البرادات): https://officezied-prog.github.io/zied/khair-pos/gudang/

**Backend = "Khair Mart Jumla" (الخير مارت جملة) — LIVE since 2026-10-10.** The owner, cashier
and field-sales apps point at the Cloudflare Worker `https://khair-mart-jumla.officezied.workers.dev`
(D1 database `khair_mart_jumla`, account `c82e2561b81c97de7c59166d7a915924`). Source under
`khair-pos/worker/`: all five workflows (POS, Field, Chat, Attendance, Photo) built from
`khair-pos/backend/*` (the single source of truth, wrapped at build time) — so edit backend
logic in `backend/*`. **Deploy is automatic (v36):** `.github/workflows/worker-deploy.yml` tests and deploys the
Worker on every push to `main` that touches `khair-pos/backend/**` or `khair-pos/worker/**`, once the owner has added
the repo secret `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + D1:Edit + Workers R2 Storage:Edit); it creates/binds
the R2 photo bucket `khair-mart-photos` when it can, smoke-tests and rolls back on failure. Without the secret it
skips with a notice (manual fallback: `cd khair-pos/worker && npm run build && npx wrangler deploy`). New D1
columns/tables are added by the Worker itself at runtime (no migration step). `.github/workflows/tests.yml` runs
the worker tests + the three Playwright suites on every PR. This removed n8n's monthly execution wall (the outage cause).

- **n8n (ziedapp.app.n8n.cloud) is KEPT PERMANENTLY as a reference — NEVER delete or modify it**
  (owner's standing instruction). It also stands as instant rollback: revert the apps' host
  swap (`ziedapp.app.n8n.cloud` ↔ the Worker host) in `index.html`/`kasir/`/`sales/` + CSP.
- Google Places search (field app, v34) runs ONLY in the Worker with the secret `GOOGLE_PLACES_KEY` (set by the owner in the
  Cloudflare dashboard — never in the repo/apps); hard cap 4,500 calls/month (`pos_api_usage`) < Google's free 5,000 →
  bill 0; over the cap / no key → the apps keep the free OpenStreetMap search. Only "Pro" fields (no phone/rating/hours).
- `gudang/` (cold storage, `/webhook/khair-cold`) moved to the Worker in Batch C (PR #22) and is shown inside the owner
  app; Phase 2 proper (WhatsApp + Lalamove) is still to do (plan in `khair-pos/worker/docs/phase2-plan.md`).

## Owner standing rules — ALWAYS honor

- **Reliability FIRST, then cost (recommend best + cheapest, proactively).** The owner
  (Khair Mart, Jakarta) wants a system that is **strong, stable, and always-on**, that
  does NOT stop and does NOT depend on staff being present — he travels a lot and cannot
  babysit it or rely on employees to keep it running. So the top priority is a solution
  that keeps working on its own. He is still cost-conscious, but cost is the tie-breaker
  AMONG reliable options, not the first filter. For EVERY technical choice, state the
  **most reliable** option AND the **cheapest** option together, flag the trade-offs,
  and recommend BEFORE the owner decides — do not wait to be asked. (Owner's standing
  rules, set 2026-10-10, refined 2026-10-10: reliability over pure cost.)

- **Watch execution/running cost — but never at the expense of uptime.** The POS once
  hit the n8n Starter plan's monthly execution limit because the apps polled too often,
  and that one quota wall took down ALL apps (login failed for everyone) until support
  reset it. That "whole business stops at once, owner must intervene from abroad" failure
  mode is exactly what the owner wants gone. Keep backend calls lean (polls are throttled
  and pause when the tab is hidden; device ping is hourly), and when adding features,
  consider their recurring-cost impact — but prefer architectures with no hard monthly
  cap that can halt everything.

- **Merge it yourself — never ask.** Once a change is built, tested (the app's Playwright suites
  green) and pushed, open the PR and squash-merge it into `main` yourself; do not ask the owner
  "shall I merge?" (owner's standing instruction, 2026-10-11: "لا تسألني عن الدمج بعد الآن يجب أن
  تدمج أنت كل شيء"). Then tell him the new app version to check on the login screen.

- **Mixed Arabic/English text:** when writing Arabic and a word/term is English, put each
  English token on its own line, then continue the Arabic on a new line (keeps the
  right-to-left reading order clean).
