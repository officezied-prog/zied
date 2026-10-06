// Screenshots of the main screens, phone (390×844) and tablet/desktop (1180×820).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

for (const [label, vp] of [['phone', H.PHONE], ['tablet', H.TABLET]]) {
  test.describe(label, () => {
    test.use(vp);
    test(`screens ${label}`, async ({ page, context }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const s = name => H.shot(page, `${label}-s-${name}`);
      await H.openKasir(page);
      await s('01-key');
      await H.enterKey(page);
      await s('02-users');
      await page.click('[data-act="login-user"][data-name="Siti"]');
      await s('03-pin');
      await H.typePin(page, '1111');
      await expect(page.locator('#gate #shift-open')).toBeVisible();
      await s('04-buka-kasir');
      await page.fill('#so-cash', '500000');
      await page.click('#so-ok');
      await expect(page.locator('#grid .pc').first()).toBeVisible();
      await page.waitForTimeout(2900); // let the toast go
      await s('05-sell-empty');
      await H.addItem(page, 'ajwa');
      await H.addItem(page, 'tunisia');
      await H.addItem(page, 'pistachio');
      await s('07-sell');
      if (label === 'phone') { await H.openCart(page); await s('08-cart'); await page.click('#btn-pay'); }
      else await page.click('#btn-pay');
      await expect(page.locator('#pay')).toBeVisible();
      // the manual survey is optional: opened from the link inside the payment window
      await page.click('#vs-manual');
      await expect(page.locator('#survey')).toBeVisible();
      await page.check('#sv-consent');
      await page.locator('[data-sq="1"]').fill('Lihat video di TikTok');
      await s('06-survey');
      await page.click('#sv-save');
      await expect(page.locator('#survey')).toHaveCount(0);
      await page.click('[data-act="paid-set"] >> nth=2');
      await s('09-pay');
      await page.click('#pay-ok');
      await expect(page.locator('#rc-modal #receipt')).toBeVisible();
      await s('10-receipt');
      await page.click('#rc-new');
      // credit approval step
      await H.addItem(page, 'kismis hijau');
      await H.pay(page);
      await page.click('#pm-hutang');
      await page.locator('#cp-list [data-pick]').filter({ hasText: 'Warung Bu Halimah' }).click();
      await s('11-pay-hutang');
      await page.click('#pay-ok');
      await page.click('#ap-here');
      await s('12-approval-pin');
      await H.closeModals(page);
      await H.tab(page, 'masuk');
      await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
      await expect(page.locator('#pu-photo-ok')).toBeVisible();
      await s('13-barang-masuk');
      await H.tab(page, 'kas');
      await s('14-kas');
      await page.click('#kas-close');
      await s('15-tutup-kasir');
      await H.closeModals(page);
      await H.tab(page, 'more');
      await s('16-lainnya');

      // manager view: approvals inbox
      const p2 = await context.newPage();
      await p2.addInitScript(() => { localStorage.removeItem('kpos.mock.kasir.session'); });
      await p2.setViewportSize(vp.viewport);
      await H.login(p2, 'Jihan', '2222');
      await H.setDb(p2, `db.approvals.push({ request_id: 'APR-0901', client_id: 'c1', created_at: new Date().toISOString(), cashier: 'Siti', customer_id: 2, customer_name: 'Warung Bu Halimah', customer_debt_before: 250000, total: 430000, debt_amount: 430000, summary: '5× Kismis Hijau Afghanistan 1 kg', status: 'pending', decided_by: '', decided_at: '', note: '', kind: 'credit', ref: 'c1', payload: '', approver_role: 'manager' });`);
      await p2.click('#tb-appr');
      await expect(p2.locator('.apr-card').first()).toBeVisible();
      await p2.waitForTimeout(400);
      await p2.screenshot({ path: require('path').join(H.SHOTS, `${label}-s-17-manager-inbox.png`) });
      expect(errors).toEqual([]);
    });
  });
}
