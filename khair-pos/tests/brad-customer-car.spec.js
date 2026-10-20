// v62 (owner 2026-10-20) — Khair Order Brad (brad/?mock=1): the car the customer booked himself.
//  «كثير من الأحيان يقوم الزبون هو باختيار السيارة للموف لإرسال البضاعة من المخزن التبريد مباشرة، فيجب أن تكون هناك مكان لكتابة رسائل الزبون».
//  A third way in the car step ("Dipesan pelanggan"): his WhatsApp message pasted, "Baca pesan" fills the driver, the plate, the
//  driver's WhatsApp, the vehicle and the minutes (still editable); the message and the Lalamove tracking link stay on the order,
//  and the link goes to the cold store with the car's details.
// The test fixes the page's clock (WIB): 2026-10-14 is a Wednesday.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS } = require('./helpers');

const LINK = 'https://share.lalamove.com/?ID100221014123456&lang=id_ID';
const MSG = 'Pak, mobil saya yang pesan ya.\nDriver: Budi Santoso, B 1234 XYZ, 0812-3456-7890, Grand Max, sampai 25 menit\nLacak: ' + LINK;
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

test('the customer booked the car: his message pasted, "Baca pesan" fills the fields, saved — the message and the tracking link on the order and to the cold store', async ({ page }) => {
  await bradLogin(page, '2026-10-14T10:00:00+07:00');
  // an order for Toko Barokah, up to "Barang siap"
  await page.click('#or-new');
  await page.selectOption('#of-wh', 'DPP');
  await page.selectOption('#of-lines [data-f="pallet_code"]', '2274537');
  await page.fill('#of-lines [data-f="cartons"]', '10');
  await page.selectOption('#of-cust', await page.locator('#of-cust option', { hasText: 'Toko Barokah' }).getAttribute('value'));
  await page.click('#of-save');
  await expect(page.locator('#modal')).toBeHidden();
  const no = await page.evaluate(() => S.D.orders[0].order_no), c = card(page, no);
  await c.locator('[data-act="send"]').click();
  await waDone(page);
  await c.locator('[data-act="approve"]').click();
  await expect(c.locator('[data-chip]')).toHaveText('3/9 Gudang setuju');
  await c.locator('[data-act="ready"]').click();
  await expect(c.locator('[data-chip]')).toHaveText('4/9 Barang siap');
  // step 5: the third way, its box only when chosen; the cost is the customer's
  await c.locator('[data-act="car"]').click();
  await expect(page.locator('#tk-via option')).toHaveText(['Lalamove', 'Sopir sendiri', 'Dipesan pelanggan']);
  await expect(page.locator('#tk-cust')).toBeHidden();
  await page.selectOption('#tk-via', 'pelanggan');
  await expect(page.locator('#tk-cust')).toBeVisible();
  await expect(page.locator('#tk-cust')).toContainText('Pesan dari pelanggan (tempel di sini)');
  await expect(page.locator('#tk-cost')).toHaveAttribute('placeholder', 'Dibayar pelanggan');
  // a message without the car's details: nothing filled, said so; no driver and no plate → refused
  await page.fill('#tk-cmsg', 'Pak, mobilnya saya pesan sendiri ya, nanti saya kabari');
  await page.click('#tk-cmsg-read');
  await expect(page.locator('#tk-cmsg-out')).toHaveText('Data mobil tidak ditemukan di pesan — isi sendiri');
  await expect(page.locator('#tk-driver')).toHaveValue('');
  await page.click('#tk-save');
  await expect(page.locator('#toast')).toHaveText('Nama sopir dan nomor polisi wajib');
  // his message with the car: read into the fields
  await page.fill('#tk-cmsg', MSG);
  await page.click('#tk-cmsg-read');
  await expect(page.locator('#tk-cmsg-out')).toHaveText('Terbaca: Nama sopir, No. polisi, HP sopir, Kendaraan, Menit di Lalamove, Link lacak (Lalamove) — periksa, lalu Simpan');
  await expect(page.locator('#tk-driver')).toHaveValue('Budi Santoso');
  await expect(page.locator('#tk-plate')).toHaveValue('B 1234 XYZ');
  await expect(page.locator('#tk-dwa')).toHaveValue('6281234567890');
  await expect(page.locator('#tk-veh')).toHaveValue('Grand Max');
  await expect(page.locator('#tk-eta')).toHaveValue('25');
  await expect(page.locator('#tk-link')).toHaveValue(LINK);
  await expect(page.locator('#tk-eta-at')).toHaveText('Perkiraan tiba (+20%): 10:30'); // 25 min + 20 %
  await expect(page.locator('#tk-eta-ok')).toHaveText('Sebelum 17:00');
  // still editable
  await page.fill('#tk-driver', 'Pak Budi Santoso');
  await page.evaluate(() => { document.querySelector('#toast').style.display = 'none'; }); // (the refusal above)
  await page.screenshot({ path: path.join(SHOTS, 'brad-customer-car.png') });
  await page.click('#tk-save');
  // to the cold store (by hand: WhatsApp not set up in the demo): the car and the tracking link
  expect(await waText(page)).toBe('Order ' + no + ' — mobil untuk ambil di DPP Cold Storage:\nKendaraan: Grand Max\nNo. polisi: B 1234 XYZ\nSopir: Pak Budi Santoso (081234567890)\nPerkiraan tiba: 10:30\nLacak mobil: ' + LINK + '\nTerima kasih.');
  await waDone(page);
  // the order: the car, "Mobil dari pelanggan" with the link (a new tab) and his message (folded)
  await expect(c.locator('[data-chip]')).toHaveText('5/9 Mobil dipesan');
  await expect(c.locator('[data-car]')).toHaveText('Mobil: B 1234 XYZ · Pak Budi Santoso · Grand Max · tiba ± 10:30');
  const cc = c.locator('[data-cust-car]');
  await expect(cc.locator('b')).toHaveText('Mobil dari pelanggan');
  await expect(cc.locator('a[data-track]')).toHaveText('Lacak mobil ↗');
  await expect(cc.locator('a[data-track]')).toHaveAttribute('href', LINK);
  await expect(cc.locator('a[data-track]')).toHaveAttribute('target', '_blank');
  await expect(cc.locator('.cmsg')).toBeHidden();
  await cc.locator('[data-cmsg] summary').click();
  await expect(cc.locator('.cmsg')).toHaveText(MSG);
  await expect(c.locator('[data-log]')).toContainText('dipesan pelanggan');
  expect(await page.evaluate(n => S.D.orders.find(o => o.order_no === n).car.cost, no)).toBe(0);
  // "Ubah mobil": his message and the link come back in the form
  await c.locator('[data-act="car-edit"]').click();
  await expect(page.locator('#tk-via')).toHaveValue('pelanggan');
  await expect(page.locator('#tk-cust')).toBeVisible();
  await expect(page.locator('#tk-cmsg')).toHaveValue(MSG);
  await expect(page.locator('#tk-link')).toHaveValue(LINK);
  await page.click('#md-close');
  // in Arabic
  await page.click('#lang');
  await expect(c.locator('[data-cust-car] b')).toHaveText('سيارة من الزبون');
  await expect(c.locator('a[data-track]')).toHaveText('تتبع السيارة ↗');
  await c.locator('[data-act="car-edit"]').click();
  await expect(page.locator('#tk-via option[value="pelanggan"]')).toHaveText('حجزها الزبون');
  await expect(page.locator('#tk-cmsg-read')).toHaveText('اقرأ الرسالة');
  await expect(page.locator('#tk-cust')).toContainText('رسالة الزبون (الصقها هنا)');
});
