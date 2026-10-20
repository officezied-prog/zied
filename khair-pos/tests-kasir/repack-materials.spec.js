// v63 (owner 2026-10-20: «عند استقبال أي بضاعة تدخل إلى المحل يتم كتابة ثمنها ونوعها ولأي شيء تستعمل … ستيكر عجوة 250 غرام، هناك كم ثمن
// الحبة الواحدة، يتم إدخاله عند استقبال البضاعة من الموظف الاستقبال أو الكاشير … أو أيضا العلبة التي يتم فيها التعليب»): a packaging
// material comes in at goods-in like any goods — its price per piece is the note's cost — with the packs it is for. It is never sold;
// the repack form shows how many pieces a repack takes and the stock; the manager's confirmation uses them up.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const ADD = `
  const nid = () => (db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1);
  if (db.products.some(p => p.sku === 'MTB1')) return;
  const base = { category: 'Kurma', wholesale_price: 0, wholesale_min_qty: 0, min_stock: 0, active: true, notes: '' };
  const b = Object.assign({ id: nid(), sku: 'MTB1', name: 'Kurma Ajwa Curah 5 kg', unit: 'kg', cost_price: 100000, retail_price: 150000, stock: 20, shop_stock: 0, repack_from: 0, repack_qty: 0 }, base);
  db.products.push(b);
  db.products.push(Object.assign({ id: nid(), sku: 'MTP1', name: 'Kurma Ajwa 500 g', unit: 'pak', cost_price: 0, retail_price: 70000, stock: 0, shop_stock: 0, repack_from: b.id, repack_qty: 0.5 }, base));
  db.products.push(Object.assign({ id: nid(), sku: 'MTP2', name: 'Kurma Ajwa 250 g', unit: 'pak', cost_price: 0, retail_price: 38000, stock: 0, shop_stock: 0, repack_from: b.id, repack_qty: 0.25 }, base));
`;
const NOTE = items => ({ supplier: 'Percetakan Jaya', date: '', invoice_no: 'PJ-063', total: 0, items });
const prod = (db, re) => db.products.find(p => re.test(p.name));

test('goods-in: a sticker comes in as a packaging material (packs it is for, price per piece from the note); never sold; the repack uses it up', async ({ page, context }) => {
  await H.openKasir(page);
  await H.setDb(page, ADD);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE([{ name: 'STIKER LOGO KHAIR', qty: 100, unit: 'pcs', unit_price: 300, total: 30000 }]));
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await page.click('#pu-newprod-0');
  const m = page.locator('#new-product');
  await expect(m.locator('#np-name')).toHaveValue('Stiker Logo Khair');
  // a material: no category, size or selling price — the packs it is for instead
  await m.locator('#np-kind-mat').check();
  await expect(m.locator('#np-mat')).toBeVisible();
  await expect(m.locator('#np-sale-f')).toBeHidden();
  await expect(m.locator('[data-np-pack]')).toHaveCount(2);
  await m.locator('#np-ok').click();
  await expect(m.locator('#np-err')).toContainText('Pilih minimal satu kemasan');
  const db0 = await H.getDb(page), p500 = prod(db0, /Ajwa 500 g/), p250 = prod(db0, /Ajwa 250 g/);
  await m.locator(`[data-np-use="${p500.id}"]`).check();
  await m.locator(`[data-np-use="${p250.id}"]`).check();
  await H.shot(page, 'phone-v63-material', false, { noToasts: true });
  await m.locator('#np-ok').click();
  await expect(m).toHaveCount(0);
  let db = await H.getDb(page);
  const st = prod(db, /^Stiker Logo Khair$/);
  expect(st).toMatchObject({ category: 'Bahan kemasan', retail_price: 0, cost_price: 300, stock: 0 });
  expect(JSON.parse(st.use_for).sort((a, b) => a.p - b.p)).toEqual([{ p: p500.id, q: 1 }, { p: p250.id, q: 1 }].sort((a, b) => a.p - b.p));
  // the goods-in saves the stickers with their price per piece
  await H.pickCarrier(page);
  await page.locator('[data-pu-expnone="0"]').check(); // a sticker does not expire
  await page.click('#pu-save');
  await expect(page.locator('#pu-res')).toContainText('Barang masuk tersimpan');
  db = await H.getDb(page);
  expect(prod(db, /^Stiker Logo Khair$/).stock).toBe(100);

  // never sold: not on the sale screen, not found by its name there
  await H.tab(page, 'sell');
  await page.fill('#q', 'stiker logo');
  await expect(page.locator('#grid .pc')).toHaveCount(0);
  await page.fill('#q', '');
  const refused = await page.evaluate(id => api('save_sale', { client_id: 'mat-1', items: [{ product_id: id, qty: 1 }], payment_method: 'tunai', amount_paid: 1000 }).then(() => '', e => String(e.message || e)), st.id);
  expect(refused).toContain('bahan kemasan');

  // the repack form (after a fresh bootstrap) shows the sticker each pack takes and its stock
  await page.evaluate(() => refreshData && refreshData());
  await H.tab(page, 'more');
  await page.click('#m-repack');
  await H.pick(page, 'rk-bulk', 'ajwa curah', prod(db, /Curah 5 kg/).id);
  await H.pick(page, 'rk-pack', '500', p500.id);
  await expect(page.locator('#rk-gmats')).toContainText('Stiker Logo Khair: 1 / pak');
  await page.fill('#rk-amount', '5');
  await expect(page.locator('#rk-calc #rk-gmats')).toContainText('Stiker Logo Khair: 10');
  await expect(page.locator('#rk-calc #rk-gmats')).toContainText('Stok 100');
  await expect(page.locator('#rk-calc [data-mat-short]')).toHaveCount(0);
  await page.fill('#rk-amount', '60');
  await expect(page.locator('#rk-calc [data-mat-short]')).toContainText('stok Stiker Logo Khair kurang (ada 100)');
  await page.fill('#rk-amount', '5');
  await page.click('#rk-ok');
  await expect(page.locator('#rk-done')).toBeVisible();
  expect(prod(await H.getDb(page), /^Stiker Logo Khair$/).stock).toBe(100); // used only when the manager confirms

  // the manager confirms the 10 packs made → 10 stickers leave their stock, the owner is told the cost of one pack
  await H.closeModals(page);
  await H.setDb(page, `db.shifts.filter(x => x.cashier === 'Jihan' && x.status === 'open').forEach(x => { x.status = 'closed'; x.closed_at = new Date().toISOString(); x.counted_cash = x.opening_cash; });`);
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await H.tab(p2, 'more');
  await p2.click('#m-repack');
  await p2.locator('#rk-open-list [data-act="rk-fin"]').first().click();
  await expect(p2.locator('#rkf-gmats')).toContainText('Stiker Logo Khair: 10');
  await p2.click('#rkf-ok');
  await expect(p2.locator('#rk-fin-modal')).toHaveCount(0);
  db = await H.getDb(p2);
  expect(prod(db, /^Stiker Logo Khair$/).stock).toBe(90);
  expect(db.purchases.find(r => r.supplier === 'KEMAS ULANG' && r.product_id === st.id).qty).toBe(-10);
  const own = db.activity.filter(a => a.kind === 'notifikasi' && a.ref === 'owner' && /bahan: Stiker Logo Khair 10/.test(a.summary));
  expect(own.length).toBe(1);
  expect(own[0].summary).toMatch(/biaya per pak: Rp 50\.300 \(curah Rp 50\.000, bahan Rp 300\)$/);
});

test('every new v63 text exists in Indonesian and Arabic', async ({ page }) => {
  await H.login(page);
  const missing = await page.evaluate(() => {
    const I = window.KASIR.I18N;
    const keys = ['newp.kind', 'newp.k_sale', 'newp.k_mat', 'newp.mat_for', 'newp.mat_hint', 'newp.mat_q', 'newp.mat_none', 'newp.need_for', 'sell.material', 'rk.gmats', 'rk.gmats_use', 'rk.gmat_short'];
    return keys.filter(k => !I.id[k] || !I.ar[k] || I.ar[k] === I.id[k]);
  });
  expect(missing).toEqual([]);
});
