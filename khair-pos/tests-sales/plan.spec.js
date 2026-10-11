// v31 (owner 2026-10-11): the rep plans the day BEFORE setting off — start point, shops along a street / by name from the
// free OpenStreetMap search (answered here with fixed data), ordered stops, saved for tomorrow / today. The Today card
// shows the next stop + Google Maps, and "Kunjungi" on a new place opens the new-shop form already filled in.
const H = require('./helpers');
const { test, expect } = H;

const NOMI = [
  { place_id: 1, osm_type: 'way', osm_id: 111, lat: '-6.2731', lon: '106.8582', category: 'highway', type: 'primary', name: 'Jalan Raya Condet', display_name: 'Jalan Raya Condet, Balekambang, Kramat Jati',
    address: { road: 'Jalan Raya Condet', suburb: 'Balekambang', city_district: 'Kramat Jati' }, boundingbox: ['-6.2850', '-6.2650', '106.8560', '106.8600'] },
  { place_id: 2, osm_type: 'node', osm_id: 222, lat: '-6.2740', lon: '106.8590', category: 'shop', type: 'convenience', name: 'Indomaret Condet', display_name: 'Indomaret Condet',
    address: { road: 'Jalan Raya Condet', house_number: '12', suburb: 'Balekambang' }, boundingbox: ['-6.2741', '-6.2739', '106.8589', '106.8591'] }];
const OVER = { elements: [
  { type: 'way', id: 111, tags: { highway: 'primary', name: 'Jalan Raya Condet' }, geometry: [{ lat: -6.2850, lon: 106.8570 }, { lat: -6.2731, lon: 106.8582 }, { lat: -6.2650, lon: 106.8595 }] },
  { type: 'node', id: 301, lat: -6.2800, lon: 106.8578, tags: { shop: 'convenience', name: 'Alfamart Condet' } },
  { type: 'node', id: 302, lat: -6.2760, lon: 106.8585, tags: { shop: 'general', name: 'Warung Bu Sri', 'addr:street': 'Jalan Raya Condet', 'addr:housenumber': '40' } },
  { type: 'node', id: 303, lat: -6.2700, lon: 106.8590, tags: { shop: 'convenience' } },
  { type: 'way', id: 304, center: { lat: -6.2680, lon: 106.8592 }, tags: { amenity: 'place_of_worship', religion: 'muslim', name: 'Masjid Al-Hidayah' } }] };
const CORS = { 'access-control-allow-origin': '*' };

test('route plan: street → shops along it → saved for tomorrow; a searched shop planned for today → "Kunjungi" opens the new-shop form filled in', async ({ page, context }) => {
  const seen = { nomi: '', over: '' };
  await context.route(/nominatim\.openstreetmap\.org/, r => { seen.nomi = r.request().url(); r.fulfill({ json: NOMI, headers: CORS }); });
  await context.route(/overpass/, r => { seen.over = decodeURIComponent((r.request().postData() || '').replace(/^data=/, '')); r.fulfill({ json: OVER, headers: CORS }); });
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  await H.login(page);
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await expect(page.locator('#plan-card #pl-hint')).toBeVisible();

  // tomorrow: start = my position; street search → the shops along that street
  await page.click('#pl-open-tomorrow');
  await expect(page.locator('#pl-nomap')).toBeVisible(); // this suite blocks the map library: planning still works from the lists
  await page.click('#pl-mypos');
  await expect(page.locator('#pl-start')).toHaveAttribute('data-set', '1');
  await page.fill('#pl-q', 'Jalan Raya Condet');
  await page.click('#pl-go');
  await expect(page.locator('#pl-results .pl-res[data-kind="street"]')).toHaveCount(1);
  expect(seen.nomi).toMatch(/countrycodes=id/);
  await page.click('#pl-results .pl-res[data-kind="street"] [data-act="pl-work"]'); // the street goes into the plan + its shops are listed
  await expect(page.locator('#pl-street')).toContainText('Jalan Raya Condet');
  await expect(page.locator('#pl-results .pl-res')).toHaveCount(4);
  expect(seen.over).toContain('"name"="Jalan Raya Condet"');
  expect(seen.over).toContain('around.s:60');
  await H.shot(page, 'plan-along-street');
  await page.click('#pl-add-all');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-stops .pl-stop')).toHaveCount(3); // "add all" takes the named places only
  await expect(page.locator('#pl-stops .pl-stop').first()).toContainText('Warung Bu Sri'); // nearest first from the start
  await page.click('#pl-save');
  await expect(page.locator('#pl-tomorrow')).toContainText('3');

  // today: one searched shop → Today card → Kunjungi = the new-shop form, already filled in
  await page.click('#pl-open-today');
  await page.fill('#pl-q', 'Indomaret Condet');
  await page.click('#pl-go');
  await page.click('#pl-results .pl-res[data-kind="poi"] [data-act="pl-toggle"]');
  await page.click('#pl-save');
  await expect(page.locator('#pl-prog')).toHaveAttribute('data-n', '1');
  await expect(page.locator('#pl-next')).toContainText('Indomaret Condet');
  await expect(page.locator('#pl-nav')).toHaveAttribute('href', /google\.com\/maps\/dir\/\?api=1&destination=-6\.274/);
  await H.shot(page, 'plan-today-card');
  await page.click('#pl-visit');
  await expect(page.locator('#ci-name')).toHaveValue('Indomaret Condet');
  await expect(page.locator('#tp-sel')).toHaveAttribute('data-type', 'minimarket');

  // both plans reached the server (mock) and the phone copies are no longer pending
  await expect.poll(async () => ((await H.getDb(page)).route_plans || []).length).toBe(2);
  const db = await H.getDb(page);
  expect(db.route_plans.map(p => p.stops.length).sort()).toEqual([1, 3]);
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.sales.plans.ahmad') || '{}'));
  expect(Object.values(local).every(p => p.dirty === false)).toBe(true);
});

test('route plan: work streets + finish point; a street another rep already worked is shown and warned about', async ({ page, context }) => {
  await context.route(/nominatim\.openstreetmap\.org/, r => r.fulfill({ json: NOMI, headers: CORS }));
  await context.route(/overpass/, r => r.fulfill({ json: OVER, headers: CORS }));
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  const d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(d.getUTCDate() - 1); const yday = d.toISOString().slice(0, 10);
  await H.openSales(page);
  // yesterday another rep (Budi) worked Jalan Raya Condet
  await H.setDb(page, `db.route_plans = db.route_plans || []; db.route_plans.push({ plan_id: 'RPB', user: 'Budi', plan_date: '${yday}', start: null, end: null, stops: [], note: '',
    streets: [{ ref: 'st:jalan raya condet', name: 'Jalan Raya Condet', lines: [[[-6.285, 106.857], [-6.2731, 106.8582], [-6.265, 106.8595]]] }], updated_at: '' });`);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');

  await page.click('#pl-open-today');
  await page.click('#pl-mypos');
  await page.click('#pl-end-same');
  await expect(page.locator('#pl-end')).toHaveAttribute('data-set', '1');
  await page.fill('#pl-q', 'Jalan Raya Condet');
  await page.click('#pl-go');
  const street = page.locator('#pl-results .pl-res[data-kind="street"]');
  await expect(street.locator('[data-worked]')).toContainText('Budi'); // shown before the rep picks it
  await street.locator('[data-act="pl-work"]').click();
  await expect(page.locator('.toast').filter({ hasText: 'Budi' })).toBeVisible();
  await expect(page.locator('#pl-results .pl-res')).toHaveCount(4); // the shops along the whole street
  await page.click('#pl-results .pl-res >> nth=0 >> [data-act="pl-toggle"]');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-streets .pl-street')).toHaveCount(1);
  await expect(page.locator('#pl-streets [data-worked]')).toContainText('Budi');
  await H.shot(page, 'plan-streets');
  await page.click('#pl-save');
  await expect(page.locator('#pl-card-streets')).toContainText('Jalan Raya Condet');
  await expect(page.locator('#pl-card-end')).toBeVisible();

  await expect.poll(async () => ((await H.getDb(page)).route_plans || []).filter(p => p.user === 'Ahmad').length).toBe(1); // sent in the background
  const db = await H.getDb(page);
  const mine = db.route_plans.find(p => p.user === 'Ahmad');
  expect(mine.end).toBeTruthy();
  expect(mine.streets[0].name).toBe('Jalan Raya Condet');
  expect(mine.streets[0].lines[0].length).toBeGreaterThan(1); // the street's line is kept, so the next rep sees it
});
