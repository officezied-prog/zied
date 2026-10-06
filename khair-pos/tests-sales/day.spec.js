// Working day: consent → Mulai kerja → GPS points (moved > 30 m, accuracy ≤ 100 m) → batches → Selesai kerja.
const H = require('./helpers'); const { test, expect } = H;

test('consent + start day + tracking batches + end of day with km / visits / orders', async ({ page, context }) => {
  await H.openSales(page);
  await H.setDb(page, 'db.settings.field_batch_min = 0.05; db.settings.field_interval_s = 3600;'); // batch every 3 s in the test
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  await H.setPos(context, -6.2600, 106.8600);
  // consent first time
  await page.click('#day-start');
  await expect(page.locator('#consent')).toBeVisible();
  await expect(page.locator('#consent')).toContainText('HANYA saat jam kerja');
  await expect(page.locator('#consent')).toContainText('Lokasi aktif');
  await H.shot(page, 'phone-05-consent');
  await page.click('#consent-ok');
  await expect(page.locator('#day-card[data-status="working"]')).toBeVisible();
  await expect(page.locator('#tb-gps')).toContainText('Lokasi aktif');
  let db = await H.getDb(page);
  const T = db.field_days.find(d => d.user === 'Ahmad' && !d.ended_at);
  expect(T).toBeTruthy();

  // walk north ~110 m per step; a 10 m wiggle and a 500 m-accuracy fix are not kept
  const kept = () => page.evaluate(() => { const S = window.SALES.S; return JSON.parse(localStorage.getItem('kpos.mock.sales.pts.ahmad.' + T)) || []; });
  await H.setPos(context, -6.26009, 106.8600); // ~10 m
  await H.setPos(context, -6.2650, 106.8700, 500); // bad accuracy
  for (let i = 1; i <= 4; i++) { await H.setPos(context, -6.2600 + i * 0.001, 106.8600); await page.waitForTimeout(250); }
  await expect.poll(async () => (await page.evaluate(() => (JSON.parse(localStorage.getItem('kpos.mock.sales.trackq.ahmad')) || []).length + window.SALES.S.outbox.filter(e => e.action === 'track').reduce((a, e) => a + e.data.points.length, 0))) + (await H.getDb(page)).tracks.filter(x => x.user === 'Ahmad' && x.track_date === T.day_date).length, { timeout: 5000 }).toBeGreaterThanOrEqual(6);
  // the batch reaches the server (every field_batch_min)
  await expect.poll(async () => (await H.getDb(page)).tracks.filter(x => x.user === 'Ahmad' && x.track_date === T.day_date).length, { timeout: 15000 }).toBeGreaterThanOrEqual(6);
  db = await H.getDb(page);
  const pts = db.tracks.filter(x => x.user === 'Ahmad' && x.track_date === T.day_date);
  expect(pts.every(p => p.acc <= 100)).toBe(true);
  expect(pts.some(p => Math.abs(p.lat - -6.2560) < 1e-6)).toBe(true);
  expect(pts.some(p => Math.abs(p.lat - -6.2650) < 1e-6)).toBe(false); // the inaccurate fix was dropped
  await expect(page.locator('#st-km')).not.toHaveText('0,0');
  await expect(page.locator('#today-map')).toHaveAttribute('data-mode', 'svg'); // Leaflet blocked → SVG plot
  await expect(page.locator('#today-map polyline')).toHaveCount(1);
  await H.shot(page, 'phone-06-working');

  // one visit with an order today
  await H.tab(page, 'visit');
  await expect(page.locator('#ci-fix')).toContainText('akurasi');
  await page.click('#ci-new');
  await page.fill('#ci-name', 'Warung Uji Coba');
  await H.pickType(page, 'warung');
  await page.click('#oc-order');
  await page.click('#ci-ok');
  await expect(page.locator('#v-order')).toBeVisible();
  await page.fill('#po-q', 'ajwa');
  await page.locator('#po-sug [data-act="po-add"]').first().click();
  await page.click('#po-ok');
  await expect(page.locator('#order-done')).toBeVisible();
  await H.closeModals(page);

  // end of day
  await H.tab(page, 'today');
  await page.click('#day-end');
  await page.fill('#cf-in', 'Hujan sore');
  await page.click('#cf-ok');
  await expect(page.locator('#day-summary')).toBeVisible();
  await expect(page.locator('#sum-visits')).toHaveText('1');
  await expect(page.locator('#sum-orders')).toHaveText('1');
  const km = await page.locator('#sum-km').textContent();
  expect(parseFloat(km.replace(',', '.'))).toBeGreaterThan(0.3);
  await expect(page.locator('#sum-map')).toHaveAttribute('data-mode', 'svg');
  await H.shot(page, 'phone-07-day-summary');
  await H.closeModals(page);
  await expect(page.locator('#tb-gps')).toBeHidden();
  db = await H.getDb(page);
  const day = db.field_days.find(d => d.user === 'Ahmad' && d.day_date === T.day_date);
  expect(day).toMatchObject({ visits: 1, orders: 1, note: 'Hujan sore' });
  expect(day.ended_at).toBeTruthy();
  expect(day.km).toBeGreaterThan(0.3);
  // after the day ended, points are no longer recorded
  const n = db.tracks.filter(x => x.user === 'Ahmad' && x.track_date === T.day_date).length;
  await H.setPos(context, -6.2500, 106.8650);
  await page.waitForTimeout(800);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.sales.trackq.ahmad')) || [])).length).toBe(0);
  expect((await H.getDb(page)).tracks.filter(x => x.user === 'Ahmad' && x.track_date === T.day_date).length).toBe(n);
});
