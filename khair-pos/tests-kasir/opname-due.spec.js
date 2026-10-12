// v37 (owner 2026-10-12: «والكميات التي يتم جردها آخر كل شهرين»): a FULL stock count every opname_every_days (default 60).
// When ≤ 7 days are left or it is overdue, Khair Kasir shows a banner on the sell screen (the cashier can count here: "Hitung stok");
// "×" hides it for today. The stock-count window shows "last full count — next". Computed from the settings already loaded.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const back = n => new Date(Date.now() + 7 * 3600000 - n * 86400000).toISOString().slice(0, 10);

test('opname due: banner on the sell screen opens the stock count with last/next; × hides it for today', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, `db.settings.opname_state = { since: '2026-01-01', last_full: arg, last_full_by: 'Pemilik' };`, back(57));
  await H.login(page, 'Siti', '1111', { noGoto: true });
  const b = page.locator('#op-banner');
  await expect(b).toBeVisible();
  await expect(b).toHaveAttribute('data-status', 'due');
  await expect(b).toContainText('Stok opname penuh jatuh tempo');
  await expect(b).toContainText('(3 hari lagi)');
  await page.click('#op-banner-go');
  await expect(page.locator('#stock-count')).toBeVisible();
  await expect(page.locator('#sc-due')).toContainText('Opname penuh terakhir:');
  await expect(page.locator('#sc-due')).toHaveAttribute('data-status', 'due');
  await H.closeModals(page);
  await page.click('[data-act="opname-snooze"]');
  await expect(b).toBeHidden();
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#op-banner')).toBeHidden(); // hidden for the rest of today
});

test('opname overdue: banner says how late (Arabic too); not due → no banner', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, `db.settings.opname_state = { since: '2026-01-01', last_full: arg };`, back(65));
  await H.login(page, 'Siti', '1111', { noGoto: true });
  const b = page.locator('#op-banner');
  await expect(b).toHaveAttribute('data-status', 'overdue');
  await expect(b).toContainText('TERLAMBAT 5 hari');
  await page.evaluate(() => { S.lang = 'ar'; updateOpnameBanner(); });
  await expect(b).toContainText('الجرد الكامل متأخر 5 يوم');
  // the owner / manager were told once by the server (mock) when the app started
  const db = await H.getDb(page);
  expect(db.activity.filter(a => a.kind === 'notifikasi' && /TERLAMBAT/.test(a.summary) && a.ref === 'owner,manager')).toHaveLength(1);
  // a recent full count → nothing to remind
  await H.setDb(page, `db.settings.opname_state = { since: '2026-01-01', last_full: arg };`, back(10));
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#grid .pc').first()).toBeVisible();
  await expect(page.locator('#op-banner')).toBeHidden();
});
