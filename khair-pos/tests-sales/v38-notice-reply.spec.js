// v38 (owner 2026-10-12: "For any notice come to me make for me I can reply"): a rep gets the owner's reply to a notice he
// caused in their private room, the notice quoted; he answers there like any chat.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test('rep: the owner\'s reply to his notice arrives quoted in their private room; he answers', async ({ page }) => {
  await H.login(page, 'Ahmad', '4444');
  await expect(page.locator('.kchat-fab')).toBeVisible();
  const as = (user, pin, action, data) => page.evaluate(async ({ user, pin, action, data }) => {
    const pin_hash = await pinHash('demo', user, pin);
    try { return await apiRawInner(action, data, { key: 'demo', user, pin_hash }, { chat: true }); } catch (e) { return { error: e.code }; }
  }, { user, pin, action, data });
  const ob = await as('Pemilik', '1234', 'chat_bootstrap', {});
  const room = ob.team.find(t => t.name === 'Ahmad').channel;
  const sent = await as('Pemilik', '1234', 'chat_send', { channel: room, body: 'Kenapa pesanan ini dibatalkan?', cid: 'v38-s1',
    quote: { text: 'Pesanan lapangan FO-261012-0003 dibatalkan oleh Ahmad', at: new Date().toISOString(), no: 'FO-261012-0003', by: 'Ahmad' }, ref: 'a:ACS1' });
  expect(sent.ok).toBe(true);
  await page.locator('.kchat-fab').click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  await expect(page.locator('.kchat-member[data-name="Pemilik"] .kchat-mbadge')).toHaveText('1');
  await page.locator('.kchat-member[data-name="Pemilik"]').click();
  const msg = page.locator('.kchat-msg', { hasText: 'Kenapa pesanan ini dibatalkan?' });
  await expect(msg.locator('.kchat-quote')).toContainText('FO-261012-0003');
  await page.locator('.kchat-ta').fill('Tokonya tutup, Pak.');
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).not.toHaveClass(/pending/);
  const op = await as('Pemilik', '1234', 'chat_poll', { cursors: { [room]: '' } });
  expect(op.messages[room].map(m => m.body)).toContain('Tokonya tutup, Pak.');
});
