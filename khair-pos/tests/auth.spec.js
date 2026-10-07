const { test, expect } = require('@playwright/test');
const { sha, openApp, enterKey, typePin, login, getDb, loginKasirRedirect, editDb, staffSession } = require('./helpers');

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
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await typePin(page, '9999');
  await expect(page.locator('.login-err')).toContainText('PIN salah');

  await page.keyboard.type('1234');
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toBeVisible();
  // a manager comes from Khair Kasir with the session of this tab
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Jihan');
  await expect(page.locator('#tb-role')).toHaveText('');
  await expect(page.locator('#shift-open')).toHaveCount(0);
  // manager has no owner-only panels
  await page.click('#nav [data-view="settings"]');
  // v19: the manager manages only cashier and sales accounts (no accountant) — 2 groups
  await expect(page.locator('#st-users [data-role-group]')).toHaveCount(2);
  await expect(page.locator('#st-users [data-role-group="owner"], #st-users [data-role-group="manager"], #st-users [data-role-group="akuntan"]')).toHaveCount(0);
  expect(await page.locator('#nu-role option').evaluateAll(o => o.map(x => x.value))).toEqual(['pekerja', 'kasir', 'sales']);
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

test('owner app lists only the owner; staff log in once in Khair Kasir and go on to their own screens', async ({ page }) => {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await enterKey(page);
  await expect(page.locator('[data-act="login-user"]')).toHaveCount(1);
  await expect(page.locator('[data-act="login-user"][data-name="Pemilik"]')).toHaveText('Pemilik');
  await expect(page.locator('#lg-staff')).toHaveAttribute('href', /kasir\/\?mock=1/);
  // Khair Kasir: everyone except the owner, names only
  await page.evaluate(() => localStorage.setItem('kpos.device_consent', JSON.stringify({ ok: false, at: new Date().toISOString() })));
  await page.goto('kasir/index.html?mock=1');
  await expect(page.locator('#users [data-act="login-user"][data-name="Jihan"]')).toHaveText('Jihan');
  await expect(page.locator('#users [data-name="Pemilik"]')).toHaveCount(0);
  await expect(page.locator('#users [data-name="Lestari"]')).toBeVisible(); // accountant
  // the accountant → management screens (read-only), no second PIN
  await page.click('#users [data-name="Lestari"]');
  await typePin(page, '5555');
  await expect(page).toHaveURL(/\/index\.html\?mock=1$/);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Lestari');
  await expect(page.locator('body')).toHaveClass(/\bro\b/);
  // a manager sells in Khair Kasir and opens "Menu manajemen" when needed
  await page.evaluate(() => { localStorage.removeItem('kpos.mock.session'); sessionStorage.clear(); localStorage.removeItem('kpos.mock.kasir.session'); localStorage.removeItem('kpos.mock.last_user'); });
  await page.goto('kasir/index.html?mock=1');
  await page.click('#users [data-name="Jihan"]');
  await typePin(page, '2222');
  await expect(page.locator('#grid .pc').first()).toBeVisible();
  await page.click('#tab-more');
  await expect(page.locator('#v-more')).toBeVisible();
  await page.click('#m-mgmt');
  await expect(page).toHaveURL(/\/index\.html\?mock=1$/);
  await expect(page.locator('#tb-user')).toHaveText('Jihan');
  await expect(page.locator('#nav [data-view="absensi"], #more-list [data-view="absensi"]').first()).toBeAttached();
});

test('manager adds a new cashier with a temporary PIN; the server refuses a manager or owner account', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.click('#nav [data-view="settings"]');
  await page.fill('#nu-name', 'Budi Kasir');
  await page.selectOption('#nu-role', 'kasir');
  await page.fill('#nu-pin', '4321');
  await page.fill('#nu-pin2', '4321');
  await page.click('[data-act="user-add"]');
  await expect(page.locator('#st-temp-pin')).toContainText('Budi Kasir');
  await expect(page.locator('#st-users [data-role-group="kasir"] tr').filter({ hasText: 'Budi Kasir' })).toBeVisible();
  const db = await getDb(page);
  expect(db.users.find(u => u.name === 'Budi Kasir')).toMatchObject({ role: 'kasir', must_change: true });
  expect(db.activity.filter(a => a.kind === 'pengguna').slice(-1)[0]).toMatchObject({ user: 'Jihan', level: 'warn' });
  for (const role of ['manager', 'owner']) {
    const r = await page.evaluate(async ([ro, h]) => { try { await api('save_user', { name: 'X Y', role: ro, pin_hash: h }); return 'ok'; } catch (e) { return e.code; } }, [role, sha('demo:x y:4321')]);
    expect(r).toBe('FORBIDDEN');
  }
  const r2 = await page.evaluate(async () => { try { await api('save_user', { name: 'Pemilik', role: 'kasir', active: false }); return 'ok'; } catch (e) { return e.code; } });
  expect(r2).toBe('FORBIDDEN');
});

test('first job choice "Pekerja harian": no account, the attendance worker form opens with the name', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.click('#nav [data-view="settings"]');
  await expect(page.locator('#nu-role')).toHaveValue('pekerja');
  await page.fill('#nu-name', 'Joko Angkut');
  await page.click('[data-act="user-add"]');
  await expect(page.locator('#view-absensi')).toBeVisible();
  await expect(page.locator('#att-editor #aw-name')).toHaveValue('Joko Angkut');
  await expect(page.locator('#att-editor #aw-wage')).toHaveCount(0); // wages are the owner's
  expect((await getDb(page)).users.some(u => u.name === 'Joko Angkut')).toBe(false);
});
