// POS "Tahan" (hold sale): park the cart, serve the next customer, resume later. Held carts stay on this
// device per store key, survive a reload, and are priced again from the current product data on resume.
const { test, expect } = require('@playwright/test');
const { rp, login, openApp, jktToday, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals, editDb, SHOTS } = require('./helpers');
const path = require('path');

const HELD_KEY = 'kpos.mock.held.demo';
const heldStored = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]'), HELD_KEY);
async function hold(page, label) {
  await page.click('#btn-hold');
  await expect(page.locator('#hold-prompt')).toBeVisible();
  if (label) await page.fill('#hold-label', label);
  await page.click('#hold-ok');
  await expect(page.locator('#hold-prompt')).toHaveCount(0);
}

test('hold → next sale → resume (same lines, discount, override) → pay; survives reload', async ({ page }) => {
  await login(page);
  const db0 = await getDb(page);
  const ajwa = productByName(db0, /Ajwa/), tun = productByName(db0, /Tunisia/);
  await expect(page.locator('#btn-hold')).toBeHidden(); // empty cart: nothing to hold
  await addBySearch(page, 'ajwa', 2);
  await addBySearch(page, 'tunisia', 3);
  await page.locator('.cline').nth(1).locator('.ptype').click(); // manual grosir on the Tunisia line
  await page.fill('#cart-disc', '4000');
  const total = 2 * ajwa.retail_price + 3 * tun.wholesale_price - 4000;
  await expect(page.locator('#cart-total')).toHaveText(rp(total));
  await expect(page.locator('#held-chip')).toBeHidden();

  await page.click('#btn-hold');
  await expect(page.locator('#hold-label')).toHaveAttribute('placeholder', 'Pelanggan 1');
  await page.fill('#hold-label', 'Bapak topi hitam');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-hold.png') });
  await page.locator('#hold-label').press('Enter');
  await expect(page.locator('.toast.ok', { hasText: 'Ditahan: Bapak topi hitam' })).toBeVisible();
  await expect(page.locator('.cline')).toHaveCount(0);
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  const st = await heldStored(page);
  expect(st).toHaveLength(1);
  expect(st[0]).toMatchObject({ label: 'Bapak topi hitam', by: 'Pemilik' });
  expect(JSON.stringify(st[0])).not.toMatch(/unit_price|retail_price|cost/);

  // next customer
  await addBySearch(page, 'gula pasir');
  await checkoutSkip(page);
  await page.click('#rc-new');

  // reload: still held
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'pos');
  await expect(page.locator('#pos-grid .pcard').first()).toBeVisible();
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  await page.click('#held-chip');
  const row = page.locator('#held-items .held');
  await expect(row).toContainText('Bapak topi hitam');
  await expect(row.locator('[data-ref="n"]')).toHaveText('2 produk');
  await expect(row.locator('[data-ref="total"]')).toHaveText(rp(total));
  await expect(row.locator('[data-ref="ago"]')).toHaveText(/baru saja|1 menit lalu/);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-held-list.png') });
  await row.locator('[data-act="held-resume"]').click();
  await expect(page.locator('.toast.ok', { hasText: 'Dilanjutkan: Bapak topi hitam' })).toBeVisible();
  await expect(page.locator('#held-chip')).toBeHidden();
  await expect(page.locator('.cline')).toHaveCount(2);
  await expect(page.locator('.cline').nth(1).locator('.ptype')).toHaveClass(/manual/);
  await expect(page.locator('#cart-total')).toHaveText(rp(total));
  expect(await heldStored(page)).toEqual([]);

  await checkoutSkip(page); // paying never waits for a survey
  const db = await getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ total, discount: 4000, status: 'ok' });
  expect(db.items.filter(i => i.invoice_no === sale.invoice_no).map(i => [i.product_id, i.qty, i.price_type]).sort()).toEqual([[ajwa.id, 2, 'eceran'], [tun.id, 3, 'grosir']].sort());
});

test('swap, delete with confirm, price change between hold and resume, max 10', async ({ page }) => {
  await login(page);
  const db0 = await getDb(page);
  const ajwa = productByName(db0, /Ajwa/);
  await addBySearch(page, 'ajwa');
  await hold(page);
  await addBySearch(page, 'almond');
  // the owner changes the Ajwa price meanwhile (server side) → the app reloads its data
  await editDb(page, `db.products.find(p => p.id === arg).retail_price = 180000;`, ajwa.id);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'pos');
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  await page.click('#held-chip');
  await expect(page.locator('#held-items .held [data-ref="total"]')).toHaveText(rp(180000));
  await page.locator('[data-act="held-resume"]').click(); // current cart (almond) is held automatically
  await expect(page.locator('.toast.ok', { hasText: 'Keranjang tadi' })).toHaveText('Keranjang tadi ditahan sebagai "Pelanggan 2". Dilanjutkan: Pelanggan 1');
  await expect(page.locator('#cart-total')).toHaveText(rp(180000));
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  // delete the almond cart
  await page.click('#held-chip');
  await page.locator('[data-act="held-del"]').click();
  await expect(page.locator('#cf-ok')).toHaveText('Hapus');
  await page.click('#cf-ok');
  await expect(page.locator('#held-list')).toContainText('Tidak ada transaksi ditahan');
  await closeModals(page);
  await expect(page.locator('#held-chip')).toBeHidden();
  // 10 held carts at most
  const gula = productByName(db0, /Gula Pasir/);
  await page.evaluate(([k, n, pid]) => {
    const one = { id: '', label: '', held_at: new Date().toISOString(), by: 'Pemilik', cart: { client_id: 'c', lines: [{ product_id: pid, name: 'Gula Pasir 1 kg', qty: 1, override: null }], customer_id: null, discount: 0, method: 'tunai', paid: '', survey: null, notes: '', channel: 'toko', promo: '' } };
    localStorage.setItem(k, JSON.stringify(Array.from({ length: n }, (_, i) => Object.assign({}, one, { id: 'h' + i, label: 'Pelanggan ' + (i + 1) }))));
  }, [HELD_KEY, 10, gula.id]);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'pos');
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (10)');
  await page.click('#btn-hold');
  await expect(page.locator('.toast.err')).toContainText('Sudah 10 transaksi ditahan');
  await expect(page.locator('#hold-prompt')).toHaveCount(0);
  await expect(page.locator('.cline')).toHaveCount(1);
  // a held cart older than 12 hours is marked "lama"
  await page.evaluate(k => { const a = JSON.parse(localStorage.getItem(k)); a[0].held_at = new Date(Date.now() - 13 * 3600000).toISOString(); localStorage.setItem(k, JSON.stringify(a)); }, HELD_KEY);
  await page.locator('[data-act="qty-inc"]').first().click(); // any cart change refreshes the chip
  await expect(page.locator('#held-chip')).toHaveClass(/old/);
  await page.click('#held-chip');
  await expect(page.locator('#held-items .held').first().locator('.badge.amber')).toHaveText('lama');
  await expect(page.locator('#held-items .held').first().locator('[data-ref="ago"]')).toHaveText('13 jam lalu');
  await expect(page.locator('#held-items .held.old')).toHaveCount(1);
});

test('manager: closing her shift warns about held carts; phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // v15: a manager no longer opens a drawer — this one was opened before (older version) and is still hers
  await openApp(page);
  await editDb(page, `db.shifts.push({ shift_id: 'SH-OLD1', cashier: 'Jihan', shift_date: arg, opened_at: arg + 'T08:00:00+07:00', closed_at: '', status: 'open', opening_cash: 300000, counted_cash: null, difference: null, note: '' });`, jktToday());
  await login(page, 'Jihan', '2222');
  await page.fill('#pos-search', 'ajwa');
  await page.locator('#pos-grid .pcard').first().click();
  await page.click('#qs-ok');
  await page.click('#cart-bar');
  await expect(page.locator('#cart.open')).toBeVisible();
  await hold(page, 'Baju merah');
  await expect(page.locator('#cart.open')).toHaveCount(0);
  await expect(page.locator('#held-chip')).toBeVisible();
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'phone-pos-held.png') });
  await nav(page, 'kas');
  await page.locator('#view-kas [data-act="shift-close"]:not([data-cashier])').click();
  await expect(page.locator('.modal', { hasText: 'Masih ada 1 transaksi ditahan' })).toBeVisible();
  await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').last().click();
  await expect(page.locator('#shift-close')).toHaveCount(0);
  await page.locator('#view-kas [data-act="shift-close"]:not([data-cashier])').click();
  await page.click('#cf-ok');
  await expect(page.locator('#shift-close')).toBeVisible();
  expect(await heldStored(page)).toHaveLength(1);
});
