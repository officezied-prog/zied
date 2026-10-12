// v40 (owner 2026-10-12): the cashier's stock count goes to the MANAGER, who approves the whole table at once; the owner is
// told when it is sent and when it is decided; a second count by the same cashier joins the table still waiting. The manager's
// own count and single-product fixes apply at once — the owner only gets a notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'A', name: 'Kurma Ajwa', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, shop_stock: 20, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'B', name: 'Kismis', unit: 'pcs', cost_price: 20000, retail_price: 25000, stock: 50, shop_stock: 50, active: true });
  insert(db, 'pos_products', { id: 3, sku: 'C', name: 'Madu', unit: 'btl', cost_price: 60000, retail_price: 80000, stock: 10, shop_stock: 10, active: true });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SH1', cashier: 'Siti', status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const notices = (db) => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();

test('cashier count → one manager approval for the whole table; a second count merges into it; the owner is told twice', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r1 = await call(ad, 'Siti', 'stock_count', { counts: [{ product_id: 1, counted: 18 }, { product_id: 2, counted: 50 }], note: 'rak depan' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.applied, false);
  const ap = () => db.prepare("SELECT * FROM pos_approvals WHERE kind = 'opname'").all();
  assert.equal(ap().length, 1);
  assert.equal(ap()[0].approver_role, 'manager');
  assert.match(notices(db).at(-1).summary, /Stok opname dari Siti: 2 barang, 1 selisih — menunggu persetujuan manajer/);
  assert.equal(notices(db).at(-1).ref, 'owner');
  // the same cashier counts more (and Kurma again): still ONE approval, the newer Kurma count wins
  const r2 = await call(ad, 'Siti', 'stock_count', { counts: [{ product_id: 1, counted: 17 }, { product_id: 3, counted: 12 }] });
  assert.equal(r2.merged, true);
  assert.equal(r2.request_id, r1.request_id);
  assert.equal(ap().length, 1);
  const lines = JSON.parse(ap()[0].payload).lines;
  assert.deepEqual(lines.map((l) => [l.product_id, l.counted]).sort(), [[1, 17], [2, 50], [3, 12]]);
  assert.match(ap()[0].summary, /3 barang, 2 selisih/);
  assert.equal(notices(db).length, 1); // no second "sent" notice for a merge
  // the manager sees it and may decide it; one tap applies every line
  const inbox = await call(ad, 'Jihan', 'list_approvals', {});
  const card = inbox.approvals.find((a) => a.request_id === r1.request_id);
  assert.equal(card.approver_role, 'manager');
  const d = await call(ad, 'Jihan', 'decide_approval', { request_id: r1.request_id, decision: 'approved' });
  assert.equal(d.ok, true, JSON.stringify(d));
  const st = (id) => db.prepare('SELECT stock FROM pos_products WHERE id = ?').get(id).stock;
  assert.deepEqual([st(1), st(2), st(3)], [17, 50, 12]);
  assert.match(notices(db).at(-1).summary, /Stok opname Siti DISETUJUI oleh Jihan: 3 barang, 2 selisih \(nilai modal -Rp 330\.000\)/); // -3 kg ×150.000 + 2 ×60.000 = -330.000
  assert.equal(notices(db).at(-1).ref, 'owner');
});

// owner 2026-10-12: «المدير هو من يقوم بالتغيير ويصل مجرد إعلام فقط للمالك»
test('the manager changes stock himself (own count, single-product fix) — the owner only gets a notice; a rejection is told too', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const st = (id) => db.prepare('SELECT stock FROM pos_products WHERE id = ?').get(id).stock;
  const r = await call(ad, 'Jihan', 'stock_count', { counts: [{ product_id: 2, counted: 48 }, { product_id: 3, counted: 10 }] });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(st(2), 48);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pos_approvals WHERE kind = 'opname'").get().c, 0); // no approval at all
  assert.match(notices(db).at(-1).summary, /Stok opname oleh manajer Jihan langsung diterapkan: 2 barang, 1 selisih \(nilai modal -Rp 40\.000\): Kismis 50→48/);
  assert.equal(notices(db).at(-1).ref, 'owner');
  // a single product's stock fixed by the manager (was owner-only) → applied, the owner is told with the value
  const adj = await call(ad, 'Jihan', 'stock_adjust', { product_id: 1, new_stock: 22, reason: 'salah hitung' });
  assert.equal(adj.ok, true, JSON.stringify(adj));
  assert.equal(st(1), 22);
  assert.match(notices(db).at(-1).summary, /Stok Kurma Ajwa diubah oleh manajer Jihan: 20→22 \(nilai modal \+Rp 300\.000\) \| salah hitung/);
  assert.equal(db.prepare("SELECT qty FROM pos_purchases WHERE supplier = 'PENYESUAIAN STOK'").get().qty, 2);
  // the cashier still may not fix stock directly
  assert.equal((await call(ad, 'Siti', 'stock_adjust', { product_id: 1, new_stock: 0, reason: 'x' })).error, 'FORBIDDEN');
  // the cashier's count rejected by the manager → the owner hears about it
  const c = await call(ad, 'Siti', 'stock_count', { counts: [{ product_id: 3, counted: 9 }] });
  const rej = await call(ad, 'Jihan', 'decide_approval', { request_id: c.request_id, decision: 'rejected' });
  assert.equal(rej.ok, true);
  assert.match(notices(db).at(-1).summary, /Stok opname Siti DITOLAK oleh Jihan: 1 barang, 1 selisih/);
  assert.equal(st(3), 10); // nothing changed
  // the owner's own count and fix: applied at once, no notice to himself
  const n0 = notices(db).length;
  const o = await call(ad, 'Pemilik', 'stock_count', { counts: [{ product_id: 1, counted: 19 }] });
  assert.equal(o.applied, true);
  await call(ad, 'Pemilik', 'stock_adjust', { product_id: 2, new_stock: 47, reason: 'rusak' });
  assert.equal(notices(db).length, n0);
});

// v40: the cashier's table holds the whole store (~1,900 products) — one send, one approval, one tap for the manager,
// within the free plan's 50 D1 calls; more than 2000 lines is refused (never cut silently); a full table starts a new one.
test('a whole-store count (1,900 products) is one table the manager approves in one tap, inside the free-plan limit', async () => {
  const { d1Mock } = await import('./shim.js');
  const { default: worker } = await import('../src/index.js');
  const db = seed();
  for (let i = 4; i <= 1900; i++) insert(db, 'pos_products', { id: i, sku: 'P' + i, name: 'Produk ' + i, unit: 'pcs', cost_price: 1000, retail_price: 1500, stock: 10, shop_stock: 10, active: true });
  const env = { DB: d1Mock(db, { maxCalls: 50 }), STORE_KEY: KEY };
  const post = async (user, action, data) => { env.DB.calls = 0; const r = await worker.fetch(new Request('https://w.test/webhook/khair-pos', { method: 'POST', body: JSON.stringify({ action, key: KEY, user, pin_hash: h(user, PIN[user]), data }) }), env); return { body: await r.json(), calls: env.DB.calls }; };
  await post('Siti', 'bootstrap', {});
  const counts = Array.from({ length: 1900 }, (_, i) => ({ product_id: i + 1, counted: i + 1 > 3 ? (i % 10 === 0 ? 9 : 10) : 1 }));
  const s = await post('Siti', 'stock_count', { counts });
  assert.equal(s.body.ok, true, JSON.stringify(s.body).slice(0, 200));
  const ap = db.prepare("SELECT * FROM pos_approvals WHERE kind = 'opname' AND status = 'pending'").all();
  assert.equal(ap.length, 1);
  assert.equal(JSON.parse(ap[0].payload).lines.length, 1900);
  const d = await post('Jihan', 'decide_approval', { request_id: ap[0].request_id, decision: 'approved' });
  assert.equal(d.body.ok, true, JSON.stringify(d.body).slice(0, 200));
  assert.ok(d.calls <= 8, 'D1 calls: ' + d.calls);
  assert.equal(db.prepare('SELECT stock FROM pos_products WHERE id = 11').get().stock, 9);
  assert.equal(db.prepare('SELECT stock FROM pos_products WHERE id = 12').get().stock, 10);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pos_purchases WHERE supplier = 'STOK OPNAME'").get().c, 3 + 189); // only the differences are booked (ids 11, 21 … 1891)
  // more than 2000 lines at once: refused with a clear error, nothing written
  const big = await post('Siti', 'stock_count', { counts: Array.from({ length: 2001 }, (_, i) => ({ product_id: (i % 1900) + 1, counted: 1 })) });
  assert.equal(big.body.ok, false);
  assert.match(big.body.message || big.body.error_message || JSON.stringify(big.body), /2000/);
});

test('a pending table that would pass 2000 lines is not cut: the new count starts its own table', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  for (let i = 4; i <= 2100; i++) insert(db, 'pos_products', { id: i, sku: 'P' + i, name: 'Produk ' + i, unit: 'pcs', cost_price: 1000, retail_price: 1500, stock: 10, shop_stock: 10, active: true });
  const a = await call(ad, 'Siti', 'stock_count', { counts: Array.from({ length: 1500 }, (_, i) => ({ product_id: i + 1, counted: 10 })) });
  const b = await call(ad, 'Siti', 'stock_count', { counts: Array.from({ length: 600 }, (_, i) => ({ product_id: 1501 + i, counted: 10 })) });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(b.request_id, a.request_id);
  assert.equal(b.merged, undefined);
  const rows = db.prepare("SELECT payload FROM pos_approvals WHERE kind = 'opname' AND status = 'pending' ORDER BY id").all().map((r) => JSON.parse(r.payload).lines.length);
  assert.deepEqual(rows, [1500, 600]);
});
