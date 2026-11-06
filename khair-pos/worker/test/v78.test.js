// v78 (manager 2026-11-06, Audit harian 03/11: «customer payment transfer, kita input cash. sudah ubah ke transfer, tapi di report harian
// detect minus»): a cash sale entered by mistake was cancelled and entered again as a transfer, but the cashier's drawer still counted
// its cash — "seharusnya" Rp 3.266.000 instead of 666.000, "selisih" -Rp 2.600.000 although the drawer was right. A cancelled sale now
// leaves its drawer (open or already closed), once; the sales cancelled before are taken out once per database.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest, ensurePosSchema, repairVoidDrawers, shiftUndoStatements, _resetPosSchemaForTests } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222' };
const DAY = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const call = (db, user, action, data) => handleRequest(sqliteAdapter(db), { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
const EMPTY = { cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, transfer_sales: 0, qris_sales: 0, card_sales: 0, debt_sales: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' };

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 1000000, retail_price: 2600000, stock: 20, shop_stock: 20, active: true });
  insert(db, 'pos_shifts', Object.assign({ id: 1, shift_id: 'SHS', cashier: 'Siti', shift_date: DAY, status: 'open', opening_cash: 806000 }, EMPTY));
  return db;
}
const sell = (db, cid, extra) => call(db, 'Siti', 'save_sale', Object.assign({ client_id: cid, sale_date: DAY, items: [{ product_id: 1, qty: 1, unit_price: 2600000 }], discount: 0 }, extra));
const shift = (db, id = 'SHS') => db.prepare('SELECT * FROM pos_shifts WHERE shift_id = ?').get(id);
const saleRow = (db, inv) => db.prepare('SELECT * FROM pos_sales WHERE invoice_no = ?').get(inv);

test('the 03/11 case: cash by mistake → cancelled → entered again as a transfer; the drawer counts only what is really cash', async () => {
  const db = seed();
  const wrong = await sell(db, 'w1', { payment_method: 'tunai', paid_amount: 2600000 });
  assert.equal(wrong.ok, true, JSON.stringify(wrong));
  assert.equal(shift(db).cash_sales, 2600000);
  // the cashier asks, the manager approves the cancellation
  const rq = await call(db, 'Siti', 'request_void', { invoice_no: wrong.invoice_no, reason: 'salah input: dibayar transfer' });
  assert.equal(rq.ok, true, JSON.stringify(rq));
  const ap = db.prepare("SELECT request_id FROM pos_approvals WHERE kind = 'void'").get();
  const ok = await call(db, 'Jihan', 'decide_approval', { request_id: ap.request_id, decision: 'approved', invoice_no: wrong.invoice_no });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(saleRow(db, wrong.invoice_no).status, 'void');
  assert.equal(saleRow(db, wrong.invoice_no).drawer_undone, 1);
  const s1 = shift(db);
  assert.equal(s1.cash_sales, 0, 'the cancelled cash no longer counts');
  assert.equal(s1.sales_count, 0); assert.equal(s1.sales_total, 0);
  assert.ok(db.prepare("SELECT summary FROM pos_activity WHERE kind = 'kas'").all().some((a) => /dibatalkan, tunai Rp 2600000 tidak dihitung lagi/.test(a.summary)));
  // entered again, paid by transfer
  const right = await sell(db, 'w2', { payment_method: 'transfer', paid_amount: 2600000 });
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(shift(db).transfer_sales, 2600000);
  assert.equal(shift(db).cash_sales, 0);
  // the evening count: the opening cash is all there is — no difference
  const cl = await call(db, 'Siti', 'close_shift', { counted_cash: 806000 });
  assert.equal(cl.ok, true, JSON.stringify(cl));
  assert.equal(shift(db).expected_cash, 806000);
  assert.equal(shift(db).difference, 0);
});

test('cancelled after the drawer was closed: its expected cash and difference are corrected too; split sales leave each part', async () => {
  const db = seed();
  const a = await sell(db, 'c1', { payment_method: 'tunai', paid_amount: 2600000 });
  const b = await sell(db, 'c2', { payments: [{ method: 'tunai', amount: 600000 }, { method: 'transfer', amount: 2000000 }] });
  assert.equal(b.ok, true, JSON.stringify(b));
  const cl = await call(db, 'Siti', 'close_shift', { counted_cash: 806000 + 600000 }); // a's cash was never there
  assert.equal(cl.ok, true);
  assert.equal(shift(db).difference, -2600000);
  const v = await call(db, 'Pemilik', 'void_sale', { invoice_no: a.invoice_no, reason: 'salah input' });
  assert.equal(v.ok, true, JSON.stringify(v));
  const s = shift(db);
  assert.equal(s.expected_cash, 806000 + 600000); assert.equal(s.difference, 0);
  assert.equal(s.cash_sales, 600000); assert.equal(s.transfer_sales, 2000000);
  // the split one cancelled too: its cash and its transfer part both leave
  await call(db, 'Pemilik', 'void_sale', { invoice_no: b.invoice_no, reason: 'x' });
  const s2 = shift(db);
  assert.equal(s2.cash_sales, 0); assert.equal(s2.transfer_sales, 0); assert.equal(s2.sales_count, 0);
  assert.equal(s2.expected_cash, 806000); assert.equal(s2.difference, 600000, 'now 600.000 more in the drawer than its sales say');
  // cancelling again changes nothing
  await call(db, 'Pemilik', 'void_sale', { invoice_no: b.invoice_no, reason: 'x' });
  assert.equal(shift(db).expected_cash, 806000);
});

test('the drawer changes once even if the same cancellation is applied twice; a sale without a drawer is left alone', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const a = await sell(db, 'd1', { payment_method: 'tunai', paid_amount: 2600000 });
  const sale = saleRow(db, a.invoice_no);
  const st = shiftUndoStatements([{ sale_id: sale.id, shift_id: 'SHS', cash: 2600000, transfer: 0, qris: 0, card: 0, debt: 0, total: 2600000 }]);
  ad.batch(st.map((q) => ({ sql: q.sql, params: q.params, kind: 'run' })).concat([{ sql: 'UPDATE pos_sales SET drawer_undone = 1, status = ? WHERE id = ?', params: ['void', sale.id], kind: 'run' }]));
  ad.batch(st.map((q) => ({ sql: q.sql, params: q.params, kind: 'run' }))); // a second Worker with the same plan
  assert.equal(shift(db).cash_sales, 0);
  assert.deepEqual(shiftUndoStatements([{ sale_id: 9, shift_id: '' }, null, { shift_id: 'X' }]), []);
});

test('sales cancelled before v78: taken out of their drawers once per database, the owner told; a new instance does not repeat it', async () => {
  const db = seed();
  insert(db, 'pos_shifts', Object.assign({ id: 2, shift_id: 'SH03', cashier: 'Siti', shift_date: '2026-11-03', status: 'closed', opening_cash: 806000 }, EMPTY,
    { cash_sales: 2832000, transfer_sales: 3380000, cash_out: 372000, sales_count: 9, sales_total: 6212000, expected_cash: 3266000, counted_cash: 666000, difference: -2600000 }));
  const base = { sale_date: '2026-11-03', cashier: 'Siti', customer_id: 0, customer_name: 'Umum', subtotal: 2600000, discount: 0, total: 2600000, debt_amount: 0 };
  insert(db, 'pos_sales', Object.assign({ id: 50, invoice_no: '03/11/2026/1015/3', payment_method: 'tunai', paid_amount: 2600000, status: 'void', shift_id: 'SH03' }, base));
  insert(db, 'pos_sales', Object.assign({ id: 51, invoice_no: '03/11/2026/1020/4', payment_method: 'transfer', paid_amount: 2600000, status: 'ok', shift_id: 'SH03' }, base));
  insert(db, 'pos_sales', Object.assign({ id: 52, invoice_no: '03/11/2026/1100/5', payment_method: 'tunai', paid_amount: 50000, status: 'void', shift_id: '' }, base, { total: 50000 })); // no drawer (owner's sale)
  _resetPosSchemaForTests();
  const ad = sqliteAdapter(db);
  await ensurePosSchema(ad); await ensurePosSchema(ad); await ensurePosSchema(ad); // the database's first requests (migrations, then the repair)
  const s = shift(db, 'SH03');
  assert.equal(s.cash_sales, 232000); assert.equal(s.expected_cash, 666000); assert.equal(s.difference, 0);
  assert.equal(s.transfer_sales, 3380000); assert.equal(s.sales_count, 8);
  assert.equal(db.prepare('SELECT drawer_undone FROM pos_sales WHERE id = 50').get().drawer_undone, 1);
  assert.equal(db.prepare('SELECT drawer_undone FROM pos_sales WHERE id = 52').get().drawer_undone, null);
  assert.equal(db.prepare("SELECT v FROM pos_meta WHERE k = 'repair:void_drawer'").get().v, 1);
  assert.match(db.prepare("SELECT summary FROM pos_activity WHERE user = 'Sistem'").get().summary, /1 faktur yang dibatalkan .*tunai Rp 2600000: 03\/11\/2026\/1015\/3/);
  // a new instance: one read, nothing done twice
  _resetPosSchemaForTests();
  const before = ad.calls;
  await ensurePosSchema(ad);
  assert.equal(ad.calls - before, 1, 'one read of pos_meta, the repair flag with it');
  await repairVoidDrawers(ad);
  assert.equal(shift(db, 'SH03').expected_cash, 666000);
  // the cancelled sales are found through the status index
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM pos_sales WHERE status = 'void' AND COALESCE(drawer_undone, 0) = 0 AND COALESCE(shift_id, '') != '' ORDER BY id LIMIT 200").all().map((x) => x.detail).join(' ');
  assert.match(plan, /USING (COVERING )?INDEX idx_pos_sales_status/);
});
