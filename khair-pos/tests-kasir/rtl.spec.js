// Arabic: RTL layout, translated labels; phone and tablet screenshots.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

for (const [label, vp] of [['phone', H.PHONE], ['tablet', H.TABLET]]) {
  test.describe(label, () => {
    test.use(vp);
    test(`Arabic renders right-to-left (${label})`, async ({ page }) => {
      await H.login(page);
      await H.tab(page, 'more');
      await page.click('#lang-ar');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
      await expect(page.locator('#tab-sell')).toContainText('بيع');
      await expect(page.locator('#tab-more')).toContainText('المزيد');
      await H.shot(page, `${label}-ar-more`);
      await H.tab(page, 'sell');
      await H.addItem(page, 'ajwa');
      await H.addItem(page, 'sukkari');
      if (label === 'phone') await expect(page.locator('#paybar-pay')).toHaveText('ادفع');
      else await expect(page.locator('#btn-pay')).toHaveText('ادفع');
      // the search box sits on the right edge in RTL
      const box = await page.locator('#q').boundingBox();
      const icon = await page.locator('.search svg').boundingBox();
      expect(icon.x).toBeGreaterThan(box.x + box.width / 2);
      await H.shot(page, `${label}-ar-sell`);
      await H.pay(page);
      await expect(page.locator('#pm-tunai')).toHaveText('نقدًا');
      await H.shot(page, `${label}-ar-pay`);
      await page.click('#pay-ok');
      await expect(page.locator('#rc-modal')).toContainText('الإيصال');
      await page.click('#rc-new');
      await H.tab(page, 'more');
      await page.click('#lang-id');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.locator('#tab-sell')).toContainText('Jual');
    });
  });
}
