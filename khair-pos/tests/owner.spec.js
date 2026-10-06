const { test, expect } = require('@playwright/test');
const { rp, pct, jktToday, login, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals } = require('./helpers');

test('owner voids a sale from history: status void, stock restored, debt reversed', async ({ page }) => {
  await login(page);
  const db0 = await getDb(page);
  const p = productByName(db0, /Sukkari/);
  const cust = db0.customers.find(c => c.name === 'Toko Al-Barokah Kramat Jati');
  await addBySearch(page, 'sukkari');
  await page.locator('.cline input[data-qty]').fill('3');
  await page.locator('.cline input[data-qty]').press('Enter');
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Al-Barokah' }).click();
  await page.click('[data-act="method"][data-m="hutang"]');
  await checkoutSkip(page);
  const inv = (await page.locator('.modal #receipt').innerText()).match(/KM\d{6}-\d{4}/)[0];
  await closeModals(page);
  let db = await getDb(page);
  expect(productByName(db, /Sukkari/).stock).toBe(p.stock - 3);
  expect(db.customers.find(c => c.id === cust.id).debt_balance).toBe(cust.debt_balance + 3 * p.wholesale_price);

  await nav(page, 'history');
  await page.locator(`[data-act="hist-open"][data-inv="${inv}"]`).click();
  await expect(page.locator('.modal #receipt')).toContainText(inv);
  await page.click('[data-act="void-sale"]');
  await page.click('#cf-ok');
  await expect(page.locator('#cf-err')).toHaveText('Wajib diisi');
  await page.fill('#cf-in', 'Salah input qty');
  await page.click('#cf-ok');
  await expect(page.locator('.toast.ok')).toContainText(inv);

  db = await getDb(page);
  const s = db.sales.find(x => x.invoice_no === inv);
  expect(s.status).toBe('void');
  expect(s.void_reason).toBe('Salah input qty');
  expect(productByName(db, /Sukkari/).stock).toBe(p.stock);
  expect(db.customers.find(c => c.id === cust.id).debt_balance).toBe(cust.debt_balance);
  await expect(page.locator(`#hist-table tr.void[data-inv="${inv}"]`)).toBeVisible();
});

test('purchase (barang masuk) updates stock and weighted average cost; stock adjustment is excluded from purchase totals', async ({ page }) => {
  await login(page);
  const p = productByName(await getDb(page), /Medjool/);
  await nav(page, 'purchases');
  await page.fill('#pu-sup', 'PT Kurma Nusantara');
  await page.fill('#pu-q', 'medjool');
  await page.locator('[data-act="pu-add"]').first().click();
  await page.locator('[data-pu-qty="0"]').fill('10');
  await page.locator('[data-pu-cost="0"]').fill('175.000');
  await expect(page.locator('#pu-total')).toHaveText(rp(1750000));
  await page.click('#pu-save');
  await expect(page.locator('#pu-res')).toBeVisible();

  const expectedCost = Math.round((p.stock * p.cost_price + 10 * 175000) / (p.stock + 10));
  const db = await getDb(page);
  const after = productByName(db, /Medjool/);
  expect(after.stock).toBe(p.stock + 10);
  expect(after.cost_price).toBe(expectedCost);
  expect(db.purchases.slice(-1)[0]).toMatchObject({ supplier: 'PT Kurma Nusantara', product_id: p.id, qty: 10, cost_price: 175000, total: 1750000, user: 'Pemilik' });
  await expect(page.locator(`[data-newcost="${p.id}"]`)).toContainText(rp(expectedCost));

  // stock opname: writes a 'PENYESUAIAN STOK' purchase row with qty = difference, total 0
  await nav(page, 'products');
  await page.fill('#pr-q', 'medjool');
  await expect(page.locator('#prod-table tbody tr')).toHaveCount(1);
  await page.locator('#prod-table [data-act="stock-adj"]').first().click();
  await expect(page.locator('.modal')).toContainText(p.name);
  await page.fill('#sa-new', String(after.stock - 2));
  await page.click('#sa-save');
  await expect(page.locator('#sa-save')).toHaveCount(0);
  await expect.poll(async () => productByName(await getDb(page), /Medjool/).stock).toBe(after.stock - 2);
  const db2 = await getDb(page);
  expect(db2.purchases.slice(-1)[0]).toMatchObject({ supplier: 'PENYESUAIAN STOK', qty: -2, total: 0 });

  await nav(page, 'reports');
  const todays = db2.purchases.filter(x => x.purchase_date === jktToday() && x.supplier !== 'PENYESUAIAN STOK');
  await expect(page.locator('[data-kpi="purchases"] .v')).toHaveText(rp(todays.reduce((a, x) => a + x.total, 0)));
  await expect(page.locator('[data-kpi="purchases"] .s')).toContainText('1 penyesuaian stok');
});

test('kasir never receives or sees cost / profit', async ({ page }) => {
  await login(page, 'Siti', '1111');
  expect(await page.evaluate(() => KPOS.S.products.some(p => 'cost_price' in p))).toBe(false);

  await nav(page, 'products');
  await expect(page.locator('#prod-table')).toBeVisible();
  await expect(page.locator('#prod-table th[data-col="cost"]')).toHaveCount(0);
  await expect(page.locator('#prod-table thead')).not.toContainText('Modal');
  await expect(page.locator('[data-act="prod-new"]')).toHaveCount(0);
  await expect(page.locator('[data-act="import-csv"]')).toHaveCount(0);

  const leaked = await page.evaluate(async () => {
    const T = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    const r = await api('get_sales', { from: '2000-01-01', to: T });
    const bad = ['cost_price', 'total_cost', 'profit', 'line_profit', 'cost'];
    const rows = [...r.sales, ...r.items, ...r.purchases];
    const pr = await api('save_purchase', { purchase_date: T, supplier: 'x', items: [{ product_id: 1, qty: 1, cost_price: 100 }] });
    let forbidden = '';
    try { await api('void_sale', { invoice_no: r.sales[0].invoice_no, reason: 'x' }); } catch (e) { forbidden = e.code; }
    return { n: rows.length, leaked: rows.filter(x => bad.some(k => k in x)).length, purchaseLeak: pr.stock.some(s => 'cost_price' in s), forbidden };
  });
  expect(leaked.n).toBeGreaterThan(100);
  expect(leaked.leaked).toBe(0);
  expect(leaked.purchaseLeak).toBe(false);
  expect(leaked.forbidden).toBe('FORBIDDEN');

  await nav(page, 'reports');
  await expect(page.locator('[data-kpi="omzet"]')).toBeVisible();
  await expect(page.locator('[data-kpi="laba"]')).toHaveCount(0);
  await expect(page.locator('[data-kpi="margin"]')).toHaveCount(0);
  await expect(page.locator('#view-reports')).not.toContainText('Laba');
  const db = await getDb(page);
  const ok = db.sales.filter(s => s.sale_date === jktToday() && s.status !== 'void');
  await expect(page.locator('[data-kpi="omzet"] .v')).toHaveText(rp(ok.reduce((a, s) => a + s.total, 0)));
  await expect(page.locator('[data-kpi="count"] .v')).toHaveText(String(ok.length));
});

async function expectReportMatches(page, from, to) {
  const db = await getDb(page);
  const inR = d => d >= from && d <= to;
  const ok = db.sales.filter(s => inR(s.sale_date) && s.status !== 'void');
  const omzet = ok.reduce((a, s) => a + s.total, 0);
  const laba = ok.reduce((a, s) => a + s.profit, 0);
  const inv = new Set(ok.map(s => s.invoice_no));
  const items = db.items.filter(i => inv.has(i.invoice_no));
  const grosir = items.filter(i => i.price_type === 'grosir').reduce((a, i) => a + i.line_total, 0);
  const purchases = db.purchases.filter(p => inR(p.purchase_date) && p.supplier !== 'PENYESUAIAN STOK').reduce((a, p) => a + p.total, 0);
  const paymentsIn = db.payments.filter(p => inR(p.pay_date)).reduce((a, p) => a + p.amount, 0);
  const newDebt = ok.reduce((a, s) => a + s.debt_amount, 0);
  const receivable = db.customers.reduce((a, c) => a + c.debt_balance, 0);
  expect(ok.length).toBeGreaterThan(0);
  await expect(page.locator('[data-kpi="omzet"] .v')).toHaveText(rp(omzet));
  await expect(page.locator('[data-kpi="laba"] .v')).toHaveText(rp(laba));
  await expect(page.locator('[data-kpi="margin"] .v')).toHaveText(pct(laba / omzet * 100));
  await expect(page.locator('[data-kpi="count"] .v')).toHaveText(new Intl.NumberFormat('id-ID').format(ok.length));
  await expect(page.locator('[data-kpi="avg"] .v')).toHaveText(rp(Math.round(omzet / ok.length)));
  await expect(page.locator('[data-kpi="purchases"] .v')).toHaveText(rp(purchases));
  await expect(page.locator('[data-kpi="payments"] .v')).toHaveText(rp(paymentsIn));
  await expect(page.locator('[data-kpi="newdebt"] .v')).toHaveText(rp(newDebt));
  await expect(page.locator('[data-kpi="receivable"] .v')).toHaveText(rp(receivable));
  await expect(page.locator('#rp-split')).toContainText(rp(grosir));
  // top product by omzet
  const agg = {};
  items.forEach(i => { agg[i.name] = (agg[i.name] || 0) + i.line_total; });
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1])[0];
  await expect(page.locator('#rp-top-omzet tbody tr').first()).toContainText(top[0]);
  await expect(page.locator('#rp-top-omzet tbody tr').first()).toContainText(rp(top[1]));
  return { omzet, laba };
}

test('reports: omzet, laba, margin and other KPIs equal the sums of the mock data', async ({ page }) => {
  await login(page);
  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="7d"]');
  await expectReportMatches(page, jktToday(-6), jktToday());

  // custom range
  const from = jktToday(-25), to = jktToday(-11);
  await page.fill('#rp-from', from);
  await page.fill('#rp-to', to);
  const { omzet } = await expectReportMatches(page, from, to);
  expect(omzet).toBeGreaterThan(1000000);
  await expect(page.locator('#rp-sources .bar-row').first()).toBeVisible();
  await expect(page.locator('.chart svg rect').first()).toBeAttached();

  // monthly WhatsApp text
  await page.click('[data-act="rep-copy"][data-kind="month"]');
  await expect(page.locator('.toast.ok')).toHaveText('Tersalin');
  const txt = await page.evaluate(() => navigator.clipboard.readText());
  expect(txt).toContain('*Laporan Bulanan Khair Mart*');
  expect(txt).toMatch(/Omzet: \*Rp [\d.]+\*/);
  expect(txt).toContain('Top 5 produk');
  expect(txt).toContain('Piutang pelanggan');
});

test('CSV import (majoo style): BOM, semicolons, quotes, Rupiah formats, upsert by SKU', async ({ page }) => {
  await login(page);
  const db0 = await getDb(page);
  const ajwa = productByName(db0, /Ajwa/);
  const csv = '﻿' + [
    'Nama Produk;SKU;Kategori;Satuan;Harga Modal;Harga Jual;Harga Grosir;Min Grosir;Stok',
    '"Kurma Sagai; Premium 1 kg";8990001112223;Kurma;kg;"Rp 98.000";"Rp 125.000";115.000;5;12',
    'Madu Yaman Sidr 250 g;8990001112224;Madu;botol;180000;250000;;;"3"',
    `"${ajwa.name}";${ajwa.sku};Kurma;kg;140.000;179.000;165.000;5;40`
  ].join('\r\n');
  await nav(page, 'products');
  await page.click('[data-act="import-csv"]');
  await page.setInputFiles('#im-file', { name: 'majoo-produk.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(page.locator('#im-prev tbody tr')).toHaveCount(3);
  await expect(page.locator('#im-m-retail_price')).toHaveValue('5');
  await expect(page.locator('#im-m-cost_price')).toHaveValue('4');
  await expect(page.locator('#im-m-sku')).toHaveValue('1');
  await expect(page.locator('#im-prev tbody tr').first()).toContainText('Kurma Sagai; Premium 1 kg');
  await expect(page.locator('#im-prev tbody tr').first()).toContainText(rp(125000));
  await page.click('#im-go');
  await expect(page.locator('.toast.ok')).toContainText('2 baru, 1 diperbarui');

  const db = await getDb(page);
  expect(productByName(db, /Sagai/)).toMatchObject({ sku: '8990001112223', category: 'Kurma', unit: 'kg', cost_price: 98000, retail_price: 125000, wholesale_price: 115000, wholesale_min_qty: 5, stock: 12, active: true });
  expect(productByName(db, /Madu Yaman/)).toMatchObject({ retail_price: 250000, wholesale_price: 0, stock: 3 });
  expect(productByName(db, /Ajwa/)).toMatchObject({ id: ajwa.id, cost_price: 140000, retail_price: 179000 });
  expect(db.products.length).toBe(db0.products.length + 2);
  await expect(page.locator('#prod-table')).toContainText('Madu Yaman Sidr');

  // parser edge cases: comma separator, escaped quotes, English headers
  const r = await page.evaluate(() => {
    const p = KPOS.parseCSV('Product Name,Barcode,Price,Cost,Qty\n"Teh ""Spesial"", 100g",123,"12,500",9.000,"1,5"\n');
    return { rows: p.rows, map: KPOS.guessMapping(p.rows[0]), n: [KPOS.parseNum('Rp 12.500'), KPOS.parseNum('12,500.50'), KPOS.parseNum('1,5'), KPOS.parseNum('1.250.000')] };
  });
  expect(r.rows[1][0]).toBe('Teh "Spesial", 100g');
  expect(r.map).toMatchObject({ name: 0, sku: 1, retail_price: 2, cost_price: 3, stock: 4 });
  expect(r.n).toEqual([12500, 12500.5, 1.5, 1250000]);
});
