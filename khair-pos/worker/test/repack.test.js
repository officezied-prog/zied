// Repacking in the shop (bulk → small packs), on the real backend (backend/process.js through the Worker's loaders and race guards)
// on an in-memory SQLite.
// v39 (owner 2026-10-12: «طلب التعليب لا يحتاج إلى موافقات، إن شاهد العمال نقص في البضائع فعليهم أن يقوموا بالتعليب، بس يقوم بإرسال
// معلومات للمدير ولي أنا وللمحاسب حتى يتم إدخال كل المعلومات في المخزون ومراقبة المخزون»):
//   1. the cashier repacks DIRECTLY — the stock moves at once; the owner, the manager and the accountant get the full record;
//   2. no double repack (v38: «ممكن 2 كاشير يقوم بنفس الطلب والتعليب، انتبه منها»): a resend is recorded once (client id), the same bulk
//      repacked in the last 2 h asks "is this another one?" first, and two at the same second move the bulk stock once (stock_claim);
//   3. a v38 request still pending is finished by the manager / accountant as before (and blocks a second repack of that bulk).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest, _resetPosSchemaForTests } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const call = (a, action, who, data) => handleRequest(a, base(action, who[0], who[1], data), {}, KEY);
const OWNER = ['Pemilik', '1234'], SITI = ['Siti', '1111'], RINA = ['Rina', '3333'], MGR = ['Jihan', '2222'], AK = ['Aqil', '4444'];

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Rina', role: 'kasir', pin_hash: h('Rina', '3333'), active: true });
  // bulk dates 20 kg → packs of 0.5 kg and 0.25 kg
  insert(db, 'pos_products', { id: 1, sku: 'B1', name: 'Kurma Curah', unit: 'kg', cost_price: 50000, retail_price: 70000, stock: 20, shop_stock: 0, min_stock: 0, active: true, repack_from: 0, repack_qty: 0 });
  insert(db, 'pos_products', { id: 2, sku: 'P1', name: 'Kurma 500 g', unit: 'pak', cost_price: 26000, retail_price: 35000, stock: 4, shop_stock: 4, min_stock: 0, active: true, repack_from: 1, repack_qty: 0.5 });
  insert(db, 'pos_products', { id: 3, sku: 'P2', name: 'Kurma 250 g', unit: 'pak', cost_price: 13000, retail_price: 19000, stock: 0, shop_stock: 0, min_stock: 0, active: true, repack_from: 1, repack_qty: 0.25 });
  insert(db, 'pos_products', { id: 4, sku: 'X', name: 'Madu', unit: 'btl', cost_price: 40000, retail_price: 55000, stock: 10, shop_stock: 10, min_stock: 0, active: true, repack_from: 0, repack_qty: 0 });
  return db;
}
const stockOf = (a, id) => a.all('SELECT stock FROM pos_products WHERE id = ?', [id])[0].stock;
const repacks = (a) => a.all('SELECT * FROM pos_repacks ORDER BY id', []);
const approvals = (a) => a.all("SELECT * FROM pos_approvals WHERE kind = 'repack' ORDER BY id", []);
const notices = (a) => a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id", []);


const seedRequest = (db, o) => insert(db, 'pos_approvals', Object.assign({ request_id: 'APOLD1', client_id: 'old-1', created_at: new Date().toISOString(), cashier: 'Rina', kind: 'repack', ref: '1', status: 'pending', approver_role: 'mgr_akuntan',
  payload: JSON.stringify({ to_product_id: 3, from_product_id: 1, from_name: 'Kurma Curah', to_name: 'Kurma 250 g', to_qty: 8, from_qty: 2 }), summary: 'Minta kemas ulang', decided_by: '', decided_at: '', note: '', total: 0 }, o || {}));

test('v39 #1 the cashier repacks directly: stock moves at once, recorded, and the owner + manager + accountant get the full record', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const r = await call(a, 'repack', SITI, { client_id: 'c-1', to_product_id: 2, to_qty: 18, from_qty: 10, packaging_cost: 9000, exp_date: '2027-03-01', note: 'pagi' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(stockOf(a, 1), 10);
  assert.equal(stockOf(a, 2), 22);
  assert.deepEqual(r.stock.map((x) => [x.product_id, x.stock]), [[1, 10], [2, 22]]);
  assert.equal(r.repack.unit_cost, undefined); // the pack cost stays the owner's
  const rp = repacks(a);
  assert.equal(rp.length, 1);
  assert.deepEqual([rp[0].user, rp[0].to_qty, rp[0].from_qty, rp[0].yield_pct, rp[0].loss_qty, rp[0].packaging_cost, rp[0].exp_date, rp[0].client_id], ['Siti', 18, 10, 90, 1, 9000, '2027-03-01', 'c-1']);
  const pu = a.all("SELECT * FROM pos_purchases WHERE supplier = 'KEMAS ULANG' ORDER BY id", []);
  assert.deepEqual(pu.map((x) => [x.product_id, x.qty]), [[1, -10], [2, 18]]);
  // no approval at all
  assert.equal(approvals(a).length, 0);
  // ONE notice to the owner, the manager and the accountant: who, when, what, the yield and the stock before → after; low yield → warn
  const n = notices(a);
  assert.equal(n.length, 1);
  assert.equal(n[0].ref, 'owner,manager,akuntan');
  assert.equal(n[0].level, 'warn');
  assert.match(n[0].summary, /^Kemas ulang oleh kasir Siti \(.* WIB\): Kurma Curah 10 kg → Kurma 500 g x18 \(hasil 90%, susut 1 kg\) \| stok Kurma Curah 20 → 10 kg, stok Kurma 500 g 4 → 22 pak — PERHATIAN: hasil di bawah 95%$/);
  for (const who of [OWNER, MGR, AK]) {
    const bo = await call(a, 'bootstrap', who, {});
    assert.ok(bo.notifications.some((x) => /Kemas ulang oleh kasir Siti/.test(x.summary)), who[0]);
  }
  // the history (get_sales) carries it; costs only for the owner
  const gs = await call(a, 'get_sales', MGR, { from: '2000-01-01', to: '2100-01-01' });
  assert.equal(gs.repacks[0].user, 'Siti');
  assert.equal(gs.repacks[0].packaging_cost, undefined);
  const go = await call(a, 'get_sales', OWNER, { from: '2000-01-01', to: '2100-01-01' });
  assert.equal(go.repacks[0].packaging_cost, 9000);
});

test('v39 #2 the same repack sent twice (double tap / retry / offline resend) is recorded ONCE', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const d = { client_id: 'dup-1', to_product_id: 2, to_qty: 6 };
  const r1 = await call(a, 'repack', SITI, d);
  const r2 = await call(a, 'repack', SITI, d);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.duplicate, true);
  assert.equal(r2.repack.repack_id, r1.repack.repack_id);
  assert.equal(repacks(a).length, 1);
  assert.equal(notices(a).length, 1);
  assert.equal(stockOf(a, 1), 17);
  assert.equal(stockOf(a, 2), 10);
  // an old (v38) cashier app still sends request_repack: it is the same direct repack now
  const r3 = await call(a, 'request_repack', SITI, d);
  assert.equal(r3.duplicate, true);
  assert.equal(repacks(a).length, 1);
});

test('v39 #3 two cashiers, one repack: the same bulk repacked in the last 2 h asks first — recorded only when confirmed as another one', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const r1 = await call(a, 'repack', SITI, { client_id: 's-1', to_product_id: 2, to_qty: 10 });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  for (const [who, to] of [[RINA, 2], [RINA, 3], [SITI, 3], [MGR, 2]]) {
    const r2 = await call(a, 'repack', who, { client_id: 'x-' + who[0] + to, to_product_id: to, to_qty: 4 });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'REPACK_RECENT');
    assert.match(r2.message, /^Siti sudah mengemas ulang Kurma Curah 5 kg → Kurma 500 g x10 pada .* WIB \(RP/);
    assert.deepEqual([r2.recent.user, r2.recent.to_name, r2.recent.to_qty], ['Siti', 'Kurma 500 g', 10]);
  }
  assert.equal(repacks(a).length, 1);
  assert.equal(stockOf(a, 1), 15);
  // another bulk is not affected
  // Rina confirms it is another repack → recorded; the notice says it was confirmed
  const ok = await call(a, 'repack', RINA, { client_id: 'r-2', to_product_id: 3, to_qty: 8, confirm_recent: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(stockOf(a, 1), 13);
  assert.equal(stockOf(a, 3), 8);
  assert.match(notices(a).slice(-1)[0].summary, /Kemas ulang oleh kasir Rina .*dikonfirmasi bukan kemas ulang ganda/);
  // older than 2 h → no question
  a.run('UPDATE pos_repacks SET repack_time = ?', [new Date(Date.now() - 3 * 3600000).toISOString()]);
  const later = await call(a, 'repack', SITI, { client_id: 's-3', to_product_id: 2, to_qty: 2 });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(stockOf(a, 1), 12);
});

test('v39 #4 checks: too little bulk, not a pack product, roles; the manager\'s repack tells the owner + accountant, the owner\'s the manager + accountant', async () => {
  const db = seed(), a = sqliteAdapter(db);
  assert.equal((await call(a, 'repack', SITI, { client_id: 'big', to_product_id: 3, to_qty: 100 })).error, 'INVALID'); // 25 kg of 20
  assert.equal((await call(a, 'repack', SITI, { client_id: 'np', to_product_id: 4, to_qty: 1 })).error, 'INVALID'); // not a pack product
  assert.equal((await call(a, 'repack', AK, { client_id: 'ak', to_product_id: 2, to_qty: 2 })).error, 'FORBIDDEN');
  assert.equal(stockOf(a, 1), 20);
  const m = await call(a, 'repack', MGR, { client_id: 'm-1', to_product_id: 2, to_qty: 10, from_qty: 5 });
  assert.equal(m.ok, true, JSON.stringify(m));
  let n = notices(a);
  assert.equal(n.length, 1);
  assert.equal(n[0].ref, 'owner,akuntan');
  assert.equal(n[0].level, 'info');
  assert.match(n[0].summary, /^Kemas ulang oleh manajer Jihan .*Kurma Curah 5 kg → Kurma 500 g x10 \(hasil 100%/);
  const o = await call(a, 'repack', OWNER, { client_id: 'o-1', to_product_id: 3, to_qty: 4, confirm_recent: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  n = notices(a);
  assert.equal(n[1].ref, 'manager,akuntan');
  assert.match(n[1].summary, /^Kemas ulang oleh pemilik Pemilik/);
  assert.equal(stockOf(a, 1), 14);
});

test('v39 #5 at the same second: two cashiers repack the same bulk → the bulk stock moves once, the second is shown the first', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const [x, y] = await Promise.all([
    call(a, 'repack', SITI, { client_id: 'race-s', to_product_id: 2, to_qty: 6 }),
    call(a, 'repack', RINA, { client_id: 'race-r', to_product_id: 3, to_qty: 8 }),
  ]);
  const oks = [x, y].filter((r) => r.ok), refused = [x, y].filter((r) => !r.ok);
  assert.equal(oks.length, 1, JSON.stringify([x, y]));
  assert.equal(refused[0].error, 'REPACK_RECENT');
  assert.equal(repacks(a).length, 1);
  assert.equal(notices(a).length, 1);
  assert.equal(stockOf(a, 1), oks[0] === x ? 17 : 18);
});

test('v39 #6 the stock claim on the database itself: a repack written between load and write wins; nothing of the second is written', async () => {
  const db = seed(), a0 = sqliteAdapter(db);
  let injected = false;
  const a = { all: a0.all, run(sql, params) {
    if (!injected && /^UPDATE pos_products SET stock = \? WHERE id = \? AND stock = \?/.test(sql)) {
      injected = true; // Rina's repack lands after this request loaded its rows, just before it writes
      a0.run('UPDATE pos_products SET stock = 18 WHERE id = 1', []);
      insert(db, 'pos_repacks', { repack_id: 'RPRINA', repack_date: '2026-10-12', repack_time: new Date().toISOString(), user: 'Rina', from_product_id: 1, from_name: 'Kurma Curah', from_unit: 'kg', from_qty: 2, to_product_id: 3, to_name: 'Kurma 250 g', to_unit: 'pak', to_qty: 8 });
    }
    return a0.run(sql, params);
  } };
  const r = await call(a, 'repack', SITI, { client_id: 'g-1', to_product_id: 2, to_qty: 2 });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'REPACK_RECENT');
  assert.match(r.message, /^Rina baru saja mengemas ulang Kurma Curah 2 kg → Kurma 250 g x8/);
  assert.equal(stockOf(a0, 1), 18);
  assert.equal(stockOf(a0, 2), 4);
  assert.equal(repacks(a0).length, 1);
  assert.equal(notices(a0).length, 0);
  // a stock change without a repack (a sale) → "the stock just changed, check and save again"
  injected = false;
  a0.run("UPDATE pos_repacks SET repack_time = '2000-01-01T00:00:00Z'", []);
  const b = { all: a0.all, run(sql, params) {
    if (!injected && /^UPDATE pos_products SET stock = \? WHERE id = \? AND stock = \?/.test(sql)) { injected = true; a0.run('UPDATE pos_products SET stock = 17 WHERE id = 1', []); }
    return a0.run(sql, params);
  } };
  const r2 = await call(b, 'repack', SITI, { client_id: 'g-2', to_product_id: 2, to_qty: 2 });
  assert.equal(r2.error, 'STOCK_CHANGED', JSON.stringify(r2));
  assert.equal(stockOf(a0, 1), 17);
  // a write that fails after the claim puts the bulk stock back
  const c = { all: a0.all, run(sql, params) { if (/^INSERT INTO pos_purchases/.test(sql)) throw new Error('disk'); return a0.run(sql, params); } };
  await assert.rejects(call(c, 'repack', SITI, { client_id: 'g-3', to_product_id: 2, to_qty: 2 }));
  assert.equal(stockOf(a0, 1), 17);
});

test('v39 #7 a v38 request still pending: it blocks a second repack of that bulk and the manager / accountant finish it as before', async () => {
  const db = seed(), a = sqliteAdapter(db);
  seedRequest(db);
  const busy = await call(a, 'repack', SITI, { client_id: 'p-1', to_product_id: 2, to_qty: 2 });
  assert.equal(busy.error, 'REPACK_PENDING');
  assert.equal(busy.pending.cashier, 'Rina');
  const d = await call(a, 'decide_approval', AK, { request_id: 'APOLD1', decision: 'approved' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(stockOf(a, 1), 18);
  assert.equal(stockOf(a, 3), 8);
  assert.equal(repacks(a)[0].approved_by, 'Aqil');
  const free = await call(a, 'repack', SITI, { client_id: 'p-2', to_product_id: 2, to_qty: 2, confirm_recent: true });
  assert.equal(free.ok, true, JSON.stringify(free));
  assert.equal(stockOf(a, 1), 17);
});

test('v38 the decide claim: an approval decided by someone else between load and write is not applied twice; a failed write puts it back', async () => {
  const db = seed(), a0 = sqliteAdapter(db);
  seedRequest(db, { request_id: 'APRINA1' });
  // the 'decide' claim: another approver decided between this one's load and write → nothing is applied twice
  let raced = false;
  const b = { all: a0.all, run(sql, params) {
    if (!raced && /SET status = 'deciding'/.test(sql)) { raced = true; a0.run("UPDATE pos_approvals SET status = 'approved', decided_by = 'Aqil' WHERE request_id = ?", [params[0]]); }
    return a0.run(sql, params);
  } };
  const d = await call(b, 'decide_approval', MGR, { request_id: 'APRINA1', decision: 'approved', to_qty: 8 });
  assert.equal(d.ok, false, JSON.stringify(d));
  assert.match(d.message, /sudah diputuskan oleh Aqil/);
  assert.equal(stockOf(a0, 1), 20);
  assert.equal(repacks(a0).length, 0);
  // a write that fails right after the claim (nothing written yet) puts the request back to pending — never stuck in 'deciding'
  insert(db, 'pos_approvals', { request_id: 'APSITI2', client_id: 'c2', created_at: new Date().toISOString(), cashier: 'Siti', kind: 'repack', ref: '9', status: 'pending', approver_role: 'mgr_akuntan',
    payload: JSON.stringify({ to_product_id: 2, from_product_id: 1, to_qty: 2, from_qty: 1, from_name: 'Kurma Curah', to_name: 'Kurma 500 g' }), summary: 's', decided_by: '', decided_at: '', note: '', total: 0 });
  const c = { all: a0.all, run(sql, params) { if (/^INSERT INTO pos_purchases/.test(sql)) throw new Error('disk'); return a0.run(sql, params); } };
  await assert.rejects(call(c, 'decide_approval', MGR, { request_id: 'APSITI2', decision: 'approved' }));
  assert.equal(a0.all("SELECT status FROM pos_approvals WHERE request_id = 'APSITI2'", [])[0].status, 'pending');
});


test('v39 self-migration adds the repack columns (v38 request columns + v39 client id) to an older D1', async () => {
  const db = seed();
  for (const c of ['requested_by', 'approved_by', 'request_id', 'client_id']) db.exec('ALTER TABLE pos_repacks DROP COLUMN ' + c);
  _resetPosSchemaForTests();
  const a = sqliteAdapter(db);
  const r = await call(a, 'repack', SITI, { client_id: 'mig-1', to_product_id: 2, to_qty: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(['requested_by', 'approved_by', 'request_id', 'client_id'].every((c) => a.all('PRAGMA table_info(pos_repacks)', []).some((x) => x.name === c)));
  assert.equal(repacks(a)[0].client_id, 'mig-1');
  assert.equal((await call(a, 'repack', SITI, { client_id: 'mig-1', to_product_id: 2, to_qty: 2 })).duplicate, true);
});
