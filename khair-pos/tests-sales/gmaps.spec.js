// v33 (owner 2026-10-11): shops of a street from GOOGLE MAPS, free. (1) The office sends the rep a list → it goes straight
// into his plan for that day (street + stops; a place without a position waits in "no point yet"). (2) The rep pastes what he
// copied in Google Maps, or shares a place to the app (Google Maps → Share → Khair Sales), and each lands at its spot.
const H = require('./helpers');
const { test, expect } = H;
const CORS = { 'access-control-allow-origin': '*' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const tomorrow = () => { const d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

test('a shop list from the office goes straight into the plan of its day; a place without a position is found or put on the map', async ({ page, context }) => {
  await page.route(/\/vendor\/leaflet\//, r => r.continue()); // the map is needed to put a place on it
  await page.route(/tile\.openstreetmap\.org/, r => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await context.route(/nominatim\.openstreetmap\.org/, r => r.fulfill({ json: [], headers: CORS })); // the address is not found → the rep places it
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  await H.openSales(page);
  const T1 = tomorrow();
  await H.setDb(page, `db.shop_lists = db.shop_lists || []; db.shop_lists.push({ list_id: 'SLTEST1', from_user: 'Siti', from_role: 'kasir', to_user: 'Ahmad', plan_date: '${T1}', street: 'Jalan Raya Condet', note: '',
    status: 'sent', created_at: new Date().toISOString(), received_at: '', places: [
      { name: 'Toko Kurma Barokah', address: 'Jl. Raya Condet No.12', phone: '', url: '', lat: -6.27405, lng: 106.85834, type: '' },
      { name: 'Perlengkapan Haji Al-Amin', address: 'Jl. Raya Condet No.40', phone: '081234567890', url: '', lat: -6.27612, lng: 106.85871, type: '' },
      { name: 'Warung Tanpa Titik', address: 'Jl. Raya Condet No. 7', phone: '', url: '', lat: null, lng: null, type: '' }] });`);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await expect(page.locator('.toast').filter({ hasText: 'Siti' })).toBeVisible(); // "Siti sent 3 shops for Jalan Raya Condet → plan …"
  await expect(page.locator('#pl-tomorrow')).toContainText('2');
  await expect.poll(async () => ((await H.getDb(page)).shop_lists.find(l => l.list_id === 'SLTEST1') || {}).status).toBe('received');
  await expect.poll(async () => ((await H.getDb(page)).route_plans || []).filter(p => p.user === 'Ahmad' && p.plan_date === T1).length).toBe(1); // sent to the server
  let plan = (await H.getDb(page)).route_plans.find(p => p.user === 'Ahmad' && p.plan_date === T1);
  expect(plan.streets.map(x => x.name)).toEqual(['Jalan Raya Condet']);
  expect(plan.stops.map(s => s.name)).toEqual(['Toko Kurma Barokah', 'Perlengkapan Haji Al-Amin']);
  expect(plan.stops[1].phone).toBe('081234567890');

  // tomorrow's plan: the place without a position waits — the rep taps "on the map", then the map
  await page.click('#pl-tomorrow [data-act="plan-open"]');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-unplaced .pl-stop')).toHaveCount(1);
  await page.click('#pl-unplaced [data-act="pl-place"]');
  await expect(page.locator('#pl-placebar')).toContainText('Warung Tanpa Titik');
  const box = await page.locator('#pl-map').boundingBox();
  await page.locator('#pl-map').click({ position: { x: box.width / 2, y: box.height / 3 } });
  await expect(page.locator('#pl-unplaced')).toHaveCount(0);
  await expect(page.locator('#pl-stops .pl-stop')).toHaveCount(3);
  await page.click('#pl-save');
  await expect.poll(async () => ((await H.getDb(page)).route_plans.find(p => p.user === 'Ahmad' && p.plan_date === T1) || { stops: [] }).stops.length).toBe(3);
  // a second refresh does not add the same list again
  await page.reload();
  await expect(page.locator('#v-today .hero')).toBeVisible();
  await expect(page.locator('#pl-tomorrow')).toContainText('3');
});

test('the rep pastes places copied in Google Maps (links followed by the server) and shares one to the app', async ({ page, context }) => {
  await context.route(/nominatim\.openstreetmap\.org/, r => r.fulfill({ json: [{ place_id: 9, osm_type: 'node', osm_id: 9, lat: '-6.2771', lon: '106.8589', category: 'shop', type: 'convenience', name: 'Warung Bu Sri', display_name: 'Warung Bu Sri', address: {} }], headers: CORS }));
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  await H.openSales(page);
  await H.setDb(page, `db.gmaps_links = { 'https://maps.app.goo.gl/AbC123': 'https://www.google.com/maps/place/Toko+Kurma+Barokah/@-6.2741,106.8583,17z/data=!3d-6.27405!4d106.85834',
    'https://maps.app.goo.gl/Share1': 'https://www.google.com/maps/place/Toko+Oleh2+Haji/data=!3d-6.2790!4d106.8600' };`);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');

  await page.click('#pl-open-today');
  await page.click('#pl-mypos');
  await page.click('#pl-gm');
  await page.fill('#pl-gm-text', `Toko Kurma Barokah
Jl. Raya Condet No.12
https://maps.app.goo.gl/AbC123

Perlengkapan Haji Al-Amin
Toko perlengkapan haji · Jl. Raya Condet No.40
https://www.google.com/maps/place/Perlengkapan+Haji+Al-Amin/@-6.276,106.858,17z/data=!3d-6.27612!4d106.85871

Warung Bu Sri
Jl. Raya Condet No. 7`);
  await page.click('#pl-gm-read');
  await expect(page.locator('#pl-results .pl-res[data-src="gm"]')).toHaveCount(3); // short link → server; full link; address → OpenStreetMap
  await expect(page.locator('#pl-results .pl-res').first()).toContainText('Toko Kurma Barokah'); // nearest first from the start
  await H.shot(page, 'plan-gmaps-paste');
  await page.click('#pl-results .pl-res >> nth=1 >> [data-act="pl-toggle"]');
  await page.click('#pl-save');
  await expect.poll(async () => (((await H.getDb(page)).route_plans || []).find(p => p.user === 'Ahmad') || { stops: [] }).stops.map(s => s.src)).toEqual(['gm']);

  // Google Maps → Share → Khair Sales: the app opens with the shared place and keeps it for the planner
  await page.goto('sales/index.html?mock=1&share_title=' + encodeURIComponent('Toko Oleh2 Haji') + '&share_text=' + encodeURIComponent('Toko Oleh2 Haji\nJl. Raya Condet No.88') + '&share_url=' + encodeURIComponent('https://maps.app.goo.gl/Share1'));
  await expect(page.locator('.toast').filter({ hasText: 'Google Maps' })).toBeVisible();
  await expect(page).not.toHaveURL(/share_text/);
  await expect(page.locator('#v-today .hero')).toBeVisible();
  await page.click('#pl-open-today');
  await page.click('#pl-seg-search');
  await page.click('#pl-gm-inbox');
  await expect(page.locator('#pl-results .pl-res[data-src="gm"]')).toHaveCount(1);
  await expect(page.locator('#pl-results .pl-res')).toContainText('Toko Oleh2 Haji');
  await expect(page.locator('#pl-gm-inbox')).toHaveCount(0); // the inbox is emptied once taken
});
