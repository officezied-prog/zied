// v36 (owner 2026-10-11) in the owner app (mock backend = same rules as backend/process.js):
//  #1 «إصلاح فاتورة قديمة لا يتم إلا بموافقتي الشخصية» — a void of an EARLIER day's sale only by the owner;
//  #2 «إشعار فتح الصندوق للمدير والمحاسب ليوافق كل صباح» — the opening count to the manager AND the accountant;
//  #3 the manager renames the accountant account (name only);
//  #6 «الكشف الشهري يكتب الربح والخسارة» — profit & loss on the monthly statement (screen, print, copied text);
//  #7 Ramadan season worked out by itself (Absensi → Jam kerja);
//  #14 the owner's cashier page shows today's sales and invoices only — no selling, no cash drawer.
const { test, expect } = require('@playwright/test');
const { login, openApp, enterKey, typePin, getDb, nav, editDb, asUser, staffSession, switchUser, jktToday, rp } = require('./helpers');

async function addAkuntan(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await enterKey(page);
}
/** The owner logs in on this device after a staff session (the staff session is dropped first). */
async function asOwner(page) {
  await page.evaluate(() => { sessionStorage.clear(); localStorage.removeItem('kpos.mock.session'); });
  await page.goto('index.html?mock=1');
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await typePin(page, '1234');
  await expect(page.locator('#app')).toBeVisible();
}
/** The accountant comes through Khair Kasir to the management screens (session hand-off in this tab). */
async function asAkuntan(page) {
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
}

test('#14 owner: the cashier page is a read-only live list of today\'s sales — no cart, no drawer; the manager still sells', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // the manager sells at the counter (Khair Kasir) meanwhile
  const p = (await getDb(page)).products.find(x => x.active !== false && x.stock > 3 && (x.shop_stock === undefined || x.shop_stock > 3));
  const s = await asUser(page, 'Jihan', '2222', 'save_sale', { client_id: 'v36-om', sale_date: jktToday(), items: [{ product_id: p.id, qty: 1, unit_price: p.retail_price }], payment_method: 'tunai', paid_amount: p.retail_price });
  expect(s.invoice_no, JSON.stringify(s)).toBeTruthy();
  await nav(page, 'pos');
  await expect(page.locator('#view-pos h1')).toHaveText('Penjualan & faktur hari ini');
  await expect(page.locator('#om-live')).toBeVisible();
  await expect(page.locator('#om-table')).toBeVisible();
  await expect(page.locator(`#om-table tr[data-inv="${s.invoice_no}"]`)).toContainText('Jihan');
  // nothing to sell with, no cash-drawer tab
  await expect(page.locator('#pos-grid')).toHaveCount(0);
  await expect(page.locator('#cart')).toHaveCount(0);
  await expect(page.locator('#pos-search')).toHaveCount(0);
  await expect(page.locator('[data-act="cashier-tab"]')).toHaveCount(0);
  await page.evaluate(() => go('kas'));
  await expect(page.locator('#view-kas')).toBeHidden();
  await expect(page.locator('#view-pos')).toBeVisible();
  // totals = today's sales (not void)
  const db = await getDb(page);
  const todays = db.sales.filter(x => x.sale_date === jktToday() && x.status !== 'void');
  await expect(page.locator('[data-kpi="om-omzet"] .v')).toHaveText(rp(todays.reduce((a, x) => a + x.total, 0)));
  await expect(page.locator('[data-kpi="om-count"] .v')).toHaveText(String(todays.length));
  // a row opens the invoice (read-only receipt)
  await page.locator(`#om-table tr[data-inv="${s.invoice_no}"]`).click();
  await expect(page.locator('.modal #receipt')).toBeVisible();
  await page.keyboard.press('Escape');
  // F9 (checkout) does nothing for the owner
  const before = (await getDb(page)).sales.length;
  await page.keyboard.press('F9');
  expect((await getDb(page)).sales.length).toBe(before);
  // Arabic
  await page.click('#tb-lang');
  await expect(page.locator('#view-pos h1')).toHaveText('مبيعات وفواتير اليوم');

  // the manager keeps the full selling screen and the drawer tab
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'pos');
  await expect(page.locator('#pos-grid .pcard').first()).toBeVisible();
  await expect(page.locator('[data-act="cashier-tab"][data-tab="kas"]')).toBeVisible();
  await expect(page.locator('#om-table')).toHaveCount(0);
});

test('#1 old invoice: void request goes to the owner only (manager sees it locked); today\'s goes to manager or accountant', async ({ page }) => {
  await addAkuntan(page);
  const db0 = await getDb(page);
  const old = db0.sales.filter(s => s.sale_date < jktToday() && s.status !== 'void').sort((a, b) => b.sale_date.localeCompare(a.sale_date))[0];
  expect(old).toBeTruthy();
  const r = await asUser(page, 'Siti', '1111', 'request_void', { invoice_no: old.invoice_no, reason: 'harga salah' });
  expect(r).toMatchObject({ approver_role: 'owner', old_invoice: true });
  // the manager sees the card, locked, with the "old invoice — owner only" mark
  await staffSession(page, 'Jihan', '2222');
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${r.request_id}"]`);
  await expect(card.locator('[data-old-invoice]')).toContainText('Nota lama');
  await expect(card.locator('[data-owner-only]')).toBeVisible();
  await expect(card.locator('[data-d="approved"]')).toBeDisabled();
  expect((await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: r.request_id, decision: 'approved', invoice_no: old.invoice_no })).error).toBe('NEEDS_OWNER');
  // the accountant does not get it at all
  expect((await asUser(page, 'Lestari', '5555', 'list_approvals', {})).approvals.some(a => a.request_id === r.request_id)).toBe(false);
  // today's sale: the accountant approves it from the management screens
  const t = (await getDb(page)).sales.find(s => s.sale_date === jktToday() && s.status !== 'void');
  let todayInv = t && t.invoice_no;
  if (!todayInv) {
    const p = (await getDb(page)).products.find(x => x.active !== false && x.stock > 3);
    todayInv = (await asUser(page, 'Jihan', '2222', 'save_sale', { client_id: 'v36-void', sale_date: jktToday(), items: [{ product_id: p.id, qty: 1, unit_price: p.retail_price }], payment_method: 'tunai', paid_amount: p.retail_price })).invoice_no;
  }
  const r2 = await asUser(page, 'Siti', '1111', 'request_void', { invoice_no: todayInv, reason: 'dobel' });
  expect(r2).toMatchObject({ approver_role: 'mgr_akuntan', old_invoice: false });
  await asAkuntan(page);
  await nav(page, 'approvals');
  const c2 = page.locator(`.apr-card[data-req="${r2.request_id}"]`);
  await expect(c2.locator('[data-old-invoice]')).toHaveCount(0);
  await c2.locator('[data-d="approved"]').click();
  await expect(c2).toHaveCount(0);
  expect((await getDb(page)).sales.find(s => s.invoice_no === todayInv).status).toBe('void');
  // the owner approves the old one himself
  await asOwner(page);
  await nav(page, 'approvals');
  const c3 = page.locator(`.apr-card[data-req="${r.request_id}"]`);
  await expect(c3.locator('[data-old-invoice]')).toBeVisible();
  await c3.locator('[data-d="approved"]').click();
  await expect(c3).toHaveCount(0);
  expect((await getDb(page)).sales.find(s => s.invoice_no === old.invoice_no).status).toBe('void');
});

test('#1 a manager asking to void an old invoice in the owner app is told it went to the owner', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const old = (await getDb(page)).sales.filter(s => s.sale_date < jktToday() && s.status !== 'void')[0];
  const pending = page.evaluate(inv => requestVoid(inv), old.invoice_no);
  await page.fill('#cf-in', 'salah input');
  await page.click('#cf-ok');
  await pending;
  await expect(page.locator('.toast.ok')).toContainText('Nota lama: permintaan pembatalan');
});

test('#2 morning opening count: the manager AND the accountant get it; the first decision wins, the other is told', async ({ page }) => {
  await addAkuntan(page);
  await editDb(page, `db.shifts.filter(x => x.cashier === 'Siti' && x.status === 'open').forEach(x => { x.status = 'closed'; x.closed_at = new Date().toISOString(); x.counted_cash = 0; });`);
  const o = await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 250000 });
  expect(o.approval).toMatchObject({ kind: 'buka_kas', approver_role: 'mgr_akuntan' });
  // the manager sees it and may decide
  const lm = await asUser(page, 'Jihan', '2222', 'list_approvals', {});
  expect(lm.approvals.find(a => a.request_id === o.request_id).can_decide).toBe(true);
  // the accountant approves it from the management screens
  await asAkuntan(page);
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${o.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'buka_kas');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  expect((await getDb(page)).approvals.find(a => a.request_id === o.request_id)).toMatchObject({ status: 'approved', decided_by: 'Lestari' });
  // the manager, a moment later: already decided, by whom
  const late = await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: o.request_id, decision: 'approved' });
  expect(late.error).toBe('INVALID');
  expect(late.message).toContain('oleh Lestari');
});

test('#3 the manager renames the accountant account (Ganti orang) but cannot change its role or reset its PIN alone', async ({ page }) => {
  await addAkuntan(page);
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'settings');
  const row = page.locator('[data-role-group="akuntan"] tr[data-user="Lestari"]');
  await expect(row.locator('[data-act="user-swap"]')).toBeVisible();
  await expect(row.locator('[data-act="user-pin"]')).toHaveCount(0);
  await expect(row.locator('select[data-user-role]')).toHaveCount(0);
  await row.locator('[data-act="user-swap"]').click();
  await page.fill('#sw-name', 'Nadia Putri');
  await page.fill('#sw-pin', '4321');
  await page.fill('#sw-pin2', '4321');
  await page.click('#sw-save');
  await expect(page.locator('.toast.ok')).toContainText('Nadia Putri');
  const u = (await getDb(page)).users.find(x => x.name === 'Nadia Putri');
  expect(u).toMatchObject({ role: 'akuntan', must_change: true });
  // the server keeps the limits
  expect((await asUser(page, 'Jihan', '2222', 'save_user', { name: 'Nadia Putri', role: 'kasir', active: true })).error).toBe('FORBIDDEN');
  const h = await page.evaluate(() => KPOS.pinHash('demo', 'Nadia Putri', '9999'));
  expect((await asUser(page, 'Jihan', '2222', 'save_user', { name: 'Nadia Putri', role: 'akuntan', active: true, pin_hash: h })).error).toBe('FORBIDDEN');
  const h2 = await page.evaluate(() => KPOS.pinHash('demo', 'Akun Baru', '9999'));
  expect((await asUser(page, 'Jihan', '2222', 'save_user', { name: 'Akun Baru', role: 'akuntan', active: true, pin_hash: h2 })).error).toBe('FORBIDDEN');
});

test('#6 the monthly statement shows profit & loss (screen, print, copied month text) — owner only', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // a stock-count loss and an expense this month, so the lines are not all zero
  const T = jktToday();
  await editDb(page, `db.purchases.push({ id: 99901, purchase_date: arg, supplier: 'STOK OPNAME', product_id: db.products[0].id, name: db.products[0].name, qty: -1, cost_price: db.products[0].cost_price, total: 0, note: 'test' }); db.expenses.push({ id: 99902, expense_date: arg, category: 'listrik_air', amount: 12345, note: 'PLN', user: 'Pemilik', paid_from: 'kas' });`, T);
  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="month"]');
  await expect(page.locator('#pl-table')).toBeVisible();
  const P = (await page.evaluate(([f, t]) => api('profit_loss', { from: f, to: t }), [T.slice(0, 8) + '01', T])).pl;
  const db = await getDb(page);
  const ok = db.sales.filter(s => s.sale_date >= P.from && s.sale_date <= P.to && s.status !== 'void');
  expect(P.sales.total).toBe(ok.reduce((a, s) => a + s.total, 0));
  expect(P.gross_profit).toBe(ok.reduce((a, s) => a + s.profit, 0));
  expect(P.stock_diff.value).toBeLessThan(0);
  expect(P.expenses.total).toBeGreaterThanOrEqual(12345);
  expect(P.net_profit).toBe(P.gross_profit - P.expenses.total + P.returns.net + P.stock_diff.value + P.corrections.collected);
  await expect(page.locator('#pl-table tr[data-pl="sales"] td.r')).toHaveText(rp(P.sales.total));
  await expect(page.locator('#pl-table tr[data-pl="cogs"] td.r')).toHaveText(rp(-P.cogs));
  await expect(page.locator('#pl-table tr[data-pl="gross"] td.r')).toHaveText(rp(P.gross_profit));
  await expect(page.locator('#pl-table tr[data-pl="expenses"] td.r')).toHaveText(rp(-P.expenses.total));
  await expect(page.locator('#pl-table tr[data-pl="stock"] td.r')).toHaveText(rp(P.stock_diff.value));
  await expect(page.locator('#pl-table tr[data-pl="net"] td.r')).toHaveText(rp(P.net_profit));
  await expect(page.locator('#pl-table tr[data-pl="net"]')).toContainText(P.net_profit < 0 ? 'Rugi bersih' : 'Laba bersih');
  // print carries the profit & loss table
  await page.evaluate(() => { window.__printed = ''; window.printHTML = h => { window.__printed = h; }; });
  await page.click('[data-act="rep-print"]');
  const printed = await page.evaluate(() => window.__printed);
  expect(printed).toContain('id="pl-print"');
  expect(printed).toContain('Laba &amp; Rugi');
  // the copied month text (WhatsApp) ends with the profit & loss lines
  await page.click('[data-act="rep-copy"][data-kind="month"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  const txt = await page.evaluate(() => navigator.clipboard.readText());
  expect(txt).toContain('*Laba & Rugi:*');
  expect(txt).toContain('Harga pokok (modal barang terjual)');
  // Arabic
  await page.click('#tb-lang');
  await expect(page.locator('#rp-pl h3')).toContainText('الأرباح والخسائر');
  // nobody else gets it
  expect((await asUser(page, 'Jihan', '2222', 'profit_loss', { from: P.from, to: P.to })).error).toBe('FORBIDDEN');
});

test('#7 Ramadan season: computed every year by itself and shown in Absensi → Jam kerja; can be switched off', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'absensi');
  const box = page.locator('#att-ramadan');
  await expect(box).toBeVisible();
  const first = box.locator('#att-rm-list [data-hijri]').first();
  await expect(first).toHaveAttribute('data-hijri', '1448');
  await expect(first).toHaveAttribute('data-from', '2026-12-08');
  await expect(first).toHaveAttribute('data-to', '2027-03-09');
  await expect(first).toContainText('08/12/2026 – 09/03/2027 · tutup 23:00');
  await expect(first).toContainText('1 Ramadan 08/02/2027');
  await expect(page.locator('#att-rm-auto')).toBeChecked();
  // switch it off and change the closing time
  await page.uncheck('#att-rm-auto');
  await page.fill('#att-rm-end', '22:30');
  await page.click('#att-save-set');
  await expect(page.locator('.toast.ok')).toBeVisible();
  let db = await getDb(page);
  expect(db.att.settings).toMatchObject({ att_ramadan_auto: false, att_ramadan_end: '22:30' });
  expect(await page.evaluate(() => KAtt.hoursOn({ att_ramadan_auto: false }, '2027-01-10').end)).toBe('21:00');
  await expect(page.locator('#att-rm-list [data-hijri="1448"]')).toContainText('mati');
  await page.check('#att-rm-auto');
  await page.click('#att-save-set');
  await expect(page.locator('#att-rm-list [data-hijri="1448"]')).not.toContainText('mati');
  db = await getDb(page);
  expect(db.att.settings.att_ramadan_auto).toBe(true);
  // a day inside the season → 08:00–22:30 (the closing time just set)
  expect(await page.evaluate(s => KAtt.hoursOn(s, '2027-01-10'), db.att.settings)).toMatchObject({ start: '08:00', end: '22:30', auto: true });
});
