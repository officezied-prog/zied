// Shared helpers for the Khair Sales e2e tests (mock backend, ?mock=1, mocked geolocation).
// Network independence: cdnjs (Leaflet), OSM tiles and wa.me are blocked in every test → the map
// falls back to the SVG plot.
const base = require('@playwright/test');
const { expect } = base;
const path = require('path');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (Math.round(n) < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
const SHOTS = path.join(__dirname, 'screenshots');
const shot = async (page, name, full = false) => { await page.waitForTimeout(350); return page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full }); };
const BLOCK = /cdnjs\.cloudflare\.com|tile\.openstreetmap\.org|wa\.me|google\.com/;

const test = base.test.extend({
  context: async ({ context }, use) => {
    await context.route(BLOCK, r => r.abort());
    await use(context);
  }
});
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const STORE = { latitude: -6.2655, longitude: 106.8605 };
async function setPos(context, lat, lng, accuracy = 12) { await context.setGeolocation({ latitude: lat, longitude: lng, accuracy }); }

/** The device-location notice (v11) is answered once per browser: tests that are not about it start with "Tidak"
 *  already answered (opts.devConsent: 'no' default, 'yes', or null = not answered). A rep's work consent still applies. */
async function presetDeviceConsent(page, choice = 'no') {
  if (choice === null || page.__devPreset) return;
  page.__devPreset = true;
  await page.addInitScript(ok => { if (!localStorage.getItem('kpos.device_consent')) localStorage.setItem('kpos.device_consent', JSON.stringify({ ok, at: new Date().toISOString() })); }, choice === 'yes');
}
async function openSales(page, query = '', opts = {}) {
  await presetDeviceConsent(page, opts.devConsent === undefined ? 'no' : opts.devConsent);
  await page.goto('sales/index.html?mock=1' + query);
  await expect(page.locator('#login .screen-card')).toBeVisible();
}
async function typePin(page, pin) {
  for (const d of pin) await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
}
/** Store key → name → PIN. */
async function login(page, user = 'Ahmad', pin = '4444', opts = {}) {
  if (!opts.noGoto) await openSales(page, '', opts);
  if (await page.locator('#lg-key').isVisible()) { await page.fill('#lg-key', 'demo'); await page.click('[data-act="login-key"]'); }
  if (await page.locator('#pin-who').isVisible() && (await page.locator('#pin-who').textContent()) !== user) await page.locator('[data-act="login-back"]').first().click();
  if (!(await page.locator('#pin-who').isVisible())) await page.click(`#users [data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#v-today .hero')).toBeVisible();
}
const getDb = page => page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
/** Changes the mock DB. The code runs here in Node (the app's CSP forbids eval in the page), then the DB is written back. */
async function setDb(page, src) {
  const db = await getDb(page);
  (new Function('db', src))(db);
  await page.evaluate(s => localStorage.setItem('kmock.db', s), JSON.stringify(db));
}
/** Consent (first time) + Mulai kerja. */
async function startDay(page) {
  await page.click('#day-start');
  if (await page.locator('#consent').isVisible().catch(() => false) || await page.locator('#consent').waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await page.click('#consent-ok');
  await expect(page.locator('#day-card[data-status="working"]')).toBeVisible();
  await expect(page.locator('#tb-gps')).toBeVisible();
}
async function tab(page, v) { await page.click(`#tab-${v}`); await expect(page.locator(`#v-${v}`)).toBeVisible(); }
async function photoFile(page, name = 'foto.png') {
  return { name, mimeType: 'image/png', buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 390, height: 300 } }) };
}
/** New-shop form / "Ubah jenis toko": pick a shop type through its group (shared/shop-types.js). */
async function pickType(page, type) {
  const g = await page.evaluate(t => window.KhairShopTypes.groupOf(t), type);
  await page.click(`#tp-groups [data-act="tp-group"][data-g="${g}"]`);
  if (type !== 'lainnya') await page.click(`#tp-types [data-act="tp-type"][data-t="${type}"]`);
  await expect(page.locator('#tp-sel')).toHaveAttribute('data-type', type);
}
async function closeModals(page) { while (await page.locator('.modal-bg').count()) await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').first().click(); }

module.exports = { presetDeviceConsent, test, expect, rp, SHOTS, shot, STORE, setPos, openSales, typePin, login, getDb, setDb, startDay, tab, photoFile, closeModals, pickType };
