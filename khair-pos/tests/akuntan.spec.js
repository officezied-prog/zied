// v17 accountant (akuntan): read-only owner app — reports, history, goods in/out, customers, suppliers, returns, bank.
// Purchase prices only when the owner allows it; profit never; every write refused by the server (mock = same rules).
const { test, expect } = require('@playwright/test');
const { login, openApp, enterKey, typePin, getDb, nav, editDb, asUser, staffSession } = require('./helpers');

async function addAkuntan(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
}
async function loginRina(page) {
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555'); // through Khair Kasir
  await expect(page.locator('#app')).toBeVisible();
}

test('accountant: lands on reports, sees only the audit views, cannot change anything', async ({ page }) => {
  await addAkuntan(page);
  await loginRina(page);
  await expect(page.locator('#view-reports')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bro\b/);
  const views = await page.locator('#nav [data-view]').evaluateAll(b => b.map(x => x.dataset.view));
  expect(views.sort()).toEqual(['bank', 'cold', 'customers', 'history', 'purchases', 'reports', 'retur', 'settings', 'suppliers']); // cold = Gudang Dingin page (read-only there too)
  await page.evaluate(() => go('pos'));
  await expect(page.locator('#view-reports')).toBeVisible(); // POS is not reachable
  await nav(page, 'purchases');
  await expect(page.locator('#pu-sup')).toHaveCount(0); // no goods-in form
  await expect(page.locator('#pu-hist [data-act="pu-doc"]').first()).toBeVisible();
  await expect(page.locator('#pu-hist [data-act="pu-fix"]').first()).toBeHidden();
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.locator('#pu-hist [data-act="pu-doc"]').first().click();
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('#print-area')).not.toContainText('Harga beli'); // default: no purchase prices
  await nav(page, 'customers');
  await page.locator('[data-act="cust-open"]').filter({ hasText: 'Toko Berkah' }).click();
  await expect(page.locator('#cd-ledger #led-docs')).toBeVisible();
  await expect(page.locator('[data-act="cust-pay"]')).toBeHidden();
  await expect(page.locator('#cd-statement')).toBeVisible();
  await page.keyboard.press('Escape');
  for (const v of ['suppliers', 'retur', 'bank', 'history']) await nav(page, v);
  // the server refuses every write
  for (const [a, d] of [['save_sale', { items: [] }], ['receive_payment', { customer_id: 1, amount: 1 }], ['save_purchase', { supplier: 'X' }], ['save_settings', { settings: {} }], ['request_return', {}], ['list_approvals', {}]]) {
    expect((await asUser(page, 'Lestari', '5555', a, d)).error).toBe('FORBIDDEN');
  }
  const r = await asUser(page, 'Lestari', '5555', 'daily_report', { date: await page.evaluate(() => today()) });
  expect(r.report).toBeTruthy(); expect(r.report.profit).toBeUndefined();
});

test('owner allows purchase prices for the accountant; profit stays hidden; invoice due days saved', async ({ page }) => {
  await addAkuntan(page);
  const from = await page.evaluate(() => addDays(today(), -30)), to = await page.evaluate(() => today());
  let g = await asUser(page, 'Lestari', '5555', 'get_sales', { from, to });
  expect(g.purchases.length).toBeGreaterThan(0);
  expect(g.purchases.every(p => p.cost_price === undefined)).toBe(true);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await page.fill('#st-due-days', '200');
  await page.click('#st-save-inv');
  await expect(page.locator('#st-inv-err')).toHaveText('Isi 0–120 hari');
  await page.fill('#st-due-days', '30');
  await page.check('#st-ak-cost');
  await page.click('#st-save-inv');
  await expect(page.locator('.toast.ok')).toBeVisible();
  const db = await getDb(page);
  expect(db.settings).toMatchObject({ invoice_due_days: 30, akuntan_sees_cost: true });
  g = await asUser(page, 'Lestari', '5555', 'get_sales', { from, to });
  expect(g.purchases.some(p => p.cost_price > 0)).toBe(true);
  expect(g.sales.every(s => s.profit === undefined) && g.items.every(i => i.line_profit === undefined)).toBe(true);
  // the role can be given from the user list
  await expect(page.locator('#nu-role option[value="akuntan"]')).toHaveCount(1);
});
