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

async function login(page, user = 'Pemilik', pin = '1234', query = '') {
  await openApp(page, query);
  await enterKey(page);
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#pos-grid .pcard').first()).toBeVisible();
}

const getDb = page => page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
const productByName = (db, re) => db.products.find(p => re.test(p.name));

async function nav(page, view) {
  await page.click(`#nav [data-view="${view}"]`);
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

async function closeModals(page) {
  while (await page.locator('.modal-bg').count()) {
    await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').first().click();
  }
}

module.exports = { rp, pct, sha, SHOTS, jktToday, openApp, enterKey, typePin, login, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals };
