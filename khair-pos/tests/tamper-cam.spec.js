// v36 (owner 2026-10-11: «صور من يحاول كتابة الكود هذا ضروري جدا»; «… أرقام متتالية … يغلق التطبيق»): in the owner app
// a manager / accountant who types code — or a run of 8+ sequential / repeated digits in a free-text field — is locked
// and photographed with the front camera; the OWNER sees the photo in "Perlu perhatian", Pengaturan → Pengguna and
// Aktivitas, and unlocks from there. list_tamper_shots is owner-only. The lock screen of a staff session carries the notice.
const { test, expect } = require('@playwright/test');
const { login, getDb, nav, typePin, enterKey, asUser } = require('./helpers');

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

async function ownerLogin(page) {
  await page.evaluate(() => { localStorage.removeItem('kpos.mock.session'); sessionStorage.clear(); });
  await page.goto('index.html?mock=1');
  if (await page.locator('#lg-key').count()) await enterKey(page);
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await typePin(page, '1234');
  await expect(page.locator('#app')).toBeVisible();
}

test('manager types a digit run in a customer note → locked + photographed; the owner sees the photo and unlocks', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'customers');
  await page.click('[data-act="cust-new"]');
  // numbers where they belong never lock: the phone, a real phone number in the note
  await page.fill('[name="c_phone"]', '081111111111');
  await page.fill('[name="c_notes"]', 'WA 0812 3456 7890, buka jam 8');
  await page.waitForTimeout(300);
  await expect(page.locator('#app')).toBeVisible();
  // a sequential run in the note is tampering
  await page.fill('[name="c_notes"]', 'Pelanggan 87654321');
  await expect(page.locator('#app')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#login')).toContainText('dikunci');
  let db = await getDb(page);
  expect(db.settings.locked_accounts).toContain('jihan');
  expect(db.tamper_shots).toHaveLength(1);
  expect(db.tamper_shots[0]).toMatchObject({ user: 'Jihan', role: 'manager', kind: 'digits', sample: '87654321', place: 'c_notes', photo_status: 'ok' });
  expect(db.tamper_shots[0].photo).toMatch(/^data:image\/jpeg;base64,/);
  // only the owner reads the photos
  const no = await asUser(page, 'Rina', '3333', 'list_tamper_shots', {});
  expect(no.error).toBe('FORBIDDEN');

  // the owner: "Perlu perhatian" → the photo window → unlock
  await ownerLogin(page);
  await page.evaluate(() => KPOS.refreshAttention()); // (the bell fills a moment after opening)
  await page.click('#tb-bell');
  const item = page.locator('#bell-att [data-key="tamper"]');
  await expect(item).toContainText('1 akun dikunci setelah percobaan kode — lihat foto');
  await item.click();
  const win = page.locator('#tamper-shots');
  await expect(win).toBeVisible();
  await expect(win.locator('.ts-shot')).toHaveCount(1);
  await expect(win.locator('.ts-shot')).toContainText('Jihan');
  await expect(win.locator('.ts-shot')).toContainText('Angka berurutan "87654321"');
  await expect(win.locator('.ts-shot')).toContainText('Kolom: c_notes');
  await expect(win.locator('img.ts-photo')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  expect(await win.locator('img.ts-photo').evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);
  await win.locator('[data-act="user-unlock"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('#tamper-shots')).toHaveCount(0, { timeout: 20000 });
  await expect.poll(async () => (await getDb(page)).settings.locked_accounts, { timeout: 20000 }).toEqual([]);
});

test('owner: Pengaturan → Pengguna "Foto" and Aktivitas "Foto" open the shots; a refused camera shows "Tanpa foto (kamera ditolak)"; Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // two shots (the demo server's own report_tamper, as the cashier / rep apps send them)
  const r1 = await asUser(page, 'Siti', '1111', 'report_tamper', { where: 'cm-note', kind: 'code', shot_id: 'TSAAAAAAAAAAAA', photo_status: 'pending' });
  expect(r1).toMatchObject({ ok: true, locked: true, photo_status: 'pending' });
  const r2 = await asUser(page, 'Siti', '1111', 'report_tamper', { where: 'cm-note', kind: 'code', shot_id: 'TSAAAAAAAAAAAA', photo_status: 'ok', photo: PHOTO });
  expect(r2).toMatchObject({ ok: true, photo_status: 'ok' });
  await asUser(page, 'Ahmad', '4444', 'report_tamper', { where: 'ci-notes', kind: 'digits', sample: '11111111', shot_id: 'TSBBBBBBBBBBBB', photo_status: 'denied' });
  const db = await getDb(page);
  expect(db.tamper_shots.map(s => [s.user, s.photo_status])).toEqual([['Siti', 'ok'], ['Ahmad', 'denied']]);
  expect(db.tamper_shots[0].photo).toBe(PHOTO);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'settings');
  const row = page.locator('#st-users tr').filter({ hasText: 'Ahmad' });
  await row.locator('[data-act="tamper-shots"]').click();
  const win = page.locator('#tamper-shots');
  await expect(win.locator('.ts-shot')).toHaveCount(1);
  await expect(win.locator('.ts-nophoto')).toContainText('Tanpa foto (kamera ditolak)');
  await expect(win.locator('.ts-shot')).toContainText('Angka berurutan "11111111"');
  await page.locator('#tamper-shots [data-act="modal-close"]').click();
  // Aktivitas: the lock entry has its "Foto" button
  await nav(page, 'activity');
  const act = page.locator('.act-row[data-kind="tamper"]').filter({ hasText: 'Siti' }).first();
  await act.locator('[data-act="tamper-shots"]').click();
  await expect(page.locator('#tamper-shots .ts-shot')).toHaveCount(1);
  await expect(page.locator('#tamper-shots img.ts-photo')).toHaveAttribute('src', PHOTO);
  await page.locator('#tamper-shots [data-act="modal-close"]').click();
  // Arabic
  await nav(page, 'settings');
  await page.click('#view-settings [data-act="set-lang"][data-lang="ar"]');
  await page.evaluate(() => KPOS.refreshAttention());
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="tamper"]')).toContainText('2 حساب موقوف بعد محاولة كود — شاهد الصورة');
});

test('a staff session\'s lock screen carries the camera notice; the owner\'s own does not', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.click('#tb-lock');
  await expect(page.locator('#cam-note')).toHaveText('📷 Perangkat ini diawasi kamera untuk keamanan');
  await ownerLogin(page);
  await page.click('#tb-lock');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#cam-note')).toHaveCount(0);
});
