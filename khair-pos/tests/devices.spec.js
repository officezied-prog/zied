// v11 Devices: consent, device on every request, ping, owner map/list, manager blocked when location is required.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, nav, asUser, blockMapNetwork, typePin } = require('./helpers');

const CTX = { viewport: { width: 1366, height: 768 }, serviceWorkers: 'block', locale: 'id-ID', timezoneId: 'Asia/Jakarta' };
const HERE = { latitude: -6.27640, longitude: 106.85790, accuracy: 15 };
const deviceRow = async (page, id) => (await getDb(page)).devices.find(d => d.device_id === id);
/** Records every request body the app sends to the mock backend. */
const spyRequests = page => page.evaluate(() => { window.__bodies = []; const orig = MockServer.request; MockServer.request = (b, o) => { window.__bodies.push(JSON.parse(JSON.stringify(b))); return orig(b, o); }; });

test('consent bar → location shared; every request carries the device; ping on open and after 30 idle minutes', async ({ browser }) => {
  const ctx = await browser.newContext(Object.assign({ geolocation: HERE, permissions: ['geolocation'] }, CTX));
  const page = await ctx.newPage();
  await blockMapNetwork(page);
  await login(page, 'Pemilik', '1234', '', { consent: null, stay: true });
  await expect(page.locator('#dev-consent')).toBeVisible();
  await expect(page.locator('#dev-consent-text')).toContainText('Lokasi perangkat ini dibagikan ke pemilik toko selama aplikasi dibuka');
  const id = await page.evaluate(() => localStorage.getItem('kpos.device_id'));
  expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  // before consent the device is known, without a location
  await expect.poll(async () => (await deviceRow(page, id) || {}).loc_status).toBe('prompt');
  const r0 = await deviceRow(page, id);
  expect(r0).toMatchObject({ user: 'Pemilik', role: 'owner', app: 'owner', lat: 0 });
  expect(r0.label).toMatch(/^(Linux|Windows|Mac|Android|iPhone|iPad|Chromebook|Perangkat) · /);
  expect((await getDb(page)).activity.some(a => a.kind === 'perangkat_baru' && a.ref === id)).toBe(true);

  await page.click('#dev-consent-yes');
  await expect(page.locator('#dev-consent')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('kpos.loc_consent'))).toBe('yes');
  await expect.poll(async () => (await deviceRow(page, id)).loc_status).toBe('granted');
  const r1 = await deviceRow(page, id);
  expect(r1.lat).toBeCloseTo(HERE.latitude, 5);
  expect(r1.lng).toBeCloseTo(HERE.longitude, 5);
  expect(r1.acc).toBe(15);

  // every request carries data.device with the latest fix
  await spyRequests(page);
  await nav(page, 'customers');
  await page.evaluate(async () => { await refreshData(true); await api('get_sales', { from: today(), to: today() }); });
  const bodies = await page.evaluate(() => window.__bodies);
  expect(bodies.length).toBeGreaterThan(1);
  for (const b of bodies) expect(b.data.device).toMatchObject({ id, app: 'owner', loc_status: 'granted', lat: HERE.latitude, lng: HERE.longitude, acc: 15 });

  // ping: not while requests are flowing; after 30 minutes without any request it is sent (forced write)
  expect(await page.evaluate(() => KPOS.devicePingTick(Date.now()))).toBe(false);
  const pings = r1.pings;
  expect(await page.evaluate(() => KPOS.devicePingTick(Date.now() + 31 * 60000))).toBe(true);
  await expect.poll(async () => (await deviceRow(page, id)).pings).toBeGreaterThan(pings);
  expect((await page.evaluate(() => window.__bodies)).some(b => b.action === 'device_ping' && b.data.device.id === id)).toBe(true);
  // the label from the user agent
  expect(await page.evaluate(() => [KPOS.deviceLabel('Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36', 5), KPOS.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 5), KPOS.deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0', 0), KPOS.deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 0)]))
    .toEqual(['Android · Chrome', 'iPhone · Safari', 'Windows · Edge', 'Mac · Chrome']);
  // the id survives a logout
  await page.evaluate(() => logoutStore());
  expect(await page.evaluate(() => localStorage.getItem('kpos.device_id'))).toBe(id);
  await ctx.close();
});

test('owner: Perangkat map (SVG fallback) + list: active, outside the shop, approximate computer, denied; detail opens Google Maps', async ({ browser }) => {
  const ctx = await browser.newContext(Object.assign({ geolocation: HERE, permissions: ['geolocation'] }, CTX));
  const page = await ctx.newPage();
  await blockMapNetwork(page);
  await login(page, 'Pemilik', '1234', '', { consent: 'yes', stay: true });
  await nav(page, 'devices');
  await expect(page.locator('#dv-map')).toHaveAttribute('data-mode', 'svg');
  const db = await getDb(page);
  await expect(page.locator('#dv-table tbody tr[data-dev]')).toHaveCount(db.devices.length);
  await expect(page.locator('#dv-svg [data-store]')).toHaveCount(1);
  const row = id => page.locator(`#dv-table tr[data-dev="${id}"]`);
  await expect(row('dKSR8R5P2YB7RINA02').locator('[data-away]')).toBeVisible(); // Rina, kasir, ~620 m away, active
  await expect(row('dKSR7Q2M9XA4SITI01').locator('[data-active]')).toBeVisible();
  await expect(row('dKSR7Q2M9XA4SITI01').locator('[data-away]')).toHaveCount(0);
  await expect(row('dOWN6W4C8QF3PEMIL6').locator('[data-approx]')).toBeVisible(); // computer, ±1500 m
  await expect(row('dOWN6W4C8QF3PEMIL6').locator('[data-ago]')).toContainText(/\d+ mnt lalu/);
  await expect(row('dMGR9T2V6MD8JIHAN4').locator('[data-loc="denied"]')).toBeVisible();
  await expect(row('dSLS4H8N3PE6AHMAD5')).toContainText('Sales');
  await expect(page.locator('[data-kpi="dv-away"] .v')).toHaveText('1');
  // filters
  await page.click('#dv-apps [data-app="kasir"]');
  await expect(page.locator('#dv-table tbody tr[data-dev]')).toHaveCount(db.devices.filter(d => d.app === 'kasir').length);
  await page.click('#dv-apps [data-app=""]');
  await page.click('#dv-act [data-v="1"]');
  await expect(row('dMGR9T2V6MD8JIHAN4')).toHaveCount(0);
  await page.click('#dv-act [data-v="0"]');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-devices.png') });
  await row('dKSR8R5P2YB7RINA02').click();
  await expect(page.locator('#dv-detail')).toContainText('Rina');
  await expect(page.locator('#dv-gmaps')).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\?q=-6\.28/);
  await ctx.close();
});

test('phone + Arabic: Perangkat screen', async ({ browser }) => {
  const ctx = await browser.newContext(Object.assign({}, CTX, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }));
  const page = await ctx.newPage();
  await blockMapNetwork(page);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.click('#tb-lang');
  await nav(page, 'devices');
  await expect(page.locator('#view-devices h1')).toHaveText('الأجهزة');
  await expect(page.locator('#dv-map')).toHaveAttribute('data-mode', 'svg');
  await page.screenshot({ path: path.join(SHOTS, 'phone-devices-ar.png'), fullPage: false });
  await ctx.close();
});

test('"Tidak" sends loc_status denied and never asks the browser; the manager cannot open Perangkat', async ({ browser }) => {
  const ctx = await browser.newContext(CTX);
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.__geoCalls = 0; const g = navigator.geolocation; if (g) { const w = g.watchPosition.bind(g), c = g.getCurrentPosition.bind(g); g.watchPosition = (...a) => { window.__geoCalls++; return w(...a); }; g.getCurrentPosition = (...a) => { window.__geoCalls++; return c(...a); }; } });
  await login(page, 'Jihan', '2222', '', { consent: null, stay: true });
  await expect(page.locator('#dev-consent')).toBeVisible();
  await page.click('#dev-consent-no');
  await expect(page.locator('#dev-consent')).toBeHidden();
  const id = await page.evaluate(() => localStorage.getItem('kpos.device_id'));
  await expect.poll(async () => (await deviceRow(page, id) || {}).loc_status).toBe('denied');
  expect((await deviceRow(page, id)).role).toBe('manager');
  expect(await page.evaluate(() => window.__geoCalls)).toBe(0);
  await expect(page.locator('#nav [data-view="devices"]')).toHaveCount(0);
  await expect(page.locator('#nav [data-view="activity"]')).toHaveCount(0);
  await page.evaluate(() => go('devices'));
  await expect(page.locator('#view-pos')).toBeVisible();
  expect((await asUser(page, 'Jihan', '2222', 'list_devices')).error).toBe('FORBIDDEN');
  await ctx.close();
});

test('Pengaturan: shop location + "Wajibkan lokasi" → the manager sees a blocking screen until location is allowed', async ({ browser }) => {
  const ctx = await browser.newContext(CTX);
  const page = await ctx.newPage();
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await page.fill('#st-lat', '-6,2770');
  await page.fill('#st-lng', '106.8580');
  await page.check('#st-req-loc');
  await page.click('[data-act="set-save-loc"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  expect((await getDb(page)).settings).toMatchObject({ store_lat: -6.277, store_lng: 106.858, require_device_location: true });
  // the owner himself is never blocked
  await expect(page.locator('#dev-block')).toBeHidden();
  // the manager logs in on this device (consent "Tidak" earlier) → blocked
  await page.click('#tb-lock');
  await page.click('[data-act="login-user"][data-name="Jihan"]');
  await typePin(page, '2222');
  await expect(page.locator('#dev-block-card')).toBeVisible();
  await expect(page.locator('#dev-block-card')).toContainText('Lokasi perangkat wajib');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-device-required.png') });
  await ctx.grantPermissions(['geolocation']);
  await ctx.setGeolocation(HERE);
  await page.click('#dev-allow');
  await expect(page.locator('#dev-block')).toBeHidden();
  expect(await page.evaluate(() => KPOS.DEV.status)).toBe('granted');
  await ctx.close();
});
