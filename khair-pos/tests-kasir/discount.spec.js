// v16 discount limit: list total vs total; a kasir above max_discount_pct (default 3 %) asks the manager / owner
// (request_discount), waits like a credit approval, then the sale goes through with discount_approval_id.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('live % against the limit; over it → "Minta persetujuan diskon" → manager approves (no profit shown) → sale saved', async ({ page, context }) => {
  await H.login(page);
  await H.addItem(page, 'ajwa'); // Rp 175.000 retail
  await H.pay(page);
  // within the limit: 5.000 = 2,9 % → plain SELESAI
  await page.fill('#pay-disc', '5000');
  await expect(page.locator('#pay-disc-pct')).toHaveText('Diskon 2,9% (batas 3%)');
  await expect(page.locator('#pay-ok')).toHaveText('SELESAI');
  await expect(page.locator('#pay-total')).toHaveText(H.rp(170000));
  // above: 10.000 = 5,7 %
  await page.fill('#pay-disc', '10000');
  await expect(page.locator('#pay-disc-pct')).toHaveText('Diskon 5,7% (batas 3%)');
  await expect(page.locator('#pay-disc-pct')).toHaveClass(/red/);
  await expect(page.locator('#pay-disc-warn')).toContainText('perlu persetujuan manajer');
  await expect(page.locator('#pay-ok')).toHaveText('Minta persetujuan diskon');
  // the server refuses it too
  const code = await page.evaluate(async () => { try { await api('save_sale', { client_id: 'x-' + Date.now(), sale_date: '2026-01-01', items: [{ product_id: 1, qty: 1, unit_price: 175000, price_type: 'eceran' }], discount: 10000, payment_method: 'tunai', paid_amount: 165000 }); return 'saved'; } catch (e) { return e.code; } });
  expect(code).toBe('DISCOUNT_APPROVAL_REQUIRED');
  await page.click('#pay-ok');
  const step = page.locator('#disc-step');
  await expect(step).toBeVisible();
  await expect(step).toContainText(H.rp(175000));
  await expect(step).toContainText('5,7%');
  await page.fill('#disc-reason', 'Pelanggan lama, beli rutin');
  await H.shot(page, 'phone-41-discount-request', false, { noToasts: true });
  await page.click('#disc-send');
  await expect(page.locator('#disc-wait')).toBeVisible();
  const rid = (await page.locator('#dw-id').textContent()).trim();
  let db = await H.getDb(page);
  const ap = db.approvals.find(a => a.request_id === rid);
  expect(ap).toMatchObject({ kind: 'discount', status: 'pending', approver_role: 'manager', debt_amount: 10000, total: 165000, note: 'Pelanggan lama, beli rutin' });
  expect(JSON.parse(ap.payload)).toMatchObject({ list_total: 175000, discount: 10000, pct: 5.7, max_pct: 3, member_pct: 0 });
  expect(JSON.parse(ap.payload).profit_before).toBeGreaterThan(0); // stored for the owner…
  const seen = await page.evaluate(async id => (await api('check_approval', { request_id: id })).approval, rid);
  expect(seen.payload).not.toMatch(/profit|margin/); // …never sent to the kasir
  expect(seen.summary).not.toContain('laba');
  expect(db.activity.find(a => a.kind === 'minta_diskon' && a.ref === rid)).toMatchObject({ user: 'Siti', level: 'warn', amount: 10000 });

  // the manager decides on her phone: the card shows the discount, never profit
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await p2.click('#tb-appr');
  const card = p2.locator(`.apr-card[data-req="${rid}"]`);
  await expect(card).toHaveAttribute('data-kind', 'discount');
  await expect(card).toContainText('Diskon 5,7%');
  await expect(card.locator('[data-disc]')).toContainText(H.rp(10000));
  await expect(card).toContainText('Pelanggan lama');
  await expect(card).not.toContainText(/laba|margin|profit/i);
  await H.shot(p2, 'phone-42-discount-card');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  await p2.close();

  // the kasir's poll sees it and saves the sale with discount_approval_id
  const rc = page.locator('#rc-modal #receipt');
  await expect(rc).toBeVisible({ timeout: 15000 });
  await expect(rc).toContainText('Diskon');
  await expect(rc).toContainText('165.000');
  db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ discount: 10000, total: 165000, cashier: 'Siti' });
  expect(sale.notes).toContain('[diskon 5.7% disetujui Jihan]');
  expect(db.approvals.find(a => a.request_id === rid).status).toBe('used');
  expect(db.activity.find(a => a.kind === 'diskon' && a.ref === sale.invoice_no)).toMatchObject({ level: 'warn', amount: 10000 });
  await page.click('#rc-new');
  await H.tab(page, 'more');
  await page.click('#m-myreq');
  await expect(page.locator(`#myreq [data-req="${rid}"]`)).toContainText('Diskon 5,7%');
});

test('owner / manager give a bigger discount themselves (logged); a rejected request is shown with the note', async ({ page, context }) => {
  await H.login(page, 'Jihan', '2222');
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.fill('#pay-disc', '20000');
  await expect(page.locator('#pay-disc-warn')).toContainText('tercatat atas nama Anda');
  await expect(page.locator('#pay-ok')).toHaveText('SELESAI');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const db = await H.getDb(page);
  expect(db.sales[db.sales.length - 1].notes).toContain('[diskon 11.4% disetujui Jihan]');

  // a kasir's request rejected by the owner
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Siti', '1111');
  await H.addItem(p2, 'ajwa');
  await H.pay(p2);
  await p2.fill('#pay-disc', '30000');
  await p2.click('#pay-ok');
  await p2.click('#disc-send');
  const rid = (await p2.locator('#dw-id').textContent()).trim();
  const p3 = await H.otherPhone(context);
  await H.login(p3, 'Pemilik', '1234');
  await p3.click('#tb-appr');
  const card = p3.locator(`.apr-card[data-req="${rid}"]`);
  await card.locator('[data-note]').fill('Terlalu besar');
  await card.locator('[data-d="rejected"]').click();
  await expect(card).toHaveCount(0);
  await expect(p2.locator('#dw-rej')).toContainText('Diskon ditolak Pemilik', { timeout: 15000 });
  await expect(p2.locator('#dw-note')).toContainText('Terlalu besar');
});
