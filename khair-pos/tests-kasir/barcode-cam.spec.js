// v47 (owner 2026-10-14: «لا يمكن استعمال الكاميرا لقراءة الباركود»): the camera reads barcodes on every device. The test
// browser has no built-in reader (BarcodeDetector), like Windows PCs and iPhones — so this is the ZXing path, reading a real
// EAN-13 drawn into a fake camera. A refused camera says how to allow it.
const { test, expect } = require('@playwright/test');
const { login, setDb } = require('./helpers');

const EAN = '8991002101234'; // valid check digit
/** Replaces the camera with a canvas showing an EAN-13 barcode (or a refusal). Runs in the page before the app. */
function fakeCamera({ code, fail }) {
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async () => {
    if (fail) throw new DOMException('Permission denied', fail);
    const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
    const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
    const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
    const P = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
    const d = code.split('').map(Number); let s = '101';
    for (let i = 1; i <= 6; i++) s += (P[d[0]][i - 1] === 'L' ? L : G)[d[i]];
    s += '01010'; for (let i = 7; i <= 12; i++) s += R[d[i]]; s += '101';
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    const paint = n => { g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#000'; for (let m = 0; m < s.length; m++) if (s[m] === '1') g.fillRect(132 + m * 4, 80, 4, 200); g.fillStyle = n % 2 ? '#fefefe' : '#fff'; g.fillRect(0, 0, 2, 2); };
    let n = 0; paint(n); setInterval(() => paint(++n), 100); // keep frames coming
    window.__camOpened = (window.__camOpened || 0) + 1;
    return c.captureStream(10);
  };
}

test('no built-in reader (PC / iPhone): the camera button is there and reads an EAN-13 into the cart', async ({ page }) => {
  await page.addInitScript(fakeCamera, { code: EAN });
  await login(page, 'Siti', '1111');
  expect(await page.evaluate(() => 'BarcodeDetector' in window)).toBe(false);
  await setDb(page, `const p = db.products.find(x => x.active !== false && x.stock > 5 && !x.repack_from); p.sku = arg; db.__name = p.name;`, EAN);
  const name = await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')).__name);
  await page.reload();
  await expect(page.locator('#cam')).toBeVisible();
  await page.click('#cam');
  await expect(page.locator('#cart')).toContainText(name, { timeout: 15000 });
  expect(await page.evaluate(() => !!window.ZXing && window.__camOpened)).toBe(1);
  await expect(page.locator('#cam-v')).toHaveCount(0); // the camera window closed by itself
});

test('a refused camera says how to allow it', async ({ page }) => {
  await page.addInitScript(fakeCamera, { code: EAN, fail: 'NotAllowedError' });
  await login(page, 'Siti', '1111');
  await page.click('#cam');
  await expect(page.locator('.toast.err')).toContainText('Izin kamera ditolak');
  await expect(page.locator('#cam-v')).toHaveCount(0);
});

test('a phone whose built-in reader knows no barcode kinds falls back to ZXing', async ({ page }) => {
  await page.addInitScript(fakeCamera, { code: EAN });
  await page.addInitScript(() => { window.BarcodeDetector = class { static async getSupportedFormats() { return []; } async detect() { return []; } }; });
  await login(page, 'Siti', '1111');
  await setDb(page, `const p = db.products.find(x => x.active !== false && x.stock > 5 && !x.repack_from); p.sku = arg; db.__name = p.name;`, EAN);
  const name = await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')).__name);
  await page.reload();
  await page.click('#cam');
  await expect(page.locator('#cart')).toContainText(name, { timeout: 15000 });
  expect(await page.evaluate(() => !!window.ZXing)).toBe(true);
});
