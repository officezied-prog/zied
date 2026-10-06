const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, nav, addBySearch, closeModals, photoFile, loginKasirRedirect } = require('./helpers');
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
      await page.click('#vs-manual');
      await expect(page.locator('#sv-consent')).toBeVisible();
      await page.check('#sv-consent');
      await page.locator('[data-sq="1"]').fill('Lihat video di TikTok');
      await page.waitForTimeout(300);
      await shot(page, `${label}-survey`);
      await page.click('#sv-save');
      await page.click('#btn-checkout');
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

    test(`screenshots ${label}: Beranda, menu, kas, approvals, purchase photo`, async ({ page }) => {
      await login(page, 'Pemilik', '1234', '', { stay: true });
      await page.click('[data-act="home-preset"][data-p="7d"]');
      await page.waitForTimeout(400);
      await shot(page, `${label}-home`);
      await shot(page, `${label}-home-full`, true);
      if (label === 'phone') { await page.click('#nav-more'); await page.waitForTimeout(250); await shot(page, 'phone-more-menu'); await closeModals(page); }
      await nav(page, 'purchases');
      await page.setInputFiles('#pu-photo', await photoFile(page));
      await expect(page.locator('#pu-photo-card'), 'purchase photo card never reached .done').toHaveClass(/\bdone\b/, { timeout: 15000 });
      await shot(page, `${label}-purchase-photo`);
      await nav(page, 'kas');
      await shot(page, `${label}-kas-owner`);
      await nav(page, 'orders');
      await page.waitForTimeout(300);
      await shot(page, `${label}-field-orders`);
      await page.route(/cdnjs\.cloudflare\.com|tile\.openstreetmap\.org/, r => r.abort());
      await nav(page, 'field');
      await page.fill('#fd-date', (await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')).field_days.slice(-1)[0].day_date)));
      await expect(page.locator('#fd-map'), 'field map never drew (data-mode stays unset or not svg)').toHaveAttribute('data-mode', 'svg', { timeout: 15000 });
      await shot(page, `${label}-field`);
    });

    test(`screenshots ${label}: manager shift prompt, kas, dark mode, kasir redirect`, async ({ page }) => {
      await login(page, 'Jihan', '2222', '', { openShift: false });
      await page.waitForTimeout(250);
      await shot(page, `${label}-shift-open`);
      await page.fill('#so-cash', '500000');
      await page.click('#so-ok');
      await nav(page, 'kas');
      await shot(page, `${label}-kas-manager`);
      await page.emulateMedia({ colorScheme: 'dark' });
      await nav(page, 'home');
      await page.waitForTimeout(400);
      await shot(page, `${label}-home-dark`);
      await nav(page, 'pos');
      await addBySearch(page, 'ajwa');
      await shot(page, `${label}-pos-dark`);
      await page.emulateMedia({ colorScheme: 'light' });
      const p2 = await page.context().newPage();
      await loginKasirRedirect(p2);
      await p2.screenshot({ path: path.join(SHOTS, `${label}-kasir-redirect.png`) });
      await p2.close();
    });
  });
}
