// ?demo=1: demo data with an open login (no store key, no PIN) so staff can try the apps from a link.
const { test, expect } = require('@playwright/test');

test('?demo=1&u=Jihan opens the owner app as Jihan without key or PIN', async ({ page }) => {
  await page.goto('index.html?demo=1&u=Jihan');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Jihan');
  expect(await page.evaluate(() => KPOS.S.role)).toBe('manager');
});

test('?demo=1 skips the store key; tapping a name logs in, a cashier lands in Khair Kasir', async ({ page }) => {
  await page.goto('index.html?demo=1');
  await expect(page.locator('#lg-key')).toHaveCount(0);
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Pemilik');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('index.html?demo=1');
  await page.click('[data-act="login-user"][data-name="Siti"]');
  await page.waitForURL(/kasir\/\?demo=1&u=Siti/);
  await expect(page.locator('#gate #shift-open')).toBeVisible();
});

test('Khair Sales ?demo=1&u=Ahmad opens the rep app directly; a kasir name is refused', async ({ page }) => {
  await page.goto('sales/index.html?demo=1&u=Ahmad');
  await expect(page.locator('#app')).toBeVisible();
  expect(await page.evaluate(() => SALES.S.user)).toBe('Ahmad');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('sales/index.html?demo=1&u=Siti');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
});

test('real mode (no demo flag) still asks for the store key', async ({ page }) => {
  await page.goto('index.html');
  await expect(page.locator('#lg-key')).toBeVisible();
});
