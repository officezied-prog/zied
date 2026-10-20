// v64 (owner 2026-10-20: «إلى الآن … لا يمكن التواصل مع قارئ الباركود»): a scanner that types like a keyboard (USB / Bluetooth HID) works
// with nothing focused (a phone never focuses the search box), over the last receipt and the quantity sheet, in goods-in one item after
// another, and a scan that lands in a quantity box is put back and read as a scan (shared/scan-wedge.js). Lainnya → "Pemindai barcode"
// shows how to connect one and tests what arrives.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

async function scan(page, code, opts = {}) {
  await page.keyboard.type(code, { delay: 4 });
  if (opts.end !== false) await page.keyboard.press(opts.end || 'Enter');
}
const blur = page => page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
const cartQty = (page, id) => page.evaluate(pid => { const l = KASIR.S.cart.lines.find(x => String(x.product_id) === String(pid)); return l ? l.qty : 0; }, id);

test('a phone with nothing focused: scans add to the cart, over the last receipt (next sale) and over the quantity sheet', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Ajwa/), tun = H.productByName(db0, /Tunisia/);
  await blur(page);
  await scan(page, ajwa.sku);
  await expect.poll(() => cartQty(page, ajwa.id)).toBe(1);
  // pay → the receipt stays open; the next scan starts the next sale
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal')).toBeVisible();
  await blur(page);
  await scan(page, tun.sku);
  await expect(page.locator('#rc-modal')).toHaveCount(0);
  await expect.poll(() => cartQty(page, tun.id)).toBe(1);
  expect(await cartQty(page, ajwa.id)).toBe(0);
  // the quantity sheet of a tapped product is open (not focused on a phone): it goes in first, then the scanned one
  await page.fill('#q', 'ajwa');
  await page.locator('#grid .pc').first().click();
  await expect(page.locator('#qty-sheet')).toBeVisible();
  await blur(page);
  await scan(page, tun.sku);
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
  await expect.poll(() => cartQty(page, tun.id)).toBe(2);
  expect(await cartQty(page, ajwa.id)).toBe(1);
  // an unknown code: a beep and "tidak dikenal", nothing added
  await blur(page);
  await scan(page, '8990000000000');
  await expect(page.locator('.toast.err')).toContainText('tidak dikenal');
  await H.openCart(page);
  await page.locator(`.cl[data-pid="${tun.id}"] input[data-qty]`).focus();
  // a scan that lands in a quantity box: the quantity is put back, the code is read as a scan
  await scan(page, tun.sku);
  await expect.poll(() => cartQty(page, tun.id)).toBe(3);
  await expect(page.locator(`.cl[data-pid="${tun.id}"] input[data-qty]`)).toHaveValue('3');
  // typing a quantity by hand still works
  await page.locator(`.cl[data-pid="${tun.id}"] input[data-qty]`).fill('4');
  await page.locator(`.cl[data-pid="${tun.id}"] input[data-qty]`).press('Enter');
  await expect.poll(() => cartQty(page, tun.id)).toBe(4);
});

test('UPC-A ↔ EAN-13: a 12-digit barcode in the app is found by the 13-digit scan (leading 0), and the other way round', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, `const p = db.products.find(x => /Tunisia/.test(x.name)); p.sku = '036000291452';`);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  const tun = H.productByName(await H.getDb(page), /Tunisia/);
  await blur(page);
  await scan(page, '0036000291452');
  await expect.poll(() => cartQty(page, tun.id)).toBe(1);
});

test('goods-in: scan after scan adds the lines (nothing to tap between them); an unknown barcode opens "Produk baru" with it', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Ajwa/), tun = H.productByName(db0, /Tunisia/);
  await H.tab(page, 'masuk');
  await blur(page);
  await scan(page, ajwa.sku);
  await expect(page.locator('#pu-lines .pu-line')).toHaveCount(1);
  await blur(page);
  await scan(page, ajwa.sku);
  await scan(page, tun.sku); // straight after: the focus was lost by the redraw
  await expect(page.locator('#pu-lines .pu-line')).toHaveCount(2);
  expect(await page.evaluate(() => KASIR.PU.lines.map(l => l.qty))).toEqual([2, 1]);
  await blur(page);
  await scan(page, '8997777000013');
  await expect(page.locator('.toast.warn')).toContainText('Barcode 8997777000013 belum ada di aplikasi');
  await page.click('#pu-newprod-q');
  await expect(page.locator('#new-product #np-sku')).toHaveValue('8997777000013');
  await expect(page.locator('#new-product #np-name')).toHaveValue('');
});

test('Lainnya → Pemindai barcode: the steps, then a test scan shows the code, its speed, the Enter and the product; Arabic', async ({ page }) => {
  await H.login(page);
  const ajwa = H.productByName(await H.getDb(page), /Ajwa/);
  await H.tab(page, 'more');
  await page.click('#m-scanner');
  await expect(page.locator('#scanner')).toContainText('mode HID / Keyboard');
  await expect(page.locator('#wedge-res')).toContainText('Menunggu pindaian');
  await scan(page, ajwa.sku);
  await expect(page.locator('#wedge-res')).toHaveAttribute('data-code', ajwa.sku);
  await expect(page.locator('#wedge-res')).toHaveAttribute('data-end', 'Enter');
  await expect(page.locator('#wedge-res [data-found="1"]')).toContainText(ajwa.name);
  await expect(page.locator('#wedge-res [data-ok]')).toBeVisible();
  expect(await cartQty(page, ajwa.id)).toBe(0); // a test scan sells nothing
  // no Enter at the end: said so
  await scan(page, '8991234500017', { end: false });
  await expect(page.locator('#wedge-res')).toHaveAttribute('data-end', 'none');
  await expect(page.locator('#wedge-res')).toContainText('setel akhiran ke Enter');
  await H.shot(page, 'phone-v64-scanner', false, { noToasts: true });
  await H.closeModals(page);
  await page.evaluate(() => { window.__lang = 'ar'; });
  const ar = await page.evaluate(() => ['title', 's1', 's2', 's3', 's4', 'wait', 'slow', 'ok'].filter(k => KWedge.text('ar', k) === KWedge.text('id', k)));
  expect(ar).toEqual([]);
  const missing = await page.evaluate(() => ['more.scanner_s', 'scan.close_first', 'scan.where', 'pu.scan_nf'].filter(k => !KASIR.I18N.id[k] || !KASIR.I18N.ar[k] || KASIR.I18N.id[k] === KASIR.I18N.ar[k]));
  expect(missing).toEqual([]);
});
