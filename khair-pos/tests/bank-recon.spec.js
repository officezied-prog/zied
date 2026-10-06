// v14 Company bank account: settings, monthly statement import (CSV, Indonesian formats), reconciliation report, manual match / ignore.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, asUser, editDb } = require('./helpers');

const prevMonth = () => { const d = new Date(jktToday().slice(0, 8) + '01T00:00:00Z'); d.setUTCDate(0); return d.toISOString().slice(0, 7); };
async function openBank(page, period) {
  await nav(page, 'bank');
  await page.fill('#bk-period', period);
  await page.locator('#bk-period').dispatchEvent('change');
  await expect(page.locator('#bk-recon')).toContainText(period);
}

test('Pengaturan: bank accounts of the shop (add, validate, save)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await expect(page.locator('#st-bank-rows .st-bank-row[data-acc="BA1"] [data-k="account_no"]')).toHaveValue('1234567890');
  await page.click('#st-bank-add');
  const row = page.locator('#st-bank-rows .st-bank-row').last();
  await row.locator('[data-k="bank"]').fill('BRI');
  await row.locator('[data-k="account_no"]').fill('0987-65');
  await page.click('[data-act="set-save-bank"]');
  await expect(page.locator('#st-bank-err')).toContainText('nomor rekening');
  await row.locator('[data-k="account_no"]').fill('098765432101');
  await row.locator('[data-k="holder"]').fill('Khair Mart Cabang');
  await page.click('[data-act="set-save-bank"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  const accs = (await getDb(page)).settings.bank_accounts;
  expect(accs.map(a => a.id)).toEqual(['BA1', 'BA2', 'BA3']);
  expect(accs[2]).toEqual({ id: 'BA3', bank: 'BRI', account_no: '098765432101', holder: 'Khair Mart Cabang', active: true });
  // the payment form offers the active accounts, first one by default
  await nav(page, 'customers');
  await page.locator('[data-act="cust-open"]').first().click();
  await page.click('[data-act="cust-pay"]');
  await page.click('#py-m [data-m="transfer"]');
  await expect(page.locator('#py-acc option')).toHaveCount(2);
  await expect(page.locator('#py-acc')).toHaveValue('BA1');
});

test('seeded month: every status with clear groups, totals, manual match, ignore, reopen; CSV export', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true }); // the manager / accountant
  const pm = prevMonth();
  await openBank(page, pm);
  const c = s => page.locator(`#bk-counts [data-count="${s}"]`);
  await expect(c('cocok')).toContainText(': 5');
  await expect(c('manual')).toContainText(': 1');
  await expect(c('beda_tanggal')).toContainText(': 1');
  await expect(c('beda_jumlah')).toContainText(': 1');
  await expect(c('tidak_tercatat')).toContainText(': 2');
  await expect(c('missing')).toContainText(': 1');
  await expect(c('diabaikan')).toContainText(': 1');
  const rep = await page.evaluate(p => api('bank_recon', { account_id: 'BA1', period: p }), pm);
  expect(rep.imported).toBe(true);
  await expect(page.locator('[data-kpi="st-in"] .v')).toContainText(new Intl.NumberFormat('id-ID').format(rep.totals.statement_in));
  await expect(page.locator('[data-diff="out"]')).toContainText(new Intl.NumberFormat('id-ID').format(Math.abs(rep.totals.statement_out - rep.totals.recorded_out)));
  // the line recorded 2 days late, and the amount that differs from the bank
  await expect(page.locator('[data-group="beda_tanggal"] tr[data-line]')).toContainText('beda 2 hari');
  await expect(page.locator('[data-group="beda_jumlah"] tr[data-line]')).toContainText('Grosir Kramat Jati');
  // the recorded payments of the month: slip amount ✓ and slip date vs recorded date
  const late = page.locator('#bk-pays tr[data-pay]').filter({ hasText: 'Toko Al-Barokah' }).filter({ hasText: '600.000' });
  await expect(late.locator('[data-date-ok="false"]')).toContainText('Beda tanggal');
  await expect(late.locator('[data-amt-ok="true"]')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-bank-recon.png'), fullPage: true });

  // ignore the cash deposit (note required), match the interest line by hand with the missing payment, then reopen it
  const dep = page.locator('[data-group="tidak_tercatat"] tr[data-line]').filter({ hasText: 'SETORAN TUNAI' });
  await dep.locator('[data-act="bk-ignore"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('#cf-err')).toContainText('Wajib');
  await page.fill('#cf-in', 'Setoran kas toko ke bank');
  await page.click('#cf-ok');
  await expect(c('diabaikan')).toContainText(': 2');
  const giro = page.locator('[data-group="tidak_tercatat"] tr[data-line]').filter({ hasText: 'BUNGA JASA GIRO' });
  const lineId = await giro.getAttribute('data-line');
  await giro.locator('[data-act="bk-match"]').click();
  await page.locator('#bk-cands input[type="radio"]').first().check();
  await page.click('#bk-match-ok');
  await expect(page.locator('#bk-err')).toContainText('Wajib');
  await page.fill('#bk-note', 'Dicocokkan untuk uji');
  await page.click('#bk-match-ok');
  await expect(c('manual')).toContainText(': 2');
  await expect(c('tidak_tercatat')).toContainText(': 0');
  let db = await getDb(page);
  expect(db.bank_lines.find(l => l.line_id === lineId)).toMatchObject({ status: 'manual', note: 'Dicocokkan untuk uji' });
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'rekening', user: 'Jihan' });
  await page.locator(`[data-group="manual"] tr[data-line="${lineId}"] [data-act="bk-reopen"]`).click();
  await expect(c('tidak_tercatat')).toContainText(': 1');
  // CSV export of the report
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bk-csv')]);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  expect(dl.suggestedFilename()).toBe(`rekonsiliasi-BCA-1234567890-${pm}.csv`);
  expect(csv).toContain('TRSF E-BANKING CR');
  expect(csv).toContain('"Beda jumlah"');
  // kasir and sales accounts may not see the bank account
  for (const [u, pin] of [['Siti', '1111'], ['Ahmad', '4444']]) expect((await asUser(page, u, pin, 'bank_recon', { account_id: 'BA1', period: pm })).error).toBe('FORBIDDEN');
  expect((await asUser(page, 'Siti', '1111', 'import_statement', { account_id: 'BA1', period: pm, lines: [{ date: pm + '-02', amount: 1 }] })).error).toBe('FORBIDDEN');
});

test('import a bank CSV (Indonesian numbers, DD/MM/YYYY, DD/MM, ISO dates): mapping guessed and remembered per bank; transfer matched by reference', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const T = jktToday(), period = T.slice(0, 7), [y, m, d] = T.split('-');
  const db0 = await getDb(page);
  const cust = db0.customers.find(c => c.debt_balance > 345000);
  const pay = await page.evaluate(([cid, t]) => api('receive_payment', { customer_id: cid, amount: 345000, method: 'transfer', bank: 'BCA', transfer_ref: '7781234567', pay_date: t, account_id: 'BA1' }), [cust.id, T]);
  expect(pay.payment.account_id).toBe('BA1');
  const csv = ['Informasi Rekening - Mutasi Rekening', 'No. rekening :,1234567890', '',
    'Tanggal Transaksi;Keterangan;Debet;Kredit;Saldo',
    `${d}/${m}/${y};TRSF E-BANKING CR 7781234567 TOKO;;345.000,00;12.345.000,00`,
    `'${d}/${m};BIAYA ADM;10.000,00;;12.335.000,00`,
    `${T};SETORAN TUNAI;;1.250.000,00;13.585.000,00`].join('\r\n');
  await nav(page, 'bank');
  await page.fill('#bk-period', period);
  await page.locator('#bk-period').dispatchEvent('change');
  await page.click('#bk-import-btn');
  await expect(page.locator('#bi-period')).toHaveValue(period);
  await page.setInputFiles('#bi-file', { name: 'mutasi-bca.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(page.locator('#bi-m-date option:checked')).toHaveText('Tanggal Transaksi');
  await expect(page.locator('#bi-m-description option:checked')).toHaveText('Keterangan');
  await expect(page.locator('#bi-m-debit option:checked')).toHaveText('Debet');
  await expect(page.locator('#bi-m-credit option:checked')).toHaveText('Kredit');
  await expect(page.locator('#bi-m-balance option:checked')).toHaveText('Saldo');
  await expect(page.locator('#bi-prev tbody tr')).toHaveCount(3);
  await expect(page.locator('#bi-prev tbody tr.diff')).toHaveCount(0);
  await expect(page.locator('#bi-prev tbody tr').nth(1)).toContainText('-Rp 10.000');
  await expect(page.locator('#bi-sum')).toContainText('3 dari 3');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-bank-import.png') });
  await page.click('#bi-go');
  await expect(page.locator('.toast.ok').filter({ hasText: '3 baris' })).toBeVisible();
  const db = await getDb(page);
  const lines = db.bank_lines.filter(l => l.period === period && l.account_id === 'BA1').sort((a, b) => a.seq - b.seq);
  expect(lines.map(l => [l.line_date, l.amount, l.balance])).toEqual([[T, 345000, 12345000], [T, -10000, 12335000], [T, 1250000, 13585000]]);
  expect(lines[0]).toMatchObject({ status: 'cocok', pay_id: pay.payment.pay_id });
  await expect(page.locator('[data-group="cocok"]')).toContainText('7781234567');
  // the mapping is remembered for BCA
  const map = await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.bk_map_bca')));
  expect(map.headers).toEqual(['Tanggal Transaksi', 'Keterangan', 'Debet', 'Kredit', 'Saldo']);
  // parser units
  expect(await page.evaluate(() => [KPOS.bankAmount('1.250.000,00'), KPOS.bankAmount('1,250,000.00'), KPOS.bankAmount('50.000 DB'), KPOS.bankAmount('75.000,00 CR'), KPOS.bankAmount('(20.000)'), KPOS.bankDate('06/10/2026', '2026-10'), KPOS.bankDate('6/10', '2026-10'), KPOS.bankDate('2026-10-06'), KPOS.bankDate("'06/10/26", '2026-10')]))
    .toEqual([1250000, 1250000, -50000, 75000, -20000, '2026-10-06', '2026-10-06', '2026-10-06', '2026-10-06']);
});

test('Beranda reminds when last month\'s statement is not imported; phone + Arabic', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const pm = prevMonth();
  await editDb(page, 'db.bank_lines = db.bank_lines.filter(l => l.period !== arg);', pm);
  await page.evaluate(() => { BK.att = null; return refreshAttention(); });
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="bank-BA1"]')).toContainText(`Rekonsiliasi rekening bulan lalu belum dibuat (BCA 1234567890, ${pm})`);
  await page.locator('#bell-att [data-key="bank-BA1"]').click();
  await expect(page.locator('#view-bank')).toBeVisible();
  await page.click('#tb-lang');
  await page.fill('#bk-period', pm);
  await page.locator('#bk-period').dispatchEvent('change');
  await expect(page.locator('#bk-not-imported')).toBeVisible();
  await expect(page.locator('#view-bank h1')).toHaveText('الحساب البنكي للشركة');
  await page.screenshot({ path: path.join(SHOTS, 'phone-bank-ar.png') });
});
