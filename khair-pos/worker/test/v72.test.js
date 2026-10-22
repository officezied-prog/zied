// v72 (owner 2026-10-22) on the real backend (backend/process.js + shared/measure.js through the Worker) on an in-memory SQLite:
//  1. «هناك خطاء في العملية الحسابية» — "Garam Himalaya 1 kg" from "Garam Himalaya 25 Kg" counted in karung had been set up as 1 karung
//     a pack, so 2 karung planned 2 packs instead of 50. The content must match the sizes in the two names (KMeasure); a wrong
//     set-up cannot start a repack; a repack started before the fix is confirmed with the right content; 1/18 stays exact.
//  2. «في تطبيق الكاشير لا توجد سجل اليومي للعمليات المالية المنجزة» — a cashier reads his OWN payments and expenses (nobody else's).
//  3. «كل السجل لا يمحى» — a drawer keeps every move (it kept the last 100).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KM = new Function(readFileSync(new URL('../../shared/measure.js', import.meta.url), 'utf8') + '\nreturn KMeasure;')();
const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Rina: '3333' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Rina', role: 'kasir', pin_hash: h('Rina', '3333'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'G25', name: 'Garam Himalaya 25 Kg', category: 'Garam', unit: 'karung', cost_price: 500000, retail_price: 0, stock: 12, shop_stock: 0, active: true });
  // the owner's screenshot: set up as 1 karung a pack
  insert(db, 'pos_products', { id: 2, sku: 'G1', name: 'Garam Himalaya 1 kg', category: 'Garam', unit: 'pcs', cost_price: 0, retail_price: 30000, stock: 0, shop_stock: 0, active: true, repack_from: 1, repack_qty: 1 });
  insert(db, 'pos_products', { id: 3, sku: 'M18', name: 'Minyak Goreng 18 L', category: 'Minyak', unit: 'jerigen', cost_price: 360000, retail_price: 0, stock: 100, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 4, sku: 'M1', name: 'Minyak Goreng 1 L', category: 'Minyak', unit: 'btl', cost_price: 0, retail_price: 24000, stock: 0, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 5, sku: 'K1', name: 'Kurma Curah', category: 'Kurma', unit: 'dus', cost_price: 100000, retail_price: 0, stock: 10, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 6, sku: 'K2', name: 'Kurma Pak Kecil', category: 'Kurma', unit: 'pak', cost_price: 0, retail_price: 15000, stock: 0, shop_stock: 0, active: true, repack_from: 5, repack_qty: 0.1 });
  return db;
}
const prod = (db, id) => ({ ...db.prepare('SELECT stock, repack_qty FROM pos_products WHERE id = ?').get(id) });

test('KMeasure: the sizes written in names (kg, g, gr, ons, L, ml, ½, 1/2, 1.000 gr, "10 x 500 g"); unclear names say nothing', () => {
  const q = (n, u) => { const m = KM.of(n, u); return m ? m.d + m.q : null; };
  assert.equal(q('Garam Himalaya 25 Kg', 'karung'), 'w25000');
  assert.equal(q('Garam Himalaya 1 kg', 'pcs'), 'w1000');
  assert.equal(q('Gula 1/2 kg', 'pcs'), 'w500');
  assert.equal(q('Lada ½ kg', 'pcs'), 'w500');
  assert.equal(q('Tepung 1.000 gr', 'pcs'), 'w1000');
  assert.equal(q('Kacang 2 ons', 'pcs'), 'w200');
  assert.equal(q('Kurma 10 x 500 g', 'dus'), 'w5000');
  assert.equal(q('Minyak 1,5 L', 'btl'), 'v1500');
  assert.equal(q('Susu 250ml', 'pcs'), 'v250');
  assert.equal(q('Beras 25 kg', 'kg'), 'w1000'); // counted in kg: one unit is 1 kg
  assert.equal(q('Garam', 'karung 50kg'), 'w50000');
  for (const n of ['Kopi 200g (isi 10 sachet 20g)', 'Kertas A4', 'Cuka 5 lusin', 'Kurma Pak Kecil', 'Kurma Ajwa 1 kg (isi 10)', 'Teh 20 pcs 2 g', 'Kurma @5 kg']) assert.equal(q(n, 'pcs'), null, n); // a count beside the size: unclear
  const B = { name: 'Garam Himalaya 25 Kg', unit: 'karung' }, P = { name: 'Garam Himalaya 1 kg', unit: 'pcs' };
  assert.equal(KM.size(B, P), 0.04);
  assert.equal(KM.fits(1, 0.04), false);
  assert.deepEqual(KM.input('1 kg', B), { size: 0.04, typed: '1 kg' });
  assert.deepEqual(KM.input('0,04', B), { size: 0.04, typed: '' });
  assert.equal(KM.input('500 ml', B).error, 'dim');
  assert.equal(KM.input('1 kg', { name: 'Garam', unit: 'karung' }).error, 'bulk');
  assert.equal(KM.packs(2, 0.04), 50);
  assert.equal(KM.packs(100, KM.round(1 / 18)), 1800); // 1/18 kept exact: not 1799
});

test('the screenshot: 1 kg packs set up as 1 karung — refused to start; the manager fixes it ("1 kg" = 0.04 karung); 2 karung → 50 packs', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const st = await call(ad, 'Siti', 'repack_start', { from_product_id: 1, to_product_id: 2, from_qty: 2 });
  assert.equal(st.error, 'SIZE_MISMATCH');
  assert.equal(st.want, 0.04);
  assert.match(st.message, /tercatat 1 karung per pcs, seharusnya Garam Himalaya 1 kg \(1 kg\) dari Garam Himalaya 25 Kg \(25 kg per karung\) = 0\.04 karung per pcs\. Manajer memperbaikinya dulu/);
  assert.equal(prod(db, 1).stock, 12); // nothing left the stock
  // the manager types 1 again: refused with the right number
  const bad = await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 1 });
  assert.equal(bad.error, 'SIZE_MISMATCH');
  assert.match(bad.message, /Tulis 1 kg \(atau 0\.04\)/);
  const ok = await call(ad, 'Jihan', 'set_repack', { product_id: 2, repack_from: 1, repack_qty: 0.04 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const n = db.prepare("SELECT summary FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id DESC").get().summary;
  assert.match(n, /Garam Himalaya 25 Kg, 0\.04 karung \(1 kg\) per pcs \(sebelumnya Garam Himalaya 25 Kg, 1 karung per pcs\)/);
  const r = await call(ad, 'Siti', 'repack_start', { from_product_id: 1, to_product_id: 2, from_qty: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.repack.planned_qty, 50);
  assert.equal(prod(db, 1).stock, 10);
  const f = await call(ad, 'Jihan', 'repack_finish', { repack_id: r.repack.repack_id, to_qty: 50, remaining_qty: 0 });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.equal(prod(db, 2).stock, 50);
  assert.equal(f.repack.yield_pct, 100);
});

test('a repack started with the wrong content before this fix is confirmed with the right one (50 packs, not "more than the bulk")', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  insert(db, 'pos_repacks', { repack_id: 'RPOLD1', repack_date: today(), repack_time: new Date().toISOString(), user: 'Siti', status: 'proses', from_product_id: 1, from_name: 'Garam Himalaya 25 Kg', from_unit: 'karung', from_qty: 2,
    to_product_id: 2, to_name: 'Garam Himalaya 1 kg', to_unit: 'pcs', to_qty: 0, pack_size: 1, expected_qty: 2, planned_qty: 2, planned_from_qty: 2, bulk_cost: 500000, started_by: 'Siti', started_at: new Date().toISOString() });
  const f = await call(ad, 'Jihan', 'repack_finish', { repack_id: 'RPOLD1', to_qty: 50, remaining_qty: 0 });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.equal(f.repack.pack_size, 0.04);
  assert.equal(f.repack.yield_pct, 100);
  assert.equal(prod(db, 2).stock, 50);
});

test('a size the names do not tell is not checked; "1 L" bottles from an 18 L jerigen: exact, 1 jerigen = 18 bottles', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  assert.equal((await call(ad, 'Siti', 'repack_start', { from_product_id: 5, to_product_id: 6, from_qty: 1 })).repack.planned_qty, 10);
  const s = await call(ad, 'Jihan', 'set_repack', { product_id: 4, repack_from: 3, repack_qty: KM.input('1 L', { name: 'Minyak Goreng 18 L', unit: 'jerigen' }).size });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(prod(db, 4).repack_qty, KM.round(1 / 18));
  const r = await call(ad, 'Siti', 'repack_start', { from_product_id: 3, to_product_id: 4, from_qty: 1 });
  assert.equal(r.repack.planned_qty, 18);
  // the product form (save_product) checks the same
  const p = await call(ad, 'Pemilik', 'save_product', { id: 4, sku: 'M1', name: 'Minyak Goreng 1 L', category: 'Minyak', unit: 'btl', retail_price: 24000, repack_from: 3, repack_qty: 1 });
  assert.equal(p.error, 'SIZE_MISMATCH');
});

test('the cashier\'s day: his own payments and expenses reach his app, nobody else\'s', async () => {
  const db = seed(), ad = sqliteAdapter(db), d = today();
  insert(db, 'pos_payments', { pay_id: 'PY1', pay_date: d, customer_id: 1, customer_name: 'Toko A', amount: 50000, method: 'tunai', cashier: 'Siti', direction: 'in' });
  insert(db, 'pos_payments', { pay_id: 'PY2', pay_date: d, customer_id: 2, customer_name: 'Toko B', amount: 70000, method: 'transfer', cashier: 'Rina', direction: 'in' });
  insert(db, 'pos_payments', { pay_id: 'PY3', pay_date: d, supplier: 'PT Gaji', amount: 3000000, method: 'transfer', cashier: 'Jihan', direction: 'out' });
  insert(db, 'pos_expenses', { expense_date: d, category: 'Bensin', amount: 20000, note: 'antar', user: 'Siti', paid_from: 'laci' });
  insert(db, 'pos_expenses', { expense_date: d, category: 'Gaji', amount: 2500000, note: 'gaji', user: 'Jihan' });
  const r = await call(ad, 'Siti', 'get_sales', { from: d, to: d });
  assert.deepEqual(r.payments.map((x) => x.pay_id), ['PY1']);
  assert.deepEqual(r.expenses.map((x) => x.category), ['Bensin']);
  const m = await call(ad, 'Jihan', 'get_sales', { from: d, to: d });
  assert.equal(m.payments.length, 3);
  assert.equal(m.expenses.length, 2);
});

test('a drawer keeps every move (no longer only the last 100)', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const moves = Array.from({ length: 100 }, (_, i) => ({ t: new Date(Date.now() - (100 - i) * 60000).toISOString(), type: 'in', amount: 1000, note: 'm' + i, by: 'Siti' }));
  insert(db, 'pos_shifts', { shift_id: 'SH1', cashier: 'Siti', shift_date: today(), opened_at: new Date().toISOString(), status: 'open', opening_cash: 100000, cash_in: 100000, moves: JSON.stringify(moves) });
  const r = await call(ad, 'Siti', 'cash_move', { type: 'out', amount: 5000, note: 'plastik' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const kept = JSON.parse(db.prepare("SELECT moves FROM pos_shifts WHERE shift_id = 'SH1'").get().moves);
  assert.equal(kept.length, 101);
  assert.equal(kept[0].note, 'm0');
  assert.equal(kept[100].note, 'plastik');
});
