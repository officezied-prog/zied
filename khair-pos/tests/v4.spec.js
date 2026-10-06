// v4: cash drawer shifts (blind count), SHIFT_REQUIRED, dashboard, channel/promo, notifications.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { rp, SHOTS, jktToday, login, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals, asUser } = require('./helpers');

const copyDb = async (from, to) => { const raw = await from.evaluate(() => localStorage.getItem('kmock.db')); await to.evaluate(r => localStorage.setItem('kmock.db', r), raw); };
const ctxOpts = { viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' };

test('manager: open shift → cash sale → kas expense → cash out → close with counted cash → difference (live)', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { openShift: false });
  await page.fill('#so-cash', '500.000');
  await page.click('#so-ok');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Kasir dibuka' })).toContainText(rp(500000));
  await nav(page, 'pos');
  const gula = productByName(await getDb(page), /Gula Pasir/);
  await addBySearch(page, 'gula pasir');
  await page.fill('#cart-paid', '20000');
  await checkoutSkip(page);
  await closeModals(page);

  await nav(page, 'expenses');
  await expect(page.locator('#ex-from .on')).toHaveAttribute('data-f', 'kas');
  await page.fill('#ex-amt', '10.000');
  await page.fill('#ex-note', 'Plastik kresek');
  await page.click('#ex-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Pengeluaran' })).toBeVisible();

  await nav(page, 'kas');
  await page.click('[data-act="kas-refresh"]');
  await expect(page.locator('#kas-mine')).toContainText(rp(500000 + gula.retail_price - 10000));
  await page.click('[data-act="cash-move"][data-type="out"]');
  await page.fill('#cm-amt', '50.000');
  await page.click('#cm-ok');
  await expect(page.locator('#cm-err')).toContainText('Wajib');
  await page.fill('#cm-note', 'Beli galon');
  await page.click('#cm-ok');
  await expect(page.locator('#cm-ok')).toHaveCount(0);

  const expected = 500000 + gula.retail_price - 50000 - 10000;
  await page.click('[data-act="shift-close"]');
  await expect(page.locator('#shift-close')).toContainText(rp(expected));
  await page.fill('#cs-counted', '450.000');
  await expect(page.locator('#cs-diff')).toHaveText(rp(450000 - expected));
  await page.click('#cs-ok');
  await expect(page.locator('#shift-result')).toContainText('Kurang ' + rp(expected - 450000));
  await expect(page.locator('#sr-diff')).toHaveAttribute('data-diff', String(450000 - expected));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-shift-report.png') });
  const sh = (await getDb(page)).shifts.slice(-1)[0];
  expect(sh).toMatchObject({ cashier: 'Jihan', status: 'closed', opening_cash: 500000, cash_sales: gula.retail_price, cash_out: 60000, expected_cash: expected, counted_cash: 450000, difference: 450000 - expected, sales_count: 1 });
  await closeModals(page);
  await expect(page.locator('#kas-none')).toBeVisible();
});

test('blind count: a kasir never receives running cash totals until the shift is closed (API as Siti)', async ({ page }) => {
  await login(page);
  const blind = ['cash_sales', 'cash_payments', 'sales_total', 'expected_cash'];
  const o = await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 400000 });
  expect(blind.filter(k => k in o.shift)).toEqual([]);
  await asUser(page, 'Siti', '1111', 'save_sale', { client_id: 'b1', items: [{ product_id: 20, qty: 2, unit_price: 18000, price_type: 'eceran' }], payment_method: 'tunai', paid_amount: 50000 });
  const boot = await asUser(page, 'Siti', '1111', 'bootstrap');
  expect(blind.filter(k => k in boot.shift)).toEqual([]);
  const ob = await page.evaluate(() => api('bootstrap'));
  expect(ob.open_shifts.find(x => x.cashier === 'Siti').expected_cash).toBe(436000);
  const c = await asUser(page, 'Siti', '1111', 'close_shift', { counted_cash: 436000 });
  expect(c.shift).toMatchObject({ expected_cash: 436000, cash_sales: 36000, difference: 0, status: 'closed' });
});

test('SHIFT_REQUIRED: selling without an open shift asks to open the cash drawer first', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { openShift: false });
  await page.click('#shift-later');
  await nav(page, 'pos');
  await expect(page.locator('#pos-grid .pcard').first()).toBeVisible();
  expect((await asUser(page, 'Siti', '1111', 'save_sale', { client_id: 'x' + Date.now(), items: [{ product_id: 1, qty: 1, unit_price: 175000, price_type: 'eceran' }], payment_method: 'tunai', paid_amount: 175000 })).error).toBe('SHIFT_REQUIRED');
  await addBySearch(page, 'ajwa');
  await page.click('#btn-checkout');
  await expect(page.locator('#shift-open')).toBeVisible();
  await page.fill('#so-cash', '300000');
  await page.click('#so-ok');
  await expect(page.locator('.modal #receipt')).toBeVisible();
  const db = await getDb(page);
  const sale = db.sales.slice(-1)[0];
  expect(sale.shift_id).toBe(db.shifts.slice(-1)[0].shift_id);
  expect(db.shifts.slice(-1)[0].cashier).toBe('Jihan');
});

test('manager sees expected cash live and closes a forgotten shift of another cashier', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'kas');
  await expect(page.locator('#kas-mine')).toContainText('Seharusnya di laci');
  const rina = page.locator('#kas-open .li').filter({ hasText: 'Rina' });
  await expect(rina).toContainText('belum ditutup sejak kemarin');
  await rina.locator('[data-act="shift-close"]').click();
  await expect(page.locator('#shift-close')).toContainText('Seharusnya di laci');
  await page.fill('#cs-counted', '290.000');
  await expect(page.locator('#cs-diff')).toHaveText('-' + rp(10000).replace('Rp ', 'Rp '));
  await page.click('#cs-ok');
  await expect(page.locator('#shift-result')).toContainText('Kurang ' + rp(10000));
  const sh = (await getDb(page)).shifts.find(x => x.cashier === 'Rina');
  expect(sh).toMatchObject({ status: 'closed', expected_cash: 300000, counted_cash: 290000, difference: -10000, closed_by: 'Jihan' });
});

test('dashboard (Beranda): KPIs, attention, top 10, hourly chart, brand filter', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await expect(page.locator('#view-home')).toBeVisible();
  const db = await getDb(page);
  const T = jktToday();
  const ok = db.sales.filter(s => s.sale_date === T && s.status !== 'void');
  await expect(page.locator('[data-kpi="h-omzet"] .v')).toHaveText(rp(ok.reduce((a, s) => a + s.total, 0)));
  await expect(page.locator('[data-kpi="h-count"] .v')).toHaveText(String(ok.length));
  await expect(page.locator('#home-att')).toContainText('Rina');
  // 7 days for a fuller picture
  await page.click('[data-act="home-preset"][data-p="7d"]');
  await expect(page.locator('#home-top [data-rows] tbody tr')).toHaveCount(5);
  expect(await page.locator('#home-hourly svg rect').count()).toBeGreaterThan(8);
  await expect(page.locator('#home-hourly svg polyline')).toHaveCount(1);
  await expect(page.locator('#home-cashiers')).toContainText('Siti');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-home.png') });
  await page.locator('#home-top [data-act="home-all"]').click();
  await expect(page.locator('#home-all-body tbody tr')).toHaveCount(10);
  await closeModals(page);
  // brand filter: grosir omzet equals the classified sum
  await page.click('[data-act="home-brand"][data-b="grosir"]');
  const expectGrosir = await page.evaluate(({ db, from, to }) => {
    const byInv = {}; db.items.forEach(i => (byInv[i.invoice_no] = byInv[i.invoice_no] || []).push(i));
    return db.sales.filter(s => s.sale_date >= from && s.sale_date <= to && s.status !== 'void' && KPOS.brandOf(s, byInv) === 'grosir').reduce((a, s) => a + s.total, 0);
  }, { db, from: (() => { const d = new Date(Date.now() + 7 * 3600000 - 6 * 86400000); return d.toISOString().slice(0, 10); })(), to: T });
  await expect(page.locator('[data-kpi="h-omzet"] .v')).toHaveText(rp(expectGrosir));
  // bell lists the same attention items
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att')).toContainText('Rina');
});

test('channel and promo code are saved and reported', async ({ page }) => {
  await login(page);
  await addBySearch(page, 'zamzam');
  await page.click('#cart-more summary');
  await page.click('[data-act="channel"][data-c="whatsapp"]');
  await page.fill('#cart-promo', 'khair1111');
  await expect(page.locator('#cart-ch-sum')).toHaveText('WhatsApp');
  await checkoutSkip(page);
  await expect(page.locator('.modal #receipt')).toContainText('KHAIR1111');
  const sale = (await getDb(page)).sales.slice(-1)[0];
  expect(sale).toMatchObject({ channel: 'whatsapp', promo_code: 'KHAIR1111' });
  await closeModals(page);
  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="today"]');
  await expect(page.locator('#rp-promos')).toContainText('KHAIR1111');
  await expect(page.locator('#rp-channels')).toContainText('WhatsApp');
  // Laporan → Kas Kasir lists the shifts of the range
  await page.click('[data-act="rp-mode"][data-m="kas"]');
  await page.click('[data-act="rep-preset"][data-p="7d"]');
  const db = await getDb(page);
  const from = new Date(Date.now() + 7 * 3600000 - 6 * 86400000).toISOString().slice(0, 10);
  await expect(page.locator('#rp-shifts tbody tr')).toHaveCount(db.shifts.filter(x => x.shift_date >= from && x.shift_date <= jktToday()).length);
});

test('notification: the manager is told when the owner approves her cost-price request', async ({ page, browser }) => {
  await login(page, 'Jihan', '2222');
  await nav(page, 'products');
  await page.fill('#pr-q', 'zamzam');
  await expect(page.locator('#prod-table tbody tr')).toHaveCount(1);
  await page.click('#prod-table [data-act="price-change"]');
  await page.fill('#pc-cost', '100.000');
  await page.fill('#pc-reason', 'Harga pasar naik');
  await page.click('#pc-save');
  await expect(page.locator('#pc-pending')).toBeVisible();
  const rid = (await getDb(page)).approvals.slice(-1)[0].request_id;
  await closeModals(page);

  const octx = await browser.newContext(ctxOpts);
  const owner = await octx.newPage();
  await login(owner, 'Pemilik', '1234', '', { stay: true });
  await copyDb(page, owner);
  await nav(owner, 'approvals');
  await owner.click('[data-act="apr-refresh"]');
  await owner.locator(`.apr-card[data-req="${rid}"] [data-d="approved"]`).click();
  await expect(owner.locator('.toast.ok').filter({ hasText: rid })).toBeVisible();
  await copyDb(owner, page);
  await octx.close();

  await page.evaluate(() => KPOS.checkMyRequests());
  await expect(page.locator('#tb-bell b')).toBeVisible();
  await page.click('#tb-bell');
  await expect(page.locator('#bell-notifs')).toContainText('Ubah harga Air Zamzam 5 L disetujui Pemilik');
  expect(productByName(await getDb(page), /Zamzam/).cost_price).toBe(100000);
});
