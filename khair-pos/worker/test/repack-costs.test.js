// v48 (owner 2026-10-14): «في بعض الأحيان نقوم بتعبية منتج جديد مثلا نختار عبوة جديدة و ستيكر جديد … واجعل ايضا هناك مصاريف للتعبية
// مثلا اختيار الستيكر الغطاء كثير اشياء فاجعل للمدير له خانات يمكن ان يضيفها للتكلفة التعبية» — a NEW pack product made in the repack
// setup, and the pack's materials (cost per pack) that every repack adds to the pack's cost.
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
  insert(db, 'pos_products', { id: 1, sku: 'KRM10', name: 'Kurma Ajwa Curah', category: 'Kurma', unit: 'kg', cost_price: 120000, retail_price: 160000, stock: 20, shop_stock: 20, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'KRM-T500', name: 'Kurma Ajwa Toples 500 g', category: 'Kurma', unit: 'toples', cost_price: 0, retail_price: 95000, stock: 0, shop_stock: 0, active: true, repack_from: 1, repack_qty: 0.5 });
  return db;
}
const notices = (db) => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();
const row = (db, sql, ...a) => ({ ...db.prepare(sql).get(...a) });

test('the manager makes a NEW pack (new jar + sticker) right in the setup, with its materials; the owner and the accountant are told', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await call(ad, 'Jihan', 'set_repack', {
    new_product: { name: 'Kurma Ajwa Box Premium 250 g', unit: 'box', sku: '8991234500017', retail_price: 55000 },
    repack_from: 1, repack_qty: 0.25,
    costs: [{ name: 'Box premium', cost: 4500 }, { name: 'Stiker', cost: 500 }, { name: '', cost: '' }, { name: 'Pita', cost: 1000 }]
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.ok(r.product.id > 0, 'the new product comes back with its id');
  const p = row(db, 'SELECT * FROM pos_products WHERE name = ?', 'Kurma Ajwa Box Premium 250 g');
  assert.equal(p.category, 'Kurma'); assert.equal(p.unit, 'box'); assert.equal(p.sku, '8991234500017');
  assert.equal(p.retail_price, 55000); assert.equal(p.stock, 0); assert.equal(p.cost_price, 0);
  assert.equal(Number(p.repack_from), 1); assert.equal(Number(p.repack_qty), 0.25);
  assert.deepEqual(JSON.parse(p.repack_costs), [{ n: 'Box premium', c: 4500 }, { n: 'Stiker', c: 500 }, { n: 'Pita', c: 1000 }]);
  const n = notices(db).at(-1);
  assert.equal(n.ref, 'owner,akuntan');
  assert.match(n.summary, /Kemasan baru dibuat: Kurma Ajwa Box Premium 250 g \(box, barcode 8991234500017, harga jual Rp 55\.000\) dibuat dari Kurma Ajwa Curah, 0\.25 kg per box; bahan kemasan per box: Box premium Rp 4\.500 \+ Stiker Rp 500 \+ Pita Rp 1\.000 = Rp 6\.000 — oleh manajer Jihan/);
  // the same name / barcode again is refused
  assert.equal((await call(ad, 'Jihan', 'set_repack', { new_product: { name: 'kurma ajwa box premium 250 g', retail_price: 55000 }, repack_from: 1, repack_qty: 0.25 })).error, 'INVALID');
  assert.equal((await call(ad, 'Jihan', 'set_repack', { new_product: { name: 'Box Lain', sku: '8991234500017', retail_price: 55000 }, repack_from: 1, repack_qty: 0.25 })).error, 'INVALID');
  // a new pack needs its bulk, its size and its selling price
  assert.equal((await call(ad, 'Jihan', 'set_repack', { new_product: { name: 'Box Tanpa Curah', retail_price: 1000 }, repack_from: 0 })).error, 'INVALID');
  assert.equal((await call(ad, 'Jihan', 'set_repack', { new_product: { name: 'Box Tanpa Harga' }, repack_from: 1, repack_qty: 0.25 })).error, 'INVALID');
  // the cashier and the accountant cannot
  for (const u of ['Siti', 'Aqil']) assert.equal((await call(ad, u, 'set_repack', { new_product: { name: 'Box X', retail_price: 1000 }, repack_from: 1, repack_qty: 0.25 })).error, 'FORBIDDEN', u);
});

test('materials × packs go into the pack cost of every repack; the cashier sees the material names only', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const s = await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.5, costs: [{ name: 'Toples', cost: 3000 }, { name: 'Stiker', cost: 500 }, { name: 'Tutup segel', cost: 700 }] });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.match(notices(db).at(-1).summary, /Biaya kemasan diubah: Kurma Ajwa Toples 500 g; bahan kemasan per toples: Toples Rp 3\.000 \+ Stiker Rp 500 \+ Tutup segel Rp 700 = Rp 4\.200 — oleh manajer Jihan/);
  // the cashier packs 10 jars from 5 kg (+ a one-off Rp 2.000 typed in the form)
  const rp = await call(ad, 'Siti', 'repack', { to_product_id: 2, to_qty: 10, packaging_cost: 2000, client_id: 'rc-1' });
  assert.equal(rp.ok, true, JSON.stringify(rp));
  assert.equal(rp.repack.materials_cost, undefined); assert.equal(rp.repack.unit_cost, undefined); // no costs to the cashier
  const r = row(db, 'SELECT packaging_cost, materials_cost, unit_cost FROM pos_repacks ORDER BY id DESC LIMIT 1');
  assert.deepEqual(r, { packaging_cost: 44000, materials_cost: 42000, unit_cost: 64400 }); // (5 × 120.000 + 42.000 + 2.000) / 10
  assert.equal(row(db, 'SELECT cost_price FROM pos_products WHERE id = 2').cost_price, 64400);
  // the cashier's product list: the names of the materials, not their prices; the manager sees the prices
  const bk = await call(ad, 'Siti', 'bootstrap', {});
  const kp = bk.products.find(x => x.id === 2);
  assert.deepEqual(JSON.parse(kp.repack_costs), [{ n: 'Toples' }, { n: 'Stiker' }, { n: 'Tutup segel' }]);
  const bm = await call(ad, 'Jihan', 'bootstrap', {});
  assert.deepEqual(JSON.parse(bm.products.find(x => x.id === 2).repack_costs).map(x => x.c), [3000, 500, 700]);
  // unchanged → nothing written; no list sent → kept; removing the repack clears the materials
  const before = notices(db).length;
  assert.equal((await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.5 })).unchanged, true);
  assert.equal((await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.5, costs: [{ name: 'Toples', cost: 3000 }, { name: 'Stiker', cost: 500 }, { name: 'Tutup segel', cost: 700 }] })).unchanged, true);
  assert.equal(notices(db).length, before);
  await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 0 });
  assert.equal(row(db, 'SELECT repack_costs FROM pos_products WHERE id = 2').repack_costs, '');
});

test('bad material lines are refused', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const bad = async costs => (await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.5, costs })).error;
  assert.equal(await bad([{ name: 'Stiker', cost: -5 }]), 'INVALID');
  assert.equal(await bad([{ name: '', cost: 500 }]), 'INVALID');
  assert.equal(await bad([{ name: 'S'.repeat(41), cost: 500 }]), 'INVALID');
  assert.equal(await bad(Array.from({ length: 13 }, (_, i) => ({ name: 'Bahan ' + i, cost: 100 }))), 'INVALID');
  assert.equal(await bad('stiker'), 'INVALID');
  assert.equal(row(db, 'SELECT repack_costs FROM pos_products WHERE id = 2').repack_costs, null);
});
