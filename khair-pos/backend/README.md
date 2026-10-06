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
pos_purchases, pos_users, pos_settings, pos_approvals, pos_photos, pos_expenses, pos_shifts.
The AI agents (Souq Brain, Supervisor) read them.

## Photo workflow

**"Khair Mart POS – Foto (barang masuk/keluar)"** (`POST .../webhook/khair-pos-photo`), sources in `photo/`:

`Photo API` → `Parse Photo` → load users, products, the sale and its items, photos in range →
`Auth & Route` (checks key + PIN, builds the AI prompt) → `Image To File` → `Read Photo AI`
(Anthropic image analysis through n8n gateway credits) → `Match` (parses the AI JSON, suggests
products for goods in, decides cocok / tidak_cocok / perlu_cek for goods out) → `Save Photo`
(pos_photos) → `Update Sale` (exit_photo, exit_match) → `Respond`.

If the AI call fails, the photo is still saved with status `perlu_cek`, so a person checks it.
The image itself is not stored yet; `drive_url` stays empty until a Google Drive credential
is connected in n8n and an upload node is added after `Image To File`.
