// v35 (owner 2026-10-11): "a button to choose the routes walked by DATE … all the routes in one place — all of them, by area,
// or the ones of the area the map is on". The field page lists every street / work line the reps worked or planned (kept
// forever), a colour per rep on its own map, filtered by dates, rep and "only on the map now"; a click lights the route.
const { test, expect } = require('@playwright/test');
const { login, nav, editDb, jktToday, SHOTS } = require('./helpers');
const path = require('path');

test('Lapangan: routes history — filtered by dates, rep and the map view; a click lights the route on the map', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await editDb(page, `db.route_plans = db.route_plans || [];
    db.route_plans.push({ plan_id: 'RA', user: 'Budi', plan_date: '${jktToday(-2)}', start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'st:jalan raya condet', name: 'Jalan Raya Condet', lines: [[[-6.285, 106.857], [-6.2731, 106.8582]]] }] });
    db.route_plans.push({ plan_id: 'RB', user: 'Ahmad', plan_date: '${jktToday(-10)}', start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'ln:a1', name: 'Garis Ahmad', drawn: true, lines: [[[-6.2650, 106.8600], [-6.2660, 106.8620]]] }] });
    db.route_plans.push({ plan_id: 'RC', user: 'Budi', plan_date: '${jktToday(-60)}', start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'st:jalan bogor', name: 'Jalan Bogor', lines: [[[-6.40, 106.80], [-6.41, 106.81]]] }] });`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'field');
  const rows = page.locator('#fd-routes .fd-route');
  await expect(rows).toHaveCount(2); // last 30 days by default
  await expect(rows.first()).toContainText('Jalan Raya Condet'); // newest first
  await expect(page.locator('#fd-routes-map')).toHaveAttribute('data-mode', 'leaflet');
  await page.click('#fd-rq-all');
  await expect(rows).toHaveCount(3);
  await page.selectOption('#fd-rf-user', 'Budi');
  await expect(rows).toHaveCount(2);
  await page.fill('#fd-rf-from', jktToday(-90)); await page.fill('#fd-rf-to', jktToday(-30));
  await page.locator('#fd-rf-to').dispatchEvent('change');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Jalan Bogor');
  await page.click('#fd-rq-30');
  await page.selectOption('#fd-rf-user', '');
  await expect(rows).toHaveCount(2);
  await page.locator('#fd-routes .fd-route', { hasText: 'Garis Ahmad' }).click();
  await expect(page.locator('#fd-routes .fd-route.sel')).toContainText('Garis Ahmad');
  await expect.poll(() => page.locator('#fd-routes-map path.leaflet-interactive').evaluateAll(ps => ps.some(p => p.getAttribute('stroke') === '#F59E0B'))).toBe(true);
  // "only on the map now": the map is zoomed on Ahmad's line, Condet is off the map
  await page.check('#fd-rf-view');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Garis Ahmad');
  await page.locator('#fd-routes-panel').screenshot({ path: path.join(SHOTS, 'desktop-field-routes.png') });
});
