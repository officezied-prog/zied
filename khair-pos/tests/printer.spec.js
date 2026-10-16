// v54 (owner 2026-10-15: «أريد من التطبيق أن يرتبط بكثير من أنواع من المطابع حتى يستطيع طباعة الأوراق الصغيرة»): the owner app (the manager
// sells here too) has the same "Printer struk" choice in Pengaturan; receipts then go as ESC/POS (see tests-kasir/printer.spec.js).
const { test, expect } = require('@playwright/test');
const { login, nav, closeModals, openApp, enterKey, editDb, staffSession } = require('./helpers');

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

// v58 (owner 2026-10-16: «و تطبيق المدير و المحاسب»): the manager and the accountant use this app too — inside the Khair Mart APK the
// accountant (read-only otherwise) opens Printer struk as well: the app's own Bluetooth way is the default, "Tes cetak" goes to the app.
test('the accountant in the Khair Mart APK opens Printer struk: Bluetooth (aplikasi Khair) by default, Tes cetak goes to the app', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('kprint.app', 'com.khairmart.owner')); // as the APK's first open leaves it
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(() => { window.__go = []; KPrint.go = u => window.__go.push(u); });
  await nav(page, 'settings');
  await expect(page.locator('#st-printer')).toContainText('Bluetooth (aplikasi Khair)');
  await page.click('#st-printer');
  await expect(page.locator('.toast.warn')).toHaveCount(0);
  await expect(page.locator('#prn-m-app')).toHaveAttribute('aria-checked', 'true');
  await page.click('#prn-test');
  await expect.poll(() => page.evaluate(() => window.__go.length)).toBe(1);
  const u = await page.evaluate(() => window.__go[0]);
  expect(u).toMatch(/^intent:base64,[A-Za-z0-9+/=]+#Intent;scheme=khairprint;package=com\.khairmart\.owner;end;$/);
  expect(Buffer.from(u.slice(14).split('#')[0], 'base64').toString('latin1')).toContain('Tes printer OK');
});
