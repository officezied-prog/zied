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

**Purchase line**: `id, purchase_date, supplier, product_id, name, qty, cost_price, total, note, user`
(cost_price of the product becomes the weighted average of old stock and new stock).
