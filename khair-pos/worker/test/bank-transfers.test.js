// v57 (owner 2026-10-15) — bank transfers by store account, on the real backend (backend/process.js through the Worker) on an
// in-memory SQLite:
//   «في عملية التحويلات إمكانية اختيار كتابة التحويل لأي بنك تمت مع أن المدير يقوم بإدخال بيانات كل بنك وعند المحاسب عندما يقوم بعملية
//    المراجعة أو تصنيف التحويلات فتتم حسب بنك والتطبيق أيضا عندما يتم عملية التحويل البنكي يقع التقاط الصورة للتحويل البنكي والتطبيق
//    مباشرة يتعرف على على أي نوع البنك ويصنفها حسب الصورة»
//   1. the manager keeps the store's bank accounts (save_bank_accounts); one left out stays, inactive;
//   2. a sale paid by transfer names the account: the cashier's choice, else the slip photo's account / bank, else the only one;
//   3. the accountant files a transfer under another account (set_transfer_bank) — a sale or a payment;
//   4. a transfer out keeps its payee (it was dropped before: pos_payments had no payee column).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444' };
const DAY = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const call = (db, user, action, data) => handleRequest(sqliteAdapter(db), { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
const BCA = { bank: 'BCA', account_no: '1234567890', holder: 'Khair Mart' }, MDR = { bank: 'Mandiri', account_no: '1560009876543', holder: 'Khair Mart' };

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', category: 'kurma', unit: 'kg', cost_price: 100000, retail_price: 150000, stock: 50, shop_stock: 50, active: true });
  insert(db, 'pos_customers', { id: 7, name: 'Toko Berkah', phone: '0812', type: 'eceran', address: '', notes: '', debt_balance: 300000 });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SHS', cashier: 'Siti', shift_date: DAY, status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, transfer_sales: 0, qris_sales: 0, debt_sales: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const slip = (db, id, ex) => insert(db, 'pos_photos', { photo_id: id, kind: 'bayar', ref: '', created_at: DAY + 'T03:00:00.000Z', photo_date: DAY, user: 'Siti', extracted: JSON.stringify(Object.assign({ amount: 150000, readable: true }, ex)), match_status: '', match_notes: '' });
const sell = (db, cid, extra = {}) => call(db, 'Siti', 'save_sale', Object.assign({ client_id: cid, sale_date: DAY, items: [{ product_id: 1, qty: 1, unit_price: 150000 }], discount: 0, payment_method: 'transfer', paid_amount: 150000 }, extra));
const saleRow = (db, inv) => db.prepare('SELECT * FROM pos_sales WHERE invoice_no = ?').get(inv);
const notices = (db) => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();
const accounts = async (db) => (await call(db, 'Pemilik', 'bootstrap', {})).settings.bank_accounts;

test('the manager keeps the bank accounts; the owner and the accountant are told; one left out stays (inactive); the cashier cannot', async () => {
  const db = seed();
  const r = await call(db, 'Jihan', 'save_bank_accounts', { accounts: [BCA, MDR] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.bank_accounts, [{ id: 'BA1', ...BCA, active: true }, { id: 'BA2', ...MDR, active: true }]);
  assert.equal(notices(db).at(-1).ref, 'owner,akuntan');
  assert.equal(notices(db).at(-1).summary, 'Rekening bank toko diubah: + BCA 1234567890 a.n. Khair Mart; + Mandiri 1560009876543 a.n. Khair Mart — oleh manajer Jihan');
  assert.equal((await call(db, 'Jihan', 'save_bank_accounts', { accounts: [{ id: 'BA1', ...BCA }, { id: 'BA2', ...MDR }] })).unchanged, true);
  // Mandiri left out → kept, inactive (its transfers keep their bank)
  const r2 = await call(db, 'Jihan', 'save_bank_accounts', { accounts: [{ id: 'BA1', ...BCA }] });
  assert.deepEqual(r2.bank_accounts.map((a) => [a.id, a.active]), [['BA1', true], ['BA2', false]]);
  assert.match(notices(db).at(-1).summary, /Mandiri 1560009876543 a\.n\. Khair Mart nonaktif/);
  assert.equal((await call(db, 'Siti', 'save_bank_accounts', { accounts: [BCA] })).error, 'FORBIDDEN');
  assert.equal((await call(db, 'Aqil', 'save_bank_accounts', { accounts: [BCA] })).error, 'FORBIDDEN');
  for (const bad of [[{ bank: '', account_no: '123456' }], [{ bank: 'BCA', account_no: '12' }], [BCA, { bank: 'bca', account_no: '1234567890' }]]) {
    assert.equal((await call(db, 'Jihan', 'save_bank_accounts', { accounts: bad })).error, 'INVALID', JSON.stringify(bad));
  }
  assert.equal((await accounts(db)).length, 2);
});

test('a sale paid by transfer names the account: chosen, else the slip (number, then bank), else the only one; the manager check says where', async () => {
  const db = seed();
  await call(db, 'Jihan', 'save_bank_accounts', { accounts: [BCA, MDR] });
  // chosen by the cashier
  const a = await sell(db, 'c1', { account_id: 'BA2', bank: 'BRI', transfer_ref: 'TRX1' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([saleRow(db, a.invoice_no).account_id, saleRow(db, a.invoice_no).bank, saleRow(db, a.invoice_no).transfer_ref], ['BA2', 'BRI', 'TRX1']);
  const tc = db.prepare("SELECT * FROM pos_approvals WHERE kind = 'transfer_confirm' AND ref = ?").get(a.invoice_no);
  assert.match(tc.summary, /ke Mandiri 1560009876543 — pastikan dana sudah masuk/);
  assert.equal(JSON.parse(tc.payload).account_id, 'BA2');
  // the slip: the receiver's account (masked) → BCA; the sender's bank and the transfer no. come from it too
  slip(db, 'PH1', { receiver_account: 'xxxxxx7890', receiver_bank: 'Bank Mandiri', sender_bank: 'BRI', transfer_ref: 'BRI-778' });
  const b = await sell(db, 'c2', { photo_id: 'PH1' });
  const sb = saleRow(db, b.invoice_no);
  assert.deepEqual([sb.account_id, sb.bank, sb.transfer_ref, sb.proof_photo_id], ['BA1', 'BRI', 'BRI-778', 'PH1']);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM pos_approvals WHERE ref = ?").get(b.invoice_no).payload).slip_amount, 150000);
  // the slip with no number: by the receiver's bank name (Livin' by Mandiri → Mandiri)
  slip(db, 'PH2', { receiver_bank: "Livin' by Mandiri" });
  assert.equal(saleRow(db, (await sell(db, 'c3', { photo_id: 'PH2' })).invoice_no).account_id, 'BA2');
  // two accounts, no choice, no slip → open (the accountant files it)
  assert.equal(saleRow(db, (await sell(db, 'c4')).invoice_no).account_id, '');
  // a split sale: the transfer part names the account; a cash sale names none
  const c = await sell(db, 'c5', { payment_method: undefined, paid_amount: undefined, payments: [{ method: 'tunai', amount: 100000 }, { method: 'transfer', amount: 50000 }], account_id: 'BA1' });
  assert.equal(saleRow(db, c.invoice_no).account_id, 'BA1');
  assert.equal(saleRow(db, (await sell(db, 'c6', { payment_method: 'tunai', account_id: 'BA1' })).invoice_no).account_id, null);
  // one active account → that one
  await call(db, 'Jihan', 'save_bank_accounts', { accounts: [{ id: 'BA1', ...BCA }] });
  assert.equal(saleRow(db, (await sell(db, 'c7')).invoice_no).account_id, 'BA1');
});

test('the accountant files a transfer under another account (a sale or a payment); a payment slip picks its account; a transfer out keeps its payee', async () => {
  const db = seed();
  await call(db, 'Jihan', 'save_bank_accounts', { accounts: [BCA, MDR] });
  const s = await sell(db, 'f1');
  assert.equal(saleRow(db, s.invoice_no).account_id, '');
  const r = await call(db, 'Aqil', 'set_transfer_bank', { kind: 'sale', invoice_no: s.invoice_no, account_id: 'BA2' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(saleRow(db, s.invoice_no).account_id, 'BA2');
  const act = db.prepare("SELECT summary FROM pos_activity WHERE kind = 'atur_bank' ORDER BY id DESC").get();
  assert.equal(act.summary, `Transfer faktur ${s.invoice_no} (Umum) Rp 150000 masuk ke Mandiri 1560009876543 — oleh akuntan Aqil`);
  assert.equal((await call(db, 'Aqil', 'set_transfer_bank', { kind: 'sale', invoice_no: s.invoice_no, account_id: 'BA2' })).unchanged, true);
  assert.equal((await call(db, 'Siti', 'set_transfer_bank', { kind: 'sale', invoice_no: s.invoice_no, account_id: 'BA1' })).error, 'FORBIDDEN');
  assert.equal((await call(db, 'Aqil', 'set_transfer_bank', { kind: 'sale', invoice_no: s.invoice_no, account_id: 'BA9' })).error, 'INVALID');
  const cash = await sell(db, 'f2', { payment_method: 'tunai' });
  assert.equal((await call(db, 'Aqil', 'set_transfer_bank', { kind: 'sale', invoice_no: cash.invoice_no, account_id: 'BA1' })).error, 'INVALID');
  // a customer's debt payment by transfer with a slip: the receiver's account on it (exact number) → BCA
  slip(db, 'PH5', { amount: 100000, receiver_account: '123-456-7890', receiver_bank: 'BCA' });
  const p = await call(db, 'Siti', 'receive_payment', { customer_id: 7, amount: 100000, method: 'transfer', photo_id: 'PH5' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.payment.account_id, 'BA1');
  // filed under Mandiri by the accountant (sent with its day)
  const r2 = await call(db, 'Aqil', 'set_transfer_bank', { kind: 'payment', pay_id: p.payment.pay_id, pay_date: p.payment.pay_date, account_id: 'BA2' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(db.prepare('SELECT account_id FROM pos_payments WHERE pay_id = ?').get(p.payment.pay_id).account_id, 'BA2');
  // a transfer out (the owner records it directly): the payee is stored; its slip's sender account picks the account
  slip(db, 'PH6', { amount: 250000, sender_account: '1560009876543', sender_bank: 'Mandiri' });
  const t = await call(db, 'Pemilik', 'record_transfer', { payee: 'PLN Jakarta', amount: 250000, reason: 'Listrik Oktober', photo_id: 'PH6' });
  assert.equal(t.ok, true, JSON.stringify(t));
  const row = db.prepare('SELECT * FROM pos_payments WHERE pay_id = ?').get(t.payment.pay_id);
  assert.deepEqual([row.payee, row.account_id, row.proof_photo_id], ['PLN Jakarta', 'BA2', 'PH6']);
  // get_sales gives each sale its account (the owner app's per-bank list reads it)
  const g = await call(db, 'Aqil', 'get_sales', { from: DAY, to: DAY });
  assert.equal(g.sales.find((x) => x.invoice_no === s.invoice_no).account_id, 'BA2');
  assert.equal(g.payments.find((x) => x.pay_id === t.payment.pay_id).payee, 'PLN Jakarta');
});
