// v57 (owner 2026-10-15: «في عملية التحويلات إمكانية اختيار كتابة التحويل لأي بنك تمت … والتطبيق أيضا عندما يتم عملية التحويل البنكي يقع التقاط الصورة
// للتحويل البنكي والتطبيق مباشرة يتعرف على أي نوع البنك ويصنفها حسب الصورة»): a sale paid by transfer names the store account it went to —
// a tap on the account, or the slip photo (the account is recognised by itself and the slip's amount is checked).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const TWO = `db.settings.bank_accounts = [{ id: 'BA1', bank: 'BCA', account_no: '1234567890', holder: 'Khair Mart', active: true }, { id: 'BA2', bank: 'Mandiri', account_no: '1560009876543', holder: 'Khair Mart', active: true }];`;
async function start(page, slip) {
  await H.openKasir(page);
  await H.setDb(page, TWO);
  if (slip) await page.evaluate(s => localStorage.setItem('kmock.scanpay', JSON.stringify(s)), slip);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await H.addItem(page, 'tunisia');
  await H.pay(page);
}
const total = async page => Number((await page.locator('#pay-total').textContent()).replace(/\D/g, ''));
const lastSale = async page => (await H.getDb(page)).sales.slice(-1)[0];

test('two store accounts: Transfer asks which one; a tap on BCA → the sale is filed under BCA and the manager check says so', async ({ page }) => {
  await start(page);
  await page.click('#pm-transfer');
  await expect(page.locator('#pay-tr')).toBeVisible();
  await expect(page.locator('#pay-acc .chip')).toHaveCount(2);
  await expect(page.locator('#pay-result')).toHaveText('Pilih rekening toko tujuan transfer (atau foto buktinya)');
  await expect(page.locator('#pay-ok')).toBeDisabled();
  await page.click('#pay-acc-BA1');
  await expect(page.locator('#pay-acc-BA1')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#pay-ok')).toBeEnabled();
  await H.shot(page, 'phone-pay-transfer-acc', false, { noToasts: true });
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const s = await lastSale(page);
  expect(s.account_id).toBe('BA1');
  const db = await H.getDb(page);
  const tc = db.approvals.filter(a => a.kind === 'transfer_confirm').pop();
  expect(tc.summary).toContain('ke BCA 1234567890');
  expect(JSON.parse(tc.payload).account_id).toBe('BA1');
});

test('the slip photo: Mandiri recognised from the account number, amount checked, sender bank + transfer no. kept with the sale', async ({ page }) => {
  await start(page, { amount: null, receiver_account: 'xxxxxxxx6543', receiver_bank: 'BCA', sender_bank: 'BRI', transfer_ref: 'BRI-55120', readable: true, notes: '' });
  const amt = await total(page);
  await page.evaluate(a => { const s = JSON.parse(localStorage.getItem('kmock.scanpay')); s.amount = a; localStorage.setItem('kmock.scanpay', JSON.stringify(s)); }, amt);
  await page.click('#pm-transfer');
  await page.setInputFiles('#pay-slip', await H.photoFile(page, 'bukti.png'));
  await expect(page.locator('#pay-slip-ok')).toContainText('Jumlah cocok');
  await expect(page.locator('#pay-slip-acc')).toContainText('Mandiri 1560009876543'); // the number, not the bank name on the slip
  await expect(page.locator('#pay-acc-BA2')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#pay-slip-read')).toContainText('dari BRI');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const s = await lastSale(page);
  expect([s.account_id, s.bank, s.transfer_ref]).toEqual(['BA2', 'BRI', 'BRI-55120']);
  expect(s.proof_photo_id).toMatch(/^PH-/);
});

test('a slip with another amount is flagged (the manager checks it); a split payment shows the box only with a transfer part', async ({ page }) => {
  await start(page, { amount: 1000, receiver_bank: 'BCA', transfer_ref: 'X1', readable: true, notes: '' });
  await page.click('#pm-transfer');
  await page.setInputFiles('#pay-slip', await H.photoFile(page, 'bukti.png'));
  await expect(page.locator('#pay-slip-mm')).toContainText('Bukti Rp 1.000');
  await expect(page.locator('#pay-acc-BA1')).toHaveAttribute('aria-checked', 'true'); // only BCA at that bank → BCA
  // split: no transfer part → no box; a transfer part → the box (the account already chosen stays)
  await page.click('#pm-campur');
  await expect(page.locator('#pay-tr')).toBeHidden();
  await page.fill('#pay-sp-transfer', '20000');
  await expect(page.locator('#pay-tr')).toBeVisible();
  await expect(page.locator('#pay-acc-BA1')).toHaveAttribute('aria-checked', 'true');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const s = await lastSale(page);
  expect(s.payment_method).toBe('campur');
  expect(s.account_id).toBe('BA1');
  const tc = (await H.getDb(page)).approvals.filter(a => a.kind === 'transfer_confirm').pop();
  expect(JSON.parse(tc.payload).slip_amount).toBe(1000);
});

test('one store account: Transfer needs no choice — it is that account; Arabic', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, `db.settings.bank_accounts = [{ id: 'BA1', bank: 'BCA', account_no: '1234567890', holder: 'Khair Mart', active: true }, { id: 'BA2', bank: 'Mandiri', account_no: '1560009876543', holder: 'Khair Mart', active: false }];`);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  await page.evaluate(() => setLang('ar'));
  await page.click('#pm-transfer');
  await expect(page.locator('#pay-acc .chip')).toHaveCount(1);
  await expect(page.locator('#pay-acc .chip')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#pay-tr')).toContainText('صورة إيصال التحويل');
  await expect(page.locator('#pay-tr')).toContainText('دخل إلى حساب المتجر');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  expect((await lastSale(page)).account_id).toBe('BA1');
});
