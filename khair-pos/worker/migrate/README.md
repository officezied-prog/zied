# Cut-over: move live data from n8n → Khair Mart Jumla (Cloudflare D1)

The new code version is **Khair Mart Jumla** (الخير مارت جملة). The old n8n workflows are kept
as a reference — they are not deleted or modified; the apps simply stop pointing at them.


Do this only when the code backend has passed parity (`npm test`) and the owner has a
Cloudflare account. The live service stays on n8n the whole time; we only switch the apps'
backend URL at the very end, and keep n8n as instant rollback.

## 1. One-time setup (owner's Cloudflare account)

```
cd khair-pos/worker
npm install                 # wrangler
npx wrangler login          # owner's account
npx wrangler d1 create khair_mart_jumla   # copy the printed database_id into wrangler.toml
npm run build                         # writes schema.sql + src/generated/
npx wrangler d1 execute khair_mart_jumla --remote --file schema.sql
npx wrangler secret put STORE_KEY     # paste the real store key (never committed)
# optional — enables the photo AI reader (without it, photos save as 'perlu_cek'):
npx wrangler secret put ANTHROPIC_API_KEY
```

One Worker serves all five endpoints (`khair-pos`, `khair-field`, `khair-chat`, `khair-att`,
`khair-pos-photo`) on the one D1 database, so a single deploy covers every app.

## 2. Export the live n8n data (through this session's n8n MCP)

The container cannot reach the n8n host directly (proxy-blocked), so the export runs through
the MCP: for every `pos_*` table, page through `get_data_table_rows` (project
`w58qjNXPtPmWJPB6`, 100 rows/page) and write one JSON file:

```
{ "pos_users": [ { "id": 1, "name": "…", … }, … ], "pos_sales": [ … ], … }
```

Then:

```
node migrate/rows-to-sql.js dump.json > seed-data.sql
npx wrangler d1 execute khair_mart_jumla --remote --file seed-data.sql
```

## 3. Verify (before any switch)

Compare row counts and money/stock totals against n8n:

```
npx wrangler d1 execute khair_mart_jumla --remote --command \
  "SELECT (SELECT COUNT(*) FROM pos_sales) sales, (SELECT COUNT(*) FROM pos_products) products,
          (SELECT ROUND(SUM(total)) FROM pos_sales) sales_total,
          (SELECT ROUND(SUM(debt_balance)) FROM pos_customers) debt;"
```

These must match the n8n figures exactly before going further.

## 4. Parallel run, then switch

1. `npm run deploy` → note the Worker URL (`https://khair-mart-jumla.<subdomain>.workers.dev`).
2. Leave the apps on n8n; mirror real requests to the Worker and diff responses for a few days.
3. **Switch the apps — a pure host swap.** The webhook *paths* are unchanged (`/webhook/khair-pos`,
   `-field`, `-chat`, `-att`, `-pos-photo`), so in each of `index.html`, `kasir/index.html`,
   `sales/index.html` replace the host **everywhere it appears**:

   ```
   https://ziedapp.app.n8n.cloud   →   https://khair-mart-jumla.<subdomain>.workers.dev
   ```

   This covers BOTH the `CONFIG.*_URL` constants AND the CSP `connect-src` meta tag. ⚠️ The CSP
   is the easy miss: if `connect-src` still lists only the n8n host, the browser **silently
   blocks** every call to the new backend and the app looks broken. One find/replace of the
   host per file handles both. Bump each app's `sw.js` cache version too, so phones pick up the
   change. (The cold-storage app `gudang/` stays on n8n — it migrates with Phase 2 / Lalamove.)
4. Keep n8n frozen as instant rollback for a week (revert = swap the host back). After a clean
   week, decommission the n8n POS/Field/Chat/Attendance/Photo workflows (keep them archived as
   reference — never delete).

(All five workflows are already in code on the one D1 database, so step 3 switches them all at
once. The cold-storage workflow migrates later with Phase 2.)
