// v48 + v50 (owner 2026-10-14/15: «في بعض الأحيان نقوم بتعبية منتج جديد مثلا نختار عبوة جديدة و ستيكر جديد …»; «عندما نختار مثلا الستيكر أو
// التوبليس … لا يمكن كتابة شيء بعد كلمة توبليس أو ستيكر … فهي تكون عنصر للاختيار بس»): a NEW pack made right in the repack form (its name typed
// in the pack field), its materials CHOSEN from the materials list (pieces per pack), their cost per pack added to every confirmed repack.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, productByName, nav, pick, asUser } = require('./helpers');

async function openRepackTab(page) {
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="repack"]');
  await expect(page.locator('#rp-form')).toBeVisible();
}

test('a NEW pack from the form: materials chosen from the list (no typing after a chosen one), 2 kg → 8 pouches; the confirmed repack carries materials × packs', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const bulk = productByName(await getDb(page), /Gula Pasir/);
  await openRepackTab(page);
  await page.fill('#rm-n-name', 'Pouch 250 g'); await page.fill('#rm-n-price', '1200'); await page.click('#rm-add');
  await expect(page.locator('#rm-list tr[data-rm="Pouch 250 g"]')).toBeVisible();
  await page.fill('#rm-n-name', 'Stiker'); await page.fill('#rm-n-price', '300'); await page.click('#rm-add');
  await expect(page.locator('#rm-list tr[data-rm="Stiker"]')).toBeVisible();
  await pick(page, 'rp-bulk', bulk.name, bulk.id);
  // the new pack's name is typed in the pack field → "＋ Kemasan baru" takes it
  await page.fill('#rp-pack-q', 'Gula Pasir Pouch 250 g');
  await page.locator('#rp-pack-list [data-pick="__new"]').click();
  await expect(page.locator('#rpi-new')).toBeVisible();
  await expect(page.locator('#rpi-n-name')).toHaveValue('Gula Pasir Pouch 250 g');
  await page.fill('#rpi-n-price', '6000');
  await page.fill('#rpi-n-unit', 'pouch');
  await page.fill('#rpi-n-sku', 'GP250POUCH');
  await page.fill('#rpi-size', '0,25');
  await page.click('#rpi-mat-add');
  await pick(page, 'rpi-m0', 'pouch', 'Pouch 250 g');
  await expect(page.locator('#rpi-m0-q')).toBeHidden(); // chosen: a fixed chip — nothing can be typed after "Pouch 250 g"
  await page.click('#rpi-mat-add');
  // typed but not chosen → dropped when the field is left (only a name from the list counts)
  await page.fill('#rpi-m1-q', 'Stiker emas baru');
  await page.locator('#rpi-size').click();
  await expect(page.locator('#rpi-m1')).toHaveAttribute('data-value', '');
  await expect(page.locator('#rpi-m1-q')).toHaveValue('');
  await pick(page, 'rpi-m1', 'stik', 'Stiker');
  await page.locator('#rpi-mats .ps-mat-qty').nth(1).fill('2');
  await expect(page.locator('#rpi-mat-total')).toHaveText('Total per pouch: Rp 1.800');
  await page.fill('#rp-amount', '2');
  await expect(page.locator('#rp-planned')).toHaveAttribute('data-planned', '8');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-repack-new-pack.png') });
  await page.click('#rp-start');
  await expect(page.locator('#rp-res, #rp-recent').first()).toBeVisible();
  if (await page.locator('#rp-recent').isVisible()) await page.click('#rp-again');
  await expect(page.locator('#rp-res')).toContainText('rencana 8');
  let db = await getDb(page);
  const pk = productByName(db, /Gula Pasir Pouch 250 g/);
  expect(pk).toMatchObject({ unit: 'pouch', sku: 'GP250POUCH', retail_price: 6000, stock: 0, repack_from: bulk.id, repack_qty: 0.25, category: bulk.category });
  expect(JSON.parse(pk.repack_costs)).toEqual([{ n: 'Pouch 250 g', q: 1, c: 1200 }, { n: 'Stiker', q: 2, c: 600 }]);
  const made = db.activity.filter(a => a.kind === 'notifikasi').find(a => a.summary.includes('Kemasan baru dibuat: Gula Pasir Pouch 250 g'));
  expect(made).toMatchObject({ ref: 'owner,akuntan' });
  expect(made.summary).toContain('bahan kemasan per pouch: Pouch 250 g Rp 1.200 + Stiker x2 Rp 600 = Rp 1.800');
  await expect(page.locator(`#rs-list tr[data-rs="${pk.id}"] [data-rs-costs]`)).toContainText('Pouch 250 g Rp 1.200 + Stiker ×2 Rp 600 = Rp 1.800 / pouch');
  // confirm: 8 pouches → materials 8 × Rp 1.800
  const rp0 = db.repacks.slice(-1)[0];
  await page.locator(`#rp-open-body [data-rp-open="${rp0.repack_id}"] [data-act="rp-fin"]`).click();
  await page.fill('#rf-cost', '2000');
  await page.click('#rf-ok');
  await expect(page.locator('#rp-fin-modal')).toHaveCount(0);
  db = await getDb(page);
  const rp = db.repacks.find(r => r.repack_id === rp0.repack_id);
  expect(rp).toMatchObject({ status: 'selesai', to_qty: 8, materials_cost: 14400, packaging_cost: 16400 });
  expect(rp.unit_cost).toBe(Math.round((2 * bulk.cost_price + 16400) / 8));
  // a price changed on the list is used by the next repack
  await page.locator('#rm-list tr[data-rm="Stiker"] .rm-price').fill('500');
  await page.locator('#rm-list tr[data-rm="Stiker"] .rm-price').blur();
  await page.click('#rm-save');
  await expect.poll(async () => (await getDb(page)).settings.repack_materials.find(m => m.n === 'Stiker').c).toBe(500);
  const st = await asUser(page, 'Jihan', '2222', 'repack_start', { from_product_id: bulk.id, to_product_id: pk.id, from_qty: 1, confirm_recent: true });
  const fin = await asUser(page, 'Jihan', '2222', 'repack_finish', { repack_id: st.repack.repack_id, to_qty: 4, remaining_qty: 0 });
  expect(fin.ok).toBe(true);
  expect((await getDb(page)).repacks.find(r => r.repack_id === st.repack.repack_id).materials_cost).toBe(4 * (1200 + 2 * 500));
});

test('Arabic: the new-pack and materials fields read in Arabic', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const bulk = productByName(await getDb(page), /Gula Pasir/);
  await page.evaluate(() => setLang('ar'));
  await openRepackTab(page);
  await pick(page, 'rp-bulk', bulk.name, bulk.id);
  await page.locator('#rp-pack-q').click();
  await page.locator('#rp-pack-list [data-pick="__new"]').click();
  await expect(page.locator('#rp-setup-inline')).toContainText('اسم العبوة الجديدة');
  await expect(page.locator('#rp-setup-inline')).toContainText('مواد التعبئة لكل عبوة');
  await expect(page.locator('label[for="rp-cost"]')).toContainText('تكاليف أخرى');
  await expect(page.locator('label[for="rp-amount"]')).toContainText('كمية السائب التي تُعبّأ');
});
