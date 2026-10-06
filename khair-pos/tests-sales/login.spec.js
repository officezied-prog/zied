// Login: store key → a sales name (owner/manager also allowed) → PIN. Kasir accounts are refused.
const H = require('./helpers'); const { test, expect } = H;

test('store key, pick the sales rep, PIN; kasir names are not offered', async ({ page }) => {
  await H.openSales(page);
  await H.shot(page, 'phone-01-key');
  await page.fill('#lg-key', 'demo');
  await page.click('[data-act="login-key"]');
  await expect(page.locator('#users [data-name="Ahmad"]')).toBeVisible();
  await expect(page.locator('#users [data-act="login-user"]').first()).toHaveAttribute('data-name', 'Ahmad'); // sales first
  await expect(page.locator('#users [data-name="Pemilik"]')).toBeVisible();
  await expect(page.locator('#users [data-name="Jihan"]')).toBeVisible();
  await expect(page.locator('#users [data-name="Siti"]')).toHaveCount(0);
  await expect(page.locator('#users [data-name="Rina"]')).toHaveCount(0);
  await H.shot(page, 'phone-02-users');
  await page.click('#users [data-name="Ahmad"]');
  await H.typePin(page, '1111');
  await expect(page.locator('#login-err')).toContainText('PIN salah');
  await H.typePin(page, '4444');
  await expect(page.locator('#v-today .hero')).toContainText('Ahmad');
  await expect(page.locator('#day-start')).toContainText('Mulai kerja');
  await expect(page.locator('#tb-gps')).toBeHidden(); // no tracking before "Mulai kerja"
  await H.shot(page, 'phone-03-today-off');
  const db = await H.getDb(page);
  expect(db.users.find(u => u.name === 'Ahmad')).toMatchObject({ role: 'sales', active: true });
  expect(db.shops.length).toBeGreaterThanOrEqual(20);
});

test('a kasir user cannot log in to the sales app', async ({ page }) => {
  // e.g. a shared phone where the last user of the sales app was set to Siti
  await page.addInitScript(() => { localStorage.setItem('kpos.mock.key', JSON.stringify('demo')); localStorage.setItem('kpos.mock.sales.last_user', JSON.stringify('Siti')); });
  await H.openSales(page);
  await expect(page.locator('#pin-who')).toHaveText('Siti');
  await H.typePin(page, '1111'); // correct kasir PIN
  await expect(page.locator('#login-err')).toContainText('Akun Kasir tidak bisa memakai Khair Sales');
  await expect(page.locator('#app')).toBeHidden();
  await H.shot(page, 'phone-04-kasir-refused');
  // and the field API itself refuses a kasir
  const code = await page.evaluate(async () => { try { await apiRaw('field_bootstrap', {}, { key: 'demo', user: 'Siti', pin_hash: await pinHash('demo', 'Siti', '1111') }); return 'ok'; } catch (e) { return e.code; } });
  expect(code).toBe('FORBIDDEN');
});

test('owner can open the app read-only (catalog, shops) without tracking', async ({ page }) => {
  await H.login(page, 'Pemilik', '1234');
  await expect(page.locator('#day-start')).toHaveCount(0);
  await H.tab(page, 'shops');
  await expect(page.locator('#sh-list .shop-li').first()).toBeVisible();
  expect(await page.evaluate(() => window.SALES.S.products.some(p => 'cost_price' in p))).toBe(false);
});
