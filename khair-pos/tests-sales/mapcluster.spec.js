// v32 (owner 2026-10-11: "split the map by how crowded it is, so it is not heavy"): with many shops, a crowded area is ONE
// bubble with its count; tapping it zooms in and splits it; only what is in view is drawn.
const H = require('./helpers'); const { test, expect } = H;

test('a crowded map groups the shops into count bubbles; tapping one zooms in and splits it', async ({ page, context }) => {
  await page.route(/\/vendor\/leaflet\//, r => r.continue()); // this test needs the map library…
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  await page.route(/tile\.openstreetmap\.org/, r => r.fulfill({ body: PNG, contentType: 'image/png' })); // …and blank tiles (else it falls back to the simple map)
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2655, 106.8605);
  await H.openSales(page);
  // 600 shops spread over ~4 km around the store
  await H.setDb(page, `db.shops = db.shops || []; for (let i = 0; i < 600; i++) db.shops.push({ shop_id: 'SX' + i, name: 'Toko Uji ' + i, owner_name: '', phone: '', address: '', area: 'Uji', type: i % 3 ? 'toko' : 'toko_kurma',
    type_other: '', chain: '', lat: -6.2655 + ((i * 7919) % 400 - 200) / 10000, lng: 106.8605 + ((i * 104729) % 400 - 200) / 10000, created_by: 'Ahmad', created_at: '', last_visit_at: '', visits: 0, status: 'prospek', customer_id: 0, next_visit: '' });`);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await page.click('#map-expand');
  const map = page.locator('#full-map');
  await expect(map.locator('.clu').first()).toBeVisible();
  const bubbles = await map.locator('.clu').count();
  const inBubbles = (await map.locator('.clu').evaluateAll(b => b.map(x => +x.dataset.n))).reduce((a, n) => a + n, 0);
  const dots = await map.locator('path.leaflet-interactive').count();
  expect(bubbles).toBeGreaterThan(0);
  expect(dots).toBeLessThan(200); // far fewer drawn things than 600 shops
  expect(inBubbles).toBeGreaterThan(300);
  await H.shot(page, 'map-clusters');
  await map.locator('.clu').first().click();
  await expect.poll(async () => (await map.locator('.clu').evaluateAll(b => b.map(x => +x.dataset.n))).reduce((a, n) => a + n, 0)).toBeLessThan(inBubbles); // zoomed in: bubbles split up
});
