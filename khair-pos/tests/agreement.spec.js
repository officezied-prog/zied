// Owner decisions (07 Oct): the return limit (default Rp 2.000.000) changes only by agreement of owner and manager:
// one proposes (propose_agreement), the OTHER confirms in the inbox; save_settings → AGREEMENT_REQUIRED; history kept.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, nav, asUser, typePin } = require('./helpers');

async function relogin(page, user, pin) {
  await page.click('#tb-lock');
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  await typePin(page, pin);
  await expect(page.locator('#app')).toBeVisible();
}

test('owner proposes a new return limit → only the manager sees and confirms it → limit changes, history and activity', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  expect(await asUser(page, 'Pemilik', '1234', 'save_settings', { settings: { return_owner_min_value: 500000 } })).toMatchObject({ error: 'AGREEMENT_REQUIRED' });
  await nav(page, 'settings');
  await expect(page.locator('#ag-cur-value')).toHaveText('Rp 2.000.000');
  await expect(page.locator('#st-rt-minval')).toHaveCount(0);
  await page.fill('#ag-value', '1.500.000');
  await page.fill('#ag-note', 'Retur besar harus saya lihat');
  await page.click('#ag-propose');
  await expect(page.locator('#ag-pending')).toContainText('Rp 1.500.000');
  let db = await getDb(page);
  const ap = db.approvals.filter(a => a.kind === 'kesepakatan').slice(-1)[0];
  expect(ap).toMatchObject({ status: 'pending', approver_role: 'manager', cashier: 'Pemilik', ref: 'return_owner_min_value', total: 1500000 });
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'usul_kesepakatan' });
  // the proposer never sees it in the inbox and cannot confirm it
  await page.evaluate(() => pollApprovals());
  await nav(page, 'approvals');
  await expect(page.locator(`.apr-card[data-req="${ap.request_id}"]`)).toHaveCount(0);
  expect(await asUser(page, 'Pemilik', '1234', 'decide_approval', { request_id: ap.request_id, decision: 'approved' })).toMatchObject({ error: 'FORBIDDEN' });

  // manager (phone) confirms
  await page.setViewportSize({ width: 390, height: 844 });
  await relogin(page, 'Jihan', '2222');
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card.locator('[data-v="from"]')).toHaveText('Rp 2.000.000');
  await expect(card.locator('[data-v="to"]')).toHaveText('Rp 1.500.000');
  await expect(card).toContainText('Retur besar harus saya lihat');
  await page.screenshot({ path: path.join(SHOTS, 'phone-agreement-manager-confirm.png') });
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  db = await getDb(page);
  expect(db.settings.return_owner_min_value).toBe(1500000);
  expect(db.settings.limit_agreements[0]).toMatchObject({ key: 'return_owner_min_value', value: 1500000, from: 2000000, proposed_by: 'Pemilik', confirmed_by: 'Jihan', note: 'Retur besar harus saya lihat' });
  expect(db.activity.slice(-1)[0].kind).toBe('keputusan');
  expect(db.activity.some(a => a.kind === 'kesepakatan' && a.summary.includes('Disepakati Pemilik & Jihan'))).toBe(true);

  // manager proposes the quantity limit → only the owner confirms (manager cannot)
  const q = await asUser(page, 'Jihan', '2222', 'propose_agreement', { key: 'return_owner_min_qty', value: 30, note: 'retur grosir' });
  expect(q.approval.approver_role).toBe('owner');
  expect(await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: q.request_id, decision: 'approved' })).toMatchObject({ error: 'NEEDS_OWNER' }) // server: canDecide refuses first;
  await page.setViewportSize({ width: 1366, height: 768 });
  await relogin(page, 'Pemilik', '1234');
  await nav(page, 'approvals');
  await page.locator(`.apr-card[data-req="${q.request_id}"] [data-d="approved"]`).click();
  await expect(page.locator(`.apr-card[data-req="${q.request_id}"]`)).toHaveCount(0);
  await nav(page, 'settings');
  await expect(page.locator('#ag-cur-value')).toHaveText('Rp 1.500.000');
  await expect(page.locator('#ag-cur-qty')).toHaveText('30');
  await expect(page.locator('#ag-hist tbody tr')).toHaveCount(2);
  await expect(page.locator('#ag-hist tr[data-ag="0"]')).toContainText('Jihan');
  await page.locator('#st-agree').screenshot({ path: path.join(SHOTS, 'desktop-settings-agreement.png') });
  // activity labels
  await nav(page, 'activity');
  await expect(page.locator('#act-list .act-row[data-kind="usul_kesepakatan"]').first()).toContainText('Usul kesepakatan');
  await expect(page.locator('#act-list .act-row[data-kind="kesepakatan"]').first()).toContainText('Kesepakatan');
});
