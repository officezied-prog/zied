// v39: products imported first (no quantities), quantities imported later → they land on the shelf, so they can be sold.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const imp = (ad, rows) => handleRequest(ad, { action: 'import_products', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { rows } }, {}, KEY);

test('import names first, quantities later: an empty warehouse puts the quantity on the shelf; real warehouse stock stays', async () => {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_products', { id: 9, sku: 'G1', name: 'Gula 1 kg', unit: 'pak', cost_price: 14000, retail_price: 16000, stock: 30, shop_stock: 10, active: true }); // 20 in the warehouse
  const ad = sqliteAdapter(db);
  const r1 = await imp(ad, [{ name: '7 Dates Susu Kurma', sku: '8997214730064', unit: 'pcs', cost_price: 5666, retail_price: 10000 }]);
  assert.equal(r1.created, 1);
  const row = () => db.prepare('SELECT stock, shop_stock FROM pos_products WHERE sku = ?').get('8997214730064');
  assert.deepEqual({ ...row() }, { stock: 0, shop_stock: 0 });
  const r2 = await imp(ad, [{ sku: '8997214730064', stock: 24 }, { sku: 'G1', stock: 40 }]);
  assert.equal(r2.updated, 2);
  assert.deepEqual({ ...row() }, { stock: 24, shop_stock: 24 }); // on the shelf → can be sold
  assert.equal(db.prepare('SELECT name, retail_price FROM pos_products WHERE sku = ?').get('8997214730064').retail_price, 10000); // only the stock changed
  assert.deepEqual({ ...db.prepare('SELECT stock, shop_stock FROM pos_products WHERE sku = ?').get('G1') }, { stock: 40, shop_stock: 10 }); // shelf kept, warehouse 30
  // a lower quantity later: the shelf follows (all of it was on the shelf)
  await imp(ad, [{ sku: '8997214730064', stock: 5 }]);
  assert.deepEqual({ ...row() }, { stock: 5, shop_stock: 5 });
  // new products imported WITH quantities: all on the shelf, as before
  await imp(ad, [{ name: 'Kurma Sukari 1 kg', sku: 'S1', stock: 12, retail_price: 110000 }]);
  assert.deepEqual({ ...db.prepare('SELECT stock, shop_stock FROM pos_products WHERE sku = ?').get('S1') }, { stock: 12, shop_stock: 12 });
});

// v44 (owner 2026-10-13: «خيار إضافة الأصناف غير الموجودة فقط»): only_new adds what the app does not have; a product with the
// same barcode or the same name (entered by hand) is skipped — no price, stock or name change.
test('import only_new: existing products (same barcode or name) are skipped untouched; new ones are added', async () => {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_products', { id: 9, sku: 'G1', name: 'Gula 1 kg', unit: 'pak', cost_price: 14000, retail_price: 16000, stock: 30, shop_stock: 10, active: true });
  insert(db, 'pos_products', { id: 10, sku: '', name: 'Teh Celup', unit: 'box', cost_price: 8000, retail_price: 9500, stock: 4, shop_stock: 4, active: true });
  const ad = sqliteAdapter(db);
  const r = await handleRequest(ad, { action: 'import_products', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { only_new: true, rows: [
    { name: 'Gula Pasir (majoo)', sku: 'G1', retail_price: 1, stock: 999 },
    { name: 'teh celup', retail_price: 1, stock: 999 },
    { name: 'Kopi Baru', sku: 'K9', retail_price: 20000 },
    { name: 'Kopi Baru', sku: 'K9', retail_price: 21000 } // twice in the file: added once
  ] } }, {}, KEY);
  assert.deepEqual([r.created, r.updated, r.skipped], [1, 0, 3]);
  assert.deepEqual({ ...db.prepare('SELECT name, retail_price, stock FROM pos_products WHERE id = 9').get() }, { name: 'Gula 1 kg', retail_price: 16000, stock: 30 });
  assert.deepEqual({ ...db.prepare('SELECT name, retail_price, stock FROM pos_products WHERE id = 10').get() }, { name: 'Teh Celup', retail_price: 9500, stock: 4 });
  assert.equal(db.prepare("SELECT retail_price FROM pos_products WHERE sku = 'K9'").get().retail_price, 20000);
  // without the option the import still updates (unchanged behaviour)
  const u = await imp(ad, [{ sku: 'G1', retail_price: 17000 }]);
  assert.equal(u.updated, 1);
  assert.equal(db.prepare('SELECT retail_price FROM pos_products WHERE id = 9').get().retail_price, 17000);
});
