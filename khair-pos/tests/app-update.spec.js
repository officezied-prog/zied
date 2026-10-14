// v49 (owner 2026-10-14: «لم تظهرت النسخة الجديدة»): the app finds a new version on the site by itself. On the login screen
// (nobody working) it reloads at once; while someone works a green bar offers "Perbarui" (the session stays). Never twice
// for the same version, so a stale copy somewhere cannot make it reload in a loop.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { SHOTS, openApp, login } = require('./helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CUR = /const APP_VERSION = '([^']+)'/.exec(SRC)[1];
/** The site now has version v of the page: for the app's own check only (navigation: false = the phone still gets the old page), or for everything. */
async function siteHas(page, v, { navigation = true } = {}) {
  const body = SRC.replace(/const APP_VERSION = '[^']+'/, `const APP_VERSION = '${v}'`);
  await page.unroute(u => u.pathname === '/index.html');
  await page.route(u => u.pathname === '/index.html', route => {
    if (!navigation && route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
}
const check = page => page.evaluate(() => { window.__upd = KUpdate.check(); }); // the page may reload before it answers

test('login screen: a new version on the site → the app reloads itself into it; same version / offline → nothing', async ({ page, context }) => {
  await openApp(page);
  await expect(page.locator('#login-ver')).toContainText(CUR);
  expect(await page.evaluate(() => KUpdate.check())).toBe('same');
  await context.setOffline(true);
  expect(await page.evaluate(() => KUpdate.check())).toBe('none');
  await context.setOffline(false);
  await expect(page.locator('#kupd')).toHaveCount(0);
  await siteHas(page, '9.9.9');
  await check(page);
  await expect(page.locator('#login-ver')).toContainText('9.9.9'); // reloaded by itself, nobody had to touch it
  await expect(page.locator('#kupd')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('kupd.to'))).toBeNull();
});

test('while someone works: a green bar "Perbarui" (Arabic too) — one tap, same user still logged in; "Nanti" hides it', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await siteHas(page, '9.9.9', { navigation: false });
  expect(await page.evaluate(() => KUpdate.check())).toBe('new');
  const bar = page.locator('#kupd');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Versi baru 9.9.9 sudah siap');
  await expect(page.locator('#kupd-go')).toHaveText('Perbarui');
  await expect(page.locator('#app')).toBeVisible(); // not reloaded under the user's hands
  await page.evaluate(() => setLang('ar'));
  await page.evaluate(() => KUpdate.check());
  await expect(bar).toContainText('نسخة جديدة 9.9.9 جاهزة');
  await expect(page.locator('#kupd-go')).toHaveText('تحديث');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-update-bar-ar.png') });
  await siteHas(page, '9.9.9');
  await page.click('#kupd-go');
  await expect(page.locator('#tb-sub')).toContainText('v9.9.9');
  await expect(page.locator('#app')).toBeVisible(); // the session of this tab survives the reload
  await expect(bar).toHaveCount(0);
  // "Nanti" (later): hidden, and the next check does not bring it back at once
  await page.keyboard.press('Shift'); // someone works in it (untouched since it opened, it would just reload again)
  await siteHas(page, '9.9.10', { navigation: false });
  await page.evaluate(() => KUpdate.check());
  await expect(page.locator('#kupd-x')).toHaveText('لاحقًا');
  await page.click('#kupd-x');
  await expect(bar).toHaveCount(0);
  expect(await page.evaluate(() => KUpdate.check())).toBe('new');
  await expect(bar).toHaveCount(0);
  await expect(page.locator('#tb-sub')).toContainText('v9.9.9');
});

test('a stale copy cannot make it reload in a loop: one reload per version, then the bar', async ({ page }) => {
  await openApp(page);
  let loads = 0;
  page.on('load', () => { loads++; });
  await siteHas(page, '9.9.9', { navigation: false }); // the check sees 9.9.9, but the phone keeps getting the old page
  await check(page);
  await expect.poll(() => loads).toBe(1);
  await expect(page.locator('#login-ver')).toContainText(CUR);
  expect(await page.evaluate(() => KUpdate.check())).toBe('new');
  await expect(page.locator('#kupd')).toBeVisible();
  await page.waitForTimeout(5500); // the bar's own 5-second look did not reload either
  expect(loads).toBe(1);
  await expect(page.locator('#login-ver')).toContainText(CUR);
});
