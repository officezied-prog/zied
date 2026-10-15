// v54 (owner 2026-10-15: «أريد من التطبيق أن يرتبط بكثير من أنواع من المطابع حتى يستطيع طباعة الأوراق الصغيرة»): the owner app (the manager
// sells here too) has the same "Printer struk" choice in Pengaturan; receipts then go as ESC/POS (see tests-kasir/printer.spec.js).
const { test, expect } = require('@playwright/test');
const { login, nav, closeModals } = require('./helpers');

test('Pengaturan → Printer struk: RawBT; "Tes cetak" and a receipt go through the RawBT link; Arabic', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.evaluate(() => { window.__rawbt = []; KPrint.go = u => window.__rawbt.push(u); });
  await nav(page, 'settings');
  await expect(page.locator('#st-printer')).toContainText('Jendela cetak (driver) · 58 mm');
  await page.click('#st-printer');
  await page.click('#prn-m-rawbt');
  await page.click('#prn-test');
  await expect(page.locator('#prn-status')).toContainText('Terkirim ke printer');
  const dec = u => Buffer.from(u.split(',')[1], 'base64').toString('latin1');
  expect(dec(await page.evaluate(() => window.__rawbt[0]))).toContain('Tes printer OK');
  // a receipt (as the receipt window's "Cetak" button does)
  await page.evaluate(() => printReceipt({ invoice_no: 'INV-TES-1', sale_time: new Date().toISOString(), cashier: 'Jihan', customer_name: 'Umum',
    lines: [{ name: 'Kurma Ajwa', qty: 2, unit_price: 50000, line_total: 100000 }], subtotal: 100000, total: 100000, method: 'kartu', paid: 100000 }));
  await expect(page.locator('.toast.ok', { hasText: 'Struk dikirim ke printer' })).toBeVisible();
  const rc = dec(await page.evaluate(() => window.__rawbt[1]));
  expect(rc).toContain('INV-TES-1');
  expect(rc).toContain('Bayar (Kartu)');
  await closeModals(page);
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'settings');
  await expect(page.locator('#st-printer')).toContainText('RawBT (أندرويد)');
});
