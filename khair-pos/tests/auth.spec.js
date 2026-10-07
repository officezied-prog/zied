const { test, expect } = require('@playwright/test');
const { sha, openApp, enterKey, typePin, login, getDb, loginKasirRedirect } = require('./helpers');

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
  await expect(page.locator('#tb-role')).toHaveText('');

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
  await page.click('[data-act="login-user"][data-name="Jihan"]');
  await typePin(page, '9999');
  await expect(page.locator('.login-err')).toContainText('PIN salah');

  await page.keyboard.type('2222');
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-role')).toHaveText('');
  await expect(page.locator('#shift-open')).toHaveCount(0);
  // manager has no owner-only panels
  await page.click('#nav [data-view="settings"]');
  await expect(page.locator('#st-users')).toHaveCount(0);
  await expect(page.locator('#st-outbox')).toBeVisible();
  await expect(page.locator('#st-kasir-app')).toHaveAttribute('href', './kasir/?mock=1');
});

test('kasir account: owner app shows the cashier-app screen, logs out and redirects to ./kasir/ after 2 s', async ({ page }) => {
  await loginKasirRedirect(page, 'Siti', '1111');
  await expect(page.locator('#kasir-redirect')).toContainText('Aplikasi ini untuk pemilik');
  await expect(page.locator('#kasir-go')).toHaveAttribute('href', './kasir/?mock=1');
  await expect(page.locator('#app')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('kpos.mock.session'))).toBeNull();
  await page.waitForURL(/\/kasir\/\?mock=1$/, { timeout: 5000 });
  await expect(page.locator('body')).toContainText('kasir app');
});

test('auto-lock after idle time', async ({ page }) => {
  await login(page);
  await page.evaluate(() => { KPOS.S.lockMinutes = 1; KPOS.S.lastActivity = Date.now() - 2 * 60000; });
  await expect(page.locator('#login')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.pinpad')).toBeVisible();
});

test('names only; the owner shows on the login screen only on a device opened with his own link (khair-pos/zied/)', async ({ page }) => {
  await openApp(page, '', { ownerDevice: false });
  await enterKey(page);
  await expect(page.locator('[data-act="login-user"][data-name="Jihan"]')).toHaveText('Jihan');
  await expect(page.locator('[data-act="login-user"][data-name="Pemilik"]')).toHaveCount(0);
  // the owner link marks the device (live prefix) and opens the app
  await page.goto('zied/');
  await expect(page).toHaveURL(/\/index\.html$/);
  expect(await page.evaluate(() => localStorage.getItem('kpos.owner_device'))).toBe('true');
  await page.evaluate(() => localStorage.setItem('kpos.mock.owner_device', 'true'));
  await page.goto('index.html?mock=1');
  await expect(page.locator('[data-act="login-user"][data-name="Pemilik"]')).toHaveText('Pemilik');
});
