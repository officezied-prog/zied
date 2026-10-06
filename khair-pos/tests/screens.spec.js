const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, nav, addBySearch, closeModals } = require('./helpers');
const shot = (page, name, full = false) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full });

async function fillCart(page, phone) {
  await addBySearch(page, 'ajwa');
  await addBySearch(page, 'tunisia');
  await addBySearch(page, 'pistachio');
  if (phone) await shot(page, 'phone-pos');
  if (phone) { await page.click('#cart-bar'); await expect(page.locator('#cart.open')).toBeVisible(); await page.waitForTimeout(300); }
  await page.locator('.cline input[data-qty]').nth(1).fill('10');
  await page.locator('.cline input[data-qty]').nth(1).press('Enter');
}

for (const [label, vp] of [['desktop', { width: 1366, height: 768 }], ['phone', { width: 390, height: 844 }]]) {
  test.describe(label, () => {
    test.use({ viewport: vp, hasTouch: label === 'phone', isMobile: label === 'phone' });

    test(`screenshots ${label}: POS, receipt, reports, survey`, async ({ page }) => {
      await login(page);
      await fillCart(page, label === 'phone');
      await shot(page, label === 'phone' ? 'phone-cart' : 'desktop-pos');
      await page.click('#cart-cust');
      await page.locator('#cp-list [data-pick]').filter({ hasText: 'Toko Berkah' }).click();
      await page.click('#btn-checkout');
      await expect(page.locator('#sv-consent')).toBeVisible();
      await page.check('#sv-consent');
      await page.locator('[data-sq="1"]').fill('Lihat video di TikTok');
      await page.waitForTimeout(300);
      await shot(page, `${label}-survey`);
      await page.click('#sv-save');
      await expect(page.locator('.modal #receipt')).toBeVisible();
      await page.waitForTimeout(200);
      await shot(page, `${label}-receipt`);
      await closeModals(page);

      await nav(page, 'reports');
      await page.click('[data-act="rep-preset"][data-p="month"]');
      await expect(page.locator('[data-kpi="laba"]')).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, `${label}-reports`);
      await shot(page, `${label}-reports-full`, true);

      await nav(page, 'customers');
      await shot(page, `${label}-customers`);

      // Arabic / RTL
      await page.click('#tb-lang');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('#view-customers h1')).toHaveText('العملاء');
      await nav(page, 'reports');
      await page.waitForTimeout(300);
      await shot(page, `${label}-reports-ar`);
      await nav(page, 'pos');
      await shot(page, `${label}-pos-ar`);
    });
  });
}
