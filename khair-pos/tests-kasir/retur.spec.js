// v16 returns (retur). Customer: invoice → lines (≤ bought − returned) → reason, who brings it back, refund method →
// request_return → the manager approves (the owner above return_owner_min_value) → the return note (RT number). Supplier:
// from a goods-in (purchase_no) with the outgoing note number, a photo and who takes the goods; no values for the kasir.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

async function manager(context, user = 'Jihan', pin = '2222') {
  const p = await context.newPage();
  await p.addInitScript(() => { localStorage.removeItem('kpos.mock.kasir.session'); });
  await H.login(p, user, pin);
  return p;
}
const retCard = page => page.locator('.apr-card[data-kind="retur"]');

test('customer return: invoice from the receipt, limits, manager approves, cash back from the drawer, return note', async ({ page, context }) => {
  await H.login(page);
  await H.setDb(page, `db.products.forEach(p => { if (/Ajwa|Medjool/.test(p.name)) p.shop_stock = p.stock; });`);
  await page.evaluate(() => refreshData(true));
  await H.addItem(page, 'ajwa', { qty: 2 });
  await H.addItem(page, 'medjool', { qty: 1 });
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  await page.click('#rc-new');
  let db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1], inv = sale.invoice_no;
  const aj0 = H.productByName(db, /Ajwa/), med0 = H.productByName(db, /Medjool/);

  // "Struk terakhir" → Retur: the invoice is looked up at once
  await H.tab(page, 'more');
  await page.click('#m-last');
  await page.click('#rc-retur');
  const m = page.locator('#retur');
  await expect(m.locator('#rt-sale')).toHaveAttribute('data-inv', inv);
  await expect(m.locator('#rt-buyer')).toHaveText('Umum');
  const aj = m.locator(`[data-rt-line="${aj0.id}"]`), med = m.locator(`[data-rt-line="${med0.id}"]`);
  await expect(aj).toContainText('Dibeli 2 · sudah diretur 0 · bisa 2 kg');
  await aj.locator('[data-rt-qty]').fill('3');
  await page.click('#rt-send');
  await expect(m.locator('#rt-err')).toHaveText('Kurma Ajwa Al-Madinah 1 kg: paling banyak 2');
  await aj.locator('[data-rt-qty]').fill('1');
  await med.locator('[data-rt-qty]').fill('1');
  await med.locator('[data-c="rusak"]').click();
  await expect(m.locator('#rt-amount')).toHaveText(H.rp(175000 + 215000));
  await page.click('#rt-send');
  await expect(m.locator('#rt-err')).toHaveText('Pilih alasan retur');
  await m.locator('#rt-reason').selectOption('lainnya');
  await page.click('#rt-send');
  await expect(m.locator('#rt-err')).toHaveText('Tulis alasan retur');
  await m.locator('#rt-note').fill('Salah <beli> varian'); // < > never get in
  await m.locator('#rt-by').fill('Pak Budi; 123');
  await expect(m.locator('#rt-by')).toHaveValue('Pak Budi 123');
  await m.locator('#rt-phone').fill('0812-9988-7766');
  await expect(m.locator('#rt-phone')).toHaveValue('081299887766');
  await H.shot(page, 'phone-53-retur-customer', false, { noToasts: true });
  await page.click('#rt-send');
  const wait = m.locator('#rt-wait');
  await expect(wait).toBeVisible();
  await expect(wait.locator('[data-approver]')).toHaveText('Menunggu persetujuan manajer.');
  const rid = (await m.locator('#rt-id').textContent()).trim();
  expect(rid).toMatch(/^RT\d{6}-[A-Z0-9]{4}$/);
  db = await H.getDb(page);
  const ap = db.approvals.find(a => a.kind === 'retur' && a.ref === rid);
  expect(ap).toMatchObject({ status: 'pending', approver_role: 'manager', cashier: 'Siti', total: 390000, note: 'Salah beli varian' });
  expect(JSON.parse(ap.payload)).toMatchObject({ kind: 'pelanggan', ref: inv, returned_by: 'Pak Budi 123', returned_by_phone: '6281299887766', refund_method: 'tunai', refund: 390000, value: 390000 });
  expect(db.activity.find(a => a.kind === 'minta_retur' && a.ref === rid)).toMatchObject({ user: 'Siti', level: 'warn' });
  // the pending return counts: the same items cannot be asked twice
  const again = await page.evaluate(async ([no, id]) => { try { await api('request_return', { kind: 'pelanggan', invoice_no: no, lines: [{ product_id: id, qty: 2 }], reason_code: 'rusak' }); return 'ok'; } catch (e) { return e.code + ' ' + e.message; } }, [inv, aj0.id]);
  expect(again).toBe('INVALID Jumlah retur melebihi yang dibeli di faktur ini: Kurma Ajwa Al-Madinah 1 kg: dibeli 2, sudah diretur 1');

  // the manager decides in her inbox (refund shown, no cost)
  const p2 = await manager(context);
  await p2.click('#tb-appr');
  const card = retCard(p2);
  await expect(card).toContainText('Retur pelanggan · Umum');
  await expect(card.locator('[data-retur="pelanggan"]')).toContainText(rid);
  await expect(card.locator('[data-refund]')).toContainText(H.rp(390000));
  await expect(card.locator('[data-retur-lines]')).toContainText('Rusak');
  await H.shot(p2, 'phone-54-retur-inbox', false, { noToasts: true });
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);

  // the kasir's open window shows the decision and the return note
  await expect(m.locator('#rt-approved')).toBeVisible({ timeout: 10000 });
  await expect(m.locator('#rt-slip-no')).toHaveText(rid);
  await expect(m.locator('#rt-slip-refund')).toContainText(H.rp(390000));
  await H.shot(page, 'phone-55-retur-note', false, { noToasts: true });
  db = await H.getDb(page);
  // good → warehouse (the shelf keeps its count), damaged → no stock
  expect(H.productByName(db, /Ajwa/)).toMatchObject({ stock: aj0.stock + 1, shop_stock: aj0.shop_stock });
  expect(H.productByName(db, /Medjool/).stock).toBe(med0.stock);
  const sh = db.shifts.find(x => x.status === 'open' && x.cashier === 'Siti');
  expect(db.cash_moves.find(x => x.shift_id === sh.shift_id && x.note === 'Retur ' + rid)).toMatchObject({ type: 'out', amount: 390000 });
  expect(db.payments[db.payments.length - 1]).toMatchObject({ direction: 'out', amount: 390000, method: 'tunai', match_status: 'retur', cashier: 'Siti' });
  expect(db.returns.find(r => r.return_id === rid)).toMatchObject({ status: 'approved', approved_by: 'Jihan', user: 'Siti', ref: inv });
  expect(db.activity.find(a => a.kind === 'retur' && a.ref === rid)).toMatchObject({ user: 'Jihan', level: 'warn' });
  // "Permintaan saya" keeps the note
  await H.closeModals(page);
  await page.click('#m-myreq');
  await page.locator(`#myreq [data-act="rt-slip"]`).first().click();
  await expect(page.locator('#rt-note #rt-slip-no')).toHaveText(rid);
});

test('above the limit only the owner decides; less debt with the return fee; Arabic', async ({ page, context }) => {
  await H.login(page);
  await H.setDb(page, `db.settings.return_fee_pct = 10; db.settings.return_owner_min_value = 100000;`);
  await page.evaluate(() => refreshData(true));
  const db0 = await H.getDb(page);
  const debtor = new Set(db0.customers.filter(c => c.debt_balance > 0).map(c => c.id));
  const sale = db0.sales.filter(s => s.status === 'ok' && debtor.has(s.customer_id) && s.total >= 150000 && !s.discount).pop();
  const it = db0.items.find(i => i.invoice_no === sale.invoice_no);
  const cust0 = db0.customers.find(c => c.id === sale.customer_id);
  await H.tab(page, 'more');
  await page.click('#lang-ar');
  await page.click('#m-retur');
  const m = page.locator('#retur');
  await m.locator('#rt-inv').fill(sale.invoice_no.toLowerCase());
  await expect(m.locator('#rt-inv')).toHaveValue(sale.invoice_no);
  await m.locator('#rt-find').click();
  await expect(m.locator('#rt-buyer')).toHaveText(cust0.name);
  await expect(m.locator('#rt-by')).toHaveValue(cust0.name);
  await m.locator(`[data-rt-qty="${it.product_id}"]`).fill(String(it.qty));
  await m.locator('#rt-reason').selectOption('kadaluarsa');
  await m.locator('#rt-m-potong_hutang').click();
  const gross = it.line_total, fee = Math.round(gross * 0.1);
  await expect(m.locator('#rt-fee')).toContainText(H.rp(fee));
  await expect(m.locator('#rt-amount')).toHaveText(H.rp(gross - fee));
  await H.shot(page, 'phone-56-retur-ar', false, { noToasts: true });
  await page.click('#rt-send');
  await expect(m.locator('#rt-wait [data-approver="owner"]')).toBeVisible();
  const rid = (await m.locator('#rt-id').textContent()).trim();
  await H.closeModals(page);
  await page.click('#lang-id');

  const p2 = await manager(context);
  await p2.click('#tb-appr');
  await expect(retCard(p2).locator('[data-owner-only]')).toBeVisible();
  await expect(retCard(p2).locator('[data-d="approved"]')).toBeDisabled();
  const p3 = await manager(context, 'Pemilik', '1234');
  await p3.click('#tb-appr');
  await retCard(p3).locator('[data-d="approved"]').click();
  await expect(retCard(p3)).toHaveCount(0);
  const db = await H.getDb(p3);
  expect(db.customers.find(c => c.id === cust0.id).debt_balance).toBe(Math.max(0, cust0.debt_balance - (gross - fee)));
  expect(db.returns.find(r => r.return_id === rid)).toMatchObject({ status: 'approved', approved_by: 'Pemilik', refund_method: 'potong_hutang', fee, refund: gross - fee });
  // potong hutang is refused for a buyer without debt (walk-in sale)
  const walkin = db.sales.filter(s => s.status === 'ok' && !s.customer_id).pop();
  const wi = db.items.find(i => i.invoice_no === walkin.invoice_no);
  const r = await page.evaluate(async ([no, id]) => { try { await api('request_return', { kind: 'pelanggan', invoice_no: no, lines: [{ product_id: id, qty: 0.5 }], reason_code: 'rusak', refund_method: 'potong_hutang' }); return 'ok'; } catch (e) { return e.message; } }, [walkin.invoice_no, wi.product_id]);
  expect(r).toBe('Pelanggan ini tidak punya hutang untuk dipotong');
});

test('supplier return from a goods-in: outgoing note, photo, carrier; no values for kasir; stock down after approval', async ({ page, context }) => {
  await H.login(page);
  const NOTE = { supplier: 'CV Timur Tengah Food', date: '', invoice_no: 'TTF-9001', total: 0, items: [{ name: 'KURMA MEDJOOL JUMBO 1KG', qty: 10, unit: 'kg', unit_price: 170000, total: 1700000 }] };
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE);
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-ok')).toContainText('1 baris');
  await H.pickCarrier(page);
  await page.click('#pu-save');
  const no = (await page.locator('#pu-res-no').textContent()).trim();
  const med0 = H.productByName(await H.getDb(page), /Medjool/);
  const h = page.locator(`#pu-hist .hist[data-no="${no}"]`);
  await h.locator('[data-act="pu-retur"]').click();
  const m = page.locator('#sup-retur');
  await expect(m).toBeVisible();
  await expect(m).not.toContainText(/Rp|170\.000|modal/);
  const ln = m.locator(`[data-sr-line="${med0.id}"]`);
  await expect(ln).toContainText('Masuk 10 · sudah diretur 0');
  await ln.locator('[data-sr-qty]').fill('11');
  await page.click('#sr-send');
  await expect(m.locator('#sr-err')).toHaveText('Kurma Medjool Jumbo 1 kg: paling banyak 10');
  await ln.locator('[data-sr-qty]').fill('3');
  await m.locator('#sr-reason').selectOption('kualitas_buruk');
  await page.click('#sr-send');
  await expect(m.locator('#sr-err')).toContainText('nomor nota / surat jalan');
  await m.locator('#sr-doc').fill('sjk/0012-a');
  await expect(m.locator('#sr-doc')).toHaveValue('SJK/0012-A');
  await page.click('#sr-send');
  await expect(m.locator('#sr-err')).toHaveText('Foto bukti barang keluar wajib');
  await page.setInputFiles('#sr-photo', await H.photoFile(page, 'keluar.png'));
  await expect(m.locator('#sr-photo-ok')).toBeVisible();
  await page.click('#sr-send');
  await expect(m.locator('#sr-err')).toHaveText('Pilih siapa yang membawa barang');
  await H.pickCarrier(page, 'umum', {}, 'sr');
  await page.click('#sr-send');
  await expect(m.locator('#sr-car-err')).toHaveText('Tulis nomor kendaraannya (plat / nomor angkot)');
  await H.pickCarrier(page, 'umum', { kind: 'truk', vehicle: 'b 9876 kq', phone: '0812 3456 7890' }, 'sr');
  await expect(m.locator('#sr-car-vehicle')).toHaveValue('B 9876 KQ');
  await H.shot(page, 'phone-57-retur-supplier', false, { noToasts: true });
  await page.click('#sr-send');
  await expect(m.locator('#sr-wait')).toBeVisible();
  const rid = (await m.locator('#sr-id').textContent()).trim();
  // the kasir never gets the purchase value
  const seen = await page.evaluate(async id => { const r = await api('check_approval', { request_id: id }); return r.approval; }, (await H.getDb(page)).approvals.find(a => a.ref === rid).request_id);
  expect(seen.total).toBe(0);
  expect(JSON.parse(seen.payload).lines[0].unit_price).toBeUndefined();
  expect(JSON.parse(seen.payload).value).toBeUndefined();
  expect(seen.summary).not.toContain('nilai Rp');
  expect(JSON.parse(seen.payload)).toMatchObject({ kind: 'pemasok', ref: no, out_doc_no: 'SJK/0012-A', carrier_type: 'umum', carrier_name: 'truk', carrier_vehicle: 'B 9876 KQ', carrier_phone: '6281234567890' });
  expect(await page.evaluate(async () => (await api('list_returns', { from: '2020-01-01', to: '2099-01-01' })).returns.length)).toBe(0); // kasir: customer returns only
  await H.closeModals(page);

  const p2 = await manager(context);
  await p2.click('#tb-appr');
  const card = retCard(p2);
  await expect(card).toContainText('Retur ke pemasok · CV Timur Tengah Food');
  await expect(card.locator('[data-retur="pemasok"]')).toContainText(`Dari barang masuk ${no} · nota keluar SJK/0012-A`);
  await expect(card).not.toContainText('Rp');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  const db = await H.getDb(p2);
  expect(H.productByName(db, /Medjool/).stock).toBe(med0.stock - 3);
  expect(H.productByName(db, /Medjool/).shop_stock).toBeLessThanOrEqual(med0.stock - 3);
  const neg = db.purchases.filter(r => r.purchase_no === rid);
  expect(neg).toHaveLength(1);
  expect(neg[0]).toMatchObject({ qty: -3, cost_price: 170000, total: -510000, match_status: 'retur', match_notes: 'nota keluar SJK/0012-A', supplier: 'CV Timur Tengah Food', user: 'Siti' });
  expect(neg[0].note).toContain('RETUR ' + rid + ' dari ' + no);
  // the history now shows the return and what is left to return
  await page.click('[data-act="pu-hist-refresh"]');
  await expect(page.locator(`#pu-hist .hist[data-no="${rid}"]`)).toContainText('Retur ke pemasok');
  await page.locator(`#pu-hist .hist[data-no="${no}"] [data-act="pu-retur"]`).click();
  await expect(page.locator(`#sup-retur [data-sr-line="${med0.id}"]`)).toContainText('Masuk 10 · sudah diretur 3');
});

test('Arabic supplier return screen', async ({ page }) => {
  await H.login(page);
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), { supplier: 'CV Timur Tengah Food', date: '', invoice_no: 'TTF-9002', total: 0, items: [{ name: 'GULA PASIR 1 KG', qty: 20, unit: 'pak', unit_price: 15000, total: 300000 }] });
  await H.tab(page, 'more');
  await page.click('#lang-ar');
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await H.pickCarrier(page, 'teman', { name: 'أحمد' });
  await page.click('#pu-save');
  const no = (await page.locator('#pu-res-no').textContent()).trim();
  await page.locator(`#pu-hist .hist[data-no="${no}"] [data-act="pu-retur"]`).click();
  await page.locator('#sup-retur [data-sr-qty]').first().fill('٢');
  await expect(page.locator('#sup-retur [data-sr-qty]').first()).toHaveValue('2');
  await H.pickCarrier(page, 'pemasok', { name: 'Ali' }, 'sr');
  await H.shot(page, 'phone-58-retur-supplier-ar', false, { noToasts: true });
  const db = await H.getDb(page);
  expect(db.purchases.filter(r => r.purchase_no === no)[0]).toMatchObject({ carrier_type: 'teman', carrier_name: 'أحمد' });
});
