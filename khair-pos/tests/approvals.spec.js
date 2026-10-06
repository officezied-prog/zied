// Credit (hutang) approval: kasir needs owner/manager approval, on-site PIN or remote request.
// The mock backend lives in each browser context's localStorage; copyDb() plays the role of the
// shared server between the cashier's device and the owner's device.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { rp, SHOTS, login, getDb, nav, addBySearch, closeModals } = require('./helpers');

const copyDb = async (from, to) => { const raw = await from.evaluate(() => localStorage.getItem('kmock.db')); await to.evaluate(r => localStorage.setItem('kmock.db', r), raw); };

async function debtCart(page, customer = 'Warung Bu Halimah') {
  await addBySearch(page, 'kismis hijau');
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: customer }).click();
  await page.click('[data-act="method"][data-m="hutang"]');
  await page.click('#btn-checkout');
  await page.click('#sv-skip');
  await expect(page.locator('#apr-step')).toBeVisible();
}

test('kasir: a debt sale is refused without approval', async ({ page }) => {
  await login(page, 'Siti', '1111');
  const before = (await getDb(page)).sales.length;
  await debtCart(page);
  await expect(page.locator('#apr-step')).toContainText('Butuh persetujuan hutang');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approval-step.png') });
  await closeModals(page);
  expect((await getDb(page)).sales.length).toBe(before);
  await expect(page.locator('.cline')).toHaveCount(1);
  const code = await page.evaluate(async () => {
    try { await api('save_sale', { client_id: 'x-' + Date.now(), customer_id: 2, items: [{ product_id: 7, qty: 1, unit_price: 86000, price_type: 'grosir' }], payment_method: 'hutang', paid_amount: 0 }); return 'saved'; }
    catch (e) { return e.code; }
  });
  expect(code).toBe('APPROVAL_REQUIRED');
});

test('kasir: on-site approval with the manager PIN (Jihan) saves the debt sale', async ({ page }) => {
  await login(page, 'Siti', '1111');
  const db0 = await getDb(page);
  const cust = db0.customers.find(c => c.name === 'Warung Bu Halimah');
  await debtCart(page);
  await page.click('#ap-here');
  await page.click('#ap-users [data-n="Jihan"]');
  await page.fill('#ap-pin', '9999');
  await page.click('#ap-ok');
  await expect(page.locator('#ap-err')).toContainText('PIN penyetuju salah');
  await page.fill('#ap-pin', '2222');
  await page.click('#ap-ok');
  const rc = page.locator('.modal #receipt');
  await expect(rc).toBeVisible();
  await expect(rc).toContainText('Disetujui');
  await expect(rc).toContainText('Jihan');
  await expect(page.locator('#apr-step')).toHaveCount(0);
  const db = await getDb(page);
  const sale = db.sales.slice(-1)[0];
  expect(sale).toMatchObject({ cashier: 'Siti', approved_by: 'Jihan', payment_method: 'hutang', customer_id: cust.id });
  expect(db.customers.find(c => c.id === cust.id).debt_balance).toBe(cust.debt_balance + sale.debt_amount);
});

test('kasir: remote approval request → owner approves on another device → sale completes', async ({ page, browser }) => {
  await login(page, 'Siti', '1111');
  await debtCart(page);
  await page.click('#ap-remote');
  await expect(page.locator('#apr-wait')).toBeVisible();
  const rid = (await page.locator('#aw-id').innerText()).trim();
  expect(rid).toMatch(/^APR-\d+/);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approval-waiting.png') });
  const clientId = await page.evaluate(() => KPOS.S.cart.client_id);

  const ownerCtx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' });
  const owner = await ownerCtx.newPage();
  await login(owner);
  await copyDb(page, owner);
  await nav(owner, 'approvals');
  await owner.click('[data-act="apr-refresh"]');
  const card = owner.locator(`.apr-card[data-req="${rid}"]`);
  await expect(card).toContainText('Warung Bu Halimah');
  await expect(card).toContainText('Siti');
  await expect(owner.locator('#tb-appr b')).toHaveText('1');
  await owner.screenshot({ path: path.join(SHOTS, 'desktop-approvals-inbox.png') });
  await card.locator('[data-d="approved"]').click();
  await expect(owner.locator('.toast.ok')).toContainText(rid);
  await copyDb(owner, page);
  await ownerCtx.close();

  await expect(page.locator('.modal #receipt')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.modal #receipt')).toContainText('Pemilik');
  const db = await getDb(page);
  const sale = db.sales.find(s => s.client_id === clientId);
  expect(sale).toMatchObject({ approved_by: 'Pemilik', cashier: 'Siti' });
  expect(db.approvals.find(a => a.request_id === rid).status).toBe('used');
});

test('kasir: remote approval rejected → note shown, cart kept, nothing saved', async ({ page, browser }) => {
  await login(page, 'Siti', '1111');
  const before = (await getDb(page)).sales.length;
  await debtCart(page, 'Toko Berkah Condet');
  await page.click('#ap-remote');
  const rid = (await page.locator('#aw-id').innerText()).trim();

  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const mgr = await ctx.newPage();
  await login(mgr, 'Jihan', '2222');
  await copyDb(page, mgr);
  await nav(mgr, 'approvals');
  await mgr.click('[data-act="apr-refresh"]');
  const card = mgr.locator(`.apr-card[data-req="${rid}"]`);
  await card.locator('[data-note]').fill('Hutang lama belum lunas');
  await card.locator('[data-d="rejected"]').click();
  await expect(mgr.locator('.toast.warn').filter({ hasText: 'ditolak' })).toContainText(rid);
  await copyDb(mgr, page);
  await ctx.close();

  await expect(page.locator('#aw-note')).toContainText('Hutang lama belum lunas', { timeout: 15000 });
  await expect(page.locator('#apr-wait')).toContainText('Ditolak oleh Jihan');
  await page.click('#aw-back');
  await expect(page.locator('.cline')).toHaveCount(1);
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
  await page.click('#sv-skip');
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
