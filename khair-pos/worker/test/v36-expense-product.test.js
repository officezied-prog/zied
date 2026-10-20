// v36 (owner 2026-10-11): expense invoice check line by line + the cashier adding a NEW product at goods-in.
// Runs the real backend (backend/process.js built into the Worker) against in-memory SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest, _resetPosSchemaForTests, POS_MIGRATIONS } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 150000, retail_price: 185000, wholesale_price: 170000, wholesale_min_qty: 5, stock: 20, shop_stock: 20, min_stock: 3, active: true });
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', opening_cash: 200000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const photo = (db, id, ex) => insert(db, 'pos_photos', { id: Number(id.replace(/\D/g, '')) || 9, photo_id: id, kind: 'biaya', user: 'Siti', extracted: JSON.stringify(ex), match_status: '', match_notes: '' });
const INVOICE = { vendor: 'Toko ATK', amount: 85000, total: 85000, readable: true, items: [
  { name: 'Plastik kresek besar', qty: 10, unit_price: 5000, total: 50000 },
  { name: 'Lakban coklat', qty: 5, unit_price: 7000, total: 35000 },
] };

test('v36 expense lines: sum must equal the amount; lines are stored', async () => {
  const a = sqliteAdapter(seed());
  const bad = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'kemasan', amount: 90000, lines: [{ name: 'Plastik kresek besar', qty: 10, unit_price: 5000 }, { name: 'Lakban coklat', qty: 5, unit_price: 7000 }] }), {}, KEY);
  assert.equal(bad.ok, false); assert.equal(bad.error, 'INVALID');
  const ok = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'kemasan', amount: 85000, lines: [{ name: 'Plastik kresek besar', qty: 10, unit_price: 5000 }, { name: 'Lakban coklat', qty: 5, unit_price: 7000 }] }), {}, KEY);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const e = a.all('SELECT * FROM pos_expenses', [])[0];
  assert.equal(JSON.parse(e.lines).length, 2);
  assert.equal(e.check_status, ''); // no invoice photo → nothing to compare
  assert.equal(a.all("SELECT COUNT(*) c FROM pos_approvals WHERE kind = 'expense_check'", [])[0].c, 0);
});

test('v36 expense photo: matching lines → cocok, no approval', async () => {
  const db = seed(); const a = sqliteAdapter(db);
  photo(db, 'PH1', INVOICE);
  const r = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'kemasan', amount: 85000, photo_id: 'PH1', lines: [{ name: 'Lakban coklat', qty: 5, unit_price: 7000 }, { name: 'Plastik kresek besar', qty: 10, unit_price: 5000 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.check.status, 'cocok');
  assert.equal(a.all('SELECT check_status FROM pos_expenses', [])[0].check_status, 'cocok');
  assert.equal(a.all("SELECT COUNT(*) c FROM pos_approvals WHERE kind = 'expense_check'", [])[0].c, 0);
});

test('v36 expense photo: qty / price / count differences are each flagged, need a reason, go to mgr_akuntan; accountant approves', async () => {
  const db = seed(); const a = sqliteAdapter(db);
  photo(db, 'PH2', INVOICE);
  const lines = [{ name: 'Plastik kresek besar', qty: 12, unit_price: 5000 }, { name: 'Lakban coklat', qty: 5, unit_price: 5000 }];
  const noReason = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'kemasan', amount: 85000, photo_id: 'PH2', lines }), {}, KEY);
  assert.equal(noReason.ok, false); assert.equal(noReason.error, 'MISMATCH');
  const fields = noReason.check.diffs.map((d) => d.field).sort();
  assert.deepEqual(fields, ['price', 'qty'], JSON.stringify(noReason.check.diffs));
  assert.equal(a.all('SELECT COUNT(*) c FROM pos_expenses', [])[0].c, 0, 'nothing saved without a reason');
  // a line missing → count + missing; total differs
  const r3 = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'kemasan', amount: 50000, photo_id: 'PH2', lines: [{ name: 'Plastik kresek besar', qty: 10, unit_price: 5000 }] }), {}, KEY);
  assert.deepEqual(r3.check.diffs.map((d) => d.field).sort(), ['count', 'missing', 'total']);
  const ok = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'kemasan', amount: 85000, photo_id: 'PH2', lines, mismatch_reason: 'harga naik' }), {}, KEY);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.check_request_id);
  const ap = a.all("SELECT * FROM pos_approvals WHERE kind = 'expense_check'", [])[0];
  assert.equal(ap.approver_role, 'mgr_akuntan');
  assert.equal(ap.status, 'pending');
  const e = a.all('SELECT * FROM pos_expenses', [])[0];
  assert.equal(e.check_status, 'selisih'); assert.equal(e.request_id, ap.request_id);
  const list = await handleRequest(a, base('list_approvals', 'Aqil', '4444'), {}, KEY);
  assert.ok(list.approvals.some((x) => x.request_id === ap.request_id && x.can_decide), 'accountant sees + may decide');
  const d = await handleRequest(a, base('decide_approval', 'Aqil', '4444', { request_id: ap.request_id, decision: 'approved', note: 'cek nota fisik ok' }), {}, KEY);
  assert.equal(d.ok, true, JSON.stringify(d));
  const e2 = a.all('SELECT * FROM pos_expenses', [])[0];
  assert.equal(e2.check_status, 'disetujui'); assert.equal(e2.checked_by, 'Aqil');
  const rep = await handleRequest(a, base('daily_report', 'Pemilik', '1234', { date: e2.expense_date }), {}, KEY);
  assert.equal(rep.report.expenses.approved, 1, JSON.stringify(rep.report.expenses));
});

test('v36 expense photo without the AI key (unreadable): saved at once as "cek manual" + approval; reject flags it', async () => {
  const db = seed(); const a = sqliteAdapter(db);
  photo(db, 'PH3', { items: [], readable: false, notes: 'AI gagal membaca: AI_DISABLED' });
  const r = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'transport', amount: 25000, photo_id: 'PH3', lines: [{ name: 'Ongkir', qty: 1, unit_price: 25000 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.check.status, 'cek_manual');
  const ap = a.all("SELECT * FROM pos_approvals WHERE kind = 'expense_check'", [])[0];
  assert.ok(ap, 'a by-hand check request was raised');
  const rep = await handleRequest(a, base('daily_report', 'Pemilik', '1234', { date: a.all('SELECT expense_date FROM pos_expenses', [])[0].expense_date }), {}, KEY);
  assert.equal(rep.report.expenses.flagged, 1);
  const d = await handleRequest(a, base('decide_approval', 'Jihan', '2222', { request_id: ap.request_id, decision: 'rejected' }), {}, KEY);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(a.all('SELECT check_status FROM pos_expenses', [])[0].check_status, 'ditolak');
});

test('v36 cashier adds a NEW product at goods-in: required fields, flagged for review, usable at once; manager confirms with a price fix', async () => {
  const db = seed(); const a = sqliteAdapter(db);
  const p0 = { name: 'Madu Sidr 250g', unit: 'botol', retail_price: 95000, cost_price: 60000, from_goods_in: true };
  let r = await handleRequest(a, base('save_product', 'Siti', '1111', p0), {}, KEY);
  assert.equal(r.ok, false); assert.match(r.message, /Kategori/);
  r = await handleRequest(a, base('save_product', 'Siti', '1111', { ...p0, category: 'madu' }), {}, KEY);
  assert.equal(r.ok, false); assert.match(r.message, /Ukuran atau berat/);
  r = await handleRequest(a, base('save_product', 'Siti', '1111', { name: 'X', category: 'madu', size: '1 L' }), {}, KEY);
  assert.equal(r.error, 'FORBIDDEN', 'without from_goods_in the cashier still cannot add products');
  r = await handleRequest(a, base('save_product', 'Siti', '1111', { ...p0, name: 'kurma ajwa 1KG', category: 'kurma', weight: '1 kg' }), {}, KEY);
  assert.equal(r.ok, false, 'duplicate name refused');
  r = await handleRequest(a, base('save_product', 'Siti', '1111', { ...p0, category: 'madu', weight: '250 g', stock: 99 }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.product.id > 0, 'id filled by Finalize');
  assert.equal(r.product.cost_price, undefined, 'cost not echoed to the cashier');
  const p = a.all('SELECT * FROM pos_products WHERE id = ?', [r.product.id])[0];
  assert.equal(p.stock, 0); assert.equal(p.review, r.review_request_id); assert.equal(p.weight, '250 g');
  // usable at once in the goods-in
  insert(db, 'pos_photos', { id: 50, photo_id: 'PHM', kind: 'masuk', user: 'Siti', extracted: JSON.stringify({ items: [{ name: 'MADU SIDR 250G', qty: 6 }], readable: true }), match_status: '', match_notes: '' });
  const pu = await handleRequest(a, base('save_purchase', 'Siti', '1111', { supplier: 'PT Madu', photo_id: 'PHM', items: [{ product_id: p.id, qty: 6, cost_price: 60000, exp_date: '2028-01-01', photo_index: 0 }], carrier: { type: 'pemasok', name: 'Sopir' } }), {}, KEY);
  assert.equal(pu.ok, true, JSON.stringify(pu));
  assert.equal(a.all('SELECT stock FROM pos_products WHERE id = ?', [p.id])[0].stock, 6);
  const ap = a.all("SELECT * FROM pos_approvals WHERE kind = 'product_new'", [])[0];
  assert.equal(ap.approver_role, 'mgr_akuntan');
  const lm = await handleRequest(a, base('list_approvals', 'Jihan', '2222'), {}, KEY);
  assert.equal(JSON.parse(lm.approvals.find((x) => x.kind === 'product_new').payload).cost_price, undefined, 'manager does not see the invoice cost');
  const lo = await handleRequest(a, base('list_approvals', 'Pemilik', '1234'), {}, KEY);
  assert.equal(JSON.parse(lo.approvals.find((x) => x.kind === 'product_new').payload).cost_price, 60000, 'owner sees it');
  const d = await handleRequest(a, base('decide_approval', 'Jihan', '2222', { request_id: ap.request_id, decision: 'approved', prices: { retail_price: 99000, wholesale_price: 90000, wholesale_min_qty: 6 } }), {}, KEY);
  assert.equal(d.ok, true, JSON.stringify(d));
  const p2 = a.all('SELECT * FROM pos_products WHERE id = ?', [p.id])[0];
  assert.equal(p2.review, ''); assert.equal(p2.retail_price, 99000); assert.equal(p2.wholesale_price, 90000); assert.equal(p2.wholesale_min_qty, 6); assert.equal(p2.active, 1);
});

test('v36 rejecting a cashier product switches it off for sale (stock stays); owner app new-from-invoice also needs category + size/weight', async () => {
  const db = seed(); const a = sqliteAdapter(db);
  const r = await handleRequest(a, base('save_product', 'Siti', '1111', { name: 'Gelas Plastik', category: 'kemasan', size: '16 oz', unit: 'pak', retail_price: 15000, from_goods_in: true }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = await handleRequest(a, base('decide_approval', 'Aqil', '4444', { request_id: r.review_request_id, decision: 'rejected' }), {}, KEY);
  assert.equal(d.ok, true, JSON.stringify(d));
  const p = a.all('SELECT * FROM pos_products WHERE id = ?', [r.product.id])[0];
  assert.equal(p.active, 0); assert.equal(p.review, '');
  const o1 = await handleRequest(a, base('save_product', 'Pemilik', '1234', { name: 'Zaitun 1L', unit: 'botol', from_goods_in: true }), {}, KEY);
  assert.equal(o1.ok, false);
  const o2 = await handleRequest(a, base('save_product', 'Pemilik', '1234', { name: 'Zaitun 1L', unit: 'botol', category: 'minyak', size: '1 L', from_goods_in: true }), {}, KEY);
  assert.equal(o2.ok, true, JSON.stringify(o2));
  assert.equal(a.all("SELECT COUNT(*) c FROM pos_approvals WHERE kind = 'product_new'", [])[0].c, 1, 'only the cashier product needs a check');
});

test('v36 self-migration adds the new columns to an older D1 (before loading)', async () => {
  const db = seed();
  db.exec('DROP INDEX IF EXISTS idx_pos_expenses_request_id');
  for (const c of ['lines', 'check_status', 'request_id', 'checked_by']) db.exec(`ALTER TABLE pos_expenses DROP COLUMN ${c}`);
  db.exec('ALTER TABLE pos_products DROP COLUMN review');
  _resetPosSchemaForTests();
  const a = sqliteAdapter(db);
  const r = await handleRequest(a, base('save_expense', 'Siti', '1111', { category: 'lain', amount: 1000, lines: [{ name: 'Air', qty: 1, unit_price: 1000 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const cols = a.all('PRAGMA table_info(pos_expenses)', []).map((x) => x.name);
  for (const c of ['lines', 'check_status', 'request_id', 'checked_by']) assert.ok(cols.includes(c), c);
  assert.ok(a.all('PRAGMA table_info(pos_products)', []).some((x) => x.name === 'review'));
  assert.equal(POS_MIGRATIONS.length, 37); // + v63 pos_products.use_for + pos_tamper_shots and its index (v36 code-attempt photos) + v37 pos_activity.detail and its kind index + v38 repack requested_by / approved_by / request_id and the approvals client_id index + v39 pos_repacks.client_id + v48 pos_products.repack_costs and pos_repacks.materials_cost + v50 the two-step repack columns (status, plan, left over, who confirmed) and their two indexes + v51 pos_sales.pay_parts (split payment) + v52 pos_products.loose + v53 pos_shifts.card_sales + v57 pos_sales account_id / bank / transfer_ref / proof_photo_id and pos_payments.payee
});
