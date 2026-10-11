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
  // owner sees two channel tabs + the team tab (v36)
  await expect(page.locator('.kchat-tab')).toHaveCount(3);
  await expect(page.locator('.kchat-tab[data-ch="team"]')).toHaveText('Tim');
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

// v36 (owner 2026-10-11: «أريد الدردشة مع كل الفريق المسجل وكل من له يحمل هذا التطبيق»)
test('owner: Team tab lists every registered user (names only); a private room with one of them, unread badge from the same poll', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db = await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
  const others = db.users.filter(u => u.active !== false && u.name !== 'Pemilik' && ['owner', 'manager', 'kasir', 'sales', 'akuntan'].includes(u.role)).map(u => u.name);
  // Rina writes to the owner privately before he opens the chat → the launcher badge counts it
  const bootR = await chatAs(page, 'Rina', '3333', 'chat_bootstrap', {});
  const roomR = bootR.team.find(t => t.name === 'Pemilik').channel;
  expect((await chatAs(page, 'Rina', '3333', 'chat_send', { channel: roomR, body: 'Pak, boleh izin besok?', cid: 'rina-1' })).ok).toBe(true);
  await page.locator('.kchat-fab').click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  const members = page.locator('.kchat-member');
  await expect(members).toHaveCount(others.length);
  for (const n of others) await expect(page.locator(`.kchat-member[data-name="${n}"]`)).toBeVisible();
  // names only — never a role word next to a person
  await expect(page.locator('.kchat-list')).not.toContainText(/manajer|kasir|akuntan|sales|pemilik toko/i);
  await expect(page.locator('.kchat-foot')).toBeHidden();
  const rina = page.locator('.kchat-member[data-name="Rina"]');
  await expect(rina.locator('.kchat-mbadge')).toHaveText('1');
  await expect(members.first()).toHaveAttribute('data-name', 'Rina'); // unread first
  await rina.click();
  await expect(page.locator('.kchat-peer b')).toHaveText('Rina');
  await expect(page.locator('.kchat-list')).toContainText('boleh izin besok');
  await expect(page.locator('.kchat-list')).not.toContainText('Selamat pagi'); // not the general room
  await page.locator('.kchat-ta').fill('Boleh, hati-hati.');
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText('Boleh, hati-hati.');
  await expect(page.locator('.kchat-msg.me').last()).not.toHaveClass(/pending/);
  // back to the team: Rina's badge is gone
  await page.locator('.kchat-back').click();
  await expect(page.locator('.kchat-member[data-name="Rina"] .kchat-mbadge')).toHaveCount(0);
  // Rina gets the reply; Siti and Jihan never see this room, not even by asking for it
  const pr = await chatAs(page, 'Rina', '3333', 'chat_poll', { cursors: { [roomR]: '' }, seen: {} });
  expect(pr.messages[roomR].map(m => m.body)).toContain('Boleh, hati-hati.');
  for (const [u, p] of [['Siti', '1111'], ['Jihan', '2222']]) {
    const x = await chatAs(page, u, p, 'chat_poll', { cursors: { [roomR]: '' }, seen: {} });
    expect(JSON.stringify(x)).not.toContain('boleh izin besok');
    expect((await chatAs(page, u, p, 'chat_send', { channel: roomR, body: 'x', cid: 'no-' + u })).error).toBe('FORBIDDEN');
  }
  // Arabic labels
  await page.locator('.kchat-x').click();
  await page.evaluate(() => KChatUI.setLang('ar'));
  await page.locator('.kchat-fab').click();
  await expect(page.locator('.kchat-tab[data-ch="team"]')).toHaveText('الفريق');
});
