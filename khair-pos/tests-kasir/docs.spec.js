// v17 A4 documents in Khair Kasir (shared/docs.js): Penawaran from the cart, Faktur A4 + Surat jalan from the receipt,
// Tanda terima for a goods-in note (never with purchase prices for the cashier).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const stubPrint = page => page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
const printed = page => page.evaluate(() => window.__printed);

test('cart → Penawaran; receipt → Faktur A4 and Surat jalan; goods-in → Tanda terima', async ({ page }) => {
  await H.login(page);
  await stubPrint(page);
  const sales0 = (await H.getDb(page)).sales.length;
  await H.addItem(page, 'tasbih', { qty: 2 });
  await H.openCart(page);
  await page.click('#btn-quote');
  await expect(page.locator('#quote')).toContainText('PNW-');
  await page.click('#q-print');
  await expect.poll(() => printed(page)).toBe(1);
  const area = page.locator('#print-area');
  await expect(area.locator('.kdoc h1')).toHaveText('PENAWARAN HARGA');
  await expect(area).toContainText('Tasbih');
  expect(await page.locator('#page-style').textContent()).toContain('A4');
  expect((await H.getDb(page)).sales.length).toBe(sales0);
  await H.closeModals(page);

  await page.click('#btn-pay'); // the cart sheet is still open on the phone
  await expect(page.locator('#pay')).toBeVisible();
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const inv = (await H.getDb(page)).sales.slice(-1)[0].invoice_no;
  await page.click('#rc-invoice');
  await expect.poll(() => printed(page)).toBe(2);
  await expect(area.locator('.kdoc h1')).toHaveText('FAKTUR PENJUALAN');
  await expect(area).toContainText(inv);
  await expect(area).toContainText('Terbilang:');
  await page.click('#rc-sj');
  await expect.poll(() => printed(page)).toBe(3);
  await expect(area.locator('.kdoc h1')).toHaveText('SURAT JALAN');
  await expect(area).not.toContainText('Rp');
  await page.click('#rc-new');

  const NOTE = { supplier: 'CV Timur Tengah Food', date: '', invoice_no: 'TTF-9100', total: 0, items: [{ name: 'KURMA MEDJOOL JUMBO 1KG', qty: 4, unit: 'kg', unit_price: 170000, total: 680000 }] };
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE);
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-ok')).toContainText('1 baris');
  await H.pickCarrier(page);
  await H.fillPuExp(page);
  await page.click('#pu-save');
  const no = (await page.locator('#pu-res-no').textContent()).trim();
  await page.locator(`#pu-hist .hist[data-no="${no}"] [data-act="pu-doc"]`).click();
  await expect.poll(() => printed(page)).toBe(4);
  await expect(area.locator('.kdoc h1')).toHaveText('TANDA TERIMA BARANG');
  await expect(area).toContainText(no);
  await expect(area).toContainText('CV Timur Tengah Food');
  await expect(area).not.toContainText('Harga beli');
  await expect(area).not.toContainText('170.000');
});
