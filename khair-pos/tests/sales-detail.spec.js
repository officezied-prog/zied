// v67 (owner 2026-10-20, majoo screenshots: «اضف هذه المميزات»): Laporan → "Detail" (Detail penjualan: five cards, every invoice of the
// range with search / filters / paging, the eye opening the receipt, CSV) and "Grafik" (Penjualan per periode: a line chart per day /
// week / month with series toggles, the table per period, CSV). Same date range and data as "Periode" (get_sales, cached); the cards
// equal computeReport's numbers. Owner, manager and accountant; Arabic; phone width.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { jktToday, getDb, nav, openApp, enterKey, typePin, staffSession, editDb, closeModals, rp, SHOTS } = require('./helpers');

const T = jktToday(), MONTH = T.slice(0, 8) + '01';
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const money = s => Number(String(s).replace(/[^\d-]/g, '')) || 0;

/** Demo data the seed does not have: a void, a split payment into the BCA account with a send fee, a field order, a return refund. */
const SEED = `
  const T = arg.T, M = arg.M;
  const inR = s => s.sale_date >= M && s.sale_date <= T;
  const list = db.sales.filter(inR).sort((a, b) => String(a.sale_time).localeCompare(String(b.sale_time)));
  const pick = i => list[i];
  const v = pick(3); v.status = 'void'; v.void_reason = 'salah input';
  const c = pick(5); c.payment_method = 'campur'; c.pay_parts = JSON.stringify([{ m: 'tunai', a: 20000 }, { m: 'transfer', a: c.total - 20000 }]); c.paid_amount = c.total; c.debt_amount = 0; c.account_id = 'BA1'; c.send_fee = 500;
  const f = pick(7); f.notes = 'Pesanan sales FO-0007 (Ahmad)'; f.channel = 'toko';
  db.payments.push({ id: 990001, pay_id: 'PYRET0001', pay_date: T, pay_time: new Date().toISOString(), direction: 'out', party_type: 'customer', customer_id: 0, customer_name: 'Umum', supplier: '', amount: 25000, method: 'tunai', account_id: '', slip_date: '', bank: '', transfer_ref: '', proof_photo_id: '', alloc: '[]', match_status: 'retur', note: 'Uang kembali retur RT1 faktur ' + list[0].invoice_no, cashier: 'Siti' });
`;

async function ownerWithSeed(page) {
  await openApp(page);
  await editDb(page, SEED, { T, M: MONTH });
  await enterKey(page);
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await typePin(page, '1234');
  await expect(page.locator('#app')).toBeVisible();
}
async function addAccountant(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
}
async function openMode(page, m) {
  if (!(await page.locator('#view-reports').isVisible())) await nav(page, 'reports');
  if (await page.locator('#rp-daily-btn').isVisible().catch(() => false)) await page.click('#rp-daily-btn'); // manager / accountant land on today's numbers
  await page.click(`[data-act="rp-mode"][data-m="${m}"]`);
  await expect(page.locator(m === 'detail' ? '#sx-kpis' : '#sx-ptable')).toBeVisible();
}
async function setRange(page, from, to) {
  await page.fill('#rp-from', from); await page.locator('#rp-from').dispatchEvent('change');
  await page.fill('#rp-to', to); await page.locator('#rp-to').dispatchEvent('change');
  await expect(page.locator('#sx-body p.muted').first()).toContainText(from.slice(8, 10) + '/' + from.slice(5, 7));
}
async function csvOf(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sx-csv')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  return { name: dl.suggestedFilename(), lines: text.slice(1).trim().split(/\r\n/) };
}
const kpiV = (page, id) => page.locator(`[data-kpi="${id}"] .v`);
const shown = page => page.locator('#sx-table tbody tr[data-sx-inv]');

test('Detail penjualan: the cards equal the demo data and Periode; search, filters, paging, the eye, CSV (owner)', async ({ page }) => {
  await ownerWithSeed(page);
  const db = await getDb(page);
  const sales = db.sales.filter(s => s.sale_date >= MONTH && s.sale_date <= T), ok = sales.filter(s => s.status !== 'void');
  const voided = sales.find(s => s.status === 'void'), split = sales.find(s => s.payment_method === 'campur'), field = sales.find(s => /^Pesanan sales/.test(s.notes || ''));
  expect(sales.length).toBeGreaterThan(200);
  const total = ok.reduce((a, s) => a + s.total, 0), debt = ok.reduce((a, s) => a + (s.debt_amount || 0), 0);
  const refund = db.payments.filter(p => p.direction === 'out' && p.party_type === 'customer' && p.match_status === 'retur' && p.pay_date >= MONTH && p.pay_date <= T).reduce((a, p) => a + p.amount, 0);
  expect(refund).toBe(25000);

  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="month"]');
  const omzetPeriode = await kpiV(page, 'omzet').innerText(), countPeriode = await kpiV(page, 'count').innerText();
  await openMode(page, 'detail');
  await expect(page.locator('#view-reports h1')).toHaveText('Detail penjualan');
  await expect(kpiV(page, 'sx-total')).toHaveText(rp(total));
  expect(rp(total)).toBe(omzetPeriode); // = computeReport for the same range
  await expect(kpiV(page, 'sx-count')).toHaveText(String(ok.length));
  expect(countPeriode).toBe(String(ok.length));
  await expect(page.locator('[data-kpi="sx-count"] .s')).toContainText('batal: 1');
  await expect(kpiV(page, 'sx-net')).toHaveText(rp(total - refund));
  await expect(kpiV(page, 'sx-paid')).toHaveText(rp(total - debt));
  await expect(kpiV(page, 'sx-debt')).toHaveText(rp(debt));
  await expect(page.locator('#sx-hint')).toContainText('Penjualan bersih = total penjualan − uang yang dikembalikan');
  await expect(page.locator('#sx-body')).not.toContainText('Laba'); // no cost / profit in this mode

  // newest first, 100 at a time
  await expect(page.locator('#sx-count')).toContainText(`${sales.length} faktur`);
  await expect(shown(page)).toHaveCount(100);
  const newest = sales.slice().sort((a, b) => String(b.sale_time).localeCompare(String(a.sale_time)))[0];
  await expect(shown(page).first()).toHaveAttribute('data-sx-inv', newest.invoice_no);
  await page.click('#sx-more');
  await expect(shown(page)).toHaveCount(200);
  await page.click('#sx-more');
  await expect(shown(page)).toHaveCount(sales.length);
  await expect(page.locator('#sx-more')).toHaveCount(0);

  // the rows: void badge, split method with the account, the field order's rep
  await expect(page.locator(`[data-sx-inv="${voided.invoice_no}"]`)).toContainText('Batal');
  await expect(page.locator(`[data-sx-inv="${split.invoice_no}"]`)).toContainText('Tunai Rp 20.000 + Transfer');
  await expect(page.locator(`[data-sx-inv="${split.invoice_no}"]`)).toContainText('BCA 1234567890');
  await expect(page.locator(`[data-sx-inv="${field.invoice_no}"]`)).toContainText('Sales (lapangan) · Ahmad');
  // a debt invoice paid later (an allocated payment of the range): its "waktu bayar" is that payment's day
  const later = db.payments.filter(p => p.direction === 'in' && p.pay_date >= MONTH && p.pay_date <= T).map(p => ({ p, a: JSON.parse(p.alloc || '[]') })).find(x => x.a.some(a => sales.some(s => s.invoice_no === a.ref && s.sale_date < x.p.pay_date)));
  expect(later).toBeTruthy();
  {
    const ref = later.a.find(a => sales.some(s => s.invoice_no === a.ref && s.sale_date < later.p.pay_date)).ref;
    const lastPay = db.payments.filter(p => p.pay_date >= MONTH && p.pay_date <= T && JSON.parse(p.alloc || '[]').some(a => a.ref === ref && a.amount > 0)).map(p => p.pay_time || p.pay_date).sort().pop();
    const d = new Date(Date.parse(lastPay) + 7 * 3600000).toISOString();
    await expect(page.locator(`[data-sx-inv="${ref}"] td`).nth(2)).toContainText(`${d.slice(8, 10)}/${d.slice(5, 7)}`);
  }

  // search: invoice no, then a product name (every invoice holding it)
  await page.fill('#sx-q', split.invoice_no);
  await expect(shown(page)).toHaveCount(1);
  const prod = db.items.find(i => i.invoice_no === newest.invoice_no).name;
  const withProd = sales.filter(s => db.items.some(i => i.invoice_no === s.invoice_no && i.name === prod) || [s.invoice_no, s.customer_name, s.cashier].join(' ').toLowerCase().includes(prod.toLowerCase()));
  await page.fill('#sx-q', prod);
  await expect(page.locator('#sx-count')).toContainText(`${withProd.length} faktur`);
  await expect(shown(page)).toHaveCount(Math.min(100, withProd.length));
  await page.fill('#sx-q', '');
  // filters: method (incl. campur), cashier, status
  await page.selectOption('#sx-method', 'transfer');
  await expect(page.locator('#sx-count')).toContainText(`${sales.filter(s => s.payment_method === 'transfer').length} faktur`);
  await page.selectOption('#sx-method', 'campur');
  await expect(shown(page)).toHaveCount(1);
  await page.selectOption('#sx-method', '');
  await page.selectOption('#sx-cashier', 'Siti');
  await expect(page.locator('#sx-count')).toContainText(`${sales.filter(s => s.cashier === 'Siti').length} faktur`);
  await page.selectOption('#sx-cashier', '');
  await page.selectOption('#sx-status', 'void');
  await expect(shown(page)).toHaveCount(1);
  await expect(shown(page).first()).toHaveAttribute('data-sx-inv', voided.invoice_no);
  await page.selectOption('#sx-status', 'ok');
  await expect(page.locator('#sx-count')).toContainText(`${ok.length} faktur · yang sah ${rp(total)}`);
  await expect(kpiV(page, 'sx-total')).toHaveText(rp(total)); // the cards stay on the whole range
  await page.selectOption('#sx-status', 'all');

  // the eye opens the receipt with every line
  const lines = db.items.filter(i => i.invoice_no === newest.invoice_no);
  await shown(page).first().locator('[data-sx-eye]').click();
  await expect(page.locator('.modal #receipt')).toBeVisible();
  for (const l of lines) await expect(page.locator('.modal #receipt')).toContainText(l.name);
  await closeModals(page);

  // CSV: one row per invoice the filters show
  const csv = await csvOf(page);
  expect(csv.name).toBe(`penjualan-${MONTH}_${T}.csv`);
  expect(csv.lines[0]).toBe('"no_transaksi";"waktu_order";"waktu_bayar";"kasir";"jenis_order";"pelanggan";"total";"diskon";"ongkir";"dibayar";"piutang";"metode";"status"');
  expect(csv.lines.length - 1).toBe(sales.length);
  const cRow = csv.lines.find(l => l.startsWith(`"${split.invoice_no}"`));
  expect(cRow).toContain(`"${split.total}";"${split.discount || 0}";"500";"${split.total}";"0"`);
  expect(cRow).toContain('BCA 1234567890');
  expect(csv.lines.find(l => l.startsWith(`"${voided.invoice_no}"`))).toMatch(/"batal"$/);
  await page.selectOption('#sx-method', 'transfer');
  expect((await csvOf(page)).lines.length - 1).toBe(sales.filter(s => s.payment_method === 'transfer').length);
  await page.selectOption('#sx-method', '');
  await page.screenshot({ path: path.join(SHOTS, 'sales-detail.png') });
});

test('Penjualan per periode: a point per day, week and month totals = day totals, series toggles, CSV (owner)', async ({ page }) => {
  await ownerWithSeed(page);
  const db = await getDb(page);
  await nav(page, 'reports');
  await openMode(page, 'chart');
  await expect(page.locator('#view-reports h1')).toHaveText('Penjualan per periode');
  // last 7 days: 7 points and 7 rows, even days without sales
  await page.click('[data-act="rep-preset"][data-p="7d"]');
  await expect(page.locator('#sx-svg g.sx-pt')).toHaveCount(7);
  await expect(page.locator('#sx-ptable tr[data-sx-p]')).toHaveCount(7);
  const F = addDays(T, -29);
  await setRange(page, F, T);
  await expect(page.locator('#sx-svg g.sx-pt')).toHaveCount(30);
  await expect(page.locator('#sx-svg g.sx-pt title').first()).toContainText('Penjualan (Rp) Rp');
  const sales = db.sales.filter(s => s.sale_date >= F && s.sale_date <= T && s.status !== 'void');
  const inv = new Set(sales.map(s => s.invoice_no));
  const total = sales.reduce((a, s) => a + s.total, 0), qty = db.items.filter(i => inv.has(i.invoice_no)).reduce((a, i) => a + Number(i.qty), 0);
  const tot = page.locator('#sx-ptable [data-sx-total]');
  await expect(tot.locator('[data-c="omzet"]')).toHaveText(rp(total));
  await expect(tot.locator('[data-c="tx"]')).toHaveText(String(sales.length));
  const dayRows = await page.locator('#sx-ptable tr[data-sx-p] [data-c="omzet"]').allInnerTexts();
  expect(dayRows.reduce((a, x) => a + money(x), 0)).toBe(total);
  const byDay = {}; sales.forEach(s => { byDay[s.sale_date] = (byDay[s.sale_date] || 0) + s.total; });
  await expect(page.locator(`#sx-ptable tr[data-sx-p="${T}"] [data-c="omzet"]`)).toHaveText(rp(byDay[T] || 0));
  // weeks (Monday–Sunday, cut to the range): the same total, one row per week
  await page.click('[data-act="rep-sx-group"][data-g="week"]');
  const weeks = new Set(); for (let d = F; d <= T; d = addDays(d, 1)) { const dow = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; weeks.add(addDays(d, -dow)); }
  await expect(page.locator('#sx-ptable tr[data-sx-p]')).toHaveCount(weeks.size);
  await expect(page.locator('#sx-svg g.sx-pt')).toHaveCount(weeks.size);
  await expect(page.locator('#sx-ptable tr[data-sx-p]').first()).toHaveAttribute('data-sx-p', F);
  const wk = await page.locator('#sx-ptable tr[data-sx-p] [data-c="omzet"]').allInnerTexts();
  expect(wk.reduce((a, x) => a + money(x), 0)).toBe(total);
  await expect(tot.locator('[data-c="omzet"]')).toHaveText(rp(total));
  expect(await page.locator('#sx-ptable tr[data-sx-p] td').first().innerText()).toMatch(/^\d{1,2}(–\d{1,2})? [A-Z][a-z]{2}( – \d{1,2} [A-Z][a-z]{2})?$/); // e.g. "13–19 Okt"
  // months
  await page.click('[data-act="rep-sx-group"][data-g="month"]');
  await expect(page.locator('#sx-ptable tr[data-sx-p]')).toHaveCount(F.slice(0, 7) === T.slice(0, 7) ? 1 : 2);
  const mo = await page.locator('#sx-ptable tr[data-sx-p] [data-c="omzet"]').allInnerTexts();
  expect(mo.reduce((a, x) => a + money(x), 0)).toBe(total);
  await expect(tot.locator('[data-c="qty"]')).toHaveText(new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(Math.round(qty * 1000) / 1000));
  // CSV: one row per period
  const csv = await csvOf(page);
  expect(csv.name).toBe(`penjualan-per-periode-${F}_${T}.csv`);
  expect(csv.lines[0]).toBe('"periode";"dari";"sampai";"penjualan";"transaksi";"produk";"rata_rata"');
  expect(csv.lines.length - 1).toBe(mo.length);
  expect(csv.lines.slice(1).reduce((a, l) => a + Number(l.split(';')[3].replace(/"/g, '')), 0)).toBe(total);
  await page.click('[data-act="rep-sx-group"][data-g="day"]');
  expect((await csvOf(page)).lines.length - 1).toBe(30);
  // series: Penjualan + Transaksi by default; Produk on; Transaksi off; none → a hint; hide / show the chart
  await expect(page.locator('#sx-svg .sx-l.s-omzet')).toHaveCount(1);
  await expect(page.locator('#sx-svg .sx-l.s-tx')).toHaveCount(1);
  await expect(page.locator('#sx-svg .sx-l.s-qty')).toHaveCount(0);
  await page.check('#sx-ser-qty');
  await expect(page.locator('#sx-svg .sx-l.s-qty')).toHaveCount(1);
  await expect(page.locator('#sx-legend [data-lg]')).toHaveCount(3);
  await page.uncheck('#sx-ser-tx');
  await expect(page.locator('#sx-svg .sx-l.s-tx')).toHaveCount(0);
  await page.uncheck('#sx-ser-omzet'); await page.uncheck('#sx-ser-qty');
  await expect(page.locator('#sx-no-series')).toBeVisible();
  await page.check('#sx-ser-omzet'); await page.check('#sx-ser-tx');
  await expect(page.locator('#sx-svg')).toBeVisible();
  await page.click('#sx-chart-toggle');
  await expect(page.locator('#sx-chart-wrap')).toBeHidden();
  await expect(page.locator('#sx-chart-toggle')).toContainText('Tampilkan grafik');
  await expect(page.locator('#sx-ptable')).toBeVisible();
  await page.click('#sx-chart-toggle');
  await expect(page.locator('#sx-svg')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'sales-per-period.png') });
});

test('the accountant opens both modes (export, eye, grouping); Arabic; no horizontal scroll at 375 px', async ({ page }) => {
  await addAccountant(page);
  await openMode(page, 'detail');
  await expect(page.locator('#view-reports [data-act="rp-mode"]')).toHaveCount(4);
  await page.click('[data-act="rep-preset"][data-p="7d"]');
  await expect(page.locator('#sx-count')).toBeVisible();
  const csv = await csvOf(page); // rep-* buttons pass the accountant's read-only guard
  expect(csv.lines[0]).toContain('"no_transaksi"');
  await shown(page).first().locator('[data-sx-eye]').click();
  await expect(page.locator('.modal #receipt')).toBeVisible();
  await closeModals(page);
  await page.click('[data-act="rp-mode"][data-m="chart"]');
  await page.click('[data-act="rep-sx-group"][data-g="week"]');
  await expect(page.locator('[data-act="rep-sx-group"][data-g="week"]')).toHaveClass(/on/);
  await expect(page.locator('#sx-svg')).toBeVisible();
  // Arabic
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#view-reports h1')).toHaveText('المبيعات حسب الفترة');
  await expect(page.locator('[data-act="rp-mode"][data-m="detail"]')).toHaveText('التفاصيل');
  await expect(page.locator('#sx-chart-toggle')).toContainText('إخفاء الرسم');
  await page.click('[data-act="rp-mode"][data-m="detail"]');
  await expect(page.locator('#view-reports h1')).toHaveText('تفاصيل المبيعات');
  await expect(page.locator('#sx-table thead')).toContainText('رقم العملية');
  await expect(page.locator('[data-kpi="sx-net"] .k')).toHaveText('صافي المبيعات');
  // phone
  await page.evaluate(() => setLang('id'));
  await page.setViewportSize({ width: 375, height: 800 });
  for (const m of ['detail', 'chart']) {
    await page.click(`[data-act="rp-mode"][data-m="${m}"]`);
    await expect(page.locator(m === 'detail' ? '#sx-table' : '#sx-svg')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => { const v = document.querySelector('#view-reports'); return v.scrollWidth <= v.clientWidth; })).toBe(true);
  }
});

test('the manager reaches Detail and Grafik from the daily report', async ({ page }) => {
  await openApp(page);
  await enterKey(page);
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await openMode(page, 'chart');
  await expect(page.locator('#sx-svg g.sx-pt').first()).toBeAttached();
  await page.click('[data-act="rp-mode"][data-m="detail"]');
  await expect(page.locator('#sx-kpis [data-kpi]')).toHaveCount(5);
  // yesterday: the same total, invoices and debt as the daily report (server daily_report)
  const day = jktToday(-1);
  await page.click('[data-act="rep-preset"][data-p="yesterday"]');
  await expect(page.locator('#sx-body p.muted').first()).toHaveText(`${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`);
  const sxTotal = await kpiV(page, 'sx-total').innerText(), sxCount = await kpiV(page, 'sx-count').innerText(), sxDebt = await kpiV(page, 'sx-debt').innerText();
  await page.click('[data-act="rp-mode"][data-m="daily"]');
  await expect(page.locator('#dr-body')).toBeVisible();
  await page.fill('#dr-date', day); await page.locator('#dr-date').dispatchEvent('change');
  await expect(kpiV(page, 'dr-total')).toHaveText(sxTotal);
  await expect(page.locator('[data-kpi="dr-total"] .s')).toContainText(`${sxCount} transaksi`);
  await expect(page.locator('#dr-methods [data-dr="hutang"]')).toHaveText(sxDebt);
  // back to "Hari ini" still works
  await page.click('[data-act="rp-mode"][data-m="period"]');
  await expect(page.locator('#rp-daily-btn')).toBeVisible();
});
