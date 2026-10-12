// v38 (owner 2026-10-12: "For any notice come to me make for me I can reply"): the owner answers a cashier's notice → she
// finds it in her private room with him (usual unread badge), the notice quoted above his words, and answers there.
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

test('kasir: the owner\'s reply to her notice arrives quoted in their private room; she answers; old messages still render', async ({ page }) => {
  await H.login(page, 'Siti', '1111');
  await expect(page.locator('.kchat-fab')).toBeVisible();
  const ob = await chatAs(page, 'Pemilik', '1234', 'chat_bootstrap', {});
  const room = ob.team.find(t => t.name === 'Siti').channel;
  const at = new Date(Date.now() - 3600000).toISOString();
  const sent = await chatAs(page, 'Pemilik', '1234', 'chat_send', { channel: room, body: 'Salah input apa, Siti?', cid: 'v38-k1',
    quote: { text: 'Permintaan batal faktur KM261012-AB123 Rp 50.000 oleh Siti: salah input', at, no: 'KM261012-AB123', by: 'Siti' }, ref: 'a:ACK1' });
  expect(sent.ok).toBe(true);
  expect(sent.notices.replied['a:ACK1'].to).toBe('Siti');
  await page.locator('.kchat-fab').click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  const own = page.locator('.kchat-member[data-name="Pemilik"]');
  await expect(own.locator('.kchat-mbadge')).toHaveText('2'); // the seeded private note + the reply
  await own.click();
  const reply = page.locator('.kchat-msg', { hasText: 'Salah input apa, Siti?' });
  await expect(reply.locator('.kchat-quote')).toContainText('KM261012-AB123');
  await expect(reply.locator('.kchat-quote .kq-h')).toContainText('Pemberitahuan');
  await expect(reply.locator('.kchat-quote .kq-t')).toContainText('Permintaan batal faktur');
  const old = page.locator('.kchat-msg', { hasText: 'cek harga minyak goreng' }); // the old message format (no quote)
  await expect(old).toBeVisible();
  await expect(old.locator('.kchat-quote')).toHaveCount(0);
  await page.locator('.kchat-ta').fill('Barang tertukar, Pak. Sudah saya cek.');
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).not.toHaveClass(/pending/);
  const op = await chatAs(page, 'Pemilik', '1234', 'chat_poll', { cursors: { [room]: '' }, seen: {} });
  expect(op.messages[room].map(m => m.body)).toContain('Barang tertukar, Pak. Sudah saya cek.');
  expect(op.unread[room]).toBe(1);
  // her own notice state is hers alone: the owner's "dibalas" is not in it
  expect(JSON.stringify((await chatAs(page, 'Siti', '1111', 'chat_bootstrap', {})).notices)).not.toContain('ACK1');
  // Arabic
  await page.evaluate(() => KChatUI.setLang('ar'));
  await expect(reply.locator('.kchat-quote .kq-h')).toContainText('إشعار');
});
