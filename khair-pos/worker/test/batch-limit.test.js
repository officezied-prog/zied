// v39 (free Cloudflare plan: at most 50 D1 calls per request): every read of a request goes in one D1 batch and every write
// in another, so a 30-item invoice or a 200-product import stays far under the limit. d1Mock({ maxCalls: 50 }) fails the
// 51st call like D1 Free does.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, d1Mock, insert } from './shim.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  for (let i = 1; i <= 40; i++) insert(db, 'pos_products', { id: i, sku: 'S' + i, name: 'Produk ' + i, unit: 'pcs', cost_price: 1000, retail_price: 1500, stock: 100, shop_stock: 100, active: true });
  insert(db, 'pos_shifts', { id: 1, shift_id: 'SH1', cashier: 'Siti', shift_date: today(), status: 'open', opening_cash: 100000, cash_sales: 0, cash_payments: 0, cash_in: 0, cash_out: 0, sales_count: 0, sales_total: 0, moves: '[]', note: '' });
  return db;
}
const call = async (env, user, pin, action, data) => {
  env.DB.calls = 0;
  const r = await worker.fetch(new Request('https://w.test/webhook/khair-pos', { method: 'POST', body: JSON.stringify({ action, key: KEY, user, pin_hash: h(user, pin), data }) }), env);
  return { status: r.status, body: await r.json(), calls: env.DB.calls };
};

test('a 30-item invoice is saved in a handful of D1 calls (was 91 queries; the free plan allows 50)', async () => {
  const db = seed(), env = { DB: d1Mock(db, { maxCalls: 50 }), STORE_KEY: KEY };
  await call(env, 'Siti', '1111', 'bootstrap', {}); // first request of the isolate also runs the self-migrations
  const items = Array.from({ length: 30 }, (_, i) => ({ product_id: i + 1, qty: 2, unit_price: 1500 }));
  const r = await call(env, 'Siti', '1111', 'save_sale', { client_id: 'big-1', sale_date: today(), items, payment_method: 'tunai', paid_amount: 90000 });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.ok, true, JSON.stringify(r.body).slice(0, 200));
  assert.ok(r.calls <= 6, 'D1 calls: ' + r.calls);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pos_sale_items WHERE invoice_no = ?').get(r.body.invoice_no).c, 30);
  assert.equal(db.prepare('SELECT stock FROM pos_products WHERE id = 30').get().stock, 98);
});

test('importing 200 products in one request works under the limit; a failing write rolls the whole batch back', async () => {
  const db = seed(), env = { DB: d1Mock(db, { maxCalls: 50 }), STORE_KEY: KEY };
  const rows = Array.from({ length: 200 }, (_, i) => ({ name: 'Impor ' + i, sku: 'IMP' + i, retail_price: 1000 + i }));
  const r = await call(env, 'Pemilik', '1234', 'import_products', { rows });
  assert.equal(r.body.ok, true, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.created, 200);
  assert.ok(r.calls <= 6, 'D1 calls: ' + r.calls);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pos_products WHERE sku LIKE 'IMP%'").get().c, 200);
  // all or nothing: a batch with a bad statement leaves no half-written rows
  const { sqliteAdapter } = await import('./shim.js');
  const ad = sqliteAdapter(db);
  assert.throws(() => ad.batch([{ sql: "INSERT INTO pos_products (sku, name) VALUES ('HALF', 'Half')", params: [], kind: 'run' }, { sql: 'INSERT INTO no_such_table VALUES (1)', params: [], kind: 'run' }]));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pos_products WHERE sku = 'HALF'").get().c, 0);
});

test('GET …/health/batch answers ok with 60 statements in one batch', async () => {
  const env = { DB: d1Mock(seed(), { maxCalls: 50 }), STORE_KEY: KEY };
  const r = await worker.fetch(new Request('https://w.test/webhook/khair-pos/health/batch'), env);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.batch, 60);
  assert.equal(env.DB.calls, 1);
});
