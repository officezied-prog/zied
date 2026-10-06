// v16 Warehouse (gudang) vs shop shelf (toko): Total / Gudang / Rak columns, "Ada di gudang, rak kosong", "Pindah ke rak"
// (move_stock both ways), goods-in adds to the warehouse only, POS refuses goods not on the shelf (NOT_ON_SHELF) and offers
// to move them, sell_from_shop_only setting, queued offline sales never refused (jual_tanpa_rak).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, asUser, addBySearch, checkoutSkip, editDb, closeModals, CARRIER } = require('./helpers');

const shelf = p => p.shop_stock === undefined || p.shop_stock === null || p.shop_stock === '' ? p.stock : Math.min(p.shop_stock, p.stock);
const fq = q => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(q);
const P = (db, re) => db.products.find(p => re.test(p.name));
function sale(p, qty, extra) {
  return Object.assign({ client_id: 'sh-' + Math.random().toString(36).slice(2), sale_date: jktToday(), items: [{ product_id: p.id, qty, unit_price: p.retail_price, price_type: 'eceran' }], discount: 0, payment_method: 'tunai', paid_amount: qty * p.retail_price }, extra || {});
}
async function openList(page) {
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="list"]');
  await expect(page.locator('#gd-table')).toBeVisible();
}

test('Gudang list: Total / Gudang / Rak, filter "rak kosong", highlight; Pindah ke rak and back; logged pindah_stok', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  let db = await getDb(page);
  const kab = P(db, /Bumbu Kabsah/), empty = db.products.filter(p => p.active !== false && shelf(p) <= 0 && p.stock - shelf(p) > 0);
  expect(empty.length).toBeGreaterThan(1);
  await openList(page);
  const row = page.locator(`#gd-table tr[data-pid="${kab.id}"]`);
  await expect(row.locator('[data-col="stock"]')).toContainText(fq(kab.stock));
  await expect(row.locator('[data-col="gudang"]')).toHaveText(fq(kab.stock));
  await expect(row.locator('[data-col="rak"] b')).toHaveText('0');
  await expect(row).toHaveClass(/shelf-empty/);
  await page.click('[data-act="gd-status"][data-status="rak_kosong"]');
  await expect(page.locator('#gd-table tbody tr[data-pid]')).toHaveCount(empty.length);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-gudang-shelf.png') });

  // → Rak on the row: 5 to the shelf
  await row.locator('[data-act="gd-move-one"]').click();
  await expect(page.locator('#move-modal')).toBeVisible();
  await page.locator('#move-modal [data-mv-qty="0"]').fill(String(kab.stock + 1));
  await page.click('#mv-save');
  await expect(page.locator('#mv-err')).toContainText('gudang kurang');
  await page.locator('#move-modal [data-mv-qty="0"]').fill('5');
  await page.fill('#mv-note', 'isi rak bumbu');
  await page.click('#mv-save');
  await expect(page.locator('#move-modal')).toHaveCount(0);
  db = await getDb(page);
  expect(P(db, /Bumbu Kabsah/)).toMatchObject({ stock: kab.stock, shop_stock: 5 });
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'pindah_stok', summary: expect.stringContaining('Gudang → toko: Bumbu Kabsah 100 g 5') });
  await page.click('[data-act="gd-status"][data-status=""]');
  await expect(row.locator('[data-col="rak"] b')).toHaveText('5');
  await expect(row).not.toHaveClass(/shelf-empty/);
  // back to the warehouse from the toolbar
  await page.click('#gd-move');
  await page.click('#mv-to [data-to="gudang"]');
  await page.selectOption('#mv-add', String(kab.id));
  await page.locator('#move-modal [data-mv-qty="0"]').fill('2');
  await page.click('#mv-save');
  await expect(page.locator('#move-modal')).toHaveCount(0);
  expect(P(await getDb(page), /Bumbu Kabsah/).shop_stock).toBe(3);
  // server rules: NOT_IN_GUDANG with the reason; sales accounts cannot move
  const zaa = P(db, /Za'atar/);
  expect(await asUser(page, 'Pemilik', '1234', 'move_stock', { to: 'toko', lines: [{ product_id: P(db, /Kurma Ajwa/).id, qty: 1 }] })).toMatchObject({ error: 'NOT_IN_GUDANG', message: expect.stringContaining('belum ada barang masuk dengan nota') });
  expect(await asUser(page, 'Ahmad', '4444', 'move_stock', { to: 'toko', lines: [{ product_id: zaa.id, qty: 1 }] })).toMatchObject({ error: 'FORBIDDEN' });
  const mv = await asUser(page, 'Siti', '1111', 'move_stock', { to: 'toko', lines: [{ product_id: zaa.id, qty: 2 }] });
  expect(mv.stock[0]).toMatchObject({ product_id: zaa.id, shop_stock: 2, gudang_stock: zaa.stock - 2 });
  // activity log label + group
  await nav(page, 'activity');
  const ar = page.locator('#act-list .act-row[data-kind="pindah_stok"]').first();
  await expect(ar).toContainText('Pindah stok gudang/rak');
  await expect(ar).toHaveAttribute('data-group', 'stok');
  // phone + Arabic
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tb-lang');
  await openList(page);
  await page.click('[data-act="gd-status"][data-status="rak_kosong"]');
  await page.screenshot({ path: path.join(SHOTS, 'phone-gudang-shelf-ar.png') });
});

test('goods-in adds to the warehouse only; a sale above the shelf → NOT_ON_SHELF modal → move & save; setting off; queued sales never refused; void back to the shelf', async ({ page }) => {
  await login(page);
  let db = await getDb(page);
  const ajwa = P(db, /Kurma Ajwa/), before = ajwa.stock;
  const ph = await asUser(page, 'Pemilik', '1234', 'scan_purchase', { image_base64: 'AAAA', mime: 'image/jpeg' });
  await asUser(page, 'Pemilik', '1234', 'save_purchase', { carrier: CARRIER, purchase_date: jktToday(), supplier: 'PT Uji Rak', photo_id: ph.photo_id, items: [{ product_id: ajwa.id, qty: 10, cost_price: 130000 }], mismatch_reason: 'uji rak' });
  db = await getDb(page);
  expect(P(db, /Kurma Ajwa/)).toMatchObject({ stock: before + 10, shop_stock: before }); // the old stock counts as on the shelf

  // POS: Za'atar has nothing on the shelf
  const zaa = P(db, /Za'atar/);
  await page.evaluate(() => refreshData(true));
  await addBySearch(page, 'za\'atar', 2);
  await page.click('#btn-checkout');
  await expect(page.locator('#shelf-modal')).toBeVisible();
  const r = page.locator(`#ns-table tr[data-pid="${zaa.id}"]`);
  await expect(r).toContainText('Za\'atar');
  await expect(r.locator('td').nth(2)).toHaveText('0');
  await expect(r.locator('td').nth(3)).toHaveText(fq(zaa.stock));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-pos-not-on-shelf.png') });
  await page.click('#ns-move');
  await expect(page.locator('.modal #receipt')).toBeVisible();
  await closeModals(page);
  db = await getDb(page);
  expect(P(db, /Za'atar/)).toMatchObject({ stock: zaa.stock - 2, shop_stock: 0 });
  const inv = db.sales.slice(-1)[0].invoice_no;
  expect(db.activity.some(a => a.kind === 'pindah_stok' && a.summary.includes('Za\'atar'))).toBe(true);

  // API: the server answer has items; queued offline sales are never refused and logged for the owner
  const kab = P(db, /Bumbu Kabsah/);
  const no = await asUser(page, 'Pemilik', '1234', 'save_sale', sale(kab, 1));
  expect(no).toMatchObject({ error: 'NOT_ON_SHELF' });
  const q = await asUser(page, 'Pemilik', '1234', 'save_sale', sale(kab, 1, { queued: true }));
  expect(q.stock[0]).toMatchObject({ product_id: kab.id, stock: kab.stock - 1 });
  expect(q.stock[0].shop_stock).toBeLessThanOrEqual(0); // server answers shelf − qty (−1); the stored shelf is 0
  db = await getDb(page);
  expect(P(db, /Bumbu Kabsah/).shop_stock).toBe(0);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'jual_tanpa_rak', level: 'warn' });
  // void puts it back on the shelf
  await asUser(page, 'Pemilik', '1234', 'void_sale', { invoice_no: inv, reason: 'uji rak' });
  expect(P(await getDb(page), /Za'atar/)).toMatchObject({ stock: zaa.stock, shop_stock: 2 });

  // setting off: sales from the warehouse are allowed
  await nav(page, 'settings');
  await expect(page.locator('#st-shelf-only')).toBeChecked();
  await page.uncheck('#st-shelf-only');
  await page.click('[data-act="set-save-shelf"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  expect((await getDb(page)).settings.sell_from_shop_only).toBe(false);
  expect((await asUser(page, 'Pemilik', '1234', 'save_sale', sale(kab, 1))).invoice_no).toBeTruthy();
  await page.locator('#st-shelf').screenshot({ path: path.join(SHOTS, 'desktop-settings-shelf.png') });
});
