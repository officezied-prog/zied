// v60 (owner 2026-10-18) — Khair Order Brad (brad/?mock=1): the cold-store order process as its own app until it is proven.
//  «انطلق بالمرحلة الاولى و الاحسن في تطبيق اخر الان منفصل حتى نتأكد منه قبل دمجه مع القديم». The owner's 9 steps with one-tap WhatsApp
//  (the cold store works only by WhatsApp), the order read from a photo / a message, the cooler's hours (last order 16:00, overtime per
//  started hour after 17:00, Sunday by arrangement, holidays), the car (+20 %), the door, loading (30 min a pallet), the departure.
// Every test fixes the page's clock (WIB): 2026-10-14 is a Wednesday, 2026-10-18 a Sunday.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS } = require('./helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4//8/AxJgYGBgAACQhAP9kw2fBQAAAABJRU5ErkJggg==', 'base64');
async function bradLogin(page, at, user = 'Jihan', pin = '2222') {
  await page.clock.setFixedTime(new Date(at));
  await page.goto('brad/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kbrad.mock.db'); localStorage.removeItem('kcold.mock.db'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', user);
  await page.fill('#lg-pin', pin);
  await page.click('#lg-go');
  await expect(page.locator('#nav')).toBeVisible();
}
const card = (page, no) => page.locator(`.order[data-no="${no}"]`);
const waText = page => page.locator('#wa-text').textContent();
async function waDone(page) { await page.evaluate(() => { document.querySelector('#wa-go').removeAttribute('target'); document.querySelector('#wa-go').setAttribute('href', '#'); }); await page.click('#wa-go'); await expect(page.locator('#modal')).toBeHidden(); }
/** A new order through the form: pallet `pc`, `n` cartons, for Toko Barokah. Returns its number. */
async function newOrder(page, pc, n, date) {
  await page.click('#or-new');
  if (date) await page.fill('#of-date', date);
  await page.selectOption('#of-wh', 'DPP');
  await page.selectOption('#of-lines [data-f="pallet_code"]', pc);
  await page.fill('#of-lines [data-f="cartons"]', String(n));
  const opt = await page.locator('#of-cust option', { hasText: 'Toko Barokah' }).getAttribute('value');
  await page.selectOption('#of-cust', opt);
  await page.click('#of-save');
  await expect(page.locator('#modal')).toBeHidden();
  return page.evaluate(() => S.D.orders[0].order_no);
}

test('home: the trial note, the seeded orders with their step, nothing late at 10:00; the accountant only looks', async ({ page }) => {
  await bradLogin(page, '2026-10-14T10:00:00+07:00');
  await expect(page.locator('#trial')).toContainText('Aplikasi uji coba');
  await expect(page.locator('#al-none')).toHaveText('Semua aman.');
  const cs = page.locator('#or-list .order');
  await expect(cs).toHaveCount(2);
  await expect(cs.first().locator('[data-chip]')).toHaveText('5/9 Mobil dipesan');
  await expect(cs.first().locator('[data-car]')).toContainText('B 9123 KXT · Pak Udin · Engkel (CDE) · tiba ± 10:33');
  await expect(cs.nth(1).locator('[data-chip]')).toHaveText('2/9 Dikirim ke gudang');
  await expect(cs.nth(1).locator('.steps i.done')).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, 'brad-home.png') });
  // yesterday's order (overtime) is in "Semua order"; the month's overtime
  await page.click('[data-tab="ot"]');
  await expect(page.locator('#ot-sum')).toHaveText('Lembur: 1 kali · 1 jam · Rp 300.000');
  await expect(page.locator('[data-cause="car_late"]')).toHaveText('Mobil terlambat: Rp 300.000');
  // the accountant: no new order, no action buttons, no settings
  await page.click('#logout');
  await page.fill('#lg-user', 'Akuntan'); await page.fill('#lg-pin', '3333'); await page.click('#lg-go');
  await expect(page.locator('#who')).toContainText('Hanya lihat');
  await expect(page.locator('#or-new')).toHaveCount(0);
  await expect(page.locator('.order .next')).toHaveCount(0);
  await expect(page.locator('[data-tab="set"]')).toHaveCount(0);
});

test('the 9 steps: a photo → the draft → saved; WhatsApp to the cold store; its pasted replies; the car; in at door 12; loading; gone — the stock goes down', async ({ page }) => {
  await bradLogin(page, '2026-10-14T10:00:00+07:00');
  // 1. the order from a photo of the sheet (the demo's stand-in AI)
  await page.click('#or-new');
  await page.click('#of-read summary');
  await page.setInputFiles('#of-rd-photo', { name: 'pesanan.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#of-rd-go');
  await expect(page.locator('#of-rd-sum')).toHaveText('3 baris terbaca → 2 palet di form · dibaca AI');
  await expect(page.locator('#of-rd-un [data-reason="unknown"]')).toHaveText('Zahidi · 10 ctn — produk tidak dikenal');
  await expect(page.locator('#of-wh')).toHaveValue('DPP');
  await expect(page.locator('#of-dname')).toHaveValue('Toko Barokah');
  await expect(page.locator('#of-sum')).toHaveText('Total: 140 ctn'); // 40 Ruthab + the Ajwa pallet's 100 free (21 held by a gudang order)
  await page.screenshot({ path: path.join(SHOTS, 'brad-read.png') });
  await page.click('#of-save');
  const no = await page.evaluate(() => S.D.orders[0].order_no);
  expect(no).toBe('BRD-261014-003');
  const c = card(page, no);
  await expect(c.locator('[data-chip]')).toHaveText('1/9 Ditulis');
  await expect(c).toContainText('dari foto');
  // 2. to the cold store by WhatsApp: quantity, product, pallet, product code
  await c.locator('[data-act="send"]').click();
  await expect(page.locator('#wa-to')).toHaveText('Ke: 6281200000001');
  const msg = await waText(page);
  expect(msg).toContain('No: ' + no + '\nTanggal ambil: Rabu, 14 Oktober 2026\nGudang: DPP Cold Storage\nTujuan: Toko Barokah (pelanggan)');
  expect(msg).toContain('1. 40 ctn · Ruthab Dates 2kg · Palet 2274561 · Kode RUTHAB-2\n2. 100 ctn · Kurma Ajwa Jumbo 5kg · Palet 3619208 · Kode AJWA-5\nTotal: 140 ctn · 2 palet');
  expect(await page.locator('#wa-go').getAttribute('href')).toMatch(/^https:\/\/wa\.me\/6281200000001\?text=/);
  await page.screenshot({ path: path.join(SHOTS, 'brad-wa-order.png') });
  await waDone(page);
  await expect(c.locator('[data-chip]')).toHaveText('2/9 Dikirim ke gudang');
  // 3–4. the cold store's replies, pasted
  await c.locator('[data-act="reply"]').click();
  await page.fill('#rp-text', 'Ok pak, siap. Terima kasih');
  await page.click('#rp-go');
  await expect(page.locator('#rp-kind')).toHaveText('Gudang SETUJU');
  await page.click('#rp-apply');
  await expect(c.locator('[data-chip]')).toHaveText('3/9 Gudang setuju');
  await c.locator('[data-act="reply"]').click();
  await page.fill('#rp-text', 'Barang sudah siap diambil pak');
  await page.click('#rp-go');
  await page.click('#rp-apply');
  await expect(c.locator('[data-chip]')).toHaveText('4/9 Barang siap');
  // 5. the car: Lalamove 40 min + 20 % = 10:48, before closing; its plate and driver go to the cold store
  await c.locator('[data-act="car"]').click();
  await expect(page.locator('#tk-sug')).toHaveText('Saran: Pickup (bak) (± 580 kg)');
  await page.fill('#tk-driver', 'Pak Budi'); await page.fill('#tk-dwa', '0812 9999 0000'); await page.fill('#tk-plate', 'b 1234 xyz'); await page.fill('#tk-eta', '40');
  await expect(page.locator('#tk-eta-at')).toHaveText('Perkiraan tiba (+20%): 10:48');
  await expect(page.locator('#tk-eta-ok')).toHaveText('Sebelum 17:00');
  await page.click('#tk-save');
  expect(await waText(page)).toBe('Order ' + no + ' — mobil untuk ambil di DPP Cold Storage:\nKendaraan: Pickup (bak)\nNo. polisi: B 1234 XYZ\nSopir: Pak Budi (081299990000)\nPerkiraan tiba: 10:48\nTerima kasih.');
  await waDone(page);
  await expect(c.locator('[data-chip]')).toHaveText('5/9 Mobil dipesan');
  // 6–7. in; the cold store says the door (pasted) → the driver gets it
  await c.locator('[data-act="reply"]').click();
  await page.fill('#rp-text', 'Mobil B 1234 XYZ sudah masuk, ke pintu 12');
  await page.click('#rp-go');
  await expect(page.locator('#rp-kind')).toHaveText('PINTU 12');
  await page.click('#rp-apply');
  await expect(page.locator('#in-door')).toHaveValue('12');
  await page.click('#in-save');
  expect(await waText(page)).toBe('Halo Pak Budi, order ' + no + ':\nsilakan masuk ke DPP Cold Storage (Jl. Contoh Pergudangan No. 1, Jakarta Utara) — *PINTU 12*.\nMuat 2 palet · 140 ctn untuk Toko Barokah.\nTerima kasih.');
  await expect(page.locator('#wa-to')).toHaveText('Ke: 6281299990000');
  await waDone(page);
  await expect(c.locator('[data-chip]')).toHaveText('7/9 Ke pintu');
  // 8. loading: 2 pallets × 30 min
  await c.locator('[data-act="load"]').click();
  await expect(c.locator('[data-door]')).toHaveText('Pintu 12 · selesai muat ± 11:00');
  // 9. gone: the goods leave the gudang stock; the customer is told
  const stock = () => page.evaluate(() => JSON.parse(localStorage.getItem('kcold.mock.db')).movements.filter(m => m.pallet_code === '3619208' && m.warehouse === 'DPP').reduce((s, m) => s + m.cartons, 0));
  expect(await stock()).toBe(121);
  await c.locator('[data-act="depart"]').click();
  await page.click('#dep-ok');
  await expect(page.locator('#wa-to')).toHaveText('Ke: 6281300000020');
  expect(await waText(page)).toBe('Halo Toko Barokah, pesanan ' + no + ' (140 ctn) sudah berangkat dari DPP Cold Storage jam 10:00.\nMobil: B 1234 XYZ · Sopir Pak Budi (081299990000)\nTerima kasih — Khair Mart');
  await waDone(page);
  await expect(c.locator('[data-chip]')).toHaveText('9/9 Berangkat');
  expect(await stock()).toBe(21);
  await page.screenshot({ path: path.join(SHOTS, 'brad-departed.png') });
  await c.locator('[data-act="delivered"]').click();
  await page.click('[data-tab="all"]');
  await page.selectOption('#or-st', 'delivered');
  await expect(card(page, no).locator('[data-chip]')).toHaveText('Sampai');
});

test('after 16:00: a same-day pickup asks first — tomorrow without overtime, or today with the risk; a car too late asks; in at 17:10 = 1 hour with its cause', async ({ page }) => {
  await bradLogin(page, '2026-10-14T16:20:00+07:00');
  await expect(page.locator('#al-list [data-kind="no_car"]')).toHaveCount(1); // the seeded order sent this morning, still no car
  const a = await newOrder(page, '2274537', 10), b = await newOrder(page, '2274537', 10);
  await card(page, a).locator('[data-act="send"]').click();
  await expect(page.locator('#modal-box h3')).toHaveText('Lewat jam order terakhir (16:00)');
  await expect(page.locator('#sd-text')).toHaveText('Kalau diambil hari ini, mobil harus masuk gudang sebelum 17:00. Setelah itu lembur Rp 300.000 per jam (jam yang sudah mulai dihitung penuh).');
  await expect(page.locator('#sd-later')).toHaveText('Ambil Kamis, 15 Oktober 2026 (tanpa lembur)');
  await page.screenshot({ path: path.join(SHOTS, 'brad-after-hours.png') });
  await page.click('#sd-later');
  expect(await waText(page)).toContain('Tanggal ambil: Kamis, 15 Oktober 2026');
  await waDone(page);
  await card(page, b).locator('[data-act="send"]').click();
  await page.click('#sd-today');
  await waDone(page);
  await expect(card(page, b).locator('[data-log]')).toContainText('risiko lembur disetujui');
  await card(page, b).locator('[data-act="approve"]').click();
  await card(page, b).locator('[data-act="ready"]').click();
  // the car: 40 min + 20 % from 16:20 = 17:08 → overtime → asked
  await card(page, b).locator('[data-act="car"]').click();
  await page.fill('#tk-driver', 'Pak Budi'); await page.fill('#tk-plate', 'B 1 AB'); await page.fill('#tk-eta', '40');
  await expect(page.locator('#tk-eta-late')).toHaveText('Lewat 17:00: lembur 1 jam (Rp 300.000)');
  await page.click('#tk-save');
  await expect(page.locator('#tk-late-q')).toContainText('tiba 17:08');
  await page.click('#tk-accept');
  await waDone(page);
  // cancelled after 16:00 → back to "book a car", with the warning
  await card(page, b).locator('[data-act="car-cancel"]').click();
  await page.fill('#ask-in', 'Sopir batal');
  await page.click('#ask-ok');
  await expect(page.locator('#toast')).toContainText('cepat pesan mobil lain');
  await expect(card(page, b).locator('[data-chip]')).toHaveText('4/9 Barang siap');
  await expect(card(page, b).locator('[data-cancels]')).toHaveText('mobil batal 1×');
  await card(page, b).locator('[data-act="car"]').click();
  await page.fill('#tk-driver', 'Pak Andi'); await page.fill('#tk-plate', 'B 2 CD'); await page.fill('#tk-eta', '30');
  await expect(page.locator('#tk-eta-ok')).toHaveText('Sebelum 17:00'); // 30 min + 20 % from 16:20 = 16:56
  await page.click('#tk-save'); await waDone(page);
  // in at 17:10: one full hour, its cause
  await page.clock.setFixedTime(new Date('2026-10-14T17:15:00+07:00'));
  await card(page, b).locator('[data-act="arrived"]').click();
  await page.fill('#in-time', '17:10');
  await expect(page.locator('#in-ot-text')).toHaveText('Lembur 1 jam (Rp 300.000)');
  await page.selectOption('#in-cause', 'car_cancel');
  await page.screenshot({ path: path.join(SHOTS, 'brad-arrived-ot.png') });
  await page.click('#in-save');
  await expect(card(page, b).locator('[data-ot]')).toHaveText('Lembur 1 · Rp 300.000 (Mobil batal / ganti)');
  await page.click('[data-tab="ot"]');
  await expect(page.locator('#ot-sum')).toHaveText('Lembur: 2 kali · 2 jam · Rp 600.000');
});

test('Sunday only with the agreed extra cost (in the WhatsApp too); the owner sets a cooler\'s hours, its WhatsApp, a holiday — that day is closed', async ({ page }) => {
  await bradLogin(page, '2026-10-18T10:00:00+07:00', 'Pemilik', '1234');
  const s = await newOrder(page, '2274537', 5);
  await card(page, s).locator('[data-act="send"]').click();
  await expect(page.locator('#modal-box h3')).toHaveText('Hari perjanjian');
  await expect(page.locator('#sd-text')).toHaveText('Minggu, 18 Oktober 2026: gudang buka hanya dengan perjanjian. Isi biaya tambahan yang disepakati dengan gudang.');
  await page.fill('#sd-cost', '350000'); await page.fill('#sd-note', 'Buka Minggu');
  await page.click('#sd-cost-go');
  expect(await waText(page)).toContain('Hari perjanjian: biaya tambahan Rp 350.000 (Buka Minggu)');
  await waDone(page);
  await expect(card(page, s).locator('[data-extra]')).toHaveText('Biaya perjanjian: Rp 350.000');
  // settings: the cooler's own WhatsApp and hours (Saturday by arrangement); a holiday
  await page.click('[data-tab="set"]');
  const k = page.locator('[data-cooler="DPP"]');
  await k.locator('[data-f="wa"]').fill('0813 5555 6666');
  await k.locator('[data-h="last"]').fill('15:00');
  await k.locator('[data-days="days"] [data-dow="6"]').uncheck();
  await k.locator('[data-days="arrange"] [data-dow="6"]').check();
  await k.locator('[data-save="DPP"]').click();
  await expect(page.locator('#toast')).toHaveText('Tersimpan');
  await page.fill('#set-hol', '2026-10-20 Libur contoh');
  await page.click('#set-save');
  await expect(page.locator('#toast')).toHaveText('Tersimpan');
  await page.click('[data-tab="today"]');
  await page.click('#or-new');
  await page.fill('#of-date', '2026-10-20');
  await page.selectOption('#of-lines [data-f="pallet_code"]', '2274537');
  await page.fill('#of-lines [data-f="cartons"]', '5');
  await page.click('#of-save');
  await expect(page.locator('#toast')).toContainText('tutup tanggal 2026-10-20 (Libur contoh). Hari kerja berikutnya: 2026-10-21');
  await page.click('#md-close');
  await card(page, s).locator('[data-act="rewa"]').count(); // (sent orders keep a resend button)
  expect(await page.evaluate(() => S.D.coolers.find(c => c.code === 'DPP').wa)).toBe('6281355556666');
});

test('no AI key: the photo says so, a pasted customer message is still read (rules)', async ({ page }) => {
  await page.addInitScript(() => { window.KBradMockAI = false; });
  await bradLogin(page, '2026-10-14T10:00:00+07:00');
  await page.click('#or-new');
  await page.click('#of-read summary');
  await expect(page.locator('#of-rd-hint')).toHaveText('Pembaca foto (AI) belum aktif — pesan yang ditempel tetap dibaca.');
  await page.setInputFiles('#of-rd-photo', { name: 'pesanan.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#of-rd-go');
  await expect(page.locator('#of-rd-err')).toContainText('Pembaca foto (AI) belum aktif');
  await page.setInputFiles('#of-rd-photo', []);
  await page.fill('#of-rd-text', 'Selamat pagi pak\nKirim ke Toko Al Amin besok ya\n1. Medjool 30 ctn\n2. PID K-77003 20 dus\n3. Mangga 2 ctn');
  await page.click('#of-rd-go');
  await expect(page.locator('#of-rd-sum')).toHaveText('3 baris terbaca → 2 palet di form · dibaca tanpa AI');
  await expect(page.locator('#of-wh')).toHaveValue('KAWANISHI');
  await expect(page.locator('#of-date')).toHaveValue('2026-10-15');
  await expect(page.locator('#of-dname')).toHaveValue('Toko Al Amin');
  await page.click('#of-save');
  await expect(card(page, 'BRD-261014-003')).toContainText('dari pesan');
});

test('Arabic: home, an order and the WhatsApp step read in Arabic', async ({ page }) => {
  await bradLogin(page, '2026-10-14T16:40:00+07:00');
  await page.click('#lang');
  await expect(page.locator('#title')).toHaveText('طلبيات البراد');
  await expect(page.locator('#al-list [data-kind="no_car"]')).toContainText('لا توجد سيارة');
  await expect(page.locator('#or-list .order').first().locator('[data-chip]')).toHaveText('5/9 السيارة محجوزة');
  await page.screenshot({ path: path.join(SHOTS, 'brad-home-ar.png') });
});
