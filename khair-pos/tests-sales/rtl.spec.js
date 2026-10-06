// Arabic: right-to-left layout and translated labels.
const H = require('./helpers'); const { test, expect } = H;

test('Arabic renders right-to-left', async ({ page }) => {
  await H.login(page);
  await page.click('#tb-menu');
  await page.click('#lang-ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await H.closeModals(page);
  await expect(page.locator('#tab-today')).toContainText('اليوم');
  await expect(page.locator('#day-start')).toContainText('بدء العمل');
  await H.shot(page, 'phone-16-ar-today');
  await H.startDay(page);
  await expect(page.locator('#tb-gps')).toContainText('الموقع نشط');
  await H.tab(page, 'catalog');
  await expect(page.locator('#cat-present')).toContainText('عرض');
  const box = await page.locator('#cat-q').boundingBox(), icon = await page.locator('#v-catalog .search svg').boundingBox();
  expect(icon.x).toBeGreaterThan(box.x + box.width / 2);
  await expect.poll(() => page.locator('#cat-grid img[data-img]').count()).toBeGreaterThan(3);
  await H.shot(page, 'phone-17-ar-catalog');
  await H.tab(page, 'visit');
  await expect(page.locator('#ci-new')).toContainText('متجر جديد');
  await H.shot(page, 'phone-18-ar-visit');
  await page.click('#tb-menu');
  await page.click('#lang-id');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
