// v33 (owner 2026-10-11): the office — manager, accountant or cashier — sends a rep the shops of a street, copied from
// Google Maps (free: the text / links Google Maps gives when you share a place). Full links carry the position; a short
// link is followed by the server (here: the demo's known links); a place without either is sent and placed by the rep.
const { test, expect } = require('@playwright/test');
const { openApp, enterKey, getDb, nav, editDb, staffSession, sha } = require('./helpers');

const PASTE = `Toko Kurma Barokah
Jl. Raya Condet No.12, Balekambang
https://maps.app.goo.gl/AbC123

Perlengkapan Haji Al-Amin
4,6(88)
Toko perlengkapan haji · Jl. Raya Condet No.40
0812-3456-7890
https://www.google.com/maps/place/Perlengkapan+Haji+Al-Amin/@-6.276,106.858,17z/data=!3m1!4b1!3d-6.27612!4d106.85871

Warung Tanpa Link
Jl. Raya Condet No. 7`;
const LINKS = { 'https://maps.app.goo.gl/AbC123': 'https://www.google.com/maps/place/Toko+Kurma+Barokah/@-6.2741,106.8583,17z/data=!3d-6.27405!4d106.85834' };

async function seedOffice(page) {
  await openApp(page);
  await editDb(page, `db.gmaps_links = arg.links; db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg.ak, active: true });
    if (!db.users.some(u => u.name === 'Ahmad')) db.users.push({ name: 'Ahmad', role: 'sales', pin_hash: arg.ah, active: true });`, { links: LINKS, ak: sha('demo:lestari:5555'), ah: sha('demo:ahmad:4444') });
}
async function sendList(host, page) {
  await expect(host.locator('#gl-rep option', { hasText: 'Ahmad' })).toHaveCount(1);
  await host.locator('#gl-rep').selectOption('Ahmad');
  await host.locator('#gl-street').fill('Jalan Raya Condet');
  await host.locator('#gl-text').fill(PASTE);
  await host.locator('#gl-read').click();
  await expect(host.locator('#gl-places .gl-place')).toHaveCount(3);
  await expect(host.locator('#gl-places .gl-place[data-pos="1"]')).toHaveCount(2); // full link + short link followed by the server
  await expect(host.locator('#gl-places .gl-place').nth(1)).toContainText('Jl. Raya Condet No.40');
  await expect(host.locator('#gl-places .gl-place').nth(1)).toContainText('081234567890');
  await host.locator('#gl-note').fill('Mulai dari pasar');
  await host.locator('#gl-send').click();
  await expect(page.locator('.toast.ok').filter({ hasText: 'Ahmad' })).toBeVisible();
  await expect(host.locator('#gl-sent .gl-sent-row').first()).toHaveAttribute('data-status', 'sent');
}

test('manager: Google Maps text → the shops of a street → sent to the rep (positions from the links)', async ({ page }) => {
  await seedOffice(page);
  await enterKey(page);
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'field');
  await page.click('#fd-shoplist');
  const host = page.locator('#gl-host');
  await sendList(host, page);
  const db = await getDb(page);
  const l = db.shop_lists.slice(-1)[0];
  expect(l).toMatchObject({ from_user: 'Jihan', from_role: 'manager', to_user: 'Ahmad', street: 'Jalan Raya Condet', status: 'sent', note: 'Mulai dari pasar' });
  expect(l.places.map(p => p.name)).toEqual(['Toko Kurma Barokah', 'Perlengkapan Haji Al-Amin', 'Warung Tanpa Link']);
  expect([l.places[0].lat, l.places[0].lng]).toEqual([-6.27405, 106.85834]);
  expect(l.places[2].lat).toBeNull(); // the rep puts it on the map
});

test('the accountant (read-only app) may still send a shop list', async ({ page }) => {
  await seedOffice(page);
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'shoplist');
  await sendList(page.locator('#gl-host'), page);
  const db = await getDb(page);
  expect(db.shop_lists.slice(-1)[0]).toMatchObject({ from_user: 'Lestari', from_role: 'akuntan' });
});
