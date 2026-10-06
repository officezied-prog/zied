const { test, expect } = require('@playwright/test');
const { sha, openApp, enterKey, typePin, login, getDb } = require('./helpers');

test('first run: store key → setup owner → login, lock and unlock with PIN', async ({ page }) => {
  await openApp(page, '&seed=empty');
  await enterKey(page);
  await expect(page.locator('#su-name')).toBeVisible();

  await page.fill('#su-name', 'Ahmad');
  await page.fill('#su-pin', '2468');
  await page.fill('#su-pin2', '2469');
  await page.click('[data-act="login-setup"]');
  await expect(page.locator('.login-err')).toContainText('PIN tidak sama');

  await page.fill('#su-pin2', '2468');
  await page.click('[data-act="login-setup"]');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Ahmad');
  await expect(page.locator('#tb-role')).toHaveText('Pemilik');

  const db = await getDb(page);
  expect(db.users).toHaveLength(1);
  expect(db.users[0]).toMatchObject({ name: 'Ahmad', role: 'owner', pin_hash: sha('demo:ahmad:2468') });

  // session survives a reload without retyping the PIN
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Ahmad');

  // lock → wrong PIN → right PIN
  await page.click('#tb-lock');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#login h2')).toContainText('terkunci');
  await typePin(page, '0000');
  await expect(page.locator('.login-err')).toContainText('PIN salah');
  await typePin(page, '2468');
  await expect(page.locator('#app')).toBeVisible();
});

test('login: wrong PIN is rejected, keyboard PIN entry works, bad store key is rejected', async ({ page }) => {
  await openApp(page);
  await page.fill('#lg-key', 'salah');
  await page.click('[data-act="login-key"]');
  await expect(page.locator('.login-err')).toContainText('Kode toko tidak dikenal');

  await enterKey(page);
  await page.click('[data-act="login-user"][data-name="Siti"]');
  await typePin(page, '9999');
  await expect(page.locator('.login-err')).toContainText('PIN salah');

  await page.keyboard.type('1111');
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-role')).toHaveText('Kasir');
  await page.click('#shift-later');
  // kasir has no owner-only panels
  await page.click('#nav [data-view="settings"]');
  await expect(page.locator('#st-users')).toHaveCount(0);
  await expect(page.locator('#st-outbox')).toBeVisible();
});

test('auto-lock after idle time', async ({ page }) => {
  await login(page);
  await page.evaluate(() => { KPOS.S.lockMinutes = 1; KPOS.S.lastActivity = Date.now() - 2 * 60000; });
  await expect(page.locator('#login')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.pinpad')).toBeVisible();
});
