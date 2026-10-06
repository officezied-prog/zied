// Offline: sales, debt payments and cash moves are queued (pending count shown) and synced when back online.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('offline queue (sale, debt payment, cash out) then sync', async ({ page, context }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const debtor = db0.customers.filter(c => c.debt_balance > 0).sort((a, b) => b.debt_balance - a.debt_balance)[0];
  await context.setOffline(true);

  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-state')).toContainText('offline');
  await expect(page.locator('#rc-modal #receipt')).toContainText('BELUM TERKIRIM');
  await page.click('#rc-new');
  await expect(page.locator('#tb-outbox-n')).toHaveText('1');

  await H.tab(page, 'more');
  await page.click('#m-debt');
  await page.locator('#cp-list [data-pick]').filter({ hasText: debtor.name }).click();
  await page.fill('#py-amt', '10000');
  await page.click('#py-ok');
  await expect(page.locator('#tb-outbox-n')).toHaveText('2');
  await expect(page.locator('#more-outbox-n')).toHaveText('2');

  await H.tab(page, 'kas');
  await page.click('#kas-out');
  await page.fill('#cm-amt', '20000');
  await page.fill('#cm-note', 'Beli es batu');
  await page.click('#cm-ok');
  await expect(page.locator('#tb-outbox-n')).toHaveText('3');
  await page.click('#tb-outbox');
  await expect(page.locator('#outbox .li')).toHaveCount(3);
  await H.shot(page, 'phone-21-outbox');
  await H.closeModals(page);
  const before = await H.getDb(page);
  expect(before.sales.length).toBe(db0.sales.length);

  await context.setOffline(false); // 'online' event → sync
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 10000 });
  const db = await H.getDb(page);
  expect(db.sales.length).toBe(db0.sales.length + 1);
  expect(db.sales[db.sales.length - 1]).toMatchObject({ cashier: 'Siti', total: 175000 });
  expect(db.payments[db.payments.length - 1]).toMatchObject({ customer_id: debtor.id, amount: 10000, cashier: 'Siti' });
  expect(db.customers.find(c => c.id === debtor.id).debt_balance).toBe(debtor.debt_balance - 10000);
  expect(db.cash_moves[db.cash_moves.length - 1]).toMatchObject({ type: 'out', amount: 20000, note: 'Beli es batu' });
  // the receipt now has its real invoice number
  await H.tab(page, 'more');
  await page.click('#m-last');
  await expect(page.locator('#rc-modal #receipt')).toContainText(db.sales[db.sales.length - 1].invoice_no);
});
