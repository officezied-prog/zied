// v16 warehouse (gudang) vs shop shelf (rak): only goods on the shelf can be sold; goods-in lands in the warehouse; the
// cashier moves goods to the shelf with "Pindah ke rak" (move_stock). The server refuses with NOT_ON_SHELF (items[]) and
// NOT_IN_GUDANG; a sale already paid offline is replayed with queued: true and never refused (logged for the owner).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const NOTE = items => ({ supplier: 'CV Timur Tengah Food', date: '', invoice_no: 'TTF-8812', total: 0, items });
const setShelf = (page, re, shop, stock) => H.setDb(page, `const p = db.products.find(p => new RegExp(arg.re).test(p.name)); p.shop_stock = arg.shop; if (arg.stock != null) p.stock = arg.stock;`, { re, shop, stock });
const refresh = page => page.evaluate(() => refreshData(true));

test('cart refuses goods not on the shelf; server NOT_ON_SHELF → "Pindah ke rak" → the sale goes through', async ({ page }) => {
  await H.login(page);
  await setShelf(page, 'Medjool', 1, 20);
  await setShelf(page, 'Ajwa', 0, 0);
  await refresh(page);

  // the grid card and the quantity sheet show shelf and warehouse
  await page.fill('#q', 'medjool');
  const card = page.locator('#grid .pc').first();
  await expect(card.locator('.st')).toHaveAttribute('data-shelf', '1');
  await expect(card.locator('.st')).toContainText('Rak 1 kg');
  await expect(card.locator('.st')).toContainText('Gudang 19');
  await card.click();
  await expect(page.locator('#qs-stock')).toContainText('Rak 1 kg');
  await expect(page.locator('#qs-stock')).toContainText('Gudang 19');
  await page.fill('#qs-qty', '3');
  await expect(page.locator('#qs-warn')).toContainText('belum di rak — pindahkan dari gudang dulu');
  await expect(page.locator('#qs-ok')).toBeDisabled();
  await page.fill('#qs-qty', '1');
  await expect(page.locator('#qs-ok')).toBeEnabled();
  await page.click('#qs-ok');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
  await page.fill('#q', '');

  // nothing on the shelf and nothing in the warehouse: no goods-in with a supplier note yet
  await page.fill('#q', 'ajwa');
  await page.locator('#grid .pc').first().click();
  await expect(page.locator('#qs-warn')).toContainText('belum ada barang masuk dengan nota');
  await expect(page.locator('#qs-ok')).toBeDisabled();
  await H.closeModals(page);
  await page.fill('#q', '');

  // meanwhile the last one on the shelf was sold at another till: the server refuses with the list
  await setShelf(page, 'Medjool', 0);
  const db0 = await H.getDb(page);
  const med = H.productByName(db0, /Medjool/);
  await H.pay(page);
  await page.click('#pay-ok');
  const nos = page.locator('#not-on-shelf');
  await expect(nos).toBeVisible();
  await expect(nos).toContainText('Penjualan ditolak');
  const row = nos.locator('#nos-items tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Kurma Medjool Jumbo 1 kg');
  await expect(row.locator('td').nth(1)).toHaveText('1');
  await expect(row.locator('td').nth(2)).toHaveText('0');
  await expect(row.locator('td').nth(3)).toHaveText('20');
  await H.shot(page, 'phone-48-not-on-shelf', false, { noToasts: true });
  expect((await H.getDb(page)).sales.length).toBe(db0.sales.length);

  // → the move screen opens with what is missing on the shelf
  await page.click('#nos-move');
  const mv = page.locator('#move-stock');
  await expect(mv).toBeVisible();
  await expect(mv.locator('#mv-to-toko')).toHaveClass(/on/);
  await expect(mv.locator(`[data-mv-qty="${med.id}"]`)).toHaveValue('1');
  await mv.locator(`[data-mv-qty="${med.id}"]`).fill('25');
  await page.click('#mv-ok');
  await expect(mv.locator('#mv-err')).toContainText('di gudang hanya 20');
  await mv.locator(`[data-mv-qty="${med.id}"]`).fill('4');
  await page.fill('#mv-note', 'Rak kurma depan');
  await expect(mv.locator('#mv-ok')).toContainText('Pindahkan ke rak (1)');
  await H.shot(page, 'phone-49-move-stock', false, { noToasts: true });
  await page.click('#mv-ok');
  await expect(mv).toHaveCount(0);
  await expect(page.locator('#toasts')).toContainText('1 barang dipindah ke rak');
  let db = await H.getDb(page);
  expect(H.productByName(db, /Medjool/)).toMatchObject({ stock: 20, shop_stock: 4 });
  expect(db.activity.find(a => a.kind === 'pindah_stok')).toMatchObject({ user: 'Siti', level: 'info' });
  expect(db.activity.find(a => a.kind === 'pindah_stok').summary).toContain('Gudang → toko: Kurma Medjool Jumbo 1 kg 4 kg | Rak kurma depan');

  // the payment window is still open: the sale now goes through and takes it off the shelf
  await expect(page.locator('#pay')).toBeVisible();
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  db = await H.getDb(page);
  expect(db.sales.length).toBe(db0.sales.length + 1);
  expect(H.productByName(db, /Medjool/)).toMatchObject({ stock: 19, shop_stock: 3 });
});

test('move screen: back to the warehouse; NOT_IN_GUDANG from the server; the API refuses what is not there', async ({ page }) => {
  await H.login(page);
  await setShelf(page, 'Medjool', 2, 10);
  await refresh(page);
  const med = H.productByName(await H.getDb(page), /Medjool/);
  await H.tab(page, 'masuk');
  await expect(page.locator('#mv-open-n')).toBeVisible();
  await page.click('#mv-open');
  const mv = page.locator('#move-stock');
  await expect(mv.locator('#mv-hint')).toContainText('Barang masuk ada di gudang');
  await page.fill('#mv-q', 'medjool');
  await mv.locator(`[data-mv-add="${med.id}"]`).click();
  await expect(mv.locator(`[data-mv-qty="${med.id}"]`)).toHaveValue('8');
  await expect(mv.locator(`[data-mv-line="${med.id}"]`)).toContainText('Di gudang: 8 kg');

  // the warehouse emptied at the same time (another device): the server refuses
  await setShelf(page, 'Medjool', 2, 5);
  await page.click('#mv-ok');
  await expect(mv.locator('#mv-err')).toContainText('Tidak bisa pindah ke toko — stok gudang kurang: Kurma Medjool Jumbo 1 kg: gudang 3');
  expect(H.productByName(await H.getDb(page), /Medjool/)).toMatchObject({ stock: 5, shop_stock: 2 });

  // shelf → warehouse
  await mv.locator('#mv-to-gudang').click();
  await expect(mv.locator('#mv-lines [data-mv-line]')).toHaveCount(0);
  await expect(mv.locator('#mv-hint')).toContainText('Kembalikan barang dari rak');
  await page.fill('#mv-q', 'medjool');
  await mv.locator(`[data-mv-add="${med.id}"]`).click();
  await expect(mv.locator(`[data-mv-qty="${med.id}"]`)).toHaveValue('2');
  await expect(mv.locator('#mv-ok')).toContainText('Kembalikan ke gudang (1)');
  await page.click('#mv-ok');
  await expect(mv).toHaveCount(0);
  expect(H.productByName(await H.getDb(page), /Medjool/)).toMatchObject({ stock: 5, shop_stock: 0 });

  // the API directly: errors as on the server
  const r = await page.evaluate(async id => {
    const out = {};
    for (const [k, d] of Object.entries({ none: { to: 'toko', lines: [] }, zero: { to: 'toko', lines: [{ product_id: id, qty: 0 }] }, gudang: { to: 'toko', lines: [{ product_id: id, qty: 3 }, { product_id: id, qty: 3 }] }, rak: { to: 'gudang', lines: [{ product_id: id, qty: 1 }] } })) {
      try { await api('move_stock', d); out[k] = 'ok'; } catch (e) { out[k] = e.code; }
    }
    return out;
  }, med.id);
  expect(r).toEqual({ none: 'INVALID', zero: 'INVALID', gudang: 'NOT_IN_GUDANG', rak: 'NOT_ON_SHELF' });
});

test('goods-in lands in the warehouse → "Pindahkan ke rak sekarang"', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const med = H.productByName(db0, /Medjool/), shop0 = med.shop_stock ?? med.stock;
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE([{ name: 'KURMA MEDJOOL JUMBO 1KG', qty: 6, unit: 'kg', unit_price: 170000, total: 1020000 }]));
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-ok')).toContainText('1 baris');
  await expect(page.locator('#pu-match-box')).toHaveAttribute('data-status', 'cocok');
  await H.pickCarrier(page);
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-match')).toHaveText('Cocok dengan nota');
  let db = await H.getDb(page);
  expect(H.productByName(db, /Medjool/)).toMatchObject({ stock: med.stock + 6, shop_stock: shop0 }); // in the warehouse, not on the shelf
  await expect(page.locator('#mv-open-n')).toBeVisible();
  await expect(page.locator('#pu-res-move')).toHaveText(/Pindahkan ke rak sekarang/);
  await H.shot(page, 'phone-50-goodsin-move-now', false, { noToasts: true });
  await page.click('#pu-res-move');
  const mv = page.locator('#move-stock');
  await expect(mv).toBeVisible();
  await expect(mv.locator('#mv-lines [data-mv-line]')).toHaveCount(1);
  await expect(mv.locator(`[data-mv-qty="${med.id}"]`)).toHaveValue('6');
  await page.click('#mv-ok');
  await expect(mv).toHaveCount(0);
  db = await H.getDb(page);
  expect(H.productByName(db, /Medjool/)).toMatchObject({ stock: med.stock + 6, shop_stock: shop0 + 6 });
});

test('a sale paid offline is replayed with queued: true and never refused for the shelf (logged jual_tanpa_rak)', async ({ page, context }) => {
  await H.login(page);
  await setShelf(page, 'Ajwa', 2, 10);
  await refresh(page);
  await context.setOffline(true);
  await H.addItem(page, 'ajwa', { qty: 2 });
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-state')).toContainText('offline');
  await page.click('#rc-new');
  await expect(page.locator('#tb-outbox-n')).toHaveText('1');
  // the queued sale took the shelf locally: no more Ajwa can be sold
  await page.fill('#q', 'ajwa');
  await expect(page.locator('#grid .pc').first().locator('.st')).toHaveAttribute('data-shelf', '0');
  await page.locator('#grid .pc').first().click();
  await expect(page.locator('#qs-warn')).toContainText('belum di rak — pindahkan dari gudang dulu');
  await H.closeModals(page);
  await page.fill('#q', '');

  // another till sold the shelf empty in the meantime; the replay still goes through
  await setShelf(page, 'Ajwa', 0);
  const db0 = await H.getDb(page);
  await context.setOffline(false); // 'online' → the outbox replays save_sale with queued: true
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 10000 });
  const db = await H.getDb(page);
  expect(db.sales.length).toBe(db0.sales.length + 1);
  const inv = db.sales[db.sales.length - 1].invoice_no;
  expect(H.productByName(db, /Ajwa/)).toMatchObject({ stock: 8, shop_stock: 0 });
  const act = db.activity.find(a => a.kind === 'jual_tanpa_rak' && a.ref === inv);
  expect(act).toMatchObject({ user: 'Siti', level: 'warn' });
  expect(act.summary).toContain('tersimpan offline');
});
