// v38 (owner 2026-10-12: stay on the free Cloudflare plan, pay the $5 only when needed): the owner sees how much of the free
// daily server allowance is used, and is warned in the bell at 60% / 85%. The manager does not get it.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, nav, editDb } = require('./helpers');

test('owner: Settings shows today / yesterday use of the free allowance; the bell warns from 60%, red from 85%', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.evaluate(() => pollApprovals());
  await nav(page, 'settings');
  const p = page.locator('#st-d1');
  await expect(p.locator('[data-d1="read"]')).toContainText('182.000 / 5.000.000');
  await expect(p.locator('[data-d1="y-read"]')).toContainText('640.000');
  await expect(p.locator('[data-d1="read"]')).toHaveClass(/green/);
  await expect(page.locator('#st-d1-hint')).toContainText('Aman di bawah 60%');
  await page.evaluate(() => refreshAttention());
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="d1"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // yesterday used 3.4 M of the 5 M reads → warning
  await editDb(page, `db.d1_usage = { y_read: 3400000 };`);
  await page.evaluate(() => pollApprovals().then(() => refreshAttention()));
  await expect(p.locator('[data-d1="y-read"]')).toHaveClass(/amber/);
  await expect(page.locator('#st-d1-hint')).toContainText('upgrade ke Workers Paid');
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="d1"]')).toContainText('68%');
  await expect(page.locator('#bell-att [data-key="d1"]')).toHaveClass(/warn/);
  await page.keyboard.press('Escape');

  // 90% of the writes today → red
  await editDb(page, `db.d1_usage = { write: 90000 };`);
  await page.evaluate(() => pollApprovals().then(() => refreshAttention()));
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="d1"]')).toHaveClass(/err/);
  await page.locator('#bell-att [data-key="d1"]').click();
  await expect(page.locator('#st-d1 [data-d1="write"]')).toHaveClass(/red/);

  // Arabic, phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tb-lang');
  await nav(page, 'settings');
  await expect(page.locator('#st-d1 h3')).toContainText('استهلاك الخادم المجاني');
  await page.locator('#st-d1').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'phone-free-plan-ar.png') });
});

test('the manager gets no server-usage numbers and no usage panel', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const r = await page.evaluate(() => api('list_approvals'));
  expect('usage' in r).toBe(false);
  await nav(page, 'settings');
  await expect(page.locator('#st-d1')).toHaveCount(0);
});

test('the 30-day alert data is read at most every 30 minutes', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.evaluate(() => refreshAttention());
  const n0 = await page.evaluate(() => { window.__gs = 0; const o = window.api; window.api = (a, d, x) => { if (a === 'get_sales') window.__gs++; return o(a, d, x); }; return window.__gs; });
  await page.evaluate(() => refreshAttention());
  expect(await page.evaluate(() => window.__gs)).toBe(n0); // cached
  // 31 minutes later it is read again
  await page.evaluate(() => { Object.values(salesCache).forEach(c => { c.at -= 31 * 60000; }); return refreshAttention(); });
  expect(await page.evaluate(() => window.__gs)).toBe(1);
});
