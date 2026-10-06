// Retail vs wholesale price: automatic at wholesale_min_qty, by grosir customer, or by the manual "Grosir" toggle.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.TABLET);

test('wholesale price kicks in at wholesale_min_qty; manual Grosir toggle; grosir customer', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Ajwa/), suk = H.productByName(db0, /Sukkari/);
  expect(ajwa.wholesale_min_qty).toBe(5);
  await H.addItem(page, 'ajwa');
  const line = page.locator(`.cl[data-pid="${ajwa.id}"]`);
  await line.locator('input[data-qty]').fill('4');
  await expect(line.locator('[data-ref="pt"]')).toHaveText('Eceran');
  await expect(line.locator('[data-ref="up"]')).toHaveText('× ' + H.rp(175000));
  await line.locator('[data-act="qty-inc"]').click();
  await expect(line.locator('input[data-qty]')).toHaveValue('5');
  await expect(line.locator('[data-ref="pt"]')).toHaveText('Grosir');
  await expect(line.locator('[data-ref="up"]')).toHaveText('× ' + H.rp(160000));
  await expect(page.locator('#cart-total')).toHaveText(H.rp(5 * 160000));
  await line.locator('[data-act="qty-dec"]').click();
  await expect(line.locator('[data-ref="pt"]')).toHaveText('Eceran');

  // manual toggle: everything at the wholesale price
  await H.addItem(page, 'sukkari');
  const sl = page.locator(`.cl[data-pid="${suk.id}"]`);
  await expect(sl.locator('[data-ref="up"]')).toHaveText('× ' + H.rp(115000));
  await page.click('#grosir');
  await expect(page.locator('#grosir')).toHaveAttribute('aria-pressed', 'true');
  await expect(sl.locator('[data-ref="up"]')).toHaveText('× ' + H.rp(102000));
  await expect(line.locator('[data-ref="up"]')).toHaveText('× ' + H.rp(160000));
  await H.shot(page, 'tablet-02-grosir');
  await page.click('#grosir');
  await expect(sl.locator('[data-ref="up"]')).toHaveText('× ' + H.rp(115000));

  // a grosir customer gets wholesale prices automatically
  await page.click('#cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Toko Berkah Condet' }).click();
  await expect(sl.locator('[data-ref="pt"]')).toHaveText('Grosir');
  await H.pay(page);
  await page.click('#pm-transfer');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const db = await H.getDb(page);
  const inv = db.sales[db.sales.length - 1].invoice_no;
  const items = db.items.filter(i => i.invoice_no === inv);
  expect(items.find(i => i.product_id === ajwa.id)).toMatchObject({ qty: 4, unit_price: 160000, price_type: 'grosir' });
  expect(items.find(i => i.product_id === suk.id)).toMatchObject({ qty: 1, unit_price: 102000, price_type: 'grosir' });
});
