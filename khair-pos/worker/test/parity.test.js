// Parity tests for the code backend. They prove three things that matter for a money/stock
// system:
//   1. the build-time wrap of process.js preserves behaviour (generated runProcess ==
//      original process.js for the same inputs);
//   2. the SQL loaders reproduce the live n8n "Get X" filters (range, equality, OR);
//   3. the boolean round-trip is correct (the subtle 0/1-vs-true/false trap).
// Run: npm test  (node --experimental-sqlite --test test/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';
import { parseRequest } from '../src/parse.js';
import { loadNodes, makeAccessor } from '../src/db.js';
import { runProcess } from '../src/generated/process.gen.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const origSrc = readFileSync(new URL('../../backend/process.js', import.meta.url), 'utf8').replace('__STORE_KEY__', KEY);
const origFn = new Function('$', origSrc);

const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 150000, retail_price: 185000, wholesale_price: 170000, wholesale_min_qty: 5, stock: 20, shop_stock: 20, min_stock: 3, active: true });
  insert(db, 'pos_products', { id: 2, sku: '222', name: 'Kismis 500g', category: 'kismis', unit: 'pcs', cost_price: 20000, retail_price: 25000, wholesale_price: 23000, wholesale_min_qty: 10, stock: 50, shop_stock: 50, min_stock: 5, active: true });
  insert(db, 'pos_customers', { id: 7, name: 'Toko Berkah', phone: '0812', type: 'grosir', address: '', notes: '', debt_balance: 100000 });
  // Open cashier shifts (selling requires an open shift), mirroring the harness DEFSHIFTS.
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', opening_cash: 200000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  insert(db, 'pos_shifts', { id: 22, shift_id: 'SHJ', cashier: 'Jihan', status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}

// Deterministic Math.random + Date so the two process implementations, fed identical
// inputs, produce identical output (random invoice ids / wall-clock timestamps aside).
function frozen(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-06T03:00:00.000Z');
  const oR = Math.random;
  let s = 12345;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
    static now() { return FIXED; }
  }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = oR; }
}

async function nodesFor(db, body) {
  const req = parseRequest(body, {});
  return { req, nodes: await loadNodes(sqliteAdapter(db), req) };
}

// ---- 1. build-transform equivalence -------------------------------------
test('generated runProcess == original process.js (same inputs)', async () => {
  const cases = [
    base('users', 'Siti', '1111'),
    base('bootstrap', 'Siti', '1111'),
    { action: 'bootstrap', key: 'WRONG', user: 'Siti', pin_hash: h('Siti', '1111'), data: {} },
    base('bootstrap', 'Siti', '9999'), // wrong pin
    base('save_sale', 'Siti', '1111', { client_id: 'c1', sale_date: '2026-10-06', items: [{ product_id: 1, qty: 2, unit_price: 185000 }], payment_method: 'tunai', paid_amount: 400000 }),
    base('save_customer', 'Siti', '1111', { name: 'Bu Aisyah', phone: '0813 1111 2222', email: 'a@mail.com', member: true }),
    base('save_product', 'Pemilik', '1234', { name: 'Madu 250g', sku: '333', unit: 'pcs', retail_price: 50000, cost_price: 35000, stock: 12 }),
    base('get_sales', 'Pemilik', '1234', { from: '2026-10-01', to: '2026-10-31' }),
  ];
  for (const body of cases) {
    const { nodes } = await nodesFor(seed(), body);
    const $ = makeAccessor(nodes);
    const gen = frozen(() => runProcess($, KEY)[0].json);
    const orig = frozen(() => origFn($)[0].json);
    assert.deepEqual(gen, orig, 'mismatch for action ' + body.action);
  }
});

// ---- 2. loader filters ---------------------------------------------------
test('Get Range Sales matches date range (and excludes outside)', async () => {
  const db = seed();
  await handleRequest(sqliteAdapter(db), base('save_sale', 'Siti', '1111', { client_id: 'c1', sale_date: '2026-10-06', items: [{ product_id: 1, qty: 1, unit_price: 185000 }], payment_method: 'tunai', paid_amount: 185000 }), {}, KEY);
  const inRange = await nodesFor(db, base('get_sales', 'Pemilik', '1234', { from: '2026-10-01', to: '2026-10-31' }));
  assert.equal(inRange.nodes['Get Range Sales'].length, 1);
  const outRange = await nodesFor(db, base('get_sales', 'Pemilik', '1234', { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(outRange.nodes['Get Range Sales'].length, 0);
});

test('Get Approvals uses OR: pending + referenced-by-id (even if decided)', async () => {
  const db = seed();
  insert(db, 'pos_approvals', { id: 50, request_id: 'AP1', status: 'approved', kind: 'discount', client_id: 'd2', approver_role: 'manager' });
  insert(db, 'pos_approvals', { id: 51, request_id: 'AP2', status: 'pending', kind: 'discount', approver_role: 'manager' });
  insert(db, 'pos_approvals', { id: 52, request_id: 'AP3', status: 'approved', kind: 'discount', approver_role: 'manager' });
  const { nodes } = await nodesFor(db, base('save_sale', 'Siti', '1111', { client_id: 'd2', discount_approval_id: 'AP1', items: [{ product_id: 1, qty: 1, unit_price: 185000 }] }));
  const ids = nodes['Get Approvals'].map((a) => a.request_id).sort();
  assert.deepEqual(ids, ['AP1', 'AP2']); // AP1 by id (approved), AP2 by status; AP3 excluded
});

test('Get Sale By Client equality filter', async () => {
  const db = seed();
  await handleRequest(sqliteAdapter(db), base('save_sale', 'Siti', '1111', { client_id: 'uniq-123', sale_date: '2026-10-06', items: [{ product_id: 1, qty: 1, unit_price: 185000 }], payment_method: 'tunai', paid_amount: 185000 }), {}, KEY);
  const hit = await nodesFor(db, base('save_sale', 'Siti', '1111', { client_id: 'uniq-123', items: [] }));
  assert.equal(hit.nodes['Get Sale By Client'].length, 1);
  const miss = await nodesFor(db, base('save_sale', 'Siti', '1111', { client_id: 'other', items: [] }));
  assert.equal(miss.nodes['Get Sale By Client'].length, 0);
});

// ---- 3. boolean round-trip (the trap) ------------------------------------
test('boolean columns round-trip as true/false, not 0/1', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 9, name: 'Budi', role: 'kasir', pin_hash: h('Budi', '1111'), active: false });
  const { nodes } = await nodesFor(db, base('users', 'Siti', '1111'));
  const budi = nodes['Get Users'].find((u) => u.name === 'Budi');
  assert.equal(budi.active, false); // must be false, not 0
  const siti = nodes['Get Users'].find((u) => u.name === 'Siti');
  assert.equal(siti.active, true); // must be true, not 1
  // end-to-end: the `users` action returns only active (active !== false); if active read
  // back as 0, Budi would wrongly be included.
  const r = await handleRequest(sqliteAdapter(db), base('users', 'Siti', '1111'), {}, KEY);
  assert.ok(r.users && !r.users.find((u) => u.name === 'Budi'), 'inactive user must be excluded');
  assert.ok(r.users.find((u) => u.name === 'Siti'), 'active user must be present');
});

// ---- 4. end-to-end writes --------------------------------------------------
test('save_sale writes sale + items and decrements stock (booleans preserved)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleRequest(a, base('save_sale', 'Siti', '1111', { client_id: 'c1', sale_date: '2026-10-06', items: [{ product_id: 1, qty: 2, unit_price: 185000 }], payment_method: 'tunai', paid_amount: 400000 }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = a.all('SELECT stock, shop_stock, active FROM pos_products WHERE id = 1', [])[0];
  assert.equal(p.stock, 18);
  assert.equal(p.shop_stock, 18);
  assert.equal(p.active, 1, 'active must survive the update'); // stored 1 (reads back true via coerce)
  const sales = a.all('SELECT * FROM pos_sales', []);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].total, 370000);
  const items = a.all('SELECT * FROM pos_sale_items', []);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 2);
});

test('save_customer inserts a new row with member=true', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleRequest(a, base('save_customer', 'Siti', '1111', { name: 'Bu Aisyah', phone: '0813 1111 2222', email: 'a@mail.com', member: true }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = a.all("SELECT * FROM pos_customers WHERE name = 'Bu Aisyah'", []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member, 1);
  assert.ok(rows[0].member_no, 'a member number is assigned');
});

test('save_product (owner) inserts; opening stock lands on the shelf', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleRequest(a, base('save_product', 'Pemilik', '1234', { name: 'Madu 250g', sku: '333', unit: 'pcs', retail_price: 50000, cost_price: 35000, stock: 12 }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = a.all("SELECT * FROM pos_products WHERE name = 'Madu 250g'", [])[0];
  assert.ok(p, 'product inserted');
  assert.equal(p.stock, 12);
  assert.equal(p.shop_stock, 12);
});

test('bad store key → BAD_KEY (business error, not a crash)', async () => {
  const db = seed();
  const r = await handleRequest(sqliteAdapter(db), { action: 'bootstrap', key: 'WRONG', user: 'Siti', pin_hash: h('Siti', '1111'), data: {} }, {}, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BAD_KEY');
});

test('save_purchase (goods-in) inserts a purchase and adds to warehouse stock', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  insert(db, 'pos_settings', { id: 10, skey: 'require_purchase_photo', svalue: 'false' });
  const r = await handleRequest(a, base('save_purchase', 'Siti', '1111', { supplier: 'PT Sumber', carrier: { type: 'teman', name: 'Pak Udin' }, items: [{ product_id: 2, qty: 10, cost_price: 20000, exp_date: '2027-06-01' }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const purch = a.all('SELECT * FROM pos_purchases', []);
  assert.equal(purch.length, 1);
  assert.equal(purch[0].product_id, 2);
  assert.equal(purch[0].qty, 10);
  const p2 = a.all('SELECT stock, shop_stock FROM pos_products WHERE id = 2', [])[0];
  assert.equal(p2.stock, 60); // 50 + 10 received into the warehouse
  assert.equal(p2.shop_stock, 50); // shelf unchanged
});

test('Get Bank Lines loader filters by account AND period (two-condition AND)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  insert(db, 'pos_bank_lines', { id: 1, line_id: 'L1', account_id: 'BCA', period: '2026-10', amount: 5000 });
  insert(db, 'pos_bank_lines', { id: 2, line_id: 'L2', account_id: 'BCA', period: '2026-09', amount: 7000 });
  insert(db, 'pos_bank_lines', { id: 3, line_id: 'L3', account_id: 'MANDIRI', period: '2026-10', amount: 9000 });
  const req = parseRequest({ action: 'import_statement', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { account_id: 'BCA', period: '2026-10' } }, {});
  const nodes = await loadNodes(a, req);
  assert.deepEqual(nodes['Get Bank Lines'].map((x) => x.line_id), ['L1']); // only BCA + 2026-10
});

test('Get Party Payments loader uses OR (this customer OR this supplier)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  insert(db, 'pos_payments', { id: 1, pay_id: 'P1', customer_id: 7, direction: 'in', amount: 1000 });
  insert(db, 'pos_payments', { id: 2, pay_id: 'P2', supplier: 'PT X', direction: 'out', amount: 2000 });
  insert(db, 'pos_payments', { id: 3, pay_id: 'P3', customer_id: 99, direction: 'in', amount: 3000 });
  const req = parseRequest({ action: 'party_ledger', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { party_type: 'customer', customer_id: 7 } }, {});
  const nodes = await loadNodes(a, req);
  assert.deepEqual(nodes['Get Party Payments'].map((x) => x.pay_id), ['P1']); // customer 7 only
});

test('void_sale restores stock and marks the sale void (invoice loaders + multi-table write)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const s = await handleRequest(a, base('save_sale', 'Siti', '1111', { client_id: 'v1', sale_date: '2026-10-06', items: [{ product_id: 1, qty: 3, unit_price: 185000 }], payment_method: 'tunai', paid_amount: 600000 }), {}, KEY);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(a.all('SELECT stock FROM pos_products WHERE id = 1', [])[0].stock, 17);
  const inv = a.all('SELECT invoice_no FROM pos_sales', [])[0].invoice_no;
  const r = await handleRequest(a, { action: 'void_sale', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { invoice_no: inv, reason: 'salah' } }, {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = a.all('SELECT stock, shop_stock FROM pos_products WHERE id = 1', [])[0];
  assert.equal(p.stock, 20); // restored
  assert.equal(p.shop_stock, 20);
  assert.equal(a.all('SELECT status FROM pos_sales WHERE invoice_no = ?', [inv])[0].status, 'void');
});

test('receive_payment reduces debt and records an inbound payment (party loaders + updates)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleRequest(a, { action: 'receive_payment', key: KEY, user: 'Siti', pin_hash: h('Siti', '1111'), data: { customer_id: 7, amount: 40000, method: 'tunai' } }, {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(a.all('SELECT debt_balance FROM pos_customers WHERE id = 7', [])[0].debt_balance, 60000);
  const pays = a.all('SELECT * FROM pos_payments', []);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].amount, 40000);
  assert.equal(pays[0].direction, 'in');
});

test('discount-approval flow end-to-end across separate calls (OR loader + insert/update persistence)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  // 5% discount (9250 on a 185000 line) is over the kasir 3% limit → needs approval.
  const req1 = await handleRequest(a, base('request_discount', 'Siti', '1111', { client_id: 'd2', sale_date: '2026-10-06', items: [{ product_id: 1, qty: 1, unit_price: 185000 }], discount: 9250, reason: 'pelanggan tetap' }), {}, KEY);
  assert.equal(req1.ok, true, JSON.stringify(req1));
  const ap = a.all('SELECT request_id, status FROM pos_approvals', []);
  assert.equal(ap.length, 1);
  assert.equal(ap[0].status, 'pending');
  const rid = ap[0].request_id;
  const list = await handleRequest(a, base('list_approvals', 'Jihan', '2222', {}), {}, KEY);
  assert.ok(list.approvals.find((x) => x.request_id === rid), 'manager sees the pending approval');
  const dec = await handleRequest(a, { action: 'decide_approval', key: KEY, user: 'Jihan', pin_hash: h('Jihan', '2222'), data: { request_id: rid, decision: 'approved' } }, {}, KEY);
  assert.equal(dec.ok, true, JSON.stringify(dec));
  assert.equal(a.all('SELECT status FROM pos_approvals WHERE request_id = ?', [rid])[0].status, 'approved');
  // The sale now succeeds; Get Approvals (OR) must fetch the approved (non-pending) approval by id.
  const sale = await handleRequest(a, base('save_sale', 'Siti', '1111', { client_id: 'd2', sale_date: '2026-10-06', items: [{ product_id: 1, qty: 1, unit_price: 185000 }], discount: 9250, payment_method: 'tunai', paid_amount: 200000, discount_approval_id: rid }), {}, KEY);
  assert.equal(sale.ok, true, JSON.stringify(sale));
  assert.equal(a.all('SELECT COUNT(*) n FROM pos_sales', [])[0].n, 1);
});
