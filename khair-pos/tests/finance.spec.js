// v67 (owner 2026-10-20, majoo screenshots: «اضف هذه المميزات»): Keuangan — the "Laba rugi" line chart and P&L table of a period (the
// same numbers as Laporan for the same range), "Saldo kas & bank" as of now (the drawers, each store account from the owner's saldo awal,
// the money with no account apart) and the "Neraca" (cash & bank, receivables, stock at cost, supplier debt, equity). Owner and
// accountant; the manager only when the owner lets her see costs (the server refuses her otherwise).
const { test, expect } = require('@playwright/test');
const { jktToday, login, getDb, nav, openApp, enterKey, staffSession, editDb, asUser } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (Math.round(n) < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
const T = jktToday(), M0 = T.slice(0, 8) + '01';
const int = v => Math.round(Number(v) || 0);
const of = s => { // KPay.of: what a sale brought in by method
  const o = { tunai: 0, transfer: 0, qris: 0, kartu: 0 };
  let p = null; if (s.payment_method === 'campur') { try { p = typeof s.pay_parts === 'string' ? JSON.parse(s.pay_parts || '[]') : s.pay_parts; } catch (e) { p = null; } }
  if (Array.isArray(p) && p.length) { p.forEach(x => { if (o[x.m] !== undefined) o[x.m] += int(x.a); }); return o; }
  o[o[s.payment_method] !== undefined ? s.payment_method : 'tunai'] += Math.min(int(s.paid_amount), int(s.total));
  return o;
};

async function openFinance(page) {
  await nav(page, 'finance');
  await expect(page.locator('#fin-pl-table')).toBeVisible();
  await expect(page.locator('#fin-bs')).toBeVisible();
}
async function addAccountant(page, cost) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg.h, active: true }); db.settings.akuntan_sees_cost = arg.c;`, { h: hash, c: cost });
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
}
/** A customer return approved this month (money back + a good item back on the shelf) and an undercharge the owner decided to collect. */
async function addExtras(page) {
  await openApp(page);
  await editDb(page, `
    const s = db.sales.find(x => x.status !== 'void' && x.sale_date >= arg.m0 && x.sale_date <= arg.t), it = db.items.find(i => i.invoice_no === s.invoice_no);
    db.returns = db.returns || [];
    db.returns.push({ id: 9901, return_id: 'RT-FIN1', kind: 'pelanggan', status: 'approved', return_date: arg.t, ref: s.invoice_no, party_id: 0, party_name: 'Umum', refund: 35000, refund_method: 'tunai', lines: JSON.stringify([{ product_id: it.product_id, qty: 1, condition: 'baik' }]) });
    db.approvals.push({ id: 9902, request_id: 'APFIN1', kind: 'konsultasi', status: 'approved', total: 12000, created_at: new Date().toISOString(), decided_at: new Date().toISOString(), decided_by: 'Pemilik', payload: '{}' });`, { m0: M0, t: T });
}

test('owner: the month\'s laba rugi (chart + table) equals Laporan; the demo numbers; day / week / month; CSV', async ({ page }) => {
  await addExtras(page);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db = await getDb(page);
  const ok = db.sales.filter(s => s.status !== 'void' && s.sale_date >= M0 && s.sale_date <= T);
  const omzet = ok.reduce((a, s) => a + s.total, 0), disc = ok.reduce((a, s) => a + int(s.discount), 0), laba = ok.reduce((a, s) => a + s.profit, 0);
  const exps = db.expenses.filter(x => x.expense_date >= M0 && x.expense_date <= T), expT = exps.reduce((a, x) => a + int(x.amount), 0);
  const ret = db.returns.find(r => r.return_id === 'RT-FIN1'), retP = db.products.find(p => p.id === JSON.parse(ret.lines)[0].product_id);
  const adj = db.purchases.filter(r => ['STOK OPNAME', 'PENYESUAIAN STOK'].includes(String(r.supplier).toUpperCase()) && r.purchase_date >= M0 && r.purchase_date <= T).reduce((a, r) => a + Math.round(r.qty * r.cost_price), 0);
  const net = laba - expT - 35000 + retP.cost_price + adj + 12000;
  await openFinance(page);
  const row = k => page.locator(`#fin-pl-table [data-fin-pl="${k}"] td.r`);
  await expect(row('gross_sales')).toHaveText(rp(omzet + disc));
  await expect(row('disc')).toHaveText(rp(-disc));
  await expect(row('ret')).toHaveText(rp(-35000));
  await expect(row('net_sales')).toHaveText(rp(omzet - 35000));
  await expect(row('hpp')).toHaveText(rp(-(omzet - laba - retP.cost_price)));
  await expect(row('gross')).toHaveText(rp(laba - 35000 + retP.cost_price));
  await expect(row('exp_total')).toHaveText(rp(-expT));
  await expect(row('exp_sewa')).toHaveText(rp(-exps.filter(x => x.category === 'sewa').reduce((a, x) => a + x.amount, 0)));
  await expect(row('collected')).toHaveText(rp(12000));
  await expect(row('net')).toHaveText(rp(net));
  // the chart: three lines, the zero line, a <title> on every point, x labels thinned
  const days = Math.round((Date.parse(T) - Date.parse(M0)) / 86400000) + 1;
  await expect(page.locator('#fin-chart polyline')).toHaveCount(3);
  await expect(page.locator('#fin-chart [data-fin-zero]')).toHaveCount(1);
  await expect(page.locator('#fin-chart rect[data-fin-hit]')).toHaveCount(days);
  expect(await page.locator('#fin-chart [data-fin-mark="net"] title').count()).toBe(days);
  expect(await page.locator('#fin-chart text[text-anchor="middle"]').count()).toBeLessThanOrEqual(15);
  await expect(page.locator('#fin-legend [data-fin-lg="exp"]')).toContainText(rp(expT));
  await expect(page.locator('#fin-kpis [data-kpi="fin-net"]')).toContainText(rp(net));
  await page.locator('#fin-chart rect[data-fin-hit]').last().click({ force: true });
  await expect(page.locator('#fin-readout')).toContainText('Laba bersih');
  await page.click('[data-act="fin-group"][data-g="week"]');
  const weeks = new Set(); for (let i = 0; i < days; i++) { const d = new Date(Date.parse(M0) + i * 86400000); weeks.add(new Date(d - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10)); }
  await expect(page.locator('#fin-chart rect[data-fin-hit]')).toHaveCount(weeks.size);
  await page.click('[data-act="fin-group"][data-g="month"]');
  await expect(page.locator('#fin-chart rect[data-fin-hit]')).toHaveCount(1);
  await expect(page.locator('#fin-legend [data-fin-lg="rev"]')).toContainText(rp(laba - 35000 + retP.cost_price));
  // CSV of the periods and the P&L lines
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fin-csv')]);
  expect(dl.suggestedFilename()).toBe(`laba-rugi-${M0}-${T}.csv`);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  expect(csv).toContain('Laba bersih;' + net);
  // Laporan for the same range: the owner's Laba rugi (profit_loss) and the KPIs
  const finNet = await row('net').innerText();
  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="month"]');
  await expect(page.locator('#pl-table [data-pl="net"] td.r')).toHaveText(finNet);
  await expect(page.locator('#pl-table [data-pl="expenses"] td.r')).toHaveText(rp(-expT));
  await expect(page.locator('#pl-table [data-pl="sales"] td.r')).toHaveText(rp(omzet));
  await expect(page.locator('[data-kpi="laba"] .v')).toHaveText(rp(laba));
  await expect(page.locator('[data-kpi="net"] .v')).toHaveText(rp(laba - expT));
});

test('owner sets a saldo awal: the balance = saldo awal + in − out on that account since; drawers, no-account money, neraca', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openFinance(page);
  const ba1 = page.locator('[data-fin-acc="BA1"]');
  await expect(ba1).toContainText('Saldo awal belum diisi');
  await ba1.locator('[data-act="fin-open-set"]').click();
  await expect(page.locator('#fin-op')).toBeVisible();
  await page.fill('#fin-op-date', M0);
  await page.fill('#fin-op-amt', '5.000.000');
  await page.click('#fin-op-save');
  await expect(page.locator('#fin-op')).toHaveCount(0);
  let db = await getDb(page);
  expect(db.settings.acct_opening.BA1).toMatchObject({ date: M0, amount: 5000000, by: 'Pemilik' });
  expect(db.activity.some(a => a.kind === 'notifikasi' && a.ref === 'akuntan' && /^Saldo awal BCA 1234567890: Rp 5\.000\.000 per awal /.test(a.summary))).toBe(true);
  const flows = d => {
    const inR = x => x >= M0 && x <= T, bank = p => ['transfer', 'qris'].includes(p.method) && p.account_id === 'BA1' && inR(p.pay_date);
    const i = d.sales.filter(s => s.status !== 'void' && s.account_id === 'BA1' && inR(s.sale_date)).reduce((a, s) => a + of(s).transfer, 0) + d.payments.filter(p => bank(p) && (p.direction || 'in') === 'in').reduce((a, p) => a + p.amount, 0);
    return [i, d.payments.filter(p => bank(p) && p.direction === 'out').reduce((a, p) => a + p.amount, 0)];
  };
  const [i0, o0] = flows(db);
  expect(i0 + o0).toBeGreaterThan(0);
  await expect(ba1.locator('[data-fin-v="bal"]')).toHaveText(rp(5000000 + i0 - o0));
  await expect(ba1).toContainText(`+${rp(i0)}`);
  // a customer pays by transfer to BCA: the balance follows
  const cust = db.customers.find(c => c.debt_balance >= 10000);
  const py = await asUser(page, 'Pemilik', '1234', 'receive_payment', { customer_id: cust.id, amount: 10000, method: 'transfer', account_id: 'BA1', transfer_ref: 'FIN-TEST-77' });
  expect(py.error).toBeUndefined();
  await page.click('[data-act="fin-refresh"]');
  await expect(ba1.locator('[data-fin-v="bal"]')).toHaveText(rp(5000000 + i0 + 10000 - o0));
  db = await getDb(page);
  // the open drawers' expected cash (as the cash page counts it) and the known cash & bank
  const boot = await asUser(page, 'Pemilik', '1234', 'bootstrap');
  const drawers = boot.open_shifts.reduce((a, x) => a + x.expected_cash, 0);
  await expect(page.locator('[data-fin-v="drawers"]')).toHaveText(rp(drawers));
  const cash = drawers + 5000000 + i0 + 10000 - o0;
  await expect(page.locator('[data-fin-v="known"]')).toHaveText(rp(cash));
  // money with no account: QRIS / card sales never name one; the demo's transfer sales were never filed
  const ok = db.sales.filter(s => s.status !== 'void' && s.sale_date >= M0 && s.sale_date <= T);
  await expect(page.locator('[data-fin-none="qris_sales"] .num')).toHaveText(rp(ok.reduce((a, s) => a + of(s).qris, 0)));
  await expect(page.locator('[data-fin-none="tf_sales"] .num')).toHaveText(rp(ok.filter(s => !['BA1', 'BA2'].includes(s.account_id)).reduce((a, s) => a + of(s).transfer, 0)));
  // neraca: receivables, stock at cost, supplier debt = the sum of every supplier's ledger balance, equity = assets − liabilities
  const recv = db.customers.reduce((a, c) => a + c.debt_balance, 0);
  const stock = Math.round(db.products.filter(p => p.active !== false).reduce((a, p) => a + Math.max(0, p.stock) * p.cost_price, 0));
  const sups = [...new Set(db.purchases.map(r => String(r.supplier || '').trim()).filter(s => s && !['STOK OPNAME', 'PENYESUAIAN STOK', 'KEMAS ULANG'].includes(s.toUpperCase())))];
  let owed = 0, ahead = 0;
  for (const s of sups) { const lg = await asUser(page, 'Pemilik', '1234', 'party_ledger', { party_type: 'supplier', supplier: s }); expect(lg.error).toBeUndefined(); if (lg.balance > 0) owed += lg.balance; else ahead -= lg.balance; }
  expect(owed).toBeGreaterThan(0);
  const bs = k => page.locator(`[data-fin-bs="${k}"] b.num`).first();
  await expect(bs('cash')).toHaveText(rp(cash));
  await expect(bs('recv')).toHaveText(rp(recv));
  await expect(bs('stock')).toHaveText(rp(stock));
  await expect(bs('prepaid')).toHaveText(rp(ahead));
  await expect(bs('payable')).toHaveText(rp(owed));
  await expect(bs('assets')).toHaveText(rp(cash + recv + stock + ahead));
  await expect(bs('equity')).toHaveText(rp(cash + recv + stock + ahead - owed));
  await page.locator('[data-fin-bs="payable"] summary').click();
  await expect(page.locator('[data-fin-bs="payable"] [data-fin-sup]').first()).toBeVisible();
  await expect(page.locator('#fin-bs-note')).toContainText('Dihitung dari catatan di aplikasi');
  // the opening balances never travel with the settings
  expect((await asUser(page, 'Jihan', '2222', 'bootstrap')).settings.acct_opening).toBeUndefined();
  expect((await asUser(page, 'Pemilik', '1234', 'bootstrap')).settings.acct_opening).toBeUndefined();
});

test('the accountant sees Keuangan (costs hidden unless the owner allows them, no saldo awal button); Arabic', async ({ page }) => {
  await addAccountant(page, false);
  await nav(page, 'finance'); // from "Lainnya"
  await expect(page.locator('#fin-pl-table')).toBeVisible();
  await expect(page.locator('#fin-bs')).toBeVisible();
  await expect(page.locator('#fin-pl-table [data-fin-pl="hpp"]')).toHaveCount(0);
  await expect(page.locator('#fin-pl-table [data-fin-pl="net"]')).toHaveCount(0);
  await expect(page.locator('#fin-chart polyline')).toHaveCount(2);
  await expect(page.locator('[data-fin-bs="stock"]')).toContainText('tersembunyi');
  await expect(page.locator('[data-fin-bs="equity"] b.num')).toHaveText('—');
  await expect(page.locator('[data-act="fin-open-set"]')).toHaveCount(0);
  await expect(page.locator('[data-fin-acc="BA1"]')).toContainText('Saldo awal diisi oleh pemilik');
  expect((await asUser(page, 'Lestari', '5555', 'set_account_opening', { account_id: 'BA1', date: T, amount: 1000 })).error).toBe('FORBIDDEN');
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#view-finance')).toContainText('الأرباح والخسائر');
  await expect(page.locator('#view-finance')).toContainText('الميزانية');
  await expect(page.locator('#view-finance')).toContainText('أرصدة النقد والبنوك');
  // the owner lets her see costs: HPP, laba and the stock value appear
  await editDb(page, 'db.settings.akuntan_sees_cost = true;');
  await staffSession(page, 'Lestari', '5555');
  await nav(page, 'finance');
  await expect(page.locator('#fin-pl-table [data-fin-pl="hpp"]')).toHaveCount(1);
  await expect(page.locator('#fin-pl-table [data-fin-pl="net"]')).toHaveCount(1);
  await expect(page.locator('[data-fin-bs="stock"] b.num')).toBeVisible();
});

test('the manager without the cost setting has no Keuangan (and the server refuses); with it she has', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await expect(page.locator('#nav [data-view="finance"]')).toHaveCount(0);
  expect(await page.evaluate(() => VIEWS.filter(v => viewAllowed(v)).map(v => v.id))).not.toContain('finance'); // nor in "Lainnya"
  expect((await asUser(page, 'Jihan', '2222', 'finance_position', { from: M0, to: T })).error).toBe('FORBIDDEN');
  await page.evaluate(() => { closeModal(true); go('finance'); });
  await expect(page.locator('#view-finance')).toBeHidden();
  await editDb(page, 'db.settings.akuntan_sees_cost = true;');
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#nav [data-view="finance"]')).toBeVisible(); // once the fresh settings arrive
  await nav(page, 'finance');
  await expect(page.locator('#fin-pl-table [data-fin-pl="hpp"]')).toHaveCount(1);
  await expect(page.locator('[data-act="fin-open-set"]')).toHaveCount(0); // the saldo awal stays the owner's
  expect((await asUser(page, 'Jihan', '2222', 'set_account_opening', { account_id: 'BA1', date: T, amount: 1000 })).error).toBe('FORBIDDEN');
});

test('phone 375 px: Keuangan without horizontal scroll, in Indonesian and Arabic', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openFinance(page);
  const noScroll = () => page.evaluate(() => { const m = document.querySelector('#main'); return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; });
  expect(await noScroll()).toBe(true);
  for (const d of await page.locator('#fin-cash details, #fin-bs details').all()) await d.evaluate(e => { e.open = true; });
  expect(await noScroll()).toBe(true);
  await page.screenshot({ path: require('path').join(__dirname, 'screenshots', 'finance-phone.png'), fullPage: false });
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#fin-bs')).toContainText('الميزانية');
  expect(await noScroll()).toBe(true);
  // the chart is readable on a phone: at most 6 date labels
  expect(await page.locator('#fin-chart text[text-anchor="middle"]').count()).toBeLessThanOrEqual(6);
});
