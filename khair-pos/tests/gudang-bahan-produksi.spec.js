// v67 (owner 2026-10-20, majoo screenshots: «اضف هذه المميزات»): Gudang → "Bahan baku" (the bulk goods packed in the shop, the
// packaging materials from goods-in, the materials price list) and "Produksi stok" (the repacks of a date range + the open ones).
// Expected values are read back from the mock DB.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { rp, SHOTS, jktToday, login, getDb, editDb, productByName, nav, asUser, openApp, enterKey, staffSession } = require('./helpers');

const NFQ = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
const fq = q => NFQ.format(q);
const T = jktToday();
const monthStart = T.slice(0, 8) + '01';
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const csvLines = async dl => fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);

/** A packaging material received at goods-in (used 1 per 500 g pack) + a price-list material used 2 per 250 g pack. */
async function addMaterials(page) {
  const db = await getDb(page);
  const r500 = productByName(db, /Kurma Rabia Kemas 500 g/), r250 = productByName(db, /Kurma Rabia Kemas 250 g/);
  await editDb(page, `
    db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1;
    db.products.push({ id: db.seq.product, sku: 'STK500', name: 'Stiker Kurma 500 g', category: 'Bahan kemasan', unit: 'pcs', cost_price: 350, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0,
      stock: 40, min_stock: 50, active: true, notes: '', supplier: '', size: '', weight: '', exp_date: '', exp_none: false, repack_from: 0, repack_qty: 0, use_for: JSON.stringify([{ p: arg.r500, q: 1 }]) });
    db.settings.repack_materials = (db.settings.repack_materials || []).filter(m => m.n !== 'Plastik vakum').concat([{ n: 'Plastik vakum', c: 800 }]);
    db.products.find(p => p.id === arg.r250).repack_costs = JSON.stringify([{ n: 'Plastik vakum', q: 2, c: 1600 }]);`, { r500: r500.id, r250: r250.id });
  return { r500, r250 };
}
async function openTab(page, tab) {
  await nav(page, 'gudang');
  await page.click(`#gd-tabs [data-tab="${tab}"]`);
  await expect(page.locator(`#gd-tabs [data-tab="${tab}"]`)).toHaveClass(/\bon\b/);
}
const bbRow = (page, name) => page.locator(`#bb-table tbody tr[data-name="${name}"]`);
async function addAkuntan(page) {
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
}

test('Bahan baku: the bulk goods with their packs, a material from goods-in, the price list; search, Jenis filter, CSV, Tambah, Impor', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const { r500, r250 } = await addMaterials(page);
  await openTab(page, 'bahan');
  const db = await getDb(page);
  const rabia = productByName(db, /Kurma Rabia Curah/), mete = productByName(db, /Kacang Mete Curah/), mete250 = productByName(db, /Kacang Mete Arab/);
  // (a) the bulk goods packed in the shop, with their packs and sizes; the owner sees the purchase price
  const rr = bbRow(page, rabia.name);
  await expect(rr).toHaveAttribute('data-bb', 'curah');
  await expect(rr.locator('[data-col="uses"]')).toContainText(`${r500.name} (0,5 kg)`);
  await expect(rr.locator('[data-col="uses"]')).toContainText(`${r250.name} (0,25 kg)`);
  await expect(rr.locator('[data-col="sku"]')).toHaveText(rabia.sku);
  await expect(rr.locator('[data-col="unit"]')).toHaveText('kg');
  await expect(rr.locator('[data-col="stock"] b')).toHaveText(fq(rabia.stock));
  await expect(rr.locator('[data-col="cost"]')).toHaveText(rp(rabia.cost_price));
  await expect(bbRow(page, mete.name).locator('[data-col="uses"]')).toContainText(`${mete250.name} (0,25 kg)`);
  // (b) the material from goods-in: below its minimum, its price per piece, the pack it is used for
  const st = bbRow(page, 'Stiker Kurma 500 g');
  await expect(st).toHaveAttribute('data-bb', 'kemasan');
  await expect(st.locator('[data-col="kind"]')).toHaveText('Bahan kemasan');
  await expect(st.locator('[data-col="stock"] b')).toHaveAttribute('data-st', 'menipis');
  await expect(st.locator('[data-col="stock"] b')).toHaveClass(/amber/);
  await expect(st.locator('[data-col="stock"]')).toContainText('min 50');
  await expect(st.locator('[data-col="cost"]')).toHaveText(rp(350));
  await expect(st.locator('[data-col="uses"]')).toHaveText(`${r500.name} × 1 buah`);
  // (c) the materials price list: no stock
  const pv = bbRow(page, 'Plastik vakum');
  await expect(pv).toHaveAttribute('data-bb', 'daftar');
  await expect(pv.locator('[data-col="stock"]')).toHaveText('Daftar harga');
  await expect(pv.locator('[data-col="cost"]')).toHaveText(rp(800));
  await expect(pv.locator('[data-col="uses"]')).toHaveText(`${r250.name} × 2 buah`);
  const list = (db.settings.repack_materials || []).length;
  const bulks = new Set(db.products.filter(p => p.active !== false && p.repack_from > 0 && db.products.some(b => b.id === p.repack_from)).map(p => p.repack_from)).size;
  await expect(page.locator('#bb-table tbody tr[data-bb]')).toHaveCount(bulks + 1 + list);
  await expect(page.locator('#bb-count [data-n="daftar"]')).toHaveText(String(list));
  // search: every word of the name / SKU / the packs it is used for
  await page.fill('#bb-q', 'rabia 250');
  await expect(page.locator('#bb-table tbody tr[data-bb]')).toHaveCount(2);
  await expect(rr).toBeVisible(); await expect(pv).toBeVisible();
  await page.fill('#bb-q', 'stk500');
  await expect(page.locator('#bb-table tbody tr[data-bb]')).toHaveCount(1);
  await expect(st).toBeVisible();
  await page.fill('#bb-q', '');
  await page.selectOption('#bb-kind', 'curah');
  await expect(page.locator('#bb-table tbody tr[data-bb]')).toHaveCount(bulks);
  await expect(page.locator('#bb-table tbody tr[data-bb]:not([data-bb="curah"])')).toHaveCount(0);
  await page.selectOption('#bb-kind', '');
  // CSV: what is shown, ';' with a BOM
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bb-csv')]);
  expect(dl.suggestedFilename()).toBe(`bahan-baku-${T}.csv`);
  const csv = await csvLines(dl);
  expect(csv[0]).toBe('sku;nama;satuan;jenis;stok;stok_minimum;harga_modal_per_satuan;dipakai_untuk');
  expect(csv.length - 1).toBe(bulks + 1 + list);
  expect(csv).toContain(`"STK500";"Stiker Kurma 500 g";"pcs";"Bahan kemasan";"40";"50";"350";"${r500.name} x1"`);
  expect(csv).toContain(`"";"Plastik vakum";"buah";"Daftar bahan";"";"";"800";"${r250.name} x2"`);
  expect(csv.find(l => l.includes(rabia.name))).toContain(`"Barang curah";"${fq(rabia.stock)}";"${fq(rabia.min_stock)}";"${rabia.cost_price}";"${r500.name} (0,5 kg), ${r250.name} (0,25 kg)"`);
  // a product row opens its stock card
  await st.click();
  await expect(page.locator('.modal')).toContainText('Stiker Kurma 500 g');
  await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').first().click();
  // Tambah: the real ways (goods-in in the cashier app, the price list) → the Kemas ulang materials list
  await page.click('#bb-add');
  await expect(page.locator('#bb-add-modal [data-way]')).toHaveCount(3);
  await expect(page.locator('#bb-add-modal')).toContainText('"Produk baru" → "Bahan kemasan"');
  await page.click('#bb-open-mats');
  await expect(page.locator('#bb-add-modal')).toHaveCount(0);
  await expect(page.locator('#gd-tabs [data-tab="repack"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('#rm-list tr[data-rm="Plastik vakum"]')).toBeVisible();
  // Impor (owner): the products import, with the material hint and a sample file
  await page.click('#gd-tabs [data-tab="bahan"]');
  await page.click('#bb-imp');
  await expect(page.locator('#im-file')).toBeVisible();
  await expect(page.locator('#bb-imp-hint')).toContainText('Kategori "Bahan kemasan"');
  const [tpl] = await Promise.all([page.waitForEvent('download'), page.click('#bb-tpl')]);
  expect(tpl.suggestedFilename()).toBe('bahan-baku-contoh.csv');
  expect((await csvLines(tpl))[0]).toBe('nama;sku;kategori;satuan;harga modal;stok;stok minimum');
  const sample = test.info().outputPath('bahan-baku-contoh.csv');
  fs.mkdirSync(path.dirname(sample), { recursive: true }); fs.copyFileSync(await tpl.path(), sample);
  await page.setInputFiles('#im-file', sample);
  await expect(page.locator('#im-m-category')).toHaveValue('2'); // the "kategori" column is mapped
  await page.click('#im-go');
  await expect(page.locator('#im-file')).toHaveCount(0);
  await expect(bbRow(page, 'Toples Plastik 1 kg')).toHaveAttribute('data-bb', 'kemasan');
  expect(productByName(await getDb(page), /Toples Plastik 1 kg/)).toMatchObject({ category: 'Bahan kemasan', cost_price: 2500, stock: 200, min_stock: 50 });
});

test('Produksi stok: the range with its sources / results / materials, open + cancelled ones, status filter, search, CSV, details, Tambah', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const { r500, r250 } = await addMaterials(page);
  let db = await getDb(page);
  const rabia = productByName(db, /Kurma Rabia Curah/), mete = productByName(db, /Kacang Mete Curah/), mete250 = productByName(db, /Kacang Mete Arab/);
  // one confirmed with the goods-in sticker used (2 packs → 2 stickers), one cancelled, one still being packed
  const a = await asUser(page, 'Jihan', '2222', 'repack_start', { client_id: 'pd-a', from_product_id: rabia.id, to_product_id: r500.id, from_qty: 1, confirm_recent: true, note: 'tes stiker' });
  const af = await asUser(page, 'Jihan', '2222', 'repack_finish', { repack_id: a.repack.repack_id, to_qty: 2, remaining_qty: 0 });
  expect(af.repack.status).toBe('selesai');
  const b = await asUser(page, 'Jihan', '2222', 'repack_start', { client_id: 'pd-b', from_product_id: mete.id, to_product_id: mete250.id, from_qty: 0.5, confirm_recent: true });
  await asUser(page, 'Jihan', '2222', 'repack_finish', { repack_id: b.repack.repack_id, cancel: true });
  const c = await asUser(page, 'Jihan', '2222', 'repack_start', { client_id: 'pd-c', from_product_id: rabia.id, to_product_id: r250.id, from_qty: 1.1, confirm_recent: true });
  expect(c.repack.planned_qty).toBe(4);
  db = await getDb(page);
  expect(db.repacks.find(r => r.repack_id === b.repack.repack_id).status).toBe('batal');
  const aCost = db.repacks.find(r => r.repack_id === a.repack.repack_id).unit_cost; // (the manager's answer carries no cost)
  expect(aCost).toBe(Math.round((rabia.cost_price + 2 * 350) / 2)); // 1 kg + 2 stickers, for 2 packs
  await openTab(page, 'produksi');
  await expect(page.locator('#prd-from')).toHaveValue(monthStart);
  await expect(page.locator('#prd-to')).toHaveValue(T);
  const inMonth = db.repacks.filter(r => r.repack_date >= monthStart && r.repack_date <= T);
  const rows = page.locator('#prd-table tbody tr[data-id]');
  await expect(rows).toHaveCount(inMonth.length);
  // newest first: the open one started last
  await expect(rows.first()).toHaveAttribute('data-id', c.repack.repack_id);
  const rc = page.locator(`#prd-table tr[data-id="${c.repack.repack_id}"]`);
  await expect(rc).toHaveAttribute('data-st', 'proses');
  await expect(rc.locator('[data-col="status"]')).toHaveText('Proses');
  await expect(rc.locator('[data-col="src"]')).toContainText(`${rabia.name} × 1,1 kg`);
  await expect(rc.locator('[data-col="res"]')).toContainText(`${r250.name} × 4 pak`);
  await expect(rc.locator('[data-col="res"]')).toContainText('rencana, belum dikonfirmasi');
  await expect(rc.locator('[data-mat="Plastik vakum"]')).toHaveAttribute('data-est', ''); // the price list: estimated (2 × 4)
  await expect(rc.locator('[data-mat="Plastik vakum"]')).toContainText('≈ Plastik vakum × 8 buah');
  await expect(rc.locator('[data-col="by"]')).toHaveText('Jihan');
  const ra = page.locator(`#prd-table tr[data-id="${a.repack.repack_id}"]`);
  await expect(ra.locator('[data-col="status"]')).toHaveText('Selesai');
  await expect(ra.locator('[data-col="res"]')).toHaveText(`${r500.name} × 2 pak`);
  await expect(ra.locator('[data-mat="Stiker Kurma 500 g"]')).not.toHaveAttribute('data-est', ''); // taken from its stock: recorded
  await expect(ra.locator('[data-mat="Stiker Kurma 500 g"]')).toContainText('Stiker Kurma 500 g × 2 pcs');
  await expect(ra.locator('[data-col="note"]')).toHaveText('tes stiker');
  await expect(ra.locator('[data-col="by"]')).toContainText('dikonfirmasi Jihan');
  await expect(ra.locator('[data-col="cost"]')).toHaveText(rp(aCost));
  const rb = page.locator(`#prd-table tr[data-id="${b.repack.repack_id}"]`);
  await expect(rb.locator('[data-col="status"]')).toHaveText('Batal');
  await expect(rb.locator('[data-col="src"]')).toContainText(`${mete.name} × 0,5 kg`);
  await expect(rb.locator('[data-col="src"]')).toContainText('curah kembali ke stok');
  // a demo repack of the month: what it used and gave
  const seed = inMonth.filter(r => !r.status).sort((x, y) => y.repack_time.localeCompare(x.repack_time))[0];
  const rs = page.locator(`#prd-table tr[data-id="${seed.repack_id}"]`);
  await expect(rs.locator('[data-col="src"]')).toContainText(`${seed.from_name} × ${fq(seed.from_qty)} ${seed.from_unit}`);
  await expect(rs.locator('[data-col="res"]')).toContainText(`${seed.to_name} × ${fq(seed.to_qty)} ${seed.to_unit}`);
  await expect(rs.locator('[data-col="status"]')).toHaveText('Selesai');
  await expect(rs.locator('[data-col="cost"]')).toHaveText(rp(seed.unit_cost));
  // status filter (with counts), search, 90 days
  await expect(page.locator('#prd-st [data-st="proses"]')).toHaveText('Proses (1)');
  await page.click('#prd-st [data-st="proses"]');
  await expect(rows).toHaveCount(1);
  await page.click('#prd-st [data-st="batal"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-id', b.repack.repack_id);
  await page.click('#prd-st [data-st=""]');
  await page.fill('#prd-q', a.repack.repack_id.toLowerCase());
  await expect(rows).toHaveCount(1);
  await page.fill('#prd-q', 'mete');
  await expect(rows).toHaveCount(inMonth.filter(r => /Mete/.test(r.from_name)).length);
  await page.fill('#prd-q', '');
  await page.click('#prd-days [data-n="90"]');
  await expect(page.locator('#prd-from')).toHaveValue(addDays(T, -89));
  await expect(rows).toHaveCount(db.repacks.filter(r => r.repack_date >= addDays(T, -89)).length);
  // a demo 500 g repack from before the sticker existed: no sticker was taken from stock, none is shown (no estimate after the fact)
  const old500 = db.repacks.find(r => !r.status && r.to_product_id === r500.id);
  await expect(page.locator(`#prd-table tr[data-id="${old500.repack_id}"] [data-col="res"]`)).toContainText(`${r500.name} × ${fq(old500.to_qty)} pak`);
  await expect(page.locator(`#prd-table tr[data-id="${old500.repack_id}"] [data-mat]`)).toHaveCount(0);
  // CSV of what is shown
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#prd-csv')]);
  expect(dl.suggestedFilename()).toBe(`produksi-stok-${addDays(T, -89)}_${T}.csv`);
  const csv = await csvLines(dl);
  expect(csv[0]).toBe('tanggal;jam;no_produksi;status;stok_sumber;jumlah_sumber;satuan_sumber;bahan;stok_hasil;jumlah_hasil;satuan_hasil;catatan;dibuat_oleh;dikonfirmasi_oleh;biaya_per_kemasan');
  expect(csv.length - 1).toBe(db.repacks.filter(r => r.repack_date >= addDays(T, -89)).length);
  expect(csv.find(l => l.includes(c.repack.repack_id))).toContain(`"proses";"${rabia.name}";"1,1";"kg";"Plastik vakum 8 buah (perkiraan)";"${r250.name}";"4";"pak";"";"Jihan";"";""`);
  expect(csv.find(l => l.includes(a.repack.repack_id))).toContain(`"selesai";"${rabia.name}";"1";"kg";"Stiker Kurma 500 g 2 pcs";"${r500.name}";"2";"pak";"tes stiker";"Jihan";"Jihan";"${aCost}"`);
  // details of a row; an open one is confirmed in the Kemas ulang tab's own dialog
  await ra.click();
  await expect(page.locator('#prd-modal [data-d="yield"]')).toContainText('100,0%');
  await expect(page.locator('#prd-modal [data-d="cost"]')).toContainText(rp(aCost));
  await page.locator('#prd-modal [data-act="modal-close"]').first().click();
  await rc.click();
  await expect(page.locator('#prd-modal [data-d="res"]')).toContainText(`${r250.name} × 4 pak`);
  await page.click('#prd-fin');
  await expect(page.locator('#rp-fin-modal')).toBeVisible();
  await expect(page.locator('#gd-tabs [data-tab="repack"]')).toHaveClass(/\bon\b/);
  await page.locator('#rp-fin-modal').locator('..').locator('[data-act="modal-close"]').first().click();
  // Tambah produksi stok → the Kemas ulang form, the bulk field ready
  await page.click('#gd-tabs [data-tab="produksi"]');
  await page.click('#prd-add');
  await expect(page.locator('#gd-tabs [data-tab="repack"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('#rp-form')).toBeVisible();
  await expect(page.locator('#rp-bulk-q')).toBeFocused();
});

test('manager: no Impor; the bulk cost and the cost per pack only with the owner\'s cost setting; the accountant sees the two tabs only', async ({ page }) => {
  await openApp(page);
  await addAkuntan(page);
  await enterKey(page);
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await asUser(page, 'Jihan', '2222', 'bootstrap', {}); // (the demo's repack products are added on the first request)
  await page.reload(); await expect(page.locator('#app')).toBeVisible();
  const db = await getDb(page), rabia = productByName(db, /Kurma Rabia Curah/);
  await openTab(page, 'bahan');
  await expect(page.locator('#bb-imp')).toHaveCount(0);
  await expect(page.locator('#bb-add')).toBeVisible();
  await expect(bbRow(page, rabia.name).locator('[data-col="cost"]')).toHaveText('—');
  await page.click('#gd-tabs [data-tab="produksi"]');
  await expect(page.locator('#prd-table tbody tr[data-id]').first()).toBeVisible();
  await expect(page.locator('#prd-table th[data-col="cost"]')).toHaveCount(0);
  await expect(page.locator('#prd-add')).toBeVisible();
  await editDb(page, `db.settings.akuntan_sees_cost = true;`);
  await page.reload(); await expect(page.locator('#app')).toBeVisible();
  await openTab(page, 'bahan');
  await expect(bbRow(page, rabia.name).locator('[data-col="cost"]')).toHaveText(rp(rabia.cost_price));
  await page.click('#gd-tabs [data-tab="produksi"]');
  await expect(page.locator('#prd-table tbody tr[data-id]').first()).toBeVisible();
  await expect(page.locator('#prd-table th[data-col="cost"]')).toHaveCount(1); // v67: a repack's costs follow the owner's cost setting
  // v68 (owner 2026-10-20: «اجعل المحاسب يرى المواد الخام وإنتاج المخزون»): the accountant opens Gudang with these two tabs only
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#nav [data-view="gudang"]')).toHaveCount(1);
  await page.evaluate(() => go('gudang'));
  await expect(page.locator('#view-gudang')).toBeVisible();
  await expect(page.locator('#gd-tabs [data-tab]')).toHaveCount(2);
  await expect(page.locator('#gd-tabs [data-tab="bahan"]')).toHaveClass(/on/);
  await expect(bbRow(page, rabia.name)).toBeVisible();
  await expect(bbRow(page, rabia.name).locator('[data-col="cost"]')).toHaveText(rp(rabia.cost_price)); // the owner's cost setting is on
  await expect(page.locator('#bb-imp')).toHaveCount(0);
  await expect(page.locator('#bb-add')).toHaveCount(0);
  await page.click('#gd-tabs [data-tab="produksi"]');
  await expect(page.locator('#prd-table tbody tr[data-id]').first()).toBeVisible();
  await expect(page.locator('#prd-add')).toHaveCount(0);
  await page.evaluate(() => { GD.tab = 'repack'; RENDER.gudang(); }); // a tab that is not hers falls back to hers
  await expect(page.locator('#gd-tabs [data-tab="bahan"]')).toHaveClass(/on/);
  await expect(page.locator('#rp-form')).toHaveCount(0);
});

test('Arabic: both tabs read in Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await addMaterials(page);
  await openTab(page, 'bahan');
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#gd-tabs [data-tab="bahan"]')).toHaveText('المواد الخام');
  await expect(page.locator('#gd-tabs [data-tab="produksi"]')).toHaveText('إنتاج المخزون');
  await page.click('#gd-tabs [data-tab="bahan"]');
  await expect(page.locator('#bb-table thead')).toContainText('يُستخدم في');
  await expect(bbRow(page, 'Plastik vakum').locator('[data-col="stock"]')).toHaveText('قائمة أسعار');
  await expect(bbRow(page, 'Stiker Kurma 500 g').locator('[data-col="kind"]')).toHaveText('مستلزم تعبئة');
  await page.click('#gd-tabs [data-tab="produksi"]');
  await expect(page.locator('#prd-table thead')).toContainText('المخزون المصدر');
  await expect(page.locator('#prd-table tbody tr[data-id] [data-col="status"]').first()).toHaveText('مكتمل');
  await expect(page.locator('#prd-days [data-n="month"]')).toHaveText('هذا الشهر');
  await page.evaluate(() => setLang('id'));
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  test('375 px: both tabs fit (no horizontal page scroll); screenshots', async ({ page }) => {
    await login(page, 'Pemilik', '1234', '', { stay: true });
    await addMaterials(page);
    await nav(page, 'gudang');
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#view-gudang').scrollWidth <= document.querySelector('#view-gudang').clientWidth + 1);
    await page.click('#gd-tabs [data-tab="bahan"]');
    await expect(bbRow(page, 'Stiker Kurma 500 g')).toBeVisible();
    expect(await noScroll()).toBe(true);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, 'phone-gudang-bahan.png') });
    await page.click('#gd-tabs [data-tab="produksi"]');
    await expect(page.locator('#prd-table tbody tr[data-id]').first()).toBeVisible();
    expect(await noScroll()).toBe(true);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, 'phone-gudang-produksi.png') });
    await page.click('#tb-lang');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#prd-table thead')).toContainText('المخزون الناتج');
    expect(await noScroll()).toBe(true);
    await page.click('#tb-lang');
  });
});
