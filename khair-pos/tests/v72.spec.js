// v72 (owner 2026-10-22) in the owner app:
//  1. «هناك خطاء في العملية الحسابية» — a pack set up with a content that does not match the names ("Garam Himalaya 1 kg" from "Garam Himalaya
//     25 Kg" as 1 karung) is red in the set-up list with a one-tap fix; «مباشرة التطبيق يبين لنا كم المفروض يكون هناك من علبة … ويكتب تحتها
//     مباشرة ثمن 1 كيلوغرام من المادة الأولية … يقسم 100,000 على 25»: as soon as the pack is chosen, 1 karung (25 kg) = 25 pcs and the raw
//     material in one pack (Rp 100.000 ÷ 25 = Rp 4.000) — for whoever sees costs.
//  2. The manager's note: "History of barang masuk only 30 days. We cannot search history barang masuk by supplier name or by range date,
//     for example search history from 12 agustus 2025-12 oktober 2025" — any period, a supplier / note search, the total, CSV.
const { test, expect } = require('@playwright/test');
const { login, getDb, nav, pick, editDb, jktToday } = require('./helpers');

const GARAM = `
  const nid = () => (db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1);
  if (db.products.some(p => p.sku === 'GH25')) return;
  const base = { category: 'Garam', wholesale_price: 0, wholesale_min_qty: 0, min_stock: 0, active: true, notes: '', supplier: '' };
  const b = Object.assign({ id: nid(), sku: 'GH25', name: 'Garam Himalaya 25 Kg', unit: 'karung', cost_price: 100000, retail_price: 0, stock: 12, shop_stock: 0, repack_from: 0, repack_qty: 0 }, base);
  db.products.push(b);
  db.products.push(Object.assign({ id: nid(), sku: 'GH1', name: 'Garam Himalaya 1 kg', unit: 'pcs', cost_price: 0, retail_price: 9000, stock: 0, shop_stock: 0, repack_from: b.id, repack_qty: 1 }, base));
`;
async function openRepackTab(page) {
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="repack"]');
  await expect(page.locator('#rp-form')).toBeVisible();
}

test('the wrong content is red with a one-tap fix; then 1 karung (25 kg) = 25 pcs, raw material Rp 100.000 ÷ 25 = Rp 4.000 a pack', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await editDb(page, GARAM);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await openRepackTab(page);
  const db0 = await getDb(page), bulk = db0.products.find(p => p.sku === 'GH25'), pack = db0.products.find(p => p.sku === 'GH1');
  const row = page.locator(`#rs-list tr[data-rs="${pack.id}"]`);
  await expect(row.locator('[data-size-wrong]')).toContainText('Isi kemasan salah: tercatat 1 karung per pcs, seharusnya 0,04 karung (1 kg)');
  await row.locator('[data-act="size-fix"]').click();
  await expect(page.locator(`#rs-list tr[data-rs="${pack.id}"]`)).toContainText('0,04 karung (1 kg) / pcs');
  await expect(page.locator(`#rs-list tr[data-rs="${pack.id}"] [data-size-wrong]`)).toHaveCount(0);
  expect((await getDb(page)).products.find(p => p.sku === 'GH1').repack_qty).toBe(0.04);
  // the repack form: the yield and the raw material's cost as soon as the pack is chosen
  await pick(page, 'rp-bulk', 'garam himalaya', bulk.id);
  await pick(page, 'rp-pack', 'garam himalaya 1', pack.id);
  const info = page.locator('#rp-pack-info');
  await expect(info.locator('[data-yield-per]')).toContainText('1 karung (25 kg) = 25 pcs');
  await expect(info.locator('[data-raw-cost]')).toContainText('Bahan baku per pcs (1 kg): Rp 4.000 = Rp 100.000 per karung ÷ 25');
  await page.fill('#rp-amount', '2');
  await expect(page.locator('#rp-calc')).toContainText('2 karung (50 kg) ÷ 1 kg');
  await expect(page.locator('#rp-planned')).toHaveAttribute('data-planned', '50');
  await expect(page.locator('#rp-raw-total')).toContainText('2 karung = Rp 200.000');
  await page.screenshot({ path: require('path').join(require('./helpers').SHOTS, 'desktop-repack-raw-cost.png') });
});

test('a new pack: "1 kg" typed is converted to 0,04 karung; a content that does not match the name is refused with the right one', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await editDb(page, GARAM + `db.products.find(p => p.sku === 'GH1').repack_from = 0; db.products.find(p => p.sku === 'GH1').repack_qty = 0;`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await openRepackTab(page);
  const db0 = await getDb(page), bulk = db0.products.find(p => p.sku === 'GH25'), pack = db0.products.find(p => p.sku === 'GH1');
  await pick(page, 'rp-bulk', 'garam himalaya', bulk.id);
  await page.locator('#rp-pack-q').fill('Garam Himalaya 1');
  await page.locator(`#rp-pack-list [data-pick="${pack.id}"]`).click();
  await expect(page.locator('#rpi-size')).toHaveValue('1 kg'); // from the name
  await expect(page.locator('#rpi-size-hint')).toContainText('= 0,04 karung (1 kg) per pcs · 1 karung = 25 pcs');
  await page.fill('#rpi-size', '1');
  await expect(page.locator('#rpi-size-hint')).toContainText('Tidak cocok dengan nama: Garam Himalaya 1 kg (1 kg) dari Garam Himalaya 25 Kg = 0,04 karung (1 kg) per pcs');
  await page.fill('#rp-amount', '2');
  await page.click('#rp-start');
  await expect(page.locator('#rp-err')).toContainText('Tidak cocok dengan nama');
  await page.fill('#rpi-size', '1000 gr');
  await expect(page.locator('#rp-planned')).toHaveAttribute('data-planned', '50');
  // the manager does not see costs (the owner's setting): no raw-material price
  await expect(page.locator('#rp-raw-total')).toHaveCount(0);
  await page.click('#rp-start');
  await expect(page.locator('#rp-res')).toContainText('rencana 50');
  expect((await getDb(page)).products.find(p => p.sku === 'GH1').repack_qty).toBe(0.04);
});

test('goods-in history: any period (12 Aug – 12 Oct 2025), a supplier search, the notes found with their total, CSV', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await editDb(page, `
    const p = db.products.filter(x => x.active !== false && !x.repack_from)[0];
    let id = Math.max(...db.purchases.map(r => r.id || 0)) + 1;
    const row = (d, no, sup, qty, cost) => ({ id: id++, purchase_date: d, purchase_no: no, supplier: sup, product_id: p.id, name: p.name, qty, cost_price: cost, total: qty * cost, user: 'Siti', photo_id: '', match_status: 'cocok' });
    db.purchases.push(row('2025-08-20', 'PB250820-OLD1', 'CV Sumber Makmur', 10, 20000), row('2025-09-15', 'PB250915-OLD2', 'PT.Saida Rezeki Abadi', 5, 30000),
      row('2025-10-01', 'PB251001-OLD3', 'CV Sumber Makmur', 2, 25000), row('2025-11-01', 'PB251101-OLD4', 'CV Sumber Makmur', 1, 10000));`);
  await nav(page, 'purchases');
  await expect(page.locator('#puh-sum')).toContainText(' – ');
  await expect(page.locator('#pu-hist tr[data-no="PB250820-OLD1"]')).toHaveCount(0); // the last 30 days at first
  await page.fill('#puh-from', '2025-08-12');
  await page.fill('#puh-to', '2025-10-12');
  await page.fill('#puh-q', 'sarah');
  await page.click('#puh-go');
  await expect(page.locator('#pu-hist tbody tr')).toHaveCount(2);
  await expect(page.locator('#pu-hist tr[data-no="PB250820-OLD1"]')).toBeVisible();
  await expect(page.locator('#pu-hist tr[data-no="PB251001-OLD3"]')).toBeVisible();
  await expect(page.locator('#puh-sum')).toContainText('2 nota · 12/08/2025 – 12/10/2025');
  await expect(page.locator('#puh-total')).toHaveText('Rp 250.000');
  // the whole period, then typing narrows the notes shown at once
  await page.fill('#puh-q', '');
  await page.click('#puh-go');
  for (const no of ['PB250820-OLD1', 'PB250915-OLD2', 'PB251001-OLD3']) await expect(page.locator(`#pu-hist tr[data-no="${no}"]`)).toBeVisible();
  await expect(page.locator('#pu-hist tr[data-no="PB251101-OLD4"]')).toHaveCount(0); // after the period
  await page.fill('#puh-q', 'saida');
  await expect(page.locator('#pu-hist tbody tr')).toHaveCount(1);
  await expect(page.locator('#pu-hist tr[data-no="PB250915-OLD2"]')).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.click('#puh-csv');
  expect((await dl).suggestedFilename()).toBe('barang-masuk-2025-08-12-2025-10-12.csv');
  // more than 400 days at once: refused with a clear message
  await page.fill('#puh-from', '2024-01-01');
  await page.click('#puh-go');
  await expect(page.locator('#puh-err')).toContainText('400 hari');
  await page.screenshot({ path: require('path').join(require('./helpers').SHOTS, 'desktop-goodsin-history-search.png') });
});
