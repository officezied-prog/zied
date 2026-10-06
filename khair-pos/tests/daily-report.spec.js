// v15 Daily report (one tap per WhatsApp number), report settings, morning drawer approval (buka_kas).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, asUser, editDb } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (n < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
function expected(db, day) {
  const ok = db.sales.filter(s => s.sale_date === day && s.status !== 'void');
  const by = { tunai: 0, transfer: 0, qris: 0 };
  ok.forEach(s => { const paid = Math.min(s.paid_amount, s.total); by[by[s.payment_method] !== undefined ? s.payment_method : 'tunai'] += paid; });
  const inv = new Set(ok.map(s => s.invoice_no));
  const pin = db.payments.filter(p => p.pay_date === day && (p.direction || 'in') === 'in');
  const sumM = m => pin.filter(p => p.method === m).reduce((a, p) => a + p.amount, 0);
  return { count: ok.length, total: ok.reduce((a, s) => a + s.total, 0), debt: ok.reduce((a, s) => a + s.debt_amount, 0), items: db.items.filter(i => inv.has(i.invoice_no)).reduce((a, i) => a + i.qty, 0),
    by, bankIn: by.transfer + by.qris + sumM('transfer') + sumM('qris'), profit: ok.reduce((a, s) => a + s.profit, 0) };
}

test('owner: numbers of a seeded day per method; WhatsApp links to the shop, manager and owner numbers; profit only when ticked', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // Pengaturan: the three WhatsApp numbers (normalised) and the reminder time
  await nav(page, 'settings');
  await page.fill('#st-wa-company', '0812-8000-2700');
  await page.fill('#st-wa-manager', '0813 1111 2222');
  await page.fill('#st-wa-owner', '12');
  await page.click('[data-act="set-save-report"]');
  await expect(page.locator('#st-report-err')).toContainText('Nomor tidak valid');
  await page.fill('#st-wa-owner', '+62 811 9008 0090');
  await page.fill('#st-report-time', '20:30');
  await page.click('[data-act="set-save-report"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  let db = await getDb(page);
  expect(db.settings).toMatchObject({ wa_shop_number: '6281280002700', wa_manager_number: '6281311112222', wa_owner_number: '6281190080090', report_time: '20:30' });

  const day = jktToday(-1), E = expected(db, day);
  expect(E.count).toBeGreaterThan(3);
  await nav(page, 'home');
  await page.click('#home-daily');
  await expect(page.locator('#dr-body')).toBeVisible();
  await page.fill('#dr-date', day);
  await page.locator('#dr-date').dispatchEvent('change');
  await expect(page.locator('[data-kpi="dr-total"] .v')).toHaveText(rp(E.total));
  await expect(page.locator('[data-kpi="dr-total"] .s')).toHaveText(`${E.count} transaksi`);
  await expect(page.locator('[data-dr="tunai"]')).toHaveText(rp(E.by.tunai));
  await expect(page.locator('[data-dr="transfer"]')).toHaveText(rp(E.by.transfer));
  await expect(page.locator('[data-dr="qris"]')).toHaveText(rp(E.by.qris));
  await expect(page.locator('[data-dr="hutang"]')).toHaveText(rp(E.debt));
  await expect(page.locator('[data-dr="b-in"]')).toHaveText(rp(E.bankIn));
  await expect(page.locator('[data-kpi="dr-profit"] .v')).toHaveText(rp(E.profit));
  const href = async k => decodeURIComponent((await page.locator(`#dr-wa-${k}`).getAttribute('href')));
  expect(await href('company')).toMatch(/^https:\/\/wa\.me\/6281280002700\?text=/);
  expect(await href('manager')).toMatch(/^https:\/\/wa\.me\/6281311112222\?text=/);
  expect(await href('owner')).toMatch(/^https:\/\/wa\.me\/6281190080090\?text=/);
  const msg = await href('company');
  expect(msg).toContain(`Total penjualan: *${rp(E.total)}*`);
  expect(msg).toContain(`• Tunai: ${rp(E.by.tunai)}`);
  expect(msg).toContain(`• QRIS: ${rp(E.by.qris)}`);
  expect(msg).toContain(`Masuk rekening bank: *${rp(E.bankIn)}*`);
  expect(msg).not.toContain('Laba');
  await page.check('#dr-profit');
  expect(await href('owner')).toContain(`Laba kotor: ${rp(E.profit)}`);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-daily-report.png') });
  // an empty number hides its button
  await page.evaluate(() => saveSettings({ wa_manager_number: '' }));
  await page.click('[data-act="dr-refresh"]');
  await expect(page.locator('#dr-wa-manager')).toHaveCount(0);
  await expect(page.locator('#dr-wa-company')).toBeVisible();
});

test('reminder after report_time until sent from this device; the manager sees no profit', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await editDb(page, `db.settings.report_time = '00:00'; db.settings.wa_shop_number = '6281280002700';`);
  await page.evaluate(() => refreshData(true).then(() => refreshAttention()));
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="daily"]')).toContainText('Kirim laporan harian');
  await page.locator('#bell-att [data-key="daily"]').click();
  await expect(page.locator('#dr-body [data-dr="tunai"]')).toBeVisible();
  await expect(page.locator('#dr-profit')).toHaveCount(0);
  await expect(page.locator('[data-kpi="dr-profit"]')).toHaveCount(0);
  const r = await page.evaluate(() => api('daily_report', { date: today() }));
  expect('profit' in r.report).toBe(false);
  expect(decodeURIComponent(await page.locator('#dr-wa-company').getAttribute('href'))).not.toContain('Laba');
  // tapping a WhatsApp button marks today's report as sent (stays on this page in the test)
  await page.locator('#dr-wa-company').evaluate(a => { a.addEventListener('click', e => e.preventDefault()); a.click(); });
  await page.evaluate(() => refreshAttention());
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="daily"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await asUser(page, 'Siti', '1111', 'daily_report', { date: jktToday() })).error).toBe('FORBIDDEN');
  // phone + Arabic
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tb-lang');
  await nav(page, 'reports');
  await expect(page.locator('#view-reports h1')).toHaveText('التقرير اليومي');
  await expect(page.locator('#dr-body [data-dr="tunai"]')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'phone-daily-report-ar.png') });
});

test('morning drawer opening (kasir) → buka_kas card with last count and difference; manager approves; Beranda item', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const last = db0.shifts.filter(x => x.status === 'closed').sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))[0];
  const o = await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: last.counted_cash + 25000, note: 'Uang pecahan dari bank' });
  expect(o.shift.cashier).toBe('Siti');
  await page.evaluate(() => pollApprovals().then(() => refreshAttention()));
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="bukakas"]')).toContainText('Buka kas menunggu persetujuan (1)');
  await page.locator('#bell-att [data-key="bukakas"]').click();
  const card = page.locator('.apr-card[data-kind="buka_kas"]');
  await expect(card.locator('[data-v="opening"]')).toHaveText(rp(last.counted_cash + 25000));
  await expect(card.locator('[data-v="last"]')).toHaveText(rp(last.counted_cash));
  await expect(card.locator('[data-v="diff"]')).toHaveText('+' + rp(25000));
  await expect(card.locator('[data-v="diff"]')).toHaveClass(/red/);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approvals-bukakas.png') });
  await card.locator('[data-d="approved"]').click();
  await expect(page.locator('.apr-card[data-kind="buka_kas"]')).toHaveCount(0);
  const db = await getDb(page);
  expect(db.approvals.find(a => a.kind === 'buka_kas')).toMatchObject({ status: 'approved', decided_by: 'Jihan', ref: o.shift.shift_id });
  expect(db.activity.filter(a => a.kind === 'buka_kas').slice(-1)[0]).toMatchObject({ user: 'Siti', level: 'warn' });
});
