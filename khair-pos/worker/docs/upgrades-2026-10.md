# Owner upgrade requests — October 2026

Two batches from the owner (zied). Reliability-first, then cost. Backend logic lives in
`khair-pos/backend/*` (single source of truth, wrapped into the Worker at build time); apps are
`khair-pos/kasir/` (cashier), `khair-pos/sales/` (field rep), `khair-pos/index.html` (owner).
n8n is kept as reference — never touched.

## Approver / notification model (shared by #1, #6, #7 below)

- New `approver_role` value **`mgr_akuntan`** = manager OR accountant may decide. Owner can
  always decide. Accountant (`akuntan`, read-only till now) gains `list_approvals` +
  `decide_approval` but ONLY for `mgr_akuntan` approvals.
- Notifications = the activity log (`logAct`) the owner already watches, plus the approvals
  inbox the manager watches. When the ACCOUNTANT decides a `mgr_akuntan` item, an extra activity
  line is written addressed to the manager ("notify manager"); the owner sees the log either way.
- Owner app (`index.html`) must let `akuntan` see + decide the `mgr_akuntan` approvals (poll gate
  + `can_decide`). Manager already has the approvals inbox in the cashier app.

## Batch A — Cashier app (kasir/) 8 features

1. **Goods-receipt review + mismatch approval.** Invoice photo (AI reads items/qty via
   `scan_purchase`), receiver types the qty THEY counted. If counted ≠ invoice → raise a
   `purchase_mismatch` approval to manager+accountant (`mgr_akuntan`); accountant approve →
   notify manager. Stock-in is recorded at the counted qty immediately (goods physically present);
   the approval documents the discrepancy. Match → auto-accept, no approval. (Backend `save_purchase`
   already runs `matchNote`; add the approval + routing.)
2. **Carrier "friend" (teman).** When carrier = friend, add transport kind (motor/mobil) + plate
   number. `readCarrier` already stores type/name/vehicle/kind/phone — frontend adds the picker.
3. **Close drawer by denomination.** Enter count per banknote (100k/50k/20k/10k/5k/2k/1k + coins);
   app sums → counted_cash. Store breakdown in the shift `note` (no schema migration).
4. **Expenses: optional invoice photo + AI verify.** New photo action `scan_expense` (kind `biaya`)
   reads the invoice total; `save_expense` compares to the entered amount, flags mismatch (reason
   required), mirrors the debt-payment slip pattern.
5. **Remove member registration from the cashier.** Cashier cannot create members (remove
   `member-new` from More + the inline "make member" checkbox for role kasir). Backend `save_customer`
   rejects `member:true` from kasir. Registration by manager/accountant; owner+manager notified.
6. **Void today's invoice.** Cashier requests → manager OR accountant (`mgr_akuntan`). Manager
   approve → notify owner; accountant approve → notify manager + owner. (`request_void` approver_role
   owner → mgr_akuntan.)
7. **Price change.** Request → manager AND accountant (`mgr_akuntan`); owner notified. cost_price
   change stays owner-only. (`change_price` non-cost approver_role manager → mgr_akuntan.)
8. **Last receipt → last 4.** `last-rc` shows the last four receipts with times (picker), tap to
   open. `rememberReceipt` already keeps 40 locally.

## Batch B — Field-sales app (sales/) — NEW (owner msg 2026-10-10)

1. **Bigger map** on the daily route (currently small).
2. **Pre-start route plan (8am).** Before starting, the rep marks the route/start point/streets to
   work. App records streets already worked so they aren't repeated for a long time; reminds the rep
   to return to the best streets (those with customers + good response). The return interval to a good
   street is agreed with the manager; owner gets a notification.
3. **Visits table.** Columns: name, place, shop type, shop owner, rep's impression (star rating
   good/bad), optional note. A copy of the table goes to manager + accountant + owner for monitoring.
4. **New-shop registration.** Space to register a new shop with all data: location (GPS), photo,
   photo with the worker/owner, phone number, shop photo; any orders written in a dedicated place; app
   organizes it into the table.
5. **Order organization toggle.** Organize orders by region (to batch deliveries per region), by
   quantity, and by payment method — rep picks the grouping via a button.
6. **Orders on the map (numbered markers).** Each accepted order drops a marker at its shop's GPS
   location with a sequence number (acceptance order), so the owner sees which area/region has the
   most orders and who ordered first. Feasible with Leaflet markers + per-area count (same map as #1).

## Batch C — Cold-storage app (gudang/) — NEW (owner msg 2026-10-10)

1. **Customer registry.** Always register the customer with full details (name, address, phone) →
   a reusable customer list; tapping a customer auto-fills the rest of the entry.
2. **Home page = coolers.** Named coolers (e.g. Bosco, DP, BP). Each cooler shows the date type
   (نوع التمر) and its mode: chilling (تبريد) / storage (تخزين) / freezing (تجميد) / normal (براد عادي).
   Under each cooler name show the totals: how many pallets (palet), how many cartons (karton), how
   many kilograms (kg).

Order of work: finish Batch A (cashier) first (in progress), then Batch B (field), then Batch C
(cold storage). Phase 2 proper (cold inline + WhatsApp Cloud API + Lalamove dispatch) folds into
Batch C. gudang/ is still on n8n today — moves to the Worker as part of this.

## STATUS — 2026-10-10 (overnight)

**SHIPPED & LIVE:**
- **Batch A (cashier v29)** — all 8 features + the owner/manager/accountant login fix. Worker
  deployed; apps published (PR #19). 48/48 tests.
- **Batch B part 1 (field v30)** — bigger map + fullscreen, numbered order pins (#6), visit star
  rating (#3), order grouping region/largest/payment + payment_method (#5), accountant field-report
  read access, Today "next visits" grouped by region (#2 first slice). Worker deployed (self-migrates
  pos_visits.rating + pos_field_orders.payment_method on the first field write); apps published (PR #20).
  51/51 tests.
- **Installable apps** — PNG icons + manifests for all 4 apps, gudang made installable,
  `khair-pos/install.html` landing page (per-app cards + QR + per-platform install steps). Published.

**DEFERRED (not built overnight — need the owner / more definition):**
- Batch B #2 advanced: street-level tracking, manager-agreed return interval to good streets, owner
  notification. (First slice — plan by region — is shipped.)
- Batch B #4 second photo (with the owner): the new-shop form already captures
  name/owner/phone/address/area/type/GPS + 1 photo; a 2nd photo is a small follow-up.
- Downloadable Android **APK** (PWABuilder/Bubblewrap) — Android-only; iPhone installs via
  Add-to-Home-Screen regardless. The free PWA install already covers all platforms.

## STATUS — 2026-10-11 (v31)

- **البرادات inside the owner app** (owner: "it feels like a separate app; leaving asks me to log out"): the البرادات menu item
  now shows the cold-storage page INSIDE the owner app (same-site frame, same login, no second header); leaving is a normal
  page switch. Standalone gudang gets a "back to Khair Mart" button. Owner SW no longer serves the owner page for gudang/ offline.
- **Field route planner** (Batch B #2, owner 2026-10-11): before setting off the rep sets a start point AND an end point,
  picks one or more work streets (each searched for shops along the whole street) and/or shops near a point / by name
  (free OpenStreetMap search from the phone: Nominatim + Overpass) and our own shops, orders the stops (auto nearest-first),
  and saves the plan for today or tomorrow. Today card: progress, next stop, Google Maps (next / whole route), "Kunjungi"
  (a new place opens the new-shop form filled in). Every planned street is kept on a shared map (`streets_worked`, last
  60 days) so a second rep sees — and is warned about — streets a colleague already worked. Owner/manager see each rep's
  plan (streets, stops ✓ visited, end point) on the field page. Backend: `plan_save`, `streets_worked`, `pos_route_plans`
  (self-created by the Worker). Search provider: OSM now (free, no account); Google Places is the optional upgrade if
  small shops are missing.

## STATUS — 2026-10-11 (v32, PR #24 — live; Worker 0bb9f04e)

- **Bank page** (owner app): the owner's approval card stayed locked after switching login (render signature ignored the
  user); a recorded transfer did not show as money-out (bank list read a 2-minute sales cache). Fixed; transfer.spec green.
- **Work line drawn point by point** (field planner "Garis kerja"): map taps or "point at my position" (fresh GPS); then
  the kinds of shop to look for (dates, Hajj & Umrah, Muslim/Middle-East, oleh-oleh, minimarket, grocery, bakery/café,
  mosque) — free Overpass `around:100` the line, one colour per kind, in order along the line → stops (pins keep the colour).
  A line another rep already worked (≥ 30 % within 40 m) is warned.
- **Worked streets kept forever** (owner: "always, not 60 days"): `pos_street_log` (one row per street per plan + its map
  box), read around the rep (±0.2°), latest per street + rep; plans made before it were copied in by a one-time migration.
- **Visit result = colour**: green order · orange there, no order · blue does not want · black closed / owner not there /
  shop not found / changed business (new `tidak_ada`, `tidak_ditemukan`, `ganti_usaha`) — black needs a photo of the place
  (`photo_place`, no person's consent needed). Plan points, Today card counts, owner field page.
- **Map split by density**: crowded areas = one count bubble (tap = zoom in); only what is in view is drawn, redrawn on move.

## STATUS — 2026-10-11 (v33 — shops of a street from Google Maps, free)

- Owner's idea: the office (manager / accountant / cashier) sends the rep the shops of a street taken from Google Maps;
  or the rep does it himself. No Google key / no Places API cost: the text Google Maps gives when you SHARE or COPY a place.
- `shared/gmaps-import.js`: parser (name / address / phone / link; position from `!3d…!4d…`, `?q=lat,lng`, `@lat,lng` or a
  "lat, lng" line) + the office page (owner app view `shoplist` for owner/manager/accountant, cashier app Lainnya →
  "Daftar toko untuk sales").
- Server (`backend/field/process-field.js` + Worker): `list_reps`, `list_send` (office → a sales rep, date today … +14,
  ≤ 60 places), `lists_sent`, `list_ack`; `field_bootstrap` gives the rep his open lists; `resolve_links` — short links
  (maps.app.goo.gl) are followed by the Worker (`worker/src/gmaps.js`: redirects only, no page read, Google hosts only,
  ≤ 8 links × 3 hops). Table `pos_shop_lists` (self-created). The kasir / akuntan may call ONLY these list actions here.
- Field app: an office list goes straight into the plan of its day (street + stops, phone kept); a place without a
  position waits in "Belum ada titik" — looked up on OpenStreetMap, or the rep taps "Di peta" then the map. The rep can
  also paste in the planner ("📋 Google Maps") or share from Google Maps to the installed app (Web Share Target, Android;
  iPhone: paste).

## STATUS — Batch C (2026-10-10)

**CODE DONE (on the dev branch, not yet cut over):**
- Worker port of the cold workflow: `worker/src/cold.js` (handleCold), build wrap `runProcessCold`
  (cold-parsers + cold-core + process-cold), `/webhook/khair-cold` route, 7 `cold_*` tables in
  `tables.js` + `OPS_TABLE_COLD`, runtime self-migration (CREATE TABLE IF NOT EXISTS — the cold_*
  tables are new to D1). The separate n8n "Check Key" node is synthesized in handleCold.
- Feature (a) **customer registry**: `customer_save` action + `customers` in bootstrap, reusing the
  shared `pos_customers` (edits never touch POS-only columns). gudang: a "Pelanggan" tab (list +
  add/edit) and a customer picker in the order form (tap-to-fill name/address, links the order).
- Feature (b) **coolers home page**: a `mode` on each cooler (tabrid/takhzin/tajmid/biasa) + the
  dashboard reworked into named-cooler cards with mode, date varieties and totals (pallets/cartons/kg).
- gudang host swapped to the Worker (both hosts in the CSP, so rollback = one-line COLD_URL revert).
  Demo mode updated (shared/cold-mock.js). 61/61 worker tests pass; demo verified in a headless browser.

**STILL TO DO before cut-over (needs the Worker deploy + data move, keep n8n as rollback):**
1. Redeploy the Worker (now carries the cold route) — sibling session with the Cloudflare token.
2. Move the existing cold data from the n8n data tables → D1 (if any), then parallel-run verify.
3. Merge the dev branch → main (host swap goes live). n8n untouched as instant rollback.

## Batch C — cold storage (gudang) — PLAN (do WITH the owner, not unattended)

NOT started overnight on purpose: it migrates the live gudang app off n8n (which must stay untouched)
and touches a live surface, so it deserves the owner present + a parallel-run/rollback like the
Phase-1 cut-over, rather than an unattended deploy.

Approach (reuses the proven pattern):
1. Port `backend/cold/*` into the Worker like the other four workflows (build.js wrap → runProcessCold,
   routed at `/webhook/khair-cold`); keep n8n as instant rollback (host swap).
2. **Customers**: reuse `pos_customers` with a segment flag so the cold app shows a reusable list
   (name + address + phone), tap-to-fill. Unified with the rest of the system (recommended).
3. **Coolers home page**: `pos_coolers` (id, name e.g. Bosco/DP/BP, mode = tabrid/takhzin/tajmid/biasa,
   owner-editable) + `pos_cold_stock` (cooler_id, date variety, pallets, cartons, kg). Home lists each
   cooler with its mode + date type and the totals underneath (pallets / cartons / kg).
   - **Ask the owner** (default if unanswered: interdependent): are pallet/carton/kg linked
     (1 pallet = N cartons = M kg per variety)? If yes, enter one → compute the rest; else enter all three.
4. Then Phase-2 proper: WhatsApp Cloud API + Lalamove dispatch (see phase2-plan.md).
