// v68 (owner 2026-10-20: «نعم يسجله الكاشير ويأخذ صورة للسيارة أو ما دفع له ويكتب التفاصيل بالوقت متى وكيف ولماذا دفع هذا المبلغ. يكتب في مصاريف
// الكاشير التي دفعها وخرجت من الكاشير، ويقوم التطبيق بوضعها في المكان المناسب في الإدارة المالية»), on the real backend through the Worker's
// loaders (in-memory SQLite): cash the cashier paid from his drawer when the goods arrived, saved with the goods-in note in ONE save_purchase:
//   1. "bayar barang": a supplier payment (tunai, [dari kas]) allocated to the new note, the drawer's cash out + a move, the note paid
//      ('lunas') but still waiting for the manager / accountant, whose confirmation records no second payment (and refuses "tempo");
//   2. a delivery fee / porters: a cashier expense from the drawer (category transport), its photo and note — never a payment;
//   3. a part of the goods' price: 'sebagian', the confirmation pays the rest;
//   4. refused without the cashier's own open drawer, without a photo / note / amount, over the note's total — and then nothing is written;
//   5. the notice (owner, manager, accountant), the drawer close and the Keuangan screen count it where it belongs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Rina: '3333', Jihan: '2222', Aqil: '4444' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Rina', role: 'kasir', pin_hash: h('Rina', '3333'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'K1', name: 'Kurma Sukari 1 kg', category: 'Kurma', unit: 'pak', cost_price: 50000, retail_price: 70000, stock: 0, shop_stock: 0, active: true });
  insert(db, 'pos_products', { id: 2, sku: 'K2', name: 'Kurma Ajwa 1 kg', category: 'Kurma', unit: 'pak', cost_price: 150000, retail_price: 200000, stock: 0, shop_stock: 0, active: true });
  insert(db, 'pos_shifts', { id: 21, shift_id: 'SHS', cashier: 'Siti', status: 'open', opening_cash: 1000000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '', shift_date: today });
  insert(db, 'pos_photos', { id: 60, photo_id: 'PHCAR1', kind: 'biaya', user: 'Siti', extracted: JSON.stringify({ items: [], readable: false }), match_status: 'perlu_cek', match_notes: '' });
  insert(db, 'pos_photos', { id: 61, photo_id: 'PHCAR2', kind: 'biaya', user: 'Siti', extracted: JSON.stringify({ items: [], readable: false }), match_status: 'perlu_cek', match_notes: '' });
  insert(db, 'pos_photos', { id: 62, photo_id: 'PHSLIP', kind: 'bayar', user: 'Siti', extracted: JSON.stringify({ amount: 200000, readable: true }), match_status: '', match_notes: '' });
  insert(db, 'pos_photos', { id: 63, photo_id: 'PHNOTE', kind: 'masuk', user: 'Siti', extracted: JSON.stringify({ items: [{ name: 'KURMA SUKARI', qty: 10 }], readable: true }), match_status: '', match_notes: '' });
  insert(db, 'pos_settings', { id: 1, skey: 'require_purchase_photo', svalue: 'false' });
  return db;
}
const notices = db => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();
const lines = (db, no) => db.prepare('SELECT * FROM pos_purchases WHERE purchase_no = ?').all(no);
const shift = (db, id = 'SHS') => db.prepare('SELECT * FROM pos_shifts WHERE shift_id = ?').get(id);
const count = (db, table, where = '1 = 1') => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const recv = (ad, user, items, dp, sup = 'CV Timur Tengah') => call(ad, user, 'save_purchase', { supplier: sup, carrier: { type: 'pemasok', name: 'Sopir' }, items, ...(dp ? { drawer_pay: dp } : {}) });
const SUKARI10 = [{ product_id: 1, qty: 10, cost_price: 50000, exp_none: true }]; // Rp 500.000

test('v68 "bayar barang" from the drawer: one save_purchase = the note + a supplier payment + the drawer; confirmed later without a second payment', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await recv(ad, 'Siti', SUKARI10, { amount: 500000, purpose: 'barang', note: 'Sopir minta tunai, nota lunas', photo_id: 'PHCAR1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const no = r.purchase_no;
  assert.equal(r.drawer_pay.purpose, 'barang'); assert.equal(r.drawer_pay.full, true); assert.equal(r.drawer_pay.expense, null);
  assert.equal(r.drawer_pay.shift.cash_out, 500000);
  // the supplier payment, allocated to the new note, cash from the drawer
  const pays = db.prepare("SELECT * FROM pos_payments WHERE supplier = 'CV Timur Tengah'").all();
  assert.equal(pays.length, 1);
  assert.deepEqual([pays[0].direction, pays[0].party_type, pays[0].method, pays[0].amount, pays[0].match_status, pays[0].proof_photo_id, pays[0].pay_date, pays[0].cashier], ['out', 'supplier', 'tunai', 500000, 'lunas', 'PHCAR1', today, 'Siti']);
  assert.deepEqual(JSON.parse(pays[0].alloc), [{ ref: no, amount: 500000 }]);
  assert.match(pays[0].note, new RegExp('^Barang masuk ' + no + ' dibayar tunai oleh kasir Siti \\[dari kas\\] \\| Sopir minta tunai, nota lunas$'));
  // the drawer: cash out + the move
  const sh = shift(db);
  assert.equal(sh.cash_out, 500000);
  const mv = JSON.parse(sh.moves).at(-1);
  assert.deepEqual([mv.type, mv.amount, mv.note, mv.by], ['out', 500000, 'Bayar pemasok CV Timur Tengah (' + no + ')', 'Siti']);
  // the note: paid, with its summary — but it still waits for the manager / accountant
  const ln = lines(db, no);
  assert.equal(ln.length, 1);
  assert.deepEqual([ln[0].pay_status, ln[0].pay_method, ln[0].paid_at, ln[0].check_status || ''], ['lunas', 'tunai', today, '']);
  const info = JSON.parse(ln[0].drawer_pay);
  assert.deepEqual([info.amount, info.purpose, info.note, info.by, info.photo_id, info.pay_id], [500000, 'barang', 'Sopir minta tunai, nota lunas', 'Siti', 'PHCAR1', pays[0].pay_id]);
  assert.ok(Math.abs(Date.parse(info.at) - Date.now()) < 60000, 'the time is recorded by itself');
  assert.equal(count(db, 'pos_expenses'), 0);
  // one notice to the owner, the manager and the accountant: amount, why, the note, the time, the photo
  const n = notices(db).at(-1);
  assert.equal(n.ref, 'owner,manager,akuntan');
  assert.match(n.summary, new RegExp('^Tunai dari laci Siti Rp 500\\.000 saat barang masuk ' + no + ' dari CV Timur Tengah — Bayar barang \\(ke pemasok/sopir\\): "Sopir minta tunai, nota lunas" \\(' + today + ' \\d\\d:\\d\\d WIB, foto terlampir\\) — dicatat sebagai pembayaran ke pemasok, nota lunas \\(tetap menunggu konfirmasi\\)$'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_activity WHERE kind = 'bayar_keluar' AND ref = ?").get(pays[0].pay_id).n, 1);
  const boot = await call(ad, 'Jihan', 'bootstrap', {});
  assert.ok(boot.purchase_checks.waiting.some(x => x.purchase_no === no), 'still waits for its confirmation');
  // the manager cannot put it on credit; "sudah dibayar" records nothing new (even if she taps "transfer")
  const t1 = await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: no, supplier: 'CV Timur Tengah', pay: 'tempo', due_date: today });
  assert.equal(t1.error, 'INVALID'); assert.match(t1.message, /sudah dibayar tunai oleh kasir Siti Rp 500\.000/);
  const c = await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: no, supplier: 'CV Timur Tengah', pay: 'lunas', method: 'transfer', bank: 'BCA', transfer_ref: 'X1' });
  assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(c.payment, null);
  assert.equal(count(db, 'pos_payments', "supplier = 'CV Timur Tengah'"), 1);
  assert.deepEqual(lines(db, no).map(x => [x.check_status, x.checked_by, x.pay_status, x.pay_method, x.paid_at]), [['dikonfirmasi', 'Jihan', 'lunas', 'tunai', today]]);
  assert.match(notices(db).at(-1).summary, /dikonfirmasi manajer Jihan: sudah dibayar tunai oleh kasir Siti Rp 500\.000 dari laci saat barang masuk \(tanpa pembayaran baru\)$/);
  assert.equal(shift(db).cash_out, 500000, 'the drawer is not touched again');
  // the supplier owes nothing on that note; Keuangan: it is drawer cash (not "cash outside a drawer"), the supplier is paid
  const fin = await call(ad, 'Pemilik', 'finance_position', { from: today, to: today });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(fin.drawers.find(d => d.shift_id === 'SHS').cash_out, 500000);
  assert.equal(fin.drawers.find(d => d.shift_id === 'SHS').expected, 500000);
  assert.equal(fin.none.sup_cash, 0);
  assert.equal(fin.suppliers.payable, 0);
  // the drawer close: what should be in it is the opening minus the cash paid
  const cl = await call(ad, 'Siti', 'close_shift', { counted_cash: 500000 });
  assert.equal(cl.ok, true, JSON.stringify(cl));
  assert.deepEqual([cl.shift.cash_out, cl.shift.expected_cash, cl.shift.difference], [500000, 500000, 0]);
});

test('v68 delivery fee and porters from the drawer = cashier expenses (transport) with the photo and the note; the note itself stays unpaid', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await recv(ad, 'Siti', SUKARI10, { amount: 75000, purpose: 'ongkir', note: 'Ongkos sopir pickup dari Tanah Abang', photo_id: 'PHCAR1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const no = r.purchase_no;
  assert.equal(r.drawer_pay.payment, null);
  assert.deepEqual([r.drawer_pay.expense.category, r.drawer_pay.expense.paid_from, r.drawer_pay.expense.amount], ['transport', 'kas', 75000]);
  const ex = db.prepare('SELECT * FROM pos_expenses').all();
  assert.equal(ex.length, 1);
  assert.deepEqual([ex[0].expense_date, ex[0].category, ex[0].amount, ex[0].paid_from, ex[0].photo_id, ex[0].user], [today, 'transport', 75000, 'kas', 'PHCAR1', 'Siti']);
  assert.equal(ex[0].note, 'Barang masuk ' + no + ' — Ongkos kirim / sopir: Ongkos sopir pickup dari Tanah Abang');
  assert.equal(count(db, 'pos_payments'), 0);
  const sh = shift(db);
  assert.equal(sh.cash_out, 75000);
  assert.deepEqual(JSON.parse(sh.moves).at(-1), Object.assign(JSON.parse(sh.moves).at(-1), { type: 'out', amount: 75000, note: 'Pengeluaran transport: ' + ex[0].note }));
  const ln = lines(db, no)[0];
  assert.equal(ln.pay_status || '', ''); // the goods themselves are not paid
  assert.deepEqual(JSON.parse(ln.drawer_pay), Object.assign(JSON.parse(ln.drawer_pay), { amount: 75000, purpose: 'ongkir', category: 'transport', by: 'Siti', photo_id: 'PHCAR1' }));
  assert.match(notices(db).at(-1).summary, /— Ongkos kirim \/ sopir: "Ongkos sopir pickup dari Tanah Abang" \(.* WIB, foto terlampir\) — dicatat sebagai pengeluaran transport dari laci$/);
  // porters: transport too; "lainnya": the "lain" category
  const r2 = await recv(ad, 'Siti', [{ product_id: 2, qty: 2, cost_price: 150000, exp_none: true }], { amount: 40000, purpose: 'kuli', note: '2 kuli bongkar', photo_id: 'PHCAR2' }, 'PT Kurma Jaya');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const r3 = await recv(ad, 'Siti', [{ product_id: 2, qty: 1, cost_price: 150000, exp_none: true }], { amount: 10000, purpose: 'lain', note: 'parkir mobil sopir', photo_id: 'PHSLIP' }, '');
  assert.equal(r3.ok, true, JSON.stringify(r3)); // (no supplier needed when it is not the goods' price)
  assert.deepEqual(db.prepare('SELECT category, amount FROM pos_expenses ORDER BY id').all().map(x => [x.category, x.amount]), [['transport', 75000], ['transport', 40000], ['lain', 10000]]);
  assert.equal(shift(db).cash_out, 125000);
  // it shows where every expense shows: the day's report, Laporan (get_sales), Keuangan (drawer cash, not "other money")
  const gs = await call(ad, 'Pemilik', 'get_sales', { from: today, to: today });
  assert.equal(gs.expenses.length, 3);
  const fin = await call(ad, 'Pemilik', 'finance_position', { from: today, to: today });
  assert.equal(fin.none.exp_other, 0);
  assert.equal(fin.drawers[0].cash_out, 125000);
  // the goods' payment is still the manager's choice (here: on credit)
  const c = await call(ad, 'Aqil', 'confirm_purchase', { purchase_no: no, supplier: 'CV Timur Tengah', pay: 'tempo', due_date: today });
  assert.equal(c.ok, true, JSON.stringify(c));
});

test('v68 a part of the goods\' price from the drawer: "sebagian"; the confirmation pays the rest; unknown costs = an unallocated payment', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await recv(ad, 'Siti', SUKARI10, { amount: 200000, purpose: 'barang', note: 'DP ke sopir, sisa transfer', photo_id: 'PHSLIP' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.drawer_pay.full, false);
  const p1 = db.prepare('SELECT * FROM pos_payments').get();
  assert.equal(p1.match_status, 'sebagian'); assert.deepEqual(JSON.parse(p1.alloc), [{ ref: r.purchase_no, amount: 200000 }]);
  assert.equal(lines(db, r.purchase_no)[0].pay_status || '', '');
  assert.match(notices(db).at(-1).summary, /dicatat sebagai pembayaran ke pemasok, sisa Rp 300\.000$/);
  const c = await call(ad, 'Jihan', 'confirm_purchase', { purchase_no: r.purchase_no, supplier: 'CV Timur Tengah', pay: 'lunas', method: 'transfer', bank: 'BCA', transfer_ref: 'TRX-9' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.payment.amount, 300000);
  assert.equal(count(db, 'pos_payments'), 2);
  // costs not typed (Rp 0 on the note): the payment is kept, not allocated — the owner allocates it later
  const r2 = await recv(ad, 'Siti', [{ product_id: 2, qty: 3, cost_price: 0, exp_none: true }], { amount: 450000, purpose: 'barang', note: 'harga belum tahu', photo_id: 'PHCAR2' }, 'PT Kurma Jaya');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const p2 = db.prepare("SELECT * FROM pos_payments WHERE supplier = 'PT Kurma Jaya'").get();
  assert.deepEqual([p2.amount, p2.match_status, p2.alloc], [450000, 'belum_dialokasi', '[]']);
});

test('v68 refused without the cashier\'s own open drawer, a photo, a note, an amount, a supplier, or over the note\'s total — nothing written', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const before = () => [count(db, 'pos_purchases'), count(db, 'pos_payments'), count(db, 'pos_expenses'), shift(db).cash_out, count(db, 'pos_activity')];
  const b0 = before(), dp = { amount: 100000, purpose: 'ongkir', note: 'ongkir', photo_id: 'PHCAR1' };
  const bad = [
    ['Jihan', SUKARI10, dp, 'SHIFT_REQUIRED', /Buka laci kasir/], // the manager has no drawer of her own open
    ['Rina', SUKARI10, dp, 'SHIFT_REQUIRED', /Buka laci kasir/], // another cashier's drawer is not hers
    ['Siti', SUKARI10, { ...dp, photo_id: '' }, 'INVALID', /Foto wajib/],
    ['Siti', SUKARI10, { ...dp, photo_id: 'PHNOTE' }, 'INVALID', /Foto pembayaran dari laci tidak ditemukan/], // the supplier note's photo is not the payment's
    ['Siti', SUKARI10, { ...dp, photo_id: 'PHNONE' }, 'INVALID', /tidak ditemukan/],
    ['Siti', SUKARI10, { ...dp, note: '  ' }, 'INVALID', /kenapa \/ untuk apa/],
    ['Siti', SUKARI10, { ...dp, amount: 0 }, 'INVALID', /Jumlah/],
    ['Siti', SUKARI10, { ...dp, purpose: 'gaji' }, 'INVALID', /Pilih untuk apa/],
    ['Siti', SUKARI10, { ...dp, purpose: 'barang', amount: 500001 }, 'INVALID', /melebihi total nota Rp 500\.000/],
  ];
  for (const [user, items, d, code, re] of bad) {
    const r = await recv(ad, user, items, d);
    assert.equal(r.error, code, user + ' ' + JSON.stringify(d) + ' → ' + JSON.stringify(r)); assert.match(r.message, re);
    assert.deepEqual(before(), b0, 'nothing written for ' + JSON.stringify(d));
  }
  const ns = await recv(ad, 'Siti', SUKARI10, { ...dp, purpose: 'barang' }, '');
  assert.equal(ns.error, 'INVALID'); assert.match(ns.message, /Nama pemasok wajib/);
  assert.deepEqual(before(), b0);
  // without the section: goods-in exactly as before (no payment, no expense, the drawer untouched, no summary)
  const plain = await recv(ad, 'Siti', SUKARI10, null);
  assert.equal(plain.ok, true, JSON.stringify(plain)); assert.equal(plain.drawer_pay, undefined);
  assert.deepEqual([count(db, 'pos_payments'), count(db, 'pos_expenses'), shift(db).cash_out], [0, 0, 0]);
  assert.equal(lines(db, plain.purchase_no)[0].drawer_pay, null);
  // the manager with her own drawer open may record it too (the notice then goes to the owner and the accountant)
  insert(db, 'pos_shifts', { id: 22, shift_id: 'SHJ', cashier: 'Jihan', status: 'open', opening_cash: 300000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '', shift_date: today });
  const mg = await recv(ad, 'Jihan', SUKARI10, dp);
  assert.equal(mg.ok, true, JSON.stringify(mg));
  assert.equal(shift(db, 'SHJ').cash_out, 100000); assert.equal(shift(db).cash_out, 0);
  assert.equal(notices(db).at(-1).ref, 'owner,akuntan');
});

test('v68 a cashier sees another cashier\'s cash-on-delivery without its amount (= the note\'s total); his own, the manager and the owner see it', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await recv(ad, 'Siti', SUKARI10, { amount: 500000, purpose: 'barang', note: 'lunas ke sopir', photo_id: 'PHCAR1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const dpOf = async user => JSON.parse((await call(ad, user, 'get_sales', { from: today, to: today })).purchases.find(x => x.purchase_no === r.purchase_no).drawer_pay);
  assert.equal((await dpOf('Siti')).amount, 500000);
  assert.equal((await dpOf('Jihan')).amount, 500000);
  assert.equal((await dpOf('Pemilik')).amount, 500000);
  const other = await dpOf('Rina');
  assert.equal(other.amount, undefined); assert.equal(other.by, 'Siti'); assert.equal(other.purpose, 'barang');
});
