// v63 (owner 2026-10-20) — Khair Order Brad (brad/?mock=1), stage 3: the Lalamove car booked automatically.
//  «ابدأ المرحلة الثالثة: طلب سيارة لالاموف تلقائيًا». A fourth way in the car step ("Pesan Lalamove otomatis"): the server prices the trip
//  (the cooler → where the goods go) and books it through Lalamove's official API, then follows it — the driver and the plate on the
//  order and to the cold store, picked up = departed, completed = delivered. The demo plays Lalamove (a price by distance, a fake
//  order, the demo phone's buttons "Sopir ditemukan / Barang diambil / Selesai / Dibatalkan"). Not set up → the manual ways only.
// The test fixes the page's clock (WIB): 2026-10-14 is a Wednesday.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS } = require('./helpers');

async function bradLogin(page, at, user = 'Jihan', pin = '2222') {
  await page.clock.setFixedTime(new Date(at));
  await page.goto('brad/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kbrad.mock.db'); localStorage.removeItem('kcold.mock.db'); localStorage.removeItem('kbrad.mock.wa'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', user);
  await page.fill('#lg-pin', pin);
  await page.click('#lg-go');
  await expect(page.locator('#nav')).toBeVisible();
}
const card = (page, no) => page.locator(`.order[data-no="${no}"]`);
const waText = page => page.locator('#wa-text').textContent();
async function waDone(page) { await page.evaluate(() => { document.querySelector('#wa-go').removeAttribute('target'); document.querySelector('#wa-go').setAttribute('href', '#'); }); await page.click('#wa-go'); await expect(page.locator('#modal')).toBeHidden(); }
const WA_LOC = 'https://maps.google.com/maps?q=-6.2615%2C106.8685&z=17&hl=en'; // a location shared on WhatsApp
/** An order of `n` cartons of pallet 2274537 (Sukari 3 kg) for Toko Barokah, where the goods go pasted, up to "Barang siap". */
async function readyOrder(page, n, geo) {
  await page.click('#or-new');
  await page.selectOption('#of-wh', 'DPP');
  await page.selectOption('#of-lines [data-f="pallet_code"]', '2274537');
  await page.fill('#of-lines [data-f="cartons"]', String(n));
  await page.selectOption('#of-cust', await page.locator('#of-cust option', { hasText: 'Toko Barokah' }).getAttribute('value'));
  if (geo !== undefined) await page.fill('#of-dgeo', geo);
  await page.click('#of-save');
  await expect(page.locator('#modal')).toBeHidden();
  const no = await page.evaluate(() => S.D.orders[0].order_no), c = card(page, no);
  await c.locator('[data-act="send"]').click();
  await waDone(page);
  await c.locator('[data-act="approve"]').click();
  await c.locator('[data-act="ready"]').click();
  await expect(c.locator('[data-chip]')).toHaveText('4/9 Barang siap');
  return no;
}

test('settings: Lalamove on (demo), the month\'s cap and spend, the shop\'s and each cooler\'s place (a Maps link or "lat,lng"), "Tes koneksi"', async ({ page }) => {
  await bradLogin(page, '2026-10-14T10:00:00+07:00', 'Pemilik', '1234');
  await page.click('[data-tab="set"]');
  const k = page.locator('#la-card');
  await expect(k.locator('h2')).toHaveText('Lalamove otomatis');
  await expect(page.locator('#la-on')).toHaveText('Aktif — DEMO (simulasi)');
  await expect(page.locator('#la-month')).toHaveText('Bulan ini: Rp 0 dari Rp 10.000.000');
  await expect(page.locator('#la-svcs')).toContainText('Pickup (bak)');
  await expect(page.locator('#la-hook')).toHaveText('Webhook untuk Lalamove: https://khair-mart-jumla.officezied.workers.dev/webhook/lalamove');
  await expect(k.locator('[data-geo="DPP"]')).toHaveValue('-6.1214,106.9021'); // the demo's places
  // a place that cannot be read is said; a Google Maps link gives its pin
  await k.locator('[data-geo="DPP"]').fill('dekat pelabuhan');
  await page.click('#la-save');
  await expect(page.locator('#toast')).toContainText('Lokasi gudang DPP Cold Storage tidak terbaca');
  await k.locator('[data-geo="DPP"]').fill('https://www.google.com/maps/place/DPP+Cold+Storage/@-6.12,106.90,17z/data=!3d-6.1199!4d106.9033');
  await page.fill('#la-cap', '2.000.000');
  await page.fill('#la-store', '-6.2788, 106.8631');
  await page.click('#la-save');
  await expect(page.locator('#toast')).toHaveText('Tersimpan');
  await expect(page.locator('#la-card [data-geo="DPP"]')).toHaveValue('-6.1199,106.9033');
  await expect(page.locator('#la-store')).toHaveValue('-6.2788,106.8631');
  await expect(page.locator('#la-month')).toHaveText('Bulan ini: Rp 0 dari Rp 2.000.000');
  // the cooler's WhatsApp and hours saved again: its place stays
  await page.locator('[data-cooler="DPP"] [data-save="DPP"]').click();
  await expect(page.locator('#toast')).toHaveText('Tersimpan');
  expect(await page.evaluate(() => [S.D.coolers.find(c => c.code === 'DPP').lat, S.D.coolers.find(c => c.code === 'DPP').lng])).toEqual([-6.1199, 106.9033]);
  await page.click('#la-test');
  await expect(page.locator('#toast')).toHaveText('Terhubung: 5 jenis kendaraan (Jakarta (demo))');
});

test('the whole automatic car: the destination pasted (prefilled next time), "Cek harga", "Pesan sekarang"; Lalamove finds a driver → driver, plate and tracking link on the order; picked up → departed', async ({ page }) => {
  await bradLogin(page, '2026-10-14T10:00:00+07:00');
  const no = await readyOrder(page, 200, WA_LOC);
  expect(await page.evaluate(n => { const o = S.D.orders.find(x => x.order_no === n); return [o.dest_lat, o.dest_lng]; }, no)).toEqual([-6.2615, 106.8685]);
  // the same customer next time: his place from that order
  await page.click('#or-new');
  await page.selectOption('#of-cust', await page.locator('#of-cust option', { hasText: 'Toko Barokah' }).getAttribute('value'));
  await expect(page.locator('#of-dgeo')).toHaveValue('-6.2615,106.8685');
  await expect(page.locator('#of-dgeo-hint')).toHaveText('Diisi dari order sebelumnya pelanggan ini');
  await page.click('#md-close');
  // step 5, the fourth way: the vehicle proposed by the weight (200 ctn × 3 kg), now (40 min + 20 %), where the goods go
  const c = card(page, no);
  await c.locator('[data-act="lala-auto"]').click();
  await expect(page.locator('#tk-via')).toHaveValue('lalamove_api');
  await expect(page.locator('#tk-lala')).toBeVisible();
  await expect(page.locator('#tk-driver')).toBeHidden();
  await expect(page.locator('#tk-save')).toBeHidden();
  await expect(page.locator('#tk-lsug')).toHaveText('Saran untuk ± 600 kg: Pickup (bak)');
  await expect(page.locator('#tk-lsvc')).toHaveValue('TRUCK175');
  await expect(page.locator('#tk-lwhen')).toHaveValue('now');
  await expect(page.locator('#tk-lgeo')).toHaveValue('-6.2615,106.8685');
  await expect(page.locator('#tk-laddr')).toHaveValue('Jl. Dewi Sartika 5, Jakarta Timur');
  await expect(page.locator('#tk-lphone')).toHaveValue('6281300000020');
  await expect(page.locator('#tk-lbook')).toBeDisabled();
  await page.click('#tk-lquote');
  await expect(page.locator('#tk-lprice')).toHaveText(/^Harga Lalamove: Rp \d{3}\.000 · \d+,\d km · berlaku sampai 10:05$/);
  await expect(page.locator('#tk-leta')).toHaveText('Mobil di gudang ± 10:48');
  await expect(page.locator('#tk-lspent')).toHaveText('Bulan ini Rp 0 dari batas Rp 10.000.000');
  const price = await page.evaluate(() => Number(document.querySelector('#tk-lprice').textContent.match(/Rp ([\d.]+)/)[1].replace(/\./g, '')));
  await page.click('#tk-lbook');
  await expect(page.locator('#toast')).toHaveText('Lalamove dipesan — mencari sopir');
  await expect(page.locator('#modal')).toBeHidden();
  await expect(c.locator('[data-chip]')).toHaveText('5/9 Mobil dipesan');
  await expect(c.locator('[data-lala-st]')).toHaveText('mencari sopir');
  await expect(c.locator('[data-lala-price]')).toHaveText(' · Rp ' + price.toLocaleString('id-ID'));
  await expect(c.locator('[data-lala-track]')).toHaveAttribute('href', /^https:\/\/share\.lalamove\.com\/\?ID=DEMO-\d+&lang=id_ID$/);
  await expect(c.locator('[data-lala-track]')).toHaveAttribute('target', '_blank');
  await expect(c.locator('[data-log]')).toContainText('Lalamove otomatis · Pickup (bak) · Rp ' + price.toLocaleString('id-ID') + ' · mobil dipesan, mencari sopir · tiba ± 10:48');
  // a car booked by the server is cancelled at Lalamove, never typed over
  await expect(c.locator('[data-act="lala-cancel"]')).toHaveText('Batalkan Lalamove');
  await expect(c.locator('[data-act="car-cancel"]')).toHaveCount(0);
  await expect(c.locator('[data-act="car-edit"]')).toHaveCount(0);
  // the demo phone: Lalamove finds a driver → his name, plate and WhatsApp on the order; the car's details to the cold store
  await expect(c.locator('[data-dm="lala"]')).toContainText('Lalamove (simulasi)');
  await c.locator('[data-act="dm-la-driver"]').click();
  await expect(c.locator('[data-lala-st]')).toHaveText('sopir menuju gudang');
  await expect(c.locator('[data-car]')).toHaveText('Mobil: B 9876 TKL · Pak Slamet · Pickup (bak) · tiba ± 10:48');
  await expect(c.locator('[data-lala-carwa]')).toHaveText('Sopir ditemukan — kirim data mobil ke gudang (WhatsApp).'); // WhatsApp not set up in this demo
  await expect(c.locator('[data-lala-track]')).toBeVisible();
  await c.screenshot({ path: path.join(SHOTS, 'brad-lalamove.png') });
  await c.locator('[data-act="car-wa"]').click();
  expect(await waText(page)).toBe('Order ' + no + ' — mobil untuk ambil di DPP Cold Storage:\nKendaraan: Pickup (bak)\nNo. polisi: B 9876 TKL\nSopir: Pak Slamet (081300000077)\nPerkiraan tiba: 10:48\nTerima kasih.');
  await waDone(page);
  // the car is in at door 5 (as before); Lalamove: the goods picked up → the departure (the stock goes down), the customer told
  await c.locator('[data-act="arrived"]').click();
  await page.fill('#in-door', '5');
  await page.click('#in-save');
  await waDone(page);
  await expect(c.locator('[data-chip]')).toHaveText('7/9 Ke pintu');
  const stock = () => page.evaluate(() => JSON.parse(localStorage.getItem('kcold.mock.db')).movements.filter(m => m.pallet_code === '2274537' && m.warehouse === 'DPP').reduce((s, m) => s + m.cartons, 0));
  const s0 = await stock();
  await c.locator('[data-act="dm-la-picked"]').click();
  await expect(c.locator('[data-chip]')).toHaveText('9/9 Berangkat');
  await expect(c.locator('[data-lala-st]')).toHaveText('barang diambil');
  await expect(c.locator('[data-log]')).toContainText('Lalamove: barang diambil');
  expect(await stock()).toBe(s0 - 200);
  // done → delivered (the order leaves today's list)
  await c.locator('[data-act="dm-la-done"]').click();
  await page.click('[data-tab="all"]');
  await page.selectOption('#or-st', 'delivered');
  await expect(card(page, no).locator('[data-chip]')).toHaveText('Sampai');
  await expect(card(page, no).locator('[data-lala-st]')).toHaveText('selesai');
});

test('after 16:00 the overtime is asked first; cancelled by staff (at Lalamove) or by Lalamove → back to "book a car"; the month\'s spend', async ({ page }) => {
  await bradLogin(page, '2026-10-14T15:50:00+07:00');
  const no = await readyOrder(page, 20, WA_LOC); // sent before the last order time (16:00)
  const c = card(page, no);
  await page.clock.setFixedTime(new Date('2026-10-14T16:10:00+07:00'));
  await c.locator('[data-act="lala-auto"]').click();
  await page.click('#tk-lquote');
  // 16:10 + 40 min + 20 % = 16:58: in time — 25 minutes later it would not be
  await expect(page.locator('#tk-lprice')).toBeVisible();
  await expect(page.locator('#tk-leta')).toHaveText('Mobil di gudang ± 16:58');
  await expect(page.locator('#tk-late-q')).toHaveCount(0);
  await page.click('#md-close');
  await page.clock.setFixedTime(new Date('2026-10-14T16:35:00+07:00'));
  await c.locator('[data-act="lala-auto"]').click();
  await page.click('#tk-lquote');
  await expect(page.locator('#tk-late-q')).toHaveText('Mobil diperkirakan tiba 17:23, lewat 17:00: lembur 1 jam (Rp 300.000).');
  await page.click('#tk-laccept');
  await expect(page.locator('#tk-lprice')).toBeVisible();
  await page.click('#tk-lbook');
  await expect(page.locator('#toast')).toHaveText('Lalamove dipesan — mencari sopir');
  await expect(c.locator('[data-log]')).toContainText('tiba ± 17:23 · risiko lembur disetujui');
  // staff cancel it: at Lalamove, with a reason
  await c.locator('[data-act="lala-cancel"]').click();
  await page.click('#ask-ok');
  await expect(page.locator('#toast')).toHaveText('Alasan');
  await page.fill('#ask-in', 'Pelanggan ambil sendiri');
  await page.click('#ask-ok');
  await expect(c.locator('[data-chip]')).toHaveText('4/9 Barang siap');
  await expect(c.locator('[data-cancels]')).toHaveText('mobil batal 1×');
  await expect(c.locator('[data-log]')).toContainText('Lalamove dibatalkan: belum ada sopir — Pelanggan ambil sendiri');
  // booked again; Lalamove cancels by itself → back to "book a car" too
  await c.locator('[data-act="lala-auto"]').click();
  await page.click('#tk-lquote'); await page.click('#tk-laccept'); await page.click('#tk-lbook');
  await expect(c.locator('[data-chip]')).toHaveText('5/9 Mobil dipesan');
  await c.locator('[data-act="dm-la-cancel"]').click();
  await expect(c.locator('[data-chip]')).toHaveText('4/9 Barang siap');
  await expect(c.locator('[data-cancels]')).toHaveText('mobil batal 2×');
  await expect(c.locator('[data-log]')).toContainText('Lalamove dibatalkan: belum ada sopir — pesan mobil lagi');
  // cancelled trips cost nothing this month
  expect(await page.evaluate(() => S.D.lala.spent)).toBe(0);
});

test('not set up: the fourth way says so, no automatic button; the manual ways go on as before', async ({ page }) => {
  await page.addInitScript(() => { window.KBradMockLala = false; });
  await bradLogin(page, '2026-10-14T10:00:00+07:00');
  const no = await readyOrder(page, 20);
  const c = card(page, no);
  await expect(c.locator('[data-act="lala-auto"]')).toHaveCount(0);
  await c.locator('[data-act="car"]').click();
  await page.selectOption('#tk-via', 'lalamove_api');
  await expect(page.locator('#tk-lala-off')).toHaveText('Lalamove otomatis belum aktif — pakai cara manual (Lalamove, sopir sendiri, pelanggan). Pemilik: Pengaturan → Lalamove otomatis.');
  await expect(page.locator('#tk-save')).toBeHidden();
  await page.selectOption('#tk-via', 'lalamove');
  await expect(page.locator('#tk-save')).toBeVisible();
  await page.fill('#tk-driver', 'Pak Budi'); await page.fill('#tk-plate', 'B 1 AB'); await page.fill('#tk-eta', '30');
  await page.click('#tk-save');
  await waDone(page);
  await expect(c.locator('[data-chip]')).toHaveText('5/9 Mobil dipesan');
  await expect(c.locator('[data-lala]')).toHaveCount(0);
  await expect(c.locator('[data-act="car-cancel"]')).toBeVisible();
  // the owner's settings say how to switch it on
  await page.click('#logout');
  await page.fill('#lg-user', 'Pemilik'); await page.fill('#lg-pin', '1234'); await page.click('#lg-go');
  await page.click('[data-tab="set"]');
  await expect(page.locator('#la-on')).toContainText('Belum aktif. Pemilik: isi LALAMOVE_KEY dan LALAMOVE_SECRET di Cloudflare');
});

test('Arabic: the fourth way, the price, the booked car and the settings read in Arabic', async ({ page }) => {
  await bradLogin(page, '2026-10-14T10:00:00+07:00', 'Pemilik', '1234');
  const no = await readyOrder(page, 200, WA_LOC);
  await page.click('#lang');
  const c = card(page, no);
  await expect(c.locator('[data-act="lala-auto"]')).toHaveText('حجز لالاموف تلقائي');
  await c.locator('[data-act="lala-auto"]').click();
  await expect(page.locator('#tk-via option[value="lalamove_api"]')).toHaveText('حجز لالاموف تلقائي');
  await expect(page.locator('#tk-lquote')).toHaveText('معرفة السعر');
  await page.click('#tk-lquote');
  await expect(page.locator('#tk-lprice')).toContainText('سعر لالاموف: Rp');
  await expect(page.locator('#tk-leta')).toHaveText('السيارة عند البراد ± 10:48');
  await page.click('#tk-lbook');
  await expect(page.locator('#toast')).toHaveText('تم حجز لالاموف — جارٍ البحث عن سائق');
  await expect(c.locator('[data-lala-st]')).toHaveText('البحث عن سائق');
  await expect(c.locator('[data-lala-track]')).toHaveText('التتبع في لالاموف ↗');
  await expect(c.locator('[data-act="lala-cancel"]')).toHaveText('إلغاء لالاموف');
  await c.locator('[data-act="dm-la-driver"]').click();
  await expect(c.locator('[data-lala-st]')).toHaveText('السائق في الطريق للبراد');
  await page.click('[data-tab="set"]');
  await expect(page.locator('#la-card h2')).toHaveText('لالاموف تلقائي');
  await expect(page.locator('#la-on')).toHaveText('مفعّل — DEMO (محاكاة)');
});
