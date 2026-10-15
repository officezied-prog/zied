// v51 (owner 2026-10-15: «أريد أن أعدل الكاشير حيث يكون إمكانية البيع كل فاتورة مثلا نصف نقدا والنصف الآخر عن طريق الجوال أو التحويل أو
// أي شيء فإمكانية تجزئة الدفع حسب عدة أنواع طرق للدفع»): "Campur" in the payment window — transfer and QRIS as typed, the rest in cash
// (the change comes from the cash only); the sale keeps its parts, each counts under its own method, the transfer part is checked by the
// manager; what is still missing is debt with the hutang rules (a customer, the manager's approval).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const total = page => page.evaluate(() => cartView().total);
const fmt = n => new Intl.NumberFormat('id-ID').format(n);

test('half cash, half transfer: the rest is worked out, change from the cash, the receipt lists both, the transfer part waits for the manager', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  const T = await total(page), half = Math.floor(T / 2 / 1000) * 1000, need = T - half;
  await page.click('#pm-campur');
  await expect(page.locator('#pm-campur')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#pay-result')).toContainText('Isi jumlah transfer, QRIS atau kartu');
  await expect(page.locator('#pay-ok')).toBeDisabled();
  await page.fill('#pay-sp-transfer', String(half));
  await expect(page.locator('#pay-sp-tunai')).toHaveAttribute('placeholder', fmt(need)); // the cash still to pay
  await expect(page.locator('#pay-sp-sum')).toHaveText(`Tunai ${H.rp(need)} + Transfer ${H.rp(half)} = ${H.rp(T)}`);
  await expect(page.locator('#pay-ok')).toBeEnabled();
  // the customer hands over a round amount: the change comes from the cash part
  const given = Math.ceil(need / 50000) * 50000 + 50000;
  await page.fill('#pay-sp-tunai', String(given));
  await expect(page.locator('#pay-change')).toHaveText(H.rp(given - need));
  await H.shot(page, 'phone-pay-split', false, { noToasts: true });
  // more transfer than the bill → blocked
  await page.fill('#pay-sp-transfer', String(T + 1000));
  await expect(page.locator('#pay-result')).toContainText('lebih');
  await expect(page.locator('#pay-ok')).toBeDisabled();
  await page.fill('#pay-sp-transfer', String(half));
  await page.click('#pay-ok');
  const rc = page.locator('#rc-modal #receipt');
  await expect(rc).toBeVisible();
  await expect(rc).toContainText('Bayar (Campur)');
  await expect(rc.locator('.rc-part[data-part="tunai"]')).toContainText(fmt(need));
  await expect(rc.locator('.rc-part[data-part="transfer"]')).toContainText(fmt(half));
  await expect(page.locator('#rc-change')).toContainText(H.rp(given - need));
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ payment_method: 'campur', total: T, paid_amount: T, debt_amount: 0, cashier: 'Siti' });
  expect(JSON.parse(sale.pay_parts)).toEqual([{ m: 'tunai', a: need }, { m: 'transfer', a: half }]);
  const tc = db.approvals.filter(a => a.kind === 'transfer_confirm' && a.ref === sale.invoice_no);
  expect(tc.map(a => a.total)).toEqual([half]); // only the transfer part is checked
  // the drawer: the cash part in cash, the transfer part under transfer
  const boot = await page.evaluate(() => api('bootstrap', {}));
  expect(boot.shift.transfer_sales).toBe(half);
  await page.click('#rc-new');
  await expect(page.locator('#paybar-pay')).toBeDisabled();
});

test('three ways (transfer + QRIS + cash exact); Arabic texts', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  const T = await total(page), tr = Math.floor(T * 0.4 / 1000) * 1000, qr = Math.floor(T * 0.3 / 1000) * 1000, cash = T - tr - qr;
  await page.click('#pm-campur');
  await page.fill('#pay-sp-transfer', String(tr));
  await page.fill('#pay-sp-qris', String(qr));
  await expect(page.locator('#pay-sp-sum')).toHaveText(`Tunai ${H.rp(cash)} + Transfer ${H.rp(tr)} + QRIS ${H.rp(qr)} = ${H.rp(T)}`);
  await page.click('#pay-ok'); // cash field left empty = the exact rest
  await expect(page.locator('#rc-modal #receipt')).toContainText('Bayar (Campur)');
  const sale = (await H.getDb(page)).sales.slice(-1)[0];
  expect(JSON.parse(sale.pay_parts)).toEqual([{ m: 'tunai', a: cash }, { m: 'transfer', a: tr }, { m: 'qris', a: qr }]);
  await page.click('#rc-new');
  await page.evaluate(() => setLang('ar'));
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  await expect(page.locator('#pm-campur')).toHaveText('مختلط');
  await page.click('#pm-campur');
  await expect(page.locator('#pay-detail')).toContainText('الدفع بعدة طرق');
  await expect(page.locator('label[for="pay-sp-tunai"]')).toHaveText('النقد المستلم (روبية)');
  await expect(page.locator('#pay-result')).toContainText('اكتب مبلغ التحويل أو QRIS أو البطاقة');
  await H.shot(page, 'phone-pay-split-ar', false, { noToasts: true });
});

test('part paid, the rest on credit: needs a customer, then the manager approves like hutang; the receipt shows the parts and the debt', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'kismis hijau');
  await H.pay(page);
  await page.click('#pm-campur');
  await page.fill('#pay-sp-transfer', '20000');
  await page.fill('#pay-sp-tunai', '10000');
  await expect(page.locator('#pay-result')).toContainText('pilih pelanggan untuk hutang');
  await expect(page.locator('#pay-ok')).toBeDisabled();
  await page.click('#pay-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Warung Bu Halimah' }).click();
  await expect(page.locator('#pay-cust')).toContainText('Warung Bu Halimah');
  const T = await total(page); // a grosir customer → the wholesale price
  await page.fill('#pay-sp-transfer', '20000');
  await page.fill('#pay-sp-tunai', '10000');
  await expect(page.locator('#pay-debt')).toHaveText(H.rp(T - 30000));
  await page.click('#pay-ok');
  await expect(page.locator('#apr-step')).toContainText('Hutang perlu persetujuan');
  await page.click('#ap-here');
  await page.click('#ap-users [data-n="Jihan"]');
  await page.fill('#ap-pin', '2222');
  await page.click('#ap-ok');
  const rc = page.locator('#rc-modal #receipt');
  await expect(rc).toBeVisible();
  await expect(rc.locator('.rc-part[data-part="transfer"]')).toContainText('20.000');
  await expect(rc.locator('.rc-part[data-part="tunai"]')).toContainText('10.000');
  await expect(rc).toContainText('Jihan');
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ payment_method: 'campur', paid_amount: 30000, debt_amount: T - 30000, approved_by: 'Jihan' });
});

test('v53 card (EDC): its own button, and a part of Campur; the receipt and the drawer total show it (never as cash)', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  await expect(page.locator('#pay-m button')).toHaveCount(6);
  await page.click('#pm-kartu');
  await expect(page.locator('#pay-detail')).toContainText('mesin EDC');
  await H.shot(page, 'phone-pay-card', false, { noToasts: true });
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toContainText('Bayar (Kartu)');
  const T1 = (await H.getDb(page)).sales.slice(-1)[0];
  expect(T1.payment_method).toBe('kartu');
  await page.click('#rc-new');
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  const T = await total(page), kr = Math.floor(T / 2 / 1000) * 1000;
  await page.click('#pm-campur');
  await page.fill('#pay-sp-kartu', String(kr));
  await expect(page.locator('#pay-sp-sum')).toHaveText(`Tunai ${H.rp(T - kr)} + Kartu ${H.rp(kr)} = ${H.rp(T)}`);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal .rc-part[data-part="kartu"]')).toContainText(fmt(kr));
  const sale = (await H.getDb(page)).sales.slice(-1)[0];
  expect(JSON.parse(sale.pay_parts)).toEqual([{ m: 'tunai', a: T - kr }, { m: 'kartu', a: kr }]);
  const boot = await page.evaluate(() => api('bootstrap', {}));
  expect(boot.shift.card_sales).toBe(T1.total + kr);
});
