// v43 (owner 2026-10-13): «اختيار البضائع لاعادة التعبئة للمواد يقوم بها المدير ليس المالك و يصل اشعار للمالك و المحاسب» —
// the manager (or the owner) sets which product is packed from which bulk product and how much per pack; the others are told.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'M20', name: 'Minyak Goreng 20 L', unit: 'liter', cost_price: 18000, retail_price: 22000, stock: 40, shop_stock: 40, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'M05', name: 'Minyak Goreng 1/2 L', unit: 'btl', cost_price: 0, retail_price: 12000, stock: 0, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 3, sku: 'G25', name: 'Gula 25 kg', unit: 'kg', cost_price: 15000, retail_price: 17000, stock: 50, shop_stock: 50, active: true });
  return db;
}
const notices = (db) => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();
const prod = (db, id) => { const r = db.prepare('SELECT repack_from, repack_qty FROM pos_products WHERE id = ?').get(id); return { repack_from: Number(r.repack_from) || 0, repack_qty: Number(r.repack_qty) || 0 }; };

test('the manager sets a pack product from a bulk one; the owner and the accountant are told; nothing else of the product changes', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(prod(db, 2), { repack_from: 1, repack_qty: 0.5 });
  assert.equal(r.product.repack_from, 1);
  const n = notices(db).at(-1);
  assert.equal(n.ref, 'owner,akuntan');
  assert.match(n.summary, /Kemas ulang diatur: Minyak Goreng 1\/2 L dibuat dari Minyak Goreng 20 L, 0\.5 liter per btl — oleh manajer Jihan/);
  const p = { ...db.prepare('SELECT name, retail_price, stock FROM pos_products WHERE id = 2').get() };
  assert.deepEqual(p, { name: 'Minyak Goreng 1/2 L', retail_price: 12000, stock: 0 });
  // v72: a content that does not match the names ("1/2 L" = 0.5 liter) is refused, with the right one
  const bad = await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.45 });
  assert.equal(bad.error, 'SIZE_MISMATCH');
  assert.equal(bad.want, 0.5);
  assert.match(bad.message, /Minyak Goreng 1\/2 L \(500 ml\) dari Minyak Goreng 20 L = 0\.5 liter per btl, bukan 0\.45 liter\. Tulis 500 ml \(atau 0\.5\)/);
  assert.deepEqual(prod(db, 2), { repack_from: 1, repack_qty: 0.5 });
  // changed later (within 3 %): the notice says what it was before
  await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.51 });
  assert.match(notices(db).at(-1).summary, /0\.51 liter per btl \(sebelumnya Minyak Goreng 20 L, 0\.5 liter per btl\)/);
  // the same again: nothing written, no notice
  const before = notices(db).length;
  const same = await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.51 });
  assert.equal(same.unchanged, true);
  assert.equal(notices(db).length, before);
  // removed
  await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 0 });
  assert.deepEqual(prod(db, 2), { repack_from: 0, repack_qty: 0 });
  assert.match(notices(db).at(-1).summary, /Kemas ulang dihapus: Minyak Goreng 1\/2 L tidak lagi dibuat dari Minyak Goreng 20 L/);
});

test('set_repack: only the manager and the owner; the owner\'s change tells the manager and the accountant; bad inputs are refused', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  for (const u of ['Siti', 'Aqil']) assert.equal((await call(ad, u, 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.5 })).error, 'FORBIDDEN', u);
  assert.deepEqual(prod(db, 2), { repack_from: 0, repack_qty: 0 });
  const o = await call(ad, 'Pemilik', 'set_repack', { product_id: 2, repack_from: 3, repack_qty: 1 });
  assert.equal(o.ok, true);
  assert.equal(notices(db).at(-1).ref, 'manager,akuntan');
  assert.match(notices(db).at(-1).summary, /— oleh pemilik Pemilik/);
  assert.equal((await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 2, repack_qty: 1 })).error, 'INVALID'); // itself
  assert.equal((await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1 })).error, 'INVALID'); // no size
  assert.equal((await call(ad, 'Jihan', 'set_repack', { product_id: 3, repack_from: 2, repack_qty: 1 })).error, 'INVALID'); // the bulk is made from it
  assert.equal((await call(ad, 'Jihan', 'set_repack', { product_id: 99, repack_from: 1, repack_qty: 1 })).error, 'NOT_FOUND');
  // the manager's setting is used by the repack itself (the cashier packs 10 bottles from 5 L)
  await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.5 });
  const rp = await call(ad, 'Siti', 'repack', { to_product_id: 2, to_qty: 10, client_id: 'rp-test-1' });
  assert.equal(rp.ok, true, JSON.stringify(rp));
  assert.equal(db.prepare('SELECT stock FROM pos_products WHERE id = 1').get().stock, 35);
});
