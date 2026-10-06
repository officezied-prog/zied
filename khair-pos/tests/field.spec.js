// v8: field sales in the owner app — sales redirect, product photos, Lapangan (SVG map fallback),
// field orders → POS sale, attention items, report panel. Field data comes from shared/field-mock.js.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { rp, SHOTS, jktToday, login, getDb, nav, checkoutSkip, closeModals, photoFile, asUser, loginKasirRedirect, editDb, blockMapNetwork } = require('./helpers');

const smallJpeg = page => page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 90; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 120, 90); g.fillStyle = '#fff'; g.fillRect(20, 20, 80, 50); const d = c.toDataURL('image/jpeg', 0.6); return d.slice(d.indexOf(',') + 1); });

/** As Ahmad: start the day and check in at a shop ~450 m away from its saved location (with a photo). */
async function ahmadFarVisit(page) {
  const db = await getDb(page);
  const shop = db.shops.find(s => s.lat != null);
  await asUser(page, 'Ahmad', '4444', 'day_start', { lat: shop.lat, lng: shop.lng, acc: 10 });
  const r = await asUser(page, 'Ahmad', '4444', 'check_in', { client_id: 'far-' + Date.now(), lat: shop.lat + 0.004, lng: shop.lng, acc: 12, shop_id: shop.shop_id, photo_base64: await smallJpeg(page), photo_consent: true, outcome: 'tertarik', notes: 'Cek lokasi', next_visit: '' });
  expect(r.visit.distance_m).toBeGreaterThan(200);
  return { shop, visit: r.visit };
}

test('sales account (Ahmad) is sent to ./sales/', async ({ page }) => {
  await loginKasirRedirect(page, 'Ahmad', '4444');
  await expect(page.locator('#kasir-redirect')).toContainText('Khair Sales');
  await expect(page.locator('#kasir-go')).toHaveAttribute('href', './sales/?mock=1');
  await page.waitForURL(/\/sales\/\?mock=1$/, { timeout: 5000 });
  await expect(page.locator('body')).toContainText('sales app');
});

test('owner can create a Sales user; product photo is resized, uploaded and shown as a thumbnail', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await page.fill('#nu-name', 'Budi');
  await page.selectOption('#nu-role', 'sales');
  await page.fill('#nu-pin', '5555'); await page.fill('#nu-pin2', '5555');
  await page.click('[data-act="user-add"]');
  await expect(page.locator('#st-users')).toContainText('Budi');
  expect((await getDb(page)).users.find(u => u.name === 'Budi').role).toBe('sales');

  await nav(page, 'products');
  await expect(page.locator('#prod-table img.pthumb').first()).toBeVisible(); // seeded demo images
  await page.fill('#pr-q', 'zamzam');
  await expect(page.locator('#prod-table tbody tr')).toHaveCount(1);
  await page.click('#prod-table [data-act="prod-photo"]');
  const big = await page.evaluate(() => new Promise(res => { const c = document.createElement('canvas'); c.width = 1800; c.height = 1200; const g = c.getContext('2d'); for (let i = 0; i < 300; i++) { g.fillStyle = `hsl(${i * 7},70%,50%)`; g.fillRect(Math.random() * 1800, Math.random() * 1200, 200, 120); } c.toBlob(b => b.arrayBuffer().then(a => res(Array.from(new Uint8Array(a)))), 'image/png'); }));
  await page.setInputFiles('#pp-file', { name: 'produk.png', mimeType: 'image/png', buffer: Buffer.from(big) });
  await expect(page.locator('.toast.ok').filter({ hasText: 'Foto produk' })).toBeVisible();
  const db = await getDb(page);
  const p = db.products.find(x => /Zamzam/.test(x.name));
  const img = db.product_images.find(x => x.product_id === p.id);
  expect(img.image_base64.startsWith('/9j/')).toBe(true);
  expect(img.image_base64.length).toBeLessThanOrEqual(60000);
  expect(p.image_updated).toBe(img.image_updated);
  const dims = await page.evaluate(b => new Promise(res => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = 'data:image/jpeg;base64,' + b; }), img.image_base64);
  expect(Math.max(...dims)).toBeLessThanOrEqual(400);
  await expect(page.locator(`#prod-table tr[data-pid="${p.id}"] img.pthumb`)).toHaveAttribute('src', /^data:image\/jpeg;base64,\/9j\//);
});

test('Lapangan: SVG fallback map with route and numbered visits, far-visit warning, photo zoom, lead → customer', async ({ page }) => {
  await blockMapNetwork(page);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const { shop } = await ahmadFarVisit(page);
  // a brand-new shop found today (lead)
  const nv = await asUser(page, 'Ahmad', '4444', 'check_in', { client_id: 'new-' + Date.now(), lat: shop.lat - 0.003, lng: shop.lng + 0.002, acc: 8, shop: { name: 'Toko Baru Uji', owner_name: 'Bu Rahma', phone: '0812-0000-1111', address: 'Jl. Raya Condet 99', area: 'Condet', type: 'toko' }, outcome: 'tertarik', notes: '', photo_consent: false });
  expect(nv.shop.status).toBe('prospek');
  await nav(page, 'field');
  await expect(page.locator('#fd-map[data-mode="svg"]')).toBeVisible();
  await expect(page.locator('#fd-map polyline[data-route]')).toHaveCount(1);
  await expect(page.locator('#fd-map .c-visit')).toHaveCount(2);
  await expect(page.locator('#fd-map .c-visit.far')).toHaveCount(1);
  const card = page.locator('.rep-card[data-rep="Ahmad"]');
  await expect(card.locator('[data-status]')).toHaveText('bekerja');
  await expect(card.locator('[data-visits]')).toHaveText('2');
  await page.locator('#fd-map .c-visit.far').click();
  await expect(page.locator('#map-detail')).toContainText(shop.name);
  await expect(page.locator('#map-detail [data-far]')).toContainText('lokasi jauh dari toko');
  await expect(page.locator('#fd-visits .visit-row')).toHaveCount(2);
  await page.locator('#fd-visits img.vthumb').click();
  await expect(page.locator('.modal img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await closeModals(page);

  // a past day of the seeded route
  const db = await getDb(page);
  const day = db.field_days.filter(x => x.user === 'Ahmad' && x.day_date < jktToday()).slice(-1)[0];
  const dayVisits = db.visits.filter(v => v.user === 'Ahmad' && v.visit_date === day.day_date);
  await page.fill('#fd-date', day.day_date);
  await expect(page.locator('#fd-map .c-visit')).toHaveCount(dayVisits.length);
  await expect(card.locator('[data-status]')).toHaveText('selesai');
  await expect(page.locator('#fd-map polyline[data-route]')).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-field.png'), fullPage: true });

  // turn a new shop (lead) into a customer
  await page.fill('#fd-date', jktToday());
  const lead = page.locator(`#fd-leads .lead-row[data-shop="${nv.shop.shop_id}"]`);
  const shopId = nv.shop.shop_id;
  const shopName = (await getDb(page)).shops.find(s => s.shop_id === shopId).name;
  await lead.locator('[data-act="lead-convert"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('.toast.ok').filter({ hasText: 'pelanggan grosir' })).toBeVisible();
  const db2 = await getDb(page);
  const cust = db2.customers.find(c => c.name === shopName);
  expect(cust.type).toBe('grosir');
  expect(db2.shops.find(s => s.shop_id === shopId)).toMatchObject({ customer_id: cust.id, status: 'pelanggan' });
  expect(await page.evaluate(() => localStorage.getItem('kpos.mock.shop_links'))).toBeNull(); // linked via link_shop, not the offline fallback
  await expect(page.locator(`#fd-leads .lead-row[data-shop="${shopId}"] [data-linked]`)).toBeVisible();
});

test('Pesanan sales: badge, open order, Proses → POS sale → order diproses with invoice; Batal with note', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  let db = await getDb(page);
  const nNew = db.field_orders.filter(o => o.status === 'baru').length;
  expect(nNew).toBeGreaterThan(0);
  await nav(page, 'orders');
  await expect(page.locator('#nav [data-view="orders"] [data-orders-new]')).toHaveText(String(nNew));
  await expect(page.locator('#fo-list .fo-row')).toHaveCount(nNew);
  const o = db.field_orders.filter(x => x.status === 'baru').sort((a, b) => String(b.order_time).localeCompare(String(a.order_time)))[0];
  const items = JSON.parse(o.items);
  await page.click(`[data-act="order-open"][data-id="${o.order_id}"]`);
  await expect(page.locator('#fo-items tbody tr')).toHaveCount(items.length);
  await expect(page.locator('#fo-total')).toHaveText(rp(o.total));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-field-order.png') });
  await page.click('#fo-process');
  await expect(page.locator('#view-pos')).toBeVisible();
  await expect(page.locator('#cart-fo')).toContainText(o.order_id);
  await expect(page.locator('.cline')).toHaveCount(items.length);
  // v16: goods of the order still in the warehouse → the POS offers to move them to the shelf and save
  await page.click('#btn-checkout');
  await expect(page.locator('.modal #receipt, #shelf-modal').first()).toBeVisible();
  if (await page.locator('#shelf-modal').count()) await page.click('#ns-move');
  await expect(page.locator('.modal #receipt')).toBeVisible();
  const inv = (await page.locator('.modal #receipt').innerText()).match(/KM\d{6}-\d{4}/)[0];
  await expect.poll(async () => (await getDb(page)).field_orders.find(x => x.order_id === o.order_id).status).toBe('diproses');
  db = await getDb(page);
  expect(db.field_orders.find(x => x.order_id === o.order_id).invoice_no).toBe(inv);
  const sale = db.sales.find(s => s.invoice_no === inv);
  const shop = db.shops.find(s => s.shop_id === o.shop_id);
  expect(shop.customer_id).toBeTruthy();
  expect(sale.customer_id).toBe(shop.customer_id);
  expect(db.items.filter(i => i.invoice_no === inv).map(i => [i.product_id, i.qty])).toEqual(items.map(i => [i.product_id, i.qty]));
  await closeModals(page);

  // cancel another order with a note
  const other = db.field_orders.find(x => x.status === 'baru');
  if (other) {
    await nav(page, 'orders');
    await page.click(`[data-act="order-open"][data-id="${other.order_id}"]`);
    await page.fill('#fo-note', 'Toko minta tunda');
    await page.click('#fo-cancel');
    await page.click('#cf-ok');
    await expect.poll(async () => (await getDb(page)).field_orders.find(x => x.order_id === other.order_id).status).toBe('batal');
  }
});

test('Perlu perhatian: new field orders, silent rep (> 30 min), far visits, overdue next visits; Lapangan panel in reports', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await ahmadFarVisit(page);
  // the rep's last signal was 45 minutes ago
  await editDb(page, `const T = new Date(Date.now() + 7*3600000).toISOString().slice(0,10); const old = new Date(Date.now() - 45*60000 + 7*3600000).toISOString().slice(0,19) + '+07:00';
    db.tracks.filter(x => x.user === 'Ahmad' && x.track_date === T).forEach(x => x.t = old);
    db.visits.filter(x => x.user === 'Ahmad' && x.visit_date === T).forEach(x => x.visit_time = old);
    db.field_days.filter(x => x.user === 'Ahmad' && x.day_date === T).forEach(x => x.started_at = old);`);
  await page.evaluate(() => KPOS.refreshAttention(true));
  const db = await getDb(page);
  const T = jktToday();
  await page.click('#tb-bell');
  const att = page.locator('#bell-att');
  await expect(att).toContainText(`${db.field_orders.filter(o => o.status === 'baru').length} pesanan sales baru`);
  await expect(att).toContainText('Sales Ahmad bekerja tapi tidak mengirim lokasi > 30 menit (terakhir 45 mnt lalu)');
  await expect(att).toContainText('kunjungan jauh dari lokasi toko');
  const latest = {}; db.visits.forEach(v => { if (!latest[v.shop_id] || v.visit_time > latest[v.shop_id].visit_time) latest[v.shop_id] = v; });
  const due = new Set(Object.values(latest).filter(v => v.next_visit && v.next_visit < T).map(v => v.shop_id));
  db.shops.forEach(s => { const lv = latest[s.shop_id]; if (s.next_visit && s.next_visit < T && !(lv && lv.visit_date >= s.next_visit)) due.add(s.shop_id); });
  if (due.size) await expect(att).toContainText(`${due.size} toko lewat jadwal kunjungan ulang`);
  await att.locator('[data-go="orders"]').click();
  await expect(page.locator('#view-orders')).toBeVisible();

  // reports: Lapangan panel per rep
  await nav(page, 'reports');
  await page.click('[data-act="rep-preset"][data-p="month"]');
  const from = T.slice(0, 8) + '01';
  const row = page.locator('#rp-field-table tr[data-rep="Ahmad"]');
  const v = db.visits.filter(x => x.user === 'Ahmad' && x.visit_date >= from && x.visit_date <= T).length;
  const o = db.field_orders.filter(x => x.user === 'Ahmad' && x.order_date >= from && x.order_date <= T && x.status !== 'batal').length;
  await expect(row.locator('[data-c="visits"]')).toHaveText(String(v));
  await expect(row.locator('[data-c="orders"]')).toHaveText(String(o));
  await expect(row.locator('[data-c="conv"]')).toHaveText(new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(o / v * 100) + '%');
});
