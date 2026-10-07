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
  await expect(page.locator('.kchat-tab')).toHaveCount(0); // single channel → tab bar hidden
  const msg = 'Halo ' + Date.now();
  await page.locator('.kchat-ta').fill(msg);
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText(msg);
  // kasir may not reach the private channel at the API level
  const forbid = await chatAs(page, 'Siti', '1111', 'chat_send', { channel: 'owner_mgr', body: 'no', cid: 'k1' });
  expect(forbid.error).toBe('FORBIDDEN');
});
