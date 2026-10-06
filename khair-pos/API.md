# Khair Mart POS — API contract

Frontend: static `khair-pos/index.html` (GitHub Pages).
Backend: one n8n workflow, `POST https://ziedapp.app.n8n.cloud/webhook/khair-pos`
(JSON in, JSON out, CORS allowed for `https://officezied-prog.github.io`).
Data lives in n8n data tables (prefix `pos_`), which the AI agents also read.

## Request envelope

```json
{
  "action": "save_sale",
  "key": "<store key, entered once per device>",
  "user": "Siti",
  "pin_hash": "<sha256 hex of `${key}:${user.toLowerCase()}:${pin}`>",
  "data": { }
}
```

Every response is `{ "ok": true, ... }` or `{ "ok": false, "error": "CODE", "message": "human text" }`.
Error codes: `BAD_KEY`, `BAD_PIN`, `NO_USERS`, `FORBIDDEN` (role), `INVALID` (bad data), `NOT_FOUND`, `SERVER`.

Roles: `owner` (everything), `kasir` (sell, customers, payments, purchases, products read-only;
never receives `cost_price`, `total_cost`, `profit`, `line_profit`, `cost` fields).

## Actions

| action | who | data | response |
|---|---|---|---|
| `users` | key only (no user/pin) | – | `users: [{name, role}]` (empty ⇒ show setup) |
| `setup` | key only, only while no users exist | `{owner_name, pin_hash}` | `user: {name, role:"owner"}` |
| `login` | any | – | `user: {name, role}` |
| `bootstrap` | any | – | `products[], customers[], settings{}, users[{name,role,active}], server_time` |
| `save_sale` | any | see Sale below | `invoice_no, sale: {...}, stock: [{product_id, stock}], duplicate: bool` |
| `void_sale` | owner | `{invoice_no, reason}` | `sale` |
| `save_product` | owner | Product (with `id` to update; `stock` only used on create) | `product` |
| `import_products` | owner | `{rows: [Product without id]}` upsert by `sku`, else by exact `name` | `created, updated` |
| `stock_adjust` | owner | `{product_id, new_stock, reason}` | `product` |
| `save_customer` | any | Customer (with `id` to update; `debt_balance` ignored). `name` is optional when a phone is given (default "Pelanggan " + last 4 digits). Without `id`, a customer with the same normalised phone (62…) is updated instead of duplicated. `wa_optin`, `source` (≤ 20) | `customer`, `existed` |
| `stock_count` | any except sales | `{counts: [{product_id, counted}], note}` (stock count / opname, ≤ 500 lines) | `applied, lines: [{product_id, name, unit, system, counted, diff}]`. Owner: applied now, `stock`. Others: `request_id, approval` (kind `opname`, owner decides); on approval each `diff` is added to the stock at that moment, so sales made meanwhile are kept. Every change is logged as a purchase row with supplier `STOK OPNAME` |
| `receive_payment` | any | `{customer_id, amount, method, note, pay_date}` | `payment, customer` |
| `save_purchase` | any | `{purchase_date, supplier, note, items:[{product_id, qty, cost_price, exp_date? (YYYY-MM-DD, expiry of this batch)}]}` | `stock: [{product_id, stock, cost_price}]` |
| `get_sales` | any (kasir: cost/profit stripped) | `{from: "YYYY-MM-DD", to: "YYYY-MM-DD"}` inclusive | `sales[], items[], payments[], purchases[]` |
| `save_settings` | owner | `{settings: {...}}` (merged) | `settings` |
| `save_user` | owner | `{name, role, pin_hash?, active}` (create or update by name) | `user` |

## Objects

**Product**: `id, sku, name, category, unit, cost_price, retail_price, wholesale_price, wholesale_min_qty, stock, min_stock, active (bool), notes`

**Customer**: `id, name, phone, type ("grosir"|"eceran"), address, notes, debt_balance, wa_optin (bool), source`

**Settings**: `store_name, address, phone, receipt_footer, paper ("58"|"80"), survey_questions: [string], wa_shop_number (shop WhatsApp to notify about new numbers), survey_voice (bool, default true)`

**Sale (request)**:
```json
{
  "client_id": "uuid generated on device (idempotency)",
  "sale_date": "YYYY-MM-DD (Asia/Jakarta)",
  "sale_time": "ISO timestamp",
  "customer_id": 12, "customer_name": "Toko Berkah", "customer_type": "grosir",
  "items": [{"product_id": 3, "qty": 2, "unit_price": 45000, "price_type": "grosir"}],
  "discount": 0,
  "payment_method": "tunai|transfer|qris|hutang",
  "paid_amount": 90000,
  "survey": [{"q": "Tahu Khair Mart dari mana?", "a": "dari TikTok"}],
  "survey_consent": true,
  "survey_transcript": "…text of the recorded survey conversation (≤ 4000 chars, stored only with survey_consent)…",
  "notes": ""
}
```
Server recomputes everything from the product table: `subtotal = Σ qty×unit_price`,
`total = subtotal − discount`, `total_cost = Σ qty×cost_price(current)`, `profit = total − total_cost`,
`debt_amount = max(0, total − paid_amount)` (only allowed when `customer_id` is set),
stock −= qty, customer `debt_balance += debt_amount`.

**Sale (stored)**: `id, invoice_no, sale_date, sale_time, cashier, customer_id, customer_name, customer_type,
subtotal, discount, total, total_cost, profit, payment_method, paid_amount, debt_amount, status ("ok"|"void"),
survey (JSON string), notes, client_id`

**Sale item**: `invoice_no, sale_date, product_id, sku, name, qty, unit_price, price_type, cost_price, line_total, line_profit, customer_name`

**Payment**: `id, pay_date, customer_id, customer_name, amount, method, note, cashier`

**Purchase line**: `id, purchase_date, supplier, product_id, name, qty, cost_price, total, note, user, photo_id`
(cost_price of the product becomes the weighted average of old stock and new stock).

## Roles (v2)

`owner` (everything), `manager` (like kasir, never sees cost/profit, but can APPROVE credit sales and
sees the approvals inbox), `kasir`. `save_user` accepts `role: "manager"`.

## Credit (hutang) approval (v2)

A sale with `debt_amount > 0` made by a `kasir` is refused with `APPROVAL_REQUIRED` unless it carries ONE of:

1. **On-site approval** — `data.approver = {user, pin_hash}` of an active owner/manager
   (`pin_hash` = sha256 of `${key}:${approver.toLowerCase()}:${pin}`), typed on the cashier device.
2. **Remote approval** — `data.approval_id` of an approval that is `approved`, has the same `client_id`
   and `customer_id`, and whose `total`/`debt_amount` are ≥ the sale's. The approval becomes `used`.

Owner/manager selling themselves need nothing extra. Stored sale gets `approved_by`.

| action | who | data | response |
|---|---|---|---|
| `request_credit` | any | the full Sale request (same fields as `save_sale`, incl. `client_id`, customer, items, paid_amount) | `request_id, approval` |
| `check_approval` | any | `{request_id}` | `approval: {request_id, status: pending/approved/rejected/used, decided_by, decided_at, note, total, debt_amount, ...}` |
| `list_approvals` | owner/manager | – | `approvals: [pending...]` |
| `decide_approval` | owner/manager | `{request_id, decision: "approved"|"rejected", note}` | `approval` |

`bootstrap` also returns `approvals_pending` (count) for owner/manager.

**Approval**: `request_id, client_id, created_at, cashier, customer_id, customer_name, customer_debt_before, total, debt_amount, summary, status, decided_by, decided_at, note`

## Photos: goods in / goods out (v2)

- **Barang masuk:** `save_purchase` requires `data.photo_id` (a photo of kind `masuk` created by the photo
  endpoint) unless setting `require_purchase_photo` is `false`. Every purchase line stores `photo_id`.
- **Barang keluar besar:** `save_sale` marks a sale `exit_photo: "required"` when `total ≥ exit_photo_min_total`
  (default 1 000 000) or any line `qty ≥ exit_photo_min_qty` (default 20); otherwise `""`.
  Response includes `exit_photo_required: bool`. When the exit photo is attached the sale gets
  `exit_photo = <photo_id>` and `exit_match = cocok | tidak_cocok | perlu_cek`.
- New settings keys: `exit_photo_min_total`, `exit_photo_min_qty`, `require_purchase_photo`.

**Photo endpoint:** `POST https://ziedapp.app.n8n.cloud/webhook/khair-pos-photo`, same envelope
(`text/plain` JSON), any role. Images: JPEG, resized on the device to max 1600 px, sent as base64
without the `data:` prefix (≈ 200–500 KB). Each call takes ~5–20 s (AI reading).

| action | data | response |
|---|---|---|
| `scan_purchase` | `{image_base64, mime}` photo of the supplier note / goods arriving | `photo_id, extracted: {supplier, date, invoice_no, items: [{name, qty, unit, unit_price, total}], total}, suggestions: [{index, product_id, product_name, score}], drive_url` |
| `scan_exit` | `{invoice_no, image_base64, mime}` photo of the printed receipt / goods leaving | `photo_id, extracted: {items: [...]}, match: {status: "cocok"|"tidak_cocok"|"perlu_cek", notes, diffs: [{name, recorded_qty, photo_qty}]}, drive_url` |
| `list_photos` | `{from, to}` | `photos: [{photo_id, kind, ref, created_at, photo_date, user, drive_url, extracted, match_status, match_notes}]` |

`drive_url` may be empty while Google Drive storage is not connected yet.

## Protected changes: old invoices and prices (v3)

Owner's rules:

- Cancelling or fixing an old invoice needs the **owner** (personal approval).
- Changing a **wholesale (grosir) or retail price** needs the **owner or manager**.
- Changing the **cost price** (harga modal / harga masuk pertama) needs the **owner**.

All of them go through `pos_approvals`, which now also has `kind` (`credit` | `void` | `price`),
`ref` (invoice_no or product_id), `payload` (JSON string) and `approver_role` (`manager` = owner or
manager may decide, `owner` = only the owner). Every price change (direct or approved) leaves a row,
so the history of who changed which price and when is kept (`status: "auto"` when applied directly
by someone allowed to).

| action | who | data | response |
|---|---|---|---|
| `request_void` | any | `{invoice_no, reason}` | `request_id, approval` (kind `void`, approver_role `owner`) |
| `change_price` | any | `{product_id, retail_price?, wholesale_price?, cost_price?, reason}` (only the fields that change) | applied directly if the caller may: `applied: true, product`; else `applied: false, request_id, approval` |
| `decide_approval` | owner/manager (`approver_role` respected) | `{request_id, decision, note, invoice_no?}` — for kind `void` send `invoice_no: approval.ref` | `approval` (+ `sale` when a void was executed, + `product` when a price was applied, + `stock` when an `opname` count was applied) |
| `list_approvals` | owner/manager | – | `approvals: [pending...]`, each with `can_decide: bool` |

`void_sale` stays owner-only (owner can cancel directly). `save_product` stays owner-only; when it
changes prices of an existing product, an `auto` price row is logged too.
Error `NEEDS_OWNER` when a manager tries to decide an owner-only request.

To "edit" an old invoice: the void is approved, then the sale is entered again (new invoice).

## Expenses (v3)

| action | who | data | response |
|---|---|---|---|
| `save_expense` | any | `{expense_date, category, amount, note, photo_id?}` | `expense` |

`category`: `sewa` (rent), `gaji` (salary), `listrik_air` (power/water), `transport`, `iklan` (ads),
`kemasan` (packaging), `perawatan` (maintenance), `lain` (other).
`get_sales` also returns `expenses[]` (same date range; kasir/manager see them too).

**Expense**: `id, expense_date, category, amount, note, user, photo_id`

## Annual report (frontend, owner only)

`get_sales` for `YYYY-01-01..YYYY-12-31` (and the previous year for comparison). The frontend computes:

- per month: revenue (`Σ total`, status ok), cost of goods (`Σ total_cost`), gross profit, expenses, net profit, margin %;
- variance: change vs the previous month and vs the same month last year (%);
- per product: qty, revenue, cost, profit, margin %, share of total profit;
- per category and per expense category;
- year totals plus a P&L (laba rugi) summary that can be copied or printed.

## Shifts / Kas Kasir (v4)

Every kasir/manager must open a shift before selling (`SHIFT_REQUIRED` otherwise; owner exempt;
setting `require_shift`, default `true`). The server keeps running totals on the shift, so the
expected cash in the drawer is computed by the server, not the device.

| action | who | data | response |
|---|---|---|---|
| `open_shift` | any | `{opening_cash, shift_date?, note?}` | `shift` (`already: true` if one is open) |
| `cash_move` | any (own open shift) | `{type: "in"|"out", amount, note}` (note required) | `shift` |
| `close_shift` | any (own); owner/manager may pass `cashier` to close someone else's | `{counted_cash, note?, cashier?}` | `shift` with `expected_cash, counted_cash, difference` |

expected cash = opening_cash + cash_sales + cash_payments + cash_in − cash_out, where:

- `cash_sales` = Σ min(paid, total) of `tunai`/`hutang` sales;
- `cash_payments` = cash debt payments;
- `cash_out` includes expenses with `paid_from: "kas"`.

`difference` = counted − expected (negative = cash missing).

Blind count: while a shift is open, a kasir never receives `cash_sales, cash_payments, sales_total, expected_cash`.
`bootstrap` adds `shift` (mine or null) and, for owner/manager, `open_shifts[]`. `get_sales` adds `shifts[]` (by `shift_date`).

**Shift**: `shift_id, cashier, shift_date, opened_at, closed_at, status (open|closed), opening_cash, cash_sales, cash_payments, cash_in, cash_out, sales_count, sales_total, expected_cash, counted_cash, difference, moves (JSON list), note`

Sale gets `channel` (`toko|whatsapp|shopee|tiktok|tokopedia|web|lainnya`, default `toko`), `promo_code`
(uppercase A–Z 0–9 _ -, e.g. campaign code `KHAIR1111`) and `shift_id`. Expense gets `paid_from` (`kas|lain`).
Any failed request writes nothing.

## Field sales: Khair Sales (v8)

Endpoint: `POST https://ziedapp.app.n8n.cloud/webhook/khair-field` (separate workflow), same envelope and
auth as the main API (`key`, `user`, `pin_hash`). New role **`sales`** (field rep / distributor), created by
the owner with `save_user {role: "sales"}`. Sales reps use the app at `khair-pos/sales/`.

Tracking rules (privacy, UU PDP):
- GPS is recorded only between "Mulai kerja" and "Selesai kerja", which the rep presses.
- The rep gives one-time consent in the app, and the app shows a visible indicator while tracking.
- A web app cannot track while the phone is locked or the app is closed. Points are taken while the app is
  open, plus at every check-in.

| action | who | data | response |
|---|---|---|---|
| `field_bootstrap` | sales, owner, manager | – | `user, products[] (no cost fields), images_version, shops[] (mine for sales, all for owner/manager), customers[] (grosir only), day: {status: "off"|"working"|"ended", started_at, ended_at, visits_today, km_today}, orders[] (sales only: own orders of the last 30 days, with status + status_note; empty for owner/manager), settings` |
| `day_start` | sales | `{lat, lng, acc, at?}` | `day` |
| `day_end` | sales | `{lat, lng, acc, note, at?}` | `day` (with `km_today`, `visits_today`, `orders_today`) |
| `track` | sales | `{points: [{lat, lng, acc, t (ISO), speed?, battery?}]}` max 200 per call; ignored when the day is not started; a point already stored today (same `t` + position) is skipped, so a resent batch is safe | `saved, ignored` |
| `check_in` | sales | `{client_id, lat, lng, acc, shop_id?, shop: {name, owner_name, phone, address, area, type (one of the ids in `shared/shop-types.js`, e.g. perlengkapan_haji, toko_kurma, warung, grosir_sembako, minimarket, supermarket, bakery, masjid, lainnya), type_other? (own words when type is lainnya, ≤ 60), chain? (e.g. Indomaret, Superindo, ≤ 40)}; with `shop_id` a sent `shop.type`/`chain` re-categorises the shop, photo_base64? (JPEG ≤ 400 px, ≤ 45 KB of base64, stored as `photo_thumb` until Google Drive is connected), photo_consent: true, outcome (order/tertarik/tidak/tutup/sudah_pelanggan), notes, next_visit? (YYYY-MM-DD), at?}` | `visit, shop` (new shop created when `shop_id` is missing) |
| `field_order` | sales | `{client_id, shop_id, visit_id?, items: [{product_id, qty, unit_price, price_type}], notes, delivery_date?}` | `order` (status `baru`) |
| `list_field` | owner, manager | `{from, to (≤ 1 year), user?, include_tracks? (default true; tracks only for ranges ≤ 7 days), photo thumbnails only for ranges ≤ 31 days}` | `tracks[], visits[], shops[], orders[], days[]` |
| `update_order` | owner, manager | `{order_id, status: "diproses"|"dikirim"|"batal", note, invoice_no?}` | `order` |
| `set_product_image` | owner, manager | `{product_id, image_base64 (JPEG ≤ 400 px, ≤ 60 KB)}` | `ok` |
| `product_images` | any | `{ids?: [product_id]}` | `images: [{product_id, image_base64}]` |
| `link_shop` | owner, manager | `{shop_id, customer_id}` | `shop` (status `pelanggan`, linked to the customer; create the customer first with `save_customer`) |

`client_id` makes `check_in` and `field_order` idempotent: a resend returns the stored row.

`at` (ISO, optional) is when the rep actually tapped the button on the phone. The app sends it so that an action queued offline keeps its real time when it syncs later. The server uses it for `started_at`, `ended_at` and `visit_time` only if it is on the same Jakarta day, at most 36 h old and not in the future; otherwise it uses server time.

**Objects**:
- **Shop** (`pos_shops`): `shop_id, name, owner_name, phone, address, area, type, lat, lng, created_by, created_at, last_visit_at, visits, status (prospek/pelanggan), customer_id, next_visit`
- **Visit** (`pos_visits`): `visit_id, client_id, user, visit_date, visit_time, shop_id, shop_name, lat, lng, acc, distance_m (from the shop's saved location), outcome, notes, next_visit, photo_thumb (base64 ≈ 320 px), drive_url`
- **Track point** (`pos_tracks`): `user, track_date, t, lat, lng, acc, speed, battery`
- **Field day** (`pos_field_days`): `user, day_date, started_at, ended_at, start_lat, start_lng, end_lat, end_lng, km, visits, orders, note`
- **Field order** (`pos_field_orders`): `order_id, client_id, user, order_date, order_time, shop_id, shop_name, items (JSON), total, notes, delivery_date, status, status_note, invoice_no, updated_by`

Prices in field orders are set by the server: wholesale when the shop is linked to a grosir customer or qty ≥ wholesale_min_qty, otherwise retail. The rep cannot
change them. An order becomes a real sale only when the owner/manager or the store processes it in the owner
app ("Proses" loads it into the cart; `invoice_no` is saved back with `update_order`).

Images: the client resizes before sending. Products get `image_updated` (ISO) whenever their image changes;
clients cache images per product and re-fetch only the changed ones.

Mock mode: demo field rep **Ahmad** (role `sales`, PIN 4444) with about 14 days of seeded days, tracks around
Condet/Kramat Jati/Cililitan, visits, shops (prospek and pelanggan) and orders. Mock mode keeps these tables inside `kmock.db` under the keys `shops`, `visits`, `tracks`, `field_days`,
`field_orders` and `product_images`, with the shapes above.

## Devices: where each app is open (v11)

Every request may carry `data.device = {id, app: "owner"|"kasir"|"sales", label, lat, lng, acc, loc_status: "granted"|"denied"|"unavailable"|"prompt"|"off", battery?}`.
`id` is a random id the app keeps per browser (8–64 chars `[A-Za-z0-9_-]`); `label` is a short device description made on the
phone (e.g. "Android · Chrome", "Windows · Edge"). The server writes the row (`pos_devices`) only when something changed
(new device, another user, status changed, moved more than 100 m) or every 10 minutes, so location costs no extra executions.
The server also stores the request IP and user agent. A first-time device is written to the activity log.

| Action | Who | `data` | Response |
|---|---|---|---|
| `device_ping` | any (also sales) | `{device}` — on app open/login and every 30 min while idle | `require_location` (bool), `server_time` |
| `list_devices` | owner | – | `devices: [{device_id, user, role, app, label, ua, ip, lat, lng, acc, loc_status, loc_at, first_seen, last_seen, pings, battery}]` (newest first), `store: {lat, lng}` |

Settings: `store_lat`, `store_lng` (shop location; "use my location" button), `require_device_location` (default false: when true the
kasir/manager apps do not open until location is allowed). Location is asked only after a consent notice
("Lokasi perangkat ini dibagikan ke pemilik toko selama aplikasi dibuka"); a computer's location is approximate (Wi-Fi/IP).

## Repacking in the shop, supplier per product (v12)

Products gain `supplier` (default supplier, ≤ 80), `repack_from` (id of the bulk product it is packed from, 0 = none) and
`repack_qty` (how much of the bulk product's unit goes into one piece, e.g. 0.5 kg). `save_product` (owner) accepts them;
`import_products` accepts `supplier`.

| Action | Who | `data` | Response |
|---|---|---|---|
| `repack` | owner, manager | `{to_product_id, to_qty (pieces made), from_qty? (bulk used; default to_qty × repack_qty), packaging_cost?, exp_date?, note, date?}` | `repack: {repack_id, repack_date, from_*, to_*, pack_size, expected_qty, yield_pct, loss_qty, exp_date, note, (owner: packaging_cost, unit_cost)}`, `stock` |

Bulk stock goes down, pack stock goes up; the pack's cost price becomes the weighted average with
`unit_cost = (from_qty × bulk cost + packaging_cost) / to_qty`. Two purchase rows with supplier `KEMAS ULANG` are logged
(−from_qty on the bulk product, +to_qty on the pack). `get_sales` also returns `repacks` for the range (cost fields owner only).
Fails if the bulk stock is not enough.

## Goods-in checked against the supplier note, locked after saving (v12)

`save_purchase` items may carry `photo_index` (the line of the photographed note they came from). With a `photo_id`, the server
compares every typed line with the note read by the photo workflow (`scan_purchase`): same product, same quantity.
- `match.status`: `cocok` (all equal), `tidak_cocok` (differences), `perlu_cek` (note unreadable or a quantity missing on the note),
  `tanpa_foto`. `match.diffs: [{name, recorded_qty, photo_qty}]` (`null` = missing on that side).
- `tidak_cocok` without `mismatch_reason` → `{ok: false, error: "MISMATCH", message, match}` and nothing is saved; the app shows the
  differences, the user corrects the quantities or writes the reason (e.g. "2 dus bonus") and sends again.
- Saved rows get `purchase_no` (one per note, `PB…`), `match_status`, `match_notes`. Response: `stock, purchase_no, match`.

After saving, quantities and prices can no longer be edited directly:

| Action | Who | `data` | Response |
|---|---|---|---|
| `request_purchase_fix` | any (sales excluded) | `{purchase_no, lines: [{product_id, qty, cost_price?}] (the corrected values), reason}` | owner/manager: `applied: true, changes, stock`; others: `applied: false, request_id, approval` (kind `purchase_fix`, decided by manager or owner) |

`decide_approval` for a `purchase_fix` must send `purchase_no: approval.ref`. Applying adds correction rows (same `purchase_no`,
`match_status: koreksi`, qty/total = the difference) and moves stock and cost price accordingly.

## Activity log for the owner (v12)

Every change, correction and decision is written to `pos_activity`: `{act_id, at (ISO), act_date, user, role, kind, summary, ref, amount, level: "info"|"warn"}`.
Kinds: `masuk`, `minta_koreksi`, `koreksi_masuk`, `harga`, `minta_harga`, `keputusan`, `batal`, `minta_batal`, `stok`, `opname`,
`minta_opname`, `kemas_ulang`, `biaya`, `kas`, `tutup_kas`, `hutang`, `produk`, `produk_baru`, `impor`, `pengaturan`, `pengguna`,
`perangkat_baru`, `bayar_masuk`, `bayar_keluar`, `alokasi`.

| Action | Who | `data` | Response |
|---|---|---|---|
| `list_activity` | owner | `{from, to}` | `activity` (newest first) |

`bootstrap` for the owner also returns `activity_recent` (last 7 days, newest first, max 100) so the app can show an unread badge.

## Payments: customers and suppliers, matched with the transfer slip (v13)

Every payment in or out is a row in `pos_payments`: `{pay_id, pay_date, direction: "in"|"out", party_type: "customer"|"supplier",
customer_id, customer_name, supplier, amount, method: "tunai"|"transfer"|"qris", bank, transfer_ref, proof_photo_id,
alloc (JSON [{ref, amount}] — ref = invoice_no for customers, purchase_no for suppliers), match_status, note, cashier}`.

The transfer slip photo goes through the photo workflow with kind `bayar` (`scan_payment {image_base64, mime}` →
`photo_id, extracted: {date, amount, sender_name, receiver_name, bank, transfer_ref, readable, notes}`). The app pre-fills
amount, bank, reference and date from it. With a `photo_id`, an amount that differs from the slip →
`{ok: false, error: "MISMATCH"}` unless `mismatch_reason` is sent.

| Action | Who | `data` | Response |
|---|---|---|---|
| `receive_payment` | any | existing fields + `{transfer_ref?, bank?, photo_id?, alloc?: [{ref: invoice_no, amount}], mismatch_reason?}` | `payment, customer` |
| `pay_supplier` | owner, manager | `{supplier, amount, method, bank?, transfer_ref?, photo_id?, pay_date?, alloc?: [{ref: purchase_no, amount}], note, paid_from?: "kas"|"lain", mismatch_reason?}` | `payment` |
| `allocate_payment` | owner, manager | `{pay_id, alloc: [{ref, amount}], note}` — set or change which invoices a payment covers (partial allowed) | `payment` |
| `party_ledger` | owner, manager (kasir: customers only, no cost) | `{party_type, customer_id? / supplier?}` | `docs: [{ref, date, total, paid, remaining}]` (customer: sales with debt; supplier: purchase notes), `payments: [...]`, `balance` |

Rules: allocation amounts must be > 0, each `ref` must belong to that customer/supplier, and an invoice cannot be allocated more than its
remaining amount; the sum of allocations cannot exceed the payment. `match_status`: `lunas` (allocations = payment and every invoice fully
paid), `sebagian` (an invoice is only partly paid), `belum_dialokasi` (no allocation yet), `lebih` (payment > allocations).
Cash supplier payments from the drawer count as cash out of the open shift. Every payment and allocation goes to the activity log.

## Company bank account: monthly statement vs recorded payments (v14)

Settings `bank_accounts: [{id, bank, account_no, holder, active}]` (owner edits; e.g. `{id: "BA1", bank: "BCA", account_no: "1234567890", holder: "Khair Mart"}`).
Transfer / QRIS payments (`receive_payment`, `pay_supplier`) may send `account_id`; without it the first active account is used.
They also store `slip_date` (the date read from the slip). A slip date different from `pay_date` is flagged in the activity log (warn).

| Action | Who | `data` | Response |
|---|---|---|---|
| `import_statement` | owner, manager | `{account_id, period: "YYYY-MM", lines: [{date, description, amount (+in / −out) or credit/debit, ref?, balance?}]}` (≤ 1500 lines, dates inside the month; re-importing replaces the month) | reconciliation report (below) |
| `bank_recon` | owner, manager | `{account_id, period}` | `imported` (bool) + report, recomputed, no writes |
| `match_bank_line` | owner, manager | `{account_id, period, line_id, pay_id? \| ignore: true, note}` — link a line to a payment by hand (`manual`), mark it ignored (bank fee, interest: `diabaikan`, note required), or reopen it (no pay_id, no ignore) | `line` |

Report: `lines: [{line_id, seq, line_date, description, amount, ref, status, pay_id, diff_days, pay_amount?, pay_date?, party?, note}]`,
`missing` (transfer/QRIS payments recorded in the app for that account and month that are not on the statement),
`counts` per status, `totals: {statement_in, statement_out, recorded_in, recorded_out}`.
Line status: `cocok` (same amount and direction, date within 1 day), `beda_tanggal` (2–3 days apart), `beda_jumlah` (the payment's transfer
reference appears in the line but the amount differs), `tidak_tercatat` (no payment in the app), `manual`, `diabaikan`.
Matching uses payments of the month ± 3 days; a reference match wins over a date match. Each import / manual match goes to the activity log.

## Cash drawer only for cashiers, morning approval, daily report (v15)

- `open_shift` is for **kasir** accounts only (owner / manager → `FORBIDDEN`). Only kasir sales need an open shift (`SHIFT_REQUIRED`);
  owner and manager sell without one.
- Every `open_shift` creates an approval `kind: "buka_kas"` (`approver_role: "manager"`, `ref: shift_id`, `total: opening_cash`,
  `payload: {shift_id, opening_cash, last_counted, last_cashier}`) with a summary comparing the opening count with the last closed drawer
  (counted cash). Manager or owner approves / rejects it like any approval; selling is not blocked. It is also logged (`buka_kas`, warn when
  the opening differs from the last count).
- Shifts track sales per method: `transfer_sales`, `qris_sales`, `debt_sales`, `items_qty` (plus the existing `cash_sales`, `sales_count`,
  `sales_total`), returned by `close_shift` so the cashier's end-of-day message can show them.
- Settings: `wa_shop_number` (company), `wa_manager_number`, `wa_owner_number`, `report_time` ("21:00", when the app reminds to send the report).

| Action | Who | `data` | Response |
|---|---|---|---|
| `daily_report` | owner, manager | `{date}` | `report: {date, sales: {count, total, discount, items_qty, by_method: {tunai, transfer, qris}, debt, voids: {count, total}}, top_items (10, by value), payments_in / payments_out: {count, total, tunai, transfer, qris}, expenses: {count, total, from_kas}, shifts: [{cashier, status, opening_cash, cash_sales, cash_payments, cash_in, cash_out, expected_cash, counted_cash, difference, sales_count, sales_total}], bank: {sales_transfer, sales_qris, payments_transfer, payments_qris, in_total, out_transfer}, cash: {sales, payments_in, payments_out, expenses_from_kas, expected_total, counted_total, difference_total}, profit (owner only)}`, `send_to: {company, manager, owner}` (WhatsApp numbers) |

Sending: the apps build the message text and open `https://wa.me/<number>?text=…` — one tap per number (company, manager, owner); the
user presses Send in WhatsApp (no automatic sending without the WhatsApp Business API).

## Discount limit, members, receipts, owner master code, own PINs (v16)

### Discount limit (default 3 %)
- `computeSale` compares the sale with its **list total**: retail price per line, or the wholesale price when the customer is `grosir`
  or the line reaches `wholesale_min_qty`. `discount % = (list total − total) / list total` (both the discount field and lower unit
  prices count).
- Allowed without approval: `max_discount_pct` (setting, default 3) **plus the member discount** (below). Owner and manager may give
  more (note `[diskon X% disetujui <name>]`). A kasir above the limit gets `DISCOUNT_APPROVAL_REQUIRED` and sends `request_discount`.

| Action | Who | `data` | Response |
|---|---|---|---|
| `request_discount` | any (kasir) | same as `save_sale` (+ `reason`) — payment fields not needed | `request_id`, `approval` (`kind: "discount"`, `approver_role: "manager"`, `total` = total after discount, `debt_amount` = discount amount) |

- The approval `payload`: `{list_total, total, discount, pct, max_pct, reason, lines: [{name, qty, unit_price}]}` and, **owner only**,
  `profit_before, profit_after, margin_before, margin_after` (%). The summary ends with ` | laba 18.9% → 14.7% (Rp a → Rp b)` for the
  owner only; manager and kasir never see profit.
- `save_sale` with `data.discount_approval_id` = an approved `discount` request of the same `client_id` whose amount is ≥ this
  discount → the sale goes through and the approval becomes `used`. Pending → `Diskon belum disetujui`; rejected →
  `Diskon ditolak: <note>`; bigger discount or other sale → `Transaksi berubah…`.

### Members (pelanggan member)
- Customer fields: `email`, `member` (bool), `member_no` (server, `M` + 6 chars), `member_since` (date), `visits` (purchases counted
  by the server), `last_visit` (date).
- `save_customer` accepts `email` (lower-cased, checked) and `member: true|false`. Any user may register a member (logged
  `member_baru`); only owner / manager may remove membership (kasir → `FORBIDDEN`).
- Setting `member_tiers` (default `[{"from":2,"pct":2},{"from":5,"pct":3},{"from":10,"pct":5}]`): this sale's purchase number is
  `visits + 1`; the member gets the `pct` of the highest tier whose `from` ≤ that number (first purchase → 0 %). Setting
  `member_enabled` (default true).
- The app applies the member discount itself (put it in `discount`, show it as "Diskon member X%"); the server allows it on top of
  `max_discount_pct` and answers `member: {pct, purchase_no, member_no}`; the sale note gets `[member X% · pembelian ke-N]`.
- Every `save_sale` with a customer adds 1 to `visits` and sets `last_visit`; `void_sale` takes 1 off.

### Receipts by WhatsApp or e-mail
- No server action: the kasir app sends the receipt text with `https://wa.me/<customer phone>?text=…` or `mailto:<email>?subject=…&body=…`
  (shown when the customer has a phone / e-mail). Automatic e-mail from the server needs a Gmail credential in n8n (not connected yet).

### Owner master code and own PINs
- **Master code** (8 digits): the owner sets it with `set_master` `{master_hash}` where `master_hash = sha256(KEY + ':__master__:' + code)`
  (must be logged in with the real PIN, not via the master code). Stored as `master_hash` on the owner's user row.
- **Logging in to any account with it:** send the target `user` and `pin_hash = master_hash`. The server accepts it for every active
  user, the response has `via_master: true`, and `login` is logged `masuk_master` (warn). The apps keep using that hash for the session.
  `set_master` and `change_pin` of the owner's own row are refused via the master code.
- **Own PIN at first login:** `save_user` with a (new or reset) `pin_hash` marks the user `must_change: true` (except the owner's own
  row). `login` answers `must_change: true`; every other action → `PIN_CHANGE_REQUIRED` until `change_pin` `{new_pin_hash}`
  (`sha256(KEY:user:newpin)`, must differ from the current one). Owner / manager PINs: 6 digits; kasir / sales: 4–6 (apps enforce).
- **Lock after wrong PINs:** 5 wrong PINs in a row for a user → `LOCKED` for 15 minutes (`message` gives the time). Users fields
  `fail_count`, `locked_until`.

| Action | Who | `data` | Response |
|---|---|---|---|
| `change_pin` | any | `{new_pin_hash}` | `ok` |
| `set_master` | owner (real PIN) | `{master_hash}` | `ok` |

### Other v16 changes
- `open_shift` also returns `request_id` and `approval` (the `buka_kas` request).
- Cost never reaches kasir / manager: `request_purchase_fix` and `purchase_fix` approvals keep quantities only; `get_sales` purchases
  have no `total` for them.
- `party_ledger`: payments without allocation are applied to the oldest open invoices first (`auto: true` on those amounts).

### Warehouse (gudang) and shop shelf (toko) — sell only what came in with a note (v16)
- Products carry `stock` (total, as before) and `shop_stock` (on the shelf); the apps get `gudang_stock = stock − shop_stock` too.
  A product without `shop_stock` yet (rows from before v16) counts all its stock as on the shelf, so nothing is blocked at go-live.
- **Goods-in** (`save_purchase`, with the supplier-note photo) adds to the **warehouse** only. Repacking, goods-in corrections,
  stock counts and owner adjustments also change the warehouse; the shelf is capped at the total. A new product's opening stock
  (owner) is on the shelf.
- **`move_stock`** `{to: "toko" | "gudang", lines: [{product_id, qty}], note}` (any app user except sales): moves goods from the
  warehouse to the shelf (or back). Moving to the shelf needs that much in the warehouse → else `NOT_IN_GUDANG`, with
  "belum ada barang masuk dengan nota" when the warehouse is empty. Logged `pindah_stok`. Response `stock: [{product_id, stock,
  shop_stock, gudang_stock}]`.
- **`save_sale`** sells from the shelf only: a line above `shop_stock` → `NOT_ON_SHELF` with `items: [{product_id, name, need,
  shop, gudang}]` and a message telling the cashier to move the goods first (or that no goods-in exists). Setting
  `sell_from_shop_only` (default true) turns it off. Sales the app queued offline send `queued: true`: never refused (the customer
  already paid), logged `jual_tanpa_rak` (warn) for the owner. Sales and voids change the shelf; `save_sale.stock[]` has `shop_stock`.

### Who brought the goods (goods-in) (v16)
`save_purchase` needs `data.carrier` (setting `require_carrier`, default true → `CARRIER_REQUIRED`):
`{type: "umum" | "teman" | "pemasok" | "karyawan", kind, name, vehicle, phone}`.
- `umum` = public transport: `vehicle` (plate / angkot number) required, `kind` = ojek / angkot / taksi / truk… (free word).
- `teman` = a friend, `karyawan` = our staff: `name` required. `pemasok` = the supplier's own driver (name / plate optional).
- Names: letters (any language), digits, space, `. , ' -`; vehicle numbers: letters, digits, space, `/ - .`; phone: digits.
Stored on each goods-in row (`carrier_type, carrier_name, carrier_vehicle, carrier_phone`) and in the activity log.

### Returns (retur) — customers and suppliers (v16)
| Action | Who | `data` | Response |
|---|---|---|---|
| `request_return` | kasir, manager, owner | customer: `{kind:"pelanggan", invoice_no, lines:[{product_id, qty, condition:"baik"\|"rusak"}], reason_code, reason_note, returned_by, returned_by_phone, refund_method:"tunai"\|"transfer"\|"potong_hutang"\|"tukar"}`; supplier: `{kind:"pemasok", purchase_no, lines:[{product_id, qty}], reason_code, reason_note, out_doc_no, photo_id, carrier}` | `request_id, return_id, approver_role, approval` |
| `list_returns` | owner, manager (kasir: customer returns only) | `{from, to}` | `returns: [...]` — pending requests first, then decided returns in the range |

- `reason_code`: `tidak_sesuai` (not to spec), `rusak`, `kadaluarsa`, `salah_kirim`, `kualitas_buruk`, `berubah_pikiran`, `lainnya`
  (`reason_note` required for `lainnya`).
- **Customer return:** the server reads the purchase invoice (who bought it, when, at what price after the sale discount) and refuses
  more than was bought minus what was already returned or is pending. `returned_by` = who brought it back (default the buyer).
  Refund = value of the returned lines; setting `return_fee_pct` (default 0) is a deduction for returned goods (`fee`).
  On approval: good items (`baik`) go back to the **warehouse** (they are checked before going back on the shelf), damaged ones (`rusak`) are
  not stock; `tunai` → cash out of the cashier's open drawer + payment row out; `transfer` → payment row out; `potong_hutang` → less debt.
  The return id (`RT…`) is the entry note for the returned goods.
- **Supplier return:** from a goods-in note (`purchase_no`): not more than came in minus earlier returns, and not more than in stock;
  needs the outgoing note number `out_doc_no` and a photo of the goods-exit receipt `photo_id` (setting `require_return_photo`, default
  true) and the carrier. On approval: stock goes down, and negative goods-in rows (`purchase_no` = return id, `match_status: "retur"`)
  lower what we owe the supplier. Values are purchase cost: owner only.
- **Approval:** every return is an approval `kind: "retur"`. The manager approves; when value ≥ `return_owner_min_value`
  (default Rp 1,000,000) or qty ≥ `return_owner_min_qty` (0 = off) only the owner may (`approver_role: "owner"`). The owner is always told
  (activity `minta_retur` on request, `retur` on the decision). Decided returns are kept in `pos_returns` with every detail.
- `daily_report.report.returns = {customer: {count, refund, tunai}, supplier: {count, value (owner)}}`.

### Plain-text input everywhere (v16)
Before any action the server cleans `data`: control and direction-override characters and HTML tags / `< >` are removed, the keys
`__proto__`, `constructor`, `prototype` are dropped, strings are cut at 4000 characters. Then each field is checked: person names,
product / customer / supplier names (letters, digits, `. , ' & ( ) / % + # -`), SKU / barcode (`A-Z 0-9 . _ -`), units, phone (digits),
e-mail, dates (`YYYY-MM-DD`), document and vehicle numbers. A field that does not fit is refused with a message saying what is allowed.
The apps must use the same rules in their inputs (`maxlength`, `inputmode`, `pattern`) and show the server message.

### Small v16 additions
- `get_sale` `{invoice_no}` (any app user except sales): `sale`, `items`, `returned` (qty per product already returned or pending),
  `customer_debt` — used to start a customer return at the counter.
- `LOCKED` answers carry `locked_until` (ISO time). Sales accounts may call `change_pin` (forced new PIN).
- Field and photo workflows accept the owner master code, refuse locked accounts and `must_change` users (PIN_CHANGE_REQUIRED),
  and the field workflow cleans its input the same way (photos as `data:` URLs are left alone).

### Owner decisions (07 Oct): manager sees profit on discounts; return limit agreed by owner and manager
- `discount` approvals: owner **and manager** see `profit_before/after`, `margin_before/after` and the ` | laba …` summary; kasir never.
- `return_owner_min_value` default **Rp 2,000,000**. `return_owner_min_value` and `return_owner_min_qty` cannot be changed with
  `save_settings` (`AGREEMENT_REQUIRED`); they change only by agreement:

| Action | Who | `data` | Response |
|---|---|---|---|
| `propose_agreement` | owner, manager | `{key: "return_owner_min_value" \| "return_owner_min_qty", value, note}` | `request_id`, `approval` (`kind: "kesepakatan"`, `approver_role` = the other party) |

  The other party confirms it with `decide_approval` (the proposer cannot; the owner cannot confirm a request meant for the manager).
  On approval the setting changes and setting `limit_agreements` keeps the history `[{key, value, from, proposed_by, confirmed_by, at, note}]`
  (newest first, 50 kept); logged `usul_kesepakatan` / `kesepakatan`.
