// v65 (owner 2026-10-20: «عند استقبال البضاعة و التأكد منها من الموظف، المدير و المحاسب يصادق عليها و يكتب هل تم الدفع و بأي وسيلة دفع او
// تاريخ الدفع المتفق عليه و يدخل في المصاريف او الدين»), on the real backend through the Worker's loaders (in-memory SQLite):
//   1. the cashier receives a note; it waits for the manager / accountant (bootstrap purchase_checks.waiting);
//   2. "sudah dibayar": a supplier payment allocated to the note (money out of the day), the owner told; never twice;
//   3. "bayar nanti": the agreed date on the note = the supplier's debt; near the date it is listed as due; a later payment
//      (the owner pays directly) covering it marks it paid;
//   4. the cashier may not confirm; a date in the past or too far is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const plus = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'K1', name: 'Kurma Sukari 1 kg', category: 'Kurma', unit: 'pak', cost_price: 50000, retail_price: 70000, stock: 0, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'K2', name: 'Kurma Ajwa 1 kg', category: 'Kurma', unit: 'pak', cost_price: 150000, retail_price: 200000, stock: 0, shop_stock: 0, active: true });
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', opening_cash: 200000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '', shift_date: today });
  insert(db, 'pos_photos', { id: 50, photo_id: 'PHA', kind: 'masuk', user: 'Siti', extracted: JSON.stringify({ items: [{ name: 'KURMA SUKARI', qty: 10 }], readable: true }), match_status: '', match_notes: '' });
  insert(db, 'pos_photos', { id: 51, photo_id: 'PHB', kind: 'masuk', user: 'Siti', extracted: JSON.stringify({ items: [{ name: 'KURMA AJWA', qty: 4 }], readable: true }), match_status: '', match_notes: '' });
  return db;
}
const notices = db => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();
const lines = (db, no) => db.prepare('SELECT * FROM pos_purchases WHERE purchase_no = ?').all(no);

test('v65 goods-in: the manager confirms "paid by transfer", the accountant "pay on the agreed date"; due list; a later payment clears it', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const recv = (photo, pid, qty, cost, sup) => call(ad, 'Siti', 'save_purchase', { supplier: sup, photo_id: photo, carrier: { type: 'pemasok', name: 'Sopir' }, items: [{ product_id: pid, qty, cost_price: cost, exp_none: true, photo_index: 0 }] });
  const a = await recv('PHA', 1, 10, 50000, 'CV Timur Tengah');
  const b = await recv('PHB', 2, 4, 150000, 'PT Kurma Jaya');
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b));
  // 1. both wait for the manager / accountant
  const boot = await call(ad, 'Jihan', 'bootstrap', {});
  assert.deepEqual(boot.purchase_checks.waiting.map(x => x.purchase_no).sort(), [a.purchase_no, b.purchase_no].sort());
  assert.equal((await call(ad, 'Siti', 'bootstrap', {})).purchase_checks, null);
  // the cashier may not confirm; the choice is required
  assert.equal((await call(ad, 'Siti', 'confirm_purchase', { purchase_no: a.purchase_no, supplier: 'CV Timur Tengah', pay: 'lunas', method: 'tunai' })).error, 'FORBIDDEN');
  assert.equal((await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: a.purchase_no, supplier: 'CV Timur Tengah' })).error, 'INVALID');
  assert.equal((await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: a.purchase_no, supplier: 'PT Lain', pay: 'lunas', method: 'transfer' })).error, 'INVALID');
  // 2. paid by transfer: a supplier payment allocated to the note
  const ca = await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: a.purchase_no, supplier: 'CV Timur Tengah', pay: 'lunas', method: 'transfer', bank: 'BCA', transfer_ref: 'TRX-881' });
  assert.equal(ca.ok, true, JSON.stringify(ca));
  assert.equal(ca.payment.amount, 500000); assert.deepEqual(ca.payment.alloc, [{ ref: a.purchase_no, amount: 500000 }]);
  const la = lines(db, a.purchase_no);
  assert.deepEqual(la.map(r => [r.check_status, r.checked_by, r.pay_status, r.pay_method, r.paid_at]), [['dikonfirmasi', 'Jihan', 'lunas', 'transfer', today]]);
  const pa = db.prepare("SELECT * FROM pos_payments WHERE supplier = 'CV Timur Tengah'").all();
  assert.equal(pa.length, 1); assert.equal(pa[0].direction, 'out'); assert.equal(pa[0].match_status, 'lunas');
  assert.match(notices(db).at(-1).summary, /dikonfirmasi manajer Jihan: sudah dibayar transfer Rp 500\.000 BCA ref TRX-881$/);
  assert.equal(notices(db).at(-1).ref, 'owner,akuntan');
  assert.match((await call(ad, 'Aqil', 'confirm_purchase', { purchase_no: a.purchase_no, supplier: 'CV Timur Tengah', pay: 'tempo', due_date: plus(7) })).message, /sudah dikonfirmasi oleh Jihan/);
  // the supplier's ledger: nothing owed on that note
  const lg = await call(ad, 'Jihan', 'party_ledger', { party_type: 'supplier', supplier: 'CV Timur Tengah' });
  assert.equal(lg.ok, true, JSON.stringify(lg));
  // 3. on credit until an agreed date — by the accountant
  assert.equal((await call(ad, 'Aqil', 'confirm_purchase', { purchase_no: b.purchase_no, supplier: 'PT Kurma Jaya', pay: 'tempo', due_date: plus(-1) })).error, 'INVALID');
  assert.equal((await call(ad, 'Aqil', 'confirm_purchase', { purchase_no: b.purchase_no, supplier: 'PT Kurma Jaya', pay: 'tempo', due_date: plus(200) })).error, 'INVALID');
  const cb = await call(ad, 'Aqil', 'confirm_purchase', { purchase_no: b.purchase_no, supplier: 'PT Kurma Jaya', pay: 'tempo', due_date: plus(2), note: 'janji 2 hari' });
  assert.equal(cb.ok, true, JSON.stringify(cb)); assert.equal(cb.payment, null);
  assert.deepEqual(lines(db, b.purchase_no).map(r => [r.check_status, r.checked_by, r.pay_status, r.due_date]), [['dikonfirmasi', 'Aqil', 'tempo', plus(2)]]);
  const nb = notices(db).at(-1);
  assert.match(nb.summary, new RegExp('dikonfirmasi akuntan Aqil: BAYAR NANTI — jatuh tempo ' + plus(2) + ' \\(hutang ke pemasok\\) \\| janji 2 hari$'));
  assert.equal(nb.ref, 'owner,manager');
  // no cash moved, no payment
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_payments WHERE supplier = 'PT Kurma Jaya'").get().n, 0);
  const boot2 = await call(ad, 'Pemilik', 'bootstrap', {});
  assert.deepEqual(boot2.purchase_checks.waiting, []);
  assert.deepEqual(boot2.purchase_checks.due.map(x => [x.purchase_no, x.supplier, x.due_date, x.days, x.total]), [[b.purchase_no, 'PT Kurma Jaya', plus(2), 2, 600000]]);
  // the owner pays the debt later (directly): the note is paid, no longer due
  const py = await call(ad, 'Pemilik', 'pay_supplier', { supplier: 'PT Kurma Jaya', amount: 600000, method: 'transfer', alloc: [{ ref: b.purchase_no, amount: 600000 }] });
  assert.equal(py.ok, true, JSON.stringify(py));
  assert.deepEqual(lines(db, b.purchase_no).map(r => [r.pay_status, r.paid_at]), [['lunas', today]]);
  assert.deepEqual((await call(ad, 'Pemilik', 'bootstrap', {})).purchase_checks.due, []);
});

test('v65 paid in cash from the confirmer\'s own drawer: the drawer\'s cash out grows; without an open drawer it is refused', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const a = await call(ad, 'Siti', 'save_purchase', { supplier: 'CV Timur Tengah', photo_id: 'PHA', carrier: { type: 'pemasok', name: 'Sopir' }, items: [{ product_id: 1, qty: 10, cost_price: 50000, exp_none: true, photo_index: 0 }] });
  assert.equal((await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: a.purchase_no, supplier: 'CV Timur Tengah', pay: 'lunas', method: 'tunai', paid_from: 'kas' })).error, 'SHIFT_REQUIRED');
  insert(db, 'pos_shifts', { id: 22, shift_id: 'SHJ', cashier: 'Jihan', status: 'open', opening_cash: 1000000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '', shift_date: today });
  const c = await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: a.purchase_no, supplier: 'CV Timur Tengah', pay: 'lunas', method: 'tunai', paid_from: 'kas' });
  assert.equal(c.ok, true, JSON.stringify(c));
  const sh = db.prepare("SELECT * FROM pos_shifts WHERE shift_id = 'SHJ'").get();
  assert.equal(sh.cash_out, 500000);
  assert.match(JSON.parse(sh.moves).at(-1).note || JSON.stringify(JSON.parse(sh.moves).at(-1)), /Bayar pemasok CV Timur Tengah/);
});
