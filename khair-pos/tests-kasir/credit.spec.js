// Hutang: the server answers APPROVAL_REQUIRED for a kasir; approve with the manager/owner PIN on this
// device, or send a request that the manager approves on her own phone (second page, same mock DB).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

async function debtCart(page, customer = 'Warung Bu Halimah') {
  await H.addItem(page, 'kismis hijau');
  await H.pay(page);
  await page.click('#pm-hutang'); // no customer yet → picker opens
  await page.locator('#cp-list [data-pick]').filter({ hasText: customer }).click();
  await expect(page.locator('#pay-cust')).toContainText(customer);
  await expect(page.locator('#pay-debt')).toHaveText(H.rp(86000)); // grosir customer → wholesale price
  await page.click('#pay-ok');
  await expect(page.locator('#apr-step')).toBeVisible();
}

test('APPROVAL_REQUIRED, then on-site approval with the manager PIN', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const cust = db0.customers.find(c => c.name === 'Warung Bu Halimah');
  const before = db0.sales.length;
  await debtCart(page);
  await expect(page.locator('#apr-step')).toContainText('Hutang perlu persetujuan');
  await expect(page.locator('#ap-remote')).toContainText('Minta persetujuan');
  await expect(page.locator('#ap-here')).toContainText('PIN Pemilik/Manajer di sini');
  expect((await H.getDb(page)).sales.length).toBe(before);
  // the server itself refuses the debt sale without approval
  const code = await page.evaluate(async () => { try { await api('save_sale', { client_id: 'x-' + Date.now(), customer_id: 2, items: [{ product_id: 7, qty: 1, unit_price: 86000, price_type: 'grosir' }], payment_method: 'hutang', paid_amount: 0 }); return 'saved'; } catch (e) { return e.code; } });
  expect(code).toBe('APPROVAL_REQUIRED');
  await H.shot(page, 'phone-10-approval-step');
  await page.click('#ap-here');
  await page.click('#ap-users [data-n="Jihan"]');
  await page.fill('#ap-pin', '9999');
  await page.click('#ap-ok');
  await expect(page.locator('#ap-err')).toContainText('PIN penyetuju salah');
  await expect(page.locator('#app')).toBeVisible(); // wrong approver PIN does not log the kasir out
  await page.fill('#ap-pin', '2222');
  await page.click('#ap-ok');
  const rc = page.locator('#rc-modal #receipt');
  await expect(rc).toBeVisible();
  await expect(rc).toContainText('Disetujui');
  await expect(rc).toContainText('Jihan');
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ payment_method: 'hutang', debt_amount: 86000, approved_by: 'Jihan', customer_id: cust.id });
  expect(db.customers.find(c => c.id === cust.id).debt_balance).toBe(cust.debt_balance + 86000);
});

test('remote request: the manager approves on her phone, the kasir sale saves itself', async ({ page, context }) => {
  await H.login(page);
  await debtCart(page);
  await page.click('#ap-remote');
  await expect(page.locator('#apr-wait')).toBeVisible();
  const rid = (await page.locator('#aw-id').textContent()).trim();
  expect(rid).toMatch(/^APR-/);
  await H.shot(page, 'phone-11-waiting');

  // Jihan (manager) on a second device — same mock DB (same origin storage)
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await expect(p2.locator('#tb-appr')).toBeVisible();
  // the credit request + Siti's opening count (v15: every "Buka kas" goes to the manager)
  await expect(p2.locator('#tb-appr-n')).toHaveText('2');
  await expect(p2.locator('#tb-appr')).toBeVisible();
  await p2.click('#tb-appr');
  await expect(p2.locator('.apr-card[data-kind="buka_kas"]')).toContainText('Siti');
  const card = p2.locator(`.apr-card[data-req="${rid}"]`);
  await expect(card).toContainText('Warung Bu Halimah');
  await expect(card).toContainText(H.rp(86000));
  await H.shot(p2, 'phone-12-manager-inbox');
  await card.locator('[data-note]').fill('ok, max 1 minggu');
  await card.locator('[data-d="approved"]').click();
  await expect(p2.locator('.toast.ok', { hasText: rid })).toBeVisible();
  await expect(p2.locator('#tb-appr-n')).toHaveText('1');

  // the kasir's poll (every 5 s) picks it up and saves with approval_id
  const rc = page.locator('#rc-modal #receipt');
  await expect(rc).toBeVisible({ timeout: 15000 });
  await expect(rc).toContainText('Jihan');
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ debt_amount: 86000, approved_by: 'Jihan' });
  expect(db.approvals.find(a => a.request_id === rid).status).toBe('used');
  // shows up in "Permintaan saya"
  await page.click('#rc-new');
  await H.tab(page, 'more');
  await page.click('#m-myreq');
  await expect(page.locator(`#myreq [data-req="${rid}"] [data-status]`)).toHaveAttribute('data-status', /approved|used/);
});

test('rejected request shows the manager note; void and price requests respect can_decide', async ({ page, context }) => {
  await H.login(page);
  // a sale of today to void (the demo data has none for today before 08:00 WIB)
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  await page.click('#rc-new');
  await debtCart(page);
  await page.click('#ap-remote');
  const rid = (await page.locator('#aw-id').textContent()).trim();
  await H.closeModals(page);
  // void request for one of today's invoices + price change request
  await H.tab(page, 'more');
  await page.click('#m-void');
  const first = page.locator('#void-list [data-act="void-pick"]').first();
  const inv = await first.getAttribute('data-inv');
  await first.click();
  await page.fill('#cf-in', 'Salah input jumlah');
  await page.click('#cf-ok');
  await expect(page.locator('.toast.ok', { hasText: 'terkirim' })).toBeVisible();
  await page.click('#m-price');
  await page.fill('#pp-q', 'ajwa');
  await page.locator('#pp-list [data-act="price-pick"]').first().click();
  await expect(page.locator('#price-change')).not.toContainText('modal');
  await page.fill('#pc-retail', '180000');
  await page.fill('#pc-reason', 'Supplier naik');
  await page.click('#pc-ok');
  await expect(page.locator('#pc-pending')).toBeVisible();
  await H.closeModals(page);

  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await expect(p2.locator('#tb-appr-n')).toHaveText('4'); // + Siti's opening count (buka_kas)
  await p2.click('#tb-appr');
  const v = p2.locator('.apr-card[data-kind="void"]');
  await expect(v).toContainText(inv);
  await expect(v.locator('[data-owner-only]')).toBeVisible();
  await expect(v.locator('[data-d="approved"]')).toBeDisabled();
  const pr = p2.locator('.apr-card[data-kind="price"]');
  await pr.locator('[data-d="approved"]').click();
  await expect(pr).toHaveCount(0);
  const cr = p2.locator(`.apr-card[data-req="${rid}"]`);
  await cr.locator('[data-note]').fill('Hutang lama belum lunas');
  await cr.locator('[data-d="rejected"]').click();
  await expect(cr).toHaveCount(0);
  const db = await H.getDb(p2);
  expect(H.productByName(db, /Ajwa/).retail_price).toBe(180000);

  // owner approves the void (in this app the owner can decide; invoice_no = approval.ref)
  const p3 = await H.otherPhone(context);
  await H.login(p3, 'Pemilik', '1234');
  await p3.click('#tb-appr');
  await p3.locator('.apr-card[data-kind="void"] [data-d="approved"]').click();
  await expect(p3.locator('.apr-card[data-kind="void"]')).toHaveCount(0);
  expect((await H.getDb(p3)).sales.find(s => s.invoice_no === inv).status).toBe('void');

  // kasir: my requests show the results, including the rejection note
  await page.click('#m-myreq');
  await expect(page.locator(`#myreq [data-req="${rid}"] [data-status]`)).toHaveAttribute('data-status', 'rejected', { timeout: 10000 });
  await expect(page.locator(`#myreq [data-req="${rid}"]`)).toContainText('Hutang lama belum lunas');
  await H.shot(page, 'phone-13-my-requests');
});
