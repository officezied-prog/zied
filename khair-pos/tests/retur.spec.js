// v16 Returns (retur): customer returns from the sales history, supplier returns from the goods-in history, approval cards
// (manager / owner above return_owner_min_value), Retur section with every detail, daily report; who brought the goods (carrier).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, asUser, photoFile, typePin, closeModals, pickCarrier, CARRIER, editDb } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (n < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
const P = (db, re) => db.products.find(p => re.test(p.name));
const shelf = p => p.shop_stock === undefined || p.shop_stock === null || p.shop_stock === '' ? p.stock : Math.min(p.shop_stock, p.stock);
async function relogin(page, user, pin) {
  await page.click('#tb-lock');
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#app')).toBeVisible();
}

test('customer return from the sales history: form → manager-level request → owner approves → good items to the warehouse, cash refund, Retur list, daily report', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  let db = await getDb(page);
  const kis = P(db, /Kismis Hitam/), almond = P(db, /Almond/);
  const s = await asUser(page, 'Pemilik', '1234', 'save_sale', { client_id: 'rt-' + Date.now(), sale_date: jktToday(), customer_name: 'Umum',
    items: [{ product_id: kis.id, qty: 3, unit_price: kis.retail_price, price_type: 'eceran' }, { product_id: almond.id, qty: 1, unit_price: almond.retail_price, price_type: 'eceran' }],
    discount: 0, payment_method: 'tunai', paid_amount: 3 * kis.retail_price + almond.retail_price });
  const inv = s.invoice_no;
  db = await getDb(page);
  const kis0 = P(db, /Kismis Hitam/), alm0 = P(db, /Almond/);

  await nav(page, 'history');
  await page.locator(`[data-act="hist-open"][data-inv="${inv}"]`).first().click();
  await page.click('#rc-retur');
  await expect(page.locator('#cust-retur')).toBeVisible();
  await page.locator(`[data-cr-qty="${kis.id}"]`).fill('4');
  await page.click('#cr-send');
  await expect(page.locator('#cr-err')).toContainText('paling banyak 3');
  await page.locator(`[data-cr-qty="${kis.id}"]`).fill('2');
  await page.locator(`[data-cr-qty="${almond.id}"]`).fill('1');
  await page.selectOption(`[data-cr-cond="${almond.id}"]`, 'rusak');
  await page.click('#cr-send');
  await expect(page.locator('#cr-err')).toContainText('alasan');
  await page.selectOption('#cr-reason', 'kualitas_buruk');
  await page.fill('#cr-by', 'Bu <b>Rahma</b>2');
  await expect(page.locator('#cr-by')).toHaveValue('Bu bRahmab2'); // < > and / are not typed into names
  await page.fill('#cr-by', 'Bu Rahma');
  await page.fill('#cr-phone', '0812-3456-7890');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-retur-customer-form.png') });
  await page.click('#cr-send');
  await expect(page.locator('#view-retur')).toBeVisible();
  db = await getDb(page);
  const ap = db.approvals.filter(a => a.kind === 'retur').slice(-1)[0], rec = JSON.parse(ap.payload);
  const refund = 2 * kis.retail_price + almond.retail_price;
  expect(ap).toMatchObject({ status: 'pending', approver_role: 'manager', total: refund });
  expect(rec).toMatchObject({ kind: 'pelanggan', ref: inv, returned_by: 'Bu Rahma', returned_by_phone: '6281234567890', refund, refund_method: 'tunai', reason_code: 'kualitas_buruk' });
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'minta_retur', level: 'warn' });
  // Retur section: pending tab
  const card = page.locator(`.rt-card[data-rt="${rec.return_id}"]`);
  await expect(card).toHaveAttribute('data-status', 'pending');
  await expect(card.locator('[data-refund]')).toHaveText(rp(refund));
  await expect(card.locator('[data-cond="rusak"]')).toHaveCount(1);
  // approve (owner) in the inbox
  await page.evaluate(() => pollApprovals());
  await nav(page, 'approvals');
  const ac = page.locator(`.apr-card[data-kind="retur"][data-req="${ap.request_id}"]`);
  await expect(ac.locator('[data-v="refund"]')).toHaveText(rp(refund));
  await expect(ac.locator('[data-v="by"]')).toContainText('Bu Rahma');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approvals-retur-customer.png') });
  await ac.locator('[data-d="approved"]').click();
  await expect(ac).toHaveCount(0);
  db = await getDb(page);
  const r = db.returns.find(x => x.return_id === rec.return_id);
  expect(r).toMatchObject({ status: 'approved', approved_by: 'Pemilik', user: 'Pemilik' });
  expect(P(db, /Kismis Hitam/)).toMatchObject({ stock: kis0.stock + 2 }); // good items → warehouse
  expect(shelf(P(db, /Kismis Hitam/))).toBe(shelf(kis0));
  expect(P(db, /Almond/).stock).toBe(alm0.stock); // damaged: not stock
  expect(db.payments.slice(-1)[0]).toMatchObject({ direction: 'out', amount: refund, method: 'tunai', match_status: 'retur' });
  expect(db.activity.filter(a => a.kind === 'retur').slice(-1)[0].summary).toContain('Retur disetujui Pemilik');
  // Retur list: customer tab, every detail
  await nav(page, 'retur');
  await page.click('[data-act="rt-tab"][data-tab="pelanggan"]');
  const c2 = page.locator(`.rt-card[data-rt="${rec.return_id}"]`);
  await expect(c2).toHaveAttribute('data-status', 'approved');
  await expect(c2.locator('[data-ref]')).toContainText(inv);
  await expect(c2.locator('[data-returned-by]')).toContainText('6281234567890');
  await expect(c2.locator('[data-approved-by]')).toContainText('Pemilik');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-retur-list.png') });
  // daily report shows the return
  const dr = await page.evaluate(d => api('daily_report', { date: d }), jktToday());
  expect(dr.report.returns.customer).toMatchObject({ count: 1, refund, tunai: refund });
  await nav(page, 'home');
  await page.click('#home-daily');
  await expect(page.locator('[data-dr="ret-cust"]')).toHaveText(`1 · ${rp(refund)}`);
  await expect(page.locator('[data-dr="ret-cash"]')).toHaveText(rp(refund));
  expect(decodeURIComponent(await page.locator('#dr-text').textContent())).toContain(`Retur pelanggan: 1 (uang kembali ${rp(refund)}`);
  await page.locator('#dr-returns').screenshot({ path: path.join(SHOTS, 'desktop-daily-returns.png') });
  // phone + Arabic
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tb-lang');
  await nav(page, 'retur');
  await page.click('[data-act="rt-tab"][data-tab="pelanggan"]');
  await expect(page.locator('#view-retur h1')).toHaveText('المرتجعات');
  await page.screenshot({ path: path.join(SHOTS, 'phone-retur-list-ar.png') });
});

test('supplier return from the goods-in history: carrier, outgoing note, photo; value only for the owner; above the limit only the owner decides', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  let db = await getDb(page);
  const ajwa = P(db, /Kurma Ajwa/);
  const ph = await asUser(page, 'Pemilik', '1234', 'scan_purchase', { image_base64: 'AAAA', mime: 'image/jpeg' });
  // carrier is required (CARRIER_REQUIRED), public transport needs its number
  const base = { purchase_date: jktToday(), supplier: 'PT Kurma Nusantara', photo_id: ph.photo_id, items: [{ product_id: ajwa.id, qty: 10, cost_price: 130000 }], mismatch_reason: 'uji retur' };
  expect(await asUser(page, 'Pemilik', '1234', 'save_purchase', base)).toMatchObject({ error: 'CARRIER_REQUIRED' });
  expect(await asUser(page, 'Pemilik', '1234', 'save_purchase', Object.assign({ carrier: { type: 'umum', kind: 'ojek' } }, base))).toMatchObject({ error: 'CARRIER_REQUIRED', message: expect.stringContaining('nomor kendaraan') });
  const pu = await asUser(page, 'Pemilik', '1234', 'save_purchase', Object.assign({ carrier: CARRIER }, base));
  db = await getDb(page);
  expect(db.purchases.filter(r => r.purchase_no === pu.purchase_no)[0]).toMatchObject({ carrier_type: 'pemasok', carrier_name: 'Pak Darto', carrier_vehicle: 'B 9012 TTF' });
  expect(db.activity.filter(a => a.kind === 'masuk').slice(-1)[0].summary).toContain('dibawa sopir pemasok Pak Darto B 9012 TTF');
  const stock0 = P(db, /Kurma Ajwa/).stock;

  await page.evaluate(() => Object.keys(salesCache).forEach(k => delete salesCache[k])); // saved through the API, not this screen
  await nav(page, 'purchases');
  const row = page.locator(`#pu-hist tr[data-no="${pu.purchase_no}"]`);
  await expect(row.locator('[data-carrier]')).toContainText('Sopir pemasok · Pak Darto · B 9012 TTF');
  await row.locator('[data-act="pu-retur"]').click();
  await expect(page.locator('#sup-retur')).toBeVisible();
  await page.locator(`[data-sr-qty="${ajwa.id}"]`).fill('2');
  await page.selectOption('#sr-reason', 'tidak_sesuai');
  await page.fill('#sr-doc', 'sj/07-a');
  await expect(page.locator('#sr-doc')).toHaveValue('SJ/07-A');
  await page.click('#sr-send');
  await expect(page.locator('#sr-err')).toContainText('Foto');
  await page.setInputFiles('#sr-photo', await photoFile(page, 'keluar.png'));
  await expect(page.locator('#sr-photo-ok')).toBeVisible();
  await expect(page.locator('#sr-doc')).toHaveValue('SJ/07-A'); // a typed number is never replaced by the one read from the photo
  await page.click('#sr-send');
  await expect(page.locator('#sr-err')).toContainText('membawa');
  await page.click('#sr-car-umum');
  await page.click('#sr-send');
  await expect(page.locator('#sr-car-err')).toContainText('nomor kendaraan');
  await page.fill('#sr-car-vehicle', 'b 4455 kjt');
  await page.fill('#sr-car-phone', '0813 7777 8888');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-retur-supplier-form.png') });
  await page.click('#sr-send');
  await expect(page.locator('#view-retur')).toBeVisible();
  db = await getDb(page);
  const ap = db.approvals.filter(a => a.kind === 'retur').slice(-1)[0], rec = JSON.parse(ap.payload);
  expect(ap).toMatchObject({ approver_role: 'manager', total: 260000 });
  expect(db.photos.find(x => x.photo_id === rec.photo_id)).toMatchObject({ kind: 'retur', ref: pu.purchase_no }); // v17: own photo kind
  expect(rec).toMatchObject({ kind: 'pemasok', ref: pu.purchase_no, out_doc_no: 'SJ/07-A', carrier_type: 'umum', carrier_vehicle: 'B 4455 KJT', carrier_phone: '6281377778888', value: 260000 });
  await expect(page.locator(`.rt-card[data-rt="${rec.return_id}"] [data-value]`)).toHaveText(rp(260000));

  // manager: card and list without values; approves
  await relogin(page, 'Jihan', '2222');
  const mca = await asUser(page, 'Jihan', '2222', 'check_approval', { request_id: ap.request_id });
  expect(mca.approval.total).toBe(0);
  expect(JSON.parse(mca.approval.payload).value).toBeUndefined();
  await nav(page, 'retur');
  await expect(page.locator(`.rt-card[data-rt="${rec.return_id}"] [data-out-doc]`)).toContainText('SJ/07-A');
  await expect(page.locator(`.rt-card[data-rt="${rec.return_id}"] [data-value]`)).toHaveCount(0);
  await nav(page, 'approvals');
  const mc = page.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(mc.locator('[data-v="doc"]')).toHaveText('SJ/07-A');
  await expect(mc.locator('[data-v="value"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SHOTS, 'phone-approvals-retur-supplier-manager.png') });
  await mc.locator('[data-d="approved"]').click();
  await expect(mc).toHaveCount(0);
  db = await getDb(page);
  expect(P(db, /Kurma Ajwa/).stock).toBe(stock0 - 2);
  expect(db.purchases.filter(r => r.purchase_no === rec.return_id)).toEqual([expect.objectContaining({ qty: -2, total: -260000, match_status: 'retur', supplier: 'PT Kurma Nusantara' })]);
  // more than came in minus returned → refused; the rest above the owner limit → owner only (badge for the manager)
  expect(await asUser(page, 'Jihan', '2222', 'request_return', { kind: 'pemasok', purchase_no: pu.purchase_no, lines: [{ product_id: ajwa.id, qty: 9 }], reason_code: 'rusak', out_doc_no: 'SJ2', photo_id: ph.photo_id, carrier: CARRIER }))
    .toMatchObject({ error: 'INVALID', message: expect.stringContaining('sudah diretur 2') });
  await editDb(page, `db.settings.return_owner_min_value = 1000000;`); // as if agreed earlier (see the agreement test)
  const big = await asUser(page, 'Jihan', '2222', 'request_return', { kind: 'pemasok', purchase_no: pu.purchase_no, lines: [{ product_id: ajwa.id, qty: 8 }], reason_code: 'rusak', out_doc_no: 'SJ2', photo_id: ph.photo_id, carrier: CARRIER });
  expect(big.approver_role).toBe('owner');
  await page.evaluate(() => pollApprovals());
  await nav(page, 'approvals');
  const oc = page.locator(`.apr-card[data-req="${big.request_id}"]`);
  await expect(oc.locator('[data-needs-owner]')).toBeVisible();
  await expect(oc.locator('[data-d="approved"]')).toBeDisabled();
  expect(await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: big.request_id, decision: 'approved' })).toMatchObject({ error: 'NEEDS_OWNER' });
});

test('settings: return limits, fee, photo and carrier switches; goods-in form needs the carrier; strict names', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await page.fill('#st-rt-fee', '60');
  await page.click('[data-act="set-save-retur"]');
  await expect(page.locator('#st-rt-err')).toContainText('0–50%');
  await page.fill('#st-rt-fee', '5');
  await page.uncheck('#st-rt-photo');
  await page.click('[data-act="set-save-retur"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  let db = await getDb(page);
  expect(db.settings).toMatchObject({ return_fee_pct: 5, require_return_photo: false, require_carrier: true });
  await page.locator('#st-retur').screenshot({ path: path.join(SHOTS, 'desktop-settings-retur.png') });
  // fee applies to customer refunds
  const kis = P(db, /Kismis Hitam/);
  const s = await asUser(page, 'Pemilik', '1234', 'save_sale', { client_id: 'rf-' + Date.now(), sale_date: jktToday(), items: [{ product_id: kis.id, qty: 2, unit_price: kis.retail_price, price_type: 'eceran' }], discount: 0, payment_method: 'tunai', paid_amount: 2 * kis.retail_price });
  const rq = await asUser(page, 'Siti', '1111', 'request_return', { kind: 'pelanggan', invoice_no: s.invoice_no, lines: [{ product_id: kis.id, qty: 2, condition: 'baik' }], reason_code: 'berubah_pikiran', refund_method: 'tunai' });
  expect(JSON.parse(rq.approval.payload)).toMatchObject({ fee_pct: 5, fee: Math.round(2 * kis.retail_price * 0.05), refund: 2 * kis.retail_price - Math.round(2 * kis.retail_price * 0.05) });
  // goods-in form: the save button waits for the carrier; Teman needs a name
  await page.evaluate(() => saveSettings({ require_purchase_photo: false }));
  await nav(page, 'purchases');
  await page.fill('#pu-q', 'almond');
  await page.locator('[data-act="pu-add"]').first().click();
  await expect(page.locator('#pu-block')).toHaveText('Pilih siapa yang membawa barang');
  await expect(page.locator('#pu-save')).toBeDisabled();
  await page.click('#pu-car-teman');
  await expect(page.locator('#pu-save')).toBeEnabled();
  await page.click('#pu-save');
  await expect(page.locator('#pu-car-err')).toContainText('nama');
  await page.fill('#pu-car-name', 'Ust. Hamid');
  await page.locator('#pu-carrier').screenshot({ path: path.join(SHOTS, 'desktop-goodsin-carrier.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#pu-carrier').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'phone-goodsin-carrier.png') });
  await page.setViewportSize({ width: 1366, height: 768 });
  // product names: only allowed characters reach the field; the server refuses the rest with its message
  await nav(page, 'products');
  await page.click('[data-act="prod-new"]');
  await page.fill('#pf-name', 'Kurma <script>Sukari</script> $2');
  await expect(page.locator('#pf-name')).toHaveValue('Kurma scriptSukari/script 2');
  await page.fill('#pf-sku', 'AB 12*x');
  await expect(page.locator('#pf-sku')).toHaveValue('AB12x');
  expect(await page.locator('#pf-name').getAttribute('maxlength')).toBe('80');
  await closeModals(page);
  expect(await asUser(page, 'Pemilik', '1234', 'save_product', { name: 'Kurma $uper', unit: 'pcs' })).toMatchObject({ error: 'INVALID', message: expect.stringContaining('Nama produk hanya boleh') });
  expect(await asUser(page, 'Pemilik', '1234', 'save_customer', { name: 'Bu Ani', phone: '08abc' })).toMatchObject({ error: 'INVALID' });
  expect(await asUser(page, 'Pemilik', '1234', 'save_user', { name: 'Admin!', role: 'kasir', pin_hash: 'a'.repeat(64) })).toMatchObject({ error: 'INVALID' });
  // tags and control characters never reach the data
  await asUser(page, 'Pemilik', '1234', 'save_customer', { name: 'Toko <b>Baru</b>‮', phone: '0812 9999 1111' });
  db = await getDb(page);
  expect(db.customers.slice(-1)[0].name).toBe('Toko Baru');
  // carrier switch off: goods-in without carrier is accepted
  await page.evaluate(() => saveSettings({ require_carrier: false }));
  const ph = await asUser(page, 'Pemilik', '1234', 'scan_purchase', { image_base64: 'AAAA', mime: 'image/jpeg' });
  expect((await asUser(page, 'Pemilik', '1234', 'save_purchase', { supplier: 'PT Kurma Nusantara', photo_id: ph.photo_id, items: [{ product_id: kis.id, qty: 1, cost_price: 1000 }], mismatch_reason: 'uji' })).purchase_no).toBeTruthy();
});
