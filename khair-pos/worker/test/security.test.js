// v71 security (owner 2026-10-21: «حماية التطبيق حتى لا يتمكن أي شخص من اختراقه … يجب أن يكون محاط بسرية تامة ولا تخرج المعلومات
// لأي شخص آخر»): one login gate in front of every endpoint (the store key before any read; wrong PINs counted and locked on all of
// them, longer each time, the owner told), and nobody receives data that is not theirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, d1Mock, sqliteAdapter, insert } from './shim.js';
import worker from '../src/index.js';
import { lockMinutes, safeEqual } from '../src/authgate.js';
import { handleField } from '../src/field.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const MASTER = crypto.createHash('sha256').update(KEY + ':__master__:87654321').digest('hex');
const DAY = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 7 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const ROUTES = ['khair-pos', 'khair-field', 'khair-chat', 'khair-att', 'khair-cold', 'khair-brad', 'khair-pos-photo'];

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), master_hash: MASTER, active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Rani', role: 'sales', pin_hash: h('Rani', '3333'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Dewi', role: 'kasir', pin_hash: h('Dewi', '4444'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, shop_stock: 20, active: true,
    repack_costs: JSON.stringify([{ name: 'Stiker', cost: 500 }, { name: 'Toples', cost: 2500 }]) });
  return db;
}
const env = (db) => ({ DB: d1Mock(db), STORE_KEY: KEY });
async function post(e, route, body) {
  e.DB.calls = 0;
  const r = await worker.fetch(new Request('https://w.test/webhook/' + route, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), e);
  return { status: r.status, body: await r.json(), calls: e.DB.calls };
}
const as = (user, pin, action, data = {}) => ({ action, key: KEY, user, pin_hash: pin.length === 64 ? pin : h(user, pin), data });
const userRow = (db, name) => ({ ...db.prepare('SELECT fail_count, locked_until FROM pos_users WHERE name = ?').get(name) });

test('lock tiers: 5 → 15 min, 10 → 1 h, 15 → 6 h, 20 and more → 24 h; none in between', () => {
  assert.deepEqual([1, 4, 5, 6, 9, 10, 15, 20, 25, 40].map(lockMinutes), [0, 0, 15, 0, 0, 60, 360, 1440, 1440, 1440]);
  assert.equal(safeEqual('abc', 'abc'), true); assert.equal(safeEqual('abc', 'abd'), false); assert.equal(safeEqual('abc', 'abcd'), false);
});

test('a wrong store key is refused on EVERY endpoint before any table is read (no flood can use up the daily reads)', async () => {
  const e = env(seed());
  for (const route of ROUTES) {
    for (const body of [{ action: 'bootstrap', key: 'WRONG', user: 'Pemilik', pin_hash: h('Pemilik', '1234') }, 'not json at all', {}]) {
      const r = await post(e, route, body);
      assert.equal(r.body.error, 'BAD_KEY', route + ' ' + JSON.stringify(r.body));
      assert.equal(r.calls, 0, route + ': no D1 call for a wrong key');
    }
  }
  // an unknown name costs one small read (the users), never the shop's tables
  const u = await post(e, 'khair-pos', as('Nobody', '1234', 'bootstrap'));
  assert.equal(u.body.error, 'BAD_PIN'); assert.equal(u.calls, 1);
});

test('wrong PINs are counted on every endpoint together: the 5th locks the account everywhere, the owner is told', async () => {
  const db = seed(), e = env(db);
  const wrong = (route) => post(e, route, as('Pemilik', '0000', 'bootstrap'));
  for (const route of ['khair-chat', 'khair-pos-photo', 'khair-field', 'khair-att']) {
    const r = await wrong(route);
    assert.equal(r.body.error, 'BAD_PIN', route);
  }
  assert.equal(userRow(db, 'Pemilik').fail_count, 4);
  const fifth = await wrong('khair-cold');
  assert.equal(fifth.body.error, 'LOCKED', JSON.stringify(fifth.body));
  assert.match(fifth.body.message, /Coba lagi .*WIB/);
  // locked: even the right PIN waits, on any endpoint
  const right = await post(e, 'khair-pos', as('Pemilik', '1234', 'bootstrap'));
  assert.equal(right.body.error, 'LOCKED');
  const act = db.prepare("SELECT * FROM pos_activity WHERE kind = 'keamanan'").all();
  assert.equal(act.length, 1);
  assert.equal(act[0].level, 'danger');
  assert.match(act[0].summary, /PIN salah 5 kali .* Pemilik .* 15 menit/);
  // the lock ends: the right PIN works again and resets the count
  db.prepare("UPDATE pos_users SET locked_until = ? WHERE name = 'Pemilik'").run(new Date(Date.now() - 1000).toISOString());
  const ok = await post(e, 'khair-pos', as('Pemilik', '1234', 'bootstrap'));
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body).slice(0, 200));
  assert.deepEqual(userRow(db, 'Pemilik'), { fail_count: 0, locked_until: '' });
});

test('longer locks after more wrong PINs (1 h at 10, 24 h at 20); the master code still opens an account', async () => {
  const db = seed(), e = env(db);
  db.prepare("UPDATE pos_users SET fail_count = 9 WHERE name = 'Siti'").run();
  const t0 = Date.now(), r = await post(e, 'khair-chat', as('Siti', '0000', 'chat_bootstrap'));
  assert.equal(r.body.error, 'LOCKED');
  const mins = (Date.parse(r.body.locked_until) - t0) / 60000;
  assert.ok(mins > 59 && mins < 61, String(mins));
  db.prepare("UPDATE pos_users SET fail_count = 19, locked_until = '' WHERE name = 'Siti'").run();
  const r2 = await post(e, 'khair-att', as('Siti', '0000', 'att_bootstrap'));
  assert.ok((Date.parse(r2.body.locked_until) - Date.now()) / 3600000 > 23.9);
  // the owner's master code passes the gate (the handlers decide what it may do)
  const m = await post(e, 'khair-pos', as('Jihan', MASTER, 'login'));
  assert.equal(m.body.ok, true, JSON.stringify(m.body));
});

test('the photo file GET counts wrong PINs too (401), like every endpoint', async () => {
  const db = seed(), e = env(db);
  const get = (pin) => worker.fetch(new Request('https://w.test/webhook/khair-pos-photo/file/PHX', { headers: { 'X-Khair-Key': KEY, 'X-Khair-User': 'Jihan', 'X-Khair-Pin': h('Jihan', pin) } }), e);
  const r = await get('0000');
  assert.equal(r.status, 401);
  assert.equal(userRow(db, 'Jihan').fail_count, 1);
  const bad = await worker.fetch(new Request('https://w.test/webhook/khair-pos-photo/file/PHX', { headers: { 'X-Khair-Key': 'WRONG', 'X-Khair-User': 'Jihan', 'X-Khair-Pin': h('Jihan', '2222') } }), e);
  assert.equal(bad.status, 401); assert.equal((await bad.json()).error, 'BAD_KEY');
});

test('the POS login list still needs only the store key', async () => {
  const e = env(seed());
  const r = await post(e, 'khair-pos', { action: 'users', key: KEY });
  assert.equal(r.body.ok, true);
  assert.ok(r.body.users.some((u) => u.name === 'Siti'));
  assert.ok(r.body.users.every((u) => !('pin_hash' in u) && !('master_hash' in u)));
});

test('a master-code session cannot change an owner account or make a new owner', async () => {
  const db = seed(), e = env(db);
  const r = await post(e, 'khair-pos', as('Pemilik', MASTER, 'save_user', { name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '9999') }));
  assert.equal(r.body.error, 'FORBIDDEN', JSON.stringify(r.body));
  assert.equal(db.prepare("SELECT pin_hash FROM pos_users WHERE name = 'Pemilik'").get().pin_hash, h('Pemilik', '1234'));
  const r2 = await post(e, 'khair-pos', as('Pemilik', MASTER, 'save_user', { name: 'Baru', role: 'owner', pin_hash: h('Baru', '5555') }));
  assert.equal(r2.body.error, 'FORBIDDEN');
  // with the owner's own PIN it still works
  const r3 = await post(e, 'khair-pos', as('Pemilik', '1234', 'save_user', { name: 'Baru', role: 'kasir', pin_hash: h('Baru', '5555') }));
  assert.equal(r3.body.ok, true, JSON.stringify(r3.body));
});

test('a cashier\'s get_sales: last 62 days of sales and goods-in only, own drawer without the blind-count figures', async () => {
  const db = seed(), e = env(db);
  insert(db, 'pos_sales', { id: 1, invoice_no: 'A1', sale_date: DAY, sale_time: DAY + 'T09:00:00+07:00', cashier: 'Siti', total: 1000, status: 'ok', client_id: 'a1' });
  insert(db, 'pos_sales', { id: 2, invoice_no: 'OLD', sale_date: daysAgo(90), sale_time: daysAgo(90) + 'T09:00:00+07:00', cashier: 'Siti', total: 5000, status: 'ok', client_id: 'o1' });
  insert(db, 'pos_payments', { id: 1, pay_date: DAY, customer_name: 'X', amount: 99000, method: 'tunai', cashier: 'Jihan' });
  insert(db, 'pos_expenses', { id: 1, expense_date: DAY, category: 'gaji', amount: 3000000, user: 'Jihan' });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SH1', cashier: 'Siti', shift_date: DAY, status: 'open', opening_cash: 100000, cash_sales: 777000, expected_cash: 877000, sales_total: 777000, cash_payments: 0, moves: '[]' });
  insert(db, 'pos_shifts', { id: 2, shift_id: 'SH2', cashier: 'Dewi', shift_date: DAY, status: 'closed', opening_cash: 100000, cash_sales: 50000, expected_cash: 150000, difference: -20000, moves: '[]' });
  const r = await post(e, 'khair-pos', as('Siti', '1111', 'get_sales', { from: daysAgo(120), to: DAY }));
  assert.equal(r.body.ok, true, JSON.stringify(r.body).slice(0, 200));
  assert.deepEqual(r.body.sales.map((s) => s.invoice_no), ['A1']);
  assert.deepEqual(r.body.payments, []); assert.deepEqual(r.body.expenses, []);
  assert.deepEqual(r.body.shifts.map((s) => s.shift_id), ['SH1']);
  assert.equal(r.body.shifts[0].cash_sales, undefined); assert.equal(r.body.shifts[0].expected_cash, undefined);
  // the manager still reads everything
  const m = await post(e, 'khair-pos', as('Jihan', '2222', 'get_sales', { from: daysAgo(120), to: DAY }));
  assert.equal(m.body.sales.length, 2); assert.equal(m.body.payments.length, 1); assert.equal(m.body.shifts.length, 2);
});

test('a sales rep gets no POS bootstrap; a cashier\'s settings carry no cold-store / driver / lock / agreement data', async () => {
  const db = seed(), e = env(db);
  for (const [k, v] of [['brad_coolers', '[{"name":"DPP","wa":"62811"}]'], ['cold_drivers', '[{"n":"Budi","p":"62822"}]'], ['locked_accounts', '["dewi"]'],
    ['limit_agreements', '{"x":1}'], ['store_name', '"Khair Mart"'], ['wa_owner_number', '"62833"']]) insert(db, 'pos_settings', { skey: k, svalue: v });
  const s = await post(e, 'khair-pos', as('Rani', '3333', 'bootstrap'));
  assert.equal(s.body.error, 'FORBIDDEN');
  const k = await post(e, 'khair-pos', as('Siti', '1111', 'bootstrap'));
  assert.equal(k.body.ok, true, JSON.stringify(k.body).slice(0, 200));
  for (const key of ['brad_coolers', 'cold_drivers', 'locked_accounts', 'limit_agreements', 'acct_opening']) assert.equal(k.body.settings[key], undefined, key);
  assert.equal(k.body.settings.store_name, 'Khair Mart'); assert.equal(k.body.settings.wa_owner_number, '62833'); // still used by Khair Kasir
  const o = await post(e, 'khair-pos', as('Pemilik', '1234', 'bootstrap'));
  assert.ok(Array.isArray(o.body.settings.brad_coolers));
});

test('a manager\'s notices hide cost prices and margins unless the owner lets her see costs', async () => {
  const db = seed(), e = env(db);
  insert(db, 'pos_activity', { act_id: 'AC1', at: new Date().toISOString(), act_date: DAY, user: 'Siti', role: 'kasir', kind: 'notifikasi', ref: 'owner,manager',
    summary: 'Permintaan ubah harga oleh Siti: Kurma cost_price 150000→160000 | laba 12% → 8% (Rp 20000 → Rp 15000)', amount: 0, level: 'info' });
  const m = await post(e, 'khair-pos', as('Jihan', '2222', 'bootstrap'));
  const n = (m.body.notifications || []).find((x) => x.act_id === 'AC1');
  assert.ok(n, 'the notice reaches the manager');
  assert.match(n.summary, /cost_price \(rahasia\)/); assert.doesNotMatch(n.summary, /150000|laba/);
  const o = await post(e, 'khair-pos', as('Pemilik', '1234', 'bootstrap'));
  assert.match(o.body.notifications.find((x) => x.act_id === 'AC1').summary, /150000→160000 \| laba 12%/);
});

test('the photo list is for the owner, manager and accountant; supplier unit prices follow the cost setting', async () => {
  const db = seed(), e = env(db);
  insert(db, 'pos_photos', { photo_id: 'PH1', kind: 'masuk', ref: '', created_at: new Date().toISOString(), photo_date: DAY, user: 'Siti', extracted: JSON.stringify({ supplier: 'CV A', items: [{ name: 'Kurma', qty: 5, unit_price: 140000, total: 700000 }] }), match_status: '' });
  const k = await post(e, 'khair-pos-photo', as('Siti', '1111', 'list_photos', { from: DAY, to: DAY }));
  assert.equal(k.body.error, 'FORBIDDEN');
  const r = await post(e, 'khair-pos-photo', as('Rani', '3333', 'list_photos', { from: DAY, to: DAY }));
  assert.equal(r.body.error, 'FORBIDDEN');
  const m = await post(e, 'khair-pos-photo', as('Jihan', '2222', 'list_photos', { from: DAY, to: DAY }));
  assert.equal(m.body.ok, true, JSON.stringify(m.body));
  assert.equal(m.body.photos[0].extracted.items[0].unit_price, undefined);
  assert.equal(m.body.photos[0].extracted.items[0].qty, 5);
  insert(db, 'pos_settings', { skey: 'akuntan_sees_cost', svalue: 'true' });
  const m2 = await post(e, 'khair-pos-photo', as('Jihan', '2222', 'list_photos', { from: DAY, to: DAY }));
  assert.equal(m2.body.photos[0].extracted.items[0].unit_price, 140000);
  const o = await post(e, 'khair-pos-photo', as('Pemilik', '1234', 'list_photos', { from: DAY, to: DAY }));
  assert.equal(o.body.photos[0].extracted.items[0].unit_price, 140000);
});

test('the field app gives a rep a pack\'s material names only, never their prices', async () => {
  const db = seed();
  const r = await handleField(sqliteAdapter(db), as('Rani', '3333', 'field_bootstrap'), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  const p = r.products.find((x) => x.id === 1);
  assert.deepEqual(JSON.parse(p.repack_costs), [{ n: 'Stiker' }, { n: 'Toples' }]);
  assert.equal(p.cost_price, undefined);
});
