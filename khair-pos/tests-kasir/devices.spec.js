// v11 devices: a one-time location notice per device, the location with every main-API request (data.device),
// device_ping on open and every 30 min when idle, and settings.require_device_location blocking kasir/manager (never the owner).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const POS = { latitude: -6.2655, longitude: 106.8605, accuracy: 20 };
const log = page => page.evaluate(() => window.KASIR.mockLog());
const near = (a, b) => Math.abs(a - b) < 1e-5;

test.describe('location allowed in the browser', () => {
  test.use({ ...H.PHONE, geolocation: POS, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });

  test('notice once per device; Setuju → 📍 and the fix goes with every request; device_ping on open; row + activity', async ({ page }) => {
    await H.login(page, 'Siti', '1111', { devConsent: null, openShift: false });
    const notice = page.locator('#dev-consent');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Lokasi perangkat ini dibagikan ke pemilik toko selama aplikasi dibuka (keamanan & absensi)');
    await expect(page.locator('#dev-ok')).toHaveText('Setuju');
    await expect(page.locator('#dev-no')).toHaveText('Tidak');
    // nothing asked from the browser before the answer
    expect((await log(page)).filter(e => e.device).every(e => e.device.loc_status === 'prompt' && e.device.lat === undefined)).toBe(true);
    await H.shot(page, 'phone-34-device-consent');
    await page.click('#dev-ok');
    await expect(notice).toHaveCount(0);
    await expect(page.locator('#tb-loc')).toBeVisible();
    await expect(page.locator('#tb-loc')).toHaveText('📍');
    await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping' && e.device && e.device.loc_status === 'granted').length).toBeGreaterThanOrEqual(1);
    const id = await page.evaluate(() => localStorage.getItem('kpos.device_id'));
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const ping = (await log(page)).find(e => e.action === 'device_ping' && e.device.loc_status === 'granted');
    expect(ping.device).toMatchObject({ id, app: 'kasir', label: 'Linux · Chrome', acc: 20 });
    expect(near(ping.device.lat, POS.latitude) && near(ping.device.lng, POS.longitude)).toBe(true);

    // open the drawer and sell: every main-API request carries the same device with the fix
    await page.fill('#so-cash', '500000');
    await page.click('#so-ok');
    await expect(page.locator('#gate')).toBeHidden();
    await H.addItem(page, 'tasbih');
    await H.pay(page);
    await page.click('#pay-ok');
    await expect(page.locator('#rc-modal #receipt')).toBeVisible();
    const after = (await log(page)).filter(e => e.user === 'Siti' && e.at >= ping.at && e.action !== 'users');
    expect(after.map(e => e.action)).toEqual(expect.arrayContaining(['open_shift', 'save_sale']));
    for (const e of after) {
      expect(e.device, e.action).toMatchObject({ id, app: 'kasir', loc_status: 'granted' });
      expect(near(e.device.lat, POS.latitude), e.action).toBe(true);
    }
    // the server writes the row (only when something changed) and logs the first time it sees the device
    const db = await H.getDb(page);
    const row = db.devices.find(d => d.device_id === id);
    expect(row).toMatchObject({ user: 'Siti', role: 'kasir', app: 'kasir', label: 'Linux · Chrome', loc_status: 'granted', acc: 20 });
    expect(near(row.lat, POS.latitude)).toBe(true);
    expect(row.pings).toBeGreaterThanOrEqual(2);
    const act = db.activity.filter(a => a.kind === 'perangkat_baru' && a.ref === id);
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ user: 'Siti', role: 'kasir', level: 'info' });
    expect(act[0].summary).toContain('Linux · Chrome (kasir, Siti)');

    // reopen: not asked again, same id, a new device_ping on open
    await page.click('#rc-new');
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping').length).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#dev-consent')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('kpos.device_id'))).toBe(id);
    expect((await log(page)).find(e => e.action === 'device_ping').device.id).toBe(id);

    // every 30 min while visible and idle: device_ping; not when another request was just sent
    const n0 = (await log(page)).filter(e => e.action === 'device_ping').length;
    await page.evaluate(() => window.KASIR.devTick());
    await page.waitForTimeout(300);
    expect((await log(page)).filter(e => e.action === 'device_ping').length).toBe(n0);
    await page.evaluate(() => { window.KASIR.DEV.lastMain = Date.now() - 31 * 60000; window.KASIR.devTick(); });
    await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping').length).toBe(n0 + 1);
  });

  test('Arabic notice; "Tidak" is remembered: no location, loc_status off, no 📍', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('kpos.mock.lang', JSON.stringify('ar')));
    await H.login(page, 'Siti', '1111', { devConsent: null, openShift: false });
    await expect(page.locator('#dev-consent')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#dev-consent')).toContainText('يُشارَك موقع هذا الجهاز مع مالك المتجر');
    await H.shot(page, 'phone-35-device-consent-ar');
    await page.click('#dev-no');
    await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping').length).toBe(1);
    const ping = (await log(page)).find(e => e.action === 'device_ping');
    expect(ping.device.loc_status).toBe('off');
    expect(ping.device.lat).toBeUndefined();
    await expect(page.locator('#tb-loc')).toBeHidden();
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('kpos.device_consent'))).ok).toBe(false);
    await page.reload();
    await expect(page.locator('#gate #shift-open')).toBeVisible();
    await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping').length).toBe(1);
    await expect(page.locator('#dev-consent')).toHaveCount(0);
  });

  test('device labels from the user agent', async ({ page }) => {
    await H.openKasir(page);
    const labels = await page.evaluate(() => [
      'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
      'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    ].map(ua => window.KASIR.deviceLabel(ua)));
    expect(labels).toEqual(['Android · Chrome', 'iPhone · Safari', 'Windows · Edge', 'Android · Samsung Internet', 'Mac · Safari']);
  });
});

test.describe('location required by the owner', () => {
  test.use({ ...H.PHONE, permissions: ['clipboard-read', 'clipboard-write'] });

  test('require_device_location blocks kasir and manager until location works; the owner is never blocked', async ({ page, context }) => {
    await H.openKasir(page, '', { devConsent: null });
    await H.setDb(page, 'db.settings.require_device_location = true;');
    await H.login(page, 'Siti', '1111', { noGoto: true, openShift: false });
    await page.click('#dev-no');
    const block = page.locator('#locblock #loc-required');
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute('data-status', 'off');
    await expect(block).toContainText('Lokasi wajib aktif');
    await expect(block).toContainText('Lokasi perangkat ini dibagikan ke pemilik toko');
    await expect(page.locator('#lb-allow')).toHaveText('Izinkan lokasi');
    // the browser allows it now → "Izinkan lokasi" (= Setuju) → unblocked, location sent
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation(POS);
    await page.click('#lb-allow');
    await expect(page.locator('#locblock')).toBeHidden();
    await expect(page.locator('#tb-loc')).toBeVisible();
    await expect(page.locator('#gate #shift-open')).toBeVisible();
    const last = (await log(page)).filter(e => e.action === 'device_ping').pop();
    expect(last.device.loc_status).toBe('granted');
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('kpos.device_consent'))).ok).toBe(true);

    // location refused by the browser: the manager is blocked (status "denied" + how to allow it), the owner is not
    await context.clearPermissions();
    const p2 = await context.newPage();
    await p2.addInitScript(() => { localStorage.removeItem('kpos.mock.kasir.session'); });
    await H.login(p2, 'Jihan', '2222');
    await expect(p2.locator('#locblock #loc-required')).toHaveAttribute('data-status', 'denied');
    await expect(p2.locator('#lb-why')).toContainText('pengaturan situs');
    const p3 = await context.newPage();
    await p3.addInitScript(() => { localStorage.removeItem('kpos.mock.kasir.session'); });
    await H.login(p3, 'Pemilik', '1234');
    await expect.poll(async () => (await log(p3)).filter(e => e.action === 'device_ping').length).toBeGreaterThanOrEqual(1);
    expect((await log(p3)).find(e => e.action === 'device_ping').device.loc_status).toBe('denied');
    await expect(p3.locator('#locblock')).toBeHidden();
    await expect(p3.locator('#grid .pc').first()).toBeVisible();
  });
});
