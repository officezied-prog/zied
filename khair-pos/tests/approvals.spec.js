// Credit (hutang) approval. Since v7 cashiers use the separate cashier app, so the kasir side is
// driven through the API as Siti (exactly what the cashier app sends) and the owner/manager side
// through this app's Persetujuan inbox.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, nav, addBySearch, closeModals, asUser } = require('./helpers');

async function sitiDebtSale(page, extra = {}) {
  const db = await getDb(page);
  const cust = db.customers.find(c => c.name === 'Warung Bu Halimah');
  const p = db.products.find(x => /Kismis Hijau/.test(x.name));
  return { cust, p, sale: Object.assign({ client_id: 'test-' + Math.random().toString(36).slice(2), sale_date: new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10), customer_id: cust.id, customer_name: cust.name, customer_type: cust.type, items: [{ product_id: p.id, qty: 1, unit_price: p.wholesale_price, price_type: 'grosir' }], discount: 0, payment_method: 'hutang', paid_amount: 0 }, extra) };
}

test('kasir debt sale is refused without approval; on-site approval needs a valid owner/manager PIN', async ({ page }) => {
  await login(page);
  expect((await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 500000 })).shift.cashier).toBe('Siti');
  const { cust, sale } = await sitiDebtSale(page);
  expect((await asUser(page, 'Siti', '1111', 'save_sale', sale)).error).toBe('APPROVAL_REQUIRED');
  const badPin = await page.evaluate(() => KPOS.pinHash('demo', 'Jihan', '9999'));
  expect((await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, sale, { approver: { user: 'Jihan', pin_hash: badPin } }))).error).toBe('APPROVAL_REQUIRED');
  const notApprover = await page.evaluate(() => KPOS.pinHash('demo', 'Rina', '3333'));
  expect((await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, sale, { approver: { user: 'Rina', pin_hash: notApprover } }))).error).toBe('APPROVAL_REQUIRED');
  const okPin = await page.evaluate(() => KPOS.pinHash('demo', 'Jihan', '2222'));
  const r = await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, sale, { approver: { user: 'Jihan', pin_hash: okPin } }));
  expect(r.sale).toMatchObject({ cashier: 'Siti', approved_by: 'Jihan', payment_method: 'hutang' });
  const db = await getDb(page);
  expect(db.customers.find(c => c.id === cust.id).debt_balance).toBe(cust.debt_balance + r.sale.debt_amount);
});

test('remote request → owner approves in the inbox → kasir saves with approval_id; receipt/history show the approver', async ({ page }) => {
  await login(page);
  await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 500000 });
  const { sale } = await sitiDebtSale(page);
  const req = await asUser(page, 'Siti', '1111', 'request_credit', sale);
  expect(req.request_id).toMatch(/^APR-\d+/);
  expect((await asUser(page, 'Siti', '1111', 'check_approval', { request_id: req.request_id })).approval.status).toBe('pending');

  await nav(page, 'approvals');
  await page.click('[data-act="apr-refresh"]');
  const card = page.locator(`.apr-card[data-req="${req.request_id}"]`);
  await expect(card).toContainText('Warung Bu Halimah');
  await expect(card).toContainText('Siti');
  await expect(page.locator('#tb-appr b')).toHaveText(String((await getDb(page)).approvals.filter(a => a.status === 'pending').length));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approvals-inbox.png') });
  await card.locator('[data-d="approved"]').click();
  await expect(page.locator('.toast.ok').filter({ hasText: req.request_id })).toBeVisible();

  const chk = await asUser(page, 'Siti', '1111', 'check_approval', { request_id: req.request_id });
  expect(chk.approval).toMatchObject({ status: 'approved', decided_by: 'Pemilik' });
  // a different client_id may not reuse the approval
  expect((await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, sale, { client_id: 'other', approval_id: req.request_id }))).error).toBe('APPROVAL_REQUIRED');
  const r = await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, sale, { approval_id: req.request_id }));
  expect(r.sale.approved_by).toBe('Pemilik');
  expect((await getDb(page)).approvals.find(a => a.request_id === req.request_id).status).toBe('used');

  await nav(page, 'history');
  await page.click('[data-act="hist-load"]');
  await page.locator(`[data-act="hist-open"][data-inv="${r.invoice_no}"]`).first().click();
  await expect(page.locator('.modal #receipt')).toContainText('Disetujui');
  await expect(page.locator('.modal #receipt')).toContainText('Pemilik');
});

test('manager rejects a remote request with a note; the kasir sees it and nothing is saved', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 500000 });
  const before = (await getDb(page)).sales.length;
  const { sale } = await sitiDebtSale(page);
  const req = await asUser(page, 'Siti', '1111', 'request_credit', sale);
  await nav(page, 'approvals');
  await page.click('[data-act="apr-refresh"]');
  const card = page.locator(`.apr-card[data-req="${req.request_id}"]`);
  await card.locator('[data-note]').fill('Hutang lama belum lunas');
  await page.waitForTimeout(300);
  await card.locator('[data-d="rejected"]').click();
  await expect(page.locator('.toast.warn').filter({ hasText: 'ditolak' })).toContainText(req.request_id);
  const chk = await asUser(page, 'Siti', '1111', 'check_approval', { request_id: req.request_id });
  expect(chk.approval).toMatchObject({ status: 'rejected', decided_by: 'Jihan', note: 'Hutang lama belum lunas' });
  expect((await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, sale, { approval_id: req.request_id }))).error).toBe('APPROVAL_REQUIRED');
  expect((await getDb(page)).sales.length).toBe(before);
});

test('owner/manager selling on credit need no extra step; manager never sees cost', async ({ page }) => {
  await login(page, 'Jihan', '2222');
  await expect(page.locator('#tb-role')).toHaveText('Manajer');
  await expect(page.locator('#tb-appr')).toBeVisible();
  expect(await page.evaluate(() => KPOS.S.products.some(p => 'cost_price' in p))).toBe(false);
  await addBySearch(page, 'kismis hijau');
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).click();
  await page.click('[data-act="method"][data-m="hutang"]');
  await page.click('#btn-checkout');
  await expect(page.locator('.modal #receipt')).toBeVisible();
  await expect(page.locator('#apr-step')).toHaveCount(0);
  expect((await getDb(page)).sales.slice(-1)[0]).toMatchObject({ cashier: 'Jihan', approved_by: 'Jihan' });
  await closeModals(page);

  await nav(page, 'products');
  await expect(page.locator('#prod-table th[data-col="cost"]')).toHaveCount(0);
  await nav(page, 'reports');
  await expect(page.locator('[data-kpi="laba"]')).toHaveCount(0);
  const leak = await page.evaluate(async () => {
    const r = await api('get_sales', { from: '2026-01-01', to: '2030-01-01' });
    return [...r.sales, ...r.items].filter(x => 'profit' in x || 'cost_price' in x || 'total_cost' in x || 'line_profit' in x).length;
  });
  expect(leak).toBe(0);
});
