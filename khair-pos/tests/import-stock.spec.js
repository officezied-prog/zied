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

// v44 (owner 2026-10-13: «خيار إضافة الأصناف غير الموجودة فقط»): by default the import adds only what the app does not have;
// a product the staff entered by hand (same barcode or same name) keeps its price, stock and name.
test('import "only products not in the app yet" (default): hand-entered products stay exactly as they are', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db0 = await getDb(page);
  const bySku = db0.products.find(x => x.sku && num(x.stock) > 0), byName = db0.products.find(x => x !== bySku && x.name && num(x.retail_price) > 0);
  const csv = '"Nama Produk","Barcode","Kategori","Satuan","Harga Modal","Harga Jual","Stok"\n' +
    `"Nama Lain Dari Majoo","${bySku.sku}","Food","pcs","1","2","999"\n` +
    `"${byName.name}","","Food","pcs","1","2","999"\n` +
    '"Produk Baru Dari Majoo","NEW-777","Food","pcs","1000","1500",""\n';
  await page.click('#nav [data-view="products"]');
  await page.click('[data-act="import-csv"]');
  await expect(page.locator('#im-only-new-l')).toContainText('Hanya tambah produk yang belum ada');
  await page.setInputFiles('#im-file', { name: 'majoo.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await page.click('#im-go');
  await expect(page.locator('.toast.ok')).toContainText('1 produk baru ditambahkan, 2 dilewati');
  const db = await getDb(page);
  const a = db.products.find(x => x.id === bySku.id), b = db.products.find(x => x.id === byName.id);
  expect([a.name, a.retail_price, a.stock]).toEqual([bySku.name, bySku.retail_price, bySku.stock]);
  expect([b.retail_price, b.stock]).toEqual([byName.retail_price, byName.stock]);
  expect(db.products.find(x => x.sku === 'NEW-777')).toMatchObject({ name: 'Produk Baru Dari Majoo', retail_price: 1500, stock: 0 });
  expect(db.products.length).toBe(db0.products.length + 1);
});

