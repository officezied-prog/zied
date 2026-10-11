// Owner requests (07 Oct): receipt sending fee (first receipt per customer free, later + receipt_send_fee) and
// "Ganti orang" (another person takes a role: new name + new temporary PIN hashed with the new name); users grouped by role.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, sha, jktToday, login, getDb, nav, asUser, addBySearch, checkoutSkip, closeModals, typePin } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (n < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));

test('receipt fee: setting; POS first receipt free, then +fee when ticked; shown on receipt, history and daily report; server rules', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await expect(page.locator('#st-send-fee')).toHaveValue('500');
  await expect(page.locator('#st-receipt')).toContainText('Struk pertama gratis, berikutnya +Rp 500');
  await page.fill('#st-send-fee', '750');
  await page.click('[data-act="set-save-sendfee"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  expect((await getDb(page)).settings.receipt_send_fee).toBe(750);
  await page.locator('#st-receipt').screenshot({ path: path.join(SHOTS, 'desktop-settings-receipt-fee.png') });

  let db = await getDb(page);
  const cust = db.customers.find(c => c.name === 'Pak Hasan Alatas'), p = db.products.find(x => /Kurma Ajwa/.test(x.name));
  expect(cust.receipts_sent || 0).toBe(0);
  await nav(page, 'pos');
  // first receipt: on by default and free
  await addBySearch(page, 'ajwa');
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Pak Hasan Alatas' }).click();
  await expect(page.locator('#cart-send')).toBeChecked();
  await expect(page.locator('#cart-send-fee')).toHaveText('gratis (pertama)');
  await expect(page.locator('#cart-total')).toHaveText(rp(p.retail_price));
  await checkoutSkip(page);
  await closeModals(page);
  db = await getDb(page);
  expect(db.sales.slice(-1)[0]).toMatchObject({ send_fee: 0, total: p.retail_price });
  expect(db.customers.find(c => c.id === cust.id).receipts_sent).toBe(1);
  // second: off by default; ticking adds the fee
  await addBySearch(page, 'ajwa');
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Pak Hasan Alatas' }).click();
  await expect(page.locator('#cart-send')).not.toBeChecked();
  await expect(page.locator('#cart-send-fee')).toHaveText('+Rp 750');
  await page.check('#cart-send');
  await expect(page.locator('#cart-total')).toHaveText(rp(p.retail_price + 750));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-pos-receipt-fee.png') });
  await checkoutSkip(page);
  await expect(page.locator('.modal #receipt [data-send-fee]')).toContainText('750');
  await closeModals(page);
  db = await getDb(page);
  const sale = db.sales.slice(-1)[0];
  expect(sale).toMatchObject({ send_fee: 750, total: p.retail_price + 750 });
  expect(db.customers.find(c => c.id === cust.id).receipts_sent).toBe(2);
  // history and daily report
  await nav(page, 'history');
  await expect(page.locator(`[data-act="hist-open"][data-inv="${sale.invoice_no}"] [data-send-fee]`)).toContainText('Rp 750');
  await nav(page, 'home');
  await page.click('#home-daily');
  await expect(page.locator('[data-dr="send-fee"]')).toHaveText('1 · Rp 750');
  // server rules: sending needs a customer; the fee is not counted as discount
  const walk = { client_id: 'rs-' + Date.now(), sale_date: jktToday(), items: [{ product_id: p.id, qty: 1, unit_price: p.retail_price, price_type: 'eceran' }], discount: 0, payment_method: 'tunai', paid_amount: p.retail_price, send_receipt: true };
  expect(await asUser(page, 'Pemilik', '1234', 'save_sale', walk)).toMatchObject({ error: 'INVALID', message: expect.stringContaining('nomor HP') });
  await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 100000 });
  const k = await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, walk, { client_id: 'rs2-' + Date.now(), customer_id: cust.id, paid_amount: p.retail_price + 750 }));
  expect(k.sale).toMatchObject({ send_fee: 750, total: p.retail_price + 750 });
});

test('users grouped by role (Akuntan: belum ditentukan); "Ganti orang" → new name + temporary PIN; the new person must change it; login: the owner app lists only the owner', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  for (const [r, title] of [['owner', 'Pemilik'], ['manager', 'Manajer'], ['kasir', 'Kasir'], ['sales', 'Sales'], ['akuntan', 'Akuntan']]) await expect(page.locator(`[data-role-group="${r}"] h4`)).toContainText(title);
  await expect(page.locator('[data-role-group="akuntan"] [data-empty-group]')).toHaveText('belum ditentukan');
  await expect(page.locator('[data-role-group="manager"] tr[data-user="Jihan"]')).toBeVisible();
  // the manager gets a new person: 6-digit temporary PIN
  await page.locator('tr[data-user="Jihan"] [data-act="user-swap"]').click();
  await page.fill('#sw-name', 'Nur<b>aini');
  await expect(page.locator('#sw-name')).toHaveValue('Nurbaini');
  await page.fill('#sw-name', 'Nuraini');
  await page.fill('#sw-pin', '1357');
  await page.fill('#sw-pin2', '1357');
  await page.click('#sw-save');
  await expect(page.locator('#sw-err')).toContainText('6 angka');
  await page.fill('#sw-pin', '135791');
  await page.fill('#sw-pin2', '135791');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-users-swap.png') });
  await page.click('#sw-save');
  await expect(page.locator('#swap-modal')).toHaveCount(0);
  await expect(page.locator('#st-temp-pin')).toContainText('Nuraini');
  await expect(page.locator('[data-role-group="manager"] tr[data-user="Nuraini"] [data-must]')).toBeVisible();
  let db = await getDb(page);
  expect(db.users.find(u => u.name === 'Jihan')).toBeUndefined();
  expect(db.users.find(u => u.name === 'Nuraini')).toMatchObject({ role: 'manager', must_change: true, pin_hash: sha('demo:nuraini:135791') });
  expect(db.activity.slice(-1)[0].summary).toBe('Ganti orang: Jihan → Nuraini (manager), PIN sementara baru');
  // server rules: name taken / no new PIN / open drawer
  expect(await asUser(page, 'Pemilik', '1234', 'save_user', { name: 'Rina', new_name: 'Siti', role: 'kasir', pin_hash: sha('demo:siti:2468') })).toMatchObject({ error: 'INVALID', message: 'Nama sudah dipakai' });
  expect(await asUser(page, 'Pemilik', '1234', 'save_user', { name: 'Rina', new_name: 'Dewi', role: 'kasir' })).toMatchObject({ error: 'INVALID' });
  await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 100000 });
  expect(await asUser(page, 'Pemilik', '1234', 'save_user', { name: 'Siti', new_name: 'Dewi', role: 'kasir', pin_hash: sha('demo:dewi:2468') })).toMatchObject({ error: 'INVALID', message: expect.stringContaining('Tutup kas Siti') });
  // phone: grouped list
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#st-users').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'phone-users-by-role.png') });
  await page.setViewportSize({ width: 1366, height: 768 });
  // login: role titles before names; the new manager must make her own PIN
  await page.click('#tb-lock');
  await page.evaluate(() => { localStorage.removeItem('kpos.mock.users_demo'); });
  await page.reload();
  // the owner app lists the owner, the managers and the accountant (one admin link, v29); the new manager also logs in
  // through Khair Kasir and must make her own PIN there
  await expect(page.locator('[data-act="login-user"][data-name="Pemilik"]')).toHaveText('Pemilik');
  await expect(page.locator('[data-act="login-user"][data-name="Nuraini"]')).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-login-owner-only.png') });
  await page.evaluate(() => localStorage.setItem('kpos.device_consent', JSON.stringify({ ok: false, at: new Date().toISOString() })));
  await page.goto('kasir/index.html?mock=1');
  if (await page.locator('[data-act="login-back"]').first().isVisible()) await page.locator('[data-act="login-back"]').first().click(); // the PIN pad of the last person
  await page.click('[data-act="login-user"][data-name="Nuraini"]');
  await typePin(page, '135791');
  await expect(page.locator('#newpin')).toContainText('Buat PIN baru');
});
