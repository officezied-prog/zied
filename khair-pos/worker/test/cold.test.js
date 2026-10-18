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

// v59 (owner 2026-10-18): the cooler's hours; a car entering after 17:00 records a full hour of overtime and its cause.
async function at(iso, fn) {
  const RealDate = Date, FIXED = RealDate.parse(iso);
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}
test('cold v59: the self-migration adds the hours / arrival / overtime columns to older tables (idempotent)', async () => {
  const db = newDb();
  db.exec('DROP TABLE cold_orders');
  db.exec('CREATE TABLE cold_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, status TEXT, lines TEXT)');
  db.exec('DROP TABLE cold_warehouses');
  db.exec('CREATE TABLE cold_warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT)');
  const a = sqliteAdapter(db);
  for (let i = 0; i < 2; i++) for (const sql of COLD_MIGRATIONS) { try { await a.run(sql, []); } catch (e) { /* already there */ } }
  const oc = a.all('PRAGMA table_info(cold_orders)', []).map((c) => c.name), wc = a.all('PRAGMA table_info(cold_warehouses)', []).map((c) => c.name);
  for (const c of ['extra_cost', 'extra_note', 'eta_at', 'arrived_at', 'door', 'ot_hours', 'ot_cost', 'ot_cause', 'ot_note', 'trip_cancels']) assert.ok(oc.includes(c), c);
  assert.ok(wc.includes('hours'));
});
test('cold v59: hours saved on a cooler; after 16:00 a same-day pickup asks first; the car at 17:10 = 1 hour Rp 300.000 with its cause, in D1', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const call = async (iso, action, user, pin, data) => at(iso, () => handleCold(a, base(action, user, pin, data), {}, KEY));
  const W = '2026-10-14T03:00:00Z'; // Wednesday 10:00 WIB
  assert.equal((await call(W, 'warehouse_save', 'Pemilik', '1234', { code: 'BOSCO', name: 'Bosco', hours: { open: '09:00', close: '17:00', brk: '12:00-13:00', last: '16:00', days: [1, 2, 3, 4, 5, 6], arrange: [0], ot: 300000 } })).ok, true);
  assert.deepEqual(JSON.parse(a.all("SELECT hours FROM cold_warehouses WHERE code = 'BOSCO'", [])[0].hours).days, [1, 2, 3, 4, 5, 6]);
  assert.equal((await call(W, 'pallet_in', 'Mgr', '2222', { warehouse: 'BOSCO', date: '2026-10-14', pallets: [{ pallet_code: 'P-59', product: 'AJWA', cartons: 40, exp_date: '2027-03-01' }] })).ok, true);
  const o = (await call(W, 'order_save', 'Mgr', '2222', { warehouse: 'BOSCO', order_date: '2026-10-14', dest_type: 'toko', lines: [{ pallet_code: 'P-59', cartons: 10 }] })).order;
  const late = '2026-10-14T09:20:00Z'; // 16:20 WIB
  assert.equal((await call(late, 'order_status', 'Mgr', '2222', { order_no: o.order_no, to: 'sent' })).error, 'AFTER_HOURS');
  assert.equal((await call(late, 'order_status', 'Mgr', '2222', { order_no: o.order_no, to: 'sent', when: 'overtime' })).ok, true);
  for (const to of ['approved', 'ready', 'dispatch']) assert.equal((await call(late, 'order_status', 'Mgr', '2222', { order_no: o.order_no, to })).ok, true);
  assert.equal((await call(late, 'trip_save', 'Mgr', '2222', { order_no: o.order_no, via: 'lalamove', driver: 'Pak Budi', plate: 'B 1 AB', eta_min: 40 })).error, 'LATE_CAR');
  assert.equal((await call(late, 'trip_save', 'Mgr', '2222', { order_no: o.order_no, via: 'lalamove', driver: 'Pak Budi', plate: 'B 1 AB', eta_min: 40, accept_ot: true })).ok, true);
  const r = await call('2026-10-14T10:15:00Z', 'order_arrived', 'Mgr', '2222', { order_no: o.order_no, time: '17:10', door: '2', cause: 'car_late' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = a.all('SELECT status, door, ot_hours, ot_cost, ot_cause, arrived_at, eta_at FROM cold_orders WHERE order_no = ?', [o.order_no])[0];
  assert.deepEqual({ ...row }, { status: 'arrived', door: '2', ot_hours: 1, ot_cost: 300000, ot_cause: 'car_late', arrived_at: '2026-10-14T10:10:00.000Z', eta_at: '2026-10-14T10:08:00.000Z' });
  const ot = (await call('2026-10-14T10:20:00Z', 'bootstrap', 'Mgr', '2222', {})).alerts.overtime;
  assert.deepEqual([ot.count, ot.hours, ot.cost], [1, 1, 300000]);
});

// v60 (owner 2026-10-17, stage 1b): an order read from a photo / a message. The AI (Anthropic API) is a stand-in fetch here.
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const aiReply = (o) => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(o) }] }), { status: 200 });
async function readSeed() {
  const db = seed(), a = sqliteAdapter(db), W = '2026-10-15T02:00:00Z'; // Thursday 09:00 WIB
  const r = await at(W, () => handleCold(a, base('pallet_in', 'Mgr', '2222', { warehouse: 'BOSCO', date: '2026-10-15', pallets: [
    { pallet_code: 'AJ-1', product: 'AJWA', cartons: 30, exp_date: '2027-02-01' }, { pallet_code: 'AJ-2', product: 'AJWA', cartons: 50, exp_date: '2026-12-01' }] }), {}, KEY));
  assert.equal(r.ok, true, JSON.stringify(r));
  return { a, W, read: (user, pin, data, env) => at(W, () => handleCold(a, base('order_read', user, pin, data), {}, KEY, { env })) };
}
test('cold v60: no AI key — a pasted message is read by fixed rules, a photo says the AI is off; nothing is saved', async () => {
  const { a, read } = await readSeed();
  let calls = 0;
  await withFetch(async () => { calls++; return aiReply({}); }, async () => {
    const r = await read('Mgr', '2222', { text: 'Ajwa 60 ctn\nPID AJ-1 5 dus', _ai: { text: '{"items":[{"pallet":"AJ-2","qty":1}]}' } }, {}); // a client's own _ai is ignored
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.read_by, r.ai, r.draft.warehouse], ['rules', 'off', 'BOSCO']);
    assert.deepEqual(r.draft.lines.map((l) => [l.pallet_code, l.cartons, l.src]), [['AJ-2', 50, 'fefo'], ['AJ-1', 15, 'fefo']]);
    assert.equal((await read('Mgr', '2222', { image_base64: 'data:image/jpeg;base64,' + 'A'.repeat(400) }, {})).error, 'AI_OFF');
  });
  assert.equal(calls, 0);
  assert.equal(a.all('SELECT COUNT(*) AS n FROM cold_orders', [])[0].n, 0);
  const bs = await at('2026-10-15T02:00:00Z', () => handleCold(a, base('bootstrap', 'Mgr', '2222'), {}, KEY, { env: {} }));
  assert.equal(bs.ai_reader, false);
  assert.equal((await at('2026-10-15T02:00:00Z', () => handleCold(a, base('bootstrap', 'Mgr', '2222'), {}, KEY, { env: { ANTHROPIC_API_KEY: 'k' } }))).ai_reader, true);
});
test('cold v60: a photo is read by claude-haiku-5-5 (the catalogue in the prompt); unclear lines → claude-sonnet-5-5 once; the accountant never reaches the AI', async () => {
  const { a, read } = await readSeed(), env = { ANTHROPIC_API_KEY: 'test-key' }, IMG = 'data:image/jpeg;base64,' + 'A'.repeat(400);
  const sent = [];
  // a clear sheet: one call to the small model
  let r = await withFetch(async (url, init) => { sent.push(JSON.parse(init.body)); return aiReply({ customer: { name: 'Toko Baru', phone: '0812 3456 7890' }, items: [{ pallet: 'AJ-1', qty: 0, line: 'PLT AJ-1' }, { code: 'AJWA', qty: 20, unit: 'ctn', line: 'Ajwa 20 ctn' }] }); },
    () => read('Mgr', '2222', { image_base64: IMG, mime: 'image/jpeg' }, env));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].model, sent[0].output_config.effort, sent[0].max_tokens], ['claude-haiku-5-5', 'low', 8000]);
  assert.match(sent[0].system, /ONE JSON object/);
  assert.equal(sent[0].messages[0].content[0].type, 'image');
  assert.match(sent[0].messages[0].content[1].text, /AJ-2 \| AJWA \| BOSCO \| 50/);
  assert.equal(r.read_by, 'claude-haiku-5-5');
  assert.deepEqual(r.draft.lines.map((l) => [l.pallet_code, l.cartons]), [['AJ-1', 30], ['AJ-2', 20]]);
  assert.deepEqual([r.draft.dest_type, r.draft.dest_name, r.draft.dest_phone], ['pelanggan', 'Toko Baru', '6281234567890']);
  // an unclear line: the stronger model reads it once more, and its clearer reading is used
  sent.length = 0;
  r = await withFetch(async (url, init) => {
    const b = JSON.parse(init.body); sent.push(b);
    return b.model === 'claude-haiku-5-5' ? aiReply({ items: [{ pallet: 'AJ-7', product: '?', qty: 5, unclear: true }] }) : aiReply({ items: [{ pallet: 'AJ-1', qty: 5 }] });
  }, () => read('Mgr', '2222', { image_base64: IMG }, env));
  assert.deepEqual(sent.map((b) => [b.model, b.output_config.effort]), [['claude-haiku-5-5', 'low'], ['claude-sonnet-5-5', 'medium']]);
  assert.deepEqual([r.read_by, r.draft.unclear, r.draft.lines[0].pallet_code], ['claude-sonnet-5-5', 0, 'AJ-1']);
  // the small model is down (529): the stronger one reads it; both down: said
  r = await withFetch(async (url, init) => (JSON.parse(init.body).model === 'claude-haiku-5-5' ? new Response('{}', { status: 529 }) : aiReply({ items: [{ pallet: 'AJ-2', qty: 3 }] })),
    () => read('Mgr', '2222', { image_base64: IMG }, env));
  assert.deepEqual([r.ok, r.read_by], [true, 'claude-sonnet-5-5']);
  r = await withFetch(async () => new Response('{}', { status: 500 }), () => read('Mgr', '2222', { image_base64: IMG }, env));
  assert.deepEqual([r.ok, r.error], [false, 'AI_ERROR']);
  // a typed message with the AI down: the fixed rules
  r = await withFetch(async () => new Response('{}', { status: 500 }), () => read('Mgr', '2222', { text: 'Ajwa 10 ctn' }, env));
  assert.deepEqual([r.ok, r.read_by, r.ai, r.draft.lines.length], [true, 'rules', 'error', 1]);
  // the accountant (read-only) and a wrong PIN never reach the AI
  let calls = 0;
  await withFetch(async () => { calls++; return aiReply({ items: [] }); }, async () => {
    assert.equal((await read('Akun', '3333', { image_base64: IMG }, env)).error, 'FORBIDDEN');
    assert.equal((await read('Mgr', '9999', { image_base64: IMG }, env)).error, 'BAD_PIN');
  });
  assert.equal(calls, 0);
  assert.equal(a.all('SELECT COUNT(*) AS n FROM cold_orders', [])[0].n, 0); // reading never saves an order
});
