// Shared helpers for the Khair Mart POS e2e tests (mock backend, ?mock=1).
const { expect } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const rp = n => (Math.round(n) < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
const pct = p => NF1.format(p) + '%';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SHOTS = path.join(__dirname, 'screenshots');

function jktToday(offsetDays = 0) {
  const d = new Date(Date.now() + 7 * 3600000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/** The location consent bar (v11) is answered "Tidak" for the general suites; devices.spec passes { consent: null } to see it. */
async function openApp(page, query = '', opts = {}) {
  const consent = opts.consent === undefined ? 'no' : opts.consent;
  if (consent && !page.__consentInit) { page.__consentInit = true; await page.addInitScript(c => { try { if (!localStorage.getItem('kpos.loc_consent')) localStorage.setItem('kpos.loc_consent', c); } catch (e) { } }, consent); }
  await page.goto('index.html?mock=1' + query);
  await expect(page.locator('#login')).toBeVisible();
}

async function enterKey(page) {
  await page.locator('#lg-key').fill('demo');
  await page.click('[data-act="login-key"]');
}

async function typePin(page, pin) {
  for (const d of pin) await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
}

/** Logs in. Owner and manager sell without a cash drawer (v15: only kasir accounts open one, in Khair Kasir).
 *  Owner/manager land on Beranda; the helper then goes to the POS screen unless opts.stay. */
async function login(page, user = 'Pemilik', pin = '1234', query = '', opts = {}) {
  await openApp(page, query, opts);
  await enterKey(page);
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#shift-open')).toHaveCount(0);
  if (opts.stay) return;
  if (!(await page.locator('#view-pos').isVisible())) await nav(page, 'pos');
  await expect(page.locator('#pos-grid .pcard').first()).toBeVisible();
}

const getDb = page => page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
const productByName = (db, re) => db.products.find(p => re.test(p.name));

async function nav(page, view) {
  const btn = page.locator(`#nav [data-view="${view}"]`);
  if (await btn.isVisible()) await btn.click();
  else { await page.click('#nav-more'); await page.click(`#more-list [data-view="${view}"]`); }
  await expect(page.locator(`#view-${view}`)).toBeVisible();
}

/** Search, tap the first card → quantity sheet (qty, default 1) → Tambah. */
async function addBySearch(page, query, qty) {
  const s = page.locator('#pos-search');
  await s.fill(query);
  await page.locator('#pos-grid .pcard').first().click();
  await confirmQty(page, qty);
  await s.fill('');
}
/** The quantity sheet is open: optionally type a quantity, then confirm. */
async function confirmQty(page, qty) {
  await expect(page.locator('#qty-sheet')).toBeVisible();
  if (qty != null) await page.fill('#qs-qty', String(qty));
  await page.click('#qs-ok');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
}

/** Checkout ("Bayar & Simpan"): no survey step any more, the receipt is shown at once. */
async function checkoutSkip(page) {
  await page.click('#btn-checkout');
  await expect(page.locator('#survey')).toHaveCount(0);
  await expect(page.locator('.modal #receipt')).toBeVisible();
}

/** A real image (PNG of the current page) to feed the photo inputs. */
async function photoFile(page, name = 'foto.png') {
  return { name, mimeType: 'image/png', buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 240 } }) };
}

/** Calls the (mock) API as another user from the current page, the way the separate cashier app would.
 *  Resolves to the response, or { error: CODE } on {ok:false}. */
function asUser(page, user, pin, action, data = {}) {
  return page.evaluate(async ({ user, pin, action, data }) => {
    const pin_hash = await KPOS.pinHash('demo', user, pin);
    try { return await apiRaw(action, data, { key: 'demo', user, pin_hash }); } catch (e) { return { error: e.code, message: e.message }; }
  }, { user, pin, action, data });
}
/** Kasir / sales accounts are sent to their own app: log in and assert the redirect screen (target apps stubbed). */
async function loginKasirRedirect(page, user = 'Siti', pin = '1111') {
  await page.route('**/kasir/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Khair Kasir (stub)</title><p>kasir app</p>' }));
  await page.route('**/sales/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Khair Sales (stub)</title><p>sales app</p>' }));
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('kr')) { sessionStorage.setItem('kr', '1'); localStorage.removeItem('kpos.mock.session'); } } catch (e) { } });
  await openApp(page);
  if (await page.locator('#lg-key').count()) await enterKey(page);
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#kasir-redirect')).toBeVisible();
}

/** Read-modify-write of the mock database (stands in for server-side changes). */
const editDb = (page, fn, arg) => page.evaluate(([src, a]) => { const db = JSON.parse(localStorage.getItem('kmock.db')); new Function('db', 'arg', src)(db, a); localStorage.setItem('kmock.db', JSON.stringify(db)); }, [fn, arg]);
/** Block Leaflet (cdnjs) and OSM tiles so the map must use its SVG fallback. */
async function blockMapNetwork(page) {
  await page.route(/cdnjs\.cloudflare\.com/, r => r.abort());
  await page.route(/tile\.openstreetmap\.org/, r => r.abort());
}

async function closeModals(page) {
  while (await page.locator('.modal-bg').count()) {
    await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').first().click();
  }
}

/** v16: goods-in needs "who brought the goods" (require_carrier, default on): picks one in the owner purchase form. */
async function pickCarrier(page, type = 'pemasok') {
  const b = page.locator(`#pu-car-${type}`);
  if (!/\bon\b/.test((await b.getAttribute('class')) || '')) await b.click();
  await expect(page.locator(`#pu-car-${type}`)).toHaveClass(/\bon\b/);
}
const CARRIER = { type: 'pemasok', name: 'Pak Darto', vehicle: 'B 9012 TTF' };
module.exports = { pickCarrier, CARRIER, rp, pct, sha, SHOTS, jktToday, openApp, enterKey, typePin, login, getDb, productByName, nav, addBySearch, confirmQty, checkoutSkip, closeModals, photoFile, asUser, loginKasirRedirect, editDb, blockMapNetwork };
