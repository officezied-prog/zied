// v36 (owner 2026-10-08: "فعّل حفظ الصور عبر Google Drive") — the photo itself is kept in Cloudflare R2 (binding PHOTOS)
// and served back by GET .../khair-pos-photo/file/<photo_id> to owner / manager / accountant only. Without the binding
// everything behaves exactly as before. Also guards the CI deploy smoke-test contract. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, d1Mock, sqliteAdapter, insert, r2Mock } from './shim.js';
import { handlePhoto, photoKey } from '../src/photo.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const MASTER = crypto.createHash('sha256').update(KEY + ':__master__:87654321').digest('hex');
const BYTES = Uint8Array.from({ length: 600 }, (_, i) => (i * 37 + 11) & 255); // a fake "JPEG" (any bytes)
const B64 = Buffer.from(BYTES).toString('base64');
const HOST = 'https://khair-mart-jumla.officezied.workers.dev';

function seedDb() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), master_hash: MASTER, active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Akun', role: 'akuntan', pin_hash: h('Akun', '3333'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Baru', role: 'manager', pin_hash: h('Baru', '4444'), must_change: true, active: true });
  insert(db, 'pos_products', { id: 1, sku: '111', name: 'Kurma Ajwa 1kg', unit: 'kg', cost_price: 150000, retail_price: 185000, stock: 20, shop_stock: 20, active: true });
  return db;
}
const scanBody = (user, pin, mime = 'image/jpeg') => ({ action: 'scan_purchase', key: KEY, user, pin_hash: h(user, pin), data: { image_base64: 'data:' + mime + ';base64,' + B64, mime } });
const post = (path, body) => new Request(HOST + path, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
const getFile = (id, cred) => new Request(HOST + '/webhook/khair-pos-photo/file/' + encodeURIComponent(id), {
  method: 'GET',
  headers: cred ? { 'X-Khair-Key': cred.key || KEY, 'X-Khair-User': encodeURIComponent(cred.user), 'X-Khair-Pin': cred.pin_hash } : {},
});
const cred = (user, pin) => ({ user, pin_hash: h(user, pin) });

test('photo store: photoKey is stable and per month', () => {
  assert.equal(photoKey('PHABCD2345', '2026-10-11', 'image/jpeg'), 'photos/2026-10/PHABCD2345.jpg');
  assert.equal(photoKey('PHX', '2026-01-02', 'image/png'), 'photos/2026-01/PHX.png');
  assert.equal(photoKey('PHX', '', 'image/webp'), 'photos/undated/PHX.webp');
});

test('photo store: with the PHOTOS binding the original image is kept and linked (drive_file_id / drive_url)', async () => {
  const db = seedDb();
  const a = sqliteAdapter(db);
  const PHOTOS = r2Mock();
  const base = HOST + '/webhook/khair-pos-photo';
  const r = await handlePhoto(a, scanBody('Siti', '1111'), {}, KEY, { PHOTOS }, { base });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [row] = a.all('SELECT * FROM pos_photos', []);
  const key = photoKey(row.photo_id, row.photo_date, 'image/jpeg');
  assert.equal(row.drive_file_id, 'r2:' + key);
  assert.equal(row.drive_url, base + '/file/' + row.photo_id);
  assert.equal(r.drive_url, row.drive_url, 'the scan answer carries the link too');
  const obj = PHOTOS.objects.get(key);
  assert.ok(obj, 'object stored under ' + key);
  assert.deepEqual(Array.from(obj.bytes), Array.from(BYTES), 'stored exactly as uploaded');
  assert.equal(obj.httpMetadata.contentType, 'image/jpeg');
  assert.equal(obj.customMetadata.photo_id, row.photo_id);
  assert.equal(obj.customMetadata.kind, 'masuk');
});

test('photo store: without the binding nothing changes (drive_url empty, scan ok)', async () => {
  const a = sqliteAdapter(seedDb());
  const r = await handlePhoto(a, scanBody('Siti', '1111'), {}, KEY, {});
  assert.equal(r.ok, true);
  assert.equal(r.drive_url, '');
  const [row] = a.all('SELECT * FROM pos_photos', []);
  assert.equal(row.drive_url, '');
  assert.equal(row.drive_file_id, '');
});

test('photo store: a storage failure never loses the scan (row saved, no link)', async () => {
  const a = sqliteAdapter(seedDb());
  const r = await handlePhoto(a, scanBody('Siti', '1111'), {}, KEY, { PHOTOS: r2Mock({ failPut: true }) }, { base: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.drive_url, '');
  assert.equal(a.all('SELECT * FROM pos_photos', []).length, 1);
});

test('photo store: an invalid scan (no image) stores nothing', async () => {
  const PHOTOS = r2Mock();
  const r = await handlePhoto(sqliteAdapter(seedDb()), { action: 'scan_purchase', key: KEY, user: 'Siti', pin_hash: h('Siti', '1111'), data: {} }, {}, KEY, { PHOTOS });
  assert.equal(r.ok, false);
  assert.equal(PHOTOS.objects.size, 0);
});

test('worker GET /file: owner, manager, accountant (and the master code) get the image with cache headers', async () => {
  const db = seedDb();
  const env = { DB: d1Mock(db), STORE_KEY: KEY, PHOTOS: r2Mock() };
  const scan = await (await worker.fetch(post('/webhook/khair-pos-photo', scanBody('Siti', '1111', 'image/png')), env)).json();
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.equal(scan.drive_url, HOST + '/webhook/khair-pos-photo/file/' + scan.photo_id, 'absolute link on the Worker host');
  // list_photos returns the link for the photo screens of the owner app
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const list = await (await worker.fetch(post('/webhook/khair-pos-photo', { action: 'list_photos', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { from: today, to: today } }), env)).json();
  assert.equal(list.photos[0].drive_url, scan.drive_url);
  for (const c of [cred('Pemilik', '1234'), cred('Jihan', '2222'), cred('Akun', '3333'), { user: 'Pemilik', pin_hash: MASTER }]) {
    const res = await worker.fetch(getFile(scan.photo_id, c), env);
    assert.equal(res.status, 200, c.user);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control') || '', /private.*max-age=31536000.*immutable/);
    assert.match(res.headers.get('vary') || '', /X-Khair-Pin/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Array.from(new Uint8Array(await res.arrayBuffer())), Array.from(BYTES));
  }
});

test('worker GET /file: cashier forbidden, bad PIN/key/no credentials refused, unknown photo 404', async () => {
  const db = seedDb();
  const env = { DB: d1Mock(db), STORE_KEY: KEY, PHOTOS: r2Mock() };
  const scan = await (await worker.fetch(post('/webhook/khair-pos-photo', scanBody('Siti', '1111')), env)).json();
  const expect = async (req, status, error) => {
    const res = await worker.fetch(req, env);
    assert.equal(res.status, status, error);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const b = await res.json();
    assert.equal(b.ok, false);
    assert.equal(b.error, error);
  };
  await expect(getFile(scan.photo_id, cred('Siti', '1111')), 403, 'FORBIDDEN');
  await expect(getFile(scan.photo_id, cred('Baru', '4444')), 403, 'PIN_CHANGE_REQUIRED');
  await expect(getFile(scan.photo_id, cred('Pemilik', '9999')), 401, 'BAD_PIN');
  await expect(getFile(scan.photo_id, Object.assign(cred('Pemilik', '1234'), { key: 'WRONG' })), 401, 'BAD_KEY');
  await expect(getFile(scan.photo_id, null), 401, 'BAD_KEY');
  await expect(getFile('PHNOPE1234', cred('Pemilik', '1234')), 404, 'NOT_FOUND');
  await expect(getFile('../../etc', cred('Pemilik', '1234')), 400, 'INVALID');
  // the binding removed later (e.g. a deploy without R2): a clear 404, never a crash
  const noR2 = { DB: env.DB, STORE_KEY: KEY };
  const res = await worker.fetch(getFile(scan.photo_id, cred('Pemilik', '1234')), noR2);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'NOT_FOUND');
});

test('worker: CORS preflight allows the stored-photo GET with its credential headers', async () => {
  const res = await worker.fetch(new Request(HOST + '/webhook/khair-pos-photo/file/PH1', { method: 'OPTIONS' }), { DB: d1Mock(newDb()), STORE_KEY: KEY });
  assert.match(res.headers.get('access-control-allow-methods') || '', /GET/);
  assert.match(res.headers.get('access-control-allow-headers') || '', /X-Khair-Key.*X-Khair-User.*X-Khair-Pin/);
});

test('worker: other GETs are still refused (405)', async () => {
  const res = await worker.fetch(new Request(HOST + '/webhook/khair-pos-photo', { method: 'GET' }), { DB: d1Mock(newDb()), STORE_KEY: KEY });
  assert.equal(res.status, 405);
});

// .github/workflows/worker-deploy.yml smoke-tests the live Worker with exactly this request and rolls back unless the
// answer contains "BAD_KEY" — keep this contract.
test('worker: CI smoke-test request answers BAD_KEY (HTTP 200) without touching data', async () => {
  const res = await worker.fetch(new Request(HOST + '/webhook/khair-pos', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: '{"action":"bootstrap","key":"ci-smoke-test","data":{}}' }), { DB: d1Mock(seedDb()), STORE_KEY: KEY });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"BAD_KEY"/);
});
