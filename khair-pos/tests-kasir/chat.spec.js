// Phase 3 chat in Khair Kasir: kasir sees the general channel only; a manager also sees the private owner/manager channel.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

function chatAs(page, user, pin, action, data = {}) {
  const pin_hash = H.sha(`demo:${user.toLowerCase()}:${pin}`);
  return page.evaluate(async ({ user, pin_hash, action, data }) => {
    try { return await apiRawInner(action, data, { key: 'demo', user, pin_hash }, { chat: true }); }
    catch (e) { return { error: e.code, message: e.message }; }
  }, { user, pin_hash, action, data });
}

test('kasir: chat launcher, general only, send a message', async ({ page }) => {
  await H.login(page, 'Siti', '1111');
  const fab = page.locator('.kchat-fab');
  await expect(fab).toBeVisible();
  await fab.click();
  await expect(page.locator('.kchat-wrap.open')).toBeVisible();
  await expect(page.locator('.kchat-tab')).toHaveCount(2); // v36: general + the team tab (no owner/manager room)
  await expect(page.locator('.kchat-tab[data-ch="owner_mgr"]')).toHaveCount(0);
  const msg = 'Halo ' + Date.now();
  await page.locator('.kchat-ta').fill(msg);
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText(msg);
  // kasir may not reach the private channel at the API level
  const forbid = await chatAs(page, 'Siti', '1111', 'chat_send', { channel: 'owner_mgr', body: 'no', cid: 'k1' });
  expect(forbid.error).toBe('FORBIDDEN');
});

// v36 (owner 2026-10-11: «أريد الدردشة مع كل الفريق المسجل وكل من له يحمل هذا التطبيق»)
test('kasir: the owner wrote privately → badge on the team list; open, read, reply; the reply reaches only the owner', async ({ page }) => {
  await H.login(page, 'Siti', '1111');
  const fab = page.locator('.kchat-fab');
  await expect(fab).toBeVisible();
  await expect(fab.locator('.kchat-badge')).toBeVisible(); // the seeded private note counts before the panel is opened
  await fab.click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  await expect(page.locator('.kchat-member[data-name="Jihan"]')).toBeVisible();
  await expect(page.locator('.kchat-member[data-name="Siti"]')).toHaveCount(0); // not myself
  const own = page.locator('.kchat-member[data-name="Pemilik"]');
  await expect(own.locator('.kchat-mbadge')).toHaveText('1');
  await own.click();
  await expect(page.locator('.kchat-peer b')).toHaveText('Pemilik');
  await expect(page.locator('.kchat-list')).toContainText('cek harga minyak goreng');
  await page.locator('.kchat-ta').fill('Siap Pak, Rp 17.500 per liter.');
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText('Rp 17.500');
  await page.locator('.kchat-back').click();
  await expect(page.locator('.kchat-member[data-name="Pemilik"] .kchat-mbadge')).toHaveCount(0);
  const ob = await chatAs(page, 'Pemilik', '1234', 'chat_bootstrap', {});
  const room = ob.team.find(t => t.name === 'Siti').channel;
  const op = await chatAs(page, 'Pemilik', '1234', 'chat_poll', { cursors: { [room]: '' }, seen: { [room]: '' } });
  expect(op.unread[room]).toBe(1); // Siti's reply (his own note is never unread for him)
  expect(op.messages[room].map(m => m.body)).toContain('Siap Pak, Rp 17.500 per liter.');
  const rina = await chatAs(page, 'Rina', '3333', 'chat_poll', { cursors: { [room]: '' } });
  expect(JSON.stringify(rina)).not.toContain('17.500');
  // Arabic
  await page.evaluate(() => KChatUI.setLang('ar'));
  await expect(page.locator('.kchat-tab[data-ch="team"]')).toHaveText('الفريق');
});
