// v36 (owner 2026-10-11: «صور من يحاول كتابة الكود هذا ضروري جدا»; «… أرقام متتالية … يغلق التطبيق») in Khair Sales:
// a code attempt or a run of 8+ sequential / repeated digits in a free-text field (address, notes) locks the rep's account
// and sends a front-camera photo; the phone number, quantities and the product search never trip it; the login screen
// carries the camera notice. (Before v36 the server refused the rep's report_tamper — the account is now really locked.)
const H = require('./helpers'); const { test, expect } = H;

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('rep: notice on the login screen; phone / quantity / search never lock; a digit run in the address locks + photo', async ({ page, context }) => {
  await H.openSales(page);
  await expect(page.locator('#cam-note')).toHaveText('📷 Perangkat ini diawasi kamera untuk keamanan');
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  await H.setPos(context, -6.2580, 106.8640, 9);
  await H.startDay(page);
  // order: product search and quantities
  await H.tab(page, 'order');
  await page.fill('#po-q', '12345678');
  await page.fill('#po-q', 'ajwa');
  await page.locator('#po-sug [data-act="po-add"]').first().click();
  await page.locator('[data-po-qty]').first().fill('11111111');
  // new shop: the phone may be any number; a real number in the address is fine
  await H.tab(page, 'visit');
  await page.click('#ci-new');
  await page.fill('#ci-phone', '081111111111');
  await page.fill('#ci-address', 'Jl. Raya Condet No. 99, RT 004/RW 012');
  await page.waitForTimeout(300);
  await expect(page.locator('#app')).toBeVisible();
  expect((await H.getDb(page)).tamper_shots || []).toHaveLength(0);
  // …but a sequence typed into the address is tampering
  await page.fill('#ci-address', 'Jl. 12345678');
  await expect(page.locator('#app')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#login')).toContainText('dikunci');
  await expect(page.locator('#cam-note')).toBeVisible();
  const db = await H.getDb(page);
  expect(db.settings.locked_accounts).toContain('ahmad');
  expect(db.tamper_shots).toHaveLength(1);
  expect(db.tamper_shots[0]).toMatchObject({ user: 'Ahmad', role: 'sales', place: 'ci-address', kind: 'digits', sample: '12345678', photo_status: 'ok' });
  expect(db.tamper_shots[0].photo).toMatch(/^data:image\/jpeg;base64,/);
  // the rep cannot come back in
  await H.typePin(page, '4444');
  await expect(page.locator('#login')).toContainText('dikunci', { timeout: 20000 });
  await expect(page.locator('#app')).toBeHidden();
});

test('rep: a code attempt with the camera refused → locked, "no photo (camera refused)" recorded', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await H.login(page);
  await page.click('#tb-menu').catch(() => { });
  await H.closeModals(page);
  const r = await page.evaluate(() => { const ta = document.createElement('textarea'); ta.id = 'x-note'; document.querySelector('#app').appendChild(ta); ta.value = 'catatan ${document.cookie}'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; });
  expect(r).toBe(true);
  await expect(page.locator('#app')).toBeHidden({ timeout: 15000 });
  const db = await H.getDb(page);
  expect(db.settings.locked_accounts).toContain('ahmad');
  expect(db.tamper_shots[0]).toMatchObject({ user: 'Ahmad', place: 'x-note', kind: 'code', photo_status: 'denied', photo: '' });
  expect(db.activity.filter(a => a.kind === 'tamper' && a.user === 'Ahmad').map(a => a.summary)).toEqual(['Percobaan menulis kode — akun dikunci (x-note) · foto menyusul', 'Percobaan kode: tanpa foto (kamera ditolak) (x-note)']);
});
