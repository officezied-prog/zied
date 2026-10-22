// v72 (owner 2026-10-22) in Khair Kasir:
//  1. «هناك خطاء في العملية الحسابية» — the owner's screenshot: "Garam Himalaya 1 kg" from "Garam Himalaya 25 Kg" (counted in karung) set up as
//     1 karung a pack, so 2 karung showed "2 pcs". The content is read with the sizes in the two names: the wrong set-up blocks the packing
//     (the cashier asks the manager); the manager fixes it with one tap; 2 karung (50 kg) ÷ 1 kg = 50 pcs.
//  2. «في تطبيق الكاشير لا توجد سجل اليومي للعمليات المالية المنجزة و لا سجل الفاتورات» — "Catatan keuangan hari ini" (his own money operations,
//     the cash total hidden while the drawer is open) and "Daftar faktur" (every invoice of a day, search, mine / all, open → receipt, a voided
//     one stamped and never printed again).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const GARAM = `
  const nid = () => (db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1);
  if (db.products.some(p => p.sku === 'GH25')) return;
  const base = { category: 'Garam', wholesale_price: 0, wholesale_min_qty: 0, min_stock: 0, active: true, notes: '' };
  const b = Object.assign({ id: nid(), sku: 'GH25', name: 'Garam Himalaya 25 Kg', unit: 'karung', cost_price: 500000, retail_price: 0, stock: 12, shop_stock: 0, repack_from: 0, repack_qty: 0 }, base);
  db.products.push(b);
  db.products.push(Object.assign({ id: nid(), sku: 'GH1', name: 'Garam Himalaya 1 kg', unit: 'pcs', cost_price: 0, retail_price: 30000, stock: 0, shop_stock: 0, repack_from: b.id, repack_qty: 1 }, base));
`;
// the demo's own sales / payments / expenses of today go, so the counts below are this test's only
const CLEAN_TODAY = `
  const d = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10), inv = new Set(db.sales.filter(x => x.sale_date === d).map(x => x.invoice_no));
  db.sales = db.sales.filter(x => x.sale_date !== d); db.items = db.items.filter(i => !inv.has(i.invoice_no));
  db.payments = db.payments.filter(x => x.pay_date !== d); db.expenses = (db.expenses || []).filter(x => x.expense_date !== d);`;
async function loginClean(page) {
  await H.openKasir(page);
  await H.setDb(page, CLEAN_TODAY);
  await H.login(page, 'Siti', '1111', { noGoto: true });
}
async function openRepack(page) {
  await H.tab(page, 'more');
  await page.click('#m-repack');
  await expect(page.locator('#repack')).toBeVisible();
  const db = await H.getDb(page), bulk = db.products.find(p => p.sku === 'GH25');
  await H.pick(page, 'rk-bulk', 'garam himalaya', bulk.id);
}

test('the screenshot: a 1 kg pack set up as 1 karung blocks the packing; the cashier is told to ask the manager', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, GARAM);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await openRepack(page);
  await expect(page.locator('#rk-pack-info')).toContainText('1 karung / pcs');
  await page.fill('#rk-amount', '2');
  const w = page.locator('#rk-calc [data-size-wrong]');
  await expect(w).toContainText('Isi kemasan salah: tercatat 1 karung per pcs, seharusnya 0,04 karung (1 kg)');
  await expect(w).toContainText('Minta manajer');
  await expect(page.locator('#rk-size-fix')).toHaveCount(0);
  await expect(page.locator('#rk-ok')).toBeDisabled();
  await H.shot(page, 'phone-repack-size-wrong', false, { noToasts: true });
});

test('the manager fixes the content with one tap: 2 karung (50 kg) ÷ 1 kg = 50 pcs, and the packing starts with 50 planned', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, GARAM);
  await H.login(page, 'Jihan', '2222', { noGoto: true });
  await openRepack(page);
  await expect(page.locator('#rk-size-fix')).toContainText('Perbaiki: 1 kg per kemasan');
  await page.click('#rk-size-fix');
  await expect(page.locator('#rk-pack-info')).toContainText('0,04 karung (1 kg) / pcs');
  expect((await H.getDb(page)).products.find(p => p.sku === 'GH1').repack_qty).toBe(0.04);
  await page.fill('#rk-amount', '2');
  await expect(page.locator('#rk-calc')).toContainText('2 karung (50 kg) ÷ 1 kg = 50 pcs');
  await expect(page.locator('#rk-planned')).toHaveAttribute('data-planned', '50');
  await page.fill('#rk-amount', '2,5');
  await expect(page.locator('#rk-planned')).toHaveAttribute('data-planned', '62');
  await page.fill('#rk-amount', '2');
  await H.shot(page, 'phone-repack-size-fixed', false, { noToasts: true });
  await page.click('#rk-ok');
  await expect(page.locator('#rk-done')).toContainText('(rencana 50)');
  expect((await H.getDb(page)).products.find(p => p.sku === 'GH25').stock).toBe(10);
});

test('Catatan keuangan hari ini: my sale, my cash out and my drawer expense — the cash total hidden while the drawer is open', async ({ page }) => {
  await loginClean(page);
  await H.addItem(page, 'ajwa'); // Rp 175.000 cash
  await H.pay(page);
  await page.click('#pay-ok');
  const inv = (await page.locator('#rc-modal [data-rc-no]').textContent()).split(' · ')[0].trim();
  await page.click('#rc-new');
  await H.tab(page, 'kas');
  await page.click('#kas-out');
  await page.fill('#cm-amt', '50000');
  await page.fill('#cm-note', 'Beli galon');
  await page.click('#cm-ok');
  await page.click('#kas-exp');
  await page.selectOption('#ex-cat', 'transport');
  await page.fill('#ex-amt', '25000');
  await page.fill('#ex-note', 'Ongkir');
  await page.click('#ex-ok');
  await expect(page.locator('#kas-cout')).toHaveText('-' + H.rp(75000));
  // another cashier's payment today is not in my log
  await H.setDb(page, `db.payments.push({ id: 9901, pay_id: 'PYX1', pay_date: arg, pay_time: new Date().toISOString(), customer_id: 1, customer_name: 'Toko Lain', amount: 99000, method: 'tunai', cashier: 'Rina', direction: 'in' });`,
    new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10));
  await H.tab(page, 'more');
  await page.click('#m-daylog');
  const dl = page.locator('#day-log');
  await expect(dl.locator('#dl-n')).toContainText('1');
  await expect(dl.locator('#dl-total')).toContainText(H.rp(175000));
  await expect(dl.locator('#dl-cash')).toContainText('tampil setelah laci ditutup');
  await expect(dl.locator('#dl-out')).toContainText(H.rp(25000));
  await expect(dl.locator(`[data-dl-inv="${inv}"]`)).toContainText(H.rp(175000).replace('Rp', '').trim());
  await expect(dl.locator('[data-kind="cash_out"]')).toContainText('Beli galon');
  await expect(dl.locator('[data-kind="exp"]')).toHaveCount(1);
  await expect(dl.locator('[data-kind="exp"]')).toContainText('Ongkir');
  await expect(dl).not.toContainText('Toko Lain');
  await expect(dl).toContainText('tidak bisa dihapus');
  await H.shot(page, 'phone-day-log', false, { noToasts: true });
  // one tap on the sale: its receipt, to print again
  await dl.locator(`[data-dl-inv="${inv}"]`).click();
  await expect(page.locator('#rc-modal #receipt')).toContainText(inv);
  await expect(page.locator('#rc-modal #rc-print')).toBeVisible();
});

test('Daftar faktur: every invoice of the day, search, mine / all; a voided one is stamped and cannot be printed again', async ({ page }) => {
  await loginClean(page);
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  const inv = (await page.locator('#rc-modal [data-rc-no]').textContent()).split(' · ')[0].trim();
  await page.click('#rc-new');
  // Rina sold today too; one of her invoices was voided by the manager
  await H.setDb(page, `
    const s0 = db.sales.find(x => x.invoice_no === arg.inv);
    const mk = (no, status) => ({ ...s0, id: 9900 + no.length + (status === 'void' ? 1 : 0), invoice_no: no, cashier: 'Rina', customer_name: 'Toko Rina', total: 50000, subtotal: 50000, paid_amount: 50000, status, client_id: no });
    db.sales.push(mk('RINA-1', 'ok'), mk('RINA-2', 'void'));
    const it = db.items.find(i => i.invoice_no === arg.inv);
    db.items.push({ ...it, invoice_no: 'RINA-2', qty: 1, unit_price: 50000, line_total: 50000 });`, { inv });
  await H.tab(page, 'more');
  await page.click('#m-invlog');
  const il = page.locator('#inv-log');
  await expect(il.locator('#il-list [data-il-inv]')).toHaveCount(3);
  await expect(il.locator('#il-sum')).toContainText('2 nota');
  await expect(il.locator('[data-il-inv="RINA-2"]')).toContainText('BATAL');
  await H.shot(page, 'phone-invoice-log', false, { noToasts: true });
  await page.click('#il-me');
  await expect(il.locator('#il-list [data-il-inv]')).toHaveCount(1);
  await expect(il.locator(`[data-il-inv="${inv}"]`)).toBeVisible();
  await page.click('#il-all');
  await page.fill('#il-q', 'toko rina');
  await expect(il.locator('#il-list [data-il-inv]')).toHaveCount(2);
  await page.fill('#il-q', 'tidak ada');
  await expect(il.locator('#il-list')).toContainText('Tidak ada nota');
  await page.fill('#il-q', 'RINA-2');
  await il.locator('[data-il-inv="RINA-2"]').click();
  await expect(page.locator('#rc-modal #rc-void')).toContainText('NOTA DIBATALKAN');
  await expect(page.locator('#rc-modal #rc-print')).toHaveCount(0);
  await expect(page.locator('#rc-modal #rc-invoice')).toHaveCount(0);
});

// owner 2026-10-22 (the quantity sheet of "Madu Habbatusauda 1 Kg"): «يجب يكون هناك زر لإمكانية الشراء بالميزان. مثلا أخذ 350 غرام فقط …
// ويوضع في المخزون الباقي من هذا الكيلوغرام … أي طلبية ثانية بالميزان أيضا تحسب وتخصم من هذا العلبة»; and «كل عنصر موجود في الكاشير مثلا عجوة
// تجد فيها كم الكمية الموجودة في الرفوف وكم الكمية الموجودة في المخزن الداخلي … طلبية تكون أكثر من الكمية الموجودة في الرفوف فيتم مباشرة سحبها من المخازن».
const MADU = `
  const nid = () => (db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1);
  if (db.products.some(p => p.sku === 'MHB1')) return;
  db.products.push({ id: nid(), sku: 'MHB1', name: 'Madu Habbatusauda 1 Kg', category: 'Madu', unit: 'pcs', cost_price: 120000, retail_price: 180000, wholesale_price: 0, wholesale_min_qty: 0,
    stock: 12, shop_stock: 2, min_stock: 0, active: true, notes: '', repack_from: 0, repack_qty: 0 });
`;
test('Timbang: 350 g of a 1 kg jar = Rp 63.000 and 0,35 jar out of the stock; the next 250 g come off the same jar; the card shows shelf + storeroom', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, MADU);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await page.fill('#q', 'habbatusauda');
  const card = page.locator('#grid .pc', { hasText: 'Madu Habbatusauda 1 Kg' });
  await expect(card.locator('.st')).toContainText('Rak 2 pcs · Gudang 10 pcs');
  await card.click();
  await expect(page.locator('#qty-sheet #qs-weigh')).toContainText('1 pcs = 1 kg');
  await page.click('#qs-weigh');
  await expect(page.locator('#weight-sheet')).toBeVisible();
  await page.fill('#ws-g', '350');
  await expect(page.locator('#ws-total')).toHaveText(H.rp(63000));
  await expect(page.locator('#ws-up')).toContainText('350 g × Rp 180.000/pcs 1 kg');
  await H.shot(page, 'phone-weigh-jar', false, { noToasts: true });
  await page.click('#ws-ok');
  await H.openCart(page);
  await expect(page.locator('#lines .cl .ws-edit')).toContainText('350 g');
  await page.click('#btn-pay'); // the cart is open: its own pay button
  await expect(page.locator('#pay')).toBeVisible();
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toContainText('350 g × 180.000/1 kg');
  await page.click('#rc-new');
  let p = (await H.getDb(page)).products.find(x => x.sku === 'MHB1');
  expect(p.stock).toBeCloseTo(11.65, 3);
  await expect(card.locator('.st')).toContainText('Rak 1 pcs + 650 g');
  // the next customer: 250 g from the same opened jar
  await card.click();
  await page.click('#qs-weigh');
  await page.fill('#ws-g', '250');
  await expect(page.locator('#ws-total')).toHaveText(H.rp(45000));
  await page.click('#ws-ok');
  await H.pay(page);
  await page.click('#pay-ok');
  await page.click('#rc-new');
  p = (await H.getDb(page)).products.find(x => x.sku === 'MHB1');
  expect(p.stock).toBeCloseTo(11.4, 3);
  expect(p.shop_stock).toBeCloseTo(1.4, 3);
});

test('more than the shelf holds: one tap takes the rest from the storeroom (a recorded move) and adds it to the cart', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, MADU);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await page.fill('#q', 'habbatusauda');
  await page.locator('#grid .pc', { hasText: 'Madu Habbatusauda 1 Kg' }).click();
  await page.fill('#qs-qty', '5');
  await expect(page.locator('#qs-warn')).toContainText('gudang');
  await expect(page.locator('#qs-ok')).toBeDisabled();
  await expect(page.locator('#qs-pull')).toContainText('Ambil 3 pcs dari gudang');
  await page.click('#qs-pull');
  await expect(page.locator('#qty-sheet')).toHaveCount(0);
  await H.openCart(page);
  await expect(page.locator('#lines .cl [data-qty]')).toHaveValue('5');
  const db = await H.getDb(page), p = db.products.find(x => x.sku === 'MHB1');
  expect(p.shop_stock).toBe(5);
  expect(db.activity.some(a => a.kind === 'pindah_stok' && /Madu Habbatusauda 1 Kg 3 pcs/.test(a.summary) && /Diambil langsung dari gudang/.test(a.summary))).toBe(true);
});

// v73 (owner 2026-10-22: «أضف عند إدخال المعطيات أي بضاعة جديدة هل يمكن هذه البضاعة أن تقسم إلى بضائع صغيرة وإعادة التعبئة أم لا؟ يجب أن يجيب
// عنها الموظف … فإن كانت يتم إعادة تعبئتها فتكون في خانة المواد التي يمكن إعادة تعبئتها»)
test('a new product at goods-in: "can it be repacked?" must be answered; yes is kept on the product', async ({ page }) => {
  await H.login(page);
  await H.tab(page, 'masuk');
  await page.fill('#pu-q', 'Gula Pasir Karung 50 Kg');
  await page.click('#pu-newprod-q');
  const m = page.locator('#new-product');
  await expect(m).toBeVisible();
  await m.locator('#np-cat').fill('Gula');
  await m.locator('#np-size').fill('50');
  await m.locator('#np-measure').selectOption('kg');
  await m.locator('#np-unit').selectOption('karung');
  await m.locator('#np-retail').fill('800000');
  await m.locator('#np-ok').click();
  await expect(m.locator('#np-err')).toContainText('Jawab dulu: barang ini bisa dikemas ulang atau tidak?');
  await m.locator('#np-rp-yes').check();
  await H.shot(page, 'phone-new-product-repackable', false, { noToasts: true });
  await m.locator('#np-ok').click();
  await expect(m).toHaveCount(0);
  const p = (await H.getDb(page)).products.find(x => x.name === 'Gula Pasir Karung 50 Kg');
  expect(p.repackable).toBe(true);
  // a packaging material is never repackable: the question is not asked
  await page.fill('#pu-q', 'Stiker Gula');
  await page.click('#pu-newprod-q');
  await m.locator('#np-kind-mat').check();
  await expect(m.locator('#np-rp')).toBeHidden();
});
