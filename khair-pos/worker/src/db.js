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
// v38 (owner 2026-10-12: stay on the free Cloudflare plan; 1,856 products are coming): the frequent polls — the approvals
// inbox every minute, the sales / activity refreshes, the device ping — never read the two big tables (every product,
// every customer), which they do not use. Fewer D1 rows read per day and less CPU per request; test/light-polls.test.js
// proves each of these answers (and writes) exactly the same with and without them.
export const LIGHT_ACTIONS = ['list_approvals', 'check_approval', 'get_sales', 'list_activity', 'device_ping'];
export function loaderSpecs(req, opts = {}) {
  const data = (req && req.data) || {};
  const inReturnOrSale = ['request_return', 'get_sale'].indexOf(req.action) >= 0;
  const isD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s == null ? '' : s));
  const saleInvoice = inReturnOrSale && data.kind !== 'pemasok' ? String(data.invoice_no || SENTINEL_NONE) : req.invoice_no;
  const photoId = req.action === 'request_return' ? String(data.photo_id || SENTINEL_NONE) : req.photo_id;
  const purchaseNo = req.action === 'request_return' && data.kind === 'pemasok' ? String(data.purchase_no || SENTINEL_NONE) : req.purchase_no;
  const returnsRef = inReturnOrSale ? String((data.kind === 'pemasok' ? data.purchase_no : data.invoice_no) || SENTINEL_NONE) : SENTINEL_NONE;
  const retFrom = req.action === 'list_returns' && isD(data.from) ? data.from : (['daily_report', 'profit_loss'].indexOf(req.action) >= 0 ? req.from : '9999-12-31');
  const retTo = req.action === 'list_returns' && isD(data.to) ? data.to : (['daily_report', 'profit_loss'].indexOf(req.action) >= 0 ? req.to : '0000-01-01');
  // v36: the price-correction history (koreksi + its refunds / consultations, decided or not) for the actions that report on it.
  // Before, only pending approvals were loaded, so list_corrections and the daily report's corrections block saw nothing decided.
  const corrHistory = ['list_corrections', 'daily_report', 'profit_loss'].indexOf(req.action) >= 0 ? 1 : 0;
  const discApproval = String(data.discount_approval_id || SENTINEL_NONE);

  const eq = (table, col, val) => ({ table, sql: `SELECT * FROM ${table} WHERE ${col} = ? ORDER BY id`, params: [val] });
  const range = (table, col, from, to) => ({ table, sql: `SELECT * FROM ${table} WHERE ${col} >= ? AND ${col} <= ? ORDER BY id`, params: [from, to] });
  const all = (table) => ({ table, sql: `SELECT * FROM ${table} ORDER BY id`, params: [] });

  // v36: the tamper photos are read only by the two actions that need them (no extra read on every request).
  const tamper = {};
  if (req.action === 'report_tamper' && /^TS[A-Z0-9]{8,20}$/.test(String(data.shot_id || ''))) tamper['Get Tamper Shot'] = eq('pos_tamper_shots', 'shot_id', String(data.shot_id));
  // (each row carries its small photo: read at most the 30 newest, of one person when the owner asks for one)
  if (req.action === 'list_tamper_shots') {
    const nm = String(data.name || '').trim().toLowerCase();
    tamper['Get Tamper Shots'] = nm
      ? { table: 'pos_tamper_shots', sql: 'SELECT * FROM pos_tamper_shots WHERE lower(user) = ? ORDER BY id DESC LIMIT 30', params: [nm] }
      : { table: 'pos_tamper_shots', sql: 'SELECT * FROM pos_tamper_shots ORDER BY id DESC LIMIT 30', params: [] };
  }

  return {
    ...tamper,
    'Get Users': all('pos_users'),
    'Get Settings': all('pos_settings'),
    ...(!opts.full && LIGHT_ACTIONS.indexOf(req.action) >= 0 ? {} : { 'Get Products': all('pos_products'), 'Get Customers': all('pos_customers') }),
    'Get Devices': all('pos_devices'),
    // v38: yesterday's and today's D1 use (UTC days) — read only by the owner's approvals poll, which shows it
    'Get D1 Usage': req.action === 'list_approvals'
      ? range('pos_api_usage', 'month', new Date(Date.now() - 86400000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10))
      : eq('pos_api_usage', 'month', SENTINEL_NONE),
    'Get Sale By Client': eq('pos_sales', 'client_id', req.client_id),
    'Get Sale By Invoice': eq('pos_sales', 'invoice_no', saleInvoice),
    'Get Items By Invoice': eq('pos_sale_items', 'invoice_no', saleInvoice),
    'Get Photo': eq('pos_photos', 'photo_id', photoId),
    'Get Open Shifts': eq('pos_shifts', 'status', 'open'),
    'Get Purchase By No': eq('pos_purchases', 'purchase_no', purchaseNo),
    // v65: for the owner / manager / accountant at bootstrap — the goods-in notes not confirmed yet (since the feature started) and the
    // ones bought on credit whose agreed date is near or past (a handful of rows; the light polls never read them)
    'Get Unchecked Purchases': {
      table: 'pos_purchases',
      sql: "SELECT * FROM pos_purchases WHERE purchase_date >= ? AND (check_status IS NULL OR check_status = '') ORDER BY id",
      params: [req.action === 'bootstrap' ? req.check_since : '9999-12-31'],
    },
    'Get Due Purchases': {
      table: 'pos_purchases',
      sql: "SELECT * FROM pos_purchases WHERE pay_status = 'tempo' AND due_date <= ? ORDER BY id",
      params: [req.action === 'bootstrap' ? req.due_until : '0000-01-01'],
    },
    'Get Party Sales': eq('pos_sales', 'customer_id', req.party_cid),
    'Get Party Purchases': eq('pos_purchases', 'supplier', req.party_supplier),
    'Get Returns By Ref': eq('pos_returns', 'ref', returnsRef),
    'Get Range Sales': range('pos_sales', 'sale_date', req.from, req.to),
    'Get Range Items': range('pos_sale_items', 'sale_date', req.from, req.to),
    'Get Range Payments': range('pos_payments', 'pay_date', req.pay_from, req.pay_to),
    'Get Range Purchases': range('pos_purchases', 'purchase_date', req.from, req.to),
    'Get Range Expenses': range('pos_expenses', 'expense_date', req.from, req.to),
    // v36: the expense an expense_check approval belongs to (decide_approval marks it checked / rejected)
    'Get Expense By Request': eq('pos_expenses', 'request_id', req.action === 'decide_approval' ? req.approval_id : SENTINEL_NONE),
    'Get Range Shifts': range('pos_shifts', 'shift_date', req.shift_from, req.shift_to),
    'Get Range Repacks': range('pos_repacks', 'repack_date', req.from, req.to),
    'Get Recent Repacks': { table: 'pos_repacks', sql: 'SELECT * FROM pos_repacks WHERE repack_date >= ? ORDER BY id', params: [req.rp_from || '9999-12-31'] },
    // v50: the repacks being packed now (started, not yet confirmed) — read only where they are shown or checked; one by id to confirm
    'Get Open Repacks': eq('pos_repacks', 'status', ['bootstrap', 'repack_start', 'repack'].indexOf(req.action) >= 0 ? 'proses' : SENTINEL_NONE),
    'Get Repack By Id': eq('pos_repacks', 'repack_id', req.action === 'repack_finish' ? String(data.repack_id || SENTINEL_NONE) : SENTINEL_NONE),
    'Get Range Activity': range('pos_activity', 'act_date', req.act_from, req.act_to),
    'Get Invoice Changes': { table: 'pos_activity', sql: "SELECT * FROM pos_activity WHERE kind IN ('ubah_faktur', ?) AND act_date >= ? AND act_date <= ? ORDER BY id", params: [req.chg_kind2 || '__none__', req.chg_from || '9999-12-31', req.chg_to || '0000-01-01'] },
    'Get Range Returns': range('pos_returns', 'return_date', retFrom, retTo),
    // OR filters (n8n omits matchType → "anyCondition"): load all pending approvals PLUS the
    // specific ones referenced by id (a decided discount approval is not pending but is still
    // needed), and party payments for this customer OR this supplier.
    'Get Approvals': {
      table: 'pos_approvals',
      // v38: + the repack request with this client id (a resend returns it even after it was decided)
      sql: "SELECT * FROM pos_approvals WHERE status = ? OR request_id = ? OR request_id = ? OR (? = 1 AND kind IN ('koreksi', 'refund', 'konsultasi')) OR (kind = 'repack' AND client_id = ?) ORDER BY id",
      params: ['pending', req.approval_id, discApproval, corrHistory, req.approval_client || SENTINEL_NONE],
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

// Run a {nodeName: {table, sql, params}} spec map and return nodeName -> row[] (booleans
// coerced). Reads are independent, so they run concurrently. Shared by every workflow.
export async function execSpecs(adapter, specs) {
  const names = Object.keys(specs);
  // v39 (free Cloudflare plan: at most 50 D1 queries per request): with a batching adapter every read of this request goes
  // to D1 in ONE call (the loaders alone were 29 queries, so a 10-item sale passed the limit).
  if (adapter.batch && names.length > 1) {
    const res = await adapter.batch(names.map((name) => ({ sql: specs[name].sql, params: specs[name].params, kind: 'all' })));
    return Object.fromEntries(names.map((name, i) => [name, (res[i] || []).map((r) => coerceOut(specs[name].table, r))]));
  }
  const results = await Promise.all(names.map(async (name) => {
    const { table, sql, params } = specs[name];
    const rows = await adapter.all(sql, params);
    return [name, (rows || []).map((r) => coerceOut(table, r))];
  }));
  return Object.fromEntries(results);
}

// Small SQL builders reused by each workflow's loader specs.
export const Q = {
  all: (table) => ({ table, sql: `SELECT * FROM ${table} ORDER BY id`, params: [] }),
  eq: (table, col, val) => ({ table, sql: `SELECT * FROM ${table} WHERE ${col} = ? ORDER BY id`, params: [val] }),
  range: (table, col, from, to) => ({ table, sql: `SELECT * FROM ${table} WHERE ${col} >= ? AND ${col} <= ? ORDER BY id`, params: [from, to] }),
  gte: (table, col, from) => ({ table, sql: `SELECT * FROM ${table} WHERE ${col} >= ? ORDER BY id`, params: [from] }),
};

// POS loaders.
export async function loadNodes(adapter, req) {
  const nodes = await execSpecs(adapter, loaderSpecs(req));
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
export async function applyOps(adapter, ops, opsMap = OPS_TABLE) {
  // v39: every write of the request is prepared first, then sent in ONE D1 batch (one call, one transaction: all or
  // nothing) when the adapter can batch; otherwise one by one, as before.
  const plan = [];
  for (const [key, table] of Object.entries(opsMap)) {
    const rows = (ops && ops[key]) || [];
    if (!rows.length) continue;
    const known = Object.keys(TABLES[table]);
    for (const row of rows) {
      const cols = known.filter((c) => row[c] !== undefined);
      const vals = cols.map((c) => toDb(table, c, row[c]));
      const isInsert = row._id === undefined || row._id === null || row._id === -1;
      let sql = null, params = null;
      if (isInsert) sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params = vals;
      else if (cols.length) sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, params = [...vals, Number(row._id)];
      plan.push({ key, table, row, cols, isInsert, sql, params });
    }
  }
  const stmts = plan.filter((p) => p.sql);
  let results;
  if (adapter.batch && stmts.length > 1) results = await adapter.batch(stmts.map((p) => ({ sql: p.sql, params: p.params, kind: 'run' })));
  else { results = []; for (const p of stmts) results.push(await adapter.run(p.sql, p.params)); }
  stmts.forEach((p, i) => { p.res = results[i]; });
  const upserts = {};
  for (const p of plan) {
    const id = p.isInsert ? Number(p.res && p.res.lastInsertRowid) : Number(p.row._id);
    // Echo the written row (with its id) for Finalize; booleans back to true/false.
    const out = { id };
    for (const c of p.cols) out[c] = p.row[c];
    coerceOut(p.table, out);
    (upserts[p.key] = upserts[p.key] || []).push(out);
  }
  return upserts;
}
