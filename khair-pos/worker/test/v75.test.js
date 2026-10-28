// v75 (2026-10-28 review: on 2026-10-27 the server read 2,477,882 rows for 13 sales): the reads every request makes go through
// an index, never a whole-table scan of a table that grows (an open `>= ?` range with ORDER BY id, an OR across columns, a
// lookup with no index); the goods-in attention lists only at bootstrap; the usage meter never adds a day's row twice; the
// self-migrations run once per database, not once per Worker instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, d1Mock, insert, sqliteAdapter } from './shim.js';
import worker, { recordUsage } from '../src/index.js';
import { loaderSpecs } from '../src/db.js';
import { parseRequest } from '../src/parse.js';
import { POS_MIGRATIONS, ensurePosSchema, _resetPosSchemaForTests } from '../src/core.js';
import { FIELD_MIGRATIONS } from '../src/field.js';
import { CACHE_TABLES, _clearTableCacheForTests } from '../src/tablecache.js';
import { runMigrations, PER_REQUEST } from '../src/migrate.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const DAY = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Rani: '3333' };

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Rani', role: 'sales', pin_hash: h('Rani', '3333'), active: true });
  for (let i = 1; i <= 5; i++) insert(db, 'pos_products', { id: i, sku: 'S' + i, name: 'Produk ' + i, unit: 'pcs', cost_price: 1000, retail_price: 1500, stock: 100, shop_stock: 100, active: true });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SH1', cashier: 'Siti', shift_date: DAY, status: 'open', opening_cash: 0, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  for (let i = 1; i <= 40; i++) insert(db, 'pos_purchases', { id: i, purchase_no: 'PB' + (i % 8), purchase_date: DAY, supplier: 'CV Sumber Makmur', product_id: 1, name: 'Produk 1', qty: 1, cost_price: 1000, total: 1000 });
  return db;
}
// every statement the Worker sends, with its parameters
function capture(db) {
  const B = d1Mock(db), seen = [], prep = B.prepare.bind(B);
  B.prepare = (sql) => { const p = prep(sql); return { bind: (...params) => { seen.push({ sql, params }); return p.bind(...params); } }; };
  return { B, seen };
}
async function post(B, route, user, action, data = {}) {
  const r = await worker.fetch(new Request('https://w.test/webhook/' + route, { method: 'POST', body: JSON.stringify({ action, key: KEY, user, pin_hash: h(user, PIN[user]), data }) }), { DB: B, STORE_KEY: KEY });
  return r.json();
}
const WHOLE = /^SELECT \* FROM (\w+) ORDER BY id$/;
// small tables a lookup may read whole (a few rows that do not grow with the business): the settings, and the staff accounts
// the login gate checks on every request (src/authgate.js)
const SMALL = new Set(['pos_settings', 'pos_users', 'sqlite_master']);

test('v75: no read of the frequent requests scans a whole table that grows — each goes through an index', async () => {
  _clearTableCacheForTests(); _resetPosSchemaForTests();
  const db = seed(), { B, seen } = capture(db);
  const runs = [
    ['khair-pos', 'Siti', 'login'], ['khair-pos', 'Siti', 'bootstrap'], ['khair-pos', 'Siti', 'bootstrap'],
    ['khair-pos', 'Siti', 'device_ping', { device: { id: 'D1' } }], ['khair-pos', 'Siti', 'check_approval', { request_id: 'AP123' }],
    ['khair-pos', 'Siti', 'save_sale', { client_id: 'c1', sale_date: DAY, sale_time: DAY + 'T10:00:00+07:00', items: [{ product_id: 1, qty: 1, unit_price: 1500 }], discount: 0, payment_method: 'tunai', paid_amount: 1500 }],
    ['khair-pos', 'Pemilik', 'bootstrap'], ['khair-pos', 'Pemilik', 'list_approvals'], ['khair-pos', 'Jihan', 'bootstrap'],
    ['khair-pos', 'Jihan', 'party_ledger', { supplier: 'CV Sumber Makmur' }], ['khair-pos', 'Pemilik', 'get_sales', { from: DAY, to: DAY }],
    ['khair-pos', 'Pemilik', 'list_purchases', { from: DAY, to: DAY }], ['khair-pos', 'Pemilik', 'daily_report', { date: DAY }],
    ['khair-field', 'Rani', 'field_bootstrap'], ['khair-field', 'Rani', 'track', { points: [{ lat: -6.2, lng: 106.8, t: new Date().toISOString(), acc: 9 }] }],
    ['khair-field', 'Pemilik', 'list_field', { from: DAY, to: DAY }],
    ['khair-chat', 'Siti', 'chat_bootstrap'], ['khair-chat', 'Siti', 'chat_poll', { cursors: {} }],
    ['khair-att', 'Pemilik', 'att_bootstrap'],
  ];
  for (const [route, user, action, data] of runs) {
    const r = await post(B, route, user, action, data);
    assert.notEqual(r.error, 'SERVER', route + ' ' + action + ': ' + JSON.stringify(r).slice(0, 160));
  }
  const bad = new Map();
  for (const { sql, params } of seen) {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) continue;
    const w = WHOLE.exec(sql);
    if (w && CACHE_TABLES.has(w[1])) continue; // read whole on purpose, kept in memory by version (src/tablecache.js)
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((x) => x.detail);
    for (const step of plan) {
      const m = /^SCAN (\w+)(?! USING)/.exec(step);
      if (m && !/USING (COVERING )?INDEX/.test(step) && !SMALL.has(m[1])) bad.set(sql.slice(0, 140), step);
    }
  }
  assert.deepEqual([...bad].map(([s, p]) => p + '  ←  ' + s), [], 'reads that scan a whole table');
});

test('v75: the goods-in attention lists are read at bootstrap only (they read every goods-in line on each poll before)', () => {
  for (const action of ['check_approval', 'list_approvals', 'device_ping', 'save_sale', 'party_ledger', 'login', 'get_sales']) {
    const specs = loaderSpecs(parseRequest({ action, key: KEY, user: 'Jihan', pin_hash: 'x', data: {} }, {}));
    assert.equal('Get Unchecked Purchases' in specs || 'Get Due Purchases' in specs, false, action);
    assert.equal('Get D1 Usage' in specs, action === 'list_approvals', action);
  }
  const boot = loaderSpecs(parseRequest({ action: 'bootstrap', key: KEY, user: 'Jihan', pin_hash: 'x', data: {} }, {}));
  assert.ok('Get Unchecked Purchases' in boot && 'Get Due Purchases' in boot);
  assert.equal('Get D1 Usage' in boot, false);
});

test('v75: the approvals read as one UNION of index lookups gives exactly the rows of the old OR', () => {
  const db = newDb();
  const kinds = ['diskon', 'kredit', 'koreksi', 'refund', 'konsultasi', 'repack'];
  for (let i = 1; i <= 120; i++) insert(db, 'pos_approvals', { id: i, request_id: 'AP' + i, kind: kinds[i % kinds.length], status: i % 9 ? 'approved' : 'pending', client_id: 'C' + (i % 30) });
  const OLD = "SELECT * FROM pos_approvals WHERE status = ? OR request_id = ? OR request_id = ? OR (? = 1 AND kind IN ('koreksi', 'refund', 'konsultasi')) OR (kind = 'repack' AND client_id = ?) ORDER BY id";
  for (const [flag, a, b, c] of [[0, 'AP5', '__none__', 'C11'], [1, 'AP7', 'AP8', 'C5'], [0, null, null, '__none__'], [1, 'AP200', '__none__', 'C0']]) {
    const req = parseRequest({ action: flag ? 'list_corrections' : 'check_approval', key: KEY, user: 'Jihan', pin_hash: 'x', data: {} }, {});
    const spec = loaderSpecs(req)['Get Approvals'];
    const params = ['pending', a, b, flag, c];
    assert.deepEqual(db.prepare(spec.sql).all(...params), db.prepare(OLD).all(...params), JSON.stringify(params));
  }
});

test('v75: requests at the same moment never add a counter\'s row of the day twice (2026-10-27: seven rows for one)', async () => {
  const db = newDb(), B = d1Mock(db), now = new Date('2026-10-28T03:00:00Z');
  await Promise.all(Array.from({ length: 6 }, () => recordUsage(B, { read: 10, write: 1 }, now, 'pos:party_ledger')));
  const rows = db.prepare("SELECT api, n FROM pos_api_usage WHERE month = '2026-10-28' ORDER BY api").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ api: 'd1_read', n: 60 }, { api: 'd1_write', n: 6 }, { api: 'rd:pos:party_ledger', n: 60 }]);
  await recordUsage(B, { read: 5, write: 0 }, now, 'pos:party_ledger');
  assert.equal(db.prepare("SELECT n FROM pos_api_usage WHERE api = 'd1_read' AND month = '2026-10-28'").get().n, 65);
});

test('v75: the self-migrations run once per database — a new Worker instance reads one row, not the whole list again', async () => {
  const db = newDb(), ad = sqliteAdapter(db);
  _resetPosSchemaForTests();
  for (let i = 0; i < 3; i++) await ensurePosSchema(ad); // a database's first requests: at most PER_REQUEST statements each
  assert.equal(db.prepare("SELECT v FROM pos_meta WHERE k = 'schema:pos'").get().v, POS_MIGRATIONS.length);
  for (const n of ['idx_pos_api_usage_month', 'idx_pos_approvals_kind', 'idx_pos_attendance_att_date']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(n), n);
  }
  _resetPosSchemaForTests(); // a new instance
  const before = ad.calls;
  await ensurePosSchema(ad);
  assert.equal(ad.calls - before, 1, 'one read of pos_meta');
  // one request never sends more than PER_REQUEST statements (the free plan allows 50 D1 calls a request)
  const db2 = newDb(), ad2 = sqliteAdapter(db2);
  _resetPosSchemaForTests();
  await ensurePosSchema(ad2);
  assert.ok(ad2.calls <= PER_REQUEST + 3, 'calls ' + ad2.calls);
  assert.equal(db2.prepare("SELECT v FROM pos_meta WHERE k = 'schema:pos'").get().v, Math.min(PER_REQUEST, POS_MIGRATIONS.length));
  _resetPosSchemaForTests();
});

test('v75: a migration that fails (not "already there") is tried again by the next instance; the field list too', async () => {
  const db = newDb(), ad = sqliteAdapter(db);
  const list = ['CREATE TABLE IF NOT EXISTS t75 (id INTEGER PRIMARY KEY)', 'ALTER TABLE t75 ADD COLUMN a TEXT', 'ALTER TABLE t75 ADD COLUMN a TEXT', 'CREATE INDEX IF NOT EXISTS i75 ON t75_later (a)', 'ALTER TABLE t75 ADD COLUMN b TEXT'];
  assert.equal(await runMigrations(ad, 'schema:t75', list), true);
  assert.equal(db.prepare("SELECT v FROM pos_meta WHERE k = 'schema:t75'").get().v, 3); // stopped at the index on a missing table
  db.exec('CREATE TABLE t75_later (id INTEGER PRIMARY KEY, a TEXT)');
  await runMigrations(ad, 'schema:t75', list);
  assert.equal(db.prepare("SELECT v FROM pos_meta WHERE k = 'schema:t75'").get().v, 5);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'i75'").get());
  await runMigrations(ad, 'schema:field', FIELD_MIGRATIONS);
  assert.equal(db.prepare("SELECT v FROM pos_meta WHERE k = 'schema:field'").get().v, FIELD_MIGRATIONS.length);
});
