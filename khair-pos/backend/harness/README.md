# Server test harness (no n8n needed)

Runs `../process.js` in Node with fake data-table rows, the way the n8n Process node runs it.

1. Put the store key in `storekey.txt` here (git-ignored, never commit it).
2. `node harness16.js` — v16 rules (discount limit, members, master code / own PIN / lock, warehouse vs shelf, returns, carrier,
   input checks, agreements, receipt fee, rename). Every line should print the expected values; no `Error`.
3. `node harness16base.js` — the older v15 suite with the discount limit and carrier switched off; compare with
   `expected-v15-suite.txt` (ignore ids / times). Intended differences: `must_change` on new users, cost hidden from
   kasir/manager, `auto` in party ledgers, the manager may open a drawer, `send_fee` on sales, `returns` in ops.
