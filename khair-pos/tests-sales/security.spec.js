// Security fixes: shop names are text in map tooltips (Leaflet tooltips are HTML), the store key is never shown in full,
// no usable PIN hash is kept in localStorage, idle auto-lock.
const H = require('./helpers'); const { test, expect } = H;

const EVIL = '<img src=x onerror=window.__xss=1>';
/** Stand-in for Leaflet (the CDN is blocked in tests) that, like Leaflet, puts tooltip strings in with innerHTML. */
const fakeLeaflet = () => {
  const chain = { addTo() { return this; }, on() { return this; } };
  window.L = {
    // v32: the map draws shops through a density layer (zoom / bounds / layer groups) — at zoom 18 every shop is drawn
    map: () => ({ fitBounds() { }, setView() { }, remove() { }, on() { return this; }, whenReady(f) { f(); }, getZoom: () => 18, _loaded: true,
      getBounds: () => ({ pad() { return this; }, contains: () => true }), project: () => ({ x: 0, y: 0 }) }),
    layerGroup: () => Object.assign(Object.create(chain), { clearLayers() { } }), marker: () => Object.create(chain), divIcon: () => ({}),
    tileLayer: () => Object.create(chain), polyline: () => Object.create(chain),
    circleMarker: () => Object.assign(Object.create(chain), { bindTooltip(html) { const d = document.createElement('div'); d.className = 'fake-tip'; d.innerHTML = html; document.body.appendChild(d); return this; } })
  };
};

test('C1: a shop name / type with HTML shows as text in the map tooltip, nothing runs', async ({ page }) => {
  await page.addInitScript(fakeLeaflet);
  await H.login(page, 'Ahmad', '4444');
  await H.setDb(page, `const s = db.shops.find(x => x.created_by === 'Ahmad' && x.lat) || db.shops.find(x => x.lat); s.name = ${JSON.stringify(EVIL)}; s.type = 'lainnya'; s.type_other = '<b onmouseover=window.__xss=2>x</b>'; s.chain = '<svg onload=window.__xss=3>';`);
  await page.reload();
  await expect(page.locator('#v-today .hero')).toBeVisible();
  await H.tab(page, 'shops');
  await page.click('#sh-map-btn');
  await expect(page.locator('#shops-map')).toHaveAttribute('data-mode', 'leaflet');
  const tip = page.locator('.fake-tip', { hasText: '<img src=x' });
  await expect(tip).toHaveCount(1);
  await expect(tip).toContainText(EVIL);
  await expect(page.locator('.fake-tip img, .fake-tip svg, .fake-tip b')).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  // the shop list shows it as text too
  await expect(page.locator('#sh-list')).toContainText(EVIL);
});

test('store key masked; pins keep a verifier only; the session hash lives in this tab and is wiped on lock', async ({ page }) => {
  // an old device: a reusable hash in the pins and in the stored session
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('kpos.mock.pins', JSON.stringify({ pemilik: { h: 'a'.repeat(64), role: 'owner' } }));
  });
  await H.login(page, 'Ahmad', '4444');
  const st = await page.evaluate(() => ({ pins: JSON.parse(localStorage.getItem('kpos.mock.pins')), ls: JSON.parse(localStorage.getItem('kpos.mock.sales.session')), ss: JSON.parse(sessionStorage.getItem('kpos.mock.sales.session')) }));
  expect(st.pins.pemilik.h).toBeUndefined();
  expect(st.pins.pemilik.o).toMatch(/^[0-9a-f]{64}$/);
  expect(st.pins.ahmad.h).toBeUndefined();
  expect(st.pins.ahmad.o).toMatch(/^[0-9a-f]{64}$/);
  expect(st.ls).toEqual({ user: 'Ahmad', role: 'sales' });
  expect(st.ss.pin_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(st.pins.ahmad.o).not.toBe(st.ss.pin_hash);
  // nothing of the app (the mock server's own tables in kmock.db aside) keeps the hash
  expect(JSON.stringify(await page.evaluate(() => Object.keys(localStorage).filter(k => !k.startsWith('kmock.')).map(k => localStorage.getItem(k))))).not.toContain(st.ss.pin_hash);
  // reload keeps the session (same tab)
  await page.reload();
  await expect(page.locator('#v-today .hero')).toBeVisible();
  // idle auto-lock (settings.auto_lock_minutes, default 10)
  await page.evaluate(() => { window.SALES.S.lastActivity = Date.now() - 11 * 60000; });
  await expect(page.locator('#pin-who')).toHaveText('Ahmad', { timeout: 8000 });
  expect(await page.evaluate(() => sessionStorage.getItem('kpos.mock.sales.session'))).toBeNull();
  // the change-key button never shows the whole key
  await page.locator('[data-act="login-back"]').first().click();
  await expect(page.locator('[data-act="login-change-key"]')).toContainText('(••••demo)');
});
