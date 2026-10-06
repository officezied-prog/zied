// v15: only kasir accounts open the drawer; every opening count goes to the manager/owner for approval (selling goes on);
// closing shows the day in numbers per method and sends it with one tap per WhatsApp number (shop / manager / owner).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use({ ...H.PHONE, permissions: ['clipboard-read', 'clipboard-write'] });

const SETTINGS = `Object.assign(db.settings, { wa_shop_number: '0811-1111-2222', wa_manager_number: '0812 3333 4444', wa_owner_number: '', report_time: '00:00' });`;
/** Four sales in Siti's open shift (tunai, transfer, QRIS, hutang with DP), a cash debt payment and cash out. */
const SALES = `
  const sh = db.shifts.find(x => x.cashier === 'Siti' && x.status === 'open');
  const T = arg.today, mk = (no, method, total, paid, qty, cust) => {
    db.sales.push({ id: 80000 + no, invoice_no: 'KMRPT-' + no, sale_date: T, sale_time: T + 'T10:0' + no + ':00+07:00', cashier: 'Siti', customer_id: cust || null, customer_name: cust ? 'Toko Berkah Condet' : 'Umum', customer_type: 'eceran',
      subtotal: total, discount: 0, total, total_cost: 1, profit: 1, payment_method: method, paid_amount: paid, debt_amount: total - paid, status: 'ok', survey: '[]', notes: '', client_id: 'rpt-' + no, approved_by: '', shift_id: sh.shift_id });
    db.items.push({ invoice_no: 'KMRPT-' + no, sale_date: T, product_id: 20, sku: '', name: 'Gula Pasir 1 kg', qty, unit_price: 1, price_type: 'eceran', cost_price: 1, line_total: total, line_profit: 0, customer_name: '' });
  };
  mk(1, 'tunai', 100000, 100000, 2); mk(2, 'transfer', 250000, 250000, 5); mk(3, 'qris', 75000, 75000, 1.5); mk(4, 'hutang', 200000, 50000, 10, 1);
  db.payments.push({ id: 80001, pay_id: 'PYRPT', pay_date: T, customer_id: 2, customer_name: 'Warung Bu Halimah', amount: 40000, method: 'tunai', note: '', cashier: 'Siti', shift_id: sh.shift_id });
  db.cash_moves.push({ id: 80001, shift_id: sh.shift_id, type: 'out', amount: 20000, note: 'Beli galon', user: 'Siti', time: T + 'T12:00:00+07:00' });
`;
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

test('opening → buka_kas approval (manager approves, selling not blocked); closing report per method; wa.me links; reminder banner', async ({ page, context }) => {
  await H.openKasir(page);
  await H.setDb(page, SETTINGS);
  const lastClosed = (await H.getDb(page)).shifts.filter(x => x.status === 'closed').sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))[0];
  await H.login(page, 'Siti', '1111', { noGoto: true, openingCash: 500000 });
  await expect(page.locator('.toast.ok')).toContainText('menunggu persetujuan manajer');
  let db = await H.getDb(page);
  const sh = db.shifts.find(x => x.cashier === 'Siti' && x.status === 'open');
  const ap = db.approvals.find(a => a.kind === 'buka_kas' && a.ref === sh.shift_id);
  expect(ap).toMatchObject({ status: 'pending', cashier: 'Siti', approver_role: 'manager', total: 500000 });
  expect(JSON.parse(ap.payload)).toEqual({ shift_id: sh.shift_id, opening_cash: 500000, last_counted: lastClosed.counted_cash, last_cashier: lastClosed.cashier });
  expect(ap.summary).toContain('Buka kas Siti: modal awal dihitung Rp 500000');
  expect(db.activity.find(a => a.kind === 'buka_kas' && a.ref === sh.shift_id)).toMatchObject({ user: 'Siti', amount: 500000, level: lastClosed.counted_cash === 500000 ? 'info' : 'warn' });

  // selling is not blocked while the manager has not answered; the reminder shows after report_time
  await expect(page.locator('#v-sell .rep-banner')).toContainText('waktunya tutup kas & kirim laporan');
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  await page.click('#rc-new');
  await H.tab(page, 'kas');
  await expect(page.locator('#kas-open-apr')).toHaveAttribute('data-status', 'pending');
  await expect(page.locator('#kas-open-apr')).toContainText('Modal awal menunggu persetujuan manajer');
  await expect(page.locator('#v-kas .rep-banner')).toBeVisible();

  // the manager approves the opening count on her phone
  const p2 = await context.newPage();
  await p2.addInitScript(() => { localStorage.removeItem('kpos.mock.kasir.session'); });
  await H.login(p2, 'Jihan', '2222');
  await p2.click('#tb-appr');
  const card = p2.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'buka_kas');
  await expect(card).toContainText('Buka kas: Siti');
  await expect(card.locator('[data-buka-kas]')).toContainText(H.rp(500000));
  await expect(card.locator('[data-buka-kas]')).toContainText(H.rp(lastClosed.counted_cash));
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  expect((await H.getDb(p2)).approvals.find(a => a.request_id === ap.request_id)).toMatchObject({ status: 'approved', decided_by: 'Jihan' });
  await p2.close();
  await H.tab(page, 'more');
  await H.tab(page, 'kas');
  await expect(page.locator('#kas-open-apr')).toHaveAttribute('data-status', 'approved');
  await expect(page.locator('#kas-open-apr')).toContainText('disetujui Jihan');

  // the day's sales of this shift (the tasbih sale above is replaced by known numbers)
  await H.setDb(page, `db.sales = db.sales.filter(x => x.shift_id !== db.shifts.find(s => s.cashier === 'Siti' && s.status === 'open').shift_id);` + SALES, { today: today() });
  // expected cash = 500.000 + tunai 150.000 (100.000 + DP 50.000) + cash payment 40.000 − cash out 20.000 = 670.000
  await page.locator('#v-kas .rep-banner [data-act="shift-close"]').click();
  await page.fill('#cs-counted', '660000');
  await page.click('#cs-ok');
  await expect(page.locator('#shift-result')).toContainText('Kurang ' + H.rp(10000));
  await expect(page.locator('#sr-count')).toContainText('4');
  await expect(page.locator('#sr-items')).toContainText('18,5');
  await expect(page.locator('#sr-total')).toContainText(H.rp(625000));
  await expect(page.locator('#sr-m-tunai')).toContainText(H.rp(150000));
  await expect(page.locator('#sr-m-transfer')).toContainText(H.rp(250000));
  await expect(page.locator('#sr-m-qris')).toContainText(H.rp(75000));
  await expect(page.locator('#sr-m-hutang')).toContainText(H.rp(150000));
  await expect(page.locator('#sr-cpay')).toContainText(H.rp(40000));
  await expect(page.locator('#sr-expected')).toContainText(H.rp(670000));
  await expect(page.locator('#sr-counted')).toContainText(H.rp(660000));
  await expect(page.locator('#sr-diff')).toHaveAttribute('data-diff', '-10000');
  await expect(page.locator('#shift-result-modal')).not.toContainText(/laba|profit|modal pokok|HPP/i);
  // one tap per number: shop + manager (the owner has no number → no button)
  const shop = await page.locator('#sr-wa-shop').getAttribute('href');
  const mgr = await page.locator('#sr-wa-manager').getAttribute('href');
  await expect(page.locator('#sr-wa-owner')).toHaveCount(0);
  expect(shop).toMatch(/^https:\/\/wa\.me\/6281111112222\?text=/);
  expect(mgr).toMatch(/^https:\/\/wa\.me\/6281233334444\?text=/);
  const text = decodeURIComponent(shop.split('?text=')[1]);
  expect(text).toBe(decodeURIComponent(mgr.split('?text=')[1]));
  expect(text.split('\n')[0]).toBe('Laporan tutup kas Khair Mart');
  for (const s of ['Kasir: Siti', 'Transaksi: 4', 'Barang terjual: 18,5', 'Penjualan: Rp 625.000', 'Tunai: Rp 150.000', 'Transfer: Rp 250.000', 'QRIS: Rp 75.000', 'Hutang: Rp 150.000',
    'Bayar hutang tunai: Rp 40.000', 'Seharusnya: Rp 670.000', 'Uang di laci (hasil hitung): Rp 660.000', 'Selisih: -Rp 10.000']) expect(text).toContain(s);
  expect(text).not.toMatch(/\*|laba|profit/i);
  await expect(page.locator('#sr-wa-shop')).toHaveAttribute('target', '_blank');
  await H.shot(page, 'phone-39-shift-report', false, { noToasts: true });
  await page.click('#sr-copy-text');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  db = await H.getDb(page);
  expect(db.shifts.find(x => x.shift_id === sh.shift_id)).toMatchObject({ status: 'closed', cash_sales: 150000, transfer_sales: 250000, qris_sales: 75000, debt_sales: 150000, items_qty: 18.5, expected_cash: 670000, difference: -10000 });
  await page.click('#sr-done');
  await expect(page.locator('#gate #shift-open')).toBeVisible();
  await expect(page.locator('.rep-banner:not([hidden])')).toHaveCount(0); // no open shift → no reminder
});

test('owner and manager sell without opening the drawer; open_shift is for kasir accounts only', async ({ page }) => {
  await H.login(page, 'Jihan', '2222');
  await expect(page.locator('#gate')).toBeHidden();
  await H.tab(page, 'kas');
  await expect(page.locator('#kas-mgr-none')).toContainText('Buka kas hanya dari akun kasir');
  await H.tab(page, 'sell');
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const db = await H.getDb(page);
  expect(db.sales[db.sales.length - 1]).toMatchObject({ cashier: 'Jihan', shift_id: '' });
  const codes = await page.evaluate(async () => {
    const r = {};
    for (const [u, pin] of [['Jihan', '2222'], ['Pemilik', '1234']]) {
      try { await apiRaw('open_shift', { opening_cash: 100000 }, { key: 'demo', user: u, pin_hash: await pinHash('demo', u, pin) }); r[u] = 'ok'; } catch (e) { r[u] = e.code; }
    }
    // a kasir without a shift still cannot sell
    try { await apiRaw('save_sale', { client_id: 'x-rina', sale_date: '2026-01-01', items: [{ product_id: 16, qty: 1, unit_price: 25000 }], payment_method: 'tunai', paid_amount: 25000 }, { key: 'demo', user: 'Siti', pin_hash: await pinHash('demo', 'Siti', '1111') }); r.Siti = 'ok'; } catch (e) { r.Siti = e.code; }
    return r;
  });
  expect(codes).toEqual({ Jihan: 'FORBIDDEN', Pemilik: 'FORBIDDEN', Siti: 'SHIFT_REQUIRED' });
});

test('Arabic report; without WhatsApp numbers only "copy text" is offered (message stays Indonesian)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kpos.mock.lang', JSON.stringify('ar')));
  await H.login(page, 'Siti', '1111', { openingCash: 300000 });
  await H.tab(page, 'kas');
  await page.click('#kas-close');
  await page.fill('#cs-counted', '300000');
  await page.click('#cs-ok');
  await expect(page.locator('#shift-result-modal')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#sr-send')).toContainText('انسخ نص التقرير');
  await expect(page.locator('#sr-send .wa-send')).toHaveCount(0);
  await expect(page.locator('#sr-m-qris')).toBeVisible();
  await H.shot(page, 'phone-40-shift-report-ar', false, { noToasts: true });
  await page.click('#sr-copy-text');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Laporan tutup kas');
  expect(text).toContain('Selisih: Rp 0');
});
