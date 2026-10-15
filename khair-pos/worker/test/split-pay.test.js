// v51 (owner 2026-10-15: «إمكانية البيع كل فاتورة مثلا نصف نقدا والنصف الآخر عن طريق الجوال أو التحويل أو أي شيء فإمكانية تجزئة الدفع
// حسب عدة أنواع طرق للدفع») — one sale paid by several methods, on the real backend (backend/process.js through the Worker) on an
// in-memory SQLite: the parts are kept, each goes to its own drawer total, the transfer part waits for the manager's check, the
// daily report counts each part by its method, and what is not paid is debt with the hutang rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222' };
const DAY = '2026-10-15';
const call = (db, user, action, data) => handleRequest(sqliteAdapter(db), { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 100000, retail_price: 150000, stock: 20, shop_stock: 20, active: true });
  insert(db, 'pos_customers', { id: 7, name: 'Toko Berkah', phone: '0812', type: 'eceran', address: '', notes: '', debt_balance: 0 });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SHS', cashier: 'Siti', shift_date: DAY, status: 'open', opening_cash: 200000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, transfer_sales: 0, qris_sales: 0, debt_sales: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  insert(db, 'pos_shifts', { id: 2, shift_id: 'SHJ', cashier: 'Jihan', shift_date: DAY, status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, transfer_sales: 0, qris_sales: 0, debt_sales: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const sell = (db, user, cid, payments, extra = {}) => call(db, user, 'save_sale', Object.assign({ client_id: cid, sale_date: DAY, items: [{ product_id: 1, qty: 1, unit_price: 150000 }], discount: 0, payments }, extra));
const shift = (db, id) => db.prepare('SELECT * FROM pos_shifts WHERE shift_id = ?').get(id);
const saleRow = (db, inv) => db.prepare('SELECT * FROM pos_sales WHERE invoice_no = ?').get(inv);

test('half cash, half transfer: one sale, the parts kept, each in its own drawer total, the transfer part checked by the manager', async () => {
  const db = seed();
  const r = await sell(db, 'Siti', 's1', [{ method: 'tunai', amount: 100000 }, { method: 'transfer', amount: 50000 }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = saleRow(db, r.invoice_no);
  assert.equal(s.payment_method, 'campur');
  assert.deepEqual(JSON.parse(s.pay_parts), [{ m: 'tunai', a: 100000 }, { m: 'transfer', a: 50000 }]);
  assert.equal(s.paid_amount, 150000);
  assert.equal(s.debt_amount, 0);
  const sh = shift(db, 'SHS');
  assert.equal(sh.cash_sales, 100000); // only the cash part is in the drawer
  assert.equal(sh.transfer_sales, 50000);
  assert.equal(sh.qris_sales, 0);
  assert.equal(sh.sales_total, 150000);
  const tc = db.prepare("SELECT * FROM pos_approvals WHERE kind = 'transfer_confirm'").all();
  assert.equal(tc.length, 1);
  assert.equal(tc[0].ref, r.invoice_no);
  assert.equal(tc[0].total, 50000); // the transfer part, not the whole sale
  // three ways: cash + transfer + QRIS
  const r2 = await sell(db, 'Siti', 's2', [{ method: 'tunai', amount: 50000 }, { method: 'qris', amount: 60000 }, { method: 'transfer', amount: 40000 }]);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(JSON.parse(saleRow(db, r2.invoice_no).pay_parts), [{ m: 'tunai', a: 50000 }, { m: 'transfer', a: 40000 }, { m: 'qris', a: 60000 }]);
  assert.equal(shift(db, 'SHS').cash_sales, 150000);
  assert.equal(shift(db, 'SHS').qris_sales, 60000);
  // the daily report counts each part by its method (store and cashier)
  const d = await call(db, 'Pemilik', 'daily_report', { date: DAY });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.report.sales.by_method, { tunai: 150000, transfer: 90000, qris: 60000 });
  assert.deepEqual(d.report.cashiers.find((c) => c.name === 'Siti').sales.by_method, { tunai: 150000, transfer: 90000, qris: 60000 });
  assert.equal(d.report.cash.sales, 150000);
  // a resend of the same sale is one sale
  const again = await sell(db, 'Siti', 's1', [{ method: 'tunai', amount: 100000 }, { method: 'transfer', amount: 50000 }]);
  assert.equal(again.invoice_no, r.invoice_no);
  assert.equal(shift(db, 'SHS').cash_sales, 150000);
});

test('wrong parts are refused: more than the total, an unknown method, a negative amount', async () => {
  const db = seed();
  assert.equal((await sell(db, 'Siti', 'w1', [{ method: 'tunai', amount: 100000 }, { method: 'transfer', amount: 60000 }])).error, 'INVALID');
  assert.equal((await sell(db, 'Siti', 'w2', [{ method: 'tunai', amount: 100000 }, { method: 'kartu', amount: 50000 }])).error, 'INVALID');
  assert.equal((await sell(db, 'Siti', 'w3', [{ method: 'tunai', amount: 200000 }, { method: 'transfer', amount: -50000 }])).error, 'INVALID');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pos_sales').get().n, 0);
  assert.equal(shift(db, 'SHS').cash_sales, 0);
});

test('part paid, the rest on credit: needs a customer and the credit approval like hutang; one method is stored as before', async () => {
  const db = seed();
  const parts = [{ method: 'tunai', amount: 50000 }, { method: 'qris', amount: 30000 }];
  const noCust = await sell(db, 'Siti', 'd1', parts);
  assert.equal(noCust.error, 'INVALID');
  assert.match(noCust.message, /pelanggan/);
  const cashier = await sell(db, 'Siti', 'd2', parts, { customer_id: 7 });
  assert.equal(cashier.error, 'APPROVAL_REQUIRED', JSON.stringify(cashier)); // a cashier's credit needs the manager
  const mgr = await sell(db, 'Jihan', 'd3', parts, { customer_id: 7 });
  assert.equal(mgr.ok, true, JSON.stringify(mgr));
  const s = saleRow(db, mgr.invoice_no);
  assert.equal(s.payment_method, 'campur');
  assert.equal(s.paid_amount, 80000);
  assert.equal(s.debt_amount, 70000);
  assert.equal(db.prepare('SELECT debt_balance FROM pos_customers WHERE id = 7').get().debt_balance, 70000);
  const sh = shift(db, 'SHJ');
  assert.equal(sh.cash_sales, 50000);
  assert.equal(sh.qris_sales, 30000);
  assert.equal(sh.debt_sales, 70000);
  // one method only → stored like before (no parts)
  const one = await sell(db, 'Jihan', 'd4', [{ method: 'qris', amount: 150000 }]);
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(saleRow(db, one.invoice_no).payment_method, 'qris');
  assert.equal(saleRow(db, one.invoice_no).pay_parts, '');
  assert.equal(shift(db, 'SHJ').qris_sales, 180000);
});
