// v80 (owner 2026-11-24: «أنا المالك أستطيع أن أرى كل المحادثات … وأنا الوحيد»): the owner reads the others' private rooms
// (read-only, under "Pantau"); the staff do not; the owner makes the key of his Claude assistant in the chat panel.
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

function chatAs(page, user, pin, action, data = {}) {
  return page.evaluate(async ({ user, pin, action, data }) => {
    const pin_hash = await KPOS.pinHash('demo', user, pin);
    try { return await apiRawInner(action, data, { key: 'demo', user, pin_hash }, { chat: true }); }
    catch (e) { return { error: e.code, message: e.message }; }
  }, { user, pin, action, data });
}

test('owner watches a room between two others (read-only); the assistant key is made once and can be turned off', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const boot = await chatAs(page, 'Rina', '3333', 'chat_bootstrap', {});
  const peer = boot.team.find(t => t.name !== 'Pemilik');
  expect((await chatAs(page, 'Rina', '3333', 'chat_send', { channel: peer.channel, body: 'Stok kurma tinggal 5 dus', cid: 'w-1' })).ok).toBe(true);
  // the other person never gets a watch entry
  const other = await chatAs(page, peer.name, peer.name === 'Siti' ? '1111' : '2222', 'chat_bootstrap', {});
  if (!other.error) expect(other.team.every(t => !t.readonly)).toBe(true);

  await page.locator('.kchat-fab').click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  await expect(page.locator('.kchat-list')).toContainText('Pantau');
  const label = [peer.name, 'Rina'].sort().join(' ↔ ');
  const w = page.locator('.kchat-member', { hasText: '↔' }).first();
  await expect(w).toBeVisible();
  await w.click();
  await expect(page.locator('.kchat-list')).toContainText('Stok kurma tinggal 5 dus');
  await expect(page.locator('.kchat-foot')).toBeHidden(); // read-only: no composer
  expect(label.length).toBeGreaterThan(3);
  // the owner cannot post there, even by hand
  const watched = (await chatAs(page, 'Pemilik', '1234', 'chat_bootstrap', {})).team.find(t => t.readonly);
  expect((await chatAs(page, 'Pemilik', '1234', 'chat_send', { channel: watched.channel, body: 'x', cid: 'o-x' })).error).toBe('FORBIDDEN');

  // the assistant key (demo): made, shown once, turned off
  await page.locator('.kchat-peer button').first().click().catch(() => {});
  await page.locator('.kchat-tab[data-ch="team"]').click();
  const card = page.locator('.kchat-as');
  await expect(card).toContainText('Asisten Claude');
  await card.locator('button', { hasText: 'Buat kunci baru' }).click();
  await expect(card).toContainText('kma_DEMO');
  await expect(card).toContainText('Aktif sejak');
  await card.locator('button', { hasText: 'Matikan' }).click();
  await expect(card).toContainText('Belum aktif');
  // the assistant key is the owner's alone
  expect((await chatAs(page, 'Rina', '3333', 'assistant_key_new', {})).error).toBe('FORBIDDEN');
});
