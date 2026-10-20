// v64 (owner 2026-10-20: «إلى الآن … لا يمكن التواصل مع قارئ الباركود»): in the owner / manager app a keyboard-type scanner works with
// nothing focused and over the last receipt (the manager sells), and in goods-in one item after another: the quantity box that gets the
// focus after an item is put back when the next barcode lands in it. Pengaturan → "Pemindai barcode": the steps + a test scan.
const { test, expect } = require('@playwright/test');
const { login, getDb, nav, checkoutSkip } = require('./helpers');

async function scan(page, code) { await page.keyboard.type(code, { delay: 4 }); await page.keyboard.press('Enter'); }
const blur = page => page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
const cartQty = (page, id) => page.evaluate(pid => { const l = KPOS.S.cart.lines.find(x => String(x.product_id) === String(pid)); return l ? l.qty : 0; }, id);

test('manager: a scan with nothing focused adds to the cart; over the last receipt it starts the next sale', async ({ page }) => {
  await login(page, 'Jihan', '2222');
  const db = await getDb(page);
  const [a, b] = db.products.filter(p => p.sku && p.active !== false && p.stock > 5 && !p.repack_from && !p.loose);
  await blur(page);
  await scan(page, a.sku);
  await expect.poll(() => cartQty(page, a.id)).toBe(1);
  await checkoutSkip(page);
  await expect(page.locator('#rc-new')).toBeVisible();
  await blur(page);
  await scan(page, b.sku);
  await expect(page.locator('#rc-new')).toHaveCount(0);
  await expect.poll(() => cartQty(page, b.id)).toBe(1);
  expect(await cartQty(page, a.id)).toBe(0);
});

test('goods-in: the next scan lands in the quantity box of the last line — the quantity is put back and the item is added', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db = await getDb(page);
  const [a, b] = db.products.filter(p => p.sku && p.active !== false && !p.repack_from);
  await nav(page, 'purchases');
  await page.locator('#pu-q').focus();
  await scan(page, a.sku);
  await expect.poll(() => page.evaluate(() => KPOS.PU.lines.length)).toBe(1);
  await expect(page.locator('[data-pu-qty="0"]')).toBeFocused(); // the quantity box of the new line has the focus
  await scan(page, a.sku); // … and the scanner types into it
  await expect.poll(() => page.evaluate(() => KPOS.PU.lines.map(l => l.qty))).toEqual([2]);
  await scan(page, b.sku);
  await expect.poll(() => page.evaluate(() => KPOS.PU.lines.map(l => l.qty))).toEqual([2, 1]);
  await expect(page.locator('[data-pu-qty="0"]')).toHaveValue('2');
  await blur(page);
  await scan(page, '8997777000013');
  await expect(page.locator('.toast.warn')).toContainText('Barcode 8997777000013 belum ada di aplikasi');
});

test('Pengaturan → Pemindai barcode: the steps and a test scan', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const p = (await getDb(page)).products.find(x => x.sku && x.active !== false);
  await nav(page, 'settings');
  await page.click('#st-scanner');
  await expect(page.locator('#scanner')).toContainText('mode HID / Keyboard');
  await blur(page);
  await scan(page, p.sku);
  await expect(page.locator('#wedge-res')).toHaveAttribute('data-code', p.sku);
  await expect(page.locator('#wedge-res [data-found="1"]')).toContainText(p.name);
  await expect(page.locator('#wedge-res [data-ok]')).toBeVisible();
});
