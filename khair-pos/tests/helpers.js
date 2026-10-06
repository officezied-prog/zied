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

async function openApp(page, query = '') {
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

/** Logs in. Non-owners are asked to open the cash drawer first ("Buka kasir"); by default the
 *  helper opens it with Rp 500.000 (opts.openShift = false leaves the prompt on screen).
 *  Owner/manager land on Beranda; the helper then goes to the POS screen. */
async function login(page, user = 'Pemilik', pin = '1234', query = '', opts = {}) {
  await openApp(page, query);
  await enterKey(page);
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#app')).toBeVisible();
  if (user !== 'Pemilik') {
    await expect(page.locator('#shift-open')).toBeVisible();
    if (opts.openShift === false) return;
    await page.fill('#so-cash', String(opts.openingCash ?? 500000));
    await page.click('#so-ok');
    await expect(page.locator('#shift-open')).toHaveCount(0);
  }
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

async function addBySearch(page, query) {
  const s = page.locator('#pos-search');
  await s.fill(query);
  await page.locator('#pos-grid .pcard').first().click();
  await s.fill('');
}

/** Checkout and skip the survey; returns once the receipt is shown. */
async function checkoutSkip(page) {
  await page.click('#btn-checkout');
  await page.click('#sv-skip');
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
/** Kasir accounts are sent to the cashier app: log in and assert the redirect screen. */
async function loginKasirRedirect(page, user = 'Siti', pin = '1111') {
  await page.route('**/kasir/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Khair Kasir (stub)</title><p>kasir app</p>' }));
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('kr')) { sessionStorage.setItem('kr', '1'); localStorage.removeItem('kpos.mock.session'); } } catch (e) { } });
  await openApp(page);
  if (await page.locator('#lg-key').count()) await enterKey(page);
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#kasir-redirect')).toBeVisible();
}

async function closeModals(page) {
  while (await page.locator('.modal-bg').count()) {
    await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').first().click();
  }
}

module.exports = { rp, pct, sha, SHOTS, jktToday, openApp, enterKey, typePin, login, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals, photoFile, asUser, loginKasirRedirect };
