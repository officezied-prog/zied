# Cut-over: move live data from n8n → Cloudflare D1

Do this only when the code backend has passed parity (`npm test`) and the owner has a
Cloudflare account. The live service stays on n8n the whole time; we only switch the apps'
backend URL at the very end, and keep n8n as instant rollback.

## 1. One-time setup (owner's Cloudflare account)

```
cd khair-pos/worker
npm install                 # wrangler
npx wrangler login          # owner's account
npx wrangler d1 create khair_pos      # copy the printed database_id into wrangler.toml
npm run build                         # writes schema.sql + src/generated/
npx wrangler d1 execute khair_pos --remote --file schema.sql
npx wrangler secret put STORE_KEY     # paste the real store key (never committed)
```

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
npx wrangler d1 execute khair_pos --remote --file seed-data.sql
```

## 3. Verify (before any switch)

Compare row counts and money/stock totals against n8n:

```
npx wrangler d1 execute khair_pos --remote --command \
  "SELECT (SELECT COUNT(*) FROM pos_sales) sales, (SELECT COUNT(*) FROM pos_products) products,
          (SELECT ROUND(SUM(total)) FROM pos_sales) sales_total,
          (SELECT ROUND(SUM(debt_balance)) FROM pos_customers) debt;"
```

These must match the n8n figures exactly before going further.

## 4. Parallel run, then switch

1. `npm run deploy` → note the Worker URL (`https://khair-pos-api.<subdomain>.workers.dev`).
2. Leave the apps on n8n; mirror real requests to the Worker and diff responses for a few days.
3. Flip each app's `CONFIG` backend URL (owner `index.html`, `kasir/`, `sales/`) from the n8n
   webhook to the Worker URL. Keep n8n frozen as rollback for a week.
4. After a clean week, decommission the n8n POS workflow.

(The field / chat / attendance workflows migrate the same way afterward, onto the same D1.)
