// v33 (owner 2026-10-11): the cashier too may send a rep the shops of a street copied from Google Maps (free) —
// Lainnya → "Daftar toko untuk sales"; the list reaches the rep's plan. (Same page as the owner app: shared/gmaps-import.js.)
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test('cashier: Google Maps text → a shop list for a street → sent to the rep', async ({ page }) => {
  await H.login(page, 'Siti', '1111');
  await H.setDb(page, `db.gmaps_links = { 'https://maps.app.goo.gl/AbC123': 'https://www.google.com/maps/place/Toko+Kurma+Barokah/data=!3d-6.27405!4d106.85834' };
    if (!db.users.some(u => u.name === 'Ahmad')) db.users.push({ name: 'Ahmad', role: 'sales', pin_hash: arg, active: true });`, H.sha('demo:ahmad:4444'));
  await page.reload();
  await H.login(page, 'Siti', '1111', { noGoto: true, openShift: false }).catch(() => { });
  if (await page.locator('#gate #shift-open').isVisible().catch(() => false)) { await page.fill('#so-cash', '500000'); await page.click('#so-ok'); }
  await page.click('#tab-more');
  await page.click('#m-shoplist');
  const host = page.locator('#shoplist #gl-host');
  await expect(host.locator('#gl-rep option', { hasText: 'Ahmad' })).toHaveCount(1);
  await host.locator('#gl-rep').selectOption('Ahmad');
  await host.locator('#gl-street').fill('Jalan Raya Condet');
  await host.locator('#gl-text').fill('Toko Kurma Barokah\nJl. Raya Condet No.12\nhttps://maps.app.goo.gl/AbC123\n\nWarung Tanpa Link\nJl. Raya Condet No. 7');
  await host.locator('#gl-read').click();
  await expect(host.locator('#gl-places .gl-place')).toHaveCount(2);
  await expect(host.locator('#gl-places .gl-place[data-pos="1"]')).toHaveCount(1);
  await host.locator('#gl-send').click();
  await expect(page.locator('.toast').filter({ hasText: 'Ahmad' })).toBeVisible();
  await expect(host.locator('#gl-sent .gl-sent-row')).toHaveCount(1);
  const db = await H.getDb(page);
  expect(db.shop_lists.slice(-1)[0]).toMatchObject({ from_user: 'Siti', from_role: 'kasir', to_user: 'Ahmad', street: 'Jalan Raya Condet' });
  expect(db.shop_lists.slice(-1)[0].places[0]).toMatchObject({ name: 'Toko Kurma Barokah', lat: -6.27405, lng: 106.85834 });
});
