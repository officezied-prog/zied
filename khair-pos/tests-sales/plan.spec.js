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
  await page.click('#pl-results .pl-res[data-kind="street"] [data-act="pl-work"]'); // the street goes into the plan …
  // v35d: … and opens in the work-line tab, where the kinds of shop are chosen (bottom); only those kinds are searched along it
  await expect(page.locator('#pl-seg-line')).toHaveClass(/on/);
  await expect(page.locator('#pl-lines .pl-line.sel')).toContainText('Jalan Raya Condet');
  await expect(page.locator('#pl-found .pl-res')).toHaveCount(2); // default kinds: the two groceries (sembako)
  expect(seen.over).toContain('"name"="Jalan Raya Condet"');
  expect(seen.over).toContain('around.s:60');
  await page.click('#pl-kinds [data-k="ritel"]');
  await page.click('#pl-kinds [data-k="masjid"]');
  await page.click('#pl-find-go');
  await expect(page.locator('#pl-found .pl-res')).toHaveCount(4); // + the minimarket and the mosque
  await H.shot(page, 'plan-along-street');
  await page.click('#pl-find-all');
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
  await expect(page.locator('#pl-found .pl-res')).toHaveCount(2); // the chosen kinds along the whole street
  await page.click('#pl-found .pl-res >> nth=0 >> [data-act="pl-find-toggle"]');
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

  // the kinds the owner asked for are ticked by default: dates, Indonesian groceries, Hajj & Umrah
  await expect(page.locator('#pl-kinds .find-chip.on')).toHaveCount(3);
  await expect(page.locator('#pl-kinds .find-chip.on[data-k="sembako"]')).toHaveCount(1);
  await page.click('#pl-kinds [data-k="sembako"]'); // this test looks for the Muslim shops instead of the groceries
  await page.click('#pl-kinds [data-k="muslim"]');
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

// v35 (owner 2026-10-11): tap a street on the map → "work this whole street" — the named street under the finger is
// found (free OpenStreetMap), drawn whole and put in the plan with its shops, exactly like searching its name.
test('tap a street on the map → the whole street goes into the plan with its shops; a tap off any named street says so', async ({ page, context }) => {
  const seen = [];
  await page.route(/\/vendor\/leaflet\//, r => r.continue()); // this test needs the map (tiles stay blocked)
  let empty = false;
  await context.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill({ status: 503, body: 'busy', headers: CORS })); // the address service is busy here → Overpass
  await context.route(/overpass/, r => {
    const q = decodeURIComponent((r.request().postData() || '').replace(/^data=/, '')); seen.push(q);
    const near = { elements: empty ? [] : [ // the streets within 40 m of the tap: the nearest one wins
      { type: 'way', id: 900, tags: { highway: 'residential', name: 'Gang Mawar' }, geometry: [{ lat: -6.2738, lon: 106.8576 }, { lat: -6.2738, lon: 106.8570 }] },
      { type: 'way', id: 111, tags: { highway: 'primary', name: 'Jalan Raya Condet' }, geometry: [{ lat: -6.2740, lon: 106.8580 }, { lat: -6.2731, lon: 106.8582 }] }] };
    r.fulfill({ json: /around:40,/.test(q) ? near : OVER, headers: CORS });
  });
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  await H.openSales(page);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');

  await page.click('#pl-open-today');
  await expect(page.locator('#pl-map .leaflet-container, #pl-map.leaflet-container')).toHaveCount(1);
  const box = await page.locator('#pl-map').boundingBox();
  await page.locator('#pl-map').click({ position: { x: box.width / 2, y: box.height / 2 } });
  // v35: the street's name comes up on the button as soon as the map is tapped, and that piece of street is lit
  await expect(page.locator('#pl-sel-street')).toHaveAttribute('data-state', 'found');
  await expect(page.locator('#pl-sel-street')).toContainText('Jalan Raya Condet');
  expect(await page.locator('#pl-map path.leaflet-interactive').evaluateAll(ps => ps.some(p => p.getAttribute('stroke') === '#F59E0B'))).toBe(true);
  // … then the WHOLE street (every piece with that name, not only the piece under the finger) is lit
  await expect.poll(() => seen.some(q => /way\["highway"\]\["name"="Jalan Raya Condet"\]\([^)]*\);out geom;/.test(q))).toBe(true);
  await expect.poll(() => page.locator('#pl-map path.leaflet-interactive').evaluateAll(ps => ps.filter(p => p.getAttribute('stroke') === '#F59E0B').map(p => p.getAttribute('d')).join('|'))).toContain('L');
  await page.click('#pl-sel-street');
  await expect(page.locator('#pl-found .pl-res')).toHaveCount(2); // the chosen kinds along the WHOLE street
  expect(seen[0]).toMatch(/way\(around:40,-6\.\d{6},106\.\d{6}\)\["highway"\]\["name"\]/); // only the streets under the finger
  expect(seen.filter(q => /"name"="Jalan Raya Condet"/.test(q) && /out center/.test(q)).length).toBe(1); // then the whole street + its shops, as "Kerjakan jalan ini"
  await expect(page.locator('#pl-lines .pl-line.sel')).toContainText('Jalan Raya Condet');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-streets .pl-street')).toHaveCount(1);
  await expect(page.locator('#pl-streets .pl-street')).toContainText('Jalan Raya Condet');
  // v35b (owner: "when I choose the street I want the whole street coloured in another colour"): the chosen street, whole, in its own blue
  expect(await page.locator('#pl-map path.leaflet-interactive').evaluateAll(ps => ps.filter(p => p.getAttribute('stroke') === '#2563EB').length)).toBeGreaterThan(0);
  await H.shot(page, 'plan-street-tap');

  // a tap where no named street is → a clear message, nothing added
  empty = true;
  await page.locator('#pl-map').click({ position: { x: box.width / 3, y: box.height / 3 } });
  await expect(page.locator('#pl-sel-street')).toHaveAttribute('data-state', 'none');
  await expect(page.locator('#pl-sel-street')).toBeDisabled();
  await expect(page.locator('#pl-sel-street')).toContainText('Tidak ada jalan bernama');
  expect(seen.filter(q => /around:40,/.test(q)).length).toBe(2); // one look-up per tap — the button did not search again
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-streets .pl-street')).toHaveCount(1);
});

// v35 (owner 2026-10-11): "the green line we draw is sometimes away from the road" → on "Selesai" each point goes onto the
// nearest road (≤ 35 m) and, between two points on the same road, the line follows the road's bend.
test('work line: drawn points are put back onto the road and follow its bend', async ({ page, context }) => {
  const seen = [];
  await page.route(/\/vendor\/leaflet\//, r => r.continue());
  const ROAD = { elements: [{ type: 'way', id: 700, tags: { highway: 'residential', name: 'Jalan Bengkok' },
    geometry: [{ lat: -6.2735, lon: 106.8580 }, { lat: -6.2750, lon: 106.8590 }, { lat: -6.2765, lon: 106.8580 }] }] };
  await context.route(/overpass/, r => { const q = decodeURIComponent((r.request().postData() || '').replace(/^data=/, '')); seen.push(q); r.fulfill({ json: /around:35,/.test(q) ? ROAD : { elements: [] }, headers: CORS }); });
  await context.grantPermissions(['geolocation']);
  await H.openSales(page);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await page.click('#pl-open-today');
  await page.click('#pl-seg-line');
  await page.click('#pl-draw');
  for (const [la, ln] of [[-6.27352, 106.85818], [-6.27648, 106.85818]]) { // ~15-20 m off the road, on both ends of its bend
    const n = Number(await page.locator('#pl-draw-n').getAttribute('data-n'));
    await H.setPos(context, la, ln);
    await page.click('#pl-draw-pos');
    await expect(page.locator('#pl-draw-n')).toHaveAttribute('data-n', String(n + 1));
  }
  await page.click('#pl-draw-done');
  await expect(page.locator('#pl-lines .pl-line[data-drawn="1"]')).toHaveCount(1);
  await expect(page.locator('#pl-msg')).toContainText('2 titik ditempelkan');
  expect(seen.some(q => /way\(around:35,-6\.27352,106\.85818,-6\.27648,106\.85818\)\["highway"\]/.test(q))).toBe(true);
  await page.click('#pl-seg-plan');
  await page.click('#pl-save');
  await expect.poll(async () => ((await H.getDb(page)).route_plans || []).filter(p => p.user === 'Ahmad').length).toBe(1);
  const ln = (await H.getDb(page)).route_plans.find(p => p.user === 'Ahmad').streets[0].lines[0];
  expect(ln.length).toBe(3);
  expect(ln[1]).toEqual([-6.275, 106.859]); // the road's bend is kept
  for (const q of [ln[0], ln[2]]) expect(Math.abs(q[1] - 106.85818)).toBeGreaterThan(0.00005); // both ends moved onto the road
});

// v35 (owner 2026-10-11): "a button to choose the routes walked by date … all routes in one place, all / by area / the ones
// of the area on the map": the Riwayat tab lists every worked / planned street & line, filtered by dates, rep and the map view.
test('routes history: every worked route, filtered by dates and rep; a tap lights it on the map', async ({ page, context }) => {
  await page.route(/\/vendor\/leaflet\//, r => r.continue());
  await context.route(/overpass|nominatim/, r => r.fulfill({ json: { elements: [] }, headers: CORS }));
  const day = n => { const d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  await H.openSales(page);
  await H.setDb(page, `db.route_plans = db.route_plans || [];
    db.route_plans.push({ plan_id: 'R1', user: 'Budi', plan_date: '${day(2)}', start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'st:jalan raya condet', name: 'Jalan Raya Condet', lines: [[[-6.285, 106.857], [-6.2731, 106.8582]]] }] });
    db.route_plans.push({ plan_id: 'R2', user: 'Budi', plan_date: '${day(40)}', start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'ln:old1', name: 'Garis lama', drawn: true, lines: [[[-6.2600, 106.8500], [-6.2620, 106.8510]]] }] });
    db.route_plans.push({ plan_id: 'R3', user: 'Ahmad', plan_date: '${day(5)}', start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'st:jalan dewi sartika', name: 'Jalan Dewi Sartika', lines: [[[-6.2650, 106.8600], [-6.2660, 106.8620]]] }] });`);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await page.click('#pl-open-today');
  await page.click('#pl-seg-routes');
  await page.uncheck('#pl-rf-view'); // all areas
  await expect(page.locator('#pl-routes .pl-route')).toHaveCount(3);
  await expect(page.locator('#pl-routes .pl-route').first()).toContainText('Jalan Raya Condet'); // newest first
  await page.click('#pl-rq-7');
  await expect(page.locator('#pl-routes .pl-route')).toHaveCount(2);
  await page.selectOption('#pl-rf-user', 'Budi');
  await expect(page.locator('#pl-routes .pl-route')).toHaveCount(1);
  await page.click('#pl-rq-all');
  await expect(page.locator('#pl-routes .pl-route')).toHaveCount(2);
  await page.fill('#pl-rf-from', day(50)); await page.fill('#pl-rf-to', day(30));
  await page.locator('#pl-rf-to').dispatchEvent('change');
  await expect(page.locator('#pl-routes .pl-route')).toHaveCount(1);
  await expect(page.locator('#pl-routes .pl-route')).toContainText('Garis lama');
  await page.click('#pl-routes .pl-route');
  await expect(page.locator('#pl-routes .pl-route.sel')).toHaveCount(1);
  await expect.poll(() => page.locator('#pl-map path.leaflet-interactive').evaluateAll(ps => ps.some(p => p.getAttribute('stroke') === '#F59E0B'))).toBe(true);
  // "only on the map now": the map is on the old line, so the list keeps it
  await page.check('#pl-rf-view');
  await expect(page.locator('#pl-routes .pl-route')).toHaveCount(1);
  await H.shot(page, 'plan-routes');
});

// v35c (owner 2026-10-11): "I tried colouring the street and nothing was coloured" + "each street its own colour" + "a long street
// with many branches: the rep picks where the work starts and ends, and the app colours the street between them".
// a tap at an exact place on the map (shop circles and lines there would otherwise catch a real click; test 4 taps for real)
const tapAt = async (page, lat, lng, popup) => {
  await page.evaluate(([a, b]) => planMapClick(window.L.latLng(a, b)), [lat, lng]);
  if (popup) await expect(page.locator('.leaflet-popup')).toHaveCount(1); // the last popup has faded out
};
test('streets: each its own colour; drawn even when the shop search fails; start → end along a branching street', async ({ page, context }) => {
  await page.route(/\/vendor\/leaflet\//, r => r.continue());
  // Jalan Panjang: A(-6.2600) → B(-6.2620) → C(-6.2640) → D(-6.2660) along lng 106.8600, in two pieces that almost meet (≈ 11 m gap at C),
  // with a branch B → E going east. Jalan Kedua: another street.
  const PANJANG = [
    { type: 'way', id: 1, tags: { highway: 'residential', name: 'Jalan Panjang' }, geometry: [{ lat: -6.2600, lon: 106.8600 }, { lat: -6.2620, lon: 106.8600 }, { lat: -6.2640, lon: 106.8600 }] },
    { type: 'way', id: 2, tags: { highway: 'residential', name: 'Jalan Panjang' }, geometry: [{ lat: -6.2641, lon: 106.8600 }, { lat: -6.2660, lon: 106.8600 }] },
    { type: 'way', id: 3, tags: { highway: 'residential', name: 'Jalan Panjang' }, geometry: [{ lat: -6.2620, lon: 106.8600 }, { lat: -6.2620, lon: 106.8630 }] }];
  const KEDUA = [{ type: 'way', id: 9, tags: { highway: 'residential', name: 'Jalan Kedua' }, geometry: [{ lat: -6.2610, lon: 106.8580 }, { lat: -6.2610, lon: 106.8560 }] }];
  let shopsFail = true;
  await context.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill({ status: 503, body: 'busy', headers: CORS })); // the address service is busy here → Overpass
  await context.route(/overpass|maps\.mail\.ru/, r => {
    const q = decodeURIComponent((r.request().postData() || '').replace(/^data=/, ''));
    if (/out center/.test(q) && shopsFail) return r.fulfill({ status: 504, body: 'timeout', headers: CORS }); // the heavy shops search times out
    const m = /around:40,(-?[\d.]+),(-?[\d.]+)\)/.exec(q), near = m && +m[2] < 106.859 ? KEDUA : PANJANG; // the tap: west → Jalan Kedua
    r.fulfill({ json: { elements: /name"="Jalan Kedua"/.test(q) ? KEDUA : /around:40,/.test(q) ? [near[0]] : /out center/.test(q) ? [] : PANJANG }, headers: CORS });
  });
  await H.openSales(page);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await page.click('#pl-open-today');
  await page.evaluate(() => PL.map.setView([-6.2630, 106.8595], 16, { animate: false }));

  // 1) the whole street, even though its shops search fails
  await tapAt(page, -6.2610, 106.8600, true);
  await expect(page.locator('#pl-sel-street')).toContainText('Jalan Panjang');
  await page.click('#pl-sel-street');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-streets .pl-street')).toHaveCount(1);
  const stroke = c => page.locator('#pl-map path.leaflet-interactive').evaluateAll((ps, c) => ps.filter(p => p.getAttribute('stroke') === c).length, c);
  await expect.poll(() => stroke('#2563EB')).toBeGreaterThan(0); // street 1 = blue, drawn
  // 2) a second street gets its own colour
  shopsFail = false;
  await page.evaluate(() => PL.map.setView([-6.2610, 106.8570], 17, { animate: false }));
  await tapAt(page, -6.2610, 106.8570, true);
  await expect(page.locator('#pl-sel-street')).toContainText('Jalan Kedua');
  await page.click('#pl-sel-street');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-streets .pl-street')).toHaveCount(2);
  await expect(page.locator('#pl-streets .pl-street').nth(1)).toHaveAttribute('data-c', '#16A34A');
  await expect.poll(() => stroke('#16A34A')).toBeGreaterThan(0);

  // 3) a long, branching street: from just after A to just before D — along the street, NOT into the branch, across the gap
  await page.evaluate(() => PL.map.setView([-6.2630, 106.8605], 16, { animate: false }));
  await tapAt(page, -6.2650, 106.8600, true);
  await expect(page.locator('#pl-sel-part')).toBeEnabled();
  await page.click('#pl-sel-part');
  await expect(page.locator('#pl-partbar')).toHaveAttribute('data-step', '1');
  await tapAt(page, -6.2605, 106.8601);
  await expect(page.locator('#pl-partbar')).toHaveAttribute('data-step', '2');
  await tapAt(page, -6.2655, 106.8599);
  await expect(page.locator('#pl-partbar')).toHaveCount(0);
  const part = page.locator('#pl-lines .pl-line[data-drawn="1"]');
  await expect(part).toContainText('Jalan Panjang · bagian');
  await expect(part).toHaveAttribute('data-c', '#C026D3'); // the 3rd colour
  const ln = await page.evaluate(() => PL.streets[2].lines[0]);
  expect(ln[0][0]).toBeCloseTo(-6.2605, 4);
  expect(ln[ln.length - 1][0]).toBeCloseTo(-6.2655, 4);
  expect(ln.every(q => Math.abs(q[1] - 106.86) < 0.00005)).toBe(true); // stayed on the street, not into the branch to the east
  await H.shot(page, 'plan-street-part');
});

// v35d (owner: "the street colouring worked once, then stopped"): a public Overpass server that refuses (429) or answers "timed
// out" no longer blanks the street — the next free server answers, and a street once fetched is kept on the phone.
test('streets: a busy map server → the next one answers; a street fetched once needs no new request', async ({ page, context }) => {
  await page.route(/\/vendor\/leaflet\//, r => r.continue());
  const hits = [];
  await context.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill({ status: 503, body: 'busy', headers: CORS })); // the address service is busy here → Overpass
  await context.route(/overpass|maps\.mail\.ru/, r => {
    const u = r.request().url(), q = decodeURIComponent((r.request().postData() || '').replace(/^data=/, '')); hits.push([u, q]);
    if (/overpass-api\.de/.test(u)) return r.fulfill({ status: 429, body: 'rate limited', headers: CORS });
    if (/private\.coffee/.test(u)) return r.fulfill({ json: { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' }, headers: CORS });
    r.fulfill({ json: /around:40,/.test(q) ? { elements: [OVER.elements[0]] } : OVER, headers: CORS });
  });
  await H.openSales(page);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await page.click('#pl-open-today');
  await page.evaluate(() => planMapClick(window.L.latLng(-6.2731, 106.8582)));
  await expect(page.locator('#pl-sel-street')).toContainText('Jalan Raya Condet');
  await page.click('#pl-sel-street');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-streets .pl-street')).toHaveCount(1);
  expect(hits.some(([u]) => /maps\.mail\.ru/.test(u))).toBe(true); // the third server answered
  // the whole street is kept on the phone now
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => /street_shapes$/.test(k)).map(k => Object.keys(JSON.parse(localStorage.getItem(k))).length)[0] || 0)).toBeGreaterThan(0);
  const shapeQ = () => hits.filter(([, q]) => /out geom;$/.test(q) && /"name"="Jalan Raya Condet"\]\(/.test(q)).length;
  const before = shapeQ(), n = hits.length;
  // another tap on the same street: the next request starts with the server that answered, and the shape is not asked again
  await page.evaluate(() => planMapClick(window.L.latLng(-6.2760, 106.8585)));
  await expect(page.locator('.leaflet-popup')).toHaveCount(1);
  await expect(page.locator('#pl-sel-street')).toContainText('Jalan Raya Condet');
  expect(/maps\.mail\.ru/.test(hits[n][0])).toBe(true);
  await page.waitForTimeout(800);
  expect(shapeQ()).toBe(before);
});

// v35e (owner: "it worked once, then 'the map server is busy'"): the street under the finger comes from the address service
// (Nominatim) first; the whole street from Overpass, else Nominatim; with both busy the piece under the finger is coloured.
test('streets: Overpass busy → Nominatim gives the street and the whole street; both busy → the piece is coloured', async ({ page, context }) => {
  await page.route(/\/vendor\/leaflet\//, r => r.continue());
  await context.route(/overpass|maps\.mail\.ru/, r => r.fulfill({ status: 429, body: 'Too Many Requests', headers: CORS })); // every Overpass server refuses
  const geo = pts => ({ type: 'LineString', coordinates: pts.map(([a, b]) => [b, a]) });
  let nomiBusy = false; const nq = [];
  await context.route(/nominatim\.openstreetmap\.org/, r => {
    const u = r.request().url(); nq.push(u);
    if (/\/reverse/.test(u)) return r.fulfill({ json: { category: 'highway', type: 'residential', name: 'Jalan Raya Condet', address: { road: 'Jalan Raya Condet' },
      geojson: geo([[-6.2720, 106.8581], [-6.2740, 106.8583]]) }, headers: CORS });
    if (nomiBusy) return r.fulfill({ status: 503, body: 'busy', headers: CORS });
    r.fulfill({ json: [ // the same street in two pieces + another street with a similar name
      { category: 'highway', type: 'residential', name: 'Jalan Raya Condet', geojson: geo([[-6.2700, 106.8579], [-6.2720, 106.8581]]) },
      { category: 'highway', type: 'residential', name: 'Jalan Raya Condet', geojson: geo([[-6.2720, 106.8581], [-6.2740, 106.8583], [-6.2760, 106.8585]]) },
      { category: 'highway', type: 'residential', name: 'Gang Condet', geojson: geo([[-6.2710, 106.8590], [-6.2710, 106.8600]]) }], headers: CORS });
  });
  await H.openSales(page);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await page.click('#pl-open-today');
  await page.evaluate(() => planMapClick(window.L.latLng(-6.2730, 106.8582)));
  await expect(page.locator('#pl-sel-street')).toContainText('Jalan Raya Condet');
  await page.click('#pl-sel-street');
  await expect(page.locator('#pl-lines .pl-line')).toHaveCount(1); // chosen → the work-line tab (its shop search fails here: Overpass refuses)
  expect(nq.filter(u => /\/search\?/.test(u)).length).toBe(1); // the whole street was asked once (the tap's look-up is reused)
  const ln = await page.evaluate(() => PL.streets[0].lines);
  expect(ln.length).toBe(1); // the two pieces joined into one line, the other street left out
  expect(ln[0][0][0]).toBeCloseTo(-6.27, 3); expect(ln[0][ln[0].length - 1][0]).toBeCloseTo(-6.276, 3);
  expect(nq.some(u => /search\?.*q=Jalan%20Raya%20Condet.*bounded=1.*dedupe=0.*polygon_geojson=1/.test(u))).toBe(true);
  // both services busy for the whole street → the piece under the finger is coloured, and the rep is told
  nomiBusy = true;
  await page.click('#pl-lines [data-act="pl-street-del"]');
  await page.evaluate(() => { localStorage.clear(); planMapClick(window.L.latLng(-6.2730, 106.8582)); });
  await expect(page.locator('.leaflet-popup')).toHaveCount(1);
  await expect(page.locator('#pl-sel-street')).toContainText('Jalan Raya Condet');
  await page.click('#pl-sel-street');
  await expect(page.locator('.toast').filter({ hasText: 'baru bagian jalan' })).toBeVisible();
  await expect(page.locator('#pl-lines .pl-line')).toHaveCount(1);
  expect((await page.evaluate(() => PL.streets[0].lines))[0].length).toBeGreaterThan(1);
});
