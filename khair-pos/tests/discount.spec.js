// v16 Discount limit: a kasir above max_discount_pct asks request_discount; the owner's card shows profit before/after,
// the manager's card never shows profit; the approved request lets the sale through once (status used).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, asUser, productByName } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (n < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
function discSale(p, qty, discount) {
  const sub = qty * p.retail_price;
  return { client_id: 'ds-' + Math.random().toString(36).slice(2), sale_date: jktToday(), items: [{ product_id: p.id, qty, unit_price: p.retail_price, price_type: 'eceran' }], discount, payment_method: 'tunai', paid_amount: sub - discount };
}

test('kasir above the limit → request_discount; owner sees profit before/after; manager approves without profit; sale goes through once', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  let db = await getDb(page);
  const p = productByName(db, /Kurma Sukkari/);
  expect(db.settings.max_discount_pct === undefined || db.settings.max_discount_pct === 3).toBe(true);
  await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 500000 });
  const sale = discSale(p, 2, Math.round(2 * p.retail_price * 0.1)); // 10 %
  // within 3 %: no approval; above → DISCOUNT_APPROVAL_REQUIRED
  expect(await asUser(page, 'Siti', '1111', 'request_discount', Object.assign({}, sale, { discount: Math.round(2 * p.retail_price * 0.02) }))).toMatchObject({ error: 'INVALID' });
  expect(await asUser(page, 'Siti', '1111', 'save_sale', sale)).toMatchObject({ error: 'DISCOUNT_APPROVAL_REQUIRED' });
  const rq = await asUser(page, 'Siti', '1111', 'request_discount', Object.assign({ reason: 'Pelanggan beli untuk pengajian' }, sale));
  expect(rq.approval).toMatchObject({ kind: 'discount', approver_role: 'manager', debt_amount: sale.discount, total: 2 * p.retail_price - sale.discount });
  // kasir never sees profit
  expect(JSON.parse(rq.approval.payload).profit_before).toBeUndefined();
  expect(rq.approval.summary).not.toContain('laba');

  const list = 2 * p.retail_price, cost = 2 * p.cost_price, after = list - sale.discount;
  await page.evaluate(() => pollApprovals());
  await nav(page, 'approvals');
  const card = page.locator('.apr-card[data-kind="discount"]');
  await expect(card.locator('[data-v="list"]')).toHaveText(rp(list));
  await expect(card.locator('[data-v="total"]')).toHaveText(rp(after));
  await expect(card.locator('[data-v="disc"]')).toContainText(rp(sale.discount));
  await expect(card.locator('[data-v="profit-before"]')).toHaveText(rp(list - cost));
  await expect(card.locator('[data-v="profit-after"]')).toHaveText(rp(after - cost));
  await expect(card.locator('[data-v="profit-before"]')).toHaveClass(/green/);
  await expect(card).toContainText('Pelanggan beli untuk pengajian');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approvals-discount.png') });

  // manager: same card without any profit; API payload stripped too
  await page.click('#tb-lock');
  await page.click('[data-act="login-user"][data-name="Jihan"]');
  for (const d of '2222') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#app')).toBeVisible();
  const ca = await asUser(page, 'Jihan', '2222', 'check_approval', { request_id: rq.request_id });
  expect(JSON.parse(ca.approval.payload).profit_after).toBeUndefined();
  expect(ca.approval.summary).not.toContain('laba');
  await nav(page, 'approvals');
  const mcard = page.locator('.apr-card[data-kind="discount"]');
  await expect(mcard.locator('[data-v="list"]')).toHaveText(rp(list));
  await expect(mcard.locator('[data-profit]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SHOTS, 'phone-approvals-discount-manager.png') });
  await mcard.locator('[data-note]').fill('Boleh, pelanggan tetap');
  await mcard.locator('[data-d="approved"]').click();
  await expect(page.locator('.apr-card[data-kind="discount"]')).toHaveCount(0);

  // kasir saves with the approval: once
  const ok = await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({ discount_approval_id: rq.request_id }, sale));
  expect(ok.sale.notes).toContain('[diskon 10% disetujui Jihan]');
  db = await getDb(page);
  expect(db.approvals.find(a => a.request_id === rq.request_id).status).toBe('used');
  const again = await asUser(page, 'Siti', '1111', 'save_sale', Object.assign({}, sale, { client_id: 'ds-other', discount_approval_id: rq.request_id }));
  expect(again).toMatchObject({ error: 'DISCOUNT_APPROVAL_REQUIRED' });
  expect(db.activity.filter(a => a.kind === 'minta_diskon').slice(-1)[0]).toMatchObject({ user: 'Siti', level: 'warn' });
  expect(db.activity.filter(a => a.kind === 'diskon').slice(-1)[0].summary).toContain('disetujui Jihan');
  // owner / manager may give more without a request (noted on the sale)
  const own = await asUser(page, 'Pemilik', '1234', 'save_sale', discSale(p, 1, Math.round(p.retail_price * 0.2)));
  expect(own.sale.notes).toContain('disetujui Pemilik');
});
