// v49 (owner 2026-10-14: «لم تظهرت النسخة الجديدة»): Khair Kasir finds a new version on the site by itself: on the login
// screen it reloads at once; while the cashier works a green bar offers "Perbarui" — one tap, still logged in, the shift
// still open.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { PHONE, openKasir, login, shot } = require('./helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'kasir', 'index.html'), 'utf8');
const CUR = /const APP_VERSION = '([^']+)'/.exec(SRC)[1];
async function siteHas(page, v, { navigation = true } = {}) {
  const body = SRC.replace(/const APP_VERSION = '[^']+'/, `const APP_VERSION = '${v}'`);
  await page.unroute(u => u.pathname === '/kasir/index.html');
  await page.route(u => u.pathname === '/kasir/index.html', route => {
    if (!navigation && route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
}

test.use(PHONE);

test('login screen: a new version → Khair Kasir reloads itself into it', async ({ page }) => {
  await openKasir(page);
  await expect(page.locator('#login-ver')).toContainText(CUR);
  expect(await page.evaluate(() => KUpdate.check())).toBe('same');
  await siteHas(page, 'kasir-9.9.9');
  await page.evaluate(() => { KUpdate.check(); });
  await expect(page.locator('#login-ver')).toContainText('kasir-9.9.9');
  await expect(page.locator('#kupd')).toHaveCount(0);
});

test('the cashier at work: the bar, one tap → new version, same cashier, shift still open', async ({ page }) => {
  await login(page, 'Siti', '1111');
  await siteHas(page, 'kasir-9.9.9', { navigation: false });
  expect(await page.evaluate(() => KUpdate.check())).toBe('new');
  await expect(page.locator('#kupd')).toContainText('Versi baru kasir-9.9.9 sudah siap');
  await expect(page.locator('#grid .pc').first()).toBeVisible(); // not reloaded under her hands
  await shot(page, 'phone-update-bar');
  await siteHas(page, 'kasir-9.9.9');
  await page.click('#kupd-go');
  await expect(page.locator('#tb-ver')).toHaveText('kasir-9.9.9');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#gate')).toBeHidden(); // no new "Buka Kasir": the shift is still open
  await expect(page.locator('#grid .pc').first()).toBeVisible();
  await expect(page.locator('#kupd')).toHaveCount(0);
});
