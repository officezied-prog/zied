// v19: manager manages only kasir/sales; a code attempt locks a non-owner account; the owner unlocks.
const { test, expect } = require('@playwright/test');
const { openApp, enterKey, typePin, login, getDb, nav } = require('./helpers');

test('manager: user role options are kasir/sales only (+ daily worker); no akuntan/manager/owner', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'settings');
  await expect(page.locator('#st-users [data-role-group]')).toHaveCount(2);
  await expect(page.locator('#st-users [data-role-group="kasir"]')).toBeVisible();
  await expect(page.locator('#st-users [data-role-group="akuntan"]')).toHaveCount(0);
  expect(await page.locator('#nu-role option').evaluateAll(o => o.map(x => x.value))).toEqual(['pekerja', 'kasir', 'sales']);
  const r = await page.evaluate(async () => { try { await api('save_user', { name: 'Rina', role: 'akuntan', pin_hash: 'a'.repeat(64) }); return 'ok'; } catch (e) { return e.code; } });
  expect(r).toBe('FORBIDDEN');
});

test('a code attempt locks the account and the login reports it; the owner unlocks from Settings', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const r = await page.evaluate(async () => { try { await api('save_customer', { name: 'Maju', notes: '${evil}' }); return 'ok'; } catch (e) { return e.code; } });
  expect(r).toBe('TAMPER');
  expect((await getDb(page)).settings.locked_accounts).toContain('jihan');
  // the login now reports the lock, and a normal action stays blocked
  const lg = await page.evaluate(async () => { const h = await KPOS.pinHash('demo', 'Jihan', '2222'); return await apiRaw('login', {}, { key: 'demo', user: 'Jihan', pin_hash: h }); });
  expect(lg.tamper_locked).toBe(true);
  const blocked = await page.evaluate(async () => { const h = await KPOS.pinHash('demo', 'Jihan', '2222'); try { await apiRaw('save_sale', { client_id: 'z', items: [], payment_method: 'tunai', paid_amount: 0 }, { key: 'demo', user: 'Jihan', pin_hash: h }); return 'ok'; } catch (e) { return e.code; } });
  expect(blocked).toBe('TAMPER_LOCKED');
  // owner opens the app, sees the locked account and unlocks it
  await page.evaluate(() => { localStorage.removeItem('kpos.mock.session'); sessionStorage.clear(); });
  await page.goto('index.html?mock=1');
  if (await page.locator('#lg-key').count()) await enterKey(page);
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await typePin(page, '1234');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'settings');
  const jihanRow = page.locator('#st-users tr').filter({ hasText: 'Jihan' });
  await expect(jihanRow.locator('[data-tamper]')).toBeVisible();
  await jihanRow.locator('[data-act="user-unlock"]').click();
  await page.click('#cf-ok');
  await expect.poll(async () => (await getDb(page)).settings.locked_accounts).toEqual([]);
  await expect(page.locator('#st-users tr').filter({ hasText: 'Jihan' }).locator('[data-tamper]')).toHaveCount(0);
});
