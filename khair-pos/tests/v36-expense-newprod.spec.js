// v36 (owner 2026-10-11) in the management app:
//  #12 expense item lines (sum = amount); a cashier's expense whose invoice differs (or could not be read) reaches the
//      Persetujuan inbox line by line; approving / rejecting shows in the Expenses list and the daily report.
//  #13 a product the cashier created at goods-in is flagged "Baru — dicek"; the owner / manager confirms it and may
//      correct the selling price; the invoice cost is shown to the owner only.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, nav, asUser, jktToday } = require('./helpers');

const LINES = [{ name: 'Kantong plastik besar', qty: 12, unit_price: 5000 }, { name: 'Lakban coklat', qty: 5, unit_price: 5000 }];

async function sitiExpenseWithDiff(page, scan) {
  if (scan) await page.evaluate(v => localStorage.setItem('kmock.expscan', v), scan);
  expect((await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 500000 })).error).toBeUndefined();
  const ph = await asUser(page, 'Siti', '1111', 'scan_expense', { image_base64: 'aGVsbG8=', mime: 'image/jpeg' });
  expect(ph.photo_id).toBeTruthy();
  return ph;
}

test('manager: expense item lines must add up to the amount; the list shows the lines', async ({ page }) => {
  await login(page, 'Jihan', '2222');
  await nav(page, 'expenses');
  await page.selectOption('#ex-cat', 'kemasan');
  await page.fill('#ex-amt', '90000');
  for (const [i, l] of LINES.entries()) {
    await page.click('#ex-add-line');
    await page.fill(`[data-exl-name="${i}"]`, l.name);
    await page.fill(`[data-exl-qty="${i}"]`, String(l.qty));
    await page.fill(`[data-exl-price="${i}"]`, String(l.unit_price));
  }
  await expect(page.locator('#ex-lines-total')).toHaveText('Rp 85.000');
  await expect(page.locator('#ex-lines-off')).toBeVisible();
  await page.click('#ex-save');
  await expect(page.locator('#ex-err')).toContainText('≠');
  await page.click('#ex-use-lines');
  await expect(page.locator('#ex-lines-off')).toHaveCount(0);
  await page.click('#ex-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Pengeluaran' })).toBeVisible();
  const db = await getDb(page);
  const ex = db.expenses.slice(-1)[0];
  expect(ex).toMatchObject({ amount: 85000, category: 'kemasan', user: 'Jihan', check_status: '' });
  expect(JSON.parse(ex.lines).map(l => l.total)).toEqual([60000, 25000]);
  await expect(page.locator(`#ex-table tr[data-ex-id="${ex.id}"] [data-ex-lines]`)).toContainText('Lakban coklat');
  await expect(page.locator('#ex-lines .exl')).toHaveCount(0); // the form is empty again
});

test('cashier expense with invoice differences → owner inbox line by line → approve; the no-AI one → reject; expenses list + daily report', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true }); // the owner's inbox (v36: the owner no longer sells, so ask for him explicitly)
  const ph = await sitiExpenseWithDiff(page);
  expect((await asUser(page, 'Siti', '1111', 'save_expense', { category: 'kemasan', amount: 85000, paid_from: 'kas', photo_id: ph.photo_id, lines: LINES })).error).toBe('MISMATCH');
  const r1 = await asUser(page, 'Siti', '1111', 'save_expense', { category: 'kemasan', amount: 85000, paid_from: 'kas', photo_id: ph.photo_id, lines: LINES, mismatch_reason: 'bonus 2 kantong' });
  expect(r1.check.status).toBe('selisih');
  // the Worker without an AI key: unreadable → "cek manual", saved at once
  await page.evaluate(() => localStorage.setItem('kmock.expscan', 'off'));
  const ph2 = await asUser(page, 'Siti', '1111', 'scan_expense', { image_base64: 'aGVsbG8=', mime: 'image/jpeg' });
  const r2 = await asUser(page, 'Siti', '1111', 'save_expense', { category: 'transport', amount: 25000, paid_from: 'kas', photo_id: ph2.photo_id });
  expect(r2.check.status).toBe('cek_manual');
  expect(r2.check_request_id).toBeTruthy();

  await nav(page, 'approvals');
  const c1 = page.locator(`.apr-card[data-req="${r1.check_request_id}"]`);
  await expect(c1).toHaveAttribute('data-kind', 'expense_check');
  await expect(c1).toContainText('beda dengan nota');
  await expect(c1.locator('[data-exp-rows] td.bad')).toHaveCount(2);
  await expect(c1).toContainText('bonus 2 kantong');
  const c2 = page.locator(`.apr-card[data-req="${r2.check_request_id}"]`);
  await expect(c2).toContainText('cek nota manual');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-v36-expense-approval.png') });
  await c1.locator('[data-d="approved"]').click();
  await expect(c1).toHaveCount(0);
  await c2.locator('[data-note]').fill('nota hilang');
  await c2.locator('[data-d="rejected"]').click();
  await expect(c2).toHaveCount(0);
  const db = await getDb(page);
  expect(db.expenses.find(x => x.request_id === r1.check_request_id)).toMatchObject({ check_status: 'disetujui', checked_by: 'Pemilik' });
  expect(db.expenses.find(x => x.request_id === r2.check_request_id)).toMatchObject({ check_status: 'ditolak' });

  await nav(page, 'expenses');
  await expect(page.locator('[data-kpi="ex-approved"] .v')).toHaveText('1');
  await expect(page.locator('[data-kpi="ex-rejected"] .v')).toHaveText('1');
  await expect(page.locator('#ex-table [data-ex-status="disetujui"]')).toHaveCount(1);
  await page.click('[data-ex-check="rejected"]');
  await expect(page.locator('#ex-table tbody tr')).toHaveCount(1);
  await expect(page.locator('#ex-table [data-ex-status="ditolak"]')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-v36-expenses.png') });

  await nav(page, 'home');
  await page.click('#home-daily');
  await page.fill('#dr-date', jktToday());
  await page.locator('#dr-date').dispatchEvent('change');
  await expect(page.locator('[data-dr="exp-check"]')).toContainText('1 disetujui');
  await expect(page.locator('[data-dr="exp-check"]')).toContainText('1 ditolak');
});

test('a cashier\'s new product at goods-in: "Baru — dicek" in Products; the manager confirms with a corrected price (no cost shown to her)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true }); // the owner's inbox (v36: the owner no longer sells, so ask for him explicitly)
  const r = await asUser(page, 'Siti', '1111', 'save_product', { name: 'Siwak Arak Premium', category: 'Perlengkapan Ibadah', size: 'isi 12', unit: 'pak', retail_price: 120000, cost_price: 95000, from_goods_in: true });
  expect(r.review_request_id).toBeTruthy();
  expect((await asUser(page, 'Siti', '1111', 'save_product', { name: 'Siwak Lain', category: 'X', unit: 'pak', retail_price: 1000, from_goods_in: true })).message).toMatch(/Ukuran atau berat/);
  expect((await asUser(page, 'Siti', '1111', 'save_product', { name: 'Siwak Lain', category: 'X', size: '1', retail_price: 1000 })).error).toBe('FORBIDDEN');
  // the manager's view of the request has no supplier-invoice cost
  const lm = await asUser(page, 'Jihan', '2222', 'list_approvals', {});
  expect(JSON.parse(lm.approvals.find(a => a.request_id === r.review_request_id).payload).cost_price).toBeUndefined();
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'products');
  await page.fill('#pr-q', 'Siwak');
  await expect(page.locator('#view-products [data-new-check]')).toBeVisible();

  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${r.review_request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'product_new');
  await expect(card).toContainText('Siwak Arak Premium');
  await expect(card).toContainText('95.000'); // the owner sees the invoice cost
  await card.locator('[data-np-price="retail_price"]').fill('125000');
  await card.locator('[data-np-price="wholesale_price"]').fill('115000');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  const p = (await getDb(page)).products.find(x => x.name === 'Siwak Arak Premium');
  expect(p).toMatchObject({ retail_price: 125000, wholesale_price: 115000, review: '', active: true });
});
