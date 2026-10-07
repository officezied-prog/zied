// v20 P2d: an incoming transfer payment creates a manager confirmation in the approvals inbox.
const { test, expect } = require('@playwright/test');
const { login, getDb, editDb, nav } = require('./helpers');

test('a transfer payment creates a confirmation card; approving it confirms the money arrived', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await editDb(page, `db.customers[0].debt_balance = 500000;`);
  const cid = (await getDb(page)).customers[0].id;
  await page.evaluate(async id => await api('receive_payment', { customer_id: id, amount: 200000, method: 'transfer', bank: 'BCA', transfer_ref: 'TRX1' }), cid);
  const ap = (await getDb(page)).approvals.find(a => a.kind === 'transfer_confirm');
  expect(ap).toBeTruthy();
  expect(ap.total).toBe(200000);
  await nav(page, 'approvals');
  const card = page.locator('.apr-card').filter({ hasText: 'transfer' });
  await expect(card).toContainText('Rp 200.000');
  await card.locator('[data-act="apr-decide"][data-d="approved"]').click();
  await expect.poll(async () => (await getDb(page)).approvals.find(a => a.kind === 'transfer_confirm').status).not.toBe('pending');
  expect((await getDb(page)).activity.some(a => a.kind === 'transfer_ok')).toBe(true);
});
