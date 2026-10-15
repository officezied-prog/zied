// v52 (owner 2026-10-15: «بعض البضائع المعروضة بالجملة ويأخذ الزبون كما يشاء الكمية … الشوكولاتة المعروضة بالكمية الكبيرة بدون ميزان تختار
// الزبون 250 غرام»): a product shown loose is sold by weight; the owner or the manager marks it (per kg / gram / ons only); the sale of
// 250 g of a per-kg product takes 0.25 from the stock.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222' };
const call = (db, user, action, data) => handleRequest(sqliteAdapter(db), { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'C1', name: 'Cokelat Turki Lezzo', category: 'Cokelat', unit: 'kg', cost_price: 70000, retail_price: 95000, stock: 4, shop_stock: 4, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'K1', name: 'Kismis 500g', category: 'Kismis', unit: 'pcs', cost_price: 20000, retail_price: 25000, stock: 50, shop_stock: 50, active: true });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SHS', cashier: 'Siti', shift_date: '2026-10-15', status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const prod = (db, id) => db.prepare('SELECT * FROM pos_products WHERE id = ?').get(id);

test('the manager marks a per-kg product as loose (and back); a per-piece product cannot be; a cashier cannot; it reaches the till', async () => {
  const db = seed();
  const r = await call(db, 'Jihan', 'set_loose', { product_id: 1, loose: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.product.loose, true);
  assert.equal(prod(db, 1).loose, 1);
  assert.equal(prod(db, 1).retail_price, 95000); // nothing else changes
  assert.match(db.prepare("SELECT summary FROM pos_activity WHERE kind = 'atur_curah'").get().summary, /Dijual curah .*Cokelat Turki Lezzo — oleh manajer Jihan/);
  assert.equal((await call(db, 'Jihan', 'set_loose', { product_id: 1, loose: true })).unchanged, true);
  const pcs = await call(db, 'Jihan', 'set_loose', { product_id: 2, loose: true });
  assert.equal(pcs.error, 'INVALID');
  assert.match(pcs.message, /per kg \/ gram \/ ons/);
  assert.equal((await call(db, 'Siti', 'set_loose', { product_id: 1, loose: false })).error, 'FORBIDDEN');
  const boot = await call(db, 'Siti', 'bootstrap', {});
  assert.equal(boot.products.find((p) => p.id === 1).loose, true);
  assert.equal(!!boot.products.find((p) => p.id === 2).loose, false); // never set: empty (the apps only look for true)
  // 250 g at the till = 0.25 kg
  const sale = await call(db, 'Siti', 'save_sale', { client_id: 'l1', sale_date: '2026-10-15', items: [{ product_id: 1, qty: 0.25, unit_price: 95000 }], payment_method: 'tunai', paid_amount: 23750 });
  assert.equal(sale.ok, true, JSON.stringify(sale));
  assert.equal(prod(db, 1).stock, 3.75);
  assert.equal(db.prepare('SELECT total FROM pos_sales WHERE invoice_no = ?').get(sale.invoice_no).total, 23750);
  assert.equal((await call(db, 'Pemilik', 'set_loose', { product_id: 1, loose: false })).product.loose, false);
});

test('save_product carries the flag (owner); per-piece + loose is refused', async () => {
  const db = seed();
  const ok = await call(db, 'Pemilik', 'save_product', { name: 'Almond Panggang', unit: 'kg', category: 'Kacang', retail_price: 180000, cost_price: 140000, stock: 5, loose: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.product.loose, true);
  const bad = await call(db, 'Pemilik', 'save_product', { name: 'Kurma Box', unit: 'box', retail_price: 50000, loose: true });
  assert.equal(bad.error, 'INVALID');
  // an edit without the field keeps it
  const id = ok.product.id;
  const ed = await call(db, 'Pemilik', 'save_product', { id, name: 'Almond Panggang', unit: 'kg', category: 'Kacang', retail_price: 180000, cost_price: 140000 });
  assert.equal(ed.ok, true, JSON.stringify(ed));
  assert.equal(prod(db, id).loose, 1);
});
