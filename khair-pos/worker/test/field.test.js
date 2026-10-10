// Parity tests for the Field (sales-lapangan) API: the build-time wrap preserves behaviour,
// and the field writer handles both the images upsert and the special product_flags partial
// update of pos_products. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleField, parseField, loadFieldNodes } from '../src/field.js';
import { makeAccessor } from '../src/db.js';
import { runProcessField } from '../src/generated/process-field.gen.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const origSrc = readFileSync(new URL('../../backend/field/process-field.js', import.meta.url), 'utf8').replace('__STORE_KEY__', KEY);
const origFieldFn = new Function('$', origSrc);

const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(300); // >100 chars after the data-url strip

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Rani', role: 'sales', pin_hash: h('Rani', '3333'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, shop_stock: 20, active: true });
  insert(db, 'pos_customers', { id: 7, name: 'Toko Berkah', phone: '0812', type: 'grosir', debt_balance: 0 });
  insert(db, 'pos_shops', { id: 1, shop_id: 'S1', name: 'Toko A', area: 'Condet', type: 'toko', status: 'calon', visits: 0 });
  return db;
}

function frozen(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-06T03:00:00.000Z');
  const oR = Math.random; let s = 999;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = oR; }
}

test('field: generated runProcessField == original process-field.js', async () => {
  const cases = [
    base('field_bootstrap', 'Rani', '3333'),
    base('day_start', 'Rani', '3333', { lat: -6.26, lng: 106.86, acc: 10 }),
    base('set_product_image', 'Pemilik', '1234', { product_id: 1, image_base64: IMG }),
    { action: 'field_bootstrap', key: 'WRONG', user: 'Rani', pin_hash: h('Rani', '3333'), data: {} },
    base('field_bootstrap', 'Siti', '1111'), // unknown user
  ];
  for (const body of cases) {
    const nodes = await loadFieldNodes(sqliteAdapter(seed()), parseField(body, {}));
    const $ = makeAccessor(nodes);
    const gen = frozen(() => runProcessField($, KEY)[0].json);
    const orig = frozen(() => origFieldFn($)[0].json);
    assert.deepEqual(gen, orig, 'mismatch for field action ' + body.action);
  }
});

test('field: set_product_image inserts an image and flags the product (product_flags partial update)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('set_product_image', 'Pemilik', '1234', { product_id: 1, image_base64: IMG }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const imgs = a.all('SELECT * FROM pos_product_images WHERE product_id = 1', []);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].image_base64.length, 300); // data-url prefix stripped
  // product_flags → UPDATE pos_products.image_updated only (other columns untouched)
  const p = a.all('SELECT image_updated, stock, active FROM pos_products WHERE id = 1', [])[0];
  assert.ok(p.image_updated, 'image_updated stamped');
  assert.equal(p.stock, 20, 'stock untouched by the partial update');
  assert.equal(p.active, 1, 'active untouched');
});

test('field: day_start inserts a working day for the sales rep', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('day_start', 'Rani', '3333', { lat: -6.26, lng: 106.86, acc: 10 }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const days = a.all("SELECT * FROM pos_field_days WHERE user = 'Rani'", []);
  assert.equal(days.length, 1);
  assert.equal(days[0].day_date, new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10));
});

test('field: kasir may not use field actions beyond cashier_orders', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  const r = await handleField(sqliteAdapter(db), base('field_bootstrap', 'Siti', '1111'), {}, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FORBIDDEN');
});

test('field v30: check_in stores the star rating on the visit', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('check_in', 'Rani', '3333', { client_id: 'ci1', shop_id: 'S1', lat: -6.26, lng: 106.86, acc: 10, outcome: 'tertarik', rating: 4, notes: 'ramah' }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = a.all("SELECT * FROM pos_visits WHERE client_id = 'ci1'", [])[0];
  assert.ok(v, 'visit saved');
  assert.equal(v.rating, 4);
});

test('field v30: field_order stores the payment method', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleField(a, base('field_order', 'Rani', '3333', { client_id: 'fo1', shop_id: 'S1', payment_method: 'tempo', items: [{ product_id: 1, qty: 3 }] }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const o = a.all("SELECT * FROM pos_field_orders WHERE client_id = 'fo1'", [])[0];
  assert.ok(o, 'order saved');
  assert.equal(o.payment_method, 'tempo');
});

test('field v30: the accountant may read the field report; a sales rep may not', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 5, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  const a = sqliteAdapter(db);
  const ra = await handleField(a, base('list_field', 'Aqil', '4444', { from: '2026-10-01', to: '2026-10-31' }), {}, KEY);
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.ok(Array.isArray(ra.visits), 'visits array returned to the accountant');
  const rs = await handleField(a, base('list_field', 'Rani', '3333', { from: '2026-10-01', to: '2026-10-31' }), {}, KEY);
  assert.equal(rs.ok, false);
  assert.equal(rs.error, 'FORBIDDEN');
});
