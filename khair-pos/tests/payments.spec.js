// v13 Payments: transfer slip read → prefill, MISMATCH, allocation to chosen invoices, ledger, allocate later, suppliers (kas).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, openApp, getDb, nav, photoFile, asUser, editDb } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (n < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
const parse = a => typeof a === 'string' ? JSON.parse(a || '[]') : (a || []);
/** Invoices of a customer, the server's way (v16): sales with debt minus the allocations of its payments (free = what an
 *  allocation may take), then money paid without an invoice applied to the oldest ones first (auto) → remaining. */
function ledger(db, cid) {
  const docs = db.sales.filter(s => s.customer_id === cid && s.status !== 'void' && s.debt_amount > 0).map(s => ({ ref: s.invoice_no, date: s.sale_date, total: s.debt_amount, paid: 0 }));
  const pays = db.payments.filter(p => p.customer_id === cid && (p.direction || 'in') === 'in');
  pays.forEach(p => parse(p.alloc).forEach(a => { const d = docs.find(x => x.ref === a.ref); if (d) d.paid += a.amount; }));
  let free = pays.reduce((a, p) => a + Math.max(0, p.amount - parse(p.alloc).reduce((b, x) => b + x.amount, 0)), 0);
  docs.sort((a, b) => a.date.localeCompare(b.date));
  docs.forEach(d => { d.free = Math.max(0, d.total - d.paid); const take = Math.min(free, d.free); d.auto = take; free -= take; d.remaining = d.free - take; });
  return docs;
}
const openDocs = (db, cid) => ledger(db, cid).filter(d => d.free > 0);

test('customer: slip photo pre-fills amount/bank/ref/date, MISMATCH needs a reason, part of a chosen invoice; ledger and "Atur alokasi"', async ({ page }) => {
  // the demo seed depends on the time of day (around 09:30 it adds a payment that clears Toko Berkah's debt): fix the clock
  await page.clock.setFixedTime(new Date(`${jktToday()}T08:00:00+07:00`));
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const T = jktToday();
  await page.evaluate(t => localStorage.setItem('kmock.pay', JSON.stringify({ date: t, amount: 250000, sender_name: 'TOKO BERKAH CONDET', bank: 'BCA', transfer_ref: '8800112233', readable: true, notes: '' })), T);
  let db = await getDb(page);
  const cust = db.customers.find(c => /Toko Berkah/.test(c.name));
  const docs = openDocs(db, cust.id);
  const target = docs.find((d, i) => i > 0 && d.free > 100000 && d.remaining > 0); // not the oldest one
  expect(target).toBeTruthy();

  await nav(page, 'customers');
  await page.locator('[data-act="cust-open"]').filter({ hasText: cust.name }).click();
  await expect(page.locator('#cd-ledger #led-docs')).toBeVisible();
  await expect(page.locator('#led-open-total')).toHaveText(rp(docs.reduce((a, d) => a + d.remaining, 0)));
  if (docs.some(d => d.auto)) await expect(page.locator('#led-docs [data-auto]').first()).toBeVisible();
  await expect(page.locator(`#led-docs tr[data-ref="${target.ref}"] [data-rem]`)).toHaveText(rp(target.remaining));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-ledger.png') });

  await page.click('[data-act="cust-pay"]');
  await expect(page.locator('#pay-modal')).toBeVisible();
  await page.setInputFiles('#py-slip', await photoFile(page, 'slip.png'));
  await expect(page.locator('#py-slip-name')).toHaveText('TOKO BERKAH CONDET');
  await expect(page.locator('#py-amt')).toHaveValue('250.000');
  await expect(page.locator('#py-m .on')).toHaveAttribute('data-m', 'transfer');
  await expect(page.locator('#py-bank')).toHaveValue('BCA');
  await expect(page.locator('#py-ref')).toHaveValue('8800112233');
  await expect(page.locator('#py-acc')).toHaveValue('BA1');
  await expect(page.locator('#py-datechk [data-datechk="ok"]')).toBeVisible();
  // a different amount than the slip → both amounts, a reason is required
  await page.fill('#py-amt', '200.000');
  await expect(page.locator('#py-mm')).toBeVisible();
  await expect(page.locator('#py-mm [data-mm="typed"]')).toHaveText(rp(200000));
  await expect(page.locator('#py-mm [data-mm="slip"]')).toHaveText(rp(250000));
  await page.click('#py-save');
  await expect(page.locator('#py-err')).toContainText('alasan');
  await page.fill('#py-amt', '250.000');
  await expect(page.locator('#py-mm')).toBeHidden();
  // "Bagian dari faktur no. …": the second-oldest open invoice, Rp 100.000
  await expect(page.locator('#py-alloc .alloc-row')).toHaveCount(docs.length);
  const row = page.locator(`#py-alloc .alloc-row[data-ref="${target.ref}"]`);
  await row.locator('[data-al-chk]').check();
  await row.locator('[data-al-amt]').fill('100.000');
  await expect(page.locator('#py-alloc-sum [data-al-left]')).toHaveText(rp(150000));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-receive-payment.png') });
  await page.click('#py-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Pembayaran' })).toBeVisible();
  db = await getDb(page);
  const pay = db.payments.slice(-1)[0];
  expect(pay).toMatchObject({ direction: 'in', party_type: 'customer', customer_id: cust.id, amount: 250000, method: 'transfer', bank: 'BCA', transfer_ref: '8800112233', account_id: 'BA1', slip_date: T, match_status: 'sebagian' });
  expect(pay.proof_photo_id).toMatch(/^PH-/);
  expect(parse(pay.alloc)).toEqual([{ ref: target.ref, amount: 100000 }]);
  // ledger: remaining of that invoice went down; payment row with status and allocation
  // the 150.000 not allocated counts for the oldest open invoices first (auto)
  const L2 = ledger(db, cust.id);
  await expect(page.locator(`#cd-ledger tr[data-ref="${target.ref}"] [data-rem]`).first()).toHaveText(rp(L2.find(d => d.ref === target.ref).remaining));
  await expect(page.locator('#led-open-total')).toHaveText(rp(L2.reduce((a, d) => a + d.remaining, 0)));
  const prow = page.locator(`#led-pays tr[data-pay="${pay.pay_id}"]`);
  await expect(prow.locator('[data-pay-status]')).toHaveAttribute('data-pay-status', 'sebagian');
  await expect(prow.locator('[data-alloc]')).toContainText(target.ref);
  await expect(prow.locator('[data-slip="ok"]')).toBeVisible();
  // the same slip reference cannot be used twice; a slip amount that differs without reason → MISMATCH (server rule)
  const sl = await asUser(page, 'Pemilik', '1234', 'scan_payment', { image_base64: 'AAAA', mime: 'image/jpeg' });
  expect(await asUser(page, 'Pemilik', '1234', 'receive_payment', { customer_id: cust.id, amount: 10000, method: 'transfer', transfer_ref: '8800112233' })).toMatchObject({ error: 'INVALID' });
  expect(await asUser(page, 'Pemilik', '1234', 'receive_payment', { customer_id: cust.id, amount: 10000, method: 'transfer', photo_id: sl.photo_id })).toMatchObject({ error: 'MISMATCH' });
  expect(await asUser(page, 'Pemilik', '1234', 'receive_payment', { customer_id: cust.id, amount: 10000, method: 'transfer', alloc: [{ ref: target.ref, amount: 20000 }] })).toMatchObject({ error: 'INVALID' });

  // allocate later: add the oldest invoice to this payment
  await prow.locator('[data-act="pay-alloc"]').click();
  await expect(page.locator('#alloc-modal')).toBeVisible();
  const oldest = docs[0];
  const take = Math.min(150000, oldest.free);
  const orow = page.locator(`#alloc-modal .alloc-row[data-ref="${oldest.ref}"]`);
  await orow.locator('[data-al-chk]').check();
  await orow.locator('[data-al-amt]').fill(NF.format(take));
  await page.fill('#al-note', 'Sisa untuk faktur terlama');
  await page.click('#al-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Alokasi' })).toBeVisible();
  db = await getDb(page);
  const p2 = db.payments.find(p => p.pay_id === pay.pay_id);
  expect(parse(p2.alloc)).toEqual(expect.arrayContaining([{ ref: oldest.ref, amount: take }, { ref: target.ref, amount: 100000 }]));
  expect(parse(p2.alloc)).toHaveLength(2);
  expect(p2.note).toContain('alokasi: Sisa untuk faktur terlama');
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'alokasi', ref: pay.pay_id });
});

test('seeded unallocated payment → "Atur alokasi" makes it lunas; manager allowed, kasir not', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  let db = await getDb(page);
  const cust = db.customers.find(c => /Al-Barokah/.test(c.name));
  const p0 = db.payments.filter(p => p.customer_id === cust.id && p.match_status === 'belum_dialokasi').slice(-1)[0];
  expect(p0).toBeTruthy();
  expect((await asUser(page, 'Siti', '1111', 'allocate_payment', { pay_id: p0.pay_id, customer_id: cust.id, alloc: [] })).error).toBe('FORBIDDEN');
  await nav(page, 'customers');
  await page.locator('[data-act="cust-open"]').filter({ hasText: cust.name }).click();
  await page.locator(`#led-pays tr[data-pay="${p0.pay_id}"] [data-act="pay-alloc"]`).click();
  await page.click('#al-auto');
  await page.click('#al-save');
  await expect(page.locator(`#led-pays tr[data-pay="${p0.pay_id}"] [data-pay-status]`)).not.toHaveAttribute('data-pay-status', 'belum_dialokasi');
  db = await getDb(page);
  const p1 = db.payments.find(p => p.pay_id === p0.pay_id);
  expect(parse(p1.alloc).reduce((a, x) => a + x.amount, 0)).toBe(Math.min(p0.amount, openDocs(Object.assign({}, db, { payments: db.payments.filter(p => p.pay_id !== p0.pay_id) }), cust.id).reduce((a, d) => a + d.free, 0)));
});

test('Pemasok: open notes and balance; pay a supplier from the drawer → expected cash goes down; phone + Arabic screenshot', async ({ page }) => {
  await openApp(page);
  // v15: managers no longer open drawers — this one was opened earlier and is still Jihan's
  await editDb(page, `db.shifts.push({ shift_id: 'SH-OLDJ', cashier: 'Jihan', shift_date: arg, opened_at: arg + 'T08:00:00+07:00', closed_at: '', status: 'open', opening_cash: 1000000, counted_cash: null, difference: null, note: '' });`, jktToday());
  await login(page, 'Jihan', '2222', '', { stay: true });
  const exp0 = await page.evaluate(async () => (await api('bootstrap')).shift.expected_cash);
  await nav(page, 'suppliers');
  const row = page.locator('#sp-rows [data-sup="PT Kurma Nusantara"]');
  await expect(row).toBeVisible();
  const led = await page.evaluate(() => api('party_ledger', { party_type: 'supplier', supplier: 'PT Kurma Nusantara' }));
  const open = led.docs.filter(d => d.remaining > 0);
  expect(open.length).toBeGreaterThan(0);
  await expect(row.locator('[data-remaining]')).toHaveText(rp(open.reduce((a, d) => a + d.remaining, 0)));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-suppliers.png') });
  await row.click();
  await expect(page.locator('#sd-ledger #led-docs tbody tr[data-ref]')).toHaveCount(open.length);
  await page.click('#sd-modal [data-act="sp-pay"]');
  await expect(page.locator('#pay-modal')).toBeVisible();
  await page.click('#py-m [data-m="tunai"]');
  await page.click('#py-from [data-f="kas"]');
  await page.fill('#py-amt', '300.000');
  await page.locator(`#py-alloc .alloc-row[data-ref="${open[0].ref}"] [data-al-chk]`).check();
  await page.locator(`#py-alloc .alloc-row[data-ref="${open[0].ref}"] [data-al-amt]`).fill(NF.format(Math.min(300000, open[0].remaining)));
  await page.click('#py-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'PT Kurma Nusantara' })).toBeVisible();
  const db = await getDb(page);
  const pay = db.payments.slice(-1)[0];
  expect(pay).toMatchObject({ direction: 'out', party_type: 'supplier', supplier: 'PT Kurma Nusantara', amount: 300000, method: 'tunai', paid_from: 'kas', shift_id: 'SH-OLDJ', account_id: '' });
  expect(pay.note).toContain('[dari kas]');
  const exp1 = await page.evaluate(async () => (await api('bootstrap')).shift.expected_cash);
  expect(exp1).toBe(exp0 - 300000);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'bayar_keluar', amount: 300000 });
  // without an own drawer the kas option is refused by the server
  expect((await asUser(page, 'Pemilik', '1234', 'pay_supplier', { supplier: 'PT Kurma Nusantara', amount: 1000, method: 'tunai', paid_from: 'kas' })).error).toBe('SHIFT_REQUIRED');
  expect((await asUser(page, 'Siti', '1111', 'pay_supplier', { supplier: 'PT Kurma Nusantara', amount: 1000, method: 'transfer' })).error).toBe('FORBIDDEN');
  expect((await asUser(page, 'Siti', '1111', 'party_ledger', { party_type: 'supplier', supplier: 'PT Kurma Nusantara' })).error).toBe('FORBIDDEN');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await page.click('#tb-lang');
  await nav(page, 'suppliers');
  await expect(page.locator('#view-suppliers h1')).toHaveText('الموردون');
  await expect(page.locator('#sp-rows .li').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'phone-suppliers-ar.png') });
  await page.locator('#sp-rows [data-sup="PT Kurma Nusantara"]').click();
  await expect(page.locator('#sd-ledger #led-pays')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'phone-ledger-ar.png') });
});
