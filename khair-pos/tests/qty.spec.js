// POS: tapping a product asks the quantity (sheet with −/+, keypad input, quick chips, live price incl. grosir).
// Barcode scans still add 1; the per-device setting "Tanya jumlah" (Pengaturan) turns the sheet off.
const { test, expect } = require('@playwright/test');
const { rp, login, getDb, productByName, nav, SHOTS } = require('./helpers');
const path = require('path');

const tapCard = async (page, query) => { await page.fill('#pos-search', query); await page.locator('#pos-grid .pcard').first().click(); };

test('tap → 12 → grosir price; chips; "Ubah" sets the line; scan adds 1; Enter confirms', async ({ page }) => {
  await login(page);
  const db = await getDb(page);
  const beras = productByName(db, /Beras Premium/), tun = productByName(db, /Tunisia/);
  await tapCard(page, 'beras');
  await expect(page.locator('#qty-sheet .modal-h h2')).toHaveText(beras.name);
  await expect(page.locator('#qs-gr')).toHaveText('Grosir Rp 72.500 · ≥10');
  await expect(page.locator('#qs-qty')).toBeFocused(); // desktop: type straight away
  await expect(page.locator('#qs-total')).toHaveText(rp(76000));
  await page.keyboard.type('12');
  await expect(page.locator('#qs-total')).toHaveText(rp(12 * 72500));
  await expect(page.locator('#qs-pt')).toHaveText('Grosir');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-qty-sheet.png') });
  await page.keyboard.press('Enter');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
  const line = page.locator('.cline').first();
  await expect(line.locator('input[data-qty]')).toHaveValue('12');
  await expect(line.locator('.ptype')).toHaveText('Grosir');
  await expect(page.locator('#cart-total')).toHaveText(rp(870000));

  // quick chips, incl. the grosir chip
  await tapCard(page, 'tunisia');
  await expect(page.locator('#qs-chips [data-q]')).toHaveText(['1', '2', '3', '5', '10', 'Grosir 10']);
  await page.click('#qs-chip-g');
  await expect(page.locator('#qs-total')).toHaveText(rp(10 * tun.wholesale_price));
  await page.click('#qs-chips [data-q="2"]');
  await expect(page.locator('#qs-total')).toHaveText(rp(2 * tun.retail_price));
  await page.click('#qs-ok');
  await expect(page.locator('.cline').nth(1).locator('input[data-qty]')).toHaveValue('2');
  // tap again → "Ubah" on the current quantity, sets (not adds)
  await tapCard(page, 'tunisia');
  await expect(page.locator('#qs-qty')).toHaveValue('2');
  await expect(page.locator('#qs-ok')).toHaveText('Ubah');
  await page.click('#qs-inc');
  await page.click('#qs-ok');
  await expect(page.locator('.cline').nth(1).locator('input[data-qty]')).toHaveValue('3');
  // barcode scanner: +1 without a sheet
  await page.fill('#pos-search', '');
  await page.locator('#pos-search').focus();
  await page.keyboard.type(tun.sku, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
  await expect(page.locator('.cline').nth(1).locator('input[data-qty]')).toHaveValue('4');
  // a scan while the sheet is open is a scan (+1 of the scanned item), not a giant quantity
  await tapCard(page, 'beras');
  await expect(page.locator('#qs-qty')).toBeFocused();
  await page.keyboard.type(tun.sku, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
  await expect(page.locator('.cline').nth(0).locator('input[data-qty]')).toHaveValue('12');
  await expect(page.locator('.cline').nth(1).locator('input[data-qty]')).toHaveValue('5');
  await tapCard(page, 'beras');
  await page.fill('#qs-qty', '100000');
  await expect(page.locator('#qs-warn')).toHaveText('Jumlah terlalu besar');
  await expect(page.locator('#qs-ok')).toBeDisabled();
});

test('setting OFF (per device) restores tap-adds-1; phone sheet in Arabic', async ({ page }) => {
  await login(page);
  await nav(page, 'settings');
  await expect(page.locator('#askqty-on')).toHaveClass(/on/);
  await page.click('#askqty-off');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.ask_qty')))).toBe(false);
  await nav(page, 'pos');
  await tapCard(page, 'almond');
  await page.locator('#pos-grid .pcard').first().click();
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
  await expect(page.locator('.cline input[data-qty]')).toHaveValue('2');

  await nav(page, 'settings');
  await page.click('#askqty-on');
  await page.click('#view-settings [data-act="set-lang"][data-lang="ar"]');
  await page.setViewportSize({ width: 390, height: 844 });
  await nav(page, 'pos');
  await tapCard(page, 'beras');
  await expect(page.locator('#qs-ok')).toHaveText('إضافة');
  await page.click('#qs-chips [data-q="10"]');
  await expect(page.locator('#qs-pt')).toHaveText('جملة');
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'phone-qty-sheet-ar.png') });
  await page.click('#qs-ok');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
});
