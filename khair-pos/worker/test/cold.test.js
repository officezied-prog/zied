// Parity + behaviour tests for the Cold-storage (gudang) API. The build-time wrap of
// cold-parsers.js + cold-core.js + process-cold.js preserves behaviour, the loaders/writer wire
// up like the other workflows, and the separate "Check Key" node is synthesized by handleCold.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleCold, parseCold, loadColdNodes, COLD_MIGRATIONS } from '../src/cold.js';
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

// Runs before the other handleCold tests so the once-per-process schema flag is still fresh.
test('cold C: a fresh (empty) cold DB is seeded with the cut-over setup (3 coolers + 1 product)', async () => {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_settings', { id: 1, skey: 'cold_company', svalue: JSON.stringify('PT. SAIDA REZEKI ABADI') });
  const a = sqliteAdapter(db);
  const b = await handleCold(a, base('bootstrap', 'Pemilik', '1234'), {}, KEY);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(b.warehouses.map((w) => w.code).sort(), ['BOSKO', 'DPP', 'KAWANISHI']);
  assert.equal(b.products.length, 1);
  assert.equal(b.products[0].name, 'تمر عجوة');
  assert.equal(b.warehouses.find((w) => w.code === 'DPP').rate_frozen, 9500);
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

// v62 (owner 2026-10-19: «المدير يعدل و المحاسب بإذن من المدير»): the manager edits products; the accountant proposes, the manager decides
test('cold v62: the manager saves a product; the accountant\'s proposal waits in cold_product_requests until the manager approves it', async () => {
  const a = sqliteAdapter(seed());
  const m = await handleCold(a, base('product_save', 'Mgr', '2222', { code: 'AJWA', name: 'Ajwa', kg_per_ctn: 10, ctn_per_pallet: 60 }), {}, KEY);
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.equal(a.all("SELECT ctn_per_pallet FROM cold_products WHERE code = 'AJWA'", [])[0].ctn_per_pallet, 60);
  const p = await handleCold(a, base('product_request', 'Akun', '3333', { code: 'AJWA', name: 'Ajwa Jumbo', kg_per_ctn: 10, ctn_per_pallet: 64, note: 'Nama di gudang' }), {}, KEY);
  assert.equal(p.ok, true, JSON.stringify(p));
  const rows = a.all('SELECT * FROM cold_product_requests', []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending'); assert.equal(rows[0].requested_by, 'Akun'); assert.equal(JSON.parse(rows[0].data).ctn_per_pallet, 64);
  assert.equal(a.all("SELECT name FROM cold_products WHERE code = 'AJWA'", [])[0].name, 'Ajwa'); // nothing changed yet
  const b = await handleCold(a, base('bootstrap', 'Mgr', '2222'), {}, KEY);
  assert.equal(b.alerts.product_requests, 1); assert.equal(b.requests[0].is_new, false); assert.equal(b.requests[0].id, rows[0].id);
  const no = await handleCold(a, base('request_decide', 'Akun', '3333', { id: rows[0].id, approve: true }), {}, KEY);
  assert.equal(no.error, 'FORBIDDEN');
  const d = await handleCold(a, base('request_decide', 'Mgr', '2222', { id: rows[0].id, approve: true }), {}, KEY);
  assert.equal(d.ok, true, JSON.stringify(d));
  const pr = a.all("SELECT * FROM cold_products WHERE code = 'AJWA'", []);
  assert.equal(pr.length, 1); assert.equal(pr[0].name, 'Ajwa Jumbo'); assert.equal(pr[0].ctn_per_pallet, 64);
  const after = a.all('SELECT * FROM cold_product_requests', []);
  assert.equal(after.length, 1); assert.equal(after[0].status, 'approved'); assert.equal(after[0].decided_by, 'Mgr'); assert.equal(after[0].result_code, 'AJWA');
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

// ---- v36 (owner 2026-10-11) ----

function v36db() {
  const db = seed();
  insert(db, 'cold_containers', { id: 1, container_no: 'CGMU5288973', size: '40', warehouse: 'BOSCO', arrival_date: '2026-09-25' });
  insert(db, 'cold_pallets', { id: 1, pallet_code: 'P001', product: 'AJWA', warehouse: 'BOSCO', kg_per_ctn: 10, exp_date: '2027-01-01', date_in: '2026-10-01', container_no: 'CGMU5288973' });
  insert(db, 'cold_pallets', { id: 2, pallet_code: 'P002', product: 'AJWA', warehouse: 'BOSCO', kg_per_ctn: 10, exp_date: '2027-02-01', date_in: '2026-10-01', container_no: 'CGMU5288973' });
  insert(db, 'cold_movements', { id: 1, seq: 1, move_date: '2026-10-01', type: 'IN', pallet_code: 'P001', warehouse: 'BOSCO', cartons: 50, grp: 1, by_user: 'Pemilik' });
  insert(db, 'cold_movements', { id: 2, seq: 2, move_date: '2026-10-01', type: 'IN', pallet_code: 'P002', warehouse: 'BOSCO', cartons: 50, grp: 1, by_user: 'Pemilik' });
  return db;
}

test('cold v36: a customer typed into an order is saved to pos_customers (name, address, phone); plate + phone persist on the order', async () => {
  const a = sqliteAdapter(v36db());
  const r = await handleCold(a, base('order_save', 'Mgr', '2222', { warehouse: 'BOSCO', dest_type: 'pelanggan', dest_name: 'Toko Baru', dest_address: 'Condet 9', dest_phone: '0812 7777 8888',
    plate: 'b 1234 xy', vehicle: 'Pickup', lines: [{ pallet_code: 'P001', cartons: 50 }, { pallet_code: 'P002', cartons: 10 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const cs = a.all("SELECT * FROM pos_customers WHERE name = 'Toko Baru'", []);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].address, 'Condet 9');
  assert.equal(cs[0].phone, '6281277778888');
  assert.equal(cs[0].source, 'gudang');
  const row = a.all('SELECT plate, dest_phone, lines FROM cold_orders WHERE order_no = ?', [r.order.order_no])[0];
  assert.equal(row.plate, 'B 1234 XY');
  assert.equal(row.dest_phone, '6281277778888');
  // each line: the container number and full pallet (P001: all 50) vs some cartons (P002: 10 of 50)
  assert.deepEqual(JSON.parse(row.lines).map((l) => [l.pallet_code, l.container_no, l.full]), [['P001', 'CGMU5288973', true], ['P002', 'CGMU5288973', false]]);
  const b = await handleCold(a, base('bootstrap', 'Pemilik', '1234'), {}, KEY);
  const o = b.orders.find((x) => x.order_no === r.order.order_no);
  assert.equal(o.plate, 'B 1234 XY');
  assert.deepEqual(o.lines.map((l) => [l.full, l.pallet_ctn]), [[true, 50], [false, 50]]);
  assert.ok(b.customers.some((c) => c.name === 'Toko Baru' && c.phone === '6281277778888'), 'in the customer list');
  // a second order for the same name: the customer is updated (new address), never duplicated, and the order links to it
  const r2 = await handleCold(a, base('order_save', 'Pemilik', '1234', { warehouse: 'BOSCO', dest_type: 'pelanggan', dest_name: 'TOKO BARU', dest_address: 'Condet 10', lines: [{ pallet_code: 'P002', cartons: 5 }] }), {}, KEY);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const cs2 = a.all("SELECT * FROM pos_customers WHERE lower(name) = 'toko baru'", []);
  assert.equal(cs2.length, 1);
  assert.equal(cs2[0].address, 'Condet 10');
  assert.equal(cs2[0].phone, '6281277778888', 'phone kept when not typed');
  assert.equal(r2.order.customer_id, cs2[0].id);
  assert.equal(r2.order.dest_phone, '6281277778888');
});

test('cold v36: an existing customer edited through an order keeps its POS-only columns (debt/member)', async () => {
  const db = v36db();
  insert(db, 'pos_customers', { id: 40, name: 'Lama', phone: '6281100000000', address: 'A', type: 'grosir', debt_balance: 250000, member: true, member_no: 'M-1' });
  const a = sqliteAdapter(db);
  const r = await handleCold(a, base('order_save', 'Pemilik', '1234', { warehouse: 'BOSCO', dest_type: 'pelanggan', customer_id: 40, dest_name: 'Lama', dest_address: 'B', dest_phone: '0822 1111 2222', lines: [{ pallet_code: 'P001', cartons: 1 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = a.all('SELECT * FROM pos_customers WHERE id = 40', [])[0];
  assert.equal(row.address, 'B');
  assert.equal(row.phone, '6282211112222');
  assert.equal(row.debt_balance, 250000);
  assert.equal(row.member_no, 'M-1');
  assert.equal(a.all('SELECT COUNT(*) AS n FROM pos_customers', [])[0].n, 1);
});

test('cold v36: the self-migration adds plate / dest_phone to an older cold_orders table (idempotent)', async () => {
  const db = newDb();
  db.exec('DROP TABLE cold_orders');
  db.exec('CREATE TABLE cold_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, status TEXT, lines TEXT)');
  const a = sqliteAdapter(db);
  for (let i = 0; i < 2; i++) for (const sql of COLD_MIGRATIONS) { try { await a.run(sql, []); } catch (e) { /* already there */ } }
  const cols = a.all('PRAGMA table_info(cold_orders)', []).map((c) => c.name);
  assert.ok(cols.includes('plate') && cols.includes('dest_phone'), cols.join(','));
});
