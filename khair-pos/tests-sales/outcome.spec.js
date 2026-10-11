// v32 (owner 2026-10-11): each point of the day's plan takes the colour of its visit result — green = order, orange = the
// shop is there but no order, blue = does not want to work with us, BLACK = closed / owner not there / shop gone / changed
// business, and a black result needs a photo of the place (proof; no consent from a person needed).
const H = require('./helpers'); const { test, expect } = H;

const STOPS = [[-6.2000, 106.8000], [-6.2025, 106.8000], [-6.2050, 106.8000], [-6.2075, 106.8000]]; // ~280 m apart, away from the demo shops

test('plan points take the colour of the visit result; a black result needs a photo of the place', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await H.setPos(context, STOPS[0][0], STOPS[0][1], 10);
  await H.openSales(page);
  const d = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  await H.setDb(page, `db.route_plans = db.route_plans || []; db.route_plans.push({ plan_id: 'RPOC', user: 'Ahmad', plan_date: '${d}', start: null, end: null, note: '', streets: [], updated_at: '',
    stops: ${JSON.stringify(STOPS.map((p, i) => ({ ref: 'pt:' + i, kind: 'place', shop_id: '', name: 'Titik ' + (i + 1), lat: p[0], lng: p[1], address: '', type: '', src: 'map' })))} });`);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  await H.startDay(page);
  await expect(page.locator('#pl-prog')).toHaveAttribute('data-n', '4');

  const visit = async (i, outcome, opts = {}) => {
    await H.setPos(context, STOPS[i][0], STOPS[i][1], 10);
    await H.tab(page, 'visit');
    await page.click('#ci-new');
    await page.fill('#ci-name', 'Toko Titik ' + (i + 1));
    await H.pickType(page, 'toko');
    await page.click('#oc-' + outcome);
    if (opts.black) {
      await expect(page.locator('#ci-black')).toBeVisible();
      await page.click('#ci-ok');
      await expect(page.locator('#ci-err')).toContainText('foto'); // the photo of the place is required
      await page.setInputFiles('#ci-photo-back', await H.photoFile(page));
      await expect(page.locator('#ci-thumb')).toBeVisible(); // no owner consent ticked: still accepted (it is the place)
    } else await expect(page.locator('#ci-black')).toBeHidden();
    await page.click('#ci-ok');
    await expect(page.locator('.toast.ok', { hasText: 'Toko Titik ' + (i + 1) })).toBeVisible();
    if (outcome === 'order') await expect(page.locator('#v-order')).toBeVisible();
  };
  await visit(0, 'order');
  await visit(1, 'tertarik');
  await visit(2, 'tidak');
  await visit(3, 'ganti_usaha', { black: true });

  await H.tab(page, 'today');
  await expect(page.locator('#pl-prog')).toHaveAttribute('data-k', '4');
  for (const k of ['green', 'orange', 'blue', 'black']) await expect(page.locator(`#pl-occ [data-oc="${k}"]`)).toContainText('1');
  // the route map (simple map in this suite): one point of each colour
  for (const k of ['green', 'orange', 'blue', 'black']) await expect(page.locator(`#today-map [data-oc="${k}"]`)).toHaveCount(1);
  await H.shot(page, 'plan-outcome-colours');

  const db = await H.getDb(page);
  const black = db.visits.find(v => v.outcome === 'ganti_usaha');
  expect(black.photo_thumb.length).toBeGreaterThan(100);
  expect(black).toMatchObject({ photo_consent: false, photo_place: true });
});
