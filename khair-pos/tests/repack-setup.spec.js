// v43 (owner 2026-10-13: «اختيار البضائع لاعادة التعبئة للمواد يقوم بها المدير ليس المالك و يصل اشعار للمالك و المحاسب»): the manager (and the
// owner) chooses which product is packed from which bulk and how much goes in a pack; the owner and the accountant are told.
// v50 (owner 2026-10-15: «يكون كل عنصر مرتبط بنفس الوحدة القياسية و نفس النوع»): a pack is set up right in the repack form when a product of
// the SAME kind is chosen for the first time (size in the bulk's unit + its materials); "Ubah" changes it, "Hapus" removes it; the
// packaging materials list (name + price per piece) is kept here.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, productByName, nav, asUser, pick, editDb } = require('./helpers');

async function openRepackTab(page) {
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="repack"]');
  await expect(page.locator('#rp-form')).toBeVisible();
}

test('the manager packs a same-kind product for the first time: size + materials set in the form (owner + accountant told); Ubah; Hapus', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kurma Rabia Curah/);
  const bulkIds = new Set(db0.products.filter(p => p.repack_from > 0).map(p => p.repack_from));
  const free = db0.products.find(p => p.active !== false && p.category === bulk.category && p.id !== bulk.id && !(p.repack_from > 0) && !bulkIds.has(p.id));
  expect(free).toBeTruthy();
  await openRepackTab(page);
  await expect(page.locator('#rp-setup')).toContainText('Pemilik dan akuntan diberi tahu');
  await pick(page, 'rp-bulk', 'rabia curah', bulk.id);
  await page.locator('#rp-pack-q').fill(free.name.split(' ').slice(0, 2).join(' '));
  await expect(page.locator(`#rp-pack-list [data-pick="${free.id}"]`)).toContainText('sejenis, belum dikemas ulang');
  await page.locator(`#rp-pack-list [data-pick="${free.id}"]`).click();
  await expect(page.locator('#rp-setup-inline')).toBeVisible();
  await expect(page.locator('#rpi-new')).toBeHidden(); // an existing product: no new name / price
  await expect(page.locator('#rpi-unit')).toHaveText(bulk.unit);
  await page.fill('#rp-amount', '2');
  await page.click('#rp-start');
  await expect(page.locator('#rp-err')).toContainText('isi per kemasan');
  await page.fill('#rpi-size', '0,5');
  await expect(page.locator('#rp-planned')).toHaveAttribute('data-planned', '4');
  // a material that is not on the list yet: "＋ Bahan baru…" adds it to the list, then it is chosen
  await page.click('#rpi-mat-add');
  await page.fill('#rpi-m0-q', 'Stiker bulat');
  await page.locator('#rpi-m0-list [data-pick="__newmat"]').click();
  await expect(page.locator('#rpi-newmat')).toBeVisible();
  await expect(page.locator('#rpi-nm-name')).toHaveValue('Stiker bulat');
  await page.fill('#rpi-nm-price', '400');
  await page.click('#rpi-nm-ok');
  await expect(page.locator('#rpi-m0')).toHaveAttribute('data-value', 'Stiker bulat');
  await expect(page.locator('#rpi-mat-total')).toContainText('Rp 400');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-repack-setup.png') });
  await page.click('#rp-start');
  await expect(page.locator('#rp-res, #rp-recent').first()).toBeVisible();
  if (await page.locator('#rp-recent').isVisible()) await page.click('#rp-again');
  await expect(page.locator('#rp-res')).toContainText('rencana 4');
  let db = await getDb(page);
  expect(productByName(db, new RegExp(free.name.replace(/[()]/g, '.')))).toMatchObject({ repack_from: bulk.id, repack_qty: 0.5 });
  expect(JSON.parse(db.products.find(p => p.id === free.id).repack_costs)).toEqual([{ n: 'Stiker bulat', q: 1, c: 400 }]);
  expect(db.settings.repack_materials).toEqual([{ n: 'Stiker bulat', c: 400 }]);
  const told = db.activity.filter(a => a.kind === 'notifikasi');
  expect(told.find(a => a.summary.includes(`Kemas ulang diatur: ${free.name} dibuat dari ${bulk.name}, 0.5 ${bulk.unit}`))).toMatchObject({ ref: 'owner,akuntan', user: 'Jihan' });
  expect(told.find(a => a.summary.includes('Daftar bahan kemasan diubah (harga per buah): + Stiker bulat Rp 400'))).toBeTruthy();
  // it is set up now: listed, and its open repack is confirmed (cancelled) before it is changed
  const open = db.repacks.slice(-1)[0];
  await page.locator(`#rp-open-body [data-rp-open="${open.repack_id}"] [data-act="rp-fin"]`).click();
  await page.click('#rf-cancel');
  await page.click('#cf-ok');
  await expect(page.locator('#rp-open-body [data-rp-open]')).toHaveCount(0);
  await expect(page.locator(`#rs-list tr[data-rs="${free.id}"]`)).toContainText('Stiker bulat Rp 400');
  // "Ubah": the size and the materials
  await page.click(`#rs-list [data-act="rs-edit"][data-id="${free.id}"]`);
  await expect(page.locator('#rse-size')).toHaveValue('0,5');
  await page.fill('#rse-size', '0,25');
  await page.locator('#rse-mats .ps-mat-qty').first().fill('2');
  await page.click('#rse-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Pengaturan kemas ulang disimpan' })).toBeVisible();
  db = await getDb(page);
  expect(db.products.find(p => p.id === free.id)).toMatchObject({ repack_qty: 0.25 });
  expect(JSON.parse(db.products.find(p => p.id === free.id).repack_costs)).toEqual([{ n: 'Stiker bulat', q: 2, c: 800 }]);
  // "Hapus"
  await page.click(`#rs-list [data-act="rs-del"][data-id="${free.id}"]`);
  await page.click('#cf-ok');
  await expect.poll(async () => Number((await getDb(page)).products.find(p => p.id === free.id).repack_from) || 0).toBe(0);
  await expect(page.locator(`#rs-list tr[data-rs="${free.id}"]`)).toHaveCount(0);
  expect((await getDb(page)).activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toContain(`Kemas ulang dihapus: ${free.name}`);
  // the server rules: a cashier cannot set it, nor change the materials list
  expect((await asUser(page, 'Siti', '1111', 'set_repack', { product_id: free.id, repack_from: bulk.id, repack_qty: 1 })).error).toBe('FORBIDDEN');
  expect((await asUser(page, 'Siti', '1111', 'set_repack_materials', { materials: [] })).error).toBe('FORBIDDEN');
});

test('the materials list (owner): add, change a price, remove — the manager and the accountant are told; Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openRepackTab(page);
  await expect(page.locator('#rp-setup')).toContainText('Manajer dan akuntan diberi tahu');
  await expect(page.locator('#rm-list')).toContainText('Daftar masih kosong');
  await page.fill('#rm-n-name', 'Toples 1 kg');
  await page.fill('#rm-n-price', '3000');
  await page.click('#rm-add');
  await expect(page.locator('#rm-list tr[data-rm="Toples 1 kg"]')).toBeVisible();
  await page.fill('#rm-n-name', 'Stiker');
  await page.fill('#rm-n-price', '500');
  await page.click('#rm-add');
  await expect(page.locator('#rm-list tr[data-rm="Stiker"]')).toBeVisible();
  await page.fill('#rm-n-name', 'stiker');
  await page.fill('#rm-n-price', '600');
  await page.click('#rm-add');
  await expect(page.locator('#rm-err')).toContainText('sudah ada');
  await page.locator('#rm-list tr[data-rm="Stiker"] .rm-price').fill('700');
  await page.locator('#rm-list tr[data-rm="Stiker"] .rm-price').blur();
  await page.click('#rm-save');
  await expect.poll(async () => (await getDb(page)).settings.repack_materials).toEqual([{ n: 'Toples 1 kg', c: 3000 }, { n: 'Stiker', c: 700 }]);
  let db = await getDb(page);
  expect(db.settings.repack_materials).toEqual([{ n: 'Toples 1 kg', c: 3000 }, { n: 'Stiker', c: 700 }]);
  const n = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(n).toMatchObject({ ref: 'manager,akuntan' });
  expect(n.summary).toContain('Stiker Rp 500 → Rp 700');
  await page.click('#rm-list [data-act="rm-del"][data-name="Toples 1 kg"]');
  await expect(page.locator('#rm-list tr[data-rm="Toples 1 kg"]')).toHaveCount(0);
  db = await getDb(page);
  expect(db.settings.repack_materials).toEqual([{ n: 'Stiker', c: 700 }]);
  // the cashier sees no prices of the list
  expect((await asUser(page, 'Siti', '1111', 'bootstrap', {})).settings.repack_materials).toEqual([{ n: 'Stiker' }]);
  await page.click('#tb-lang');
  await expect(page.locator('#rp-setup h3')).toContainText('ضبط بضائع إعادة التعبئة');
  await expect(page.locator('#rp-setup')).toContainText('قائمة مستلزمات التعبئة');
});

// v66 (owner 2026-10-20, the set-up list: «التطبيق لا يحسب جملة الثمن مع البضاعة. اضف ثمن البضاعة ايضا»): each pack shows its whole cost per
// piece — the bulk's share (cost price × size) + the materials; a cost above the selling price (a size typed wrong) is flagged.
test('the set-up list: the pack\'s whole cost = the bulk\'s share + the materials; above the selling price it is flagged; Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true }); // (the demo's packs are seeded on the first open)
  await editDb(page, `
    const b = db.products.find(p => p.name === 'Kurma Rabia Kemas 500 g'), bulk = db.products.find(p => String(p.id) === String(b.repack_from));
    bulk.cost_price = 48000;
    b.repack_costs = JSON.stringify([{ n: 'Toples', q: 1, c: 3000 }, { n: 'Stiker', q: 1, c: 500 }]);
    const w = db.products.find(p => p.name === 'Kurma Rabia Kemas 250 g'); w.repack_qty = 70000;`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (KPOS.S.products.find(p => p.name === 'Kurma Rabia Kemas 250 g') || {}).repack_qty)).toBe(70000);
  await openRepackTab(page);
  const db = await getDb(page), pk = productByName(db, /Kurma Rabia Kemas 500 g/), w = productByName(db, /Kurma Rabia Kemas 250 g/), bulk = db.products.find(p => p.id === pk.repack_from);
  const row = page.locator(`#rs-list tr[data-rs="${pk.id}"]`);
  await expect(row.locator('[data-rs-costs]')).toContainText('Toples Rp 3.000 + Stiker Rp 500 = Rp 3.500 / pak');
  await expect(row.locator('[data-rs-total]')).toHaveAttribute('data-rs-total', '27500');
  await expect(row.locator('[data-rs-total]')).toContainText(`Modal per pak: barang Rp 24.000 (0,5 ${bulk.unit} × Rp 48.000) + bahan Rp 3.500 = Rp 27.500`);
  await expect(row.locator('[data-rs-over]')).toHaveCount(0);
  // a size typed wrong: the cost is far above the selling price
  await expect(page.locator(`#rs-list tr[data-rs="${w.id}"] [data-rs-over]`)).toContainText('Modal di atas harga jual (Rp 19.000)');
  await page.evaluate(() => setLang('ar'));
  await openRepackTab(page);
  await expect(page.locator(`#rs-list tr[data-rs="${pk.id}"] [data-rs-total]`)).toContainText('التكلفة لكل pak: البضاعة Rp 24.000');
  await expect(page.locator(`#rs-list tr[data-rs="${w.id}"] [data-rs-over]`)).toContainText('التكلفة أعلى من سعر البيع');
});
