// v41 (owner 2026-10-12): the version is on the login screen and in the top bar; a top-bar button switches the language
// at any moment (the menu choice still works too).
const H = require('./helpers'); const { test, expect } = H;

test('version on the login screen and in the top bar; the top-bar language button switches Indonesian ⇄ Arabic', async ({ page }) => {
  await H.openSales(page);
  const ver = await page.evaluate(() => APP_VERSION);
  expect(ver).toMatch(/^sales-\d+\.\d+\.\d+$/);
  await expect(page.locator('#login-ver')).toContainText('Versi: ' + ver);
  await H.login(page);
  await expect(page.locator('#tb-user')).toHaveText(ver);
  await expect(page.locator('#tb-lang-l')).toHaveText('ع');
  await page.click('#tb-lang');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#tb-lang-l')).toHaveText('ID');
  await page.click('#tb-lang');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
