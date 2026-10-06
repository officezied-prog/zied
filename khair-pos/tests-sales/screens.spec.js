// Phone screenshots of the remaining screens (Hari ini with next visits, Toko saya, menu, outbox).
const H = require('./helpers'); const { test, expect } = H;

test('screens phone', async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await H.login(page);
  await H.setPos(context, -6.2620, 106.8600, 10);
  await H.startDay(page);
  await page.waitForTimeout(2900);
  await expect(page.locator('#next-list .shop-li').first()).toBeVisible(); // seeded next_visit ≤ today, nearest first
  await H.shot(page, 'phone-19-today-next', true);
  await H.tab(page, 'shops');
  await H.shot(page, 'phone-20-shops');
  await page.click('#tb-menu');
  await expect(page.locator('#menu')).toContainText('Lokasi hanya dicatat');
  await H.shot(page, 'phone-21-menu');
  await H.closeModals(page);
  await context.setOffline(true);
  await H.tab(page, 'visit');
  await page.click('#ci-pick, #ci-new >> nth=0').catch(() => { });
  if (await page.locator('#ci-name').isVisible()) { await page.fill('#ci-name', 'Warung Contoh'); await H.pickType(page, 'warung'); }
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await page.click('#tb-outbox');
  await expect(page.locator('#outbox .li').first()).toBeVisible();
  await H.shot(page, 'phone-22-outbox');
  await H.closeModals(page);
  await context.setOffline(false);
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 15000 });
  expect(errors).toEqual([]);
});
