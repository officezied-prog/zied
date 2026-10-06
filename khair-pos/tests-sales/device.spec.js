// v11 devices in Khair Sales: the rep's work-location consent covers the device line (asked once), device_ping with the
// rep's location on open (main API), field requests carry no device, and the sales app is never blocked.
const H = require('./helpers'); const { test, expect } = H;

const log = page => page.evaluate(() => window.SALES.mockLog());
const near = (a, b) => Math.abs(a - b) < 1e-5;

test('a new rep: one consent at open (work location + this device) → device_ping with the location; no second consent at Mulai kerja', async ({ page }) => {
  await H.login(page, 'Ahmad', '4444', { devConsent: null });
  const c = page.locator('#consent');
  await expect(c).toBeVisible();
  await expect(c).toContainText('HANYA saat jam kerja');
  await expect(page.locator('#consent-device')).toContainText('lokasi perangkat ini dibagikan ke pemilik toko selama aplikasi dibuka (keamanan & absensi)');
  await expect(page.locator('#dev-consent')).toHaveCount(0);
  await H.shot(page, 'phone-28-consent-device');
  await page.click('#consent-ok');
  await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping' && e.device && e.device.loc_status === 'granted').length).toBeGreaterThanOrEqual(1);
  const ping = (await log(page)).find(e => e.action === 'device_ping' && e.device.loc_status === 'granted');
  expect(ping.device).toMatchObject({ app: 'sales', label: 'Linux · Chrome', acc: 12 });
  expect(near(ping.device.lat, H.STORE.latitude) && near(ping.device.lng, H.STORE.longitude)).toBe(true);
  expect(ping.device.id).toBe(await page.evaluate(() => localStorage.getItem('kpos.device_id')));
  await expect(page.locator('#tb-loc')).toBeVisible();
  // field requests go to the field workflow: no device there; the main API (login, device_ping) has it
  const L = await log(page);
  expect(L.filter(e => ['field_bootstrap', 'product_images'].includes(e.action)).every(e => e.device === null)).toBe(true);
  expect(L.filter(e => e.action === 'login').every(e => e.device && e.device.app === 'sales')).toBe(true);
  let db = await H.getDb(page);
  const row = db.devices.find(d => d.device_id === ping.device.id);
  expect(row).toMatchObject({ user: 'Ahmad', role: 'sales', app: 'sales', loc_status: 'granted' });
  expect(db.activity.find(a => a.kind === 'perangkat_baru' && a.ref === ping.device.id)).toMatchObject({ user: 'Ahmad', role: 'sales' });

  // Mulai kerja: already consented, not asked again; the work indicator replaces the small 📍
  await page.click('#day-start');
  await expect(page.locator('#day-card[data-status="working"]')).toBeVisible();
  await expect(page.locator('#consent')).toHaveCount(0);
  await expect(page.locator('#tb-gps')).toBeVisible();
  await expect(page.locator('#tb-loc')).toBeHidden();

  // reopen: no notice at all, a new device_ping on open; every 30 min when idle
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping').length).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#consent, #dev-consent')).toHaveCount(0);
  const n0 = (await log(page)).filter(e => e.action === 'device_ping').length;
  await page.evaluate(() => { window.SALES.DEV.lastMain = Date.now() - 31 * 60000; window.SALES.devTick(); });
  await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping').length).toBe(n0 + 1);
});

test('a rep who already gave the work-location consent is not asked anything: device_ping carries the location', async ({ page, context }) => {
  await H.setPos(context, -6.2601, 106.8612, 9);
  await page.addInitScript(() => localStorage.setItem('kpos.mock.sales.consent.ahmad', JSON.stringify({ at: new Date().toISOString(), version: 1 })));
  await H.login(page, 'Ahmad', '4444', { devConsent: null });
  await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping' && e.device.loc_status === 'granted').length).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#consent, #dev-consent')).toHaveCount(0);
  const ping = (await log(page)).find(e => e.action === 'device_ping' && e.device.loc_status === 'granted');
  expect(near(ping.device.lat, -6.2601) && near(ping.device.lng, 106.8612)).toBe(true);
  expect(ping.device.acc).toBe(9);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('kpos.device_consent'))).ok).toBe(true);
});

test('owner in the sales app: the short device notice; "Tidak" → loc_status off, never blocked even when location is required', async ({ page }) => {
  await H.openSales(page, '', { devConsent: null });
  await H.setDb(page, 'db.settings.require_device_location = true;');
  await H.login(page, 'Pemilik', '1234', { noGoto: true });
  await expect(page.locator('#dev-consent')).toContainText('Lokasi perangkat ini dibagikan ke pemilik toko selama aplikasi dibuka');
  await page.click('#dev-no');
  await expect.poll(async () => (await log(page)).filter(e => e.action === 'device_ping').length).toBe(1);
  expect((await log(page)).find(e => e.action === 'device_ping').device.loc_status).toBe('off');
  await H.tab(page, 'shops');
  await expect(page.locator('#sh-list .shop-li').first()).toBeVisible();
  await expect(page.locator('#tb-loc')).toBeHidden();
});
