// v34 (owner 2026-10-11: "do the upgrade — we will not reach 5,000 searches a month"): Google search through our server
// (key stays there; hard cap 4,500 a month < Google's free 5,000). Results are merged with the free OpenStreetMap search,
// marked G; over the cap (or without a key) the free search simply carries on. The demo answers for Google here.
const H = require('./helpers');
const { test, expect } = H;
const CORS = { 'access-control-allow-origin': '*' };
const G = (id, name, lat, lng, types) => ({ id, name, address: 'Jl. Raya Condet', lat, lng, types: types || ['store'], primary: (types || ['store'])[0], url: '', status: 'OPERATIONAL' });

test('Google results next to the free search: by name, and along a drawn line per kind; the month count and the cap', async ({ page, context }) => {
  await context.route(/nominatim\.openstreetmap\.org/, r => r.fulfill({ json: [], headers: CORS }));
  await context.route(/overpass/, r => r.fulfill({ json: { elements: [] }, headers: CORS })); // the free map does not know these small shops
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  await H.openSales(page);
  await H.setDb(page, `db.google_enabled = true; db.google_results = arg;`.replace('arg', JSON.stringify({
    'Toko Barokah': [G('g0', 'Toko Barokah Sembako', -6.2741, 106.8582, ['grocery_store'])],
    'toko kurma': [G('g1', 'Kurma Al-Madinah', -6.2745, 106.8583), G('g9', 'Kurma Jauh Sekali', -6.3000, 106.9000)],
    'toko sembako kelontong': [G('g2', 'Warung Sembako Bu Tini', -6.2770, 106.8586, ['grocery_store'])],
    'perlengkapan haji dan umroh': [G('g3', 'Perlengkapan Haji Barokah', -6.2790, 106.8589, ['clothing_store'])] })));
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');

  await page.click('#pl-open-today');
  await page.click('#pl-mypos');
  await expect(page.locator('#pl-google')).toHaveAttribute('data-n', '0');
  // by name: the free search finds nothing, Google does
  await page.fill('#pl-q', 'Toko Barokah');
  await page.click('#pl-go');
  await expect(page.locator('#pl-results .pl-res[data-src="gp"]')).toHaveCount(1);
  await expect(page.locator('#pl-results')).toContainText('Toko Barokah Sembako');
  await expect(page.locator('#pl-google')).toHaveAttribute('data-n', '1');

  // a work line (points at my position as I walk) → the 3 default kinds: dates, Indonesian groceries, Hajj & Umrah
  await page.click('#pl-seg-line');
  await page.click('#pl-draw');
  for (const [la, ln] of [[-6.2735, 106.8580], [-6.2765, 106.8585], [-6.2795, 106.8590]]) {
    const n = Number(await page.locator('#pl-draw-n').getAttribute('data-n'));
    await H.setPos(context, la, ln);
    await page.click('#pl-draw-pos');
    await expect(page.locator('#pl-draw-n')).toHaveAttribute('data-n', String(n + 1));
  }
  await page.click('#pl-draw-done');
  await page.click('#pl-find-go');
  await expect(page.locator('#pl-found .pl-res[data-src="gp"]')).toHaveCount(3); // the far one (not on the line) is dropped
  await expect(page.locator('#pl-found .pl-res').nth(0)).toHaveAttribute('data-cat', 'kurma');
  await expect(page.locator('#pl-found .pl-res').nth(1)).toHaveAttribute('data-cat', 'sembako');
  await expect(page.locator('#pl-found .pl-res').nth(2)).toHaveAttribute('data-cat', 'haji');
  await expect(page.locator('#pl-google')).toHaveAttribute('data-n', '4'); // 1 + one per kind
  let db = await H.getDb(page);
  expect(db.google_log.filter(x => x.line).map(x => x.q).sort()).toEqual(['perlengkapan haji dan umroh', 'toko kurma', 'toko sembako kelontong']);
  await H.shot(page, 'plan-google');

  // over the month's cap: nothing more goes to Google, the free search carries on
  await H.closeModals(page);
  await H.setDb(page, `db.api_usage.forEach(r => { r.n = 4500; });`);
  await page.click('#pl-open-today');
  await page.fill('#pl-q', 'Toko Barokah');
  await page.click('#pl-go');
  await expect(page.locator('#pl-msg')).toBeVisible();
  db = await H.getDb(page);
  expect(db.google_log.length).toBe(4);
});

test('typing in the planner search survives a redraw (a GPS fix or a background load landing mid-word)', async ({ page, context }) => {
  await context.route(/nominatim\.openstreetmap\.org/, r => r.fulfill({ json: [], headers: CORS }));
  await context.route(/overpass/, r => r.fulfill({ json: { elements: [] }, headers: CORS }));
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, -6.2735, 106.8580);
  await H.openSales(page);
  await H.setDb(page, `db.google_enabled = true; db.google_results = arg;`.replace('arg', JSON.stringify({ 'Toko Barokah': [G('g0', 'Toko Barokah Sembako', -6.2741, 106.8582, ['grocery_store'])] })));
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  if (await page.locator('#consent').isVisible().catch(() => false)) await page.click('#consent-ok');
  await page.click('#pl-open-today');
  await expect(page.locator('#pl-google')).toHaveAttribute('data-n', '0');
  await page.click('#pl-q');
  await page.keyboard.type('Toko');
  await page.evaluate(() => drawPlanner()); // what a late GPS fix / "streets worked" / Google status does
  await page.keyboard.type(' Barokah');
  await expect(page.locator('#pl-q')).toBeFocused();
  await expect(page.locator('#pl-q')).toHaveValue('Toko Barokah');
  expect(await page.evaluate(() => PL.q)).toBe('Toko Barokah');
  await page.keyboard.press('Enter');
  await expect(page.locator('#pl-results .pl-res[data-src="gp"]')).toHaveCount(1);
});
