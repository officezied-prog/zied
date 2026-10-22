// v52 (owner 2026-10-15: «أريد منك تضع في التطبيق زر لبعض البضائع المعروضة بالجملة ويأخذ الزبون كما يشاء الكمية مثل الشوكولاتة الزبيب اللوز
// بعض التمور»): the owner or the manager marks the goods shown loose in Produk ("⚖ Curah", per kg / gram / ons only); the cashier then
// types the grams (see tests-kasir/loose.spec.js).
const { test, expect } = require('@playwright/test');
const { login, getDb, productByName, nav } = require('./helpers');

test('the manager marks a per-kg product as loose in Produk (and back); per-piece goods have no button; the form refuses loose + pcs', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const kg = db0.products.find(p => p.unit === 'kg' && p.active !== false), pcs = db0.products.find(p => p.unit === 'pcs' && p.active !== false);
  await nav(page, 'products');
  await page.fill('#pr-q', kg.name);
  const btn = page.locator(`#prod-table tr[data-pid="${kg.id}"] [data-act="loose-toggle"]`);
  await expect(btn).toHaveText('⚖ Curah');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(page.locator('.toast.ok', { hasText: 'dijual curah' })).toBeVisible();
  await expect.poll(async () => (await getDb(page)).products.find(p => p.id === kg.id).loose).toBe(true);
  await expect(page.locator(`#prod-table tr[data-pid="${kg.id}"] [data-act="loose-toggle"]`)).toHaveAttribute('aria-pressed', 'true');
  expect((await getDb(page)).activity.some(a => a.kind === 'atur_curah' && /Dijual curah .* oleh manajer Jihan/.test(a.summary))).toBe(true);
  await page.locator(`#prod-table tr[data-pid="${kg.id}"] [data-act="loose-toggle"]`).click();
  await expect.poll(async () => (await getDb(page)).products.find(p => p.id === kg.id).loose).toBe(false);
  await page.fill('#pr-q', pcs.name);
  await expect(page.locator(`#prod-table tr[data-pid="${pcs.id}"]`)).toBeVisible();
  await expect(page.locator(`#prod-table tr[data-pid="${pcs.id}"] [data-act="loose-toggle"]`)).toHaveCount(0);
  // a new product: loose with a per-piece unit is refused, with kg it is saved loose
  await page.click('[data-act="prod-new"]');
  await page.fill('#pf-name', 'Kismis Curah Test');
  await page.check('#pf-rp-no'); // v73: can it be repacked? — answered
  await page.fill('#pf-unit', 'pcs');
  await page.fill('#pf-retail_price', '90000');
  await page.check('#pf-loose');
  await page.click('#pf-save');
  await expect(page.locator('#pf-err')).toHaveText('Barang curah: satuannya harus kg / gram / ons');
  await page.fill('#pf-unit', 'kg');
  await page.click('#pf-save');
  await expect.poll(async () => { const p = (await getDb(page)).products.find(x => x.name === 'Kismis Curah Test'); return p && p.loose; }).toBe(true);
});
