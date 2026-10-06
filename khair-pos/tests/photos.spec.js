// Photos: goods in (purchase needs an AI-read photo of the supplier note) and goods out (large sales).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { rp, SHOTS, jktToday, login, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals, photoFile } = require('./helpers');

test('purchase is blocked without a photo; mock AI scan prefills editable lines; save stores photo_id', async ({ page }) => {
  await login(page);
  const db0 = await getDb(page);
  const medjool = productByName(db0, /Medjool/), gula = productByName(db0, /Gula Pasir/);
  await nav(page, 'purchases');
  await page.fill('#pu-q', 'almond');
  await page.locator('[data-act="pu-add"]').first().click();
  await expect(page.locator('#pu-save')).toBeDisabled();
  await expect(page.locator('#pu-block')).toHaveText('Ambil foto nota dulu');
  const code = await page.evaluate(async () => { try { await api('save_purchase', { supplier: 'x', items: [{ product_id: 1, qty: 1, cost_price: 1 }] }); return 'saved'; } catch (e) { return e.code; } });
  expect(code).toBe('INVALID');

  await page.setInputFiles('#pu-photo', await photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-card')).toHaveClass(/done/);
  await expect(page.locator('#pu-photo-status')).toContainText('Nota terbaca: 3 baris');
  await expect(page.locator('#pu-thumb')).toBeVisible();
  await expect(page.locator('#pu-sup')).toHaveValue('CV Timur Tengah Food');
  await expect(page.locator('#pu-lines tbody tr')).toHaveCount(4);
  await expect(page.locator('[data-pu-prod="1"]')).toHaveValue(String(medjool.id));
  await expect(page.locator('[data-pu-prod="2"]')).toHaveValue(String(gula.id));
  const unmatched = page.locator('#pu-lines tr.unmatched');
  await expect(unmatched).toHaveCount(1);
  await expect(unmatched).toContainText('MADU SIDR YAMAN 500GR');
  await expect(page.locator('#pu-save')).toBeDisabled();
  await expect(page.locator('#pu-block')).toContainText('Cocokkan');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-purchase-photo.png'), fullPage: false });

  // owner creates the unknown product right from the line
  await unmatched.locator('[data-act="pu-newprod"]').click();
  await expect(page.locator('#pf-name')).toHaveValue('Madu Sidr Yaman 500gr');
  await page.fill('#pf-retail_price', '275000');
  await page.click('#pf-save');
  await expect(page.locator('#pu-lines tr.unmatched')).toHaveCount(0);
  // edit: drop the manual line, change qty of the Medjool line, re-map the Gula line by hand
  await page.locator('[data-act="pu-del"][data-i="0"]').click();
  await page.locator('[data-pu-qty="0"]').fill('12');
  await page.locator('[data-pu-prod="1"]').selectOption(String(productByName(db0, /Kismis Hitam/).id));
  await expect(page.locator('#pu-save')).toBeEnabled();
  await page.click('#pu-save');
  await expect(page.locator('#pu-res')).toBeVisible();

  const db = await getDb(page);
  const rows = db.purchases.slice(-3);
  const photoId = rows[0].photo_id;
  expect(photoId).toMatch(/^PH-/);
  rows.forEach(r => expect(r.photo_id).toBe(photoId));
  expect(rows.map(r => [r.product_id, r.qty, r.cost_price])).toEqual([[medjool.id, 12, 170000], [productByName(db0, /Kismis Hitam/).id, 50, 15000], [productByName(db, /Madu Sidr/).id, 6, 210000]]);
  expect(productByName(db, /Medjool/).stock).toBe(medjool.stock + 12);
  expect(rows[0].supplier).toBe('CV Timur Tengah Food');
  await expect(page.locator('#pu-photo-card')).not.toHaveClass(/done/);
});

test('large sale requires an exit photo; match result cocok / tidak cocok; missing list in history', async ({ page }) => {
  await login(page);
  // 1) qty ≥ 20 → required, photo → cocok
  await addBySearch(page, 'gula pasir');
  await expect(page.locator('#cart-exit')).toBeHidden();
  await page.locator('.cline input[data-qty]').fill('20');
  await expect(page.locator('#cart-exit')).toBeVisible();
  await checkoutSkip(page);
  await expect(page.locator('#exit-box')).toContainText('Foto barang keluar (wajib)');
  let inv = (await page.locator('.modal #receipt').innerText()).match(/KM\d{6}-\d{4}/)[0];
  expect((await getDb(page)).sales.find(s => s.invoice_no === inv).exit_photo).toBe('required');
  await page.setInputFiles('#exit-photo', await photoFile(page, 'keluar.png'));
  await expect(page.locator('#exit-box[data-match="cocok"]')).toContainText('Cocok');
  let sale = (await getDb(page)).sales.find(s => s.invoice_no === inv);
  expect(sale.exit_photo).toMatch(/^PH-/);
  expect(sale.exit_match).toBe('cocok');
  await closeModals(page);

  // 2) total ≥ 1.000.000 → required, mock AI says tidak cocok → diffs table
  await page.evaluate(() => localStorage.setItem('kmock.exit', 'tidak_cocok'));
  await addBySearch(page, 'ajwa');
  await page.locator('.cline input[data-qty]').fill('7');
  await page.locator('.cline input[data-qty]').press('Enter');
  await checkoutSkip(page);
  await page.setInputFiles('#exit-photo', await photoFile(page));
  const box = page.locator('#exit-box[data-match="tidak_cocok"]');
  await expect(box).toContainText('Tidak cocok');
  await expect(page.locator('#exit-diffs tbody tr')).toHaveCount(1);
  await expect(page.locator('#exit-diffs tbody tr')).toContainText('Kurma Ajwa');
  await expect(page.locator('#exit-diffs tbody tr td').nth(1)).toHaveText('7');
  await expect(page.locator('#exit-diffs tbody tr td').nth(2)).toHaveText('9');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-exit-mismatch.png') });
  await closeModals(page);
  await page.evaluate(() => localStorage.removeItem('kmock.exit'));

  // 3) a large sale left without photo shows up in History → take it later
  await addBySearch(page, 'beras');
  await page.locator('.cline input[data-qty]').fill('25');
  await page.locator('.cline input[data-qty]').press('Enter');
  await checkoutSkip(page);
  inv = (await page.locator('.modal #receipt').innerText()).match(/KM\d{6}-\d{4}/)[0];
  await closeModals(page);
  await nav(page, 'history');
  const missing = page.locator('#exit-missing');
  await expect(missing).toContainText(inv);
  await missing.locator('.li').filter({ hasText: inv }).locator('[data-act="hist-open"]').click();
  await page.setInputFiles('#exit-photo', await photoFile(page));
  await expect(page.locator('#exit-box[data-match="cocok"]')).toBeVisible();
  await closeModals(page);
  await page.click('[data-act="hist-load"]');
  await expect(page.locator('#hist-table')).toBeVisible();
  await expect(page.locator('#hi-missing')).not.toContainText(inv);
});

test('reports: Kontrol foto card numbers match the data', async ({ page }) => {
  await login(page);
  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="month"]');
  const from = jktToday().slice(0, 8) + '01', to = jktToday();
  const db = await getDb(page);
  const inR = d => d >= from && d <= to;
  const pur = db.purchases.filter(p => inR(p.purchase_date) && p.supplier !== 'PENYESUAIAN STOK');
  const big = db.sales.filter(s => inR(s.sale_date) && s.status !== 'void' && s.exit_photo);
  await expect(page.locator('[data-pc="pur-with"]')).toHaveText(String(pur.filter(p => p.photo_id).length));
  await expect(page.locator('[data-pc="pur-without"]')).toHaveText(String(pur.filter(p => !p.photo_id).length));
  await expect(page.locator('[data-pc="exit-with"]')).toHaveText(String(big.filter(s => s.exit_photo !== 'required').length));
  await expect(page.locator('[data-pc="exit-missing"]')).toHaveText(String(big.filter(s => s.exit_photo === 'required').length));
  await expect(page.locator('[data-pc="mismatch"]')).toHaveText(String(big.filter(s => s.exit_match === 'tidak_cocok').length));
  const photos = db.photos.filter(p => inR(p.photo_date));
  await expect(page.locator('#photo-table tbody tr')).toHaveCount(Math.min(60, photos.length));
});
