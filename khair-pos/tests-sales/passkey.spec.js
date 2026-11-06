// v77 (owner 2026-11-06: «هل يمكن ان يتم الفتح ببصمة او بالوجه», his choice «أ»): a sales rep opens Khair Sales with his own phone's
// fingerprint / face (a passkey). Chromium's virtual authenticator plays the sensor; the demo backend checks it as the Worker does.
// A passkey needs a host name, so the page runs on localhost.
const { test, expect } = require('./helpers');
const crypto = require('crypto');

const PORT = Number(process.env.SALES_PORT || 8767);
const APP = `http://localhost:${PORT}/sales/index.html?mock=1`;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function sensor(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}
async function pinLogin(page, user, pin) {
  if (await page.locator('#lg-key').isVisible()) { await page.fill('#lg-key', 'demo'); await page.click('[data-act="login-key"]'); }
  if (!(await page.locator('#pin-who').isVisible())) await page.click(`#users [data-act="login-user"][data-name="${user}"]`);
  for (const d of pin) await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#app')).toBeVisible();
}

test('the rep turns it on once with his PIN; then the app opens with the fingerprint; the menu switches it off', async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('kpos.device_consent')) localStorage.setItem('kpos.device_consent', JSON.stringify({ ok: false, at: new Date().toISOString() })); });
  await sensor(page);
  await page.goto(APP);
  await pinLogin(page, 'Ahmad', '4444');
  await expect(page.locator('#pk-offer')).toBeVisible();
  await page.click('#pk-yes');
  await expect(page.locator('.toast').last()).toContainText('Sidik jari / wajah aktif');
  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')).passkeys);
  expect(rows.map(r => r.user)).toEqual(['ahmad']);

  // locked: one tap on the button
  await page.click('#tb-menu');
  await page.click('#m-lock');
  await expect(page.locator('#lg-pk')).toBeVisible();
  await page.click('#lg-pk');
  await expect(page.locator('#app')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('kpos.mock.sales.session')).pin_hash)).toBe(sha('demo:ahmad:4444'));

  // opening the app again: straight into the fingerprint check
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();

  // the menu shows it on and switches it off
  await page.click('#tb-menu');
  await expect(page.locator('#m-pk')).toContainText('Aktif di HP ini');
  await page.click('#m-pk');
  await page.click('#cf-ok');
  await expect(page.locator('.toast').last()).toContainText('dimatikan');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')).passkeys)).toEqual([]);
  await page.click('#tb-menu');
  await page.click('#m-lock');
  await expect(page.locator('#lg-pk')).toHaveCount(0);
});
