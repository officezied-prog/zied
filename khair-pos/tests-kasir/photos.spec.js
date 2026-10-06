// Photo control: exit photo for a large sale (scan_exit → cocok / tidak_cocok) and goods-in from a supplier note photo.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

async function bigSale(page) {
  await H.addItem(page, 'gula pasir');
  await H.openCart(page);
  await page.locator('.cl input[data-qty]').first().fill('20'); // ≥ exit_photo_min_qty (20)
  await page.locator('.cl input[data-qty]').first().press('Enter');
  await page.click('#btn-pay');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
}

test('large sale → "Foto barang keluar" → AI says cocok; a mismatch shows the differences', async ({ page }) => {
  await H.login(page);
  await bigSale(page);
  await expect(page.locator('#exit-box')).toContainText('Foto barang keluar');
  await expect(page.locator('#exit-btn')).toBeVisible();
  await H.shot(page, 'phone-14-exit-required');
  await page.setInputFiles('#exit-photo', await H.photoFile(page));
  await expect(page.locator('#exit-box[data-match="cocok"]')).toContainText('Cocok');
  await H.shot(page, 'phone-15-exit-cocok');
  let db = await H.getDb(page);
  let sale = db.sales[db.sales.length - 1];
  expect(sale.exit_match).toBe('cocok');
  expect(sale.exit_photo).toMatch(/^PH-/);
  const ph = db.photos.find(p => p.photo_id === sale.exit_photo);
  expect(ph).toMatchObject({ kind: 'keluar', ref: sale.invoice_no, user: 'Siti' });

  await page.click('#rc-new');
  await page.evaluate(() => localStorage.setItem('kmock.exit', 'tidak_cocok'));
  await bigSale(page);
  await page.setInputFiles('#exit-photo', await H.photoFile(page));
  await expect(page.locator('#exit-box[data-match="tidak_cocok"]')).toContainText('Tidak cocok');
  await expect(page.locator('#exit-diffs')).toContainText('Gula Pasir');
  await expect(page.locator('#exit-box')).toContainText('panggil pemilik');
  await H.shot(page, 'phone-16-exit-tidak-cocok');
  db = await H.getDb(page);
  expect(db.sales[db.sales.length - 1].exit_match).toBe('tidak_cocok');
});

test('small sale needs no exit photo', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  await expect(page.locator('#exit-box')).toHaveCount(0);
});

test('barang masuk: photo of the supplier note → AI lines → map products → save with photo_id', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const med = H.productByName(db0, /Medjool/), gula = H.productByName(db0, /Gula Pasir/), tas = H.productByName(db0, /Tasbih/);
  await H.tab(page, 'masuk');
  await expect(page.locator('#pu-save')).toBeDisabled();
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-ok')).toContainText('3 baris');
  await expect(page.locator('#pu-sup')).toHaveValue('CV Timur Tengah Food');
  const lines = page.locator('#pu-lines .pu-line');
  await expect(lines).toHaveCount(3);
  // suggestions preselected for the known products, the unknown one must be chosen
  await expect(lines.nth(0).locator('select')).toHaveValue(String(med.id));
  await expect(lines.nth(1).locator('select')).toHaveValue(String(gula.id));
  await expect(lines.nth(2)).toHaveClass(/unmatched/);
  await expect(page.locator('#pu-block')).toContainText('dipilih');
  await H.shot(page, 'phone-17-barang-masuk', true);
  // map the third line by hand (Madu → pick a product), then remove it again and add one manually
  await lines.nth(2).locator('select').selectOption(String(tas.id));
  await expect(page.locator('#pu-lines .pu-line').nth(2)).not.toHaveClass(/unmatched/);
  await page.locator('#pu-lines .pu-line').nth(2).locator('[data-act="pu-del"]').click();
  await page.fill('#pu-q', 'tasbih');
  await page.locator('#pu-sug [data-act="pu-add"]').first().click();
  const tl = page.locator('#pu-lines .pu-line').nth(2);
  await tl.locator('[data-pu-qty]').fill('10');
  await tl.locator('[data-pu-cost]').fill('15000');
  // the note says 6 × Madu and nothing about Tasbih → the live check and the server both say "Beda dengan nota"
  await expect(page.locator('#pu-match-box')).toHaveAttribute('data-status', 'tidak_cocok');
  await page.click('#pu-save');
  await expect(page.locator('#pu-mismatch #pu-mm-diffs tr.bad')).toHaveCount(2);
  await page.fill('#pu-mm-reason', 'Madu belum dikirim, tasbih titipan');
  await page.click('#pu-mm-save');
  await expect(page.locator('#pu-res')).toContainText('Barang masuk tersimpan');
  await expect(page.locator('#pu-res')).not.toContainText(/modal|cost|HPP/i);
  const db = await H.getDb(page);
  const rows = db.purchases.slice(-3);
  const pid = rows[0].photo_id;
  expect(pid).toMatch(/^PH-/);
  expect(rows.every(r => r.photo_id === pid && r.user === 'Siti' && r.supplier === 'CV Timur Tengah Food')).toBe(true);
  expect(db.photos.find(p => p.photo_id === pid).kind).toBe('masuk');
  expect(db.products.find(p => p.id === med.id).stock).toBe(med.stock + 10);
  expect(db.products.find(p => p.id === gula.id).stock).toBe(gula.stock + 50);
  expect(db.products.find(p => p.id === tas.id).stock).toBe(tas.stock + 10);
  await H.shot(page, 'phone-18-barang-masuk-saved');
});
