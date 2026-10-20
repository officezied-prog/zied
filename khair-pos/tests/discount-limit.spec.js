// v64 (owner 2026-10-20, to «من يحدد نسبة القصوى للتخفيض؟ — المالك»: «و المدير ايضا»): the manager sets the highest discount without
// approval in Pengaturan (that one field — the members and the other settings stay the owner's); the owner is told every change.
const { test, expect } = require('@playwright/test');
const { login, getDb, nav } = require('./helpers');

test('the manager sets the discount limit in Pengaturan; the owner gets a notice; Arabic', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'settings');
  await expect(page.locator('#st-disc')).toContainText('Batas diskon');
  await expect(page.locator('#st-mem-on')).toHaveCount(0); // the members stay the owner's
  await page.fill('#st-maxdisc', '70');
  await page.click('#st-maxdisc-save');
  await expect(page.locator('#st-disc-err')).toContainText('0,1 dan 50');
  await page.fill('#st-maxdisc', '5');
  await page.click('#st-maxdisc-save');
  await expect(page.locator('.toast.ok')).toBeVisible();
  const db = await getDb(page);
  expect(db.settings.max_discount_pct).toBe(5);
  const n = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(n).toMatchObject({ ref: 'owner', summary: 'Batas diskon tanpa persetujuan diubah oleh manajer Jihan: 3% → 5%' });
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'settings');
  await expect(page.locator('#st-disc')).toContainText('كل تغيير يُبلَّغ إلى المالك');
});
