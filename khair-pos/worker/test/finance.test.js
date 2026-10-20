// v67 (owner 2026-10-20, majoo screenshots: «اضف هذه المميزات»): the Keuangan screen's one call (finance_position) and the owner's
// opening balance of a store account (set_account_opening), on the real backend through the Worker's aggregate loaders (in-memory
// SQLite):
//   1. who may read it: owner, accountant (costs hidden unless allowed), the manager only when the owner lets her see costs;
//   2. every money record is attributed to its account, to a drawer, or to "Tanpa akun"; the saldo = saldo awal + in − out from
//      its date (a record before that date is not counted, a void sale never);
//   3. the open drawers' expected cash, what customers owe, the stock at cost, the supplier balances (= the sum of party_ledger);
//   4. the profit & loss lines get_sales does not carry (customer returns, undercharges collected), as profit_loss;
//   5. only the owner sets a saldo awal (validated, logged, the accountant told); it never travels with the settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const D = n => new Date(Date.parse(today) - n * 86400000).toISOString().slice(0, 10);
const wibIso = (ymd, hh) => new Date(Date.parse(ymd + 'T00:00:00Z') + (hh - 7) * 3600000).toISOString();

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_settings', { id: 1, skey: 'bank_accounts', svalue: JSON.stringify([{ id: 'BA1', bank: 'BCA', account_no: '1234567890', holder: 'Khair Mart', active: true }, { id: 'BA2', bank: 'Mandiri', account_no: '1560009876543', holder: 'Khair Mart', active: true }]) });
  insert(db, 'pos_settings', { id: 2, skey: 'akuntan_sees_cost', svalue: 'false' });
  insert(db, 'pos_products', { id: 1, sku: 'K1', name: 'Kurma Sukari', category: 'Kurma', unit: 'pak', cost_price: 50000, retail_price: 70000, stock: 10, shop_stock: 10, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'K2', name: 'Kismis', category: 'Kismis', unit: 'pak', cost_price: 20000, retail_price: 30000, stock: 5, shop_stock: 5, active: true });
  insert(db, 'pos_products', { id: 3, sku: 'M1', name: 'Stiker', category: 'Bahan kemasan', unit: 'pcs', cost_price: 500, retail_price: 0, stock: 100, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 4, sku: 'X1', name: 'Lama', category: 'Kurma', unit: 'pcs', cost_price: 1000, retail_price: 2000, stock: 1000, shop_stock: 0, active: false });
  insert(db, 'pos_products', { id: 5, sku: 'X2', name: 'Minus', category: 'Kurma', unit: 'pcs', cost_price: 9000, retail_price: 12000, stock: -3, shop_stock: 0, active: true });
  insert(db, 'pos_customers', { id: 7, name: 'Toko Berkah', phone: '0812', type: 'grosir', debt_balance: 100000 });
  insert(db, 'pos_customers', { id: 8, name: 'Warung Halimah', phone: '0813', type: 'grosir', debt_balance: 250000 });
  insert(db, 'pos_customers', { id: 9, name: 'Ibu Fatimah', phone: '0814', type: 'eceran', debt_balance: 0 });
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', shift_date: today, opened_at: wibIso(today, 8), opening_cash: 200000, cash_sales: 150000, cash_payments: 50000, cash_in: 10000, cash_out: 30000, sales_count: 3, sales_total: 175000, moves: '[]', note: '' });
  let sid = 100;
  const sale = (date, method, total, paid, f = {}) => insert(db, 'pos_sales', Object.assign({ id: ++sid, invoice_no: 'KM-' + sid, sale_date: date, sale_time: wibIso(date, 10), cashier: 'Siti', customer_id: 0, customer_name: 'Umum', subtotal: total, discount: 0, total, total_cost: Math.round(total * 0.7), profit: total - Math.round(total * 0.7), payment_method: method, paid_amount: paid, debt_amount: Math.max(0, total - paid), status: 'ok', shift_id: '', account_id: '' }, f));
  sale(D(2), 'transfer', 100000, 100000, { account_id: 'BA1' });
  sale(D(3), 'transfer', 80000, 80000); // not filed under an account
  sale(D(3), 'qris', 60000, 60000);
  sale(D(4), 'kartu', 40000, 40000);
  sale(D(4), 'tunai', 30000, 50000); // the owner sold with no drawer; change given back
  sale(D(1), 'tunai', 25000, 25000, { shift_id: 'SHS' }); // through the drawer
  sale(D(6), 'campur', 100000, 100000, { account_id: 'BA2', pay_parts: JSON.stringify([{ m: 'transfer', a: 70000 }, { m: 'qris', a: 20000 }, { m: 'tunai', a: 10000 }]) });
  sale(D(2), 'transfer', 999999, 999999, { account_id: 'BA1', status: 'void' });
  sale(D(1), 'hutang', 200000, 50000, { shift_id: 'SHS', customer_id: 7 }); // the down payment is drawer cash
  sale(D(10), 'transfer', 500000, 500000, { account_id: 'BA1' }); // before BA1's saldo awal date
  sale(D(40), 'transfer', 700000, 700000, { account_id: 'BA1' }); // outside the period and before the saldo awal
  let pid = 200;
  const pay = f => insert(db, 'pos_payments', Object.assign({ id: ++pid, pay_id: 'PY' + pid, pay_date: D(1), pay_time: wibIso(D(1), 11), direction: 'in', party_type: 'customer', customer_id: 0, customer_name: '', supplier: '', amount: 0, method: 'tunai', account_id: '', alloc: '[]', match_status: '', note: '', cashier: 'Pemilik' }, f));
  pay({ customer_id: 7, customer_name: 'Toko Berkah', amount: 150000, method: 'transfer', account_id: 'BA1' });
  pay({ customer_id: 8, customer_name: 'Warung Halimah', amount: 20000, method: 'qris' }); // no account
  pay({ direction: 'out', party_type: 'supplier', supplier: 'CV Arab', amount: 120000, method: 'transfer', account_id: 'BA1' });
  pay({ direction: 'out', party_type: 'supplier', supplier: 'CV Arab', amount: 30000, method: 'tunai', note: 'Bayar [dari kas]' }); // the drawer
  pay({ direction: 'out', party_type: 'supplier', supplier: 'PT Badar', amount: 45000, method: 'tunai', note: '' }); // cash from elsewhere
  pay({ direction: 'out', party_type: 'other', payee: 'Pak Ali', amount: 60000, method: 'transfer', account_id: 'BA2' });
  pay({ direction: 'out', party_type: 'customer', customer_id: 9, amount: 15000, method: 'transfer', account_id: 'BA1', match_status: 'retur' }); // a refund
  pay({ customer_id: 8, amount: 50000, method: 'tunai' }); // cash into a drawer
  pay({ direction: 'out', party_type: 'supplier', supplier: 'PT Badar', amount: 10000, method: 'transfer', account_id: 'BA9' }); // an unknown account
  pay({ pay_date: D(30), direction: 'out', party_type: 'supplier', supplier: 'CV Arab', amount: 50000, method: 'transfer', account_id: 'BA1' }); // before the period
  insert(db, 'pos_expenses', { id: 301, expense_date: D(2), category: 'transport', amount: 30000, paid_from: 'kas', user: 'Siti' });
  insert(db, 'pos_expenses', { id: 302, expense_date: D(3), category: 'sewa', amount: 70000, paid_from: 'lain', user: 'Pemilik' });
  let rid = 400;
  const pur = (supplier, no, total, f = {}) => insert(db, 'pos_purchases', Object.assign({ id: ++rid, purchase_date: D(20), supplier, product_id: 1, name: 'Kurma Sukari', qty: total / 50000, cost_price: 50000, total, purchase_no: no, match_status: 'cocok' }, f));
  pur('CV Arab', 'PB1', 300000); pur('CV Arab', 'PB1', 200000); pur('CV Arab', 'PB3', 100000, { purchase_date: D(50) });
  pur('CV Arab', 'RT1', -50000, { qty: -1, match_status: 'retur' }); // a supplier return (credit note)
  pur('PT Badar', 'PB2', 40000);
  pur('STOK OPNAME', 'SO1', -50000, { qty: -1 }); pur('KEMAS ULANG', 'KU1', 0, { qty: -2 });
  pur('', 'PB4', 70000); // no supplier name
  insert(db, 'pos_returns', { id: 501, return_id: 'RTC1', kind: 'pelanggan', status: 'approved', return_date: D(2), ref: 'KM-101', party_id: 9, refund: 20000, refund_method: 'transfer', lines: JSON.stringify([{ product_id: 1, qty: 1, condition: 'baik' }, { product_id: 2, qty: 2, condition: 'rusak' }]) });
  insert(db, 'pos_returns', { id: 502, return_id: 'RTS1', kind: 'pemasok', status: 'approved', return_date: D(2), ref: 'PB1', refund: 50000, lines: '[]' });
  insert(db, 'pos_returns', { id: 503, return_id: 'RTC2', kind: 'pelanggan', status: 'rejected', return_date: D(2), ref: 'KM-102', refund: 9000, lines: '[]' });
  insert(db, 'pos_approvals', { id: 601, request_id: 'APK1', kind: 'konsultasi', status: 'approved', total: 12000, decided_at: wibIso(D(1), 10), created_at: wibIso(D(1), 9) });
  insert(db, 'pos_approvals', { id: 602, request_id: 'APK2', kind: 'konsultasi', status: 'approved', total: 99000, decided_at: wibIso(D(16), 10), created_at: wibIso(D(16), 9) }); // before the period
  insert(db, 'pos_approvals', { id: 603, request_id: 'APK3', kind: 'konsultasi', status: 'rejected', total: 5000, decided_at: wibIso(D(1), 11), created_at: wibIso(D(1), 9) });
  return db;
}
const RANGE = { from: D(15), to: today };
const acc = (r, id) => r.accounts.find(a => a.id === id);

test('v67 finance_position: who may read it; costs only for whoever may see them', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  assert.equal((await call(ad, 'Siti', 'finance_position', RANGE)).error, 'FORBIDDEN');
  assert.equal((await call(ad, 'Jihan', 'finance_position', RANGE)).error, 'FORBIDDEN'); // the manager, costs not allowed
  const ak = await call(ad, 'Aqil', 'finance_position', RANGE);
  assert.equal(ak.ok, true, JSON.stringify(ak));
  assert.equal(ak.see_cost, false); assert.equal(ak.stock, null); assert.equal(ak.pl_extra.returns.restock, undefined);
  assert.equal(ak.pl_extra.returns.refund, 20000); // money back is not a cost
  assert.equal((await call(ad, 'Pemilik', 'finance_position', { from: today, to: D(1) })).error, 'INVALID');
  db.prepare("UPDATE pos_settings SET svalue = 'true' WHERE skey = 'akuntan_sees_cost'").run();
  const mg = await call(ad, 'Jihan', 'finance_position', RANGE);
  assert.equal(mg.ok, true, JSON.stringify(mg)); assert.equal(mg.see_cost, true); assert.equal(mg.stock.value, 650000);
  assert.equal((await call(ad, 'Aqil', 'finance_position', RANGE)).stock.value, 650000);
});

test('v67 finance_position: the money of the period by account, the drawers, and what has no account', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await call(ad, 'Pemilik', 'finance_position', RANGE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.as_of, today);
  assert.deepEqual(r.drawers.map(x => [x.cashier, x.expected]), [['Siti', 200000 + 150000 + 50000 + 10000 - 30000]]);
  // BA1: sales by transfer filed under it (+ before the saldo awal, inside the period), a customer payment; supplier + refund out
  assert.deepEqual([acc(r, 'BA1').period.in, acc(r, 'BA1').period.out], [100000 + 500000 + 150000, 120000 + 15000]);
  assert.deepEqual([acc(r, 'BA2').period.in, acc(r, 'BA2').period.out], [70000, 60000]); // the split sale's transfer part; a transfer out
  assert.equal(acc(r, 'BA1').opening, null); assert.equal(acc(r, 'BA1').balance, undefined);
  assert.deepEqual(r.none, { tf_sales: 80000, qris_sales: 60000 + 20000, card_sales: 40000, cash_nodrawer: 30000 + 10000, bank_in: 20000, bank_out: 10000, sup_cash: 45000, exp_other: 70000 });
  // receivables, stock at cost (active only, materials included, a negative stock counts 0)
  assert.equal(r.receivables.total, 350000); assert.deepEqual(r.receivables.top.map(c => c.name), ['Warung Halimah', 'Toko Berkah']);
  assert.deepEqual([r.stock.value, r.stock.items, r.stock.materials, r.stock.materials_n], [10 * 50000 + 5 * 20000 + 100 * 500, 4, 50000, 1]);
  // the profit & loss lines of the period not in get_sales (as profit_loss)
  assert.deepEqual([r.pl_extra.returns.count, r.pl_extra.returns.refund, r.pl_extra.returns.restock], [1, 20000, 50000]);
  assert.deepEqual(r.pl_extra.collected, { count: 1, total: 12000 });
  const pl = await call(ad, 'Pemilik', 'profit_loss', RANGE);
  assert.equal(pl.ok, true, JSON.stringify(pl));
  assert.deepEqual([pl.pl.returns.refund, pl.pl.returns.restock, pl.pl.corrections.collected], [r.pl_extra.returns.refund, r.pl_extra.returns.restock, r.pl_extra.collected.total]);
});

test('v67 supplier debt = the sum of every supplier\'s party_ledger balance; paid ahead is an asset', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await call(ad, 'Aqil', 'finance_position', RANGE);
  assert.equal(r.ok, true, JSON.stringify(r));
  let owed = 0, ahead = 0;
  for (const s of ['CV Arab', 'PT Badar']) {
    const lg = await call(ad, 'Aqil', 'party_ledger', { party_type: 'supplier', supplier: s });
    assert.equal(lg.ok, true, JSON.stringify(lg));
    if (lg.balance > 0) owed += lg.balance; else ahead -= lg.balance;
  }
  assert.equal(r.suppliers.payable, owed); assert.equal(r.suppliers.prepaid, ahead);
  assert.deepEqual([owed, ahead], [600000 - 50000 - 120000 - 30000 - 50000, 45000 + 10000 - 40000]);
  assert.deepEqual(r.suppliers.owed.map(s => [s.supplier, s.balance, s.notes]), [['CV Arab', 350000, 3]]);
  assert.deepEqual(r.suppliers.ahead.map(s => [s.supplier, s.balance]), [['PT Badar', -15000]]);
  assert.deepEqual(r.suppliers.nameless, { bought: 70000, paid: 0, notes: 1 }); // a goods-in with no supplier: shown apart, not a debt
  assert.ok(!r.suppliers.owed.concat(r.suppliers.ahead).some(s => /STOK OPNAME|KEMAS ULANG/.test(s.supplier)));
});

test('v67 set_account_opening: owner only, validated; the saldo = saldo awal + in − out from its date; never in the settings', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const set = (u, d) => call(ad, u, 'set_account_opening', d);
  assert.equal((await set('Jihan', { account_id: 'BA1', date: D(5), amount: 1000000 })).error, 'FORBIDDEN');
  assert.equal((await set('Aqil', { account_id: 'BA1', date: D(5), amount: 1000000 })).error, 'FORBIDDEN');
  assert.equal((await set('Pemilik', { account_id: 'BA7', date: D(5), amount: 1000000 })).error, 'INVALID');
  assert.equal((await set('Pemilik', { account_id: 'BA1', date: new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10), amount: 1000000 })).error, 'INVALID');
  assert.equal((await set('Pemilik', { account_id: 'BA1', date: D(5), amount: -5 })).error, 'INVALID');
  assert.equal((await set('Pemilik', { account_id: 'BA1', date: D(5), amount: '' })).error, 'INVALID');
  const ok = await set('Pemilik', { account_id: 'BA1', date: D(5), amount: 1000000 });
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.deepEqual([ok.opening.date, ok.opening.amount, ok.opening.by], [D(5), 1000000, 'Pemilik']);
  const note = db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id DESC").get();
  assert.equal(note.ref, 'akuntan'); assert.match(note.summary, /^Saldo awal BCA 1234567890: Rp 1\.000\.000 per awal /);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_activity WHERE kind = 'atur_bank'").get().n, 1);
  assert.equal((await set('Pemilik', { account_id: 'BA1', date: D(5), amount: 1000000 })).unchanged, true);
  const r = await call(ad, 'Aqil', 'finance_position', RANGE);
  const a1 = acc(r, 'BA1');
  // since D(5): the transfer sale of D(2) + the customer payment of D(1) in; the supplier payment and the refund out (D(10), D(40), D(30) not)
  assert.deepEqual([a1.since.in, a1.since.out, a1.balance], [100000 + 150000, 120000 + 15000, 1000000 + 250000 - 135000]);
  assert.equal(acc(r, 'BA2').opening, null);
  // a second account with an older date reads from its own date; a split sale's transfer part counts
  await set('Pemilik', { account_id: 'BA2', date: D(7), amount: 500000 });
  const r2 = await call(ad, 'Pemilik', 'finance_position', RANGE);
  assert.deepEqual([acc(r2, 'BA2').since.in, acc(r2, 'BA2').since.out, acc(r2, 'BA2').balance], [70000, 60000, 510000]);
  assert.equal(acc(r2, 'BA1').balance, 1115000);
  // the openings never travel with the settings (cashier, manager, owner)
  for (const u of ['Siti', 'Jihan', 'Pemilik', 'Aqil']) assert.equal((await call(ad, u, 'bootstrap', {})).settings.acct_opening, undefined, u);
  // cleared → back to "not set"
  const cl = await set('Pemilik', { account_id: 'BA1', clear: true });
  assert.equal(cl.ok, true); assert.equal(cl.opening, null);
  assert.equal(acc(await call(ad, 'Pemilik', 'finance_position', RANGE), 'BA1').opening, null);
  // a broken setting value never breaks the screen
  db.prepare("UPDATE pos_settings SET svalue = 'rusak' WHERE skey = 'acct_opening'").run();
  const r3 = await call(ad, 'Pemilik', 'finance_position', RANGE);
  assert.equal(r3.ok, true, JSON.stringify(r3)); assert.ok(r3.accounts.every(a => a.opening === null));
});
