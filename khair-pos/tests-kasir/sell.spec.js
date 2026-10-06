// Core cashier flow: store key → name → PIN → Buka Kasir → scan/search → qty → cash with change → receipt.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('store key, login with PIN, open the cash drawer', async ({ page }) => {
  await H.openKasir(page);
  await expect(page.locator('#owner-link')).toHaveAttribute('href', '../index.html?mock=1');
  await H.shot(page, 'phone-01-key');
  await H.enterKey(page);
  // kasir first, the owner can also log in
  await expect(page.locator('#users [data-act="login-user"]').first()).toHaveAttribute('data-name', /Siti|Rina/);
  await expect(page.locator('#users [data-name="Pemilik"]')).toBeVisible();
  await H.shot(page, 'phone-02-users');
  await page.click('[data-act="login-user"][data-name="Siti"]');
  await expect(page.locator('#pin-who')).toHaveText('Siti');
  await H.typePin(page, '9999');
  await expect(page.locator('#login .err')).toContainText('PIN salah');
  await page.click('[data-act="pin-key"][data-k="1"]');
  await H.shot(page, 'phone-03-pin');
  for (const d of '111') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#gate #shift-open')).toBeVisible();
  await expect(page.locator('#gate')).toContainText('Buka Kasir');
  await H.shot(page, 'phone-04-buka-kasir');
  // selling is blocked until the drawer is open
  await page.fill('#so-cash', '500.000');
  await page.click('#so-ok');
  await expect(page.locator('#gate')).toBeHidden();
  const db = await H.getDb(page);
  const sh = db.shifts.find(x => x.cashier === 'Siti' && x.status === 'open');
  expect(sh.opening_cash).toBe(500000);
  // the store key is the same key the owner app stores (shared device setting)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.key')))).toBe('demo');

  // reload: session kept, drawer still open → straight to selling
  await page.reload();
  await expect(page.locator('#grid .pc').first()).toBeVisible();
  await expect(page.locator('#gate')).toBeHidden();
});

test('skip the key step when the owner app already saved it on this device', async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('kpos.mock.key')) localStorage.setItem('kpos.mock.key', JSON.stringify('demo')); });
  await H.openKasir(page);
  await expect(page.locator('#lg-key')).toHaveCount(0);
  await expect(page.locator('#users [data-name="Siti"]')).toBeVisible();
});

test('scan (keyboard wedge) + search, quantity stepper, cash payment with change, receipt', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Ajwa/), tun = H.productByName(db0, /Tunisia/);
  // barcode scanner: very fast typing + Enter
  await page.locator('#q').focus();
  await page.keyboard.type(ajwa.sku, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('#survey')).toHaveCount(0); // the survey never interrupts selling
  await expect(page.locator('#paybar-total')).toHaveText(H.rp(175000));
  // unknown barcode → error, nothing added
  await page.locator('#q').focus();
  await page.keyboard.type('8990000000000', { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast.err')).toContainText('tidak dikenal');
  // search by name
  await H.addItem(page, 'tunisia');
  await expect(page.locator('#grid .pc[data-id="' + tun.id + '"] .incart')).toHaveText('1');
  await H.openCart(page);
  await expect(page.locator('#lines .cl')).toHaveCount(2);
  await page.locator('.cl[data-pid="' + tun.id + '"] [data-act="qty-inc"]').click();
  await expect(page.locator('.cl[data-pid="' + tun.id + '"] input[data-qty]')).toHaveValue('2');
  await expect(page.locator('#cart-total')).toHaveText(H.rp(175000 + 2 * 38000));
  await H.shot(page, 'phone-06-cart');
  await page.click('#btn-pay');
  await expect(page.locator('#pay')).toBeVisible();
  await expect(page.locator('#pm-tunai')).toHaveAttribute('aria-checked', 'true');
  await page.fill('#pay-cash', '300000');
  await expect(page.locator('#pay-change')).toHaveText(H.rp(300000 - 251000));
  await H.shot(page, 'phone-07-pay-cash');
  // not enough cash → blocked
  await page.fill('#pay-cash', '200000');
  await expect(page.locator('#pay-result')).toContainText('Uang kurang');
  await expect(page.locator('#pay-ok')).toBeDisabled();
  await page.fill('#pay-cash', '300000');
  await page.click('#pay-ok');
  const rc = page.locator('#rc-modal #receipt');
  await expect(rc).toBeVisible();
  await expect(page.locator('#rc-change')).toContainText(H.rp(49000));
  await expect(rc).toContainText('Kurma Tunisia');
  await expect(rc).toContainText('49.000');
  await H.shot(page, 'phone-08-receipt');
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ total: 251000, paid_amount: 251000, payment_method: 'tunai', cashier: 'Siti', channel: 'toko', status: 'ok' });
  expect(sale.shift_id).toMatch(/^SH-/);
  await expect(rc).toContainText(sale.invoice_no);
  expect(db.products.find(p => p.id === tun.id).stock).toBe(tun.stock - 2);
  // copy and print buttons work
  await page.click('#rc-copy');
  await expect(page.locator('.toast.ok', { hasText: 'Disalin' })).toBeVisible();
  await page.click('#rc-new');
  await expect(page.locator('#paybar-pay')).toBeDisabled();
});

test('channel chip and promo code are sent with the sale', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'almond');
  await H.pay(page);
  await page.click('#pay-more summary');
  await page.click('[data-act="channel"][data-c="whatsapp"]');
  await page.fill('#pay-promo', 'khair1111');
  await page.click('#pm-qris');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toContainText('KHAIR1111');
  const db = await H.getDb(page);
  expect(db.sales[db.sales.length - 1]).toMatchObject({ channel: 'whatsapp', promo_code: 'KHAIR1111', payment_method: 'qris' });
});

test('a kasir redirected from the owner app lands on the PIN pad for that name', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('kpos.mock.key', JSON.stringify('demo')); localStorage.setItem('kpos.mock.last_user', JSON.stringify('Siti')); });
  await page.goto('kasir/?mock=1');
  await expect(page.locator('#pin-who')).toHaveText('Siti');
  await page.click('[data-act="login-back"] >> nth=0');
  await expect(page.locator('#users [data-name="Rina"]')).toBeVisible();
});
