// v48 (owner 2026-10-14: «في بعض الأحيان نقوم بتعبية منتج جديد مثلا نختار عبوة جديدة و ستيكر جديد … واجعل ايضا هناك مصاريف للتعبية
// مثلا اختيار الستيكر الغطاء كثير اشياء فاجعل للمدير له خانات يمكن ان يضيفها للتكلفة التعبية»): in Gudang → Kemas ulang the manager
// makes a NEW pack product (new jar + sticker) and lists its materials with their cost per pack; every repack adds them to the cost.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, productByName, nav } = require('./helpers');

async function openRepackTab(page) {
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="repack"]');
  await expect(page.locator('#rp-form')).toBeVisible();
}
async function addMaterial(page, name, cost) {
  await page.click('#rs-cost-add');
  const row = page.locator('#rs-costs .rs-c-row').last();
  await row.locator('.rs-c-name').fill(name);
  await row.locator('.rs-c-cost').fill(cost);
  await row.locator('.rs-c-cost').blur();
}

test('the manager makes a NEW pack with its materials; a repack adds the materials × packs to the cost', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const bulk = productByName(await getDb(page), /Gula Pasir/);
  await openRepackTab(page);
  await page.selectOption('#rs-pack', '__new');
  await expect(page.locator('#rs-new')).toBeVisible();
  await page.selectOption('#rs-bulk', String(bulk.id));
  await page.fill('#rs-qty', '0,25');
  // name / price missing → refused in the form
  await page.click('#rs-save');
  await expect(page.locator('#rs-err')).toContainText('nama dan harga jual');
  await page.fill('#rs-n-name', 'Gula Pasir Pouch 250 g');
  await page.fill('#rs-n-price', '6000');
  await page.fill('#rs-n-unit', 'pouch');
  await page.fill('#rs-n-sku', 'GP250POUCH');
  await addMaterial(page, 'Pouch', '1200');
  await addMaterial(page, 'Stiker', '300');
  await expect(page.locator('#rs-cost-total')).toHaveText('Total per pouch: Rp 1.500');
  // a cost without a name is refused
  await page.click('#rs-cost-add');
  await page.locator('#rs-costs .rs-c-row').last().locator('.rs-c-cost').fill('100');
  await page.click('#rs-save');
  await expect(page.locator('#rs-err')).toContainText('nama bahan');
  await page.locator('#rs-costs [data-act="rs-cost-del"]').last().click();
  await expect(page.locator('#rs-costs .rs-c-row')).toHaveCount(2);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-repack-new-pack.png') });
  await page.click('#rs-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Kemasan baru dibuat' })).toBeVisible();
  let db = await getDb(page);
  const pk = productByName(db, /Gula Pasir Pouch 250 g/);
  expect(pk).toMatchObject({ unit: 'pouch', sku: 'GP250POUCH', retail_price: 6000, stock: 0, repack_from: bulk.id, repack_qty: 0.25, category: bulk.category });
  expect(JSON.parse(pk.repack_costs)).toEqual([{ n: 'Pouch', c: 1200 }, { n: 'Stiker', c: 300 }]);
  const n = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(n.ref).toBe('owner,akuntan');
  expect(n.summary).toContain('Kemasan baru dibuat: Gula Pasir Pouch 250 g (pouch, barcode GP250POUCH, harga jual Rp 6.000)');
  expect(n.summary).toContain('bahan kemasan per pouch: Pouch Rp 1.200 + Stiker Rp 300 = Rp 1.500');
  await expect(page.locator(`#rs-list tr[data-rs="${pk.id}"] [data-rs-costs]`)).toContainText('Pouch Rp 1.200 + Stiker Rp 300 = Rp 1.500 / pouch');
  // repack 8 pouches: the preview shows the materials, the repack carries them in its cost
  await page.selectOption('#rp-to', String(pk.id));
  await page.fill('#rp-qty', '8');
  await expect(page.locator('#rp-preview [data-mat]')).toContainText('Rp 1.500 / pouch × 8 = Rp 12.000');
  await page.fill('#rp-cost', '2000');
  await page.click('#rp-save');
  // the demo repacked this bulk a moment ago: "another repack?" → yes
  await expect(page.locator('#rp-res, #rp-recent').first()).toBeVisible();
  if (await page.locator('#rp-recent').isVisible()) await page.click('#rp-again');
  await expect(page.locator('#rp-res')).toBeVisible();
  db = await getDb(page);
  const rp = db.repacks.slice(-1)[0];
  expect(rp).toMatchObject({ to_product_id: pk.id, to_qty: 8, materials_cost: 12000, packaging_cost: 14000 });
  expect(rp.unit_cost).toBe(Math.round((2 * bulk.cost_price + 14000) / 8));
  // "Ubah" brings the materials back; changing them tells the owner
  await page.click(`#rs-list [data-act="rs-edit"][data-id="${pk.id}"]`);
  await expect(page.locator('#rs-costs .rs-c-name')).toHaveCount(2);
  await expect(page.locator('#rs-costs .rs-c-name').first()).toHaveValue('Pouch');
  await page.locator('#rs-costs .rs-c-cost').first().fill('1400');
  await page.locator('#rs-costs .rs-c-cost').first().blur();
  await page.click('#rs-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Pengaturan kemas ulang disimpan' })).toBeVisible();
  db = await getDb(page);
  expect(JSON.parse(productByName(db, /Gula Pasir Pouch 250 g/).repack_costs)).toEqual([{ n: 'Pouch', c: 1400 }, { n: 'Stiker', c: 300 }]);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toContain('Biaya kemasan diubah: Gula Pasir Pouch 250 g; bahan kemasan per pouch: Pouch Rp 1.400 + Stiker Rp 300 = Rp 1.700 (sebelumnya bahan kemasan per pouch: Pouch Rp 1.200 + Stiker Rp 300 = Rp 1.500)');
});

test('Arabic: the new-pack and materials fields read in Arabic', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.evaluate(() => { const b = document.querySelector('[data-act="set-lang"][data-lang="ar"]'); if (b) b.click(); else if (window.setLang) window.setLang('ar'); });
  await openRepackTab(page);
  await page.selectOption('#rs-pack', '__new');
  await expect(page.locator('#rp-setup')).toContainText('عبوة جديدة (منتج جديد)');
  await expect(page.locator('#rp-setup')).toContainText('مواد التعبئة لكل عبوة');
  await expect(page.locator('label[for="rp-cost"]')).toContainText('تكاليف أخرى');
});
