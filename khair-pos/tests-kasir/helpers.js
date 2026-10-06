// Shared helpers for the Khair Kasir e2e tests (mock backend, ?mock=1).
// The mock DB lives in localStorage under the same key as the owner app ("kmock.db").
const { expect } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (Math.round(n) < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SHOTS = path.join(__dirname, 'screenshots');
const shot = async (page, name, full = false, opts = {}) => { if (opts.noToasts) await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove())); await page.waitForTimeout(350); return page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full }); };

const KASIR_USERS = ['Siti', 'Rina'];
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const TABLET = { viewport: { width: 1180, height: 820 } };

/** The device-location notice (v11) is answered once per browser. Tests that are not about it start with "Tidak"
 *  already answered (opts.devConsent: 'no' default, 'yes', or null = not answered → the notice shows). */
async function presetDeviceConsent(page, choice = 'no') {
  if (choice === null || page.__devPreset) return;
  page.__devPreset = true;
  await page.addInitScript(ok => { if (!localStorage.getItem('kpos.device_consent')) localStorage.setItem('kpos.device_consent', JSON.stringify({ ok, at: new Date().toISOString() })); }, choice === 'yes');
}
async function openKasir(page, query = '', opts = {}) {
  await presetDeviceConsent(page, opts.devConsent === undefined ? 'no' : opts.devConsent);
  await page.goto('kasir/index.html?mock=1' + query);
  await expect(page.locator('#login')).toBeVisible();
}
async function enterKey(page) {
  await page.locator('#lg-key').fill('demo');
  await page.click('[data-act="login-key"]');
  await expect(page.locator('#users [data-act="login-user"]').first()).toBeVisible();
}
async function typePin(page, pin) {
  for (const d of pin) await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
}
/** Store key → tap the name → PIN. Kasir/manager then see "Buka Kasir" and (by default) open it. */
async function login(page, user = 'Siti', pin = '1111', opts = {}) {
  if (!opts.noGoto) await openKasir(page, opts.query || '', opts);
  await expect(page.locator('#login .screen-card')).toBeVisible();
  if (await page.locator('#lg-key').isVisible()) await enterKey(page);
  if (await page.locator('#pin-who').isVisible()) {
    if ((await page.locator('#pin-who').textContent()) === user) return finishLogin(page, user, pin, opts);
    await page.locator('[data-act="login-back"]').first().click();
  }
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  return finishLogin(page, user, pin, opts);
}
async function finishLogin(page, user, pin, opts) {
  await typePin(page, pin);
  await expect(page.locator('#app')).toBeVisible();
  // v15: only kasir accounts open the cash drawer ("Buka Kasir"); owner and manager sell without one
  if ((opts.role || (KASIR_USERS.includes(user) ? 'kasir' : 'other')) === 'kasir') {
    await expect(page.locator('#gate #shift-open')).toBeVisible();
    if (opts.openShift === false) return;
    await page.fill('#so-cash', String(opts.openingCash ?? 500000));
    await page.click('#so-ok');
    await expect(page.locator('#gate')).toBeHidden();
  }
  await expect(page.locator('#grid .pc').first()).toBeVisible();
}
const getDb = page => page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
/** Changes the mock DB. The code runs here in Node (the app's CSP forbids eval in the page), then the DB is written back. */
async function setDb(page, fn, arg) {
  const db = await getDb(page);
  (new Function('db', 'arg', fn))(db, arg);
  await page.evaluate(s => localStorage.setItem('kmock.db', s), JSON.stringify(db));
}
const productByName = (db, re) => db.products.find(p => re.test(p.name));

/** Search, tap the first card → quantity sheet (opts.qty, default 1) → Tambah. Nothing else opens: the
 *  customer survey lives inside the payment window and never interrupts selling. */
async function addItem(page, query, opts = {}) {
  await page.fill('#q', query);
  await page.locator('#grid .pc').first().click();
  await confirmQty(page, opts.qty);
  await expect(page.locator('#survey')).toHaveCount(0);
  await page.fill('#q', '');
}
/** The quantity sheet is open: optionally type a quantity, then confirm. */
async function confirmQty(page, qty) {
  await expect(page.locator('#qty-sheet')).toBeVisible();
  if (qty != null) await page.fill('#qs-qty', String(qty));
  await page.click('#qs-ok');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
}
/** Phone: the cart is a sheet opened from the pay bar. */
async function openCart(page) {
  if (await page.locator('#paybar-cart').isVisible()) { await page.click('#paybar-cart'); await expect(page.locator('#cart.open')).toBeVisible(); await page.waitForTimeout(250); }
}
async function pay(page) {
  if (await page.locator('#paybar-pay').isVisible()) await page.click('#paybar-pay'); else await page.click('#btn-pay');
  await expect(page.locator('#pay')).toBeVisible();
}
/** A real image (PNG of the current page) to feed the photo inputs. */
async function photoFile(page, name = 'foto.png') {
  return { name, mimeType: 'image/png', buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 240 } }) };
}
async function closeModals(page) {
  while (await page.locator('.modal-bg').count()) await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').first().click();
}
/** v16 "Siapa yang membawa barang?" (goods-in px 'pu', supplier return px 'sr'): type + optional fields. */
async function pickCarrier(page, type = 'pemasok', f = {}, px = 'pu') {
  await page.click(`#${px}-car-${type}`);
  await expect(page.locator(`#${px}-car`)).toHaveAttribute('data-type', type);
  if (f.kind) await page.selectOption(`#${px}-car-kind`, f.kind);
  for (const k of ['vehicle', 'name', 'phone']) if (f[k] != null) await page.fill(`#${px}-car-${k}`, f[k]);
}
async function tab(page, v) {
  await page.click(`#tab-${v}`);
  await expect(page.locator(`#v-${v}`)).toBeVisible();
}

module.exports = { pickCarrier, presetDeviceConsent, rp, sha, SHOTS, shot, PHONE, TABLET, openKasir, enterKey, typePin, login, getDb, setDb, productByName, addItem, confirmQty, openCart, pay, photoFile, closeModals, tab };
