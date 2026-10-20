// v12 Repacking in the shop: bulk → small packs, yield / loss / pack cost; product form fields; stock card rows.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, productByName, nav, asUser, pick } = require('./helpers');

const fq = n => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(n);
async function openRepack(page) {
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="repack"]');
  await expect(page.locator('#rp-form')).toBeVisible();
}

// v50 (owner 2026-10-15: «تنطلق عملية التعبية باختيار العنصر الكبير … ثم الحاسوب يحسب مباشرة الكمية … وبعد عملية التعليب تقع الموافقة على
// الكمية التي تمت عن طريق المدير فإن كانت كمية أقل فيرجى كتابتها وكم الكمية اللي ما زالت»; «يكون كل عنصر مرتبط بنفس الوحدة القياسية و نفس النوع
// … ولا يضع الزيوت»; «إمكانية كتابة الكلمة كاملة ليس الحرف فقط»): bulk first (type to find), then its pack (same kind only), the bulk amount
// gives the packs; "Mulai kemas" takes the bulk out; the confirmation records the packs made + the bulk left over.
test('owner: type to find the bulk, its packs (same kind, no oils), 5 kg → 10 packs; start takes the bulk; confirm 9 + 0,3 kg left → stock, cost, history, stock card', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kurma Rabia Curah/), pack = productByName(db0, /Kurma Rabia Kemas 500/);
  const other = db0.products.find(p => p.active !== false && p.category && p.category !== bulk.category && !(p.repack_from > 0));
  expect(pack).toMatchObject({ repack_from: bulk.id, repack_qty: 0.5 });
  await openRepack(page);
  // whole words, any order, narrow the list
  await page.fill('#rp-bulk-q', 'curah rabia');
  await expect(page.locator('#rp-bulk-list [data-pick]')).toHaveCount(1);
  await page.locator(`#rp-bulk-list [data-pick="${bulk.id}"]`).click();
  await expect(page.locator('#rp-bulk-v')).toContainText('Kurma Rabia Curah');
  await expect(page.locator('#rp-bulk-q')).toBeHidden(); // chosen: a fixed chip, nothing can be typed after it
  await expect(page.locator('#rp-bulk-stock')).toContainText(fq(bulk.stock));
  // the packs: those made from this bulk first, then the same kind only — never another category (oils …)
  await page.locator('#rp-pack-q').click();
  const ids = await page.locator('#rp-pack-list [data-pick]').evaluateAll(b => b.map(x => x.dataset.pick));
  expect(ids.slice(0, 2).sort()).toEqual(db0.products.filter(p => p.repack_from === bulk.id).map(p => String(p.id)).sort());
  expect(ids).toContain('__new');
  expect(ids).not.toContain(String(other.id));
  for (const id of ids.filter(x => x !== '__new')) expect(db0.products.find(p => String(p.id) === id).category).toBe(bulk.category);
  await page.locator(`#rp-pack-list [data-pick="${pack.id}"]`).click();
  await expect(page.locator('#rp-pack-info')).toContainText('0,5 kg');
  await page.fill('#rp-amount', '5');
  await expect(page.locator('#rp-planned')).toHaveAttribute('data-planned', '10');
  await expect(page.locator('#rp-calc')).toContainText('5 kg ÷ 0,5 kg =');
  await page.fill('#rp-amount', '5,2');
  await expect(page.locator('#rp-calc [data-left]')).toContainText('Sisa 0,2 kg');
  await page.fill('#rp-amount', '5');
  await page.fill('#rp-cost', '4500');
  await page.fill('#rp-note', 'Uji kemas');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-repack.png') });
  await page.click('#rp-start');
  await expect(page.locator('#rp-res, #rp-recent').first()).toBeVisible();
  if (await page.locator('#rp-recent').isVisible()) await page.click('#rp-again'); // the demo packed this bulk a moment ago
  await expect(page.locator('#rp-res')).toContainText('rencana 10');
  let db = await getDb(page);
  const rp0 = db.repacks.slice(-1)[0];
  expect(rp0).toMatchObject({ status: 'proses', from_qty: 5, planned_qty: 10, to_qty: 0, started_by: 'Pemilik' });
  expect(productByName(db, /Kurma Rabia Curah/).stock).toBe(Math.round((bulk.stock - 5) * 1000) / 1000); // on the packing table
  expect(productByName(db, /Kurma Rabia Kemas 500/).stock).toBe(pack.stock); // no packs yet
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'manager,akuntan' }); // v63: the accountant may confirm it too
  // "Sedang dikemas" → confirm: 9 packs, 0,3 kg left over
  const row = page.locator(`#rp-open-body [data-rp-open="${rp0.repack_id}"]`);
  await expect(row).toContainText('rencana 10');
  await row.locator('[data-act="rp-fin"]').click();
  await expect(page.locator('#rf-made')).toHaveValue('10');
  await page.fill('#rf-made', '9');
  await expect(page.locator('#rf-rem')).toHaveValue('0,5'); // 5 − 9 × 0,5 suggested
  await page.fill('#rf-rem', '0,3');
  await expect(page.locator('#rf-pv [data-short]')).toContainText('Kurang 1');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-repack-confirm.png') });
  await page.click('#rf-ok');
  await expect(page.locator('#rp-fin-modal')).toHaveCount(0);
  const unitCost = Math.round((4.7 * bulk.cost_price + 4500) / 9);
  await expect(page.locator('#rp-res [data-unit-cost]')).toContainText(new Intl.NumberFormat('id-ID').format(unitCost));
  db = await getDb(page);
  const b2 = productByName(db, /Kurma Rabia Curah/), p2 = productByName(db, /Kurma Rabia Kemas 500/);
  expect(b2.stock).toBe(Math.round((bulk.stock - 5 + 0.3) * 1000) / 1000);
  expect(p2.stock).toBe(pack.stock + 9);
  expect(p2.cost_price).toBe(Math.round((Math.max(0, pack.stock) * pack.cost_price + 9 * unitCost) / (Math.max(0, pack.stock) + 9)));
  const rp = db.repacks.find(r => r.repack_id === rp0.repack_id);
  expect(rp).toMatchObject({ status: 'selesai', from_qty: 4.7, remaining_qty: 0.3, to_qty: 9, planned_qty: 10, expected_qty: 9.4, yield_pct: 95.7, loss_qty: 0.2, packaging_cost: 4500, unit_cost: unitCost, started_by: 'Pemilik', confirmed_by: 'Pemilik' });
  const rows = db.purchases.filter(r => r.supplier === 'KEMAS ULANG' && r.note.includes(rp.repack_id));
  expect(rows.map(r => [r.product_id, r.qty])).toEqual([[bulk.id, -5], [bulk.id, 0.3], [pack.id, 9]]);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'manager,akuntan' });
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toContain('rencana 10, jadi 9; sisa curah 0.3 kg kembali ke stok — KURANG 1 dari rencana');
  await expect(page.locator('#rp-open-body [data-rp-open]')).toHaveCount(0);
  // history: the confirmed repack (not the open one), totals per product
  await expect(page.locator(`#rp-hist tr[data-rp="${rp.repack_id}"] [data-yield]`)).toHaveText('95,7%');
  const mine = db.repacks.filter(r => r.to_product_id === pack.id && r.repack_date >= jktToday(-29) && r.status !== 'proses');
  const avg = mine.reduce((a, r) => a + r.to_qty, 0) / mine.reduce((a, r) => a + r.expected_qty, 0) * 100;
  await expect(page.locator(`#rp-totals tr[data-pack="${pack.id}"] [data-avg]`)).toHaveText(new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(avg) + '%');
  // the bulk's stock card shows both movements
  await page.click('#gd-tabs [data-tab="list"]');
  await page.fill('#gd-q', 'rabia curah');
  await page.locator(`#gd-table tr[data-pid="${bulk.id}"]`).locator("td").first().click();
  await expect(page.locator('#gd-card-table tr[data-kind="repack"]').last()).toContainText('Kemas ulang');
  await expect(page.locator('#gdc-end')).toContainText(fq(b2.stock));
});

test('manager: no costs shown; too much bulk / less than one pack refused; the same pack cannot start twice; confirm; a cashier cannot confirm', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kacang Mete Curah/), pack = productByName(db0, /Kacang Mete Arab/);
  await openRepack(page);
  await expect(page.locator('#rp-hist th')).not.toContainText(['Biaya kemasan']);
  await pick(page, 'rp-bulk', 'mete curah', bulk.id);
  await pick(page, 'rp-pack', 'mete arab', pack.id);
  await page.fill('#rp-amount', '1000');
  await expect(page.locator('#rp-calc')).toHaveClass(/bad/);
  await page.click('#rp-start');
  await expect(page.locator('#rp-err')).toContainText('tidak cukup');
  await page.fill('#rp-amount', '0,1');
  await page.click('#rp-start');
  await expect(page.locator('#rp-err')).toContainText('Kurang dari isi satu kemasan');
  await page.fill('#rp-amount', '1');
  await page.click('#rp-start');
  await expect(page.locator('#rp-res, #rp-recent').first()).toBeVisible();
  if (await page.locator('#rp-recent').isVisible()) await page.click('#rp-again');
  await expect(page.locator('#rp-res')).toContainText('rencana 4');
  const rp0 = (await getDb(page)).repacks.slice(-1)[0];
  // the same pack from the same bulk again before it is confirmed: refused (two people, one job)
  await pick(page, 'rp-bulk', 'mete curah', bulk.id);
  await pick(page, 'rp-pack', 'mete arab', pack.id);
  await page.fill('#rp-amount', '1');
  await page.click('#rp-start');
  if (await page.locator('#rp-recent').isVisible()) await page.click('#rp-again');
  await expect(page.locator('#rp-err')).toContainText('sedang mengemas');
  expect((await asUser(page, 'Siti', '1111', 'repack_finish', { repack_id: rp0.repack_id, to_qty: 4, remaining_qty: 0 })).error).toBe('FORBIDDEN');
  await page.locator(`#rp-open-body [data-rp-open="${rp0.repack_id}"] [data-act="rp-fin"]`).click();
  await page.click('#rf-ok');
  await expect(page.locator('#rp-res')).toBeVisible();
  await expect(page.locator('#rp-res [data-unit-cost]')).toHaveCount(0);
  const r = await asUser(page, 'Jihan', '2222', 'get_sales', { from: '2000-01-01', to: '2100-01-01' });
  expect(r.repacks.some(x => 'unit_cost' in x || 'packaging_cost' in x || 'bulk_cost' in x)).toBe(false);
  expect((await getDb(page)).products.find(p => p.id === bulk.id).stock).toBe(Math.round((bulk.stock - 1) * 1000) / 1000);
  expect((await getDb(page)).products.find(p => p.id === pack.id).stock).toBe(pack.stock + 4);
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
