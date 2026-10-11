// v36 (owner 2026-10-08: "فعّل حفظ الصور عبر Google Drive") — photos are kept by the Worker in Cloudflare R2 and opened
// from the owner app with "📷 Lihat foto" (owner / manager / accountant only). Demo mode keeps them in IndexedDB.
const { test, expect } = require('@playwright/test');
const { login, getDb, nav, asUser, sha, jktToday, openApp, editDb } = require('./helpers');

const PHOTO_URL = 'https://khair-mart-jumla.officezied.workers.dev/webhook/khair-pos-photo';
const API = 'https://khair-mart-jumla.officezied.workers.dev/webhook/khair-pos';
// a valid 2×2 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

test('demo: a scanned photo is kept and opens from the photo list (owner); reload reads it back; cashier refused', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const r = await asUser(page, 'Jihan', '2222', 'scan_purchase', { image_base64: 'data:image/png;base64,' + PNG_B64, mime: 'image/png' });
  expect(r.photo_id).toMatch(/^PH-/);
  expect(r.drive_url).toBe(PHOTO_URL + '/file/' + r.photo_id);
  const db = await getDb(page);
  expect(db.photos.find(p => p.photo_id === r.photo_id)).toMatchObject({ drive_url: r.drive_url, drive_file_id: `r2:photos/${jktToday().slice(0, 7)}/${r.photo_id}.png` });
  expect(JSON.stringify(db)).not.toContain(PNG_B64); // the image is never inside the demo database

  // server rules: owner / manager / accountant may read it, a cashier may not
  expect((await asUser(page, 'Siti', '1111', 'photo_file', { photo_id: r.photo_id })).error).toBe('FORBIDDEN');
  expect((await asUser(page, 'Jihan', '2222', 'photo_file', { photo_id: r.photo_id })).data_url).toBe('data:image/png;base64,' + PNG_B64);

  for (const round of [1, 2]) {
    if (round === 2) { await page.reload(); await expect(page.locator('#app')).toBeVisible(); } // memory gone → read from IndexedDB
    await nav(page, 'reports');
    await page.click('[data-act="rep-preset"][data-p="today"]');
    const btn = page.locator(`#photo-table [data-act="photo-view"][data-photo="${r.photo_id}"]`);
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Lihat foto');
    await btn.click();
    const img = page.locator('#photo-view-img');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', 'data:image/png;base64,' + PNG_B64);
    expect(await img.evaluate(el => el.naturalWidth)).toBe(2);
    await page.click('#photo-viewer [data-act="modal-close"]');
  }
});

test('demo: Arabic label and viewer title; no stored image → no link', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const r = await asUser(page, 'Pemilik', '1234', 'scan_supplier_return', { image_base64: PNG_B64, mime: 'image/png', purchase_no: 'PB-9' });
  expect(await page.evaluate(() => photoLinkHtml('', { empty: '—' }))).toBe('—'); // no stored image → no link
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="today"]');
  await expect(page.locator(`#photo-table [data-act="photo-view"][data-photo="${r.photo_id}"]`)).toContainText('عرض الصورة');
  await page.locator(`#photo-table [data-act="photo-view"][data-photo="${r.photo_id}"]`).click();
  await expect(page.locator('#photo-viewer h2')).toHaveText('الصورة المحفوظة');
});

test('demo: the accountant (read-only app) can open a stored photo too', async ({ page }) => {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await login(page, 'Lestari', '5555', '', { stay: true });
  const r = await asUser(page, 'Jihan', '2222', 'scan_payment', { image_base64: PNG_B64, mime: 'image/png' });
  expect(r.drive_url).toContain('/file/' + r.photo_id);
  // the read-only (audit) app lets the "📷 Lihat foto" action through and the server allows the accountant
  await page.evaluate(url => document.body.insertAdjacentHTML('beforeend', '<div id="t-links" style="position:fixed;left:0;bottom:0;z-index:2147483000;background:#fff">' + photoLinkHtml(url) + '</div>'), r.drive_url);
  await page.click(`#t-links [data-act="photo-view"][data-photo="${r.photo_id}"]`);
  await expect(page.locator('#photo-view-img')).toHaveAttribute('src', 'data:image/png;base64,' + PNG_B64);
});

test('real mode: the stored photo is fetched with the session credentials as headers (never in the URL) and shown', async ({ page }) => {
  const KEY = 'test-store-key';
  const PIN = sha(`${KEY}:jihan:4321`);
  await page.route(API, route => {
    const body = JSON.parse(route.request().postData());
    const send = obj => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    if (body.action === 'users') return send({ ok: true, users: [{ name: 'Jihan', role: 'owner' }] });
    if (body.action === 'login') return send({ ok: true, user: { name: 'Jihan', role: 'owner' } });
    if (body.action === 'bootstrap') return send({ ok: true, products: [], customers: [], settings: { store_name: 'Khair Mart', paper: '80', survey_questions: [] }, users: [{ name: 'Jihan', role: 'owner', active: true }], server_time: new Date().toISOString() });
    return send({ ok: true });
  });
  const gets = [];
  await page.route(PHOTO_URL + '/file/**', route => {
    const req = route.request();
    gets.push({ url: req.url(), method: req.method(), headers: req.headers() });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, X-Khair-Key, X-Khair-User, X-Khair-Pin' } });
    const id = req.url().split('/file/')[1];
    if (id === 'PHDENIED01') return route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'FORBIDDEN', message: 'Hanya pemilik, manajer, atau akuntan' }) });
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' }, body: Buffer.from(PNG_B64, 'base64') });
  });
  await page.goto('index.html');
  await page.fill('#lg-key', KEY);
  await page.click('[data-act="login-key"]');
  await page.click('[data-act="login-user"][data-name="Jihan"]');
  for (const d of '4321') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#view-home')).toBeVisible();

  // (links are placed outside the views, which re-render on their own) any host in drive_url → the app's own Worker URL; a non-stored link stays a plain link
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="t-links" style="position:fixed;left:0;bottom:0;z-index:2147483000;background:#fff">' + photoLinkHtml('https://old-host.example/webhook/khair-pos-photo/file/PHABC23456') + photoLinkHtml('https://drive.google.com/file/d/x') + photoLinkHtml('https://x/webhook/khair-pos-photo/file/PHDENIED01') + '</div>');
  });
  await expect(page.locator('#t-links a[target="_blank"]')).toHaveAttribute('href', 'https://drive.google.com/file/d/x');
  await page.click('#t-links [data-photo="PHABC23456"]');
  const img = page.locator('#photo-view-img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^blob:/);
  expect(await img.evaluate(el => el.naturalWidth)).toBe(2);
  const get = gets.find(g => g.method === 'GET');
  expect(get.url).toBe(PHOTO_URL + '/file/PHABC23456'); // credentials are not in the URL
  expect(get.headers['x-khair-key']).toBe(KEY);
  expect(decodeURIComponent(get.headers['x-khair-user'])).toBe('Jihan');
  expect(get.headers['x-khair-pin']).toBe(PIN);
  await page.click('#photo-viewer [data-act="modal-close"]');
  // opened again: from memory, no second download
  const n = gets.filter(g => g.method === 'GET').length;
  await page.click('#t-links [data-photo="PHABC23456"]');
  await expect(page.locator('#photo-view-img')).toBeVisible();
  expect(gets.filter(g => g.method === 'GET').length).toBe(n);
  await page.click('#photo-viewer [data-act="modal-close"]');
  // refused by the server → a clear message, no viewer
  await page.click('#t-links [data-photo="PHDENIED01"]');
  await expect(page.locator('.toast').last()).toBeVisible();
  await expect(page.locator('#photo-viewer')).toHaveCount(0);
});
