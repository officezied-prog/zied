// v68 (owner 2026-10-20: «every invoice should have number. Number is like this exactly date/month/years/ anytime minute and hours no
// space all/number of invoice this date/», his choice «20/10/2026/1542/12», counted for the whole store): the invoice number is
// DD/MM/YYYY/HHmm/N — the sale's day and time (Jakarta) and its number in that day, all cashiers together. A void keeps its number; the
// day's older KM… invoices count too; two cashiers saving at the same moment never share a number (unique (sale_date, day_seq): the later
// request runs again with the next one).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Dewi: '3333' };
const DAY = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const DMY = DAY.slice(8, 10) + '/' + DAY.slice(5, 7) + '/' + DAY.slice(0, 4);
const call = (db, user, action, data) => handleRequest(sqliteAdapter(db), { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Dewi', role: 'kasir', pin_hash: h('Dewi', '3333'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 100000, retail_price: 150000, stock: 500, shop_stock: 500, active: true });
  for (const [id, who] of [[1, 'Siti'], [2, 'Dewi']]) insert(db, 'pos_shifts', { id, shift_id: 'SH' + id, cashier: who, shift_date: DAY, status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const sell = (db, who, cid, extra = {}) => call(db, who, 'save_sale', Object.assign({ client_id: cid, sale_date: DAY, sale_time: DAY + 'T15:42:10+07:00', items: [{ product_id: 1, qty: 1, unit_price: 150000 }], discount: 0, payment_method: 'tunai', paid_amount: 150000 }, extra));

test('v68 invoice no. DD/MM/YYYY/HHmm/N: the day\'s count for the whole store; the time is the sale\'s; another day starts at 1', async () => {
  const db = seed();
  const a = await sell(db, 'Siti', 'c1');
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.invoice_no, DMY + '/1542/1');
  const b = await sell(db, 'Dewi', 'c2', { sale_time: DAY + 'T16:05:59+07:00' }); // another cashier: the same count goes on
  assert.equal(b.invoice_no, DMY + '/1605/2');
  const c = await sell(db, 'Siti', 'c3', { sale_time: DAY + 'T01:07:00.000Z' }); // UTC → Jakarta 08:07
  assert.equal(c.invoice_no, DMY + '/0807/3');
  assert.deepEqual(db.prepare('SELECT invoice_no, day_seq FROM pos_sales ORDER BY id').all().map(r => r.day_seq), [1, 2, 3]);
  // the same request again (the cashier's retry): the same invoice, no new number
  const again = await sell(db, 'Siti', 'c1');
  assert.equal(again.duplicate, true); assert.equal(again.invoice_no, a.invoice_no);
  // a void keeps its number; the next sale takes the next one
  const v = await call(db, 'Pemilik', 'void_sale', { invoice_no: b.invoice_no, reason: 'salah input' });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal((await sell(db, 'Siti', 'c4')).invoice_no, DMY + '/1542/4');
  // the receipt lines carry the same number
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pos_sale_items WHERE invoice_no = ?').get(a.invoice_no).n, 1);
  // a sale saved later for an earlier day (an offline sale synced afterwards) takes that day's next number
  const y = new Date(Date.parse(DAY) - 86400000).toISOString().slice(0, 10);
  const old = await sell(db, 'Siti', 'c5', { sale_date: y, sale_time: y + 'T21:30:00+07:00' });
  assert.equal(old.invoice_no, y.slice(8, 10) + '/' + y.slice(5, 7) + '/' + y.slice(0, 4) + '/2130/1');
});

test('v68 the day\'s older KM… invoices are counted (the first new number follows them)', async () => {
  const db = seed();
  for (let i = 1; i <= 3; i++) insert(db, 'pos_sales', { id: 100 + i, invoice_no: 'KM' + DAY.replace(/-/g, '').slice(2) + '-AB' + i, sale_date: DAY, sale_time: DAY + 'T09:00:00+07:00', cashier: 'Siti', total: 1000, status: 'ok', client_id: 'old' + i });
  assert.equal((await sell(db, 'Siti', 'n1')).invoice_no, DMY + '/1542/4');
  assert.equal((await sell(db, 'Siti', 'n2')).invoice_no, DMY + '/1542/5');
});

test('v68 two cashiers save at the same moment: both sales are kept, each with its own number', async () => {
  const db = seed();
  const [x, y] = await Promise.all([sell(db, 'Siti', 'p1'), sell(db, 'Dewi', 'p2')]);
  assert.equal(x.ok, true, JSON.stringify(x)); assert.equal(y.ok, true, JSON.stringify(y));
  assert.deepEqual([x.invoice_no, y.invoice_no].sort(), [DMY + '/1542/1', DMY + '/1542/2']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pos_sales').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pos_sale_items').get().n, 2);
  assert.equal(db.prepare('SELECT stock FROM pos_products WHERE id = 1').get().stock, 498);
});
