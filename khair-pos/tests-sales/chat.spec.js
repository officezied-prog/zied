// Phase 3 chat in Khair Sales (field rep): the rep sees the general channel only and can send.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test('rep: chat launcher, general only, send a message', async ({ page }) => {
  await H.login(page, 'Ahmad', '4444');
  const fab = page.locator('.kchat-fab');
  await expect(fab).toBeVisible();
  await fab.click();
  await expect(page.locator('.kchat-wrap.open')).toBeVisible();
  await expect(page.locator('.kchat-tab')).toHaveCount(2); // v36: general + the team tab
  const msg = 'Dari lapangan ' + Date.now();
  await page.locator('.kchat-ta').fill(msg);
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText(msg);
});

// v36 (owner 2026-10-11: «أريد الدردشة مع كل الفريق المسجل وكل من له يحمل هذا التطبيق»)
test('rep: private room with the owner from the team list; only the owner receives it', async ({ page }) => {
  await H.login(page, 'Ahmad', '4444');
  await page.locator('.kchat-fab').click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  await expect(page.locator('.kchat-member[data-name="Pemilik"]')).toBeVisible();
  await expect(page.locator('.kchat-member[data-name="Ahmad"]')).toHaveCount(0);
  await page.locator('.kchat-member[data-name="Pemilik"]').click();
  await expect(page.locator('.kchat-peer b')).toHaveText('Pemilik');
  await expect(page.locator('.kchat-empty')).toBeVisible();
  await page.locator('.kchat-ta').fill('Pak, toko baru di Jl. Condet mau order 20 dus.');
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText('20 dus');
  await expect(page.locator('.kchat-msg.me').last()).not.toHaveClass(/pending/);
  const res = await page.evaluate(async () => {
    const as = async (user, pin, action, data) => { const pin_hash = await pinHash('demo', user, pin); try { return await apiRawInner(action, data, { key: 'demo', user, pin_hash }, { chat: true }); } catch (e) { return { error: e.code }; } };
    const ob = await as('Pemilik', '1234', 'chat_bootstrap', {});
    const room = ob.team.find(t => t.name === 'Ahmad').channel;
    return { owner: await as('Pemilik', '1234', 'chat_poll', { cursors: { [room]: '' } }), siti: await as('Siti', '1111', 'chat_poll', { cursors: { [room]: '' } }), room };
  });
  expect(res.owner.messages[res.room].map(m => m.body)).toContain('Pak, toko baru di Jl. Condet mau order 20 dus.');
  expect(JSON.stringify(res.siti)).not.toContain('20 dus');
});
