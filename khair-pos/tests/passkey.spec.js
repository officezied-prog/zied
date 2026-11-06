// v77 (owner 2026-11-06: «هل يمكن ان يتم الفتح ببصمة او بالوجه», his choice «أ»): the owner, the manager and the accountant open the app
// with the phone's own fingerprint / face (a passkey). Chromium's virtual authenticator plays the phone's sensor; the demo backend checks
// the signatures exactly as the Worker does (shared/passkey.js). A passkey needs a host name, so these pages run on localhost.
const { test, expect } = require('@playwright/test');
const crypto = require('crypto');

const PORT = Number(process.env.KPOS_PORT || 8765);
const APP = `http://localhost:${PORT}/index.html?mock=1`;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/** The phone's fingerprint / face sensor (a platform authenticator that checks the person). */
async function sensor(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { verified: ok => cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: ok }) };
}
async function open(page) {
  await page.addInitScript(() => { try { if (!localStorage.getItem('kpos.loc_consent')) localStorage.setItem('kpos.loc_consent', 'no'); } catch (e) { } });
  await page.goto(APP);
  await expect(page.locator('#login')).toBeVisible();
  if (await page.locator('#lg-key').isVisible()) { await page.fill('#lg-key', 'demo'); await page.click('[data-act="login-key"]'); }
}
async function pinLogin(page, user, pin) {
  await page.click(`[data-act="login-user"][data-name="${user}"]`);
  for (const d of pin) await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#app')).toBeVisible();
}
const db = page => page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')));
const session = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('kpos.mock.session') || 'null'));

test('the manager turns it on once after her PIN; then the app opens with the fingerprint alone — the same session as a PIN login', async ({ page }) => {
  const s = await sensor(page);
  await open(page);
  await pinLogin(page, 'Jihan', '2222');
  // offered once, right after the PIN login
  await expect(page.locator('#pk-offer')).toBeVisible();
  await expect(page.locator('#pk-offer')).toContainText('sidik jari atau wajah');
  await page.click('#pk-yes');
  await expect(page.locator('.toast').last()).toContainText('Sidik jari / wajah aktif');
  const rows = (await db(page)).passkeys;
  expect(rows.map(r => r.user)).toEqual(['jihan']);
  expect(rows[0].public_key.length).toBeGreaterThan(80);
  expect((await db(page)).activity.some(a => a.kind === 'keamanan' && /diaktifkan untuk akun Jihan/.test(a.summary))).toBe(true);

  // locked (idle / the lock button): the button is there, nothing pops up by itself
  await page.click('#tb-lock');
  await expect(page.locator('#lg-pk')).toBeVisible();
  await expect(page.locator('#lg-pk')).toContainText('Masuk dengan sidik jari / wajah');
  await page.waitForTimeout(600);
  await expect(page.locator('#app')).toBeHidden();
  await page.click('#lg-pk');
  await expect(page.locator('#app')).toBeVisible();
  expect((await session(page)).pin_hash).toBe(sha('demo:jihan:2222'));
  await expect(page.locator('#pk-offer')).toHaveCount(0); // never offered again once on

  // opening the app again (a new start, no session in the tab): straight into the fingerprint check — no tap at all
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  expect((await session(page)).user).toBe('Jihan');

  // the sensor refuses (wrong finger / face): nothing opens, the PIN pad is there
  await s.verified(false);
  await page.click('#tb-lock');
  await page.click('#lg-pk');
  await expect(page.locator('#lg-err')).toContainText('Dibatalkan');
  await expect(page.locator('#app')).toBeHidden();
  await s.verified(true);

  // the owner removed it (a lost phone) or the PIN was changed: the server no longer has it → back to the PIN, the button goes
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('kmock.db')); d.passkeys = []; localStorage.setItem('kmock.db', JSON.stringify(d)); });
  await page.click('#lg-pk');
  await expect(page.locator('#lg-err')).toContainText('tidak berlaku');
  await expect(page.locator('#lg-pk')).toHaveCount(0);
  for (const d of '2222') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#app')).toBeVisible();
});

test('the owner sees every device and removes a lost phone; "Nanti" is not asked again; a new PIN switches it off', async ({ page }) => {
  await sensor(page);
  await open(page);
  await pinLogin(page, 'Pemilik', '1234');
  await page.click('#pk-yes');
  await expect(page.locator('.toast').last()).toContainText('Sidik jari / wajah aktif');
  // the manager's phone (made earlier on her own phone)
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('kmock.db'));
    d.passkeys.push({ cred_id: 'LOSTPHONE0000000000000', user: 'jihan', user_name: 'Jihan', public_key: 'x', alg: -7, sign_count: 0, last_t: 0, device: 'Android · Chrome', created_at: new Date().toISOString(), last_used_at: '' });
    localStorage.setItem('kmock.db', JSON.stringify(d));
  });
  await page.evaluate(() => go('settings'));
  const panel = page.locator('#st-pk');
  await expect(panel.locator('#st-pk-state')).toHaveText('Aktif di HP ini');
  await expect(panel.locator('#st-pk-list')).toContainText('Pemilik');
  await expect(panel.locator('#st-pk-list [data-pk] .badge')).toHaveText('HP ini');
  await expect(panel.locator('#st-pk-list')).toContainText('Jihan · Android · Chrome');
  await panel.locator('[data-act="pk-del"][data-id="LOSTPHONE0000000000000"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('.toast').last()).toContainText('Perangkat dihapus');
  await expect(panel.locator('#st-pk-list')).not.toContainText('Jihan');
  expect((await db(page)).passkeys.map(r => r.user)).toEqual(['pemilik']);

  // the manager says "Nanti": not asked again on this phone; Pengaturan still has the switch
  await page.click('#tb-lock');
  await pinLogin(page, 'Jihan', '2222');
  await expect(page.locator('#pk-offer')).toBeVisible();
  await page.click('#pk-later');
  await expect(page.locator('.toast').last()).toContainText('Pengaturan');
  await page.click('#tb-lock');
  await pinLogin(page, 'Jihan', '2222');
  await page.waitForTimeout(1800);
  await expect(page.locator('#pk-offer')).toHaveCount(0);
  await page.evaluate(() => go('settings'));
  await expect(page.locator('#st-pk-on')).toBeVisible();
  await expect(page.locator('#st-pk-list')).toHaveCount(0); // only the owner sees every account's devices
  // a new PIN switches it off: the owner's passkey goes when his PIN is changed
  await page.click('#tb-lock');
  await pinLogin(page, 'Pemilik', '1234');
  await page.evaluate(async () => { await api('change_pin', { new_pin_hash: await pinHash(S.key, S.user, '123456') }); });
  expect((await db(page)).passkeys).toEqual([]);
});

test('a phone without its own fingerprint / face check is never asked; a kasir account is refused by the server; Arabic', async ({ page }) => {
  await open(page); // no sensor at all
  await pinLogin(page, 'Jihan', '2222');
  await page.waitForTimeout(1800);
  await expect(page.locator('#pk-offer')).toHaveCount(0);
  await page.evaluate(() => go('settings'));
  await expect(page.locator('#st-pk-no')).toContainText('belum bisa memakai sidik jari');
  // the server (here its demo twin) never gives a cashier a passkey, whatever an app sends
  const r = await page.evaluate(async () => {
    const d = JSON.parse(localStorage.getItem('kmock.db')), k = d.users.find(u => u.role === 'kasir');
    return MockServer.request({ action: 'passkey_add', key: 'demo', user: k.name, pin_hash: k.pin_hash, data: { cred_id: 'x' } });
  });
  expect(r.error).toBe('FORBIDDEN');
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#st-pk h3')).toContainText('الدخول بالبصمة أو الوجه');
});
