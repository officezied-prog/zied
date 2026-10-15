// v50 (owner 2026-10-15) — repacking in two steps, and the packaging materials as a list, on the real backend (backend/process.js
// through the Worker's loaders and race guards) on an in-memory SQLite:
//   «تنطلق عملية التعبية باختيار العنصر الكبير … ثم الحاسوب يحسب مباشرة الكمية المطلوبة … وبعد عملية التعليب تقع الموافقة على الكمية التي
//    تمت عن طريق المدير فإن كانت كمية أقل فيرجى كتابتها وكم الكمية اللي ما زالت»
//   1. repack_start: the bulk and how much of it goes to the packing table; the packs it should give are worked out (whole packs);
//      the bulk leaves the stock at once; the same pack from the same bulk cannot be started twice; the manager is told;
//   2. repack_finish (manager / owner): the packs really made + the bulk left over (back to stock) — or cancel; once only;
//   «لا يمكن كتابة شيء بعد كلمة توبليس أو ستيكر … فهي تكون عنصر للاختيار بس»
//   3. the materials list (name + price per piece) kept by the manager; a pack chooses from it; the cost follows the list's price.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444', Rina: '3333' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Rina', role: 'kasir', pin_hash: h('Rina', '3333'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'B1', name: 'Kurma Ajwa Curah', category: 'Kurma', unit: 'kg', cost_price: 120000, retail_price: 160000, stock: 20, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'P1', name: 'Kurma Ajwa Toples 1 kg', category: 'Kurma', unit: 'toples', cost_price: 0, retail_price: 175000, stock: 0, shop_stock: 0, active: true, repack_from: 1, repack_qty: 1 });
  insert(db, 'pos_products', { id: 3, sku: 'P2', name: 'Kurma Ajwa 500 g', category: 'Kurma', unit: 'pak', cost_price: 0, retail_price: 90000, stock: 0, shop_stock: 0, active: true, repack_from: 1, repack_qty: 0.5 });
  insert(db, 'pos_products', { id: 4, sku: 'M1', name: 'Minyak Zaitun Curah', category: 'Minyak', unit: 'liter', cost_price: 90000, retail_price: 120000, stock: 10, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 5, sku: 'P3', name: 'Kurma Ajwa Box', category: 'Kurma', unit: 'box', cost_price: 0, retail_price: 50000, stock: 0, shop_stock: 0, active: true });
  return db;
}
const stockOf = (db, id) => db.prepare('SELECT stock FROM pos_products WHERE id = ?').get(id).stock;
const repackRow = (db, id) => ({ ...db.prepare('SELECT * FROM pos_repacks WHERE repack_id = ?').get(id) });
const notices = (db) => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();

test('the materials list: the manager keeps it (name + price per piece); a pack chooses from it; the cashier sees no prices', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const m = await call(ad, 'Jihan', 'set_repack_materials', { materials: [{ name: 'Toples 1 kg', cost: 3000 }, { name: 'Stiker', cost: 500 }, { name: 'Tutup segel', cost: 700 }] });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.match(notices(db).at(-1).summary, /Daftar bahan kemasan diubah \(harga per buah\): \+ Toples 1 kg Rp 3\.000; \+ Stiker Rp 500; \+ Tutup segel Rp 700 — oleh manajer Jihan/);
  assert.equal(notices(db).at(-1).ref, 'owner,akuntan');
  assert.equal((await call(ad, 'Jihan', 'set_repack_materials', { materials: [{ name: 'Toples 1 kg', cost: 3000 }, { name: 'Stiker', cost: 500 }, { name: 'Tutup segel', cost: 700 }] })).unchanged, true);
  for (const bad of [[{ name: 'Stiker', cost: -1 }], [{ name: 'Stiker', cost: 1 }, { name: 'stiker', cost: 2 }], [{ name: 'S'.repeat(41), cost: 1 }], 'x']) assert.equal((await call(ad, 'Jihan', 'set_repack_materials', { materials: bad })).error, 'INVALID');
  assert.equal((await call(ad, 'Siti', 'set_repack_materials', { materials: [] })).error, 'FORBIDDEN');
  // the pack chooses its materials (2 stickers) — a name not on the list is refused (no free text)
  assert.equal((await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 1, materials: [{ name: 'Lakban', qty: 1 }] })).error, 'INVALID');
  const s = await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 1, materials: [{ name: 'toples 1 kg', qty: 1 }, { name: 'Stiker', qty: 2 }, { name: 'Tutup segel' }] });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual(JSON.parse(db.prepare('SELECT repack_costs FROM pos_products WHERE id = 2').get().repack_costs), [{ n: 'Toples 1 kg', q: 1, c: 3000 }, { n: 'Stiker', q: 2, c: 1000 }, { n: 'Tutup segel', q: 1, c: 700 }]);
  assert.match(notices(db).at(-1).summary, /bahan kemasan per toples: Toples 1 kg Rp 3\.000 \+ Stiker x2 Rp 1\.000 \+ Tutup segel Rp 700 = Rp 4\.700/);
  // the cashier: the names only (bootstrap settings and products); the manager: the prices
  const bk = await call(ad, 'Siti', 'bootstrap', {});
  assert.deepEqual(bk.settings.repack_materials, [{ n: 'Toples 1 kg' }, { n: 'Stiker' }, { n: 'Tutup segel' }]);
  assert.deepEqual(JSON.parse(bk.products.find((p) => p.id === 2).repack_costs).map((x) => x.n), ['Toples 1 kg', 'Stiker', 'Tutup segel']);
  assert.equal(JSON.parse(bk.products.find((p) => p.id === 2).repack_costs)[0].c, undefined);
  assert.deepEqual((await call(ad, 'Jihan', 'bootstrap', {})).settings.repack_materials.map((x) => x.c), [3000, 500, 700]);
});

test('start → the bulk leaves the stock, the packs are worked out; the manager confirms fewer packs + the bulk left over; once only', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  await call(ad, 'Jihan', 'set_repack_materials', { materials: [{ name: 'Toples 1 kg', cost: 3000 }, { name: 'Stiker', cost: 500 }] });
  await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 1, materials: [{ name: 'Toples 1 kg' }, { name: 'Stiker', qty: 2 }] });
  // the cashier: 5 kg of dates → 1 kg jars = 5 jars
  const st = await call(ad, 'Siti', 'repack_start', { client_id: 'c-1', from_product_id: 1, to_product_id: 2, from_qty: 5, packaging_cost: 2000, note: 'rak depan' });
  assert.equal(st.ok, true, JSON.stringify(st));
  const id = st.repack.repack_id;
  assert.equal(st.repack.status, 'proses'); assert.equal(st.repack.planned_qty, 5); assert.equal(st.repack.started_by, 'Siti');
  assert.equal(st.repack.packaging_cost, undefined); assert.equal(st.repack.bulk_cost, undefined); // no costs to the cashier
  assert.equal(stockOf(db, 1), 15); assert.equal(stockOf(db, 2), 0); // the bulk is on the packing table, no jars yet
  assert.match(notices(db).at(-1).summary, /Mulai kemas ulang oleh kasir Siti .*Kurma Ajwa Curah 5 kg diambil → Kurma Ajwa Toples 1 kg \(1 kg per toples\) = 5 kemasan rencana \| stok Kurma Ajwa Curah 20 → 15 kg\. Setelah selesai, manajer mengonfirmasi/);
  assert.equal(notices(db).at(-1).ref, 'owner,manager');
  // a resend is the same start; the same pack from the same bulk cannot start again while this one is open
  assert.equal((await call(ad, 'Siti', 'repack_start', { client_id: 'c-1', from_product_id: 1, to_product_id: 2, from_qty: 5 })).duplicate, true);
  const busy = await call(ad, 'Rina', 'repack_start', { client_id: 'c-2', from_product_id: 1, to_product_id: 2, from_qty: 3, confirm_recent: true });
  assert.equal(busy.error, 'REPACK_BUSY'); assert.equal(busy.busy.by, 'Siti');
  assert.equal(stockOf(db, 1), 15);
  // everyone who works with it sees it open
  assert.deepEqual((await call(ad, 'Rina', 'bootstrap', {})).repacks_open.map((r) => r.repack_id), [id]);
  // the cashier cannot confirm; the manager: 4 jars made, 0.9 kg of dates left over
  assert.equal((await call(ad, 'Siti', 'repack_finish', { repack_id: id, to_qty: 5, remaining_qty: 0 })).error, 'FORBIDDEN');
  assert.equal((await call(ad, 'Jihan', 'repack_finish', { repack_id: id, to_qty: 0, remaining_qty: 0 })).error, 'INVALID');
  assert.equal((await call(ad, 'Jihan', 'repack_finish', { repack_id: id, to_qty: 4, remaining_qty: 6 })).error, 'INVALID'); // more left than taken
  assert.equal((await call(ad, 'Jihan', 'repack_finish', { repack_id: id, to_qty: 5, remaining_qty: 2 })).error, 'INVALID'); // 5 jars from 3 kg
  const fin = await call(ad, 'Jihan', 'repack_finish', { repack_id: id, to_qty: 4, remaining_qty: 0.9 });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(stockOf(db, 1), 15.9); assert.equal(stockOf(db, 2), 4);
  const r = repackRow(db, id);
  assert.equal(r.status, 'selesai'); assert.equal(r.confirmed_by, 'Jihan'); assert.equal(r.started_by, 'Siti');
  assert.equal(r.from_qty, 4.1); assert.equal(r.remaining_qty, 0.9); assert.equal(r.to_qty, 4); assert.equal(r.planned_qty, 5);
  assert.equal(r.loss_qty, 0.1); assert.equal(r.yield_pct, 97.6);
  assert.equal(r.materials_cost, 4 * 4000); assert.equal(r.packaging_cost, 2000 + 16000);
  assert.equal(r.unit_cost, Math.round((4.1 * 120000 + 18000) / 4));
  assert.equal(db.prepare('SELECT cost_price FROM pos_products WHERE id = 2').get().cost_price, r.unit_cost);
  const n = notices(db).at(-1);
  assert.equal(n.ref, 'owner,akuntan');
  assert.match(n.summary, /Kemas ulang selesai, dikonfirmasi manajer Jihan \(RP\w+, dimulai Siti .*\): Kurma Ajwa Curah 4\.1 kg → Kurma Ajwa Toples 1 kg x4 .*rencana 5, jadi 4; sisa curah 0\.9 kg kembali ke stok — KURANG 1 dari rencana/);
  // once only; it is no longer open
  assert.equal((await call(ad, 'Pemilik', 'repack_finish', { repack_id: id, to_qty: 4, remaining_qty: 0.9 })).error, 'INVALID');
  assert.deepEqual((await call(ad, 'Rina', 'bootstrap', {})).repacks_open, []);
  // the goods movements: 5 kg out at the start, 0.9 kg back, 4 jars in
  const mv = db.prepare("SELECT product_id, qty FROM pos_purchases WHERE supplier = 'KEMAS ULANG' ORDER BY id").all().map((x) => [x.product_id, x.qty]);
  assert.deepEqual(mv, [[1, -5], [1, 0.9], [2, 4]]);
});

test('cancel: everything goes back; wrong starts are refused (not set up, another bulk, less than one pack, more than the stock)', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const st = await call(ad, 'Jihan', 'repack_start', { from_product_id: 1, to_product_id: 3, from_qty: 2.2 });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.repack.planned_qty, 4); // 2.2 kg ÷ 0.5 kg = 4 whole packs (0.2 kg over)
  assert.match(notices(db).at(-1).summary, /= 4 kemasan rencana, sisa 0\.2 kg/);
  assert.equal(notices(db).at(-1).ref, 'owner');
  assert.equal(stockOf(db, 1), 17.8);
  const c = await call(ad, 'Pemilik', 'repack_finish', { repack_id: st.repack.repack_id, cancel: true });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(stockOf(db, 1), 20); assert.equal(stockOf(db, 3), 0);
  assert.equal(repackRow(db, st.repack.repack_id).status, 'batal');
  assert.match(notices(db).at(-1).summary, /Kemas ulang DIBATALKAN oleh pemilik Pemilik/);
  const bad = async (d) => (await call(ad, 'Siti', 'repack_start', Object.assign({ confirm_recent: true }, d))).error;
  assert.equal(await bad({ from_product_id: 1, to_product_id: 5, from_qty: 1 }), 'INVALID'); // not set up as a pack
  assert.equal(await bad({ from_product_id: 4, to_product_id: 2, from_qty: 1 }), 'INVALID'); // made from another bulk
  assert.equal(await bad({ from_product_id: 1, to_product_id: 2, from_qty: 0.6 }), 'INVALID'); // less than one 1 kg jar
  assert.equal(await bad({ from_product_id: 1, to_product_id: 2, from_qty: 25 }), 'INVALID'); // more than the 20 kg in stock
  assert.equal((await call(ad, 'Aqil', 'repack_start', { from_product_id: 1, to_product_id: 2, from_qty: 1 })).error, 'FORBIDDEN');
});

test('a price changed on the materials list changes the cost of the next confirmed repack', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  await call(ad, 'Jihan', 'set_repack_materials', { materials: [{ name: 'Stiker', cost: 500 }] });
  await call(ad, 'Jihan', 'set_repack', { product_id: 3, repack_from: 1, repack_qty: 0.5, materials: [{ name: 'Stiker', qty: 1 }] });
  await call(ad, 'Jihan', 'set_repack_materials', { materials: [{ name: 'Stiker', cost: 800 }] });
  assert.match(notices(db).at(-1).summary, /Stiker Rp 500 → Rp 800/);
  const st = await call(ad, 'Jihan', 'repack_start', { from_product_id: 1, to_product_id: 3, from_qty: 1 });
  const fin = await call(ad, 'Jihan', 'repack_finish', { repack_id: st.repack.repack_id, to_qty: 2, remaining_qty: 0 });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(repackRow(db, st.repack.repack_id).materials_cost, 1600);
});

test('a cashier\'s v38 request still waiting for this bulk is decided first; "Ya, ini kemas ulang baru" is named in the notice', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const pl = { to_product_id: 2, to_name: 'Kurma Ajwa Toples 1 kg', from_product_id: 1, from_name: 'Kurma Ajwa Curah', from_unit: 'kg', pack_size: 1, to_qty: 4, from_qty: 4 };
  insert(db, 'pos_approvals', { id: 1, request_id: 'APOLD38', kind: 'repack', approver_role: 'mgr_akuntan', ref: '1', client_id: 'old', cashier: 'Siti', status: 'pending', created_at: new Date().toISOString(), summary: 'Minta kemas ulang', payload: JSON.stringify(pl), total: 0 });
  const busy = await call(ad, 'Rina', 'repack_start', { client_id: 'c-p1', from_product_id: 1, to_product_id: 3, from_qty: 2 });
  assert.equal(busy.error, 'REPACK_PENDING', JSON.stringify(busy));
  assert.equal(busy.pending.request_id, 'APOLD38');
  assert.equal(stockOf(db, 1), 20);
  db.prepare("UPDATE pos_approvals SET status = 'rejected' WHERE id = 1").run();
  const a = await call(ad, 'Siti', 'repack_start', { client_id: 'c-p2', from_product_id: 1, to_product_id: 2, from_qty: 3 });
  assert.equal(a.ok, true, JSON.stringify(a));
  const r = await call(ad, 'Rina', 'repack_start', { client_id: 'c-p3', from_product_id: 1, to_product_id: 3, from_qty: 2 });
  assert.equal(r.error, 'REPACK_RECENT');
  const ok = await call(ad, 'Rina', 'repack_start', { client_id: 'c-p3', from_product_id: 1, to_product_id: 3, from_qty: 2, confirm_recent: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(notices(db).at(-1).summary, /^Mulai kemas ulang oleh kasir Rina .* — dikonfirmasi bukan kemas ulang ganda\. Setelah selesai/);
  assert.equal(stockOf(db, 1), 15);
});
