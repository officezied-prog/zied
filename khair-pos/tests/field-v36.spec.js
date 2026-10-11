// v36 (owner 2026-10-11): the field page in the owner app —
//  · the visits table: name, place, shop type, shop owner, star rating, note (+ a new shop's two photos), for the owner, the
//    manager AND the accountant (who now opens the field page read-only);
//  · a new shop's photos (owner with the rep + shop front) on the new-shop rows;
//  · every rep's orders on one map, numbered in acceptance order, a colour per rep, "which area orders most";
//  · the good streets to go back to, the return time set by the manager / owner, and the owner's notice.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, closeModals, asUser, editDb, blockMapNetwork, openApp, enterKey, staffSession } = require('./helpers');

const jpeg = (page, color) => page.evaluate(c => { const cv = document.createElement('canvas'); cv.width = 120; cv.height = 90; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 120, 90); const d = cv.toDataURL('image/jpeg', 0.6); return d.slice(d.indexOf(',') + 1); }, color);

/** As Ahmad: a new shop today with both photos and 4 stars, and a visit (3 stars) to an existing shop. */
async function newShopVisit(page) {
  const db = await getDb(page);
  const shop = db.shops.find(s => s.lat != null && s.owner_name);
  await asUser(page, 'Ahmad', '4444', 'day_start', { lat: shop.lat, lng: shop.lng, acc: 10 });
  const owner = await jpeg(page, '#c33'), front = await jpeg(page, '#33c');
  const nv = await asUser(page, 'Ahmad', '4444', 'check_in', { client_id: 'v36-' + Date.now(), lat: shop.lat - 0.002, lng: shop.lng + 0.001, acc: 8, rating: 4, notes: 'Mau coba kurma',
    shop: { name: 'Toko Foto Dua', owner_name: 'Bu Sari', phone: '0812-7777-1111', address: 'Jl. Dukuh No. 5', area: 'Dukuh', type: 'toko_kurma' }, outcome: 'tertarik',
    photo_base64: owner, photo_consent: true, shop_photo_base64: front });
  expect(nv.warnings).toEqual([]);
  expect(nv.shop.photo_visit).toBe(nv.visit.visit_id);
  await asUser(page, 'Ahmad', '4444', 'check_in', { client_id: 'v36b-' + Date.now(), lat: shop.lat, lng: shop.lng, acc: 8, rating: 3, shop_id: shop.shop_id, outcome: 'sudah_pelanggan', notes: '' });
  return { shop, nv, owner, front };
}

test('visits table: place, shop type, owner, stars, note and both photos of a new shop; star rating in the visit list and popup', async ({ page }) => {
  await blockMapNetwork(page);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const { shop, nv, owner, front } = await newShopVisit(page);
  await nav(page, 'field');
  const table = page.locator('#fd-vtable');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  const r1 = table.locator(`tr[data-visit="${nv.visit.visit_id}"]`);
  await expect(r1.locator('[data-c="shop"]')).toContainText('Toko Foto Dua');
  await expect(r1.locator('[data-c="shop"]')).toContainText('0812-7777-1111');
  await expect(r1.locator('[data-c="place"]')).toHaveText('Dukuh · Jl. Dukuh No. 5');
  await expect(r1.locator('[data-c="type"]')).toContainText('Toko kurma');
  await expect(r1.locator('[data-c="owner"]')).toHaveText('Bu Sari');
  await expect(r1.locator('[data-c="rating"] .stars-ro')).toHaveAttribute('data-rating', '4');
  await expect(r1.locator('[data-c="rating"] .on')).toHaveCount(4);
  await expect(r1.locator('[data-c="note"]')).toHaveText('Mau coba kurma');
  await expect(r1.locator('[data-c="photos"] img')).toHaveCount(2);
  await expect(r1.locator('[data-c="photos"] img.vshop')).toHaveAttribute('src', 'data:image/jpeg;base64,' + front);
  const r2 = table.locator('tbody tr').filter({ hasText: shop.name });
  await expect(r2.locator('[data-c="owner"]')).toHaveText(shop.owner_name);
  await expect(r2.locator('[data-c="rating"] .stars-ro')).toHaveAttribute('data-rating', '3');
  // the visit list (map numbering) shows the stars and the type / owner too
  await expect(page.locator(`#fd-visits .visit-row[data-visit="${nv.visit.visit_id}"] .stars-ro`)).toHaveAttribute('data-rating', '4');
  await expect(page.locator(`#fd-visits .visit-row[data-visit="${nv.visit.visit_id}"]`)).toContainText('Bu Sari');
  // popup of the simple map
  await page.locator('#fd-map .c-visit').first().click();
  await expect(page.locator('#map-detail .stars-ro')).toHaveAttribute('data-rating', '4');
  await expect(page.locator('#map-detail [data-vp-shop]')).toContainText('Toko kurma');
  await expect(page.locator('#map-detail [data-vp-shopphoto]')).toBeVisible();
  // the new shop row: its address and both photos (read when opened)
  const lead = page.locator(`#fd-leads .lead-row[data-shop="${nv.shop.shop_id}"]`);
  await expect(lead.locator('[data-address]')).toContainText('Jl. Dukuh No. 5');
  await lead.locator('[data-act="lead-photos"]').click();
  await expect(page.locator('#shop-photos [data-ph="shop"] img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + front);
  await expect(page.locator('#shop-photos [data-ph="owner"] img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + owner);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-field-photos.png') });
  await closeModals(page);
  await page.locator('#fd-vtable-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-field-visits-table.png') });
  // Arabic
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#fd-vtable-panel h3')).toContainText('جدول الزيارات');
  await expect(page.locator('#fd-vtable thead')).toContainText('صاحب المحل');
});

async function addAkuntan(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
}

test('the accountant opens the field page read-only: visits table, orders map, streets — no boss actions', async ({ page }) => {
  await addAkuntan(page);
  expect((await asUser(page, 'Lestari', '5555', 'field_bootstrap')).ok).toBe(true); // the demo field data is written
  const { nv } = await newShopVisit(page);
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'field');
  await expect(page.locator('#view-field')).toBeVisible();
  await expect(page.locator(`#fd-vtable tr[data-visit="${nv.visit.visit_id}"] [data-c="rating"] .stars-ro`)).toHaveAttribute('data-rating', '4');
  await expect(page.locator('#fd-gtest')).toHaveCount(0); // Google test: owner / manager only
  await expect(page.locator('#fd-leads [data-act="lead-convert"]')).toHaveCount(0); // "make customer" is not his
  await page.locator(`#fd-leads .lead-row[data-shop="${nv.shop.shop_id}"] [data-act="lead-photos"]`).click();
  await expect(page.locator('#shop-photos [data-ph="shop"] img')).toBeVisible();
  await closeModals(page);
  await page.click('[data-act="field-rep"][data-u="Ahmad"]'); // allowed: choosing a rep
  await expect(page.locator('.toast.warn')).toHaveCount(0);
  // the streets panel: the return time is shown, not editable
  await expect(page.locator('#fd-sr-set')).toContainText('14 hari');
  await expect(page.locator('#fd-sr-days')).toHaveCount(0);
  // orders map (30 days): an order opens read-only
  await page.click('#fd-om-r-30');
  await expect(page.locator('#fd-om-n')).not.toHaveText('…');
  await page.locator('#fd-om-map .om-pin').first().click();
  await page.locator('.leaflet-popup [data-act="fd-om-open"]').click();
  await expect(page.locator('#fo-modal')).toBeVisible();
  await expect(page.locator('#fo-process, #fo-cancel, #fo-ship, #fo-note')).toHaveCount(0);
  await closeModals(page);
  // the server lets him read but not change the return time
  expect((await asUser(page, 'Lestari', '5555', 'street_return_set', { days: 30 })).error).toBe('FORBIDDEN');
});

test('orders map: every rep\'s orders of the period, numbered in acceptance order, a colour per rep, area summary, tap = the order', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const T = jktToday();
  // today: Ahmad 08:10 (Condet) → Budi 09:00 (Cililitan) → Ahmad 10:30 (Condet); a cancelled one is left out
  await editDb(page, `const T = '${T}'; const shops = db.shops.filter(s => s.lat != null);
    const a = shops.find(s => s.area === 'Condet'), b = shops.find(s => s.area === 'Cililitan'), c = shops.filter(s => s.area === 'Condet')[1];
    db.users.push({ name: 'Budi', role: 'sales', pin_hash: 'x', active: true });
    const mk = (id, u, sh, time, total, st) => ({ order_id: id, client_id: id, user: u, order_date: T, order_time: T + 'T' + time + ':00+07:00', shop_id: sh.shop_id, shop_name: sh.name, items: JSON.stringify([{ product_id: db.products[0].id, name: db.products[0].name, qty: 2, unit_price: 1000, line_total: total }]), total, notes: '', delivery_date: '', status: st || 'baru', invoice_no: '', updated_by: '', status_note: '' });
    db.field_orders = db.field_orders.filter(o => o.order_date !== T);
    db.field_orders.push(mk('OM-3', 'Ahmad', c, '10:30', 30000), mk('OM-1', 'Ahmad', a, '08:10', 10000), mk('OM-2', 'Budi', b, '09:00', 20000), mk('OM-X', 'Budi', b, '07:00', 5, 'batal'));`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'field');
  await expect(page.locator('#fd-om-n')).toHaveText('3');
  await expect(page.locator('#fd-om-map')).toHaveAttribute('data-mode', 'leaflet');
  const pins = page.locator('#fd-om-map .om-pin');
  await expect(pins).toHaveCount(3);
  await expect(page.locator('#fd-om-map .om-pin[data-seq="1"]')).toHaveAttribute('data-user', 'Ahmad');
  await expect(page.locator('#fd-om-map .om-pin[data-seq="2"]')).toHaveAttribute('data-user', 'Budi');
  await expect(page.locator('#fd-om-map .om-pin[data-seq="3"]')).toHaveAttribute('data-user', 'Ahmad');
  const col = async s => page.locator(`#fd-om-map .om-pin[data-seq="${s}"]`).evaluate(e => e.style.getPropertyValue('--c'));
  expect(await col(1)).toBe(await col(3));
  expect(await col(1)).not.toBe(await col(2));
  await expect(page.locator('#fd-om-legend [data-om-user="Ahmad"]')).toContainText('2');
  await expect(page.locator('#fd-om-area-table tbody tr').first()).toHaveAttribute('data-area', 'Condet');
  await expect(page.locator('#fd-om-area-table tr[data-area="Condet"] [data-c="n"]')).toHaveText('2');
  await page.locator('#fd-om-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-field-orders-map.png') });
  // tap the first pin → the order
  await page.locator('#fd-om-map .om-pin[data-seq="1"]').click();
  await expect(page.locator('.leaflet-popup .om-pop')).toContainText('#1');
  await page.locator('.leaflet-popup [data-act="fd-om-open"]').click();
  await expect(page.locator('#fo-modal')).toContainText('OM-1');
  await expect(page.locator('#fo-process')).toHaveCount(0); // v36: the owner no longer sells — the manager turns it into a sale
  await closeModals(page);
  // one rep only
  await page.selectOption('#fd-om-user', 'Budi');
  await expect(page.locator('#fd-om-n')).toHaveText('1');
  await expect(pins).toHaveCount(1);
  // 30 days: the seeded orders too; numbers stay in acceptance order
  await page.selectOption('#fd-om-user', '');
  await page.click('#fd-om-r-30');
  const db = await getDb(page);
  const n30 = db.field_orders.filter(o => o.status !== 'batal' && o.order_date >= jktToday(-29)).length;
  await expect(page.locator('#fd-om-n')).toHaveText(String(n30));
  await expect(page.locator('#fd-om-map .om-pin, #fd-om-map .clu').first()).toBeVisible();
});

test('orders map without the map library: the simple map with numbered pins, tap shows the order', async ({ page }) => {
  await blockMapNetwork(page);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'field');
  await page.click('#fd-om-r-30');
  await expect(page.locator('#fd-om-map')).toHaveAttribute('data-mode', 'svg');
  const n = Number(await page.locator('#fd-om-n').textContent());
  expect(n).toBeGreaterThan(0);
  await page.locator('#fd-om-map [data-oi="1"]').click();
  await expect(page.locator('#fd-om-detail .om-pop')).toContainText('#1');
});

test('good streets to go back to: listed per rep, the manager / owner sets the return time, the owner gets a notice', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await editDb(page, `const cust = db.shops.filter(s => s.status === 'pelanggan' && s.lat != null).slice(0, 2);
    const ago = n => new Date(Date.now() + 7 * 3600000 - n * 86400000).toISOString().slice(0, 10);
    db.route_plans = db.route_plans || [];
    db.route_plans.push({ plan_id: 'SRA', user: 'Ahmad', plan_date: ago(20), start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'st:jalan kembali', name: 'Jalan Kembali', lines: [[[cust[0].lat, cust[0].lng], [cust[1].lat, cust[1].lng]]] }] });
    db.route_plans.push({ plan_id: 'SRB', user: 'Ahmad', plan_date: ago(25), start: null, end: null, stops: [], note: '', updated_at: '',
      streets: [{ ref: 'st:jalan kosong', name: 'Jalan Kosong', lines: [[[-6.40, 106.70], [-6.41, 106.70]]] }] });`);
  await page.evaluate(() => KPOS.refreshAttention(true));
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att')).toContainText('1 jalan bagus sudah lewat 14 hari');
  await page.locator('#bell-att [data-key="streets"]').click();
  await expect(page.locator('#view-field')).toBeVisible();
  const row = page.locator('#fd-sr-list .sr-row[data-k="st:jalan kembali"]');
  await expect(row).toContainText('lewat 6 hari');
  await expect(row.locator('[data-why]')).toContainText('2 pelanggan');
  await expect(page.locator('#fd-sr-list [data-sr-user="Ahmad"]')).toBeVisible();
  await expect(page.locator('#fd-sr-list .sr-row[data-k="st:jalan kosong"]')).toHaveCount(0); // no shop along it: not a good street
  await expect(page.locator('#fd-sr-n')).toHaveText('1');
  await page.locator('#fd-sr-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-field-street-return.png') });
  // the return time: 3–90 days; 30 days → not due any more
  await page.fill('#fd-sr-days', '2');
  await page.click('#fd-sr-save');
  await expect(page.locator('.toast.err')).toContainText('3–90');
  await page.fill('#fd-sr-days', '30');
  await page.click('#fd-sr-save');
  await expect(page.locator('.toast.ok').filter({ hasText: '30 hari' })).toBeVisible();
  await expect(page.locator('#fd-sr-none')).toBeVisible();
  await expect(page.locator('#fd-sr-later')).toContainText('1 jalan bagus lainnya');
  expect((await getDb(page)).settings.street_return_days).toBe(30);
  await page.evaluate(() => KPOS.refreshAttention(true));
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att')).not.toContainText('jalan bagus');
});
