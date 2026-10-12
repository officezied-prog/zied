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

// v39: when the server refuses a big group (the free plan's 50-query limit), the import goes on 15 rows at a time.
test('the CSV import finishes in groups of 15 when the server refuses 200 rows at once', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.evaluate(() => { window.__sizes = []; const o = window.api; window.api = (a, d, x) => { if (a === 'import_products') { window.__sizes.push(d.rows.length); if (d.rows.length > 15) return Promise.reject(new NetError('HTTP 500')); } return o(a, d, x); }; });
  const csv = '"Nama Produk","Barcode","Kategori","Satuan","Harga Modal","Harga Jual"\n' + Array.from({ length: 40 }, (_, i) => `"Produk Impor ${i}","IMP${1000 + i}","Food","pcs","1000","${1500 + i}"`).join('\n');
  await page.click('#nav [data-view="products"]');
  await page.click('[data-act="import-csv"]');
  await page.setInputFiles('#im-file', { name: 'produk.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(page.locator('#im-go')).toBeEnabled();
  await page.click('#im-go');
  await expect(page.locator('.toast.ok')).toContainText('40');
  expect(await page.evaluate(() => window.__sizes)).toEqual([40, 15, 15, 10]);
  const db = await getDb(page);
  expect(db.products.filter(p => /^IMP10/.test(p.sku)).length).toBe(40);
});
