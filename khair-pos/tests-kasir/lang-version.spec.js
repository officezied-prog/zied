// v41 (owner 2026-10-12: «هذه الأرقام لا تظهر … ويمكن تغيير اللغة عندما يكون التطبيق مفتوح»): the version is on the login
// screen and in the top bar; a top-bar button switches Indonesian ⇄ Arabic at any moment without losing the sale in progress.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('version on the login screen and in the top bar; the language button switches while selling, the cart stays', async ({ page }) => {
  await H.openKasir(page);
  const ver = await page.evaluate(() => APP_VERSION);
  expect(ver).toMatch(/^kasir-\d+\.\d+\.\d+$/);
  await expect(page.locator('#login-ver')).toContainText('Versi: ' + ver);
  await H.login(page);
  await expect(page.locator('#tb-user')).toHaveText('Siti');
  await expect(page.locator('#tb-ver')).toHaveText(ver);
  await H.addItem(page, 'medjool');
  const lines = await page.evaluate(() => S.cart.lines.length);
  expect(lines).toBe(1);
  // one tap: Arabic, right-to-left, the same cart
  await expect(page.locator('#tb-lang-l')).toHaveText('ع');
  await page.click('#tb-lang');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#tb-lang-l')).toHaveText('ID');
  await expect(page.locator('#tabs')).toContainText('بيع');
  expect(await page.evaluate(() => S.cart.lines.length)).toBe(lines);
  await H.shot(page, 'phone-lang-toggle-ar', false, { noToasts: true });
  // and back; the choice is remembered after a reload
  await page.click('#tb-lang');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.click('#tb-lang');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});
