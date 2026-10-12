// v38 (owner 2026-10-12: «المالك يصله إشعار فقط، والمدير والمحاسب يوافق على الكمية والعملية كلها، والكاشير هو الذي يطلب القيام بها، لكن
// يجب التأكد: ممكن 2 كاشير يقوم بنفس الطلب والتعليب، انتبه منها») — the real backend (backend/process.js through the Worker's loaders and
// race guards) on an in-memory SQLite:
//   1. a cashier REQUESTS a repack (nothing moves); the manager OR the accountant approves (may correct the quantities) or rejects;
//      the owner only gets notices (request + decision, yield < 95 % flagged);
//   2. no double repack: one pending request per bulk product (anyone else is told who asked and when), the client id makes a resend
//      return the same request, the bulk stock is checked again at approval, a request pending 24 h can be cancelled;
//      two cashiers / two approvers at the same moment: only one wins (the guards in src/core.js).
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

test('v38 #1 cashier requests → nothing moves; the manager corrects and approves → stock moves, who asked / approved recorded, owner told', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const r = await call(a, 'request_repack', SITI, { client_id: 'c-1', to_product_id: 2, to_qty: 18, from_qty: 10, packaging_cost: 9000, exp_date: '2027-03-01', note: 'pagi' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.approval.kind, 'repack');
  assert.equal(r.approval.approver_role, 'mgr_akuntan');
  assert.equal(r.approval.status, 'pending');
  const pl = JSON.parse(r.approval.payload);
  assert.deepEqual([pl.from_name, pl.to_name, pl.to_qty, pl.from_qty, pl.expected_qty, pl.yield_pct, pl.loss_qty, pl.bulk_stock], ['Kurma Curah', 'Kurma 500 g', 18, 10, 20, 90, 1, 20]);
  // nothing moved yet
  assert.equal(stockOf(a, 1), 20);
  assert.equal(stockOf(a, 2), 4);
  assert.equal(repacks(a).length, 0);
  // ONE notice for the request: owner (told) + manager + accountant (they decide); low yield → warn
  const n1 = notices(a);
  assert.equal(n1.length, 1);
  assert.equal(n1[0].ref, 'owner,manager,akuntan');
  assert.equal(n1[0].level, 'warn');
  assert.match(n1[0].summary, /Permintaan kemas ulang oleh Siti/);
  assert.match(n1[0].summary, /Kurma Curah 10 kg → Kurma 500 g x18 \(hasil 90%, susut 1 kg\)/);
  const bo = await call(a, 'bootstrap', OWNER, {});
  assert.ok(bo.notifications.some((n) => /Permintaan kemas ulang oleh Siti/.test(n.summary)));
  // the manager and the accountant see it and may decide; the owner sees it too (he may, but only gets notices)
  const lm = await call(a, 'list_approvals', MGR, {});
  assert.equal(lm.approvals.find((x) => x.request_id === r.request_id).can_decide, true);
  const la = await call(a, 'list_approvals', AK, {});
  assert.equal(la.approvals.find((x) => x.request_id === r.request_id).can_decide, true);
  // the manager corrects: 19 packs from 10 kg
  const d = await call(a, 'decide_approval', MGR, { request_id: r.request_id, decision: 'approved', to_qty: 19, from_qty: 10 });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(stockOf(a, 1), 10);
  assert.equal(stockOf(a, 2), 23);
  const rp = repacks(a);
  assert.equal(rp.length, 1);
  assert.equal(rp[0].requested_by, 'Siti');
  assert.equal(rp[0].approved_by, 'Jihan');
  assert.equal(rp[0].request_id, r.request_id);
  assert.equal(rp[0].user, 'Siti');
  assert.equal(rp[0].to_qty, 19);
  assert.equal(rp[0].yield_pct, 95);
  assert.equal(rp[0].packaging_cost, 9000);
  assert.equal(rp[0].exp_date, '2027-03-01');
  assert.equal(d.repack.unit_cost, undefined); // the pack cost stays the owner's
  const ap = approvals(a)[0];
  assert.equal(ap.status, 'approved');
  assert.equal(ap.decided_by, 'Jihan');
  assert.deepEqual(JSON.parse(ap.payload).final, { to_qty: 19, from_qty: 10, expected_qty: 20, yield_pct: 95, loss_qty: 0.5, repack_id: rp[0].repack_id, corrected: true });
  // the KEMAS ULANG stock rows name who asked and who approved
  const pu = a.all("SELECT * FROM pos_purchases WHERE supplier = 'KEMAS ULANG' ORDER BY id", []);
  assert.deepEqual(pu.map((x) => [x.product_id, x.qty]), [[1, -10], [2, 19]]);
  assert.match(pu[0].note, /diminta Siti, disetujui Jihan/);
  // ONE decision notice: owner + the other approver (the accountant); 95 % is not below 95 → info
  const n2 = notices(a).slice(1);
  assert.equal(n2.length, 1);
  assert.equal(n2[0].ref, 'owner,akuntan');
  assert.equal(n2[0].level, 'info');
  assert.match(n2[0].summary, /Kemas ulang DISETUJUI oleh Jihan \(diminta Siti .* WIB\): Kurma Curah 10 kg → Kurma 500 g x19 \(hasil 95%, susut 0.5 kg\) — dikoreksi dari 10 kg → x18/);
  assert.equal(a.all("SELECT * FROM pos_activity WHERE kind = 'keputusan'", []).length, 0);
  // the cashier sees the decision and who made it
  const ck = await call(a, 'check_approval', SITI, { request_id: r.request_id });
  assert.equal(ck.approval.status, 'approved');
  assert.equal(ck.approval.decided_by, 'Jihan');
  // the accountant a moment later: already decided, by whom
  const late = await call(a, 'decide_approval', AK, { request_id: r.request_id, decision: 'approved' });
  assert.equal(late.ok, false);
  assert.match(late.message, /oleh Jihan/);
  assert.equal(stockOf(a, 1), 10);
  // the history (get_sales) carries requested_by / approved_by; costs only for the owner
  const gs = await call(a, 'get_sales', MGR, { from: '2000-01-01', to: '2100-01-01' });
  assert.equal(gs.repacks[0].requested_by, 'Siti');
  assert.equal(gs.repacks[0].approved_by, 'Jihan');
  assert.equal(gs.repacks[0].packaging_cost, undefined);
});

test('v38 #2 two cashiers on the same bulk product: the second is refused with who asked and when — also for another pack of the same bulk', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const r1 = await call(a, 'request_repack', SITI, { client_id: 's-1', to_product_id: 2, to_qty: 10 });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  for (const [who, to] of [[RINA, 2], [RINA, 3], [SITI, 3]]) {
    const r2 = await call(a, 'request_repack', who, { client_id: 'x-' + who[0] + to, to_product_id: to, to_qty: 4 });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'REPACK_PENDING');
    assert.match(r2.message, /Sudah ada permintaan kemas ulang Kurma Curah oleh Siti \(.* WIB, AP/);
    assert.equal(r2.pending.cashier, 'Siti');
    assert.equal(r2.pending.request_id, r1.request_id);
    assert.equal(r2.pending.stale, false);
  }
  assert.equal(approvals(a).length, 1);
  // the manager / owner cannot repack the same bulk directly meanwhile (it would be done twice)
  const dm = await call(a, 'repack', MGR, { to_product_id: 3, to_qty: 4 });
  assert.equal(dm.error, 'REPACK_PENDING');
  const dow = await call(a, 'repack', OWNER, { to_product_id: 2, to_qty: 1 });
  assert.equal(dow.error, 'REPACK_PENDING');
  assert.equal(stockOf(a, 1), 20);
  // after the decision the bulk is free again
  const rj = await call(a, 'decide_approval', AK, { request_id: r1.request_id, decision: 'rejected', note: 'belum perlu' });
  assert.equal(rj.ok, true, JSON.stringify(rj));
  assert.equal(stockOf(a, 1), 20);
  assert.equal(repacks(a).length, 0);
  const n = notices(a).slice(-1)[0];
  assert.equal(n.ref, 'owner,manager');
  assert.match(n.summary, /Kemas ulang DITOLAK oleh Aqil .*belum perlu — stok tidak berubah/);
  const ck = await call(a, 'check_approval', SITI, { request_id: r1.request_id });
  assert.deepEqual([ck.approval.status, ck.approval.decided_by], ['rejected', 'Aqil']);
  const r3 = await call(a, 'request_repack', RINA, { client_id: 'r-2', to_product_id: 3, to_qty: 8 });
  assert.equal(r3.ok, true, JSON.stringify(r3));
});

test('v38 #3 the same request sent twice (double tap / retry / offline resend) is ONE request — before and after the decision', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const d = { client_id: 'dup-1', to_product_id: 2, to_qty: 6 };
  const r1 = await call(a, 'request_repack', SITI, d);
  const r2 = await call(a, 'request_repack', SITI, d);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.duplicate, true);
  assert.equal(r2.request_id, r1.request_id);
  assert.equal(approvals(a).length, 1);
  assert.equal(notices(a).length, 1);
  await call(a, 'decide_approval', MGR, { request_id: r1.request_id, decision: 'approved' });
  const r3 = await call(a, 'request_repack', SITI, d);
  assert.equal(r3.ok, true);
  assert.equal(r3.duplicate, true);
  assert.equal(r3.approval.status, 'approved');
  assert.equal(approvals(a).length, 1);
  assert.equal(repacks(a).length, 1);
  assert.equal(stockOf(a, 1), 17);
  // a request without a client id is refused
  assert.equal((await call(a, 'request_repack', SITI, { to_product_id: 2, to_qty: 1 })).error, 'INVALID');
});

test('v38 #4 at approval the bulk stock is checked again: refused while too little is left, then approved with a smaller corrected quantity', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const r = await call(a, 'request_repack', SITI, { client_id: 'st-1', to_product_id: 2, to_qty: 30 }); // 15 kg of 20
  assert.equal(r.ok, true, JSON.stringify(r));
  // more than the stock is refused already at request time
  assert.equal((await call(a, 'request_repack', RINA, { client_id: 'st-x', to_product_id: 3, to_qty: 100 })).error, 'INVALID');
  // meanwhile 8 kg of the bulk were sold / used
  a.run('UPDATE pos_products SET stock = 12 WHERE id = 1', []);
  const d = await call(a, 'decide_approval', MGR, { request_id: r.request_id, decision: 'approved' });
  assert.equal(d.ok, false);
  assert.equal(d.error, 'REPACK_STOCK');
  assert.match(d.message, /Stok Kurma Curah sekarang 12 kg, permintaan butuh 15 kg/);
  assert.equal(stockOf(a, 1), 12);
  assert.equal(repacks(a).length, 0);
  assert.equal(approvals(a)[0].status, 'pending'); // still pending: correct or reject
  const d2 = await call(a, 'decide_approval', MGR, { request_id: r.request_id, decision: 'approved', to_qty: 22, from_qty: 12 });
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.equal(stockOf(a, 1), 0);
  assert.equal(stockOf(a, 2), 26);
  // 22 packs from 12 kg = 91.7 % → the owner's notice is a warning
  const n = notices(a).slice(-1)[0];
  assert.equal(n.level, 'warn');
  assert.match(n.summary, /PERHATIAN: hasil di bawah 95%/);
  // invalid corrections are refused
  const r2 = await call(a, 'request_repack', SITI, { client_id: 'st-2', to_product_id: 4, to_qty: 1 });
  assert.equal(r2.error, 'INVALID'); // not a pack product
});

test('v38 #5 a request pending 24 h or more can be cancelled by its cashier or the approver (not earlier, not by another cashier); the lock is then free', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const r = await call(a, 'request_repack', SITI, { client_id: 'cx-1', to_product_id: 2, to_qty: 4 });
  const early = await call(a, 'cancel_repack', SITI, { request_id: r.request_id });
  assert.equal(early.ok, false);
  assert.equal(early.error, 'TOO_EARLY');
  assert.match(early.message, /setelah 24 jam/);
  a.run('UPDATE pos_approvals SET created_at = ? WHERE request_id = ?', [new Date(Date.now() - 25 * 3600000).toISOString(), r.request_id]);
  // the stale lock is still a lock, and the refusal says it may be cancelled
  const busy = await call(a, 'request_repack', RINA, { client_id: 'cx-2', to_product_id: 2, to_qty: 4 });
  assert.equal(busy.error, 'REPACK_PENDING');
  assert.equal(busy.pending.stale, true);
  assert.match(busy.message, /lebih dari 24 jam/);
  // another cashier may not cancel someone else's request
  assert.equal((await call(a, 'cancel_repack', RINA, { request_id: r.request_id })).error, 'FORBIDDEN');
  const c = await call(a, 'cancel_repack', SITI, { request_id: r.request_id });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.approval.status, 'cancelled');
  assert.equal(stockOf(a, 1), 20);
  assert.match(notices(a).slice(-1)[0].summary, /DIBATALKAN oleh Siti/);
  // cancelled → cannot be approved any more; the bulk is free
  assert.equal((await call(a, 'decide_approval', MGR, { request_id: r.request_id, decision: 'approved' })).ok, false);
  const r2 = await call(a, 'request_repack', RINA, { client_id: 'cx-3', to_product_id: 2, to_qty: 4 });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  // the accountant (an approver) cancels a stale one too
  a.run('UPDATE pos_approvals SET created_at = ? WHERE request_id = ?', [new Date(Date.now() - 30 * 3600000).toISOString(), r2.request_id]);
  const c2 = await call(a, 'cancel_repack', AK, { request_id: r2.request_id });
  assert.equal(c2.ok, true, JSON.stringify(c2));
  assert.equal(approvals(a).filter((x) => x.status === 'pending').length, 0);
});

test('v38 #6 roles: only a cashier requests; the manager repacks directly and the owner is told; the owner\'s own repack has no notice', async () => {
  const db = seed(), a = sqliteAdapter(db);
  assert.equal((await call(a, 'request_repack', MGR, { client_id: 'm-1', to_product_id: 2, to_qty: 2 })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'request_repack', AK, { client_id: 'a-1', to_product_id: 2, to_qty: 2 })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'repack', SITI, { to_product_id: 2, to_qty: 2 })).error, 'FORBIDDEN');
  const m = await call(a, 'repack', MGR, { to_product_id: 2, to_qty: 9, from_qty: 5 });
  assert.equal(m.ok, true, JSON.stringify(m));
  let n = notices(a);
  assert.equal(n.length, 1);
  assert.equal(n[0].ref, 'owner');
  assert.equal(n[0].level, 'warn');
  assert.match(n[0].summary, /Kemas ulang oleh manajer Jihan: Kurma Curah 5 kg → Kurma 500 g x9 \(hasil 90%/);
  assert.equal(repacks(a)[0].requested_by, '');
  const o = await call(a, 'repack', OWNER, { to_product_id: 3, to_qty: 4 });
  assert.equal(o.ok, true);
  assert.equal(notices(a).length, 1);
  assert.equal(stockOf(a, 1), 14);
});

test('v38 #7 at the same moment: two cashiers → one request; manager + accountant → the stock moves once', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const [x, y] = await Promise.all([
    call(a, 'request_repack', SITI, { client_id: 'race-s', to_product_id: 2, to_qty: 6 }),
    call(a, 'request_repack', RINA, { client_id: 'race-r', to_product_id: 3, to_qty: 8 }),
  ]);
  const oks = [x, y].filter((r) => r.ok), refused = [x, y].filter((r) => !r.ok);
  assert.equal(oks.length, 1, JSON.stringify([x, y]));
  assert.equal(refused[0].error, 'REPACK_PENDING');
  assert.equal(approvals(a).filter((r) => r.status === 'pending').length, 1);
  const win = approvals(a).find((r) => r.status === 'pending');
  const [m, k] = await Promise.all([
    call(a, 'decide_approval', MGR, { request_id: win.request_id, decision: 'approved' }),
    call(a, 'decide_approval', AK, { request_id: win.request_id, decision: 'approved' }),
  ]);
  assert.equal([m, k].filter((r) => r.ok).length, 1, JSON.stringify([m, k]));
  assert.equal(repacks(a).length, 1);
  assert.equal(stockOf(a, 1), 17);
  assert.equal(approvals(a).find((r) => r.request_id === win.request_id).status, 'approved');
});

test('v38 #8 the race guards on the database itself: a concurrent request written between load and write wins; a claimed approval is not decided twice', async () => {
  const db = seed(), a0 = sqliteAdapter(db);
  // another cashier's request lands in the database after this request loaded its rows, just before it writes
  let injected = false;
  const a = { all: a0.all, run(sql, params) {
    if (!injected && /^INSERT INTO pos_approvals/.test(sql)) {
      injected = true;
      insert(db, 'pos_approvals', { request_id: 'APRINA1', client_id: 'other', created_at: new Date().toISOString(), cashier: 'Rina', kind: 'repack', ref: '1', status: 'pending', approver_role: 'mgr_akuntan',
        payload: JSON.stringify({ to_product_id: 3, from_product_id: 1, from_name: 'Kurma Curah', to_name: 'Kurma 250 g', to_qty: 8, from_qty: 2 }), summary: 'Minta kemas ulang', decided_by: '', decided_at: '', note: '', total: 0 });
    }
    return a0.run(sql, params);
  } };
  const r = await call(a, 'request_repack', SITI, { client_id: 'g-1', to_product_id: 2, to_qty: 2 });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'REPACK_PENDING');
  assert.equal(r.pending.cashier, 'Rina');
  assert.match(r.message, /oleh Rina .*APRINA1: Kurma 250 g x8/);
  const rows = approvals(a0);
  assert.deepEqual(rows.map((x) => [x.cashier, x.status]), [['Rina', 'pending'], ['Siti', 'cancelled']]);
  assert.equal(notices(a0).length, 0); // the losing request wrote nothing else (no notice)
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

test('v38 self-migration adds the repack request columns to an older D1', async () => {
  const db = seed();
  for (const c of ['requested_by', 'approved_by', 'request_id']) db.exec('ALTER TABLE pos_repacks DROP COLUMN ' + c);
  _resetPosSchemaForTests();
  const a = sqliteAdapter(db);
  const r = await call(a, 'request_repack', SITI, { client_id: 'mig-1', to_product_id: 2, to_qty: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(['requested_by', 'approved_by', 'request_id'].every((c) => a.all('PRAGMA table_info(pos_repacks)', []).some((x) => x.name === c)));
  assert.equal((await call(a, 'decide_approval', AK, { request_id: r.request_id, decision: 'approved' })).ok, true);
  assert.equal(repacks(a)[0].approved_by, 'Aqil');
});
