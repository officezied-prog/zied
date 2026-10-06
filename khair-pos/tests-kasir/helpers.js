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

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const TABLET = { viewport: { width: 1180, height: 820 } };

async function openKasir(page, query = '') {
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
  if (!opts.noGoto) await openKasir(page, opts.query || '');
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
  if (user !== 'Pemilik') {
    await expect(page.locator('#gate #shift-open')).toBeVisible();
    if (opts.openShift === false) return;
    await page.fill('#so-cash', String(opts.openingCash ?? 500000));
    await page.click('#so-ok');
    await expect(page.locator('#gate')).toBeHidden();
  }
  await expect(page.locator('#grid .pc').first()).toBeVisible();
}
const getDb = page => page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
const setDb = (page, fn, arg) => page.evaluate(([src, a]) => { const db = JSON.parse(localStorage.getItem('kmock.db')); (new Function('db', 'arg', src))(db, a); localStorage.setItem('kmock.db', JSON.stringify(db)); }, [fn, arg]);
const productByName = (db, re) => db.products.find(p => re.test(p.name));

/** Search, tap the first card → quantity sheet (opts.qty, default 1) → Tambah; on the first item of a sale
 *  the survey opens → skip it (unless keepSurvey). */
async function addItem(page, query, opts = {}) {
  const first = await page.evaluate(() => window.KASIR.S.cart.lines.length === 0);
  await page.fill('#q', query);
  await page.locator('#grid .pc').first().click();
  await confirmQty(page, opts.qty);
  if (first && !opts.keepSurvey) await skipSurvey(page);
  await page.fill('#q', '');
}
/** The quantity sheet is open: optionally type a quantity, then confirm. */
async function confirmQty(page, qty) {
  await expect(page.locator('#qty-sheet')).toBeVisible();
  if (qty != null) await page.fill('#qs-qty', String(qty));
  await page.click('#qs-ok');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
}
async function skipSurvey(page) {
  await expect(page.locator('#survey')).toBeVisible();
  await page.click('#sv-skip');
  await expect(page.locator('#survey')).toHaveCount(0);
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
async function tab(page, v) {
  await page.click(`#tab-${v}`);
  await expect(page.locator(`#v-${v}`)).toBeVisible();
}

module.exports = { rp, sha, SHOTS, shot, PHONE, TABLET, openKasir, enterKey, typePin, login, getDb, setDb, productByName, addItem, confirmQty, skipSurvey, openCart, pay, photoFile, closeModals, tab };
