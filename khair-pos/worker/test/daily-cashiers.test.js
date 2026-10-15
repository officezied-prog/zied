// v37 daily_report.cashiers: every cashier's own day next to the store totals (owner 2026-10-12:
// "طريقة لكل كاشير خاص به وكل حصيلة خاصة به ثم الحصيلة العامة للمتجر كلها").
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const DAY = '2026-10-12';
const call = (db, user, pin, action, data) => handleRequest(sqliteAdapter(db), { action, key: KEY, user, pin_hash: h(user, pin), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Rina', role: 'kasir', pin_hash: h('Rina', '3333'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  const sale = (id, cashier, total, method, paid, debt, status = 'selesai') => {
    insert(db, 'pos_sales', { id, invoice_no: 'INV' + id, sale_date: DAY, sale_time: DAY + 'T03:00:00.000Z', cashier, total, subtotal: total, discount: 0, payment_method: method, paid_amount: paid, debt_amount: debt, status, profit: 1000 });
    insert(db, 'pos_sale_items', { id, invoice_no: 'INV' + id, sale_date: DAY, product_id: 1, name: 'Kurma', qty: 2, unit_price: total / 2, line_total: total });
  };
  sale(1, 'Siti', 100000, 'tunai', 100000, 0);
  sale(2, 'Siti', 50000, 'qris', 50000, 0);
  sale(3, 'Siti', 80000, 'hutang', 30000, 50000); // part paid in cash, rest on credit
  sale(4, 'Rina', 200000, 'transfer', 200000, 0);
  sale(5, 'Rina', 40000, 'tunai', 40000, 0, 'void');
  sale(6, 'Jihan', 70000, 'tunai', 70000, 0); // the manager sold without a drawer
  insert(db, 'pos_payments', { id: 1, pay_id: 'PY1', pay_date: DAY, direction: 'in', party_type: 'customer', customer_id: 7, amount: 25000, method: 'tunai', cashier: 'Rina' });
  insert(db, 'pos_payments', { id: 2, pay_id: 'PY2', pay_date: DAY, direction: 'out', party_type: 'supplier', supplier: 'PT A', amount: 60000, method: 'transfer', cashier: 'Jihan' });
  insert(db, 'pos_expenses', { id: 1, expense_date: DAY, category: 'transport', amount: 15000, note: 'ojek', user: 'Siti', paid_from: 'kas' });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SH1', cashier: 'Siti', shift_date: DAY, status: 'closed', opening_cash: 200000, cash_sales: 130000, cash_payments: 0, cash_in: 0, cash_out: 15000,
    expected_cash: 315000, counted_cash: 310000, difference: -5000, sales_count: 3, sales_total: 230000, moves: '[]', note: '' });
  insert(db, 'pos_shifts', { id: 2, shift_id: 'SH2', cashier: 'Rina', shift_date: DAY, status: 'open', opening_cash: 100000, cash_sales: 0, cash_payments: 25000, cash_in: 0, cash_out: 0,
    sales_count: 1, sales_total: 200000, moves: '[]', note: '' });
  return db;
}

test('daily_report: one entry per cashier, each with its own sales, debt, voids, payments, expenses and drawer', async () => {
  const r = await call(seed(), 'Pemilik', '1234', 'daily_report', { date: DAY });
  assert.equal(r.ok, true, JSON.stringify(r));
  const R = r.report, by = Object.fromEntries(R.cashiers.map((c) => [c.name, c]));
  assert.deepEqual(R.cashiers.map((c) => c.name), ['Siti', 'Rina', 'Jihan']); // biggest sales first
  assert.deepEqual(by.Siti.sales, { count: 3, total: 230000, discount: 0, items_qty: 6, by_method: { tunai: 130000, transfer: 0, qris: 50000, kartu: 0 }, debt: 50000 });
  // a credit sale with a down payment: the paid part counts by its method (unknown 'hutang' → cash), like the store total
  assert.equal(R.sales.by_method.tunai, 100000 + 30000 + 70000);
  assert.equal(by.Siti.expenses.from_kas, 15000);
  assert.deepEqual(by.Siti.drawer, { count: 1, open: 0, opening_cash: 200000, cash_sales: 130000, cash_payments: 0, cash_in: 0, cash_out: 15000, expected_cash: 315000, counted_cash: 310000, difference: -5000 });
  assert.deepEqual(by.Rina.voids, { count: 1, total: 40000 });
  assert.equal(by.Rina.sales.by_method.transfer, 200000);
  assert.deepEqual(by.Rina.payments_in, { count: 1, total: 25000, tunai: 25000, transfer: 0, qris: 0 });
  assert.equal(by.Rina.drawer.open, 1);
  assert.equal(by.Rina.drawer.counted_cash, null); // still open: nothing counted yet
  assert.equal(by.Rina.drawer.expected_cash, 125000);
  assert.equal(by.Jihan.drawer, null); // no drawer
  assert.deepEqual(by.Jihan.payments_out, { count: 1, total: 60000, tunai: 0 });
  // the cashiers add up to the store
  const add = (f) => R.cashiers.reduce((a, c) => a + f(c), 0);
  assert.equal(add((c) => c.sales.total), R.sales.total);
  assert.equal(add((c) => c.sales.count), R.sales.count);
  assert.equal(add((c) => c.sales.debt), R.sales.debt);
  assert.equal(add((c) => c.sales.items_qty), R.sales.items_qty);
  for (const m of ['tunai', 'transfer', 'qris']) assert.equal(add((c) => c.sales.by_method[m]), R.sales.by_method[m]);
  assert.equal(add((c) => c.voids.total), R.sales.voids.total);
  assert.equal(add((c) => c.payments_in.total), R.payments_in.total);
  assert.equal(add((c) => c.expenses.total), R.expenses.total);
  assert.equal(add((c) => (c.drawer ? c.drawer.expected_cash : 0)), R.cash.expected_total);
});

test('daily_report.cashiers: the manager and the accountant get it too; a cashier still cannot open the report', async () => {
  const db = seed();
  const m = await call(db, 'Jihan', '2222', 'daily_report', { date: DAY });
  assert.equal(m.report.cashiers.length, 3);
  const k = await call(db, 'Siti', '1111', 'daily_report', { date: DAY });
  assert.equal(k.error, 'FORBIDDEN');
  const empty = await call(db, 'Pemilik', '1234', 'daily_report', { date: '2026-10-01' });
  assert.deepEqual(empty.report.cashiers, []);
});
