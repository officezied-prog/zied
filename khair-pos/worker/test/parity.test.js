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
