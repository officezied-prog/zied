// Check-in: GPS fix with accuracy → nearby shop (< 150 m) or new shop → photo with consent → outcome → check_in.
const H = require('./helpers'); const { test, expect } = H;

test('check-in at a NEW shop with a photo of the owner (consent required, ≤ 400 px, ≤ 45 KB)', async ({ page, context }) => {
  await H.login(page);
  await H.setPos(context, -6.2580, 106.8640, 9);
  await H.startDay(page);
  await H.tab(page, 'visit');
  await expect(page.locator('#ci-fix')).toContainText('± 9 m');
  await page.click('#ci-new');
  await page.fill('#ci-name', 'Toko Kurma Pak Umar');
  await page.fill('#ci-owner', 'Pak Umar');
  await page.fill('#ci-phone', '0812-3456-7890');
  await page.fill('#ci-address', 'Jl. Raya Condet No. 99');
  await page.fill('#ci-area', 'Condet');
  await H.pickType(page, 'toko');
  await page.setInputFiles('#ci-photo-back', await H.photoFile(page));
  await expect(page.locator('#ci-thumb')).toBeVisible();
  const kb = parseInt(await page.locator('#ci-photo-kb').textContent());
  expect(kb).toBeLessThanOrEqual(45);
  await page.click('#oc-tertarik');
  await page.fill('#ci-notes', 'Minta katalog Ramadan');
  await page.click('[data-act="ci-next"][data-n="3"]');
  await H.shot(page, 'phone-08-checkin-new', true);
  // without the owner's consent the photo is not sent
  await page.click('#ci-ok');
  await expect(page.locator('#ci-err')).toContainText('persetujuan pemilik toko');
  await page.check('#ci-consent');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.ok', { hasText: 'Toko Kurma Pak Umar' })).toBeVisible();
  const db = await H.getDb(page);
  const shop = db.shops.find(s => s.name === 'Toko Kurma Pak Umar');
  expect(shop).toMatchObject({ owner_name: 'Pak Umar', area: 'Condet', type: 'toko', status: 'prospek', created_by: 'Ahmad', lat: -6.258, lng: 106.864 });
  const v = db.visits[db.visits.length - 1];
  expect(v).toMatchObject({ shop_id: shop.shop_id, outcome: 'tertarik', notes: 'Minta katalog Ramadan', user: 'Ahmad', acc: 9, distance_m: 0, photo_consent: true });
  expect(v.photo_thumb.length).toBeLessThanOrEqual(45 * 1024);
  expect(v.photo_thumb.startsWith('/9j/')).toBe(true); // JPEG
  const dims = await page.evaluate(b => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = 'data:image/jpeg;base64,' + b; }), v.photo_thumb);
  expect(Math.max(...dims)).toBeLessThanOrEqual(400);
  expect(v.next_visit).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // the check-in point is in the track (working hours)
  expect(db.tracks.some(x => x.user === 'Ahmad' && x.lat === -6.258 && x.lng === 106.864)).toBe(true);
  await expect(page.locator('#st-visits')).toHaveText('1');
});

test('check-in at an EXISTING shop nearby (< 150 m), with the Google Maps route link', async ({ page, context }) => {
  await H.openSales(page);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  const db0 = await H.getDb(page);
  const shop = db0.shops.find(s => s.status === 'pelanggan');
  await H.setPos(context, shop.lat + 0.0004, shop.lng, 15); // ~45 m away
  await H.startDay(page);
  await H.tab(page, 'visit');
  const near = page.locator(`#ci-near [data-act="ci-pick"][data-id="${shop.shop_id}"]`);
  await expect(near).toBeVisible();
  await expect(near).toContainText(' m');
  await H.shot(page, 'phone-09-checkin-nearby');
  await near.click();
  await expect(page.locator('#ci-selected')).toContainText(shop.name);
  await page.click('#oc-sudah_pelanggan');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.ok', { hasText: shop.name })).toBeVisible();
  const db = await H.getDb(page);
  const v = db.visits[db.visits.length - 1];
  expect(v).toMatchObject({ shop_id: shop.shop_id, outcome: 'sudah_pelanggan' });
  expect(v.distance_m).toBeGreaterThan(30); expect(v.distance_m).toBeLessThan(60);
  expect(db.shops.find(s => s.shop_id === shop.shop_id).visits).toBe(shop.visits + 1);
  expect(db.shops.length).toBe(db0.shops.length); // no new shop
  // Toko saya: route link
  await H.tab(page, 'shops');
  await expect(page.locator(`#sh-list [data-shop="${shop.shop_id}"] a[data-dir]`)).toHaveAttribute('href', `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(shop.lat + ',' + shop.lng)}`);
  await page.click('#sh-map-btn');
  await expect(page.locator('#shops-map')).toHaveAttribute('data-mode', 'svg');
  expect(await page.locator('#shops-map [data-shop]').count()).toBeGreaterThan(10);
  await H.shot(page, 'phone-10-shops-map');
});

test('offline: check-in at a new shop + an order are queued, then synced in order when back online', async ({ page, context }) => {
  await H.login(page);
  await H.setPos(context, -6.2620, 106.8570, 20);
  await H.startDay(page);
  await context.setOffline(true);
  await H.tab(page, 'visit');
  await page.click('#ci-new');
  await page.fill('#ci-name', 'Warung Offline Bu Ani');
  await H.pickType(page, 'warung');
  await page.click('#oc-order');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.warn', { hasText: 'Offline' }).first()).toBeVisible();
  // outcome "order" → straight to the order for that (still pending) shop
  await expect(page.locator('#po-shop')).toContainText('Warung Offline Bu Ani');
  await page.fill('#po-q', 'sukkari');
  await page.locator('#po-sug [data-act="po-add"]').first().click();
  await page.click('#po-ok');
  await expect(page.locator('#order-done')).toContainText('offline');
  await H.closeModals(page);
  await expect(page.locator('#po-list [data-status="pending"]').first()).toBeVisible();
  const n = Number(await page.locator('#tb-outbox-n').textContent());
  expect(n).toBeGreaterThanOrEqual(2);
  await H.shot(page, 'phone-11-offline-queued');
  let db = await H.getDb(page);
  expect(db.shops.some(s => s.name === 'Warung Offline Bu Ani')).toBe(false);

  await context.setOffline(false);
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 15000 });
  db = await H.getDb(page);
  const shop = db.shops.find(s => s.name === 'Warung Offline Bu Ani');
  expect(shop).toBeTruthy();
  expect(db.visits.some(v => v.shop_id === shop.shop_id && v.outcome === 'order')).toBe(true);
  const o = db.field_orders[db.field_orders.length - 1];
  expect(o).toMatchObject({ shop_id: shop.shop_id, status: 'baru', user: 'Ahmad' });
  expect(JSON.parse(o.items)[0].name).toMatch(/Sukkari/);
  await expect(page.locator('#po-list [data-status="baru"]').first()).toBeVisible();
});
