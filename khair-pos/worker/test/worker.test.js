// Tests for the Worker HTTP layer (src/index.js) — the deploy-critical shell: path routing,
// CORS, method guard, missing-config guard, and business-error-as-200. Exercised end-to-end
// against the real fetch handler over a D1-shaped mock on node:sqlite. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, d1Mock, insert } from './shim.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');

function env() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, shop_stock: 20, active: true });
  insert(db, 'pos_settings', { id: 1, skey: 'store_name', svalue: 'Khair Mart' });
  return { DB: d1Mock(db), STORE_KEY: KEY };
}
const post = (path, body) => new Request('https://khair-mart-jumla.workers.dev' + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const bootstrap = (user, pin) => ({ action: 'bootstrap', key: KEY, user, pin_hash: h(user, pin), data: {} });

test('worker: OPTIONS preflight returns CORS headers', async () => {
  const res = await worker.fetch(new Request('https://x/webhook/khair-pos', { method: 'OPTIONS' }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
});

test('worker: non-POST is rejected', async () => {
  const res = await worker.fetch(new Request('https://x/webhook/khair-pos', { method: 'GET' }), env());
  assert.equal(res.status, 405);
  const body = await res.json();
  assert.equal(body.error, 'METHOD');
});

test('worker: POST POS bootstrap returns 200 + ok + CORS', async () => {
  const res = await worker.fetch(post('/webhook/khair-pos', bootstrap('Siti', '1111')), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.products));
});

test('worker: business error (bad key) is HTTP 200 with ok:false', async () => {
  const res = await worker.fetch(post('/webhook/khair-pos', { action: 'bootstrap', key: 'WRONG', user: 'Siti', pin_hash: h('Siti', '1111'), data: {} }), env());
  assert.equal(res.status, 200); // n8n returned business errors as 200 too
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'BAD_KEY');
});

test('worker: routes by path to the field API', async () => {
  const res = await worker.fetch(post('/webhook/khair-field', { action: 'field_bootstrap', key: KEY, user: 'Siti', pin_hash: h('Siti', '1111'), data: {} }), env());
  assert.equal(res.status, 200);
  const body = await res.json();
  // Siti is kasir → field forbids kasir beyond cashier_orders; proves the field handler ran.
  assert.equal(body.ok, false);
  assert.equal(body.error, 'FORBIDDEN');
});

test('worker: khair-pos-photo routes to the photo API (not POS)', async () => {
  const res = await worker.fetch(post('/webhook/khair-pos-photo', { action: 'list_photos', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { from: '2026-10-01', to: '2026-10-31' } }), env());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.photos));
});

test('worker: missing DB/STORE_KEY config → 500 (not a crash)', async () => {
  const res = await worker.fetch(post('/webhook/khair-pos', bootstrap('Siti', '1111')), {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'SERVER');
});
