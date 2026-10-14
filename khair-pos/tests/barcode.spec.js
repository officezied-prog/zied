// Phase 4 — barcode reader. A product's SKU (barcode) typed/scanned into the POS search box + Enter
// finds the product and adds it to the cart with its price (the physical-scanner / keyboard-wedge path).
// v47: the camera button is shown on every device with a camera — the browser's own reader when it has one, else ZXing
// (vendor/zxing), so PCs and iPhones read barcodes too; the SKU field in the product form has a scan-to-fill camera button.
const { test, expect } = require('@playwright/test');
const { login, getDb, openApp, editDb } = require('./helpers');

const EAN = '8991002101234'; // valid check digit
/** Replaces the camera with a canvas showing an EAN-13 barcode. Runs in the page before the app. */
function fakeCamera(code) {
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async () => {
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
    let n = 0; paint(n); setInterval(() => paint(++n), 100);
    return c.captureStream(10);
  };
}

test('camera (no built-in reader, like a PC): reads an EAN-13 into the POS cart', async ({ page }) => {
  await page.addInitScript(fakeCamera, EAN);
  await openApp(page);
  await editDb(page, `const p = db.products.find(x => x.active !== false && x.stock > 5 && !x.repack_from); p.sku = arg;`, EAN);
  await login(page, 'Pemilik', '1234');
  expect(await page.evaluate(() => 'BarcodeDetector' in window)).toBe(false);
  const prod = (await getDb(page)).products.find(p => p.sku === EAN);
  await expect(page.locator('#pos-cam')).toBeVisible();
  await page.click('#pos-cam');
  await expect(page.locator('#cart')).toContainText(prod.name.split(' ')[0], { timeout: 15000 });
  await expect(page.locator('#cam-v')).toHaveCount(0);
});

test('scanning a product SKU in POS search adds it to the cart', async ({ page }) => {
  await login(page, 'Pemilik', '1234'); // v36: the helper sells as the manager (the owner no longer sells)
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
