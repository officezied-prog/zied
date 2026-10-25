// v74 (owner 2026-10-25: the shop stopped at 15:00 — the free plan's 5,000,000 D1 rows a day were used up; «أريد أصلح هذه نهائياً …
// مجانية وآمنة»): the tables read whole are kept in the Worker's memory by version (src/tablecache.js), each write raises the
// version in the same D1 call, and near the limit reports / chat wait while selling goes on (QUOTA). Through the real Worker
// fetch handler over d1Mock (the D1 binding shape), as in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newDb, d1Mock, insert, sqliteAdapter } from './shim.js';
import worker from '../src/index.js';
import { CACHE_TABLES, QUOTA_SOFT, QUOTA_HARD, quotaRefusal, writtenTable, withTableCache, _clearTableCacheForTests } from '../src/tablecache.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const utcDay = () => new Date().toISOString().slice(0, 10);
const N = 1873; // the shop's products on 2026-10-25

function seed(n = N, name = 'Produk') {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  for (let i = 1; i <= n; i++) insert(db, 'pos_products', { id: i, sku: 'S' + i, name: name + ' ' + i, unit: 'pcs', cost_price: 1000, retail_price: 1500, stock: 100, shop_stock: 100, active: true });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SH1', cashier: 'Siti', shift_date: today(), status: 'open', opening_cash: 100000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const reads = (db) => (db.prepare("SELECT n FROM pos_api_usage WHERE api = 'd1_read' AND month = ?").get(utcDay()) || {}).n || 0;
async function call(env, user, pin, action, data = {}, path = '/webhook/khair-pos') {
  const db = env._db, before = reads(db);
  const r = await worker.fetch(new Request('https://w.test' + path, { method: 'POST', body: JSON.stringify({ action, key: KEY, user, pin_hash: h(user, pin), data }) }), env);
  return { status: r.status, body: await r.json(), read: reads(db) - before };
}
const envOf = (db) => ({ DB: d1Mock(db), STORE_KEY: KEY, _db: db });

test('v74: the second request reads a few dozen rows instead of every product (1,873)', async () => {
  _clearTableCacheForTests();
  const db = seed(), env = envOf(db);
  const first = await call(env, 'Siti', '1111', 'bootstrap');
  assert.equal(first.body.ok, true);
  assert.equal(first.body.products.length, N);
  assert.ok(first.read >= N, 'first read ' + first.read); // the products are read once, then kept
  const second = await call(env, 'Siti', '1111', 'bootstrap');
  assert.equal(second.body.ok, true);
  assert.equal(second.body.products.length, N);
  assert.ok(second.read < 60, 'second read ' + second.read);
  const login = await call(env, 'Siti', '1111', 'login');
  assert.equal(login.body.ok, true);
  assert.ok(login.read < 60, 'login read ' + login.read);
  // the rows read per endpoint and action are counted too
  const per = db.prepare("SELECT api, n FROM pos_api_usage WHERE month = ? AND api LIKE 'rd:%'").all(utcDay());
  assert.ok(per.some((r) => r.api === 'rd:pos:bootstrap' && r.n >= N), JSON.stringify(per));
  assert.ok(per.some((r) => r.api === 'rd:pos:login'), JSON.stringify(per));
});

test('v74: a sale changes the stock at once for every next request (the version rises in the same D1 call as the write)', async () => {
  _clearTableCacheForTests();
  const db = seed(40), env = envOf(db);
  await call(env, 'Siti', '1111', 'bootstrap');
  const s = await call(env, 'Siti', '1111', 'save_sale', { client_id: 'v74-1', sale_date: today(), items: [{ product_id: 7, qty: 3, unit_price: 1500 }], payment_method: 'tunai', paid_amount: 4500 });
  assert.equal(s.body.ok, true, JSON.stringify(s.body).slice(0, 200));
  const b = await call(env, 'Siti', '1111', 'bootstrap');
  assert.equal(b.body.products.find((p) => p.id === 7).stock, 97);
  assert.equal(db.prepare("SELECT v FROM pos_meta WHERE k = 'ver:pos_products'").get().v >= 1, true);
  // a second sale of the same product reads the new stock (not the kept one from before)
  const s2 = await call(env, 'Siti', '1111', 'save_sale', { client_id: 'v74-2', sale_date: today(), items: [{ product_id: 7, qty: 2, unit_price: 1500 }], payment_method: 'tunai', paid_amount: 3000 });
  assert.equal(s2.body.ok, true);
  assert.equal(db.prepare('SELECT stock FROM pos_products WHERE id = 7').get().stock, 95);
  // a changed price shows at once too; the user list (kept) sees a new account at once
  const p = await call(env, 'Pemilik', '1234', 'change_price', { product_id: 7, retail_price: 2100 });
  assert.equal(p.body.ok, true, JSON.stringify(p.body).slice(0, 200));
  assert.equal((await call(env, 'Siti', '1111', 'bootstrap')).body.products.find((x) => x.id === 7).retail_price, 2100);
});

test('v74: another Worker instance writing raises the version, so the kept table is read again; a write made outside the Worker shows within 30 minutes', async () => {
  _clearTableCacheForTests();
  const db = seed(10), env = envOf(db);
  await call(env, 'Siti', '1111', 'bootstrap');
  // "another instance": its own adapter over the same database
  const other = withTableCache(sqliteAdapter(db));
  await other.run('UPDATE pos_products SET retail_price = ? WHERE id = ?', [7777, 3]);
  assert.equal((await call(env, 'Siti', '1111', 'bootstrap')).body.products.find((p) => p.id === 3).retail_price, 7777);
  // outside the Worker (no version raised): the kept copy stays until its 30 minutes are over
  db.prepare('UPDATE pos_products SET retail_price = 8888 WHERE id = 3').run();
  let t = Date.now();
  const ad = withTableCache(sqliteAdapter(db), { now: () => t });
  const { execSpecs } = await import('../src/db.js');
  const all = { 'Get Products': { table: 'pos_products', sql: 'SELECT * FROM pos_products ORDER BY id', params: [] } };
  const priceOf = async () => (await execSpecs(ad, all))['Get Products'].find((p) => p.id === 3).retail_price;
  _clearTableCacheForTests();
  assert.equal(await priceOf(), 8888); // read now
  db.prepare('UPDATE pos_products SET retail_price = 9999 WHERE id = 3').run();
  assert.equal(await priceOf(), 8888); // kept
  t += 31 * 60000;
  assert.equal(await priceOf(), 9999); // read again after 30 minutes
});

test('v74: two databases never share kept rows (each has its own epoch)', async () => {
  _clearTableCacheForTests();
  const a = seed(5, 'Toko A'), b = seed(5, 'Toko B');
  assert.equal((await call(envOf(a), 'Siti', '1111', 'bootstrap')).body.products[0].name, 'Toko A 1');
  assert.equal((await call(envOf(b), 'Siti', '1111', 'bootstrap')).body.products[0].name, 'Toko B 1');
  assert.equal((await call(envOf(a), 'Siti', '1111', 'bootstrap')).body.products[0].name, 'Toko A 1');
  assert.notEqual(a.prepare("SELECT v FROM pos_meta WHERE k = 'epoch'").get().v, b.prepare("SELECT v FROM pos_meta WHERE k = 'epoch'").get().v);
});

test('v74: near the free day\'s limit reports and chat wait (QUOTA); from 90 % only what keeps the shop selling goes on', async () => {
  _clearTableCacheForTests();
  const db = seed(20), env = envOf(db);
  await call(env, 'Siti', '1111', 'bootstrap'); // makes pos_meta / pos_api_usage
  const setReads = (n) => db.prepare("UPDATE pos_api_usage SET n = ? WHERE api = 'd1_read' AND month = ?").run(n, utcDay());
  setReads(QUOTA_SOFT + 10);
  const rep = await call(env, 'Pemilik', '1234', 'get_sales', { from: today(), to: today() });
  assert.deepEqual([rep.body.ok, rep.body.error, rep.body.level], [false, 'QUOTA', 'soft']);
  assert.match(rep.body.message, /07:00 WIB/);
  const chat = await call(env, 'Siti', '1111', 'chat_poll', { cursors: {} }, '/webhook/khair-chat');
  assert.equal(chat.body.error, 'QUOTA');
  const sale = await call(env, 'Siti', '1111', 'save_sale', { client_id: 'q-1', sale_date: today(), items: [{ product_id: 2, qty: 1, unit_price: 1500 }], payment_method: 'tunai', paid_amount: 1500 });
  assert.equal(sale.body.ok, true, JSON.stringify(sale.body).slice(0, 200));
  assert.equal((await call(env, 'Pemilik', '1234', 'list_approvals')).body.ok, true); // not a report: served below 90 %
  setReads(QUOTA_HARD + 10);
  const inbox = await call(env, 'Pemilik', '1234', 'list_approvals');
  assert.deepEqual([inbox.body.error, inbox.body.level], ['QUOTA', 'hard']);
  for (const [action, data] of [['login', {}], ['bootstrap', {}], ['save_sale', { client_id: 'q-2', sale_date: today(), items: [{ product_id: 3, qty: 1, unit_price: 1500 }], payment_method: 'tunai', paid_amount: 1500 }]]) {
    const r = await call(env, 'Siti', '1111', action, data);
    assert.equal(r.body.ok, true, action + ' ' + JSON.stringify(r.body).slice(0, 160));
  }
  // the refusals are counted apart (rd:pos:quota …)
  assert.ok(db.prepare("SELECT COUNT(*) c FROM pos_api_usage WHERE month = ? AND api LIKE 'rd:%quota'").get(utcDay()).c >= 1);
  // the rule itself
  assert.equal(quotaRefusal(0, 'pos', 'get_sales'), null);
  assert.equal(quotaRefusal(QUOTA_SOFT, 'pos', 'save_sale'), null);
  assert.equal(quotaRefusal(QUOTA_HARD, 'pos', 'save_sale'), null);
  assert.equal(quotaRefusal(QUOTA_HARD, 'field', 'track'), null);
  assert.equal(quotaRefusal(QUOTA_HARD, 'pos', 'save_product'), 'hard');
});

test('v74: every table a loader reads whole is a kept table (so every write to it raises its version); the write detector', () => {
  const HERE = dirname(fileURLToPath(import.meta.url)), SRC = join(HERE, '..', 'src');
  const whole = new Set();
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(join(SRC, f), 'utf8');
    for (const m of src.matchAll(/(?:Q\.all|[^.\w]all)\('(\w+)'\)/g)) whole.add(m[1]);
  }
  assert.ok(whole.has('pos_products') && whole.has('pos_chat'), [...whole].join(','));
  for (const t of whole) assert.ok(CACHE_TABLES.has(t), t + ' is read whole but not kept');
  assert.equal(writtenTable('INSERT INTO pos_products (a) VALUES (?)'), 'pos_products');
  assert.equal(writtenTable('  UPDATE pos_users SET fail_count = 0 WHERE id = ?'), 'pos_users');
  assert.equal(writtenTable('INSERT OR IGNORE INTO pos_settings (skey) VALUES (?)'), 'pos_settings');
  assert.equal(writtenTable('DELETE FROM pos_chat WHERE id = ?'), 'pos_chat');
  assert.equal(writtenTable('ALTER TABLE pos_products ADD COLUMN x TEXT'), 'pos_products');
  assert.equal(writtenTable('SELECT * FROM pos_products'), '');
});

test('v74: if the kept-tables path itself fails (anything but QUOTA), the request reads the plain way — the cache never stops the shop', async () => {
  _clearTableCacheForTests();
  const db = seed(8), base = sqliteAdapter(db);
  const broken = Object.assign({}, base, {
    all(sql, params) { if (/pos_meta/.test(sql)) throw new Error('D1_ERROR: something odd'); return base.all(sql, params); },
    batch(list) { if (list.some((q) => /pos_meta/.test(q.sql))) throw new Error('D1_ERROR: something odd'); return base.batch(list); },
  });
  const ad = withTableCache(broken);
  const { execSpecs } = await import('../src/db.js');
  const out = await execSpecs(ad, {
    'Get Products': { table: 'pos_products', sql: 'SELECT * FROM pos_products ORDER BY id', params: [] },
    'Get Open Shifts': { table: 'pos_shifts', sql: 'SELECT * FROM pos_shifts WHERE status = ? ORDER BY id', params: ['open'] },
  });
  assert.equal(out['Get Products'].length, 8);
  assert.equal(out['Get Open Shifts'].length, 1);
  assert.equal(out['Get Products'][0].active, true); // booleans still coerced
});
