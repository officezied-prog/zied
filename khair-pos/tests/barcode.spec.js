// Phase 4 — barcode reader. A product's SKU (barcode) typed/scanned into the POS search box + Enter
// finds the product and adds it to the cart with its price (the physical-scanner / keyboard-wedge path).
// The camera button (BarcodeDetector) is shown only on supporting browsers; the SKU field in the product
// form has a scan-to-fill camera button for assigning barcodes.
const { test, expect } = require('@playwright/test');
const { login, getDb } = require('./helpers');

test('scanning a product SKU in POS search adds it to the cart', async ({ page }) => {
  await login(page, 'Pemilik', '1234'); // owner lands on the POS screen
  const db = await getDb(page);
  const prod = db.products.find(p => p.sku && p.active !== false);
  expect(prod).toBeTruthy();
  const search = page.locator('#pos-search');
  await search.fill(prod.sku);
  await search.press('Enter');
  // an exact SKU match adds straight to the cart (no quantity sheet), and the search clears
  await expect(search).toHaveValue('');
  await expect(page.locator('#cart')).toContainText(prod.name.split(' ')[0]);
});

test('an unknown barcode does not add anything and leaves the search usable', async ({ page }) => {
  await login(page, 'Pemilik', '1234');
  const search = page.locator('#pos-search');
  await search.fill('0000000000000');
  await search.press('Enter');
  await expect(page.locator('#cart')).not.toContainText('×'); // no line added
});

test('product form exposes the SKU field (barcode) for assigning a code', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // open the first product for editing via the products view
  const { nav } = require('./helpers');
  await nav(page, 'products');
  await page.locator('#prod-list [data-act="prod-edit"], [data-act="prod-edit"]').first().click();
  await expect(page.locator('#pf-sku')).toBeVisible();
});
