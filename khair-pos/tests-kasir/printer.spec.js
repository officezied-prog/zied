// v54 (owner 2026-10-15: «أحاول أن أربط التطبيق بهذه المطبعة الصغيرة ولكن لا يعمل. أريد من التطبيق أن يرتبط بكثير من أنواع من المطابع حتى
// يستطيع طباعة الأوراق الصغيرة، الفاتورات الصغيرة»): Lainnya → Printer struk — the way this device prints receipts. The receipt goes as
// ESC/POS bytes through RawBT (Android app), Bluetooth (BLE), USB or a COM port; the test browser gets fake devices that keep the bytes.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

/** Fake printers in the page: every byte sent lands in window.__out[kind]. */
function fakePrinters({ usb }) {
  window.__out = { ble: [], serial: [], usb: [] };
  const ch = { properties: { writeWithoutResponse: true, write: true }, writeValueWithoutResponse: async b => { window.__out.ble.push(...new Uint8Array(b.buffer || b)); } };
  const dev = { name: 'RPP02', gatt: { connected: false, connect: async function () { this.connected = true; return { getPrimaryServices: async () => [{ getCharacteristics: async () => [ch] }] }; } } };
  Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => ({ requestDevice: async () => dev }) });
  const port = { writable: null, open: async function () { this.writable = { getWriter: () => ({ write: async b => { window.__out.serial.push(...b); }, releaseLock() {} }) }; } };
  Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => ({ getPorts: async () => [], requestPort: async () => port }) });
  Object.defineProperty(Navigator.prototype, 'usb', { configurable: true, get: () => (usb ? { getDevices: async () => [], requestDevice: async () => { throw Object.assign(new Error('x'), { name: 'NotFoundError' }); } } : undefined) });
}
const text = arr => Buffer.from(arr).toString('latin1');
async function openPrinter(page) {
  await H.tab(page, 'more');
  await page.click('#m-printer');
  await expect(page.locator('#printer')).toBeVisible();
}

test('RawBT (Android app): "Tes cetak" and the receipt go as ESC/POS through the RawBT link; the choice stays on this device', async ({ page }) => {
  await page.addInitScript(fakePrinters, { usb: false });
  await H.login(page);
  await page.evaluate(() => { window.__rawbt = []; KPrint.go = u => window.__rawbt.push(u); });
  await openPrinter(page);
  await expect(page.locator('#prn-m-system')).toHaveAttribute('aria-checked', 'true'); // as before until something is chosen
  await expect(page.locator('#prn-m-usb')).toBeDisabled(); // this browser has no WebUSB
  await expect(page.locator('#prn-m-usb')).toContainText('Tidak tersedia');
  await page.click('#prn-m-rawbt');
  await expect(page.locator('#prn-m-rawbt')).toHaveAttribute('aria-checked', 'true');
  await H.shot(page, 'phone-printer', false, { noToasts: true });
  await page.click('#prn-test');
  await expect(page.locator('#prn-status')).toContainText('Terkirim ke printer');
  const url = await page.evaluate(() => window.__rawbt[0]);
  expect(url).toMatch(/^rawbt:base64,/); // (an Android phone gets the intent: link that opens RawBT, or its Play Store page)
  expect(text(Buffer.from(url.slice('rawbt:base64,'.length), 'base64'))).toContain('Tes printer OK');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kprint.cfg')).mode)).toBe('rawbt');
  await H.closeModals(page);
  // a sale: its receipt goes the same way
  await H.tab(page, 'sell');
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const inv = (await H.getDb(page)).sales.slice(-1)[0].invoice_no;
  await page.click('#rc-print');
  await expect(page.locator('.toast.ok', { hasText: 'Struk dikirim ke printer' })).toBeVisible();
  const rc = text(Buffer.from((await page.evaluate(() => window.__rawbt[1])).split(',')[1], 'base64'));
  expect(rc).toContain(inv);
  expect(rc).toContain('TOTAL');
  expect(rc).toContain('Kurma Tunisia');
});

test('Bluetooth (BLE) straight from Chrome: the printer is chosen once, the bytes start with ESC @ and end with feed + cut; a COM port at 80 mm', async ({ page }) => {
  await page.addInitScript(fakePrinters, { usb: true });
  await H.login(page);
  await openPrinter(page);
  await page.click('#prn-m-ble');
  await page.click('#prn-test');
  await expect(page.locator('#prn-status')).toContainText('Terkirim ke printer');
  const ble = await page.evaluate(() => window.__out.ble);
  expect(ble.slice(0, 2)).toEqual([0x1b, 0x40]); // ESC @ (reset)
  expect(ble.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00]); // GS V — cut
  expect(text(ble)).toContain('Tes printer OK');
  expect(text(ble)).toContain('Bluetooth langsung (BLE) - 58 mm');
  expect(text(ble).split('\n').some(l => l === '12345678901234567890123456789012')).toBe(true); // 58 mm = 32 characters a line
  // the computer's COM port, 80 mm paper, no cut
  await page.click('#prn-m-serial');
  await page.click('#prn-w [data-w="80"]');
  await page.uncheck('#prn-cut');
  await page.click('#prn-test');
  await expect(page.locator('#prn-status')).toContainText('Terkirim ke printer');
  const ser = await page.evaluate(() => window.__out.serial);
  expect(text(ser).split('\n').some(l => l === '123456789012345678901234567890123456789012345678')).toBe(true); // 48 characters
  expect(ser.slice(-4)).not.toEqual([0x1d, 0x56, 0x42, 0x00]);
  // no USB printer chosen → a clear message
  await page.click('#prn-m-usb');
  await page.click('#prn-test');
  await expect(page.locator('#prn-status')).toHaveText('Tidak ada printer yang dipilih');
});

test('Arabic: the printer window reads in Arabic (the receipt itself stays in Latin letters)', async ({ page }) => {
  await page.addInitScript(fakePrinters, { usb: false });
  await H.login(page);
  await page.evaluate(() => setLang('ar'));
  await openPrinter(page);
  await expect(page.locator('#printer')).toContainText('طابعة الإيصالات');
  await expect(page.locator('#prn-m-rawbt')).toContainText('RawBT (أندرويد)');
  await expect(page.locator('#prn-test')).toContainText('طباعة تجربة');
});
