// Parity tests for the Photo API: the build-time wrap of Auth&Route and Match preserves
// behaviour, and the pipeline degrades gracefully with no AI key (photo saved 'perlu_cek'),
// exactly as the n8n workflow did when its AI node failed. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handlePhoto, parsePhoto, loadPhotoNodes } from '../src/photo.js';
import { makeAccessor } from '../src/db.js';
import { runPhotoAuth } from '../src/generated/photo-auth.gen.js';
import { runPhotoMatch } from '../src/generated/photo-match.gen.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const authSrc = readFileSync(new URL('../../backend/photo/auth-route.js', import.meta.url), 'utf8').replace("'__STORE_KEY__'", JSON.stringify(KEY));
const matchSrc = readFileSync(new URL('../../backend/photo/match.js', import.meta.url), 'utf8');
const origAuthFn = new Function('$', authSrc);
const origMatchFn = new Function('$', '$input', matchSrc);

const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(400);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, active: true });
  insert(db, 'pos_products', { id: 2, sku: '222', name: 'Kismis 500g', unit: 'pcs', cost_price: 20000, retail_price: 25000, stock: 50, active: true });
  return db;
}

function frozen(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-06T03:00:00.000Z');
  const oR = Math.random; let s = 5;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = oR; }
}

test('photo: generated runPhotoAuth == original auth-route.js', async () => {
  const cases = [
    base('scan_purchase', 'Pemilik', '1234', { image_base64: IMG }),
    base('list_photos', 'Pemilik', '1234', { from: '2026-10-01', to: '2026-10-31' }),
    { action: 'scan_purchase', key: 'WRONG', user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { image_base64: IMG } },
    base('scan_purchase', 'Pemilik', '1234', {}), // no image → INVALID
  ];
  for (const body of cases) {
    const nodes = await loadPhotoNodes(sqliteAdapter(seed()), parsePhoto(body));
    const $ = makeAccessor(nodes);
    const gen = frozen(() => runPhotoAuth($, KEY)[0].json);
    const orig = frozen(() => origAuthFn($)[0].json);
    assert.deepEqual(gen, orig, 'auth mismatch for ' + body.action);
  }
});

test('photo: generated runPhotoMatch == original match.js (goods-in suggestions)', () => {
  const auth = { mode: 'scan', kind: 'masuk', action: 'scan_purchase', user: 'Pemilik', ref: '' };
  const aiText = JSON.stringify({ supplier: 'PT Kurma', items: [{ name: 'Kurma Ajwa', qty: 10, unit: 'dus' }, { name: 'Kismis', qty: 5 }], readable: true, notes: 'ok' });
  const aiOut = { content: [{ type: 'text', text: aiText }] };
  const products = [
    { id: 1, name: 'Kurma Ajwa 1kg', active: true },
    { id: 2, name: 'Kismis 500g', active: true },
  ];
  const nodes = { 'Auth & Route': [auth], 'Get Products': products };
  const $ = makeAccessor(nodes);
  const $input = { first: () => ({ json: aiOut }) };
  const gen = frozen(() => runPhotoMatch($, $input)[0].json);
  const orig = frozen(() => origMatchFn($, $input)[0].json);
  assert.deepEqual(gen, orig);
  assert.ok(gen.response.suggestions.length === 2, 'two suggestions produced');
});

test('photo: scan with no AI key saves the photo as perlu_cek (graceful degrade)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handlePhoto(a, base('scan_purchase', 'Pemilik', '1234', { image_base64: IMG }), {}, KEY, {}); // env = {} → no AI key
  assert.equal(r.ok, true, JSON.stringify(r));
  const photos = a.all('SELECT * FROM pos_photos', []);
  assert.equal(photos.length, 1);
  assert.equal(photos[0].kind, 'masuk');
  assert.equal(photos[0].match_status, 'perlu_cek'); // AI unavailable → manual check
  assert.ok(photos[0].photo_id.startsWith('PH'));
});

test('photo: list_photos returns saved photos; bad date range rejected', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  await handlePhoto(a, base('scan_purchase', 'Pemilik', '1234', { image_base64: IMG }), {}, KEY, {});
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const list = await handlePhoto(a, base('list_photos', 'Pemilik', '1234', { from: today, to: today }), {}, KEY, {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.photos.length, 1);
  const bad = await handlePhoto(a, base('list_photos', 'Pemilik', '1234', {}), {}, KEY, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'INVALID');
});

test('photo: bad store key → BAD_KEY', async () => {
  const db = seed();
  const r = await handlePhoto(sqliteAdapter(db), { action: 'scan_purchase', key: 'WRONG', user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { image_base64: IMG } }, {}, KEY, {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BAD_KEY');
});
