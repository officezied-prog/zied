// v16 Owner master code, own PINs at first login (must_change), LOCKED after 5 wrong PINs.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, sha, login, getDb, nav, asUser, typePin, editDb } = require('./helpers');

const MASTER = '24681357';
const masterHash = code => sha(`demo:__master__:${code}`);
async function pickUser(page, name) { await page.click(`[data-act="login-user"][data-name="${name}"]`); }

test('Kode pemilik: set twice-typed 8 digits; log in to another account with it (badge, activity); refused when the session is via master', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await expect(page.locator('#st-mc-state')).toHaveText('Belum ada');
  await page.fill('#st-mc1', '1234567');
  await page.click('#st-mc-save');
  await expect(page.locator('#st-mc-err')).toContainText('8 angka');
  await page.fill('#st-mc1', MASTER);
  await page.fill('#st-mc2', '24681350');
  await page.click('#st-mc-save');
  await expect(page.locator('#st-mc-err')).toContainText('tidak sama');
  await page.fill('#st-mc2', MASTER);
  await page.click('#st-mc-save');
  await expect(page.locator('#st-mc-state')).toHaveText('Kode pemilik aktif');
  let db = await getDb(page);
  expect(db.users.find(u => u.name === 'Pemilik').master_hash).toBe(masterHash(MASTER));
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'kode_pemilik', level: 'warn' });
  // the code is never kept on the device
  expect(await page.evaluate(h => Object.keys(localStorage).filter(k => k !== 'kmock.db').some(k => localStorage.getItem(k).includes(h)), masterHash(MASTER))).toBe(false);
  await page.locator('#st-master').screenshot({ path: path.join(SHOTS, 'desktop-settings-master.png') });

  // log in to Jihan's account with the master code
  await page.click('#tb-lock');
  await pickUser(page, 'Jihan');
  await page.click('#lg-master');
  await expect(page.locator('#lg-master-on')).toContainText('Jihan');
  await typePin(page, '12345678'.slice(0, 7));
  await expect(page.locator('#lg-err')).toContainText('8 angka');
  await typePin(page, '11112222');
  await expect(page.locator('#lg-err')).not.toBeEmpty();
  await typePin(page, MASTER);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Jihan');
  await expect(page.locator('#tb-master')).toBeVisible();
  await expect(page.locator('#tb-master')).toHaveText('via kode pemilik');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-login-via-master.png') });
  db = await getDb(page);
  expect(db.activity.filter(a => a.kind === 'masuk_master').slice(-1)[0]).toMatchObject({ user: 'Jihan', level: 'warn' });
  // the master code is not remembered as an offline PIN
  const pins = await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.pins') || '{}'));
  expect(pins.jihan).toBeUndefined();

  // owner via master: the card refuses, the server refuses set_master / change_pin
  await page.click('#tb-lock');
  await pickUser(page, 'Pemilik');
  await page.click('#lg-master');
  await typePin(page, MASTER);
  await expect(page.locator('#tb-master')).toBeVisible();
  await nav(page, 'settings');
  await expect(page.locator('#st-mc-via')).toBeVisible();
  await expect(page.locator('#st-mc-save')).toBeDisabled();
  const r = await page.evaluate(async h => { try { return await api('set_master', { master_hash: h }); } catch (e) { return { error: e.code }; } }, masterHash('99998888'));
  expect(r.error).toBe('FORBIDDEN');
  const r2 = await page.evaluate(async h => { try { return await api('change_pin', { new_pin_hash: h }); } catch (e) { return { error: e.code }; } }, sha('demo:pemilik:654321'));
  expect(r2.error).toBe('FORBIDDEN');
});

test('a PIN the owner sets is temporary: notice + "belum ganti PIN"; first login → "Buat PIN baru" (6 digits for a manager); PIN_CHANGE_REQUIRED until then', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await page.fill('#nu-name', 'Nadia');
  await page.selectOption('#nu-role', 'manager');
  await page.fill('#nu-pin', '1357');
  await page.fill('#nu-pin2', '1357');
  await page.click('[data-act="user-add"]');
  await expect(page.locator('#st-temp-pin')).toContainText('Nadia');
  await expect(page.locator('#st-users tr').filter({ hasText: 'Nadia' }).locator('[data-must]')).toHaveText('belum ganti PIN');
  let db = await getDb(page);
  expect(db.users.find(u => u.name === 'Nadia')).toMatchObject({ must_change: true, role: 'manager' });
  await page.locator('#st-users').screenshot({ path: path.join(SHOTS, 'desktop-users-temp-pin.png') });
  // every action but login / change_pin is refused until the own PIN is made
  expect(await asUser(page, 'Nadia', '1357', 'bootstrap')).toMatchObject({ error: 'PIN_CHANGE_REQUIRED' });
  expect(await asUser(page, 'Nadia', '1357', 'login')).toMatchObject({ must_change: true });

  await page.click('#tb-lock');
  await page.evaluate(() => { localStorage.removeItem('kpos.mock.users_demo'); });
  await page.reload();
  await pickUser(page, 'Nadia');
  await typePin(page, '1357');
  await expect(page.locator('#pin-change')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#pc-title')).toHaveText('Buat PIN baru');
  for (const d of '1234') await page.click(`[data-act="pc-key"][data-k="${d}"]`);
  await page.click('[data-act="pc-key"][data-k="ok"]');
  await expect(page.locator('#pc-err')).toContainText('6 angka');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-pin-change.png') });
  const enter = async pin => { for (const d of pin) await page.click(`[data-act="pc-key"][data-k="${d}"]`); await page.click('[data-act="pc-key"][data-k="ok"]'); };
  await page.click('[data-act="pc-key"][data-k="del"]'); await page.click('[data-act="pc-key"][data-k="del"]'); await page.click('[data-act="pc-key"][data-k="del"]'); await page.click('[data-act="pc-key"][data-k="del"]');
  await enter('482915');
  await expect(page.locator('#pc-step')).toHaveAttribute('data-step', '2');
  await enter('482910');
  await expect(page.locator('#pc-err')).toContainText('tidak sama');
  await enter('482915');
  await enter('482915');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#pin-change')).toBeHidden();
  await expect(page.locator('#tb-user')).toHaveText('Nadia');
  db = await getDb(page);
  expect(db.users.find(u => u.name === 'Nadia')).toMatchObject({ must_change: false, pin_hash: sha('demo:nadia:482915') });
  expect(db.activity.filter(a => a.kind === 'ganti_pin').slice(-1)[0]).toMatchObject({ user: 'Nadia' });
  expect(await asUser(page, 'Nadia', '1357', 'bootstrap')).toMatchObject({ error: 'BAD_PIN' });
  expect((await asUser(page, 'Nadia', '482915', 'bootstrap')).user).toMatchObject({ name: 'Nadia', role: 'manager' });
});

test('phone: "Buat PIN baru" full screen; PIN_CHANGE_REQUIRED during a session opens it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'Jihan', '2222', '', { stay: true });
  await editDb(page, `db.users.find(u => u.name === 'Jihan').must_change = true;`);
  await page.evaluate(() => refreshData(true));
  await expect(page.locator('#pin-change')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'phone-pin-change.png') });
  await page.click('#pc-cancel');
  await expect(page.locator('#login')).toBeVisible();
});

test('5 wrong PINs lock the account 15 minutes: message with the time, pad disabled; the server says LOCKED even for the right PIN', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.click('#tb-lock');
  await pickUser(page, 'Jihan');
  for (let i = 0; i < 4; i++) { await typePin(page, '9999'); await expect(page.locator('#lg-err')).not.toBeEmpty(); }
  await expect(page.locator('#lg-err')).toContainText('1 kali lagi');
  await typePin(page, '9999');
  await expect(page.locator('#lg-locked')).toContainText(/dikunci sampai jam \d\d:\d\d WIB/);
  await expect(page.locator('#lg-pad [data-k="1"]')).toBeDisabled();
  await expect(page.locator('#lg-pad [data-k="ok"]')).toBeDisabled();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-login-locked.png') });
  const db = await getDb(page);
  const j = db.users.find(u => u.name === 'Jihan');
  expect(Date.parse(j.locked_until)).toBeGreaterThan(Date.now() + 14 * 60000);
  expect(await asUser(page, 'Jihan', '2222', 'login')).toMatchObject({ error: 'LOCKED' });
  // other accounts are not locked
  await pickUser(page, 'Pemilik');
  await expect(page.locator('#lg-pad [data-k="1"]')).toBeEnabled();
  // after the time the pad works again (server lock lifted)
  await editDb(page, `db.users.find(u => u.name === 'Jihan').locked_until = new Date(Date.now() - 1000).toISOString();`);
  await page.evaluate(() => { const l = JSON.parse(localStorage.getItem('kpos.mock.locks')); l.jihan.until = Date.now() - 1; localStorage.setItem('kpos.mock.locks', JSON.stringify(l)); });
  await pickUser(page, 'Jihan');
  await expect(page.locator('#lg-pad [data-k="1"]')).toBeEnabled();
  await typePin(page, '2222');
  await expect(page.locator('#app')).toBeVisible();
  expect((await getDb(page)).users.find(u => u.name === 'Jihan')).toMatchObject({ fail_count: 0, locked_until: '' });
});

test('LOCKED answers carry locked_until; sales may change_pin; get_sale gives the invoice with what was already returned', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  for (let i = 0; i < 4; i++) await asUser(page, 'Rina', '0000', 'login');
  const l = await page.evaluate(async () => { try { await apiRaw('login', {}, { key: 'demo', user: 'Rina', pin_hash: 'f'.repeat(64) }); } catch (e) { return e.data; } });
  expect(l.error).toBe('LOCKED');
  expect(Date.parse(l.locked_until)).toBeGreaterThan(Date.now() + 14 * 60000);
  expect(await asUser(page, 'Ahmad', '4444', 'change_pin', { new_pin_hash: sha('demo:ahmad:5678') })).toMatchObject({ ok: true });
  const db = await getDb(page);
  const s = db.sales.filter(x => x.status !== 'void').slice(-1)[0];
  const g = await asUser(page, 'Pemilik', '1234', 'get_sale', { invoice_no: s.invoice_no });
  expect(g.sale.invoice_no).toBe(s.invoice_no);
  expect(g.items.length).toBeGreaterThan(0);
  expect(g.returned).toEqual({});
  expect(await asUser(page, 'Pemilik', '1234', 'get_sale', { invoice_no: 'KM000000-XXXX' })).toMatchObject({ error: 'NOT_FOUND' });
});
