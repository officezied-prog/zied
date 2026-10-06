// v16 login in Khair Sales: no master-code link (that is for the shop), an own PIN at first login when the owner reset
// it (must_change → "Buat PIN baru", typed twice, not the old one), PIN_CHANGE_REQUIRED from any call, and LOCKED after
// 5 wrong PINs (the pad is off until the time the server gives).
const crypto = require('crypto');
const H = require('./helpers'); const { test, expect } = H;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function pinScreen(page, user = 'Ahmad') {
  await H.openSales(page);
  if (await page.locator('#lg-key').isVisible()) { await page.fill('#lg-key', 'demo'); await page.click('[data-act="login-key"]'); }
  await page.click(`#users [data-act="login-user"][data-name="${user}"]`);
  await expect(page.locator('#pin-who')).toHaveText(user);
}

test('PIN reset by the owner: "Buat PIN baru" at first login (twice, not the old one); no master-code link', async ({ page }) => {
  await pinScreen(page);
  await expect(page.locator('#login-master')).toHaveCount(0);
  await H.setDb(page, `db.users.find(u => u.name === 'Ahmad').must_change = true;`);
  await H.typePin(page, '4444');
  const np = page.locator('#newpin');
  await expect(np).toBeVisible();
  await expect(np).toContainText('Buat PIN baru');
  await expect(np).toContainText('PIN 4–6 angka');
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#np-stage')).toHaveText('Ketik PIN baru');
  // too short
  await H.typePin(page, '12');
  await expect(page.locator('#np-err')).toHaveText('PIN 4–6 angka');
  // typed differently the second time
  await H.typePin(page, '5678');
  await expect(np).toHaveAttribute('data-stage', '2');
  await expect(page.locator('#np-stage')).toHaveText('Ulangi PIN baru');
  await H.typePin(page, '5679');
  await expect(page.locator('#np-err')).toHaveText('PIN tidak sama, ulangi');
  await expect(np).toHaveAttribute('data-stage', '1');
  // the old PIN again
  await H.typePin(page, '4444');
  await H.typePin(page, '4444');
  await expect(page.locator('#np-err')).toHaveText('PIN baru harus beda dengan PIN lama');
  await H.typePin(page, '5678');
  await expect(page.locator('#np-stage')).toHaveText('Ulangi PIN baru');
  for (const d of '567') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await H.shot(page, 'phone-29-new-pin');
  await page.click('[data-act="pin-key"][data-k="8"]');
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#v-today .hero')).toBeVisible();
  await expect(np).toBeHidden();
  const db = await H.getDb(page);
  expect(db.users.find(u => u.name === 'Ahmad')).toMatchObject({ pin_hash: sha('demo:ahmad:5678'), must_change: false });
  expect(db.activity.find(a => a.kind === 'ganti_pin' && a.ref === 'Ahmad')).toMatchObject({ level: 'info' });

  // reset again while working: the next field call answers PIN_CHANGE_REQUIRED (v16 server) → the new-PIN screen at once
  await H.setDb(page, `db.users.find(u => u.name === 'Ahmad').must_change = true;`);
  expect(await page.evaluate(async () => { try { await api('field_bootstrap'); return 'ok'; } catch (e) { return e.code; } })).toBe('PIN_CHANGE_REQUIRED');
  await expect(np).toBeVisible();
  await expect(page.locator('#np-stage')).toHaveText('Ketik PIN baru');
  await expect(page.locator('#app')).toBeHidden();
  await H.typePin(page, '2468');
  await H.typePin(page, '2468');
  await expect(page.locator('#app')).toBeVisible();
  expect((await H.getDb(page)).users.find(u => u.name === 'Ahmad')).toMatchObject({ pin_hash: sha('demo:ahmad:2468'), must_change: false });
});

test('5 wrong PINs → LOCKED: tries-left hint, the time from the server, the pad is off', async ({ page }) => {
  await pinScreen(page);
  for (let i = 1; i <= 4; i++) {
    await H.typePin(page, '0000');
    await expect(page.locator('#login-err')).toContainText('PIN salah');
    if (i >= 3) await expect(page.locator('#login-err')).toContainText(`${5 - i} kali lagi`);
  }
  await H.typePin(page, '0000');
  await expect(page.locator('#login-err')).toContainText(/Coba lagi jam \d{2}:\d{2}/);
  await expect(page.locator('#pinpad[data-locked]')).toBeVisible();
  await expect(page.locator('[data-act="pin-key"][data-k="4"]')).toBeDisabled();
  await expect(page.locator('[data-act="pin-key"][data-k="ok"]')).toBeDisabled();
  await H.shot(page, 'phone-30-locked');
  const u = (await H.getDb(page)).users.find(x => x.name === 'Ahmad');
  expect(Date.parse(u.locked_until)).toBeGreaterThan(Date.now() + 14 * 60000);
  // typing on the keyboard does nothing either; the right PIN is refused by the server too
  await page.keyboard.type('4444');
  await expect(page.locator('.dots i.f')).toHaveCount(0);
  const r = await page.evaluate(async h => { try { await apiRaw('login', {}, { key: 'demo', user: 'Ahmad', pin_hash: h }); return 'ok'; } catch (e) { return e.code + ' ' + e.message; } }, sha('demo:ahmad:4444'));
  expect(r).toMatch(/^LOCKED Terlalu banyak PIN salah\. Coba lagi jam \d{2}:\d{2} WIB$/);
});
