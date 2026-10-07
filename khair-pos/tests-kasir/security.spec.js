// Cost price and profit never reach the screen of this app (the server strips them for non-owners;
// the app drops them even for the owner). Auto-lock after idle minutes.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
const COST_RE = /harga modal|harga pokok|\bHPP\b|\blaba\b|profit|margin|cost/i;
const visibleText = page => page.evaluate(() => [document.querySelector('#app'), document.querySelector('#modals')].map(e => e.innerText).join('\n'));

test('kasir never sees cost or profit (data, screens, receipts, approvals)', async ({ page }) => {
  await H.login(page);
  // the API answer itself carries no cost fields for a kasir
  const raw = await page.evaluate(async () => JSON.stringify(await api('bootstrap')) + JSON.stringify(await api('get_sales', { from: '2020-01-01', to: '2030-01-01' })));
  expect(raw).not.toMatch(/cost_price|total_cost|"profit"|line_profit/);
  expect(await page.evaluate(() => window.KASIR.S.products.some(p => 'cost_price' in p))).toBe(false);
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  expect(await visibleText(page)).not.toMatch(COST_RE);
  await page.click('#pay-ok');
  expect(await visibleText(page)).not.toMatch(COST_RE);
  await page.click('#rc-new');
  for (const v of ['masuk', 'kas', 'more']) { await H.tab(page, v); expect(await visibleText(page)).not.toMatch(COST_RE); }
  // cache on the device has no cost either
  expect(await page.evaluate(() => localStorage.getItem('kpos.mock.kasir.cache'))).not.toMatch(/cost_price/);
});

test('even the owner sees no cost price in the cashier app', async ({ page }) => {
  await H.login(page, 'Pemilik', '1234');
  const db = await H.getDb(page);
  const ajwa = H.productByName(db, /Ajwa/);
  expect(ajwa.cost_price).toBe(135000); // the owner's server data has it…
  expect(await page.evaluate(() => window.KASIR.S.products.some(p => 'cost_price' in p))).toBe(false); // …the app drops it
  const card = page.locator(`#grid .pc[data-id="${ajwa.id}"]`);
  await expect(card).not.toContainText('135.000');
  await page.click('#tb-appr');
  expect(await visibleText(page)).not.toMatch(COST_RE);
});

test('auto-lock after settings.auto_lock_minutes idle → PIN pad, cart kept', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, 'db.settings.auto_lock_minutes = 0.05;'); // 3 seconds
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await H.addItem(page, 'ajwa');
  await expect(page.locator('#pin-who')).toHaveText('Siti', { timeout: 15000 });
  await expect(page.locator('#login')).toContainText('terkunci');
  await H.typePin(page, '1111');
  await expect(page.locator('#paybar-total')).toHaveText(H.rp(175000));
  await expect(page.locator('#gate')).toBeHidden();
});

test('sales reps log in here and go on to Khair Sales (no second PIN); the server still refuses cashier actions', async ({ page }) => {
  await page.route('**/sales/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Khair Sales (stub)</title><p>sales app</p>' }));
  await H.openKasir(page);
  await H.setDb(page, `db.users.push({ name: 'Ahmad', role: 'sales', pin_hash: arg, active: true });`, H.sha('demo:ahmad:4444'));
  await page.reload();
  await H.enterKey(page);
  await expect(page.locator('[data-act="login-user"][data-name="Siti"]')).toBeVisible();
  await page.click('[data-act="login-user"][data-name="Ahmad"]');
  await H.typePin(page, '4444');
  await page.waitForURL(/\/sales\/index\.html\?mock=1$/);
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('kpos.mock.sales.session')))).toEqual({ user: 'Ahmad', role: 'sales', pin_hash: H.sha('demo:ahmad:4444') });
  await H.openKasir(page);
  const r = await page.evaluate(async h => { try { await apiRaw('bootstrap', {}, { key: 'demo', user: 'Ahmad', pin_hash: h }); await apiRaw('save_sale', { items: [] }, { key: 'demo', user: 'Ahmad', pin_hash: h }); return 'ok'; } catch (e) { return e.code; } }, H.sha('demo:ahmad:4444'));
  expect(r).toBe('FORBIDDEN');
});

test('on-site approval is never queued offline: "Butuh internet…", nothing with the approver PIN on the device', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'kismis hijau');
  await H.pay(page);
  await page.click('#pm-hutang');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Warung Bu Halimah' }).click();
  await page.click('#pay-ok');
  await page.click('#ap-here');
  await page.click('#ap-users [data-n="Jihan"]');
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1')); // the request fails like a dropped connection
  await page.fill('#ap-pin', '2222');
  await page.click('#ap-ok');
  await expect(page.locator('#ap-err')).toContainText('Butuh internet untuk persetujuan di tempat');
  await expect(page.locator('#ap-pin')).toHaveValue('');
  expect(await page.evaluate(() => window.KASIR.S.outbox.length)).toBe(0);
  const approverHash = H.sha('demo:jihan:2222');
  expect(JSON.stringify(await page.evaluate(() => Object.keys(localStorage).filter(k => !k.startsWith('kmock.')).map(k => localStorage.getItem(k)).concat(Object.keys(sessionStorage).map(k => sessionStorage.getItem(k)))))).not.toContain(approverHash);
  // back online: the same approval works
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  await page.fill('#ap-pin', '2222');
  await page.click('#ap-ok');
  await expect(page.locator('#rc-modal #receipt')).toContainText('Jihan');
});

test('store key masked; pins keep only an offline verifier; the session hash lives in this tab and is wiped on lock', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    // an old device: a reusable hash in pins and in the stored session
    localStorage.setItem('kpos.mock.pins', JSON.stringify({ pemilik: { h: 'b'.repeat(64), role: 'owner' } }));
  });
  await H.login(page);
  const hash = H.sha('demo:siti:1111');
  const st = await page.evaluate(() => ({ pins: JSON.parse(localStorage.getItem('kpos.mock.pins')), ls: JSON.parse(localStorage.getItem('kpos.mock.kasir.session')), ss: JSON.parse(sessionStorage.getItem('kpos.mock.kasir.session')) }));
  expect(st.pins.pemilik).toEqual({ o: H.sha('offline:' + 'b'.repeat(64)), role: 'owner' });
  expect(st.pins.siti).toEqual({ o: H.sha('offline:' + hash), role: 'kasir' });
  expect(st.ls).toEqual({ user: 'Siti', role: 'kasir' });
  expect(st.ss).toMatchObject({ user: 'Siti', pin_hash: hash });
  // the outbox entries keep their own credentials (offline sales); everything else on the device has no hash
  expect(JSON.stringify(await page.evaluate(() => Object.keys(localStorage).filter(k => !k.startsWith('kmock.') && !k.endsWith('kasir.outbox')).map(k => localStorage.getItem(k))))).not.toContain(hash);
  await page.click('#tb-lock');
  await expect(page.locator('#pin-who')).toHaveText('Siti');
  expect(await page.evaluate(() => sessionStorage.getItem('kpos.mock.kasir.session'))).toBeNull();
  await page.reload();
  await expect(page.locator('#pin-who')).toHaveText('Siti'); // still locked after a reload
  // offline login works with the verifier
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  await H.typePin(page, '1111');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.toast.warn')).toContainText('offline');
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  await page.click('#tb-lock');
  await page.locator('[data-act="login-back"]').first().click();
  await expect(page.locator('[data-act="login-change-key"]')).toContainText('(••••demo)');
  await expect(page.locator('#login')).not.toContainText('(demo)');
});
