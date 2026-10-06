// Receipt sending fee (07 Oct): a new customer gives a phone number at payment (first receipt free, saved as a customer);
// a known customer who already got one pays receipt_send_fee (Rp 500) when "Kirim struk" is on — a visible line on the bill,
// included in total and change, never counted as discount. Without it: printed / screen receipt as before.
// Also: the role title before the name in the login list and the header.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('new customer: number at payment, first receipt free; next time "+Rp 500" toggle with the fee on the bill, total and change', async ({ page }) => {
  await H.openKasir(page);
  await H.enterKey(page);
  await expect(page.locator('[data-act="login-user"][data-name="Jihan"]')).toHaveText('Manajer · Jihan');
  await expect(page.locator('[data-act="login-user"][data-name="Siti"]')).toHaveText('Kasir · Siti');
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await expect(page.locator('#tb-user')).toHaveText('Kasir · Siti');
  const tas = H.productByName(await H.getDb(page), /Tasbih/), price = tas.retail_price;

  await H.addItem(page, 'tasbih');
  await H.pay(page);
  const box = page.locator('#rs-box');
  await expect(box).toHaveAttribute('data-state', 'ask');
  await expect(box).toContainText('Nomor HP untuk kirim struk (gratis pertama kali)');
  await page.fill('#rs-phone', '0812 7777 1234');
  await expect(page.locator('#rs-phone')).toHaveValue('081277771234');
  await H.shot(page, 'phone-63-receipt-ask', false, { noToasts: true });
  await page.click('#rs-save');
  await expect(page.locator('#pay-cust')).toContainText('Pelanggan 1234');
  await expect(box).toHaveAttribute('data-state', 'on');
  await expect(page.locator('#pay-sendfee')).toHaveCount(0); // the first one is free
  await expect(page.locator('#pay-total')).toHaveText(H.rp(price));
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  await expect(page.locator('#rc-sendfee')).toHaveCount(0);
  await expect(page.locator('#rcs-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/6281277771234\?text=/);
  let db = await H.getDb(page);
  const cust = db.customers.find(c => c.phone === '6281277771234');
  expect(cust).toMatchObject({ name: 'Pelanggan 1234', receipts_sent: 1 });
  expect(db.sales[db.sales.length - 1]).toMatchObject({ customer_id: cust.id, send_fee: 0, total: price });
  await page.click('#rc-new');

  // the same customer again: "Kirim struk (+Rp 500)" is off until the customer wants it
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-cust');
  await page.fill('#cp-q', '1234');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Pelanggan 1234' }).click();
  await expect(page.locator("#rs-toggle")).toHaveText(/Kirim struk \(\+\u2066?Rp 500\u2069?\)/);
  await expect(page.locator('#rs-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#pay-total')).toHaveText(H.rp(price));
  await page.click('#rs-toggle');
  await expect(page.locator('#pay-sendfee')).toHaveText('Biaya kirim struk' + H.rp(500));
  await expect(page.locator('#pay-total')).toHaveText(H.rp(price + 500));
  await page.fill('#pay-cash', '50000');
  await expect(page.locator('#pay-change')).toHaveText(H.rp(50000 - price - 500));
  await H.shot(page, 'phone-64-receipt-fee', false, { noToasts: true });
  await page.click('#pay-ok');
  await expect(page.locator('#rc-sendfee')).toContainText('500');
  await expect(page.locator('#rc-change')).toContainText(H.rp(50000 - price - 500));
  db = await H.getDb(page);
  expect(db.sales[db.sales.length - 1]).toMatchObject({ send_fee: 500, total: price + 500, subtotal: price, discount: 0 });
  expect(db.customers.find(c => c.id === cust.id).receipts_sent).toBe(2);
  await page.click('#rc-new');

  // not wanted: no fee, receipt on screen as before
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-cust');
  await page.fill('#cp-q', '1234');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Pelanggan 1234' }).click();
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  db = await H.getDb(page);
  expect(db.sales[db.sales.length - 1]).toMatchObject({ send_fee: 0, total: price });
  expect(db.customers.find(c => c.id === cust.id).receipts_sent).toBe(2);
});

test('server rules (mock mirrors): sending needs a customer; the fee is not counted as discount; Arabic toggle', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const tas = H.productByName(db0, /Tasbih/), price = tas.retail_price;
  const known = db0.customers.find(c => c.phone && c.type !== 'grosir'); // retail prices
  await H.setDb(page, `const c = db.customers.find(x => x.id === arg); c.receipts_sent = 3; c.member = false;`, known.id);
  const disc = Math.floor(price * 0.03);
  const r = await page.evaluate(async ([pid, price, disc, cid]) => {
    const base = () => ({ client_id: crypto.randomUUID(), sale_date: new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10), items: [{ product_id: pid, qty: 1, unit_price: price }], payment_method: 'tunai', paid_amount: 999999 });
    const one = async d => { try { return await api('save_sale', d); } catch (e) { return { error: e.code, message: e.message }; } };
    return {
      walkin: await one(Object.assign(base(), { send_receipt: true })),
      limit: await one(Object.assign(base(), { customer_id: cid, discount: disc, send_receipt: true }))
    };
  }, [tas.id, price, disc, known.id]);
  expect(r.walkin).toEqual({ error: 'INVALID', message: 'Simpan nomor HP pelanggan dulu untuk kirim struk' });
  expect(r.limit.sale).toMatchObject({ send_fee: 500, total: price - disc + 500, discount: disc }); // 3 % exactly: no approval needed

  await page.evaluate(() => refreshData(true));
  await H.tab(page, 'more');
  await page.click('#lang-ar');
  await H.tab(page, 'sell');
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: known.name }).first().click();
  await page.click('#rs-toggle');
  await expect(page.locator('#pay-sendfee')).toContainText('رسوم إرسال الإيصال');
  await expect(page.locator('#pay-total')).toHaveText(H.rp(price + 500));
  await expect(page.locator('#tb-user')).toHaveText(/ · /);
  await H.shot(page, 'phone-65-receipt-fee-ar', false, { noToasts: true });
});
