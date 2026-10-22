// v36 (owner 2026-10-11):
//  #12 "في فاتورة المصاريف التطبيق يقارن ما كتب وما جاءته من فواتير لضبط عملية الصرف" — expense item lines (item, qty,
//      unit price; sum = amount), compared line by line with the AI-read invoice; every difference in red, a reason,
//      then the manager / accountant approves. Without the AI key: "cek manual", never blocks the cashier.
//  #13 "الكاشير يمكنه إضافة بضاعة جديدة ... عند استلام البضاعة" — a NEW product from goods-in (category + size/weight
//      required), usable at once, flagged "baru — dicek" for the manager / accountant who confirms its prices.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

async function openExpenseForm(page) {
  await H.tab(page, 'kas');
  await page.click('#kas-exp');
  await expect(page.locator('#ex-lines-box')).toBeVisible();
}
async function addLine(page, i, name, qty, price) {
  await page.click('#ex-add-line');
  await page.fill(`[data-exl-name="${i}"]`, name);
  await page.fill(`[data-exl-qty="${i}"]`, String(qty));
  await page.fill(`[data-exl-price="${i}"]`, String(price));
}

test('expense lines vs the read invoice: qty + price differences in red, reason, manager approves → reports show it', async ({ page, context }) => {
  await H.login(page);
  await openExpenseForm(page);
  await page.selectOption('#ex-cat', 'kemasan');
  await page.fill('#ex-amt', '85000');
  await addLine(page, 0, 'Kantong plastik besar', 12, 5000);
  await addLine(page, 1, 'Lakban coklat', 5, 5000);
  await expect(page.locator('#ex-lines-total')).toHaveText(H.rp(85000));
  await expect(page.locator('#ex-lines-off')).toHaveCount(0);
  await expect(page.locator('[data-exl-tot="0"]')).toContainText('60.000');
  // the demo invoice: plastic 10 × 5.000 and tape 5 × 7.000 = 85.000
  await page.setInputFiles('#ex-photo', await H.photoFile(page, 'nota-biaya.png'));
  await expect(page.locator('#ex-slip-ok')).toContainText('Nota terbaca');
  const mm = page.locator('#ex-mismatch');
  await expect(mm).toBeVisible();
  await expect(mm).toHaveAttribute('data-n', '2');
  await expect(mm.locator('#ex-cmp-rows tbody tr').nth(0)).toHaveAttribute('data-bad', 'qty');
  await expect(mm.locator('#ex-cmp-rows tbody tr').nth(1)).toHaveAttribute('data-bad', 'price');
  await expect(mm.locator('td.bad')).toHaveCount(2);
  await expect(mm.locator('#ex-cmp-rows tbody tr').nth(1).locator('td.bad')).toContainText('7.000');
  await expect(page.locator('#ex-use-photo')).toHaveCount(0); // the totals agree, only lines differ
  await H.shot(page, 'phone-v36-expense-mismatch', false, { noToasts: true });
  await page.click('#ex-ok');
  await expect(page.locator('#ex-err')).toContainText('alasan');
  await page.fill('#ex-reason', 'Toko memberi 2 kantong ekstra, harga lakban lama');
  await page.click('#ex-ok');
  await expect(page.locator('#expense')).toHaveCount(0);
  await expect(page.locator('#toasts')).toContainText('manajer / akuntan');
  let db = await H.getDb(page);
  const ex = db.expenses[db.expenses.length - 1];
  expect(ex).toMatchObject({ amount: 85000, category: 'kemasan', check_status: 'selisih' });
  expect(JSON.parse(ex.lines)).toEqual([{ name: 'Kantong plastik besar', qty: 12, unit_price: 5000, total: 60000 }, { name: 'Lakban coklat', qty: 5, unit_price: 5000, total: 25000 }]);
  const ap = db.approvals.find(a => a.request_id === ex.request_id);
  expect(ap).toMatchObject({ kind: 'expense_check', approver_role: 'mgr_akuntan', status: 'pending', cashier: 'Siti' });
  expect(JSON.parse(ap.payload).diffs.map(d => d.field).sort()).toEqual(['price', 'qty']);

  // the manager decides on her phone: the card shows the comparison line by line
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await p2.click('#tb-appr');
  const card = p2.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'expense_check');
  await expect(card).toContainText('beda dengan nota');
  await expect(card.locator('[data-exp-rows] td.bad')).toHaveCount(2);
  await expect(card).toContainText('Toko memberi 2 kantong ekstra');
  await H.shot(p2, 'phone-v36-expense-approval', false, { noToasts: true });
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  db = await H.getDb(p2);
  expect(db.expenses.find(x => x.request_id === ap.request_id)).toMatchObject({ check_status: 'disetujui', checked_by: 'Jihan' });
});

test('expense: line sum must equal the amount; matching invoice → "cocok"; no AI key → "cek manual" saved without blocking', async ({ page }) => {
  await H.login(page);
  await openExpenseForm(page);
  await page.fill('#ex-amt', '90000');
  await addLine(page, 0, 'Kantong plastik besar', 10, 5000);
  await addLine(page, 1, 'Lakban coklat', 5, 7000);
  await expect(page.locator('#ex-lines-off')).toContainText(H.rp(85000));
  await page.click('#ex-ok');
  await expect(page.locator('#ex-err')).toContainText('≠');
  await page.click('#ex-use-lines');
  await expect(page.locator('#ex-amt')).toHaveValue('85.000');
  await expect(page.locator('#ex-lines-off')).toHaveCount(0);
  await page.setInputFiles('#ex-photo', await H.photoFile(page, 'nota-biaya.png'));
  await expect(page.locator('#ex-match-ok')).toBeVisible();
  await expect(page.locator('#ex-match-ok')).toContainText('Cocok dengan nota');
  await page.click('#ex-ok');
  await expect(page.locator('#expense')).toHaveCount(0);
  let db = await H.getDb(page);
  expect(db.expenses[db.expenses.length - 1]).toMatchObject({ amount: 85000, check_status: 'cocok', request_id: '' });
  const nAp = db.approvals.length;

  // the Worker has no AI key: the photo is kept but unread → "cek manual", saved at once (no reason asked)
  await page.evaluate(() => localStorage.setItem('kmock.expscan', 'off'));
  await page.click('#kas-exp');
  await page.selectOption('#ex-cat', 'transport');
  await page.fill('#ex-amt', '25000');
  await addLine(page, 0, 'Ongkir', 1, 25000);
  await page.setInputFiles('#ex-photo', await H.photoFile(page, 'nota-ongkir.png'));
  await expect(page.locator('#ex-manual')).toBeVisible();
  await expect(page.locator('#ex-manual')).toContainText('Cek manual');
  await expect(page.locator('#ex-mismatch')).toHaveCount(0);
  await page.click('#ex-ok');
  await expect(page.locator('#expense')).toHaveCount(0);
  db = await H.getDb(page);
  const ex = db.expenses[db.expenses.length - 1];
  expect(ex).toMatchObject({ amount: 25000, check_status: 'cek_manual' });
  expect(db.approvals.length).toBe(nAp + 1);
  expect(db.approvals.find(a => a.request_id === ex.request_id)).toMatchObject({ kind: 'expense_check', approver_role: 'mgr_akuntan' });
});

test('every new v36 text exists in Indonesian and Arabic', async ({ page }) => {
  await H.login(page);
  const missing = await page.evaluate(() => {
    const I = window.KASIR.I18N;
    return Object.keys(I.id).filter(k => /^(ex\.|newp\.|apr\.(kind_exp|kind_newprod|exp_|newprod))/.test(k)).filter(k => !I.ar[k] || I.ar[k] === I.id[k]);
  });
  expect(missing).toEqual([]);
  // the new-product texts must not overwrite the new-PIN screen's keys (np.*)
  expect(await page.evaluate(() => window.KASIR.I18N.id['np.title'])).toBe('Buat PIN baru');
});

const NOTE = items => ({ supplier: 'PT Zaitun Jaya', date: '', invoice_no: 'ZJ-001', total: 0, items });

test('goods-in: cashier adds a NEW product (category + size/weight required), uses it at once; manager confirms and corrects the price', async ({ page, context }) => {
  await H.login(page);
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE([{ name: 'SIWAK ARAK PREMIUM', qty: 6, unit: 'pak', unit_price: 95000, total: 570000 }]));
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  const line = page.locator('#pu-lines .pu-line').first();
  await expect(line).toHaveClass(/unmatched/);
  await page.click('#pu-newprod-0');
  const m = page.locator('#new-product');
  await expect(m).toBeVisible();
  await expect(m.locator('#np-name')).toHaveValue('Siwak Arak Premium');
  await expect(m.locator('#np-unit')).toHaveValue('pak');
  await expect(m.locator('#np-cost')).toContainText('95.000');
  await m.locator('#np-ok').click();
  await expect(m.locator('#np-err')).toContainText('Kategori');
  await m.locator('#np-cat').fill('Perlengkapan Ibadah');
  await m.locator('#np-ok').click();
  await expect(m.locator('#np-err')).toContainText('Ukuran / berat');
  await m.locator('#np-size').fill('12');
  await m.locator('#np-measure').selectOption('isi');
  await m.locator('#np-ok').click();
  await expect(m.locator('#np-err')).toContainText('Harga jual');
  await m.locator('#np-retail').fill('120000');
  // v73: the cashier must say whether it can be repacked
  await m.locator('#np-ok').click();
  await expect(m.locator('#np-err')).toContainText('bisa dikemas ulang atau tidak');
  await m.locator('#np-rp-no').check();
  await H.shot(page, 'phone-v36-new-product', false, { noToasts: true });
  await m.locator('#np-ok').click();
  await expect(m).toHaveCount(0);
  await expect(line).not.toHaveClass(/unmatched/);
  await expect(line.locator('select[data-pu-prod]')).toHaveValue(/\d+/);
  let db = await H.getDb(page);
  const np = db.products.find(p => p.name === 'Siwak Arak Premium');
  expect(np).toMatchObject({ category: 'Perlengkapan Ibadah', size: 'isi 12', weight: '', unit: 'pak', retail_price: 120000, cost_price: 95000, stock: 0 });
  expect(np.review).toMatch(/^APR-/);
  const ap = db.approvals.find(a => a.request_id === np.review);
  expect(ap).toMatchObject({ kind: 'product_new', approver_role: 'mgr_akuntan', status: 'pending' });
  // usable at once: the goods-in saves with the new product
  await H.pickCarrier(page);
  await H.fillPuExp(page);
  await page.click('#pu-save');
  await expect(page.locator('#pu-res')).toContainText('Barang masuk tersimpan');
  db = await H.getDb(page);
  expect(db.products.find(p => p.id === np.id).stock).toBe(6);

  // the search path: a name that is not in the app → "+ Produk baru"
  await page.fill('#pu-q', 'Sabun Zaitun');
  await page.click('#pu-newprod-q');
  await expect(page.locator('#new-product #np-name')).toHaveValue('Sabun Zaitun');
  await H.closeModals(page);

  // the manager sees the card (no invoice cost), corrects the retail price and confirms
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await p2.click('#tb-appr');
  const card = p2.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'product_new');
  await expect(card).toContainText('Siwak Arak Premium');
  await expect(card).toContainText('Perlengkapan Ibadah');
  await expect(card).not.toContainText('95.000');
  await card.locator('[data-np-price="retail_price"]').fill('125000');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  db = await H.getDb(p2);
  expect(db.products.find(p => p.id === np.id)).toMatchObject({ retail_price: 125000, review: '', active: true });
  expect(db.approvals.find(a => a.request_id === ap.request_id).status).toBe('approved');
});

test('goods-in: the new-product server rules hold in the demo backend too (cashier cannot add outside goods-in; duplicate name refused)', async ({ page }) => {
  await H.login(page);
  const r = await page.evaluate(async () => {
    const who = { key: 'demo', user: 'Siti', pin_hash: await pinHash('demo', 'Siti', '1111') };
    const tryIt = async d => { try { await apiRaw('save_product', d, who); return 'ok'; } catch (e) { return e.code + ':' + e.message; } };
    return [
      await tryIt({ name: 'Produk X', category: 'Lain', size: '1 kg', retail_price: 1000 }),
      await tryIt({ name: 'kurma ajwa al-madinah 1 KG', category: 'Kurma', weight: '1 kg', retail_price: 1000, from_goods_in: true }),
      await tryIt({ name: 'Produk Y', category: 'Lain', retail_price: 1000, from_goods_in: true })
    ];
  });
  expect(r[0]).toMatch(/^FORBIDDEN/);
  expect(r[2]).toMatch(/Ukuran atau berat/);
  expect(r[1]).toMatch(/sudah ada/);
});
