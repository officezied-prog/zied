// Security review fixes: no HTML from data in map tooltips/popups (C1), store key masked, no reusable pin hash at rest (H2),
// CSV formula guard and https-only links (LOW), CSP present (M8).
const { test, expect } = require('@playwright/test');
const { login, openApp, getDb, nav, editDb, typePin, blockMapNetwork } = require('./helpers');

const EVIL = '<img src=x onerror="window.__xss=1">';
/** A tiny Leaflet stand-in that, like Leaflet, puts tooltip / popup content in with innerHTML. */
const LEAFLET_STUB = () => {
  const mk = () => { const o = { addTo(m) { o.m = m; return o; }, bindTooltip(c) { o.put('stub-tip', c); return o; }, bindPopup(c) { o.put('stub-pop', c); return o; },
    put(cls, c) { const d = document.createElement('div'); d.className = cls; d.innerHTML = c; ((o.m && o.m._el) || document.body).appendChild(d); } }; return o; };
  window.L = { map(el) { return { _el: el, remove() { }, fitBounds() { } }; }, tileLayer() { return mk(); }, polyline() { return mk(); }, circleMarker() { return mk(); }, marker() { return mk(); }, circle() { return mk(); }, divIcon(o) { return o; } };
};
async function plant(page) {
  await editDb(page, `
    const day = db.field_days[db.field_days.length - 1];
    db.shops.push({ shop_id: 'SHX1', name: arg, owner_name: arg, phone: '', address: arg, area: arg, type: 'lainnya', type_other: arg, chain: arg, lat: -6.2765, lng: 106.858, created_by: day.user, created_at: day.day_date + 'T09:00:00+07:00', last_visit_at: '', visits: 1, status: 'prospek', customer_id: 0, next_visit: '' });
    db.visits.push({ visit_id: 'VX1', client_id: 'vx1', user: day.user, visit_date: day.day_date, visit_time: day.day_date + 'T09:00:00+07:00', shop_id: 'SHX1', shop_name: arg, lat: -6.2765, lng: 106.858, acc: 10, distance_m: 5, outcome: 'tertarik', notes: arg, next_visit: '', photo_thumb: '', drive_url: 'javascript:alert(1)' });
    db.devices.push({ id: 999, device_id: 'dEVIL000000000000001', user: 'Siti', role: 'kasir', app: 'kasir', label: arg, ua: arg, ip: arg, lat: -6.2766, lng: 106.8579, acc: 10, loc_status: 'granted', loc_at: new Date().toISOString(), first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), pings: 1, battery: 0.5 });
`, EVIL);
  return (await getDb(page)).field_days.slice(-1)[0].day_date;
}

for (const mode of ['leaflet-stub', 'svg']) {
  test(`C1: a shop / device named like HTML is shown as text on the maps (${mode})`, async ({ page }) => {
    if (mode === 'svg') await blockMapNetwork(page); else await page.addInitScript(LEAFLET_STUB);
    await login(page, 'Pemilik', '1234', '', { stay: true });
    const day = await plant(page);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await nav(page, 'field');
    await page.fill('#fd-date', day);
    await page.locator('#fd-date').dispatchEvent('change');
    await expect(page.locator('#fd-map')).toHaveAttribute('data-mode', mode === 'svg' ? 'svg' : 'leaflet');
    if (mode !== 'svg') {
      await expect(page.locator('#fd-map .stub-tip').filter({ hasText: '<img src=x' })).toHaveCount(1);
      await expect(page.locator('#fd-map img')).toHaveCount(0);
    } else await expect(page.locator('#fd-map svg title').filter({ hasText: '<img src=x' }).first()).toBeAttached();
    await expect(page.locator('#fd-visits')).toContainText('<img src=x');
    await nav(page, 'devices');
    await expect(page.locator('#dv-map')).toHaveAttribute('data-mode', mode === 'svg' ? 'svg' : 'leaflet');
    if (mode !== 'svg') await expect(page.locator('#dv-map .stub-pop').filter({ hasText: '<img src=x' })).toHaveCount(1);
    await expect(page.locator('#dv-table tr[data-dev="dEVIL000000000000001"]')).toContainText('<img src=x');
    await page.locator('#dv-table tr[data-dev="dEVIL000000000000001"]').click();
    await expect(page.locator('#dv-detail')).toContainText('<img src=x');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  });
}

test('store key never shown in full; pin hashes not kept at rest; offline login with the verifier; old entries migrated', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  expect(await page.evaluate(() => [maskKey('KHR-8f3a-91c2-77d0'), maskKey('')])).toEqual(['••••-77d0', '']);
  const hash = await page.evaluate(() => KPOS.S.pin_hash);
  const local = await page.evaluate(() => Object.keys(localStorage).filter(k => k !== 'kmock.db').map(k => localStorage.getItem(k)).join('\n'));
  expect(local).not.toContain(hash);
  const pins = await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.pins')));
  expect(pins.pemilik).toEqual({ o: await page.evaluate(h => sha256Hex('offline:' + h), hash), role: 'owner' });
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('kpos.mock.session')))).toMatchObject({ user: 'Pemilik', pin_hash: hash });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.session')))).toEqual({ user: 'Pemilik', role: 'owner' });
  // lock wipes the live hash of this tab
  await page.click('#tb-lock');
  expect(await page.evaluate(() => sessionStorage.getItem('kpos.mock.session'))).toBeNull();
  await expect(page.locator('#login')).toContainText('••••-demo');
  // offline: the verifier lets the right PIN in, a wrong PIN stays out
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await typePin(page, '9999');
  await expect(page.locator('.login-err')).not.toBeEmpty();
  await typePin(page, '1234');
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  // an old {h: pin_hash} entry is converted on the next start
  await page.evaluate(h => { const p = JSON.parse(localStorage.getItem('kpos.mock.pins')); p.jihan = { h, role: 'manager' }; localStorage.setItem('kpos.mock.pins', JSON.stringify(p)); }, 'a'.repeat(64));
  await page.reload();
  await expect(page.locator('#app')).toBeVisible(); // same tab: the session survives a reload
  const p2 = await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.pins')));
  expect(p2.jihan).toEqual({ o: await page.evaluate(() => sha256Hex('offline:' + 'a'.repeat(64))), role: 'manager' });
});

test('LOW: CSV cells cannot start a formula; links from data must be https; CSP meta present', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  expect(await page.evaluate(() => [csvCell('=HYPERLINK("x")'), csvCell('+1'), csvCell('-cmd'), csvCell('@SUM(A1)'), csvCell('\tx'), csvCell(-5), csvCell('Kurma')]))
    .toEqual(['"\'=HYPERLINK(""x"")"', '"\'+1"', '"\'-cmd"', '"\'@SUM(A1)"', '"\'\tx"', '"-5"', '"Kurma"']);
  expect(await page.evaluate(() => [safeUrl('javascript:alert(1)'), safeUrl('data:text/html,x'), safeUrl('https://drive.google.com/x'), safeUrl('http://x')]))
    .toEqual(['#', '#', 'https://drive.google.com/x', '#']);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'self' https://khair-mart-jumla.officezied.workers.dev"); // backend = the Khair Mart Jumla Worker since the 2026-10-10 cut-over
  expect(csp).toContain("object-src 'none'");
});
