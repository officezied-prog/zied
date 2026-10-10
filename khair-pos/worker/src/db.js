// D1 data layer: reproduces the live n8n loaders ("Get X" nodes) and writers ("Upsert X").
//
// Adapter contract (works for both Cloudflare D1 and the node:sqlite test shim):
//   adapter.all(sql, params) -> row[]            (SELECT; may be sync or a Promise)
//   adapter.run(sql, params) -> { lastInsertRowid, changes }   (INSERT/UPDATE)
// db.js always `await`s, so a synchronous shim (returning plain values) works unchanged.
import { TABLES, BOOL_COLS, OPS_TABLE } from '../tables.js';

const SENTINEL_NONE = '__none__';

// --- value coercion -------------------------------------------------------
// n8n returns boolean columns as real true/false; D1 stores them as 0/1. Convert on the way
// out so process.js boolean checks (x === true, u.active !== false) behave as under n8n.
function coerceOut(table, row) {
  const bools = BOOL_COLS[table] || [];
  for (const c of bools) {
    const v = row[c];
    if (v === 1) row[c] = true;
    else if (v === 0) row[c] = false;
    // null / undefined left as-is (an unset boolean stays null, same as n8n)
  }
  return row;
}
// On write: booleans -> 1/0; a JS object for a string column -> JSON (process already
// stringifies JSON columns, this is only defensive). SQLite/D1 bind primitives only.
function toDb(table, col, v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// --- loaders --------------------------------------------------------------
// Each entry mirrors one live "Get X" node: same table, same filter, same AND/OR.
// Range comparisons on YYYY-MM-DD strings are lexicographic in both n8n and SQLite, so an
// inverted sentinel range (from '9999-12-31' > to '0000-01-01') returns nothing — matching
// n8n exactly for actions that don't need that range.
function loaderSpecs(req) {
  const data = (req && req.data) || {};
  const inReturnOrSale = ['request_return', 'get_sale'].indexOf(req.action) >= 0;
  const isD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s == null ? '' : s));
  const saleInvoice = inReturnOrSale && data.kind !== 'pemasok' ? String(data.invoice_no || SENTINEL_NONE) : req.invoice_no;
  const photoId = req.action === 'request_return' ? String(data.photo_id || SENTINEL_NONE) : req.photo_id;
  const purchaseNo = req.action === 'request_return' && data.kind === 'pemasok' ? String(data.purchase_no || SENTINEL_NONE) : req.purchase_no;
  const returnsRef = inReturnOrSale ? String((data.kind === 'pemasok' ? data.purchase_no : data.invoice_no) || SENTINEL_NONE) : SENTINEL_NONE;
  const retFrom = req.action === 'list_returns' && isD(data.from) ? data.from : (req.action === 'daily_report' ? req.from : '9999-12-31');
  const retTo = req.action === 'list_returns' && isD(data.to) ? data.to : (req.action === 'daily_report' ? req.to : '0000-01-01');
  const discApproval = String(data.discount_approval_id || SENTINEL_NONE);

  const eq = (table, col, val) => ({ table, sql: `SELECT * FROM ${table} WHERE ${col} = ? ORDER BY id`, params: [val] });
  const range = (table, col, from, to) => ({ table, sql: `SELECT * FROM ${table} WHERE ${col} >= ? AND ${col} <= ? ORDER BY id`, params: [from, to] });
  const all = (table) => ({ table, sql: `SELECT * FROM ${table} ORDER BY id`, params: [] });

  return {
    'Get Users': all('pos_users'),
    'Get Settings': all('pos_settings'),
    'Get Products': all('pos_products'),
    'Get Customers': all('pos_customers'),
    'Get Devices': all('pos_devices'),
    'Get Sale By Client': eq('pos_sales', 'client_id', req.client_id),
    'Get Sale By Invoice': eq('pos_sales', 'invoice_no', saleInvoice),
    'Get Items By Invoice': eq('pos_sale_items', 'invoice_no', saleInvoice),
    'Get Photo': eq('pos_photos', 'photo_id', photoId),
    'Get Open Shifts': eq('pos_shifts', 'status', 'open'),
    'Get Purchase By No': eq('pos_purchases', 'purchase_no', purchaseNo),
    'Get Party Sales': eq('pos_sales', 'customer_id', req.party_cid),
    'Get Party Purchases': eq('pos_purchases', 'supplier', req.party_supplier),
    'Get Returns By Ref': eq('pos_returns', 'ref', returnsRef),
    'Get Range Sales': range('pos_sales', 'sale_date', req.from, req.to),
    'Get Range Items': range('pos_sale_items', 'sale_date', req.from, req.to),
    'Get Range Payments': range('pos_payments', 'pay_date', req.pay_from, req.pay_to),
    'Get Range Purchases': range('pos_purchases', 'purchase_date', req.from, req.to),
    'Get Range Expenses': range('pos_expenses', 'expense_date', req.from, req.to),
    'Get Range Shifts': range('pos_shifts', 'shift_date', req.shift_from, req.shift_to),
    'Get Range Repacks': range('pos_repacks', 'repack_date', req.from, req.to),
    'Get Range Activity': range('pos_activity', 'act_date', req.act_from, req.act_to),
    'Get Range Returns': range('pos_returns', 'return_date', retFrom, retTo),
    // OR filters (n8n omits matchType → "anyCondition"): load all pending approvals PLUS the
    // specific ones referenced by id (a decided discount approval is not pending but is still
    // needed), and party payments for this customer OR this supplier.
    'Get Approvals': {
      table: 'pos_approvals',
      sql: 'SELECT * FROM pos_approvals WHERE status = ? OR request_id = ? OR request_id = ? ORDER BY id',
      params: ['pending', req.approval_id, discApproval],
    },
    'Get Party Payments': {
      table: 'pos_payments',
      sql: 'SELECT * FROM pos_payments WHERE customer_id = ? OR supplier = ? ORDER BY id',
      params: [req.party_cid, req.party_supplier],
    },
    'Get Bank Lines': {
      table: 'pos_bank_lines',
      sql: 'SELECT * FROM pos_bank_lines WHERE account_id = ? AND period = ? ORDER BY id',
      params: [req.bank_account, req.bank_period],
    },
  };
}

// Run every loader and return a node-name -> row[] map (booleans coerced). Reads are
// independent, so they run concurrently.
export async function loadNodes(adapter, req) {
  const specs = loaderSpecs(req);
  const names = Object.keys(specs);
  const results = await Promise.all(names.map(async (name) => {
    const { table, sql, params } = specs[name];
    const rows = await adapter.all(sql, params);
    return [name, (rows || []).map((r) => coerceOut(table, r))];
  }));
  const nodes = Object.fromEntries(results);
  nodes['Parse Request'] = [req];
  return nodes;
}

// Build the n8n-style `$` accessor over a loaded nodes map (same shape the harness uses).
export function makeAccessor(nodes) {
  return (name) => ({
    first: () => ({ json: (nodes[name] || [{}])[0] }),
    all: () => (nodes[name] || []).map((j) => ({ json: j })),
  });
}

// --- writer ---------------------------------------------------------------
// Mirrors the per-table Ops/Has/Upsert chain: for each ops row, _id === -1 inserts a new
// row, otherwise updates the row with that id. Only known columns present in the row are
// written (process emits full rows for updates, partial for inserts). Returns the written
// rows (with ids) per ops key, which Finalize uses to fill new customer/product/payment ids.
export async function applyOps(adapter, ops) {
  const upserts = {};
  for (const [key, table] of Object.entries(OPS_TABLE)) {
    const rows = (ops && ops[key]) || [];
    if (!rows.length) continue;
    const known = Object.keys(TABLES[table]);
    const written = [];
    for (const row of rows) {
      const cols = known.filter((c) => row[c] !== undefined);
      const vals = cols.map((c) => toDb(table, c, row[c]));
      const isInsert = row._id === undefined || row._id === null || row._id === -1;
      let id;
      if (isInsert) {
        const placeholders = cols.map(() => '?').join(', ');
        const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
        const res = await adapter.run(sql, vals);
        id = Number(res.lastInsertRowid);
      } else {
        id = Number(row._id);
        if (cols.length) {
          const setClause = cols.map((c) => `${c} = ?`).join(', ');
          const sql = `UPDATE ${table} SET ${setClause} WHERE id = ?`;
          await adapter.run(sql, [...vals, id]);
        }
      }
      // Echo the written row (with its id) for Finalize; booleans back to true/false.
      const out = { id };
      for (const c of cols) out[c] = row[c];
      coerceOut(table, out);
      written.push(out);
    }
    upserts[key] = written;
  }
  return upserts;
}
