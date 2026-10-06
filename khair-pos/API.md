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
| `save_customer` | any | Customer (with `id` to update; `debt_balance` ignored) | `customer` |
| `receive_payment` | any | `{customer_id, amount, method, note, pay_date}` | `payment, customer` |
| `save_purchase` | any | `{purchase_date, supplier, note, items:[{product_id, qty, cost_price}]}` | `stock: [{product_id, stock, cost_price}]` |
| `get_sales` | any (kasir: cost/profit stripped) | `{from: "YYYY-MM-DD", to: "YYYY-MM-DD"}` inclusive | `sales[], items[], payments[], purchases[]` |
| `save_settings` | owner | `{settings: {...}}` (merged) | `settings` |
| `save_user` | owner | `{name, role, pin_hash?, active}` (create or update by name) | `user` |

## Objects

**Product**: `id, sku, name, category, unit, cost_price, retail_price, wholesale_price, wholesale_min_qty, stock, min_stock, active (bool), notes`

**Customer**: `id, name, phone, type ("grosir"|"eceran"), address, notes, debt_balance`

**Settings**: `store_name, address, phone, receipt_footer, paper ("58"|"80"), survey_questions: [string]`

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
| `decide_approval` | owner/manager (`approver_role` respected) | `{request_id, decision, note, invoice_no?}` — for kind `void` send `invoice_no: approval.ref` | `approval` (+ `sale` when a void was executed, + `product` when a price was applied) |
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
