// v12 Repacking in the shop: bulk → small packs, yield / loss / pack cost; product form fields; stock card rows.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, productByName, nav, asUser } = require('./helpers');

const fq = n => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(n);
async function openRepack(page) {
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="repack"]');
  await expect(page.locator('#rp-form')).toBeVisible();
}

test('owner repacks 5 kg of bulk dates into 9 × 500 g: preview, stock, weighted pack cost, history with low yield, stock card', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kurma Rabia Curah/), pack = productByName(db0, /Kurma Rabia Kemas 500/);
  expect(pack).toMatchObject({ repack_from: bulk.id, repack_qty: 0.5 });
  await openRepack(page);
  await expect(page.locator(`#rp-bulks [data-bulk="${bulk.id}"]`)).toContainText(bulk.name);
  await expect(page.locator(`#rp-bulks [data-bulk="${bulk.id}"] [data-pack]`)).toHaveCount(2);
  await page.locator(`#rp-bulks [data-pack="${pack.id}"] [data-act="rp-pick"]`).click();
  await expect(page.locator('#rp-to')).toHaveValue(String(pack.id));
  await expect(page.locator('#rp-bulk-stock')).toContainText(fq(bulk.stock));
  await page.fill('#rp-qty', '9');
  await page.fill('#rp-from', '5');
  await expect(page.locator('#rp-preview')).toHaveClass(/low/);
  await expect(page.locator('#rp-preview')).toContainText('seharusnya 10 kemasan');
  await expect(page.locator('#rp-preview [data-yield]')).toContainText('90,0%');
  await expect(page.locator('#rp-preview [data-loss]')).toContainText('susut 0,5 kg');
  await page.fill('#rp-cost', '4500');
  await page.fill('#rp-note', 'Uji kemas');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-repack.png') });
  await page.click('#rp-save');
  await expect(page.locator('#rp-res')).toBeVisible();
  const unitCost = Math.round((5 * bulk.cost_price + 4500) / 9);
  await expect(page.locator('#rp-res [data-unit-cost]')).toContainText(new Intl.NumberFormat('id-ID').format(unitCost));
  const db = await getDb(page);
  const b2 = productByName(db, /Kurma Rabia Curah/), p2 = productByName(db, /Kurma Rabia Kemas 500/);
  expect(b2.stock).toBe(Math.round((bulk.stock - 5) * 1000) / 1000);
  expect(p2.stock).toBe(pack.stock + 9);
  expect(p2.cost_price).toBe(Math.round((Math.max(0, pack.stock) * pack.cost_price + 9 * unitCost) / (Math.max(0, pack.stock) + 9)));
  const rp = db.repacks.slice(-1)[0];
  expect(rp).toMatchObject({ from_product_id: bulk.id, to_product_id: pack.id, from_qty: 5, to_qty: 9, expected_qty: 10, yield_pct: 90, loss_qty: 0.5, packaging_cost: 4500, unit_cost: unitCost, user: 'Pemilik' });
  const rows = db.purchases.filter(r => r.supplier === 'KEMAS ULANG' && r.note.includes(rp.repack_id));
  expect(rows.map(r => [r.product_id, r.qty])).toEqual([[bulk.id, -5], [pack.id, 9]]);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'kemas_ulang', level: 'warn', ref: rp.repack_id });
  // history: newest first, low yield highlighted; totals per product
  await expect(page.locator(`#rp-hist tr[data-rp="${rp.repack_id}"]`)).toHaveClass(/low/);
  await expect(page.locator(`#rp-hist tr[data-rp="${rp.repack_id}"] [data-yield]`)).toHaveText('90,0%');
  const mine = db.repacks.filter(r => r.to_product_id === pack.id && r.repack_date >= jktToday(-29));
  const avg = mine.reduce((a, r) => a + r.to_qty, 0) / mine.reduce((a, r) => a + r.expected_qty, 0) * 100;
  await expect(page.locator(`#rp-totals tr[data-pack="${pack.id}"] [data-avg]`)).toHaveText(new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(avg) + '%');
  // stock card of the bulk product shows the repack row
  await page.click('#gd-tabs [data-tab="list"]');
  await page.fill('#gd-q', 'rabia curah');
  await page.locator(`#gd-table tr[data-pid="${bulk.id}"]`).locator("td").first().click();
  await expect(page.locator('#gd-card-table tr[data-kind="repack"]').last()).toContainText('Kemas ulang');
  await expect(page.locator('#gd-card-table tr[data-kind="repack"]').last()).toContainText('5');
  await expect(page.locator('#gdc-end')).toContainText(fq(b2.stock));
});

test('manager can repack but never sees the pack cost; not enough bulk is refused', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kacang Mete Curah/), pack = productByName(db0, /Kacang Mete Arab/);
  await openRepack(page);
  await expect(page.locator('#rp-hist th')).not.toContainText(['Biaya kemasan']);
  await page.selectOption('#rp-to', String(pack.id));
  await page.fill('#rp-qty', '1000');
  await expect(page.locator('#rp-preview')).toHaveClass(/bad/);
  await page.click('#rp-save');
  await expect(page.locator('#rp-err')).toContainText('tidak cukup');
  await page.fill('#rp-qty', '4');
  await page.click('#rp-save');
  await expect(page.locator('#rp-res')).toBeVisible();
  await expect(page.locator('#rp-res [data-unit-cost]')).toHaveCount(0);
  const r = await asUser(page, 'Jihan', '2222', 'get_sales', { from: '2000-01-01', to: '2100-01-01' });
  expect(r.repacks.length).toBeGreaterThan(0);
  expect(r.repacks.some(x => 'unit_cost' in x || 'packaging_cost' in x)).toBe(false);
  expect((await getDb(page)).products.find(p => p.id === bulk.id).stock).toBe(Math.round((bulk.stock - 1) * 1000) / 1000);
  expect((await asUser(page, 'Siti', '1111', 'repack', { to_product_id: pack.id, to_qty: 1 })).error).toBe('FORBIDDEN');
});

test('product form: "Pemasok utama" and "Kemasan toko (kemas ulang)" are saved; phone + Arabic screenshot of Kemas ulang', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const bulk = productByName(await getDb(page), /Kurma Rabia Curah/);
  await nav(page, 'products');
  await page.click('[data-act="prod-new"]');
  await page.fill('#pf-name', 'Kurma Rabia Kemas 1 kg');
  await page.fill('#pf-supplier', 'PT Kurma Nusantara');
  await page.fill('#pf-retail_price', '65.000');
  await page.locator('#pf-repack-box summary').click();
  await page.selectOption('#pf-repack_from', String(bulk.id));
  await expect(page.locator('#pf-rq-unit')).toHaveText('kg');
  await page.click('#pf-save');
  await expect(page.locator('#pf-err')).toContainText('Isi per kemasan');
  await page.fill('#pf-repack_qty', '1');
  await page.click('#pf-save');
  await expect(page.locator('#pf')).toHaveCount(0);
  const p = productByName(await getDb(page), /Kurma Rabia Kemas 1 kg/);
  expect(p).toMatchObject({ supplier: 'PT Kurma Nusantara', repack_from: bulk.id, repack_qty: 1 });
  expect((await getDb(page)).activity.slice(-1)[0]).toMatchObject({ kind: 'produk_baru' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tb-lang');
  await openRepack(page);
  await expect(page.locator(`#rp-bulks [data-bulk="${bulk.id}"] [data-pack]`)).toHaveCount(3);
  await page.screenshot({ path: path.join(SHOTS, 'phone-repack-ar.png') });
});
