// v38 free-plan protection: the frequent polls skip the two big tables (every product, every customer).
// For each light action and role, the answer and the writes must be exactly what the full load gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { parseRequest } from '../src/parse.js';
import { execSpecs, loaderSpecs, makeAccessor, LIGHT_ACTIONS } from '../src/db.js';
import { runProcess } from '../src/generated/process.gen.js';
import { parseField, fieldSpecs, FIELD_LIGHT } from '../src/field.js';
import { runProcessField } from '../src/generated/process-field.gen.js';
import { ensurePosSchema } from '../src/core.js';
import { finalize } from '../src/finalize.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const DAY = '2026-10-12';
const USERS = { Pemilik: ['owner', '1234'], Jihan: ['manager', '2222'], Aqil: ['akuntan', '4444'], Siti: ['kasir', '1111'], Rani: ['sales', '3333'] };

function seed() {
  const db = newDb();
  let id = 1;
  for (const [name, [role, pin]] of Object.entries(USERS)) insert(db, 'pos_users', { id: id++, name, role, pin_hash: h(name, pin), active: true });
  for (let i = 1; i <= 40; i++) insert(db, 'pos_products', { id: i, sku: '89' + (1000 + i), name: 'Produk ' + i, category: 'Food', unit: 'pcs', cost_price: 1000 * i, retail_price: 1300 * i, stock: i % 7, shop_stock: i % 5, min_stock: 3, active: true });
  for (let i = 1; i <= 15; i++) insert(db, 'pos_customers', { id: i, name: 'Pelanggan ' + i, phone: '0812' + i, type: i % 2 ? 'grosir' : 'eceran', debt_balance: i * 1000 });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SH1', cashier: 'Siti', shift_date: DAY, status: 'open', opening_cash: 100000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  for (let i = 1; i <= 6; i++) {
    insert(db, 'pos_sales', { id: i, invoice_no: 'INV' + i, sale_date: DAY, sale_time: DAY + 'T0' + i + ':00:00.000Z', cashier: i % 2 ? 'Siti' : 'Jihan', customer_id: i, customer_name: 'Pelanggan ' + i, total: 5000 * i, subtotal: 5000 * i, discount: 0, payment_method: 'tunai', paid_amount: 5000 * i, debt_amount: 0, status: 'selesai', profit: 900 * i, total_cost: 4100 * i });
    insert(db, 'pos_sale_items', { id: i, invoice_no: 'INV' + i, sale_date: DAY, product_id: i, name: 'Produk ' + i, qty: 1, unit_price: 5000 * i, cost_price: 4100 * i, line_total: 5000 * i, line_profit: 900 * i });
  }
  insert(db, 'pos_payments', { id: 1, pay_id: 'PY1', pay_date: DAY, direction: 'in', party_type: 'customer', customer_id: 3, customer_name: 'Pelanggan 3', amount: 2000, method: 'tunai', cashier: 'Siti' });
  insert(db, 'pos_expenses', { id: 1, expense_date: DAY, category: 'transport', amount: 7000, note: 'ojek', user: 'Siti', paid_from: 'kas' });
  insert(db, 'pos_approvals', { id: 1, request_id: 'AP1', created_at: DAY + 'T02:00:00.000Z', cashier: 'Siti', customer_id: 2, customer_name: 'Pelanggan 2', total: 90000, debt_amount: 90000, summary: 'Hutang', status: 'pending', kind: 'hutang', approver_role: 'manager', payload: '{}' });
  insert(db, 'pos_approvals', { id: 2, request_id: 'AP2', created_at: DAY + 'T02:10:00.000Z', cashier: 'Siti', total: 5000, summary: 'Batal INV1', status: 'pending', kind: 'void', ref: 'INV1', approver_role: 'mgr_akuntan', payload: '{}' });
  insert(db, 'pos_activity', { id: 1, act_date: DAY, at: DAY + 'T02:00:00.000Z', user: 'Siti', kind: 'jual', summary: 'Jual INV1', level: 'info', act_id: 'A1' });
  insert(db, 'pos_devices', { id: 1, device_id: 'DEVICE-0001', user: 'Siti', role: 'kasir', last_seen: DAY + 'T01:00:00.000Z' });
  return db;
}

function frozen(fn) {
  const RealDate = Date, FIXED = RealDate.parse(DAY + 'T05:00:00.000Z'), oR = Math.random;
  let s = 4242;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = oR; }
}

const CASES = [
  ...['Pemilik', 'Jihan', 'Aqil', 'Siti'].map((u) => ['list_approvals', u, {}]),
  ['check_approval', 'Siti', { request_id: 'AP1' }],
  ['check_approval', 'Siti', { request_id: 'AP2' }],
  ...['Pemilik', 'Jihan', 'Aqil', 'Siti'].map((u) => ['get_sales', u, { from: DAY, to: DAY }]),
  ['list_activity', 'Pemilik', { from: DAY, to: DAY }],
  ['list_activity', 'Jihan', { from: DAY, to: DAY }],
  ['list_purchases', 'Jihan', { from: DAY, to: DAY }], // v72: the goods-in history of any period
  ['list_purchases', 'Siti', { from: DAY, to: DAY, supplier: 'pt' }],
  ...['Pemilik', 'Siti', 'Rani'].map((u) => ['device_ping', u, { device: { id: 'DEVICE-0001', app: 'kasir', lat: -6.26, lng: 106.86, acc: 12 } }]),
];

test('every light POS action answers and writes exactly as with every product and customer loaded', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  await ensurePosSchema(ad);
  const seen = new Set();
  for (const [action, user, data] of CASES) {
    seen.add(action);
    const req = parseRequest({ action, key: KEY, user, pin_hash: h(user, USERS[user][1]), data }, {});
    const light = loaderSpecs(req), full = loaderSpecs(req, { full: true });
    assert.equal('Get Products' in light, false, action + ' must not read every product');
    assert.equal('Get Customers' in light, false, action + ' must not read every customer');
    assert.ok('Get Products' in full);
    const run = async (specs) => {
      const nodes = await execSpecs(ad, specs); nodes['Parse Request'] = [req];
      return frozen(() => runProcess(makeAccessor(nodes), KEY)[0].json);
    };
    const a = await run(light), b = await run(full);
    assert.deepEqual(a.response, b.response, `${action} as ${user}: same answer`);
    const refused = (action === 'list_approvals' && user === 'Siti') || (action === 'list_activity' && user !== 'Pemilik');
    assert.equal(a.response.ok, !refused, `${action} as ${user}: ${JSON.stringify(a.response).slice(0, 120)}`);
    assert.deepEqual(a.ops, b.ops, `${action} as ${user}: same writes`);
  }
  assert.deepEqual([...seen].sort(), [...LIGHT_ACTIONS].sort(), 'every light action is covered here');
});

test('the heavy actions still load every product and customer', () => {
  for (const action of ['bootstrap', 'save_sale', 'save_purchase', 'daily_report', 'import_products', 'stock_count']) {
    const specs = loaderSpecs(parseRequest({ action, key: KEY, user: 'Pemilik', pin_hash: 'x', data: { date: DAY } }, {}));
    assert.ok('Get Products' in specs && 'Get Customers' in specs, action);
  }
});

test('field GPS batch (track) answers and writes the same without every product and customer', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const body = { action: 'track', key: KEY, user: 'Rani', pin_hash: h('Rani', '3333'), data: { points: [{ lat: -6.26, lng: 106.86, t: DAY + 'T04:00:00.000Z', acc: 9 }, { lat: -6.261, lng: 106.861, t: DAY + 'T04:03:00.000Z', acc: 9 }] } };
  const req = parseField(body, {});
  insert(db, 'pos_field_days', { id: 1, user: 'Rani', day_date: req.today, started_at: req.today + 'T01:00:00.000Z', ended_at: '' });
  const light = fieldSpecs(req), full = fieldSpecs(req, { full: true });
  assert.equal('Get Products' in light || 'Get Customers' in light, false);
  const run = async (specs) => { const nodes = await execSpecs(ad, specs); nodes['Parse Field'] = [req]; return frozen(() => runProcessField(makeAccessor(nodes), KEY)[0].json); };
  const a = await run(light), b = await run(full);
  assert.deepEqual(a.response, b.response);
  assert.deepEqual(a.ops, b.ops);
  assert.equal(a.response.saved, 2);
  assert.deepEqual(FIELD_LIGHT, ['track']);
});

test('finalize fills new ids without copying the whole answer, and leaves the input untouched', () => {
  const big = { ok: true, products: Array.from({ length: 3 }, (_, i) => ({ id: i + 1 })), customer: { id: null, name: 'Baru' } };
  const out = finalize(big, { customers: [{ id: 99, name: 'Baru' }] });
  assert.equal(out.customer.id, 99);
  assert.equal(big.customer.id, null);
  assert.equal(out.products, big.products); // shared, not copied
  assert.deepEqual(finalize({ ok: false, error: 'X' }, {}), { ok: false, error: 'X' });
});

test('D1 meter: every request adds the rows it read / wrote to today; only the owner sees it (with yesterday)', async () => {
  const { d1Mock } = await import('./shim.js');
  const { default: worker, recordUsage } = await import('../src/index.js');
  const db = seed();
  const env = { DB: d1Mock(db), STORE_KEY: KEY };
  const post = (user, action, data = {}) => worker.fetch(new Request('https://w.test/webhook/khair-pos', { method: 'POST', body: JSON.stringify({ action, key: KEY, user, pin_hash: h(user, USERS[user][1]), data }) }), env).then((r) => r.json());
  const day = new Date().toISOString().slice(0, 10), yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  insert(db, 'pos_api_usage', { id: 50, api: 'd1_read', month: yday, n: 3200000, updated_at: '' });
  const r1 = await post('Pemilik', 'list_approvals');
  assert.equal(r1.ok, true);
  const n1 = db.prepare("SELECT SUM(n) n FROM pos_api_usage WHERE api = 'd1_read' AND month = ?").get(day).n;
  assert.ok(n1 > 0, 'the first request was counted');
  const r2 = await post('Pemilik', 'list_approvals');
  assert.equal(r2.usage.read, n1); // the second answer shows what the first one used
  assert.equal(r2.usage.y_read, 3200000);
  assert.equal(r2.usage.read_limit, 5000000);
  assert.ok(db.prepare("SELECT SUM(n) n FROM pos_api_usage WHERE api = 'd1_read' AND month = ?").get(day).n > n1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pos_api_usage WHERE api = 'd1_read' AND month = ?").get(day).c, 1); // one row a day, updated
  const m = await post('Jihan', 'list_approvals');
  assert.equal(m.ok, true);
  assert.equal('usage' in m, false); // the manager does not get it
  // a broken counter never breaks anything
  await recordUsage({ prepare() { throw new Error('down'); } }, { read: 5, write: 1 });
});
