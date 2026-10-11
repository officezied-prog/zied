// v36 (owner 2026-10-11) — the real backend (backend/process.js through the Worker's loaders) on an in-memory SQLite:
//   1. a void of an EARLIER day's sale needs the owner's personal approval; today's stays with the manager or accountant;
//   2. the morning cash-box opening goes to the manager AND the accountant (first decision wins, the other is told);
//   3. the manager may rename the accountant account (name only);
//   6. profit_loss — the monthly statement's profit & loss (and the price-correction history now reaches the reports).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const jkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const call = (a, action, user, pin, data) => handleRequest(a, base(action, user, pin, data), {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Emma', role: 'kasir', pin_hash: h('Emma', '5555'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, wholesale_price: 170000, wholesale_min_qty: 5, stock: 20, shop_stock: 20, min_stock: 3, active: true });
  insert(db, 'pos_products', { id: 2, sku: '222', name: 'Kismis 500g', unit: 'pcs', cost_price: 20000, retail_price: 25000, wholesale_price: 23000, wholesale_min_qty: 10, stock: 50, shop_stock: 50, min_stock: 5, active: true });
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', shift_date: jkToday(), opening_cash: 200000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const sale = (db, id, inv, date, extra = {}) => insert(db, 'pos_sales', Object.assign({ id, invoice_no: inv, sale_date: date, sale_time: date + 'T03:00:00.000Z', cashier: 'Siti', customer_id: 0, customer_name: 'Umum',
  subtotal: 185000, discount: 0, total: 185000, total_cost: 150000, profit: 35000, payment_method: 'tunai', paid_amount: 185000, debt_amount: 0, status: 'ok', client_id: 'c' + id }, extra));

// ---- 1. old invoice → owner only ----
test('v36 #1 void of an EARLIER day\'s sale goes to the owner; manager/accountant cannot decide; the owner can', async () => {
  const db = seed(), a = sqliteAdapter(db);
  sale(db, 30, 'KM260105-OLD01', '2026-01-05');
  insert(db, 'pos_sale_items', { id: 31, invoice_no: 'KM260105-OLD01', sale_date: '2026-01-05', product_id: 1, name: 'Kurma Ajwa 1kg', qty: 1, unit_price: 185000, line_total: 185000, cost_price: 150000, line_profit: 35000, price_type: 'eceran' });
  const rv = await call(a, 'request_void', 'Siti', '1111', { invoice_no: 'KM260105-OLD01', reason: 'salah harga' });
  assert.equal(rv.ok, true, JSON.stringify(rv));
  assert.equal(rv.approver_role, 'owner');
  assert.equal(rv.old_invoice, true);
  const ap = a.all("SELECT * FROM pos_approvals WHERE kind = 'void'", [])[0];
  assert.equal(ap.approver_role, 'owner');
  assert.equal(JSON.parse(ap.payload).sale_date, '2026-01-05');
  // the owner is told (role-addressed notice) that only he decides
  assert.ok(a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []).some((n) => String(n.ref).includes('owner') && /LAMA/.test(n.summary)));
  // manager: sees it, cannot decide
  const lm = await call(a, 'list_approvals', 'Jihan', '2222', {});
  const card = lm.approvals.find((x) => x.request_id === ap.request_id);
  assert.ok(card && card.can_decide === false, JSON.stringify(card));
  const dm = await call(a, 'decide_approval', 'Jihan', '2222', { request_id: ap.request_id, decision: 'approved', invoice_no: 'KM260105-OLD01' });
  assert.equal(dm.error, 'NEEDS_OWNER');
  // accountant: does not even see it
  const la = await call(a, 'list_approvals', 'Aqil', '4444', {});
  assert.ok(!la.approvals.some((x) => x.request_id === ap.request_id));
  assert.equal((await call(a, 'decide_approval', 'Aqil', '4444', { request_id: ap.request_id, decision: 'approved', invoice_no: 'KM260105-OLD01' })).error, 'NEEDS_OWNER');
  assert.equal(a.all("SELECT status FROM pos_sales WHERE invoice_no = 'KM260105-OLD01'", [])[0].status, 'ok');
  // the owner approves → voided
  const dob = await call(a, 'decide_approval', 'Pemilik', '1234', { request_id: ap.request_id, decision: 'approved', invoice_no: 'KM260105-OLD01' });
  assert.equal(dob.ok, true, JSON.stringify(dob));
  assert.equal(a.all("SELECT status FROM pos_sales WHERE invoice_no = 'KM260105-OLD01'", [])[0].status, 'void');
});

test('v36 #1 today\'s sale stays with the manager OR accountant; a request still pending after midnight becomes the owner\'s', async () => {
  const db = seed(), a = sqliteAdapter(db);
  sale(db, 40, 'KMTODAY-0001', jkToday());
  const rv = await call(a, 'request_void', 'Siti', '1111', { invoice_no: 'KMTODAY-0001', reason: 'dobel' });
  assert.equal(rv.approver_role, 'mgr_akuntan');
  assert.equal(rv.old_invoice, false);
  const lm = await call(a, 'list_approvals', 'Jihan', '2222', {});
  assert.equal(lm.approvals.find((x) => x.request_id === rv.request_id).can_decide, true);
  // nobody but the owner decides a void they asked for themselves: the manager's own request goes to the accountant
  sale(db, 41, 'KMTODAY-0002', jkToday());
  const own = await call(a, 'request_void', 'Jihan', '2222', { invoice_no: 'KMTODAY-0002', reason: 'salah' });
  assert.equal(own.approval.can_decide, false);
  assert.equal((await call(a, 'decide_approval', 'Jihan', '2222', { request_id: own.request_id, decision: 'approved', invoice_no: 'KMTODAY-0002' })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'decide_approval', 'Aqil', '4444', { request_id: own.request_id, decision: 'approved', invoice_no: 'KMTODAY-0002' })).ok, true);
  assert.equal(a.all("SELECT status FROM pos_sales WHERE invoice_no = 'KMTODAY-0002'", [])[0].status, 'void');
  // a shared request raised yesterday for yesterday's sale (not decided in time): only the owner now
  insert(db, 'pos_approvals', { id: 70, request_id: 'APOLD1', kind: 'void', status: 'pending', approver_role: 'mgr_akuntan', ref: 'KM-Y', cashier: 'Siti', created_at: '2026-01-04T10:00:00.000Z',
    summary: 'Batalkan faktur KM-Y (2026-01-04, kasir Siti)', note: 'x', payload: '' });
  const lm2 = await call(a, 'list_approvals', 'Jihan', '2222', {});
  assert.equal(lm2.approvals.find((x) => x.request_id === 'APOLD1').can_decide, false);
  assert.equal((await call(a, 'decide_approval', 'Aqil', '4444', { request_id: 'APOLD1', decision: 'rejected' })).error, 'NEEDS_OWNER');
  assert.equal((await call(a, 'decide_approval', 'Pemilik', '1234', { request_id: 'APOLD1', decision: 'rejected' })).ok, true);
});

// ---- 2. morning opening → manager AND accountant ----
test('v36 #2 a cashier\'s opening count goes to the manager AND the accountant; the first decision wins', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const o = await call(a, 'open_shift', 'Emma', '5555', { opening_cash: 300000 });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.approval.approver_role, 'mgr_akuntan');
  const notes = a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []);
  assert.ok(notes.some((n) => n.ref === 'manager,akuntan' && /Buka kas Emma/.test(n.summary)), JSON.stringify(notes));
  const lm = await call(a, 'list_approvals', 'Jihan', '2222', {}), la = await call(a, 'list_approvals', 'Aqil', '4444', {});
  const cm = lm.approvals.find((x) => x.kind === 'buka_kas'), ca = la.approvals.find((x) => x.kind === 'buka_kas');
  assert.ok(cm && cm.can_decide, 'manager sees + decides');
  assert.ok(ca && ca.can_decide, 'accountant sees + decides');
  const d1 = await call(a, 'decide_approval', 'Aqil', '4444', { request_id: ca.request_id, decision: 'approved' });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const d2 = await call(a, 'decide_approval', 'Jihan', '2222', { request_id: ca.request_id, decision: 'approved' });
  assert.equal(d2.ok, false);
  assert.match(d2.message, /oleh Aqil/);
  assert.equal(a.all('SELECT status, decided_by FROM pos_approvals WHERE request_id = ?', [ca.request_id])[0].decided_by, 'Aqil');
  assert.ok(a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []).some((n) => n.ref === 'manager,owner' && /Akuntan Aqil/.test(n.summary)), 'manager + owner told');
});

test('v36 #2 when the manager approves first, the accountant is told; the manager\'s own opening stays with the owner', async () => {
  const db = seed(), a = sqliteAdapter(db);
  const o = await call(a, 'open_shift', 'Emma', '5555', { opening_cash: 100000 });
  const d = await call(a, 'decide_approval', 'Jihan', '2222', { request_id: o.request_id, decision: 'approved' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.ok(a.all("SELECT * FROM pos_activity WHERE kind = 'notifikasi'", []).some((n) => n.ref === 'akuntan' && /Manajer Jihan/.test(n.summary)));
  assert.ok(!(await call(a, 'list_approvals', 'Aqil', '4444', {})).approvals.some((x) => x.request_id === o.request_id), 'gone from the accountant\'s inbox');
  const om = await call(a, 'open_shift', 'Jihan', '2222', { opening_cash: 50000 });
  assert.equal(om.approval.approver_role, 'owner');
});

// ---- 3. the manager renames the accountant ----
test('v36 #3 the manager renames the accountant account (name only)', async () => {
  const db = seed(), a = sqliteAdapter(db);
  // not: change its role, reset its PIN without a rename, suspend it through save_user, create a new accountant, touch the owner
  assert.equal((await call(a, 'save_user', 'Jihan', '2222', { name: 'Aqil', role: 'kasir', active: true })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'save_user', 'Jihan', '2222', { name: 'Aqil', role: 'akuntan', active: true, pin_hash: h('Aqil', '9999') })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'save_user', 'Jihan', '2222', { name: 'Aqil', new_name: 'Nadia', role: 'akuntan', active: false, pin_hash: h('Nadia', '7777') })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'save_user', 'Jihan', '2222', { name: 'Baru', role: 'akuntan', active: true, pin_hash: h('Baru', '7777') })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'save_user', 'Jihan', '2222', { name: 'Aqil', new_name: 'Nadia', role: 'manager', active: true, pin_hash: h('Nadia', '7777') })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'save_user', 'Jihan', '2222', { name: 'Pemilik', new_name: 'Boss', role: 'owner', active: true, pin_hash: h('Boss', '777777') })).error, 'FORBIDDEN');
  const r = await call(a, 'save_user', 'Jihan', '2222', { name: 'Aqil', new_name: 'Nadia', role: 'akuntan', active: true, pin_hash: h('Nadia', '7777') });
  assert.equal(r.ok, true, JSON.stringify(r));
  const u = a.all("SELECT * FROM pos_users WHERE id = 4", [])[0];
  assert.equal(u.name, 'Nadia');
  assert.equal(u.role, 'akuntan');
  assert.equal(u.must_change, 1); // a temporary PIN: Nadia chooses her own at the first login
  // the owner can still do it too
  assert.equal((await call(a, 'save_user', 'Pemilik', '1234', { name: 'Nadia', new_name: 'Nadia Putri', role: 'akuntan', active: true, pin_hash: h('Nadia Putri', '7777') })).ok, true);
});

// ---- 6. profit & loss ----
test('v36 #6 profit_loss: sales − cost − expenses ± returns ± stock counts + collected undercharges; corrections listed', async () => {
  const db = seed(), a = sqliteAdapter(db);
  sale(db, 50, 'KM-P1', '2026-09-03', { total: 370000, subtotal: 370000, total_cost: 300000, profit: 70000 });
  sale(db, 51, 'KM-P2', '2026-09-04', { total: 100000, subtotal: 105000, discount: 5000, total_cost: 80000, profit: 20000 });
  sale(db, 52, 'KM-P3', '2026-09-05', { total: 50000, total_cost: 40000, profit: 10000, status: 'void' });
  sale(db, 53, 'KM-OUT', '2026-08-31', { total: 999999, profit: 999 });
  insert(db, 'pos_expenses', { id: 60, expense_date: '2026-09-10', category: 'listrik_air', amount: 30000, note: 'PLN', user: 'Jihan', paid_from: 'kas' });
  insert(db, 'pos_expenses', { id: 61, expense_date: '2026-10-01', category: 'sewa', amount: 500000, note: '', user: 'Jihan', paid_from: 'kas' });
  insert(db, 'pos_purchases', { id: 62, purchase_date: '2026-09-12', supplier: 'STOK OPNAME', product_id: 2, name: 'Kismis 500g', qty: -2, cost_price: 20000, total: 0 });
  insert(db, 'pos_purchases', { id: 63, purchase_date: '2026-09-13', supplier: 'PENYESUAIAN STOK', product_id: 1, name: 'Kurma Ajwa 1kg', qty: 1, cost_price: 150000, total: 0 });
  insert(db, 'pos_purchases', { id: 64, purchase_date: '2026-09-13', supplier: 'PT Sumber', product_id: 2, name: 'Kismis 500g', qty: 10, cost_price: 20000, total: 200000 });
  insert(db, 'pos_returns', { id: 65, return_id: 'RT1', kind: 'pelanggan', status: 'approved', return_date: '2026-09-15', ref: 'KM-P2', refund: 50000, value: 50000,
    lines: JSON.stringify([{ product_id: 2, qty: 2, condition: 'baik' }, { product_id: 2, qty: 1, condition: 'rusak' }]) });
  insert(db, 'pos_returns', { id: 66, return_id: 'RT2', kind: 'pemasok', status: 'approved', return_date: '2026-09-15', ref: 'PB1', refund: 70000, value: 70000, lines: '[]' });
  insert(db, 'pos_returns', { id: 67, return_id: 'RT3', kind: 'pelanggan', status: 'rejected', return_date: '2026-09-16', ref: 'KM-P1', refund: 90000, value: 90000, lines: '[]' });
  insert(db, 'pos_approvals', { id: 80, request_id: 'KR1', kind: 'koreksi', status: 'done', approver_role: 'owner', decided_by: 'Jihan', decided_at: '2026-09-20T03:00:00.000Z', created_at: '2026-09-20T03:00:00.000Z', total: -15000, summary: 'Koreksi harga Kismis', payload: JSON.stringify({ under_total: 5000, net_diff: -15000 }) });
  insert(db, 'pos_approvals', { id: 81, request_id: 'KS1', kind: 'konsultasi', status: 'approved', approver_role: 'owner', decided_at: '2026-09-21T03:00:00.000Z', total: 5000, payload: '{}' });
  insert(db, 'pos_approvals', { id: 82, request_id: 'KS2', kind: 'konsultasi', status: 'rejected', approver_role: 'owner', decided_at: '2026-09-22T03:00:00.000Z', total: 3000, payload: '{}' });
  insert(db, 'pos_approvals', { id: 83, request_id: 'RF1', kind: 'refund', status: 'approved', approver_role: 'manager', decided_at: '2026-09-23T03:00:00.000Z', total: 12000, payload: '{}' });
  insert(db, 'pos_approvals', { id: 84, request_id: 'KR0', kind: 'koreksi', status: 'done', approver_role: 'owner', decided_at: '2026-08-20T03:00:00.000Z', total: -99000, payload: '{}' }); // outside the month

  const r = await call(a, 'profit_loss', 'Pemilik', '1234', { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const P = r.pl;
  assert.deepEqual(P.sales, { count: 2, total: 470000, discount: 5000 });
  assert.deepEqual(P.voids, { count: 1, total: 50000 });
  assert.equal(P.cogs, 380000);
  assert.equal(P.gross_profit, 90000);
  assert.equal(P.expenses.total, 30000);
  assert.deepEqual(P.expenses.by_category, { listrik_air: 30000 });
  assert.deepEqual(P.returns, { count: 1, refund: 50000, restock: 40000, net: -10000 });
  assert.deepEqual(P.stock_diff, { count: 2, value: 110000 });
  assert.deepEqual(P.corrections, { count: 1, net: -15000, overcharge: -20000, undercharge: 5000, refund_paid: 12000, collected: 5000, writeoff: 3000 });
  assert.equal(P.net_profit, 90000 - 30000 - 10000 + 110000 + 5000);
  // owner only (it needs purchase costs)
  assert.equal((await call(a, 'profit_loss', 'Jihan', '2222', { from: '2026-09-01', to: '2026-09-30' })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'profit_loss', 'Aqil', '4444', { from: '2026-09-01', to: '2026-09-30' })).error, 'FORBIDDEN');
  assert.equal((await call(a, 'profit_loss', 'Pemilik', '1234', { from: '2026-09-30', to: '2026-09-01' })).error, 'INVALID');
  // the decided price corrections now reach list_corrections (the loader used to load pending approvals only)
  const lc = await call(a, 'list_corrections', 'Pemilik', '1234', {});
  assert.deepEqual(lc.corrections.map((c) => c.request_id).sort(), ['KR0', 'KR1']);
});
