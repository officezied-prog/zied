// v16 login: the owner's master code (8 digits) opens any account, an own PIN at first login (must_change, typed twice),
// PIN_CHANGE_REQUIRED from any call, and LOCKED after 5 wrong PINs (pad off until the time the server gives).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
const owner = H.sha('demo:pemilik:1234');
const asOwner = (page, action, data) => page.evaluate(async ([a, d, h]) => { try { return await apiRaw(a, d, { key: 'demo', user: 'Pemilik', pin_hash: h }); } catch (e) { return { error: e.code, message: e.message }; } }, [action, data, owner]);
async function pinScreen(page, user) {
  await H.openKasir(page);
  await H.enterKey(page);
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await expect(page.locator('#pin-who')).toHaveText(user);
}

test('"Masuk dengan kode pemilik": 8 digits open the kasir account; header badge; logged masuk_master', async ({ page }) => {
  await pinScreen(page, 'Siti');
  const master = H.sha('demo:__master__:12345678');
  expect(await asOwner(page, 'set_master', { master_hash: master })).toMatchObject({ ok: true });
  await page.click('#login-master');
  await expect(page.locator('#pin-title')).toHaveText('Kode pemilik (8 angka)');
  for (const d of '1234567') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#login-err')).toContainText('8 angka');
  for (const d of '12345678') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await expect(page.locator('.dots i.f')).toHaveCount(8);
  await H.shot(page, 'phone-45-master-login');
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-master')).toHaveText('via kode pemilik');
  const db = await H.getDb(page);
  expect(db.activity.find(a => a.kind === 'masuk_master' && a.ref === 'Siti')).toMatchObject({ user: 'Siti', level: 'warn' });
  expect(db.activity.find(a => a.kind === 'kode_pemilik')).toMatchObject({ user: 'Pemilik', level: 'warn' });
  // no offline verifier is stored for a master-code login
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('kpos.mock.pins') || '{}')).siti).toBeUndefined();
  // the master code cannot change the owner's own PIN
  expect(await page.evaluate(async h => { try { await apiRaw('change_pin', { new_pin_hash: 'c'.repeat(64) }, { key: 'demo', user: 'Pemilik', pin_hash: h }); return 'ok'; } catch (e) { return e.code; } }, master)).toBe('FORBIDDEN');
});

test('a PIN reset by the owner must be replaced at first login (typed twice, not the old one); PIN_CHANGE_REQUIRED mid-session', async ({ page }) => {
  await pinScreen(page, 'Rina');
  expect(await asOwner(page, 'save_user', { name: 'Rina', role: 'kasir', pin_hash: H.sha('demo:rina:5555'), active: true })).toMatchObject({ ok: true, user: { must_change: true } });
  await H.typePin(page, '5555');
  const np = page.locator('#newpin');
  await expect(np).toBeVisible();
  await expect(np).toContainText('Buat PIN baru');
  await expect(np).toContainText('PIN 4–6 angka');
  await H.typePin(page, '5555'); await H.typePin(page, '5555');
  await expect(page.locator('#np-err')).toContainText('harus beda');
  await H.typePin(page, '1234'); await H.typePin(page, '1243');
  await expect(page.locator('#np-err')).toContainText('tidak sama');
  await H.typePin(page, '2468');
  await expect(np).toHaveAttribute('data-stage', '2');
  await expect(page.locator('#np-stage')).toHaveText('Ulangi PIN baru');
  await H.typePin(page, '2468');
  await expect(page.locator('#app')).toBeVisible(); // Rina still has her drawer open from yesterday (demo data)
  await expect(page.locator('#newpin')).toHaveCount(0);
  let db = await H.getDb(page);
  expect(db.users.find(u => u.name === 'Rina')).toMatchObject({ pin_hash: H.sha('demo:rina:2468'), must_change: false });
  expect(db.activity.find(a => a.kind === 'ganti_pin' && a.ref === 'Rina')).toMatchObject({ level: 'info' });
  // mid-session the server says PIN_CHANGE_REQUIRED (the owner reset it again) → the same screen
  await H.setDb(page, `db.users.find(u => u.name === 'Rina').must_change = true;`);
  await page.evaluate(() => refreshData(true));
  await expect(page.locator('#newpin')).toBeVisible();
});

test('Arabic: new-PIN screen for a manager asks 6 digits', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kpos.mock.lang', JSON.stringify('ar')));
  await pinScreen(page, 'Jihan');
  await asOwner(page, 'save_user', { name: 'Jihan', role: 'manager', pin_hash: H.sha('demo:jihan:7777'), active: true });
  await H.typePin(page, '7777');
  await expect(page.locator('#newpin')).toContainText('6');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await H.typePin(page, '1357');
  await expect(page.locator('#np-err')).toContainText('6');
  await H.shot(page, 'phone-46-new-pin-ar');
  await H.typePin(page, '135790'); await H.typePin(page, '135790');
  await expect(page.locator('#app')).toBeVisible();
});

test('5 wrong PINs → LOCKED: the time from the server, the pad is off, the right PIN is refused too', async ({ page }) => {
  await pinScreen(page, 'Siti');
  for (let i = 1; i <= 4; i++) {
    await H.typePin(page, '0000');
    await expect(page.locator('#login-err')).toContainText('PIN salah');
    if (i >= 3) await expect(page.locator('#login-err')).toContainText(`${5 - i} kali lagi`);
  }
  await H.typePin(page, '0000');
  await expect(page.locator('#login-err')).toContainText(/Coba lagi jam \d{2}:\d{2}/);
  await expect(page.locator('#pinpad[data-locked]')).toBeVisible();
  await expect(page.locator('[data-act="pin-key"][data-k="1"]')).toBeDisabled();
  await H.shot(page, 'phone-47-locked');
  const db = await H.getDb(page);
  const u = db.users.find(x => x.name === 'Siti');
  expect(Date.parse(u.locked_until)).toBeGreaterThan(Date.now() + 14 * 60000);
  const r = await page.evaluate(async h => { try { await apiRaw('login', {}, { key: 'demo', user: 'Siti', pin_hash: h }); return 'ok'; } catch (e) { return e.code + ' ' + e.message; } }, H.sha('demo:siti:1111'));
  expect(r).toMatch(/^LOCKED Terlalu banyak PIN salah\. Coba lagi jam \d{2}:\d{2} WIB$/);
  // another account is not affected
  await page.click('[data-act="login-back"] >> nth=0');
  await page.click('[data-act="login-user"][data-name="Rina"]');
  await expect(page.locator('#pinpad[data-locked]')).toHaveCount(0);
});
