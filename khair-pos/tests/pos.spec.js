const { test, expect } = require('@playwright/test');
const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const { rp, login, switchUser, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals } = require('./helpers');

test.beforeEach(async ({ page }) => { await login(page); });

test('sell a retail item via search; receipt shows and stock decreases', async ({ page }) => {
  const before = productByName(await getDb(page), /Ajwa/);
  await addBySearch(page, 'ajwa');
  await expect(page.locator('.cline')).toHaveCount(1);
  await expect(page.locator('#cart-total')).toHaveText(rp(before.retail_price));
  await expect(page.locator('.cline .ptype')).toHaveText('Eceran');

  await checkoutSkip(page);
  const rc = page.locator('.modal #receipt');
  await expect(rc).toContainText('Khair Mart');
  await expect(rc).toContainText(before.name);
  await expect(rc).toContainText(rp(before.retail_price));
  const inv = (await rc.innerText()).match(/KM\d{6}-\d{4}/)[0];

  const db = await getDb(page);
  const sale = db.sales.find(s => s.invoice_no === inv);
  expect(sale).toMatchObject({ total: before.retail_price, payment_method: 'tunai', status: 'ok', cashier: 'Pemilik', debt_amount: 0 });
  expect(sale.sale_time).toMatch(/\+07:00$/);
  expect(db.items.filter(i => i.invoice_no === inv)).toMatchObject([{ product_id: before.id, qty: 1, price_type: 'eceran', unit_price: before.retail_price }]);
  expect(productByName(db, /Ajwa/).stock).toBe(before.stock - 1);

  // new sale clears the cart
  await page.click('#rc-new');
  await expect(page.locator('.cline')).toHaveCount(0);
});

test('barcode scanner: fast typing of a SKU + Enter adds the product and clears the box', async ({ page }) => {
  const p = productByName(await getDb(page), /Gula Pasir/);
  const s = page.locator('#pos-search');
  await expect(s).toBeFocused();
  await page.keyboard.type(p.sku, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.cline')).toHaveCount(1);
  await expect(s).toHaveValue('');
  // scanning the same code again increments qty; keystrokes typed with focus elsewhere are routed to the search box
  await page.locator('#cart-lines').click();
  await page.keyboard.type(p.sku, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.cline input[data-qty]')).toHaveValue('2');
  await expect(page.locator('#cart-total')).toHaveText(rp(2 * p.retail_price));
  // unknown barcode → error toast, nothing added
  await page.keyboard.type('0000000000000', { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast.err')).toContainText('tidak ditemukan');
  await expect(page.locator('.cline')).toHaveCount(1);
});

test('wholesale price switches at wholesale_min_qty, manual override per line, and for a grosir customer', async ({ page }) => {
  const db = await getDb(page);
  const p = productByName(db, /Tunisia/); // wholesale_min_qty 10
  await addBySearch(page, 'tunisia');
  const qty = page.locator('.cline input[data-qty]');
  const pt = page.locator('.cline .ptype');
  await qty.fill(String(p.wholesale_min_qty));
  await expect(pt).toHaveText('Grosir');
  await expect(page.locator('#cart-total')).toHaveText(rp(p.wholesale_min_qty * p.wholesale_price));
  await qty.fill(String(p.wholesale_min_qty - 1));
  await expect(pt).toHaveText('Eceran');
  await expect(page.locator('#cart-total')).toHaveText(rp((p.wholesale_min_qty - 1) * p.retail_price));
  // manual override to grosir below the threshold
  await qty.press('Enter');
  await pt.click();
  await expect(pt).toHaveText('Grosir');
  await expect(pt).toHaveClass(/manual/);
  await expect(page.locator('#cart-total')).toHaveText(rp((p.wholesale_min_qty - 1) * p.wholesale_price));
  await pt.click(); // back to auto
  await expect(pt).toHaveText('Eceran');

  // grosir customer → all lines grosir even at qty 1
  const g = productByName(db, /Gula Pasir/);
  await addBySearch(page, 'gula pasir');
  await page.click('#cart-cust');
  await page.fill('#cp-q', 'Berkah');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Toko Berkah' }).click();
  await expect(page.locator('#cart-cust')).toContainText('Toko Berkah Condet');
  await expect(page.locator('.cline .ptype')).toHaveText(['Grosir', 'Grosir']);
  await expect(page.locator('#cart-total')).toHaveText(rp((p.wholesale_min_qty - 1) * p.wholesale_price + g.wholesale_price));
  await checkoutSkip(page);
  const last = (await getDb(page)).items.slice(-2);
  expect(last.map(i => i.price_type)).toEqual(['grosir', 'grosir']);
});

test('debt (hutang) needs a customer and increases the customer debt; receiving payment reduces it', async ({ page }) => {
  let db = await getDb(page);
  const cust = db.customers.find(c => c.name === 'Warung Bu Halimah');
  const p = productByName(db, /Kismis Hijau/);
  await addBySearch(page, 'kismis hijau');
  await page.click('[data-act="method"][data-m="hutang"]');
  await expect(page.locator('#cart [data-ref="result"]')).toContainText('wajib memilih pelanggan');
  const salesBefore = db.sales.length;
  await page.click('#btn-checkout');
  await expect(page.locator('.toast.err')).toBeVisible();
  expect((await getDb(page)).sales.length).toBe(salesBefore);

  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Warung Bu Halimah' }).click();
  await expect(page.locator('#cart [data-ref="result"]')).toContainText(rp(p.wholesale_price));
  await checkoutSkip(page);
  await expect(page.locator('.modal #receipt')).toContainText('Sisa hutang');

  db = await getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ customer_id: cust.id, payment_method: 'hutang', paid_amount: 0, debt_amount: p.wholesale_price });
  const after = db.customers.find(c => c.id === cust.id).debt_balance;
  expect(after).toBe(cust.debt_balance + p.wholesale_price);
  await closeModals(page);

  // receive a payment from the customer page — money-in is the manager's job; the owner only monitors
  await switchUser(page, 'Jihan', '2222');
  await nav(page, 'customers');
  await page.locator('[data-act="cust-open"]').filter({ hasText: 'Warung Bu Halimah' }).click();
  await expect(page.locator('#cd-debt')).toHaveText(rp(after));
  await expect(page.locator('#cd-wa')).toHaveAttribute('href', /wa\.me\/6281322223344\?text=.*Halimah/);
  await page.click('[data-act="cust-pay"]');
  const pay = Math.min(100000, after); // the seeded debt depends on the day the demo data was made
  await page.fill('#py-amt', NF.format(pay));
  await page.click('#py-m [data-m="transfer"]');
  await page.click('#py-save');
  await expect(page.locator('.toast.ok')).toContainText('Pembayaran');
  db = await getDb(page);
  expect(db.customers.find(c => c.id === cust.id).debt_balance).toBe(after - pay);
  expect(db.payments[db.payments.length - 1]).toMatchObject({ customer_id: cust.id, amount: pay, method: 'transfer', cashier: 'Jihan' });
  await expect(page.locator('#cd-debt')).toHaveText(rp(after - pay));
});

test('cash payment: quick amount and change (kembalian)', async ({ page }) => {
  const p = productByName(await getDb(page), /Beras Premium/);
  await addBySearch(page, 'beras');
  const quick = page.locator('[data-act="paid-set"]').first();
  const v = Number(await quick.getAttribute('data-v'));
  expect(v).toBeGreaterThan(p.retail_price);
  await quick.click();
  await expect(page.locator('#cart-change')).toHaveText(rp(v - p.retail_price));
  await page.fill('#cart-paid', '100000');
  await expect(page.locator('#cart-change')).toHaveText(rp(100000 - p.retail_price));
  await checkoutSkip(page);
  await expect(page.locator('.modal #receipt')).toContainText('Kembalian');
  const sale = (await getDb(page)).sales.slice(-1)[0];
  expect(sale.paid_amount).toBe(p.retail_price); // amount applied to the invoice (change is not revenue)
});

test('offline: sale goes to the outbox, stock is decremented locally, then syncs when back online (idempotent)', async ({ page, context }) => {
  const p = productByName(await getDb(page), /Khalas/);
  await addBySearch(page, 'khalas');
  await context.setOffline(true);
  await checkoutSkip(page);
  await expect(page.locator('.modal #receipt')).toContainText('BELUM TERKIRIM');
  await expect(page.locator('#tb-outbox')).toHaveText('Belum terkirim (1)');
  await closeModals(page);
  const outbox = await page.evaluate(() => KPOS.S.outbox.map(e => e.client_id));
  expect(outbox).toHaveLength(1);
  let db = await getDb(page);
  expect(db.sales.some(s => s.client_id === outbox[0])).toBe(false);
  expect(await page.evaluate(id => KPOS.S.products.find(x => x.id === id).stock, p.id)).toBe(p.stock - 1);
  // the queued sale survives a reload (mock server kept "unreachable" via its kmock.offline switch)
  await context.setOffline(false);
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  await page.reload();
  await expect(page.locator('#tb-outbox')).toHaveText('Belum terkirim (1)');
  await expect(page.locator('#app')).toBeVisible();

  // back online → synced
  await page.evaluate(() => { localStorage.removeItem('kmock.offline'); window.dispatchEvent(new Event('online')); });
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 15000 });
  db = await getDb(page);
  const synced = db.sales.filter(s => s.client_id === outbox[0]);
  expect(synced).toHaveLength(1);
  expect(productByName(db, /Khalas/).stock).toBe(p.stock - 1);
  expect(await page.evaluate(id => KPOS.S.products.find(x => x.id === id).stock, p.id)).toBe(p.stock - 1);

  // resending the same client_id is a no-op on the server
  const dup = await page.evaluate(async cid => {
    const S = KPOS.S;
    const r = await apiRaw('save_sale', { client_id: cid, items: [{ product_id: 1, qty: 5, unit_price: 1, price_type: 'eceran' }], payment_method: 'tunai', paid_amount: 5 }, { key: S.key, user: S.user, pin_hash: S.pin_hash });
    return r.duplicate;
  }, outbox[0]);
  expect(dup).toBe(true);
  expect((await getDb(page)).sales.filter(s => s.client_id === outbox[0])).toHaveLength(1);
});

test('an {ok:false} answer is shown and NOT queued; the cart is kept', async ({ page }) => {
  await addBySearch(page, 'ajwa');
  // product disappears on the server → NOT_FOUND
  await page.evaluate(() => { const db = JSON.parse(localStorage.getItem('kmock.db')); db.products = db.products.filter(p => !/Ajwa/.test(p.name)); localStorage.setItem('kmock.db', JSON.stringify(db)); });
  await page.click('#btn-checkout');
  await expect(page.locator('.toast.err')).toContainText('tidak ditemukan');
  await expect(page.locator('#tb-outbox')).toBeHidden();
  await expect(page.locator('.cline')).toHaveCount(1);
});

test('manual survey (optional, from the payment panel): answers saved only with consent; skip saves nothing', async ({ page }) => {
  await addBySearch(page, 'zamzam');
  await page.click('#vs-manual');
  await expect(page.locator('.modal h2')).toHaveText('Survei pelanggan (opsional)');
  await page.locator('[data-sq="1"]').fill('Dari TikTok');
  await page.click('#sv-save');
  await expect(page.locator('#sv-err')).toContainText('persetujuan');
  await page.check('#sv-consent');
  await page.click('#sv-save');
  await expect(page.locator('#survey')).toHaveCount(0);
  await expect(page.locator('#vs-manual .badge')).toHaveText('terisi');
  await checkoutSkip(page);
  let sale = (await getDb(page)).sales.slice(-1)[0];
  expect(JSON.parse(sale.survey)).toEqual([{ q: 'Tahu Khair Mart dari mana?', a: 'Dari TikTok' }]);
  expect(sale.survey_transcript).toBe('');
  await closeModals(page);

  await addBySearch(page, 'zamzam');
  await checkoutSkip(page);
  sale = (await getDb(page)).sales.slice(-1)[0];
  expect(JSON.parse(sale.survey)).toEqual([]);
});

test('receipt: copy text, WhatsApp link, print-only receipt', async ({ page }) => {
  await addBySearch(page, 'pistachio');
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).click();
  await checkoutSkip(page);
  const inv = (await page.locator('.modal #receipt').innerText()).match(/KM\d{6}-\d{4}/)[0];
  await page.click('[data-act="rc-copy"]');
  await expect(page.locator('.toast.ok')).toHaveText('Tersalin');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(inv);
  expect(clip).toContain('Kacang Pistachio');
  await expect(page.locator('#rc-wa')).toHaveAttribute('href', new RegExp(`^https://wa\\.me/6281244445566\\?text=.*${inv}`));

  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await page.click('[data-act="rc-print"]');
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(true);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-area #receipt')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#print-area')).toContainText(inv);
  expect(await page.locator('#page-style').textContent()).toContain('58mm');
});
