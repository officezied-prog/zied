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

// v68 (owner 2026-10-20: «تم إصلاح المطبعة الصغيرة، ولكن لا يوجد فيها اللوجو حق الشركة»): the store logo (logo.png, black / white raster
// GS v 0) on top of every ESC/POS receipt and of the test print, centred by blank dots; "Cetak logo toko" switches it off.
const rasters = bytes => { // the GS v 0 bands: [{bpr, rows}] and the dots printed
  const out = []; let dots = 0;
  for (let i = 0; i < bytes.length - 8; i++) if (bytes[i] === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
    const bpr = bytes[i + 4] + 256 * bytes[i + 5], rows = bytes[i + 6] + 256 * bytes[i + 7];
    for (let k = i + 8; k < i + 8 + bpr * rows; k++) for (let b = bytes[k]; b; b &= b - 1) dots++;
    out.push({ bpr, rows }); i += 7 + bpr * rows;
  }
  return { bands: out, rows: out.reduce((a, x) => a + x.rows, 0), dots };
};
test('the store logo prints on top of the receipt and the test print (58 / 80 mm); "Cetak logo toko" switches it off; Arabic', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.evaluate(() => { window.__rawbt = []; KPrint.go = u => window.__rawbt.push(u); });
  expect(await page.evaluate(() => KPrint.prepLogo())).toBe(true);
  const dec = u => [...Buffer.from(u.split(',')[1], 'base64')];
  for (const [w, bpr] of [[58, 34], [80, 48]]) { // a small logo: 160 / 192 dots after 112 / 192 blank ones (centred on 384 / 576)
    const r = rasters(await page.evaluate(w => Array.from(KPrint.logoBytes(w)), w));
    expect(r.bands.every(b => b.bpr === bpr && b.rows <= 48)).toBe(true);
    expect(r.rows).toBeGreaterThan(60);
    expect(r.rows).toBeLessThanOrEqual(w === 58 ? 95 : 114);
    expect(r.dots).toBeGreaterThan(r.rows * bpr * 8 * 0.15); // real ink, not a blank box
  }
  await nav(page, 'settings');
  await page.click('#st-printer');
  await page.click('#prn-m-rawbt');
  await expect(page.locator('#prn-logo')).toBeChecked();
  await page.click('#prn-test');
  await expect(page.locator('#prn-status')).toContainText('Terkirim ke printer');
  let bytes = dec(await page.evaluate(() => window.__rawbt[0]));
  expect(rasters(bytes).bands.length).toBeGreaterThan(0);
  const name = [...Buffer.from('Khair Mart', 'latin1')], at = (arr, sub) => arr.findIndex((_, i) => sub.every((c, k) => arr[i + k] === c));
  expect(at(bytes, [0x1d, 0x76, 0x30])).toBeLessThan(at(bytes, name)); // the logo first, then the store's name
  await page.evaluate(() => printReceipt({ invoice_no: 'INV-LOGO-1', sale_time: new Date().toISOString(), cashier: 'Jihan', customer_name: 'Umum',
    lines: [{ name: 'Kurma Ajwa', qty: 1, unit_price: 50000, line_total: 50000 }], subtotal: 50000, total: 50000, method: 'tunai', paid: 50000 }));
  await expect.poll(() => page.evaluate(() => window.__rawbt.length)).toBe(2);
  bytes = dec(await page.evaluate(() => window.__rawbt[1]));
  expect(rasters(bytes).rows).toBe(rasters(await page.evaluate(() => Array.from(KPrint.logoBytes(58)))).rows);
  // switched off: no image
  await page.click('#prn-logo');
  expect(await page.evaluate(() => KPrint.cfg().logo)).toBe(false);
  await page.click('#prn-test');
  await expect.poll(() => page.evaluate(() => window.__rawbt.length)).toBe(3);
  expect(rasters(dec(await page.evaluate(() => window.__rawbt[2]))).bands).toEqual([]);
  expect(await page.evaluate(() => KPrint.text('ar', 'logo'))).toBe('طباعة شعار المتجر أعلى الإيصال');
});
