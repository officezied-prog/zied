// v29 — owner-approved BANK TRANSFERS: the manager raises a transfer request, the owner approves it, the manager
// records the transfer executed via the company bank (BNI). Money leaving the company this way needs owner approval.
// The owner only monitors — he has no money-out record control (hidden by `omon`).
const { test, expect } = require('@playwright/test');
const { login, switchUser, nav, getDb, jktToday } = require('./helpers');

test('manager requests a transfer, owner approves, manager records it, and it shows as money-out', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });

  // 1. the manager raises a transfer request (payee, amount, reason) from the bank view
  await nav(page, 'bank');
  await page.click('[data-act="tf-request"]');
  await expect(page.locator('#tf-request-modal')).toBeVisible();
  await page.fill('#tf-payee', 'PLN');
  await page.fill('#tf-amt', '750.000');
  await page.fill('#tf-reason', 'Bayar listrik toko');
  await page.click('#tf-send');
  await expect(page.locator('.toast.ok')).toBeVisible();

  let db = await getDb(page);
  const reqAp = db.approvals.filter(a => a.kind === 'transfer').slice(-1)[0];
  expect(reqAp).toBeTruthy();
  expect(reqAp.status).toBe('pending');
  expect(reqAp.approver_role).toBe('owner');
  expect(reqAp.cashier).toBe('Jihan');
  expect(reqAp.total).toBe(750000);
  const pl0 = JSON.parse(reqAp.payload);
  expect(pl0).toMatchObject({ payee: 'PLN', amount: 750000, reason: 'Bayar listrik toko', paid: false });

  // 2. the owner sees the request in the approvals inbox and approves it
  await switchUser(page, 'Pemilik', '1234');
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${reqAp.request_id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('PLN');
  await card.locator('[data-act="apr-decide"][data-d="approved"]').click();
  await expect(card).toHaveCount(0); // decided → removed from the inbox

  db = await getDb(page);
  const apA = db.approvals.find(a => a.request_id === reqAp.request_id);
  expect(apA.status).toBe('approved');
  expect(JSON.parse(apA.payload).paid).toBe(false); // approved, not yet recorded

  // 3. the manager records the transfer from the "siap ditransfer" list
  await switchUser(page, 'Jihan', '2222');
  await nav(page, 'bank');
  const recBtn = page.locator(`#bk-transfers [data-act="tf-record"][data-req="${reqAp.request_id}"]`);
  await expect(recBtn).toBeVisible();
  await recBtn.click();
  await expect(page.locator('#tf-record-modal')).toBeVisible();
  await page.fill('#tf-ref', 'BNI-TRX-9001');
  await page.click('#tf-rec-ok');
  await expect(page.locator('.toast.ok').filter({ hasText: 'PLN' })).toBeVisible();

  db = await getDb(page);
  const pay = db.payments.slice(-1)[0];
  expect(pay).toMatchObject({ direction: 'out', party_type: 'other', method: 'transfer', payee: 'PLN', amount: 750000, transfer_ref: 'BNI-TRX-9001' });
  expect(pay.supplier).toBe('');
  expect(pay.customer_id).toBe(0);
  const apB = db.approvals.find(a => a.request_id === reqAp.request_id);
  expect(apB.status).toBe('done');
  expect(JSON.parse(apB.payload)).toMatchObject({ paid: true, pay_id: pay.pay_id });

  // once recorded, nothing is left to record in the list
  await expect(page.locator(`#bk-transfers [data-act="tf-record"]`)).toHaveCount(0);

  // 4. it shows as money-out in the bank view (this month's recorded transfers)
  await page.fill('#bk-period', jktToday().slice(0, 7));
  await page.locator('#bk-period').dispatchEvent('change');
  const row = page.locator('#bk-pays tr', { hasText: 'PLN' });
  await expect(row).toBeVisible();
  await expect(row.locator('td.num.red')).toContainText('750.000'); // the out column
});

test('the owner only monitors: no transfer request or record control (omon)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'bank');
  // the owner sees neither the "minta transfer" request entry nor any "catat transfer" record control
  await expect(page.locator('[data-act="tf-request"]')).toHaveCount(0);
  await expect(page.locator('#bk-transfers [data-act="tf-record"]')).toHaveCount(0);
});
