// v21 goods-in: every line needs a shelf life — a real date, or "tak ada" (no expiry) for items like cups / honey.
// The date is stored on the purchase batch and becomes the product's shown expiry (soonest wins; red in stock < 6 months).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('goods-in needs an expiry (date or "tak ada") per line; it reaches the product', async ({ page }) => {
  await H.login(page);
  await H.setDb(page, `db.settings.require_purchase_photo = false;`);
  await page.evaluate(() => refreshData(true));
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Kurma Ajwa/);

  await H.tab(page, 'masuk');
  await page.fill('#pu-q', 'Ajwa');
  await page.locator('[data-act="pu-add"]').first().click();
  await page.locator('[data-pu-qty="0"]').fill('5');
  await page.locator('[data-pu-cost="0"]').fill('140.000');
  await H.pickCarrier(page);

  // no expiry chosen yet → the save is refused and nothing is written
  await page.click('#pu-save');
  await expect(page.locator('#pu-err')).toContainText('kedaluwarsa');
  expect((await H.getDb(page)).purchases.length).toBe(db0.purchases.length);

  // a real date → saved; the batch keeps it and the product's shown expiry becomes that date (fresh stock path)
  await page.locator('[data-pu-exp="0"]').fill('2027-03-01');
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-no')).toBeVisible();
  let db = await H.getDb(page);
  expect(db.purchases.slice(-1)[0]).toMatchObject({ product_id: ajwa.id, exp_date: '2027-03-01' });
  expect(db.products.find(p => p.id === ajwa.id)).toMatchObject({ exp_date: '2027-03-01', exp_none: false });

  // a second goods-in with "tak ada" → the product is marked no-expiry (never red), no date stored
  const gula = H.productByName(db, /Gula Pasir/);
  await page.fill('#pu-q', 'Gula');
  await page.locator('[data-act="pu-add"]').first().click();
  await page.locator('[data-pu-qty="0"]').fill('3');
  await page.locator('[data-pu-cost="0"]').fill('15.000');
  await page.locator('[data-pu-expnone="0"]').check();
  await expect(page.locator('[data-pu-exp="0"]')).toBeDisabled();
  await H.pickCarrier(page);
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-no')).toBeVisible();
  db = await H.getDb(page);
  expect(db.products.find(p => p.id === gula.id)).toMatchObject({ exp_none: true, exp_date: '' });
});
