// v17 attendance in Khair Kasir: the shop device screen ("Lainnya → Absensi pekerja"); a kasir may record, never read reports.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { window.KFACE_STUB = { descriptor: null }; }); });

test('kasir opens the attendance screen; a worker checks in by face; reports stay closed to the kasir', async ({ page }) => {
  await H.login(page);
  await H.tab(page, 'more');
  await page.click('#m-att');
  const k = page.locator('#att-kiosk.kak');
  await expect(k.locator('.kak-w')).toHaveCount(3);
  await page.evaluate(() => { window.KFACE_STUB.descriptor = window.KAttMock.demoFace(1); });
  await k.locator('.kak-w', { hasText: 'Slamet Riyadi' }).click();
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '1');
  await expect(k.locator('#kak-result .big')).toContainText('MASUK');
  await H.shot(page, 'phone-70-absensi', false, { noToasts: true });
  const db = await H.getDb(page);
  expect(db.att.records.slice(-1)[0]).toMatchObject({ kind: 'in', worker_name: 'Slamet Riyadi', by_user: 'Siti', face_ok: true });
  const r = await page.evaluate(async () => { try { await api('att_report', { from: '2026-01-01', to: '2026-01-31' }, { att: true }); return 'ok'; } catch (e) { return e.code; } });
  expect(r).toBe('FORBIDDEN');
  await k.locator('#kak-close').click();
  await expect(k).toHaveCount(0);
});

test('Arabic attendance screen', async ({ page }) => {
  await H.login(page);
  await page.evaluate(() => { S.lang = 'ar'; });
  await H.tab(page, 'more');
  await page.click('#m-att');
  const k = page.locator('#att-kiosk.kak');
  await expect(k).toHaveAttribute('dir', 'rtl');
  await expect(k).toContainText('اضغط على اسمك');
  await H.shot(page, 'phone-71-absensi-ar', false, { noToasts: true });
});
