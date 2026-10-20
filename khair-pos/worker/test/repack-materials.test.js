// v63 (owner 2026-10-20) — packaging materials come in like any goods, on the real backend (backend/process.js through the
// Worker's loaders) on an in-memory SQLite:
//   «عند استقبال أي بضاعة تدخل إلى المحل يتم كتابة ثمنها ونوعها ولأي شيء تستعمل … ستيكر عجوة 250 غرام، هناك كم ثمن الحبة الواحدة، يتم إدخاله
//    عند استقبال البضاعة من الموظف الاستقبال أو الكاشير … أو أيضا العلبة التي يتم فيها التعليب»; «المدير و المحاسب» confirm the packs made.
//   1. the cashier adds a sticker at goods-in as a packaging material, with the pack it is for (no selling price, no size);
//   2. its goods-in note gives its price per piece (the cost price) and its stock; it is never sold;
//   3. the pack's cost carries it at that price; a confirmed repack takes the stickers used out of their stock (never below 0);
//   4. the accountant may confirm the packs made; the owner's notice carries what one pack cost.
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
  insert(db, 'pos_products', { id: 1, sku: 'B1', name: 'Kurma Ajwa 5 kg', category: 'Kurma', unit: 'kg', cost_price: 100000, retail_price: 150000, stock: 20, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'P1', name: 'Kurma Ajwa 500 g', category: 'Kurma', unit: 'pak', cost_price: 0, retail_price: 70000, stock: 0, shop_stock: 0, active: true, repack_from: 1, repack_qty: 0.5 });
  insert(db, 'pos_products', { id: 3, sku: 'P2', name: 'Kurma Ajwa 250 g', category: 'Kurma', unit: 'pak', cost_price: 0, retail_price: 38000, stock: 0, shop_stock: 0, active: true, repack_from: 1, repack_qty: 0.25 });
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', opening_cash: 200000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  insert(db, 'pos_photos', { id: 50, photo_id: 'PHM', kind: 'masuk', user: 'Siti', extracted: JSON.stringify({ items: [{ name: 'STIKER AJWA', qty: 100 }, { name: 'TOPLES 500', qty: 30 }], readable: true }), match_status: '', match_notes: '' });
  return db;
}
const prod = (db, id) => ({ ...db.prepare('SELECT * FROM pos_products WHERE id = ?').get(id) });
const notices = (db) => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();

test('v63 a sticker and a jar come in at goods-in as packaging materials; the pack costs them; a confirmed repack uses them up', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  // 1. the cashier adds them while receiving: no selling price, no size — the pack they are for instead
  assert.equal((await call(ad, 'Siti', 'save_product', { name: 'Stiker Ajwa', material: true, unit: 'pcs', from_goods_in: true })).error, 'INVALID'); // what is it for?
  assert.equal((await call(ad, 'Siti', 'save_product', { name: 'Stiker Ajwa', material: true, unit: 'pcs', from_goods_in: true, use_for: [{ pack_id: 1 }] })).error, 'INVALID'); // not a pack
  const st = await call(ad, 'Siti', 'save_product', { name: 'Stiker Ajwa', material: true, unit: 'pcs', from_goods_in: true, use_for: [{ pack_id: 2, qty: 1 }, { pack_id: 3, qty: 1 }] });
  assert.equal(st.ok, true, JSON.stringify(st));
  const jar = await call(ad, 'Siti', 'save_product', { name: 'Toples 500', category: 'bahan kemasan', unit: 'pcs', from_goods_in: true, use_for: [{ pack_id: 2 }] });
  assert.equal(jar.ok, true, JSON.stringify(jar));
  const s0 = prod(db, st.product.id);
  assert.equal(s0.category, 'Bahan kemasan'); assert.equal(s0.retail_price, 0);
  assert.deepEqual(JSON.parse(s0.use_for), [{ p: 2, q: 1 }, { p: 3, q: 1 }]);
  // 2. their goods-in note: the price per piece and the stock
  const pu = await call(ad, 'Siti', 'save_purchase', { supplier: 'Percetakan', photo_id: 'PHM', carrier: { type: 'pemasok', name: 'Sopir' },
    items: [{ product_id: st.product.id, qty: 100, cost_price: 300, exp_none: true, photo_index: 0 }, { product_id: jar.product.id, qty: 30, cost_price: 2500, exp_none: true, photo_index: 1 }] });
  assert.equal(pu.ok, true, JSON.stringify(pu));
  assert.equal(prod(db, st.product.id).cost_price, 300); assert.equal(prod(db, st.product.id).stock, 100);
  // never sold
  const sale = await call(ad, 'Siti', 'save_sale', { sale_date: '2026-10-20', items: [{ product_id: st.product.id, qty: 1, price: 0 }], payments: [{ method: 'cash', amount: 0 }] });
  assert.equal(sale.ok, false); assert.match(sale.message, /bahan kemasan — tidak dijual/);
  // 3. the pack shows its materials: names, pieces, stock for everyone; the cost for the manager, not the cashier
  const kb = (await call(ad, 'Siti', 'bootstrap', {})).products.find((p) => p.id === 2);
  assert.deepEqual(kb.materials.map((m) => [m.name, m.q, m.stock, m.cost]), [['Stiker Ajwa', 1, 100, undefined], ['Toples 500', 1, 30, undefined]]);
  const mb = (await call(ad, 'Jihan', 'bootstrap', {})).products.find((p) => p.id === 2);
  assert.deepEqual(mb.materials.map((m) => m.cost), [300, 2500]);
  assert.equal((await call(ad, 'Siti', 'bootstrap', {})).products.find((p) => p.id === st.product.id).material, true);
  // 5 kg of bulk → 10 packs of 500 g planned; 10 made, confirmed by the ACCOUNTANT
  const rs = await call(ad, 'Siti', 'repack_start', { client_id: 'c-1', from_product_id: 1, to_product_id: 2, from_qty: 5, packaging_cost: 20000 });
  assert.equal(rs.ok, true, JSON.stringify(rs)); assert.equal(rs.repack.planned_qty, 10);
  const fin = await call(ad, 'Aqil', 'repack_finish', { repack_id: rs.repack.repack_id, to_qty: 10, remaining_qty: 0 });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(prod(db, st.product.id).stock, 90); assert.equal(prod(db, jar.product.id).stock, 20);
  // one pack: 0.5 kg × 100.000 + sticker 300 + jar 2.500 + 20.000 / 10 labour and other = 54.800
  const r = db.prepare('SELECT * FROM pos_repacks WHERE repack_id = ?').get(rs.repack.repack_id);
  assert.equal(r.materials_cost, 10 * 2800); assert.equal(r.unit_cost, 54800); assert.equal(r.confirmed_by, 'Aqil');
  const n = notices(db), own = n.at(-2), mgr = n.at(-1);
  assert.equal(own.ref, 'owner'); assert.equal(mgr.ref, 'manager');
  assert.match(own.summary, /dikonfirmasi akuntan Aqil .* — bahan: Stiker Ajwa 10, Toples 500 10 — biaya per pak: Rp 54\.800 \(curah Rp 50\.000, bahan Rp 2\.800, upah & lain Rp 2\.000\)$/);
  assert.doesNotMatch(mgr.summary, /biaya per/);
  // the used stickers are on record (a KEMAS ULANG row)
  assert.equal(db.prepare("SELECT qty FROM pos_purchases WHERE product_id = ? AND supplier = 'KEMAS ULANG'").get(st.product.id).qty, -10);
  // 4. not enough jars: what is there is used, and everyone is told
  const r2 = await call(ad, 'Siti', 'repack_start', { client_id: 'c-2', from_product_id: 1, to_product_id: 2, from_qty: 12.5, confirm_recent: true });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const f2 = await call(ad, 'Jihan', 'repack_finish', { repack_id: r2.repack.repack_id, to_qty: 25, remaining_qty: 0 });
  assert.equal(f2.ok, true, JSON.stringify(f2));
  assert.equal(prod(db, jar.product.id).stock, 0); assert.equal(prod(db, st.product.id).stock, 65);
  assert.match(notices(db).at(-1).summary, /STOK KURANG: Toples 500 ada 20/);
  // the cashier may not confirm
  const r3 = await call(ad, 'Siti', 'repack_start', { client_id: 'c-3', from_product_id: 1, to_product_id: 3, from_qty: 1, confirm_recent: true });
  assert.equal((await call(ad, 'Siti', 'repack_finish', { repack_id: r3.repack.repack_id, to_qty: 4, remaining_qty: 0 })).error, 'FORBIDDEN');
});
