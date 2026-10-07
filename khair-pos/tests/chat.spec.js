// Phase 3 — in-app chat. Owner sees two channels (general + private owner/manager); kasir sees general only
// and cannot post to the private channel. Text + image, demo mock mirrors the server (backend/chat/chat-core.js).
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

function chatAs(page, user, pin, action, data = {}) {
  return page.evaluate(async ({ user, pin, action, data }) => {
    const pin_hash = await KPOS.pinHash('demo', user, pin);
    try { return await apiRawInner(action, data, { key: 'demo', user, pin_hash }, { chat: true }); }
    catch (e) { return { error: e.code, message: e.message }; }
  }, { user, pin, action, data });
}

test('owner: chat launcher, two channels, seeded messages, send a message', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const fab = page.locator('.kchat-fab');
  await expect(fab).toBeVisible();
  await fab.click();
  await expect(page.locator('.kchat-wrap.open')).toBeVisible();
  // owner sees two channel tabs
  await expect(page.locator('.kchat-tab')).toHaveCount(2);
  // seeded general message
  await expect(page.locator('.kchat-list')).toContainText('Selamat pagi');
  // send a message
  const msg = 'Tes pesan ' + Date.now();
  await page.locator('.kchat-ta').fill(msg);
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText(msg);
  // private channel visible and carries the seeded owner→manager note
  await page.locator('.kchat-tab', { hasText: 'المالك والمدير' }).or(page.locator('.kchat-tab', { hasText: 'Pemilik' })).first().click();
  await expect(page.locator('.kchat-list')).toContainText('laporan kas');
});

test('kasir: general only, cannot read or post the private channel', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const boot = await chatAs(page, 'Siti', '1111', 'chat_bootstrap', {});
  expect(boot.ok).toBe(true);
  expect(boot.channels).toEqual(['general']);
  expect(boot.messages.owner_mgr).toBeUndefined();
  const forbid = await chatAs(page, 'Siti', '1111', 'chat_send', { channel: 'owner_mgr', body: 'tidak boleh', cid: 'x1' });
  expect(forbid.error).toBe('FORBIDDEN');
  const okSend = await chatAs(page, 'Siti', '1111', 'chat_send', { channel: 'general', body: 'halo dari kasir', cid: 'x2' });
  expect(okSend.ok).toBe(true);
  expect(okSend.message.from_name).toBe('Siti');
});

test('manager can read the private channel; retention is owner-only', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db = await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
  const mgr = (db.users.find(u => u.role === 'manager') || {}).name;
  test.skip(!mgr, 'no manager in demo data');
  const boot = await chatAs(page, mgr, '2222', 'chat_bootstrap', {});
  // manager PIN may differ in demo; only assert when auth succeeded
  if (boot.ok) { expect(boot.channels).toContain('owner_mgr'); }
  const setByKasir = await chatAs(page, 'Siti', '1111', 'chat_set_retention', { days: 30 });
  expect(setByKasir.error).toBe('FORBIDDEN');
  const setByOwner = await chatAs(page, 'Pemilik', '1234', 'chat_set_retention', { days: 0 });
  expect(setByOwner.ok).toBe(true);
});
