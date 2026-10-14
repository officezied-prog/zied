// v49 (owner 2026-10-14: «لم تظهرت النسخة الجديدة»): Khair Sales finds a new version on the site by itself: on the login
// screen it reloads at once; during the rep's day a green bar offers "Perbarui" — one tap, the rep stays logged in.
const fs = require('fs');
const path = require('path');
const { test, expect, openSales, login } = require('./helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sales', 'index.html'), 'utf8');
const CUR = /const APP_VERSION = '([^']+)'/.exec(SRC)[1];
async function siteHas(page, v, { navigation = true } = {}) {
  const body = SRC.replace(/const APP_VERSION = '[^']+'/, `const APP_VERSION = '${v}'`);
  await page.unroute(u => u.pathname === '/sales/index.html');
  await page.route(u => u.pathname === '/sales/index.html', route => {
    if (!navigation && route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
}

test('login screen: a new version → Khair Sales reloads itself into it', async ({ page }) => {
  await openSales(page);
  await expect(page.locator('#login-ver')).toContainText(CUR);
  expect(await page.evaluate(() => KUpdate.check())).toBe('same');
  await siteHas(page, 'sales-9.9.9');
  await page.evaluate(() => { KUpdate.check(); });
  await expect(page.locator('#login-ver')).toContainText('sales-9.9.9');
});

test('the rep at work: the bar, one tap → new version, still logged in', async ({ page }) => {
  await login(page);
  await siteHas(page, 'sales-9.9.9', { navigation: false });
  expect(await page.evaluate(() => KUpdate.check())).toBe('new');
  await expect(page.locator('#kupd')).toContainText('Versi baru sales-9.9.9 sudah siap');
  await expect(page.locator('#v-today .hero')).toBeVisible();
  await siteHas(page, 'sales-9.9.9');
  await page.click('#kupd-go');
  await expect(page.locator('#tb-user')).toHaveText('sales-9.9.9');
  await expect(page.locator('#v-today .hero')).toBeVisible();
  await expect(page.locator('#kupd')).toHaveCount(0);
});
