// Kas: cash in/out with a note, expense from the drawer, close the shift with a BLIND count.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('cash out + expense + close shift with blind count, result and printable report', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'ajwa'); // Rp 175.000 cash
  await H.pay(page);
  await page.click('#pay-ok');
  await page.click('#rc-new');

  await H.tab(page, 'kas');
  await expect(page.locator('#kas-opening')).toHaveText(H.rp(500000));
  await expect(page.locator('#kas-blind')).toBeVisible();
  await expect(page.locator('#v-kas')).not.toContainText('Seharusnya');
  expect(await page.evaluate(() => 'expected_cash' in window.KASIR.S.shift || 'cash_sales' in window.KASIR.S.shift)).toBe(false);

  await page.click('#kas-out');
  await page.fill('#cm-amt', '50000');
  await page.click('#cm-ok');
  await expect(page.locator('#cm-err')).toContainText('Catatan');
  await page.fill('#cm-note', 'Beli galon');
  await page.click('#cm-ok');
  await expect(page.locator('#kas-cout')).toHaveText('-' + H.rp(50000));
  await page.click('#kas-in');
  await page.fill('#cm-amt', '20000');
  await page.fill('#cm-note', 'Tambah uang kecil');
  await page.click('#cm-ok');
  await expect(page.locator('#kas-cin')).toHaveText(H.rp(20000));

  await page.click('#kas-exp');
  await page.selectOption('#ex-cat', 'transport');
  await page.fill('#ex-amt', '25000');
  await page.fill('#ex-note', 'Ongkir');
  await expect(page.locator('#ex-from [data-f="kas"]')).toHaveClass(/on/);
  await page.click('#ex-ok');
  await expect(page.locator('#kas-cout')).toHaveText('-' + H.rp(75000));
  await expect(page.locator('#kas-moves')).toContainText('Beli galon');
  await H.shot(page, 'phone-19-kas');

  // expected = 500.000 + 175.000 + 20.000 − 50.000 − 25.000 = 620.000; counted 610.000 → short 10.000
  await page.click('#kas-close');
  await expect(page.locator('#shift-close')).toContainText('Hitung semua uang');
  await expect(page.locator('#shift-close')).not.toContainText('620.000');
  await page.fill('#cs-counted', '610000');
  await page.click('#cs-ok');
  await expect(page.locator('#shift-result')).toContainText('Kurang ' + H.rp(10000));
  await expect(page.locator('#sr-diff')).toHaveAttribute('data-diff', '-10000');
  await expect(page.locator('#shift-report')).toContainText('620.000');
  // v15: the report has the sale in numbers per method (one cash sale of 175.000, 1 piece)
  await expect(page.locator('#sr-count')).toContainText('1');
  await expect(page.locator('#sr-items')).toContainText('1');
  await expect(page.locator('#sr-m-tunai')).toContainText('175.000');
  await expect(page.locator('#sr-m-transfer')).toContainText(H.rp(0));
  await H.shot(page, 'phone-20-tutup-kasir');
  const db = await H.getDb(page);
  const sh = db.shifts.filter(x => x.cashier === 'Siti').pop();
  expect(sh).toMatchObject({ status: 'closed', counted_cash: 610000, expected_cash: 620000, difference: -10000, cash_sales: 175000, transfer_sales: 0, qris_sales: 0, debt_sales: 0, items_qty: 1 });
  expect(db.expenses[db.expenses.length - 1]).toMatchObject({ category: 'transport', amount: 25000, paid_from: 'kas', user: 'Siti' });
  await page.click('#sr-copy');
  await page.click('#sr-done');
  // drawer closed → "Buka Kasir" again
  await expect(page.locator('#gate #shift-open')).toBeVisible();
});

test('closing is blocked while data is still pending in the outbox', async ({ page, context }) => {
  await H.login(page);
  await context.setOffline(true);
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-ok');
  await page.click('#rc-new');
  await H.tab(page, 'kas');
  await page.click('#kas-close');
  await expect(page.locator('.toast.err')).toContainText('tertunda');
  await expect(page.locator('#shift-close')).toHaveCount(0);
  await context.setOffline(false);
});
