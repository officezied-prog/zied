// Cost price and profit never reach the screen of this app (the server strips them for non-owners;
// the app drops them even for the owner). Auto-lock after idle minutes.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
const COST_RE = /harga modal|harga pokok|\bHPP\b|\blaba\b|profit|margin|cost/i;
const visibleText = page => page.evaluate(() => [document.querySelector('#app'), document.querySelector('#modals')].map(e => e.innerText).join('\n'));

test('kasir never sees cost or profit (data, screens, receipts, approvals)', async ({ page }) => {
  await H.login(page);
  // the API answer itself carries no cost fields for a kasir
  const raw = await page.evaluate(async () => JSON.stringify(await api('bootstrap')) + JSON.stringify(await api('get_sales', { from: '2020-01-01', to: '2030-01-01' })));
  expect(raw).not.toMatch(/cost_price|total_cost|"profit"|line_profit/);
  expect(await page.evaluate(() => window.KASIR.S.products.some(p => 'cost_price' in p))).toBe(false);
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  expect(await visibleText(page)).not.toMatch(COST_RE);
  await page.click('#pay-ok');
  expect(await visibleText(page)).not.toMatch(COST_RE);
  await page.click('#rc-new');
  for (const v of ['masuk', 'kas', 'more']) { await H.tab(page, v); expect(await visibleText(page)).not.toMatch(COST_RE); }
  // cache on the device has no cost either
  expect(await page.evaluate(() => localStorage.getItem('kpos.mock.kasir.cache'))).not.toMatch(/cost_price/);
});

test('even the owner sees no cost price in the cashier app', async ({ page }) => {
  await H.login(page, 'Pemilik', '1234');
  const db = await H.getDb(page);
  const ajwa = H.productByName(db, /Ajwa/);
  expect(ajwa.cost_price).toBe(135000); // the owner's server data has it…
  expect(await page.evaluate(() => window.KASIR.S.products.some(p => 'cost_price' in p))).toBe(false); // …the app drops it
  const card = page.locator(`#grid .pc[data-id="${ajwa.id}"]`);
  await expect(card).not.toContainText('135.000');
  await page.click('#tb-appr');
  expect(await visibleText(page)).not.toMatch(COST_RE);
});

test('auto-lock after settings.auto_lock_minutes idle → PIN pad, cart kept', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, 'db.settings.auto_lock_minutes = 0.05;'); // 3 seconds
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await H.addItem(page, 'ajwa');
  await expect(page.locator('#pin-who')).toHaveText('Siti', { timeout: 15000 });
  await expect(page.locator('#login')).toContainText('terkunci');
  await H.typePin(page, '1111');
  await expect(page.locator('#paybar-total')).toHaveText(H.rp(175000));
  await expect(page.locator('#gate')).toBeHidden();
});

test('sales reps (Khair Sales accounts) are hidden here and cannot use the cashier app', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, `db.users.push({ name: 'Ahmad', role: 'sales', pin_hash: arg, active: true });`, H.sha('demo:ahmad:4444'));
  await page.reload();
  await H.enterKey(page);
  await expect(page.locator('[data-act="login-user"][data-name="Siti"]')).toBeVisible();
  await expect(page.locator('[data-act="login-user"][data-name="Ahmad"]')).toHaveCount(0);
  const r = await page.evaluate(async h => { try { await apiRaw('bootstrap', {}, { key: 'demo', user: 'Ahmad', pin_hash: h }); await apiRaw('save_sale', { items: [] }, { key: 'demo', user: 'Ahmad', pin_hash: h }); return 'ok'; } catch (e) { return e.code; } }, H.sha('demo:ahmad:4444'));
  expect(r).toBe('FORBIDDEN');
});
