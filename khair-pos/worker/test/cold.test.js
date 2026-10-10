// Parity + behaviour tests for the Cold-storage (gudang) API. The build-time wrap of
// cold-parsers.js + cold-core.js + process-cold.js preserves behaviour, the loaders/writer wire
// up like the other workflows, and the separate "Check Key" node is synthesized by handleCold.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleCold, parseCold, loadColdNodes } from '../src/cold.js';
import { makeAccessor } from '../src/db.js';
import { runProcessCold } from '../src/generated/process-cold.gen.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');

// The original n8n "Process Cold" node = the three files concatenated (no STORE_KEY decl here).
const COLD = ['cold-parsers.js', 'cold-core.js', 'process-cold.js']
  .map((f) => readFileSync(new URL('../../backend/cold/' + f, import.meta.url), 'utf8')).join('\n');
const origColdFn = new Function('$', COLD);

const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Mgr', role: 'manager', pin_hash: h('Mgr', '2222'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Akun', role: 'akuntan', pin_hash: h('Akun', '3333'), active: true });
  insert(db, 'pos_settings', { id: 1, skey: 'cold_company', svalue: JSON.stringify('PT. SAIDA REZEKI ABADI') });
  insert(db, 'cold_warehouses', { id: 1, code: 'BOSCO', name: 'Bosco', active: true, parser: 'generic', created_at: '2026-01-01' });
  insert(db, 'cold_products', { id: 1, code: 'AJWA', name: 'Ajwa', kg_per_ctn: 10, ctn_per_pallet: 50, active: true });
  return db;
}

// cold_* tables already exist via schema.sql (newDb loads it), so ensureColdSchema is a no-op here.
function nodes(adapter, body) {
  return loadColdNodes(adapter, parseCold(body)).then((n) => { n['Check Key'] = [{ key_ok: body.key === KEY }]; return n; });
}

function frozen(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-06T03:00:00.000Z');
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

test('cold: generated runProcessCold == original cold-core concat', async () => {
  const cases = [
    base('login', 'Pemilik', '1234'),
    base('bootstrap', 'Pemilik', '1234'),
    base('bootstrap', 'Akun', '3333'),
    base('warehouse_save', 'Pemilik', '1234', { name: 'DP', mode: 'tabrid' }),
    base('product_save', 'Pemilik', '1234', { name: 'Sukkari', kg_per_ctn: 5, ctn_per_pallet: 80 }),
    { action: 'bootstrap', key: 'WRONG', user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: {} },
    base('bootstrap', 'Ghost', '0000'), // unknown user
  ];
  for (const body of cases) {
    const n = await nodes(sqliteAdapter(seed()), body);
    const $ = makeAccessor(n);
    const gen = frozen(() => runProcessCold($)[0].json);
    const orig = frozen(() => origColdFn($)[0].json);
    assert.deepEqual(gen, orig, 'mismatch for cold action ' + body.action + ' key=' + body.key);
  }
});

test('cold: login + bootstrap for the owner', async () => {
  const a = sqliteAdapter(seed());
  const r = await handleCold(a, base('login', 'Pemilik', '1234'), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.me.role, 'owner');
  const b = await handleCold(a, base('bootstrap', 'Pemilik', '1234'), {}, KEY);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.warehouses.length, 1);
  assert.equal(b.warehouses[0].code, 'BOSCO');
  assert.equal(b.products.length, 1);
  assert.ok(Array.isArray(b.stock));
});

test('cold: wrong store key is rejected (synthetic Check Key node)', async () => {
  const a = sqliteAdapter(seed());
  const r = await handleCold(a, { action: 'bootstrap', key: 'NOPE', user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: {} }, {}, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BAD_KEY');
});

test('cold: warehouse_save persists a cold room (owner only)', async () => {
  const a = sqliteAdapter(seed());
  const r = await handleCold(a, base('warehouse_save', 'Pemilik', '1234', { name: 'DP Cikarang' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = a.all("SELECT * FROM cold_warehouses WHERE name = 'DP Cikarang'", []);
  assert.equal(rows.length, 1);
  // a manager may NOT save a warehouse (OWNER_ONLY)
  const r2 = await handleCold(a, base('warehouse_save', 'Mgr', '2222', { name: 'BP' }), {}, KEY);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'FORBIDDEN');
});

test('cold: the accountant is read-only', async () => {
  const a = sqliteAdapter(seed());
  const ok = await handleCold(a, base('bootstrap', 'Akun', '3333'), {}, KEY);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const no = await handleCold(a, base('product_save', 'Akun', '3333', { name: 'X' }), {}, KEY);
  assert.equal(no.ok, false);
  assert.equal(no.error, 'FORBIDDEN');
});

// ---- Batch C features ----

test('cold C: warehouse_save stores the cooler mode (home page)', async () => {
  const a = sqliteAdapter(seed());
  const r = await handleCold(a, base('warehouse_save', 'Pemilik', '1234', { name: 'BP', mode: 'tajmid' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warehouse.mode, 'tajmid');
  assert.equal(a.all("SELECT mode FROM cold_warehouses WHERE name = 'BP'", [])[0].mode, 'tajmid');
  // an invalid mode is ignored (not stored)
  const r2 = await handleCold(a, base('warehouse_save', 'Pemilik', '1234', { name: 'BP', mode: 'xxx' }), {}, KEY);
  assert.equal(r2.warehouse.mode, '');
});

test('cold C: customer_save registers a reusable customer; bootstrap returns it', async () => {
  const a = sqliteAdapter(seed());
  const r = await handleCold(a, base('customer_save', 'Mgr', '2222', { name: 'Toko Berkah', phone: '0812 3456 7890', address: 'Condet' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = a.all("SELECT * FROM pos_customers WHERE name = 'Toko Berkah'", []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'gudang');
  assert.equal(rows[0].debt_balance, 0);
  assert.ok(rows[0].phone.replace(/\D/g, '').length >= 9, 'phone normalised: ' + rows[0].phone);
  const b = await handleCold(a, base('bootstrap', 'Pemilik', '1234'), {}, KEY);
  assert.ok(b.customers.some((c) => c.name === 'Toko Berkah' && c.address === 'Condet'), 'customer in bootstrap');
});

test('cold C: editing a customer never clobbers POS-only columns (debt/member)', async () => {
  const db = seed();
  insert(db, 'pos_customers', { id: 40, name: 'Lama', phone: '0811', address: 'A', type: 'grosir', debt_balance: 250000, member: true, member_no: 'M-1' });
  const a = sqliteAdapter(db);
  const r = await handleCold(a, base('customer_save', 'Pemilik', '1234', { id: 40, name: 'Lama Baru', phone: '0822 1111 2222', address: 'B' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = a.all('SELECT * FROM pos_customers WHERE id = 40', [])[0];
  assert.equal(row.name, 'Lama Baru');
  assert.equal(row.address, 'B');
  assert.equal(row.debt_balance, 250000, 'debt untouched');
  assert.equal(row.member, 1, 'member flag untouched');
  assert.equal(row.member_no, 'M-1', 'member_no untouched');
});

test('cold C: the accountant may not register a customer (read-only)', async () => {
  const a = sqliteAdapter(seed());
  const r = await handleCold(a, base('customer_save', 'Akun', '3333', { name: 'X' }), {}, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FORBIDDEN');
});

test('cold C: order_save links to a registered customer and auto-fills name/address', async () => {
  const db = seed();
  insert(db, 'cold_pallets', { id: 1, pallet_code: 'P001', product: 'Ajwa', warehouse: 'BOSCO', kg_per_ctn: 10, exp_date: '2027-01-01', date_in: '2026-10-01' });
  insert(db, 'cold_movements', { id: 1, seq: 1, move_date: '2026-10-01', type: 'IN', pallet_code: 'P001', warehouse: 'BOSCO', cartons: 100, grp: 1, by_user: 'Pemilik' });
  insert(db, 'pos_customers', { id: 50, name: 'Pelanggan Jauh', phone: '0813', address: 'Bekasi', type: 'grosir', debt_balance: 0 });
  const a = sqliteAdapter(db);
  const r = await handleCold(a, base('order_save', 'Pemilik', '1234', { warehouse: 'BOSCO', dest_type: 'pelanggan', customer_id: 50, lines: [{ pallet_code: 'P001', cartons: 5 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.dest_name, 'Pelanggan Jauh');
  assert.equal(r.order.dest_address, 'Bekasi');
  assert.equal(r.order.customer_id, 50);
  assert.equal(a.all('SELECT customer_id FROM cold_orders WHERE order_no = ?', [r.order.order_no])[0].customer_id, 50);
});
