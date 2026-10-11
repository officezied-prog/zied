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

// v32 (owner 2026-10-11): the rep draws his WORK LINE point by point (a shop there or not), then picks the kinds of shop he
// wants (dates, Hajj & Umrah, …) and the app searches along that line — each kind its own colour — and adds them as stops.
const OVER_LINE = { elements: [
  { type: 'node', id: 501, lat: -6.2745, lon: 106.8583, tags: { shop: 'convenience', name: 'Toko Kurma Al-Madinah' } },
  { type: 'node', id: 502, lat: -6.2770, lon: 106.8586, tags: { shop: 'clothes', name: 'Perlengkapan Haji & Umroh Barokah' } },
  { type: 'node', id: 503, lat: -6.2790, lon: 106.8589, tags: { shop: 'herbalist', name: 'Herbal Habbatussauda' } },
  { type: 'node', id: 504, lat: -6.2760, lon: 106.8584, tags: { shop: 'convenience', name: 'Indomaret Condet' } }, // a kind not ticked
  { type: 'node', id: 505, lat: -6.2780, lon: 106.8587, tags: { shop: 'convenience', name: 'Warung Madura' } },     // a kind not ticked
  { type: 'way', id: 506, tags: { highway: 'residential', name: 'Jalan Haji Ten' }, geometry: [{ lat: -6.2750, lon: 106.8590 }, { lat: -6.2751, lon: 106.8600 }] }] };

test('work line: drawn point by point → kinds of shop searched along it (own colour each) → stops; a line a colleague worked is warned', async ({ page, context }) => {
  const seen = { over: '' };
  await page.route(/\/vendor\/leaflet\//, r => r.continue()); // this test needs the map (tiles stay blocked)
  await context.route(/overpass/, r => { seen.over = decodeURIComponent((r.request().postData() || '').replace(/^data=/, '')); r.fulfill({ json: OVER_LINE, headers: CORS }); });
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  const d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(d.getUTCDate() - 3); const ago = d.toISOString().slice(0, 10);
  await H.openSales(page);
  // three days ago Budi worked (by a drawn line) the same stretch of road
  await H.setDb(page, `db.route_plans = db.route_plans || []; db.route_plans.push({ plan_id: 'RPB2', user: 'Budi', plan_date: '${ago}', start: null, end: null, stops: [], note: '',
    streets: [{ ref: 'ln:budi1', name: 'Garis Budi', drawn: true, lines: [[[-6.2735, 106.8580], [-6.2765, 106.8585], [-6.2795, 106.8590]]] }], updated_at: '' });`);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');

  await page.click('#pl-open-today');
  await expect(page.locator('#pl-map .leaflet-container, #pl-map.leaflet-container')).toHaveCount(1);
  await page.click('#pl-seg-line');
  await expect(page.locator('#pl-line-hint')).toBeVisible();
  await page.click('#pl-draw');
  await expect(page.locator('#pl-draw-n')).toHaveAttribute('data-n', '0');
  // a tap on the map = a point (no popup while drawing); undo takes it back
  const box = await page.locator('#pl-map').boundingBox();
  await page.locator('#pl-map').click({ position: { x: box.width / 2, y: box.height / 3 } });
  await expect(page.locator('#pl-draw-n')).toHaveAttribute('data-n', '1');
  await expect(page.locator('#pl-sel-start')).toHaveCount(0);
  await page.click('#pl-draw-undo');
  await expect(page.locator('#pl-draw-n')).toHaveAttribute('data-n', '0');
  // points along the road from the rep's position (start, then every few hundred metres)
  for (const [la, ln] of [[-6.2735, 106.8580], [-6.2765, 106.8585], [-6.2795, 106.8590]]) {
    const n = Number(await page.locator('#pl-draw-n').getAttribute('data-n'));
    await H.setPos(context, la, ln);
    await page.click('#pl-draw-pos');
    await expect(page.locator('#pl-draw-n')).toHaveAttribute('data-n', String(n + 1));
  }
  await page.fill('#pl-line-name', 'Condet utara');
  await page.click('#pl-draw-done');
  await expect(page.locator('#pl-drawbar-in')).toHaveCount(0);
  const line = page.locator('#pl-lines .pl-line[data-drawn="1"]');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('Condet utara');
  await expect(line.locator('[data-worked]')).toContainText('Budi'); // the same road a colleague already worked
  await expect(page.locator('.toast').filter({ hasText: 'Budi' })).toBeVisible();

  // the kinds the owner asked for are ticked by default: dates, Hajj & Umrah, Muslim goods
  await expect(page.locator('#pl-kinds .find-chip.on')).toHaveCount(3);
  await page.click('#pl-find-go');
  await expect(page.locator('#pl-found .pl-res')).toHaveCount(3);
  expect(seen.over).toContain('(around:100,-6.27350,106.85800,');
  expect(seen.over).toContain('"name"~"kurma');
  await expect(page.locator('#pl-found .pl-res').nth(0)).toHaveAttribute('data-cat', 'kurma'); // in order along the line
  await expect(page.locator('#pl-found .pl-res').nth(1)).toHaveAttribute('data-cat', 'haji');
  await expect(page.locator('#pl-found .pl-res').nth(2)).toHaveAttribute('data-cat', 'muslim');
  await expect(page.locator('#pl-found-legend .kbadge')).toHaveCount(3);
  // each kind its own colour on the map
  const fills = await page.locator('#pl-map path.leaflet-interactive').evaluateAll(ps => ps.map(p => p.getAttribute('fill')));
  expect(fills).toEqual(expect.arrayContaining(['#92400E', '#0F172A', '#7C3AED']));
  await H.shot(page, 'plan-work-line');
  // untick a kind → its places leave the list
  await page.click('#pl-kinds [data-k="muslim"]');
  await expect(page.locator('#pl-found .pl-res')).toHaveCount(2);
  await page.click('#pl-find-all');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-stops .pl-stop')).toHaveCount(2);
  await expect(page.locator('#pl-stops .pl-stop').first()).toHaveAttribute('data-cat', 'kurma');
  await expect(page.locator('#pl-streets .pl-street[data-drawn="1"]')).toHaveCount(1);
  await page.click('#pl-save');

  await expect.poll(async () => ((await H.getDb(page)).route_plans || []).filter(p => p.user === 'Ahmad').length).toBe(1);
  const mine = (await H.getDb(page)).route_plans.find(p => p.user === 'Ahmad');
  expect(mine.streets[0]).toMatchObject({ name: 'Condet utara', drawn: true });
  expect(mine.streets[0].lines[0].length).toBe(3);
  expect(mine.stops.map(s => s.cat)).toEqual(['kurma', 'haji']);
});
