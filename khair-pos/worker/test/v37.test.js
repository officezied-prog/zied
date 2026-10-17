// v37 (owner 2026-10-12) — the real backend (backend/process.js through the Worker's loaders) on an in-memory SQLite:
//   1. every change to a saved invoice leaves ONE audit record (activity kind 'ubah_faktur') with date & time, each item
//      from → to, the reason, who asked and who approved — and it reaches the owner (bootstrap notifications);
//      list_invoice_changes returns them per period (purchase prices only for whoever may see costs);
//   2. a FULL stock count every opname_every_days (default 60): status on bootstrap, the cycle, the overdue notice (once);
//   3. the daily report lists the day's goods-in notes with their lines, the stock now and the day's invoice changes.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest, _resetPosSchemaForTests } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const jkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const dayPlus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const call = (a, action, user, pin, data) => handleRequest(a, base(action, user, pin, data), {}, KEY);
const OWNER = ['Pemilik', '1234'], KASIR = ['Siti', '1111'], MGR = ['Jihan', '2222'], AK = ['Aqil', '4444'];

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, wholesale_price: 170000, wholesale_min_qty: 5, stock: 20, shop_stock: 20, min_stock: 3, active: true });
  insert(db, 'pos_products', { id: 2, sku: '222', name: 'Kismis 500g', unit: 'pcs', cost_price: 20000, retail_price: 25000, wholesale_price: 23000, wholesale_min_qty: 10, stock: 50, shop_stock: 50, min_stock: 5, active: true });
  insert(db, 'pos_products', { id: 3, sku: '333', name: 'Madu 250g', unit: 'btl', cost_price: 40000, retail_price: 55000, wholesale_price: 0, wholesale_min_qty: 0, stock: 10, shop_stock: 10, min_stock: 2, active: true });
  insert(db, 'pos_settings', { id: 10, skey: 'require_purchase_photo', svalue: 'false' });
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', shift_date: jkToday(), opening_cash: 200000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const changes = (a) => a.all("SELECT * FROM pos_activity WHERE kind = 'ubah_faktur' ORDER BY id", []).map((r) => Object.assign(r, { d: JSON.parse(r.detail || '{}') }));
async function goodsIn(a, who = KASIR, qty = 10) {
  const r = await call(a, 'save_purchase', who[0], who[1], { supplier: 'PT Sumber', purchase_date: jkToday(), carrier: { type: 'pemasok', name: 'Sopir' }, items: [{ product_id: 2, qty, cost_price: 20000, exp_date: '2027-06-01' }, { product_id: 3, qty: 4, cost_price: 41000, exp_none: true }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.purchase_no;
}

// ---- 1. invoice changes ----
test('v37 #1 goods-in correction approved by the manager → audit record + owner notice (who asked, who approved, from → to, time)', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const no = await goodsIn(a);
  const before = a.all('SELECT * FROM pos_purchases ORDER BY id', []);
  const rq = await call(a, 'request_purchase_fix', 'Siti', '1111', { purchase_no: no, reason: 'salah hitung', lines: [{ product_id: 2, qty: 8 }] });
  assert.equal(rq.ok, true, JSON.stringify(rq));
  assert.equal(rq.applied, false);
  // nothing changes before the approval — the saved rows stay exactly as they were
  assert.deepEqual(a.all('SELECT * FROM pos_purchases ORDER BY id', []), before);
  assert.equal(changes(a).length, 0);
  const d = await call(a, 'decide_approval', 'Jihan', '2222', { request_id: rq.request_id, decision: 'approved', purchase_no: no });
  assert.equal(d.ok, true, JSON.stringify(d));
  const c = changes(a);
  assert.equal(c.length, 1);
  assert.equal(c[0].ref, no);
  assert.equal(c[0].level, 'warn');
  assert.equal(c[0].d.doc, 'masuk');
  assert.equal(c[0].d.what, 'koreksi_masuk');
  assert.equal(c[0].d.requested_by, 'Siti');
  assert.equal(c[0].d.approved_by, 'Jihan');
  assert.equal(c[0].d.reason, 'salah hitung');
  assert.equal(c[0].d.party, 'PT Sumber');
  assert.ok(c[0].d.requested_at && c[0].d.approved_at);
  assert.deepEqual([c[0].d.changes[0].name, c[0].d.changes[0].qty_from, c[0].d.changes[0].qty_to], ['Kismis 500g', 10, 8]);
  assert.match(c[0].summary, /FAKTUR DIUBAH/);
  assert.match(c[0].summary, /qty 10→8/);
  assert.match(c[0].summary, /diminta Siti .* WIB, disetujui Jihan .* WIB/);
  // the owner sees it as a notice; the manager's own bootstrap does not list it as hers
  const bo = await call(a, 'bootstrap', 'Pemilik', '1234', {});
  assert.ok(bo.notifications.some((n) => n.kind === 'ubah_faktur' && n.ref === no), JSON.stringify(bo.notifications));
  // the audit list: owner sees prices; the manager too for a goods-in note (v59: the note's amounts are hers to see), not the
  // owner's summary; the accountant may read it; a cashier not
  const lo = await call(a, 'list_invoice_changes', 'Pemilik', '1234', { from: jkToday(), to: jkToday() });
  assert.equal(lo.ok, true, JSON.stringify(lo));
  assert.equal(lo.changes.length, 1);
  assert.equal(lo.changes[0].changes[0].price_to, 20000);
  assert.ok(lo.changes[0].summary);
  const lm = await call(a, 'list_invoice_changes', 'Jihan', '2222', { from: jkToday(), to: jkToday() });
  assert.equal(lm.changes[0].changes[0].qty_to, 8);
  assert.equal(lm.changes[0].changes[0].price_to, 20000);
  assert.equal(lm.changes[0].summary, undefined);
  assert.equal((await call(a, 'list_invoice_changes', 'Aqil', '4444', { from: jkToday(), to: jkToday() })).ok, true);
  assert.equal((await call(a, 'list_invoice_changes', 'Siti', '1111', { from: jkToday(), to: jkToday() })).error, 'FORBIDDEN');
  // another period: nothing
  assert.equal((await call(a, 'list_invoice_changes', 'Pemilik', '1234', { from: '2020-01-01', to: '2020-01-31' })).changes.length, 0);
});

test('v37 #1 a rejected correction changes nothing and leaves no change record; the owner\'s own correction is logged', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const no = await goodsIn(a);
  const rq = await call(a, 'request_purchase_fix', 'Siti', '1111', { purchase_no: no, reason: 'x', lines: [{ product_id: 2, qty: 7 }] });
  await call(a, 'decide_approval', 'Jihan', '2222', { request_id: rq.request_id, decision: 'rejected', purchase_no: no });
  assert.equal(changes(a).length, 0);
  // the manager's request goes to the owner; the owner approves → requested by Jihan, approved by Pemilik
  const rm = await call(a, 'request_purchase_fix', 'Jihan', '2222', { purchase_no: no, reason: 'nota benar 9', lines: [{ product_id: 2, qty: 9 }] });
  assert.equal(rm.approver_role, 'owner');
  assert.equal((await call(a, 'decide_approval', 'Jihan', '2222', { request_id: rm.request_id, decision: 'approved', purchase_no: no })).error, 'NEEDS_OWNER');
  assert.equal((await call(a, 'decide_approval', 'Pemilik', '1234', { request_id: rm.request_id, decision: 'approved', purchase_no: no })).ok, true);
  let c = changes(a);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].d.requested_by, c[0].d.approved_by], ['Jihan', 'Pemilik']);
  // the owner corrects directly: one record, asked = applied = the owner
  const ro = await call(a, 'request_purchase_fix', 'Pemilik', '1234', { purchase_no: no, reason: 'final', lines: [{ product_id: 3, qty: 3 }] });
  assert.equal(ro.applied, true);
  c = changes(a);
  assert.equal(c.length, 2);
  assert.deepEqual([c[1].d.requested_by, c[1].d.approved_by, c[1].d.changes[0].qty_from, c[1].d.changes[0].qty_to], ['Pemilik', 'Pemilik', 4, 3]);
  assert.match(c[1].summary, /diubah langsung oleh Pemilik/);
});

test('v37 #1 sale void (manager approves a cashier request; owner voids directly) → change record with every line', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const s = await call(a, 'save_sale', 'Siti', '1111', { client_id: 'v37a', sale_date: jkToday(), items: [{ product_id: 1, qty: 2, unit_price: 185000 }, { product_id: 2, qty: 3, unit_price: 25000 }], payment_method: 'tunai', paid_amount: 445000 });
  assert.equal(s.ok, true, JSON.stringify(s));
  const inv = a.all('SELECT invoice_no FROM pos_sales', [])[0].invoice_no;
  const rv = await call(a, 'request_void', 'Siti', '1111', { invoice_no: inv, reason: 'dobel input' });
  const d = await call(a, 'decide_approval', 'Jihan', '2222', { request_id: rv.request_id, decision: 'approved', invoice_no: inv });
  assert.equal(d.ok, true, JSON.stringify(d));
  let c = changes(a);
  assert.equal(c.length, 1);
  assert.equal(c[0].d.what, 'batal');
  assert.equal(c[0].d.no, inv);
  assert.equal(c[0].d.requested_by, 'Siti');
  assert.equal(c[0].d.approved_by, 'Jihan');
  assert.equal(c[0].d.reason, 'dobel input');
  assert.equal(c[0].amount, -445000);
  assert.deepEqual(c[0].d.changes.map((x) => [x.name, x.qty_from, x.qty_to]), [['Kurma Ajwa 1kg', 2, 0], ['Kismis 500g', 3, 0]]);
  // the owner voids another sale himself
  await call(a, 'save_sale', 'Siti', '1111', { client_id: 'v37b', sale_date: jkToday(), items: [{ product_id: 2, qty: 1, unit_price: 25000 }], payment_method: 'tunai', paid_amount: 25000 });
  const inv2 = a.all('SELECT invoice_no FROM pos_sales ORDER BY id', [])[1].invoice_no;
  assert.equal((await call(a, 'void_sale', 'Pemilik', '1234', { invoice_no: inv2, reason: 'tes' })).ok, true);
  c = changes(a);
  assert.equal(c.length, 2);
  assert.deepEqual([c[1].d.no, c[1].d.requested_by, c[1].d.approved_by], [inv2, 'Pemilik', 'Pemilik']);
});

test('v37 #1 price correction of sold goods and an approved customer return → change records', async () => {
  const db = seed(), a = sqliteAdapter(db);
  await call(a, 'save_sale', 'Siti', '1111', { client_id: 'v37c', sale_date: jkToday(), items: [{ product_id: 2, qty: 2, unit_price: 25000 }], payment_method: 'tunai', paid_amount: 50000 });
  await call(a, 'save_sale', 'Siti', '1111', { client_id: 'v37d', sale_date: jkToday(), items: [{ product_id: 2, qty: 1, unit_price: 25000 }], payment_method: 'tunai', paid_amount: 25000 });
  const invs = a.all('SELECT invoice_no FROM pos_sales ORDER BY id', []).map((r) => r.invoice_no);
  const cp = await call(a, 'correct_price', 'Jihan', '2222', { product_id: 2, old_price: 25000, new_price: 24000, from: jkToday(), to: jkToday(), reason: 'harga promo lupa diubah' });
  assert.equal(cp.ok, true, JSON.stringify(cp));
  let c = changes(a);
  assert.equal(c.length, 1);
  assert.equal(c[0].d.what, 'koreksi_harga');
  assert.deepEqual(c[0].d.nos.slice().sort(), invs.slice().sort());
  assert.deepEqual([c[0].d.changes[0].price_from, c[0].d.changes[0].price_to, c[0].d.changes[0].qty, c[0].d.changes[0].invoices], [25000, 24000, 3, 2]);
  assert.equal(c[0].d.approved_by, 'Jihan');
  assert.equal(c[0].d.details.length, 2);
  // a customer return against the first invoice, approved by the manager
  const rr = await call(a, 'request_return', 'Siti', '1111', { kind: 'pelanggan', invoice_no: invs[0], reason_code: 'rusak', lines: [{ product_id: 2, qty: 1, condition: 'rusak' }], refund_method: 'tunai', returned_by: 'Budi' });
  assert.equal(rr.ok, true, JSON.stringify(rr));
  const dr = await call(a, 'decide_approval', 'Jihan', '2222', { request_id: rr.request_id, decision: 'approved' });
  assert.equal(dr.ok, true, JSON.stringify(dr));
  c = changes(a);
  assert.equal(c.length, 2);
  assert.deepEqual([c[1].d.what, c[1].d.no, c[1].d.requested_by, c[1].d.approved_by, c[1].d.changes[0].qty_ret, c[1].d.changes[0].condition], ['retur', invs[0], 'Siti', 'Jihan', 1, 'rusak']);
});

test('v37 #1 no other route edits a saved goods-in: a new save makes a new note; stock_adjust / repack add their own rows', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const no = await goodsIn(a);
  const rows0 = a.all('SELECT * FROM pos_purchases WHERE purchase_no = ? ORDER BY id', [no]);
  const no2 = await goodsIn(a, MGR, 5);
  assert.notEqual(no2, no);
  await call(a, 'stock_adjust', 'Pemilik', '1234', { product_id: 2, new_stock: 70, reason: 'tes' });
  await call(a, 'stock_count', 'Siti', '1111', { counts: [{ product_id: 2, counted: 60 }] });
  assert.deepEqual(a.all('SELECT * FROM pos_purchases WHERE purchase_no = ? ORDER BY id', [no]), rows0, 'the saved note rows are untouched');
  // the only way: request_purchase_fix (kasir/manager → approval)
  assert.equal((await call(a, 'request_purchase_fix', 'Siti', '1111', { purchase_no: no, reason: 'r', lines: [{ product_id: 2, qty: 1 }] })).applied, false);
  assert.equal((await call(a, 'request_purchase_fix', 'Jihan', '2222', { purchase_no: no, reason: 'r', lines: [{ product_id: 2, qty: 1 }] })).applied, false);
  assert.equal((await call(a, 'request_purchase_fix', 'Aqil', '4444', { purchase_no: no, reason: 'r', lines: [{ product_id: 2, qty: 1 }] })).error, 'FORBIDDEN');
  assert.deepEqual(a.all('SELECT * FROM pos_purchases WHERE purchase_no = ? ORDER BY id', [no]), rows0);
});

// ---- 2. stock count every two months ----
test('v37 #2 opname status: the first bootstrap starts the clock; a full count (≥ 90 % of active products) resets it', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const b = await call(a, 'bootstrap', 'Siti', '1111', {});
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.opname.every_days, 60);
  assert.equal(b.opname.since, jkToday());
  assert.equal(b.opname.last_full, '');
  assert.equal(b.opname.next_due, dayPlus(jkToday(), 60));
  assert.equal(b.opname.status, 'ok');
  assert.equal(b.opname.active_n, 3);
  // a partial count by the cashier, approved by the owner → the cycle has 1 of 3
  const sc = await call(a, 'stock_count', 'Siti', '1111', { counts: [{ product_id: 1, counted: 20 }] });
  const d = await call(a, 'decide_approval', 'Pemilik', '1234', { request_id: sc.request_id, decision: 'approved' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.opname.counted_n, 1);
  assert.equal(d.opname.last_full, '');
  // the settings sent to the apps carry only the size of the cycle, not the id list
  const b2 = await call(a, 'bootstrap', 'Siti', '1111', {});
  assert.equal(b2.settings.opname_state.counted_n, 1);
  assert.equal(b2.settings.opname_state.counted, undefined);
  // the owner counts the other two → full
  const o = await call(a, 'stock_count', 'Pemilik', '1234', { counts: [{ product_id: 2, counted: 49 }, { product_id: 3, counted: 10 }] });
  assert.equal(o.applied, true);
  assert.equal(o.opname.last_full, jkToday());
  assert.equal(o.opname.next_due, dayPlus(jkToday(), 60));
  assert.equal(o.opname.counted_n, 0);
  assert.ok(a.all("SELECT * FROM pos_activity WHERE kind = 'opname_penuh'", []).length === 1);
});

test('v37 #2 opname_every_days: owner and manager set 7–180; the cashier / accountant cannot; save_settings validates too', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const m = await call(a, 'set_opname_every', 'Jihan', '2222', { days: 30 });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.equal(m.opname.every_days, 30);
  assert.ok(a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []).some((n) => n.ref === 'owner' && /setiap 60 → 30 hari/.test(n.summary)), 'owner told');
  assert.equal((await call(a, 'set_opname_every', 'Jihan', '2222', { days: 3 })).error, 'INVALID');
  assert.equal((await call(a, 'set_opname_every', 'Jihan', '2222', { days: 181 })).error, 'INVALID');
  assert.equal((await call(a, 'set_opname_every', 'Siti', '1111', { days: 30 })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'set_opname_every', 'Aqil', '4444', { days: 30 })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'save_settings', 'Pemilik', '1234', { settings: { opname_every_days: 200 } })).error, 'INVALID');
  assert.equal((await call(a, 'save_settings', 'Pemilik', '1234', { settings: { opname_every_days: 90 } })).ok, true);
  assert.equal((await call(a, 'bootstrap', 'Pemilik', '1234', {})).opname.every_days, 90);
});

test('v37 #2 due within 7 days, then overdue: ONE notice to the owner and manager per due date', async () => {
  const db = seed(), a = sqliteAdapter(db);
  insert(db, 'pos_settings', { id: 11, skey: 'opname_state', svalue: JSON.stringify({ since: dayPlus(jkToday(), -55) }) });
  const b = await call(a, 'bootstrap', 'Jihan', '2222', {});
  assert.equal(b.opname.status, 'due');
  assert.equal(b.opname.days_left, 5);
  assert.equal(a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []).length, 0);
  db.prepare('UPDATE pos_settings SET svalue = ? WHERE id = 11').run(JSON.stringify({ last_full: dayPlus(jkToday(), -64), last_full_by: 'Pemilik', since: '2026-01-01' }));
  const b2 = await call(a, 'bootstrap', 'Siti', '1111', {});
  assert.equal(b2.opname.status, 'overdue');
  assert.equal(b2.opname.days_left, -4);
  assert.equal(b2.opname.last_full, dayPlus(jkToday(), -64));
  let n = a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []);
  assert.equal(n.length, 1);
  assert.equal(n[0].ref, 'owner,manager');
  assert.equal(n[0].user, 'Sistem');
  assert.match(n[0].summary, /TERLAMBAT 4 hari/);
  await call(a, 'bootstrap', 'Pemilik', '1234', {});
  n = a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []);
  assert.equal(n.length, 1, 'not repeated');
});

// ---- 3. daily report: goods in today ----
test('v37 #3 daily report lists today\'s goods-in notes, lines, stock now and the day\'s invoice changes (cost only for the owner)', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const no = await goodsIn(a);
  const rq = await call(a, 'request_purchase_fix', 'Siti', '1111', { purchase_no: no, reason: 'salah hitung', lines: [{ product_id: 2, qty: 8 }] });
  await call(a, 'decide_approval', 'Jihan', '2222', { request_id: rq.request_id, decision: 'approved', purchase_no: no });
  const ro = await call(a, 'daily_report', 'Pemilik', '1234', { date: jkToday() });
  assert.equal(ro.ok, true, JSON.stringify(ro));
  const gi = ro.report.goods_in;
  assert.equal(gi.count, 1);
  const n0 = gi.notes[0];
  assert.equal(n0.purchase_no, no);
  assert.equal(n0.supplier, 'PT Sumber');
  assert.equal(n0.by, 'Siti');
  assert.ok(n0.at, 'time the note was entered');
  assert.equal(n0.match_status, 'tanpa_foto');
  assert.deepEqual(n0.lines.map((l) => [l.name, l.qty, l.stock_now]), [['Kismis 500g', 10, 58], ['Madu 250g', 4, 14]]);
  assert.equal(n0.lines[0].cost_price, 20000);
  assert.equal(gi.total, 10 * 20000 + 4 * 41000);
  assert.equal(n0.changes_today, 1);
  assert.equal(ro.report.invoice_changes.count, 1);
  assert.equal(ro.report.invoice_changes.list[0].approved_by, 'Jihan');
  const rm = await call(a, 'daily_report', 'Jihan', '2222', { date: jkToday() });
  // v59: the goods-in notes' amounts reach the manager without the owner's purchase-price setting
  assert.equal(rm.report.goods_in.notes[0].lines[0].cost_price, 20000);
  assert.equal(rm.report.goods_in.total, 10 * 20000 + 4 * 41000);
  assert.equal(rm.report.invoice_changes.list[0].changes[0].price_to, 20000);
  // akuntan_sees_cost on → the same
  insert(db, 'pos_settings', { id: 12, skey: 'akuntan_sees_cost', svalue: 'true' });
  const rm2 = await call(a, 'daily_report', 'Jihan', '2222', { date: jkToday() });
  assert.equal(rm2.report.goods_in.notes[0].lines[0].cost_price, 20000);
  // another day: empty
  const ry = await call(a, 'daily_report', 'Pemilik', '1234', { date: dayPlus(jkToday(), -1) });
  assert.equal(ry.report.goods_in.count, 0);
  assert.equal(ry.report.invoice_changes.count, 0);
});

test('v37 self-migration adds pos_activity.detail to an older D1', async () => {
  const db = seed();
  db.exec('ALTER TABLE pos_activity DROP COLUMN detail');
  _resetPosSchemaForTests();
  const a = sqliteAdapter(db);
  const no = await goodsIn(a);
  assert.ok(a.all('PRAGMA table_info(pos_activity)', []).some((x) => x.name === 'detail'));
  assert.equal((await call(a, 'request_purchase_fix', 'Pemilik', '1234', { purchase_no: no, reason: 'r', lines: [{ product_id: 2, qty: 9 }] })).ok, true);
  assert.equal(changes(a).length, 1);
});
