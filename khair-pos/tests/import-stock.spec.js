// v39: products first, quantities later (owner's majoo list has no stock) → the quantities land on the shelf and sell.
const { test, expect } = require('@playwright/test');
const { login, getDb } = require('./helpers');

test('import without quantities, then only barcode + quantity: the stock is on the shelf; a product with warehouse stock keeps its shelf', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const r1 = await page.evaluate(() => api('import_products', { rows: [{ name: '7 Dates Susu Kurma', sku: '8997214730064', unit: 'pcs', cost_price: 5666, retail_price: 10000 }] }));
  expect(r1.created).toBe(1);
  let p = (await getDb(page)).products.find(x => x.sku === '8997214730064');
  expect([p.stock, p.shop_stock || 0]).toEqual([0, 0]);
  const db0 = await getDb(page);
  const wh = db0.products.find(x => num(x.stock) - (x.shop_stock ?? x.stock) > 0 && x.sku);
  const r2 = await page.evaluate(([w]) => api('import_products', { rows: [{ sku: '8997214730064', stock: 24 }].concat(w ? [{ sku: w.sku, stock: Number(w.stock) + 5 }] : []) }), [wh]);
  expect(r2.updated).toBeGreaterThan(0);
  const db = await getDb(page);
  p = db.products.find(x => x.sku === '8997214730064');
  expect([p.stock, p.shop_stock, p.retail_price]).toEqual([24, 24, 10000]);
  if (wh) expect(db.products.find(x => x.sku === wh.sku).shop_stock).toBe(wh.shop_stock); // shelf kept, the extra went to the warehouse
});
function num(v) { const x = Number(v); return isFinite(x) ? x : 0; }
