// v13 customer payments: the transfer slip read by the AI pre-fills amount / bank / reference / date; the cashier says
// which invoices the payment covers (partial allowed); an amount different from the slip needs a reason (MISMATCH).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const jkt = (d = 0) => new Date(Date.now() + 7 * 3600000 + d * 86400000).toISOString().slice(0, 10);
/** A customer with two open invoices: KMUJI-0001 (Rp 300.000 debt, 10 days ago) and KMUJI-0002 (Rp 200.000 of 250.000, 3 days ago). */
const SETUP = `
  const id = 99, d1 = arg.d1, d2 = arg.d2;
  db.customers.push({ id, name: 'Toko Uji Bayar', phone: '0812-9999-0000', type: 'grosir', address: '', notes: '', debt_balance: 500000, wa_optin: false, source: '' });
  const sale = (no, date, total, paid) => ({ id: 90000 + Number(no.slice(-1)), invoice_no: no, sale_date: date, sale_time: date + 'T10:00:00+07:00', cashier: 'Siti', customer_id: id, customer_name: 'Toko Uji Bayar', customer_type: 'grosir',
    subtotal: total, discount: 0, total, total_cost: 0, profit: 0, payment_method: 'hutang', paid_amount: paid, debt_amount: total - paid, status: 'ok', survey: '[]', notes: '', client_id: 'uji-' + no, approved_by: 'Pemilik', shift_id: '' });
  db.sales.push(sale('KMUJI-0001', d1, 300000, 0), sale('KMUJI-0002', d2, 250000, 50000));
`;
async function setup(page, slip) {
  await H.openKasir(page);
  await H.setDb(page, SETUP, { d1: jkt(-10), d2: jkt(-3) });
  await page.evaluate(s => localStorage.setItem('kmock.scanpay', JSON.stringify(s)), slip);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await H.tab(page, 'more');
  await page.click('#m-debt');
  await page.fill('#cp-q', 'uji bayar');
  await page.locator('#cp-list [data-pick="99"]').click();
  await expect(page.locator('#debt-pay')).toBeVisible();
  await expect(page.locator('#py-debt')).toHaveText(H.rp(500000));
}
async function slipPhoto(page) {
  await page.click('#py-m-transfer');
  await page.setInputFiles('#py-photo', await H.photoFile(page, 'bukti.png'));
  await expect(page.locator('#py-slip-ok')).toBeVisible();
}

test('slip prefill → partial allocation to chosen invoices → payment with bank, reference, slip, alloc and match_status', async ({ page }) => {
  await setup(page, { date: jkt(), amount: 350000, sender_name: 'BUDI SANTOSO', receiver_name: 'KHAIR MART', bank: 'BRI', transfer_ref: 'BRI-778812', readable: true, notes: '' });
  // invoices oldest first
  const docs = page.locator('#py-docs .al');
  await expect(docs).toHaveCount(2);
  await expect(docs.nth(0)).toHaveAttribute('data-ref', 'KMUJI-0001');
  await expect(docs.nth(1)).toContainText(H.rp(200000));
  await slipPhoto(page);
  await expect(page.locator('#py-sender')).toContainText('BUDI SANTOSO');
  await expect(page.locator('#py-amt')).toHaveValue('350.000');
  await expect(page.locator('#py-bank')).toHaveValue('BRI');
  await expect(page.locator('#py-ref')).toHaveValue('BRI-778812');
  await expect(page.locator('#py-date')).toHaveValue(jkt());
  await expect(page.locator('#py-mismatch')).toHaveCount(0);
  // "isi otomatis": oldest first
  await page.click('#py-auto');
  await expect(page.locator('[data-al-amt="KMUJI-0001"]')).toHaveValue('300.000');
  await expect(page.locator('[data-al-amt="KMUJI-0002"]')).toHaveValue('50.000');
  await expect(page.locator('#py-left')).toHaveText(H.rp(0));
  // the customer says: 150.000 of the old invoice, the newer one in full
  await page.fill('[data-al-amt="KMUJI-0001"]', '150000');
  await expect(page.locator('#py-left')).toHaveText(H.rp(150000));
  await page.fill('[data-al-amt="KMUJI-0002"]', '250000');
  await expect(page.locator('#py-alloc-err')).toContainText('KMUJI-0002');
  await page.fill('[data-al-amt="KMUJI-0002"]', '200000');
  await expect(page.locator('#py-alloc-err')).toHaveCount(0);
  await expect(page.locator('#py-allocated')).toHaveText(H.rp(350000));
  await expect(page.locator('#debt-pay')).not.toContainText(/modal|HPP|laba/i);
  await page.locator('#py-alloc').scrollIntoViewIfNeeded();
  await H.shot(page, 'phone-38-slip-allocation', false, { noToasts: true });
  await page.click('#py-ok');
  await expect(page.locator('.toast.ok')).toContainText('sebagian faktur');
  await expect(page.locator('#debt-pay')).toHaveCount(0);

  const db = await H.getDb(page);
  const pay = db.payments[db.payments.length - 1];
  expect(pay).toMatchObject({ direction: 'in', party_type: 'customer', customer_id: 99, amount: 350000, method: 'transfer', bank: 'BRI', transfer_ref: 'BRI-778812',
    slip_date: jkt(), pay_date: jkt(), match_status: 'sebagian', cashier: 'Siti' });
  expect(pay.pay_id).toMatch(/^PY/);
  expect(JSON.parse(pay.alloc)).toEqual([{ ref: 'KMUJI-0001', amount: 150000 }, { ref: 'KMUJI-0002', amount: 200000 }]);
  const ph = db.photos.find(p => p.photo_id === pay.proof_photo_id);
  expect(ph).toMatchObject({ kind: 'bayar', ref: pay.pay_id, user: 'Siti' });
  expect(db.customers.find(c => c.id === 99).debt_balance).toBe(150000);
  const act = db.activity.find(a => a.kind === 'bayar_masuk' && a.ref === pay.pay_id);
  expect(act).toMatchObject({ user: 'Siti', amount: 350000, level: 'info' });
  expect(act.summary).toContain('untuk KMUJI-0001 Rp 150000, KMUJI-0002 Rp 200000');
  // ledger: what is left of each invoice
  const led = await page.evaluate(async () => (await api('party_ledger', { party_type: 'customer', customer_id: 99 })));
  expect(led.docs.map(d => [d.ref, d.remaining])).toEqual([['KMUJI-0001', 150000], ['KMUJI-0002', 0]]);
  expect(led.balance).toBe(150000);
  // a kasir cannot see supplier ledgers (cost)
  const sup = await page.evaluate(async () => { try { await api('party_ledger', { party_type: 'supplier', supplier: 'CV Timur Tengah Food' }); return 'ok'; } catch (e) { return e.code; } });
  expect(sup).toBe('FORBIDDEN');
});

test('amount ≠ slip → both amounts shown; reason or "Pakai jumlah di bukti"; server MISMATCH without a reason', async ({ page }) => {
  await setup(page, { date: jkt(-1), amount: 100000, sender_name: 'HALIMAH', receiver_name: 'KHAIR MART', bank: 'BCA', transfer_ref: 'BCA-55102', readable: true, notes: '' });
  await slipPhoto(page);
  await expect(page.locator('#py-amt')).toHaveValue('100.000');
  await page.fill('#py-amt', '120000');
  const mm = page.locator('#py-mismatch');
  await expect(mm).toBeVisible();
  await expect(page.locator('#py-mm-typed')).toHaveText(H.rp(120000));
  await expect(page.locator('#py-mm-slip')).toHaveText(H.rp(100000));
  await page.click('#py-ok');
  await expect(page.locator('#py-err')).toContainText('beda dengan bukti');
  await page.click('#py-use-slip');
  await expect(mm).toHaveCount(0);
  await expect(page.locator('#py-amt')).toHaveValue('100.000');
  await page.fill('#py-amt', '120000');
  await page.fill('#py-reason', 'Sisa 20 rb dibayar tunai');
  await page.click('#py-ok');
  await expect(page.locator('#debt-pay')).toHaveCount(0);
  let db = await H.getDb(page);
  const pay = db.payments[db.payments.length - 1];
  expect(pay).toMatchObject({ amount: 120000, method: 'transfer', bank: 'BCA', transfer_ref: 'BCA-55102', match_status: 'belum_dialokasi', slip_date: jkt(-1) });
  expect(pay.note).toContain('beda dengan bukti: Sisa 20 rb dibayar tunai');
  const act = db.activity.find(a => a.kind === 'bayar_masuk' && a.ref === pay.pay_id);
  expect(act.level).toBe('warn');
  expect(pay.pay_date).toBe(jkt(-1)); // the date was taken from the slip, so no "tanggal bukti ≠ dicatat" flag
  expect(act.summary).not.toContain('tanggal bukti');
  // the server itself refuses a different amount without a reason, and a transfer number used twice
  const r = await page.evaluate(async () => {
    const out = {};
    const ph = await apiPhoto('scan_payment', { image_base64: 'AAAA', mime: 'image/jpeg' });
    try { await api('receive_payment', { customer_id: 99, amount: 90000, method: 'transfer', photo_id: ph.photo_id }); out.a = 'ok'; } catch (e) { out.a = e.code; out.slip = e.res && e.res.slip_amount; }
    try { await api('receive_payment', { customer_id: 99, amount: 10000, method: 'transfer', transfer_ref: 'bca-55102' }); out.b = 'ok'; } catch (e) { out.b = e.code; out.msg = e.message; }
    try { await api('receive_payment', { customer_id: 99, amount: 10000, method: 'tunai', alloc: [{ ref: 'KM999999-0001', amount: 10000 }] }); out.c = 'ok'; } catch (e) { out.c = e.code; }
    return out;
  });
  expect(r).toMatchObject({ a: 'MISMATCH', slip: 100000, b: 'INVALID', c: 'INVALID' });
  expect(r.msg).toContain('sudah pernah dipakai');
  db = await H.getDb(page);
  expect(db.payments.filter(p => p.customer_id === 99)).toHaveLength(1);
});

test('offline: the payment with slip and allocation waits in the outbox with all its fields, then syncs', async ({ page }) => {
  await setup(page, { date: jkt(), amount: 300000, sender_name: 'TOKO UJI', receiver_name: 'KHAIR MART', bank: 'Mandiri', transfer_ref: 'MDR-9001', readable: true, notes: '' });
  await slipPhoto(page);
  await page.locator('[data-al-chk="KMUJI-0001"]').check();
  await expect(page.locator('[data-al-amt="KMUJI-0001"]')).toHaveValue('300.000');
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  await page.click('#py-ok');
  await expect(page.locator('.toast.warn')).toContainText('Offline');
  const q = await page.evaluate(() => window.KASIR.S.outbox.find(e => e.kind === 'payment'));
  expect(q.data).toMatchObject({ customer_id: 99, amount: 300000, method: 'transfer', bank: 'Mandiri', transfer_ref: 'MDR-9001', alloc: [{ ref: 'KMUJI-0001', amount: 300000 }] });
  expect(q.data.photo_id).toMatch(/^PH-/);
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  await page.evaluate(() => window.KASIR.syncOutbox(true));
  await expect.poll(async () => (await H.getDb(page)).payments.filter(p => p.customer_id === 99).length).toBe(1);
  const pay = (await H.getDb(page)).payments.find(p => p.customer_id === 99);
  expect(pay).toMatchObject({ match_status: 'lunas', proof_photo_id: q.data.photo_id });
});
