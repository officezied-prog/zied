# Khair Mart POS – backend (n8n)

Source of the Code nodes in the n8n workflow **"Khair Mart POS – API"**
(`POST https://ziedapp.app.n8n.cloud/webhook/khair-pos`).

Flow: `POS API` webhook → `Parse Request` → load users, settings, products, customers and the
rows the action needs (data tables `pos_*`) → `Process` (auth + business logic, plans the writes)
→ one upsert per table (`_id = -1` inserts, otherwise updates) → `Finalize` → `Respond`.

- `parse-request.js` – normalises the body (JSON or text/plain).
- `process.js` – all actions from `../API.md`. `__STORE_KEY__` is replaced by the real store key
  inside n8n only; the key is never committed.
- `finalize.js` – adds ids of newly created rows to the response.

Data tables: pos_products, pos_customers, pos_sales, pos_sale_items, pos_payments,
pos_purchases, pos_users, pos_settings. The AI agents (Souq Brain, Supervisor) read them.
