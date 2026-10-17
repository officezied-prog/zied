// v17 A4 documents (shared/docs.js): faktur, surat jalan, penawaran, tanda terima barang, rekap tagihan.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, nav, addBySearch, checkoutSkip, editDb, rp, closeModals } = require('./helpers');

const stubPrint = page => page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
const printed = page => page.evaluate(() => window.__printed);

test('receipt → Faktur A4 and Surat jalan; cart → Penawaran (nothing saved)', async ({ page }) => {
  await login(page);
  await stubPrint(page);
  const sales0 = (await getDb(page)).sales.length;
  await addBySearch(page, 'pistachio', '3');
  await page.click('#btn-quote');
  const q = page.locator('#quote');
  await expect(q).toContainText('PNW-');
  await expect(page.locator('#q-wa')).toHaveAttribute('href', /PENAWARAN%20HARGA/);
  await page.click('#q-print');
  await expect.poll(() => printed(page)).toBe(1);
  await expect(page.locator('#print-area .kdoc h1')).toHaveText('PENAWARAN HARGA');
  await expect(page.locator('#print-area')).toContainText('Kacang Pistachio');
  await expect(page.locator('#print-area')).toContainText('Terbilang:');
  expect(await page.locator('#page-style').textContent()).toContain('A4');
  expect((await getDb(page)).sales.length).toBe(sales0);
  await page.locator('#quote [data-act="modal-close"]').first().click().catch(() => page.keyboard.press('Escape'));
  await page.keyboard.press('Escape');

  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).click();
  await checkoutSkip(page);
  const inv = (await page.locator('.modal #receipt').innerText()).match(/KM\d{6}-\d{4}/)[0];
  await page.click('#rc-invoice');
  await expect.poll(() => printed(page)).toBe(2);
  const area = page.locator('#print-area');
  await expect(area.locator('.kdoc h1')).toHaveText('FAKTUR PENJUALAN');
  await expect(area).toContainText(inv);
  await expect(area).toContainText('Ibu Fatimah');
  await expect(area).toContainText('Kacang Pistachio');
  await expect(area).toContainText('Penerima');
  await expect(area.locator('.meta')).toContainText(/Tanggal: \d{1,2} \w+ 20\d\d \d\d:\d\d/);
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: path.join(SHOTS, 'a4-faktur.png'), fullPage: true });
  await page.emulateMedia({ media: 'screen' });

  await page.click('#rc-sj');
  await expect.poll(() => printed(page)).toBe(3);
  await expect(area.locator('.kdoc h1')).toHaveText('SURAT JALAN');
  await expect(area).toContainText('SJ-' + inv);
  await expect(area).toContainText('Sopir / pembawa');
  await expect(area).not.toContainText('Rp'); // a delivery note never shows prices
});

test('goods-in history → Tanda terima (owner sees cost); customer → Rekap tagihan of open invoices', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await stubPrint(page);
  await nav(page, 'purchases');
  const btn = page.locator('#pu-hist [data-act="pu-doc"]').first();
  await expect(btn).toBeVisible();
  const no = await btn.getAttribute('data-no');
  await btn.click();
  await expect.poll(() => printed(page)).toBe(1);
  const area = page.locator('#print-area');
  await expect(area.locator('.kdoc h1')).toHaveText('TANDA TERIMA BARANG');
  await expect(area).toContainText(no);
  await expect(area).toContainText('Harga beli');
  await expect(area).toContainText('Diterima (gudang)');

  const db = await getDb(page);
  const cust = db.customers.filter(c => c.debt_balance > 0).sort((a, b) => b.debt_balance - a.debt_balance)[0]; // the demo seed varies with the hour
  expect(cust).toBeTruthy();
  await nav(page, 'customers');
  await page.locator('[data-act="cust-open"]').filter({ hasText: cust.name }).click();
  await expect(page.locator('#cd-ledger #led-docs')).toBeVisible();
  const openTotal = await page.locator('#led-open-total').textContent();
  await page.click('#cd-statement');
  await expect.poll(() => printed(page)).toBe(2);
  await expect(area.locator('.kdoc h1')).toHaveText('REKAP TAGIHAN');
  await expect(area).toContainText(cust.name);
  await expect(area).toContainText('TOTAL SISA TAGIHAN');
  // same total as the ledger on screen (Rp 1.234.567 there, Rp 1.234.567 here)
  await expect(area.locator('.tot tr.b td.n')).toHaveText(openTotal.replace(/\s/g, ' ').trim());
});

test('manager: Tanda terima barang (v59: with the note\'s prices and total, see below)', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await stubPrint(page);
  await nav(page, 'purchases');
  await page.locator('#pu-hist [data-act="pu-doc"]').first().click();
  await expect.poll(() => printed(page)).toBe(1);
  await expect(page.locator('#print-area .kdoc h1')).toHaveText('TANDA TERIMA BARANG');
  await expect(page.locator('#print-area')).toContainText('Harga beli');
});

// v50 (owner 2026-10-15: «عند ادخال بضائع جديده … تخرج الاجمالي صفر وعند طباعه الورقه ايضا … صفر»): the manager saw "Rp 0" for every
// goods-in note. Purchase prices hidden (the owner's setting) → "disembunyikan", never 0; once the owner allows them → the real total
// on screen and on the receipt (the server used to drop the total even then).
// v59 (owner 2026-10-17: «لا يظهر الإجمالي و يكتب مخفي لماذا اصلح هذا»): the note total — the supplier's invoice the manager types in —
// shows for the manager and the accountant without that setting; the products' average cost and margins still follow it.
test('manager: the real note total on screen and on the receipt, without the owner\'s purchase-price setting (never "disembunyikan", never Rp 0)', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  expect((await getDb(page)).settings.akuntan_sees_cost).not.toBe(true);
  await stubPrint(page);
  await nav(page, 'purchases');
  const row = page.locator('#pu-hist tbody tr').first();
  await expect(page.locator('#pu-hist [data-cost-hidden]')).toHaveCount(0);
  await expect(page.locator('#pu-hist')).not.toContainText('Rp 0');
  await expect(page.locator('#pu-recent')).not.toContainText('Akuntan & manajer boleh melihat harga beli');
  const no = await row.getAttribute('data-no');
  const total = (await getDb(page)).purchases.filter(p => p.purchase_no === no).reduce((a, p) => a + p.total, 0);
  expect(total).toBeGreaterThan(0);
  await expect(row.locator('td.r.num')).toHaveText(rp(total));
  await row.locator('[data-act="pu-doc"]').click();
  await expect.poll(() => printed(page)).toBe(1);
  await expect(page.locator('#print-area')).toContainText('Harga beli');
  await expect(page.locator('#print-area .tot tr.b td.n')).toHaveText(rp(total));
  // the products' average cost (modal) and margin stay the owner's to give
  await closeModals(page);
  await nav(page, 'products');
  await expect(page.locator('th[data-col="cost"]')).toHaveCount(0);
});
