// v59 (owner 2026-10-18) — Khair Gudang Dingin (gudang/?mock=1): the cooler's hours.
//  «البراد يعمل من الساعة 9 الصبح الى الساعة 17 … الوقت الإضافة بعد الساعة 17 ب300 الف روبية لكل ساعة … راحة من الساعة 12 الى 13 … اذا لم تدخل
//  السيارة و تسجل قبل الساعة 17 ينطلق احتساب وقت إضافي … اخر طلبية في الوقت العادي الساعة 16»; a started hour counts in full; Sunday only by
//  arrangement at a cost agreed each time; closed on public holidays; Lalamove's minutes + 15–20 %.
// Every test fixes the page's clock (WIB); 2026-10-14 is a Wednesday, 2026-10-18 a Sunday.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS } = require('./helpers');

async function coldLogin(page, at, user = 'Jihan', pin = '2222') {
  await page.clock.setFixedTime(new Date(at));
  await page.goto('gudang/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kcold.mock.db'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', user);
  await page.fill('#lg-pin', pin);
  await page.click('#lg-go');
  await expect(page.locator('#nav')).toBeVisible();
  await page.evaluate(() => { window.__opened = []; window.open = u => { window.__opened.push(u); }; });
}
/** Fresh stock (pallet H-1, 200 ctn Sukari in DPP) and a toko order for `date`; optional steps up to `upTo`. Returns the order number. */
async function mkOrder(page, date, steps = []) {
  return page.evaluate(async ({ date, steps }) => {
    if (!S.D.pallets.some(p => p.pallet_code === 'H-1')) await api('pallet_in', { warehouse: 'DPP', date: today(), pallets: [{ pallet_code: 'H-1', product: 'SUKARI-3', cartons: 200, exp_date: '2027-06-01' }] });
    const o = (await api('order_save', { warehouse: 'DPP', order_date: date, dest_type: 'pelanggan', dest_name: 'Toko Barokah', dest_phone: '081300000020', lines: [{ pallet_code: 'H-1', cartons: 10 }] })).order;
    for (const s of steps) await api('order_status', Object.assign({ order_no: o.order_no }, s));
    await load();
    return o.order_no;
  }, { date, steps });
}
const opened = page => page.evaluate(() => window.__opened.map(u => decodeURIComponent(u)));
const toDispatch = [{ to: 'sent', when: 'overtime' }, { to: 'approved' }, { to: 'ready' }, { to: 'dispatch' }];

test('after 16:00 a same-day pickup asks first: the next working day without overtime (the WhatsApp has the new date), or today with the risk', async ({ page }) => {
  await coldLogin(page, '2026-10-14T16:20:00+07:00');
  const a = await mkOrder(page, '2026-10-14'), b = await mkOrder(page, '2026-10-14'), c = await mkOrder(page, '2026-10-15');
  await page.click('[data-tab="ord"]');
  const ca = page.locator(`.order[data-no="${a}"]`);
  await ca.locator('[data-act="send"]').click();
  await expect(page.locator('#modal-box h3')).toHaveText('Lewat jam order terakhir (16:00)');
  await expect(page.locator('#sd-text')).toHaveText('Kalau diambil hari ini, mobil harus masuk gudang sebelum 17:00. Setelah itu lembur Rp 300.000 per jam (jam yang sudah mulai dihitung penuh).');
  await expect(page.locator('#sd-later')).toHaveText('Ambil Kam 15 Okt 2026 (tanpa lembur)');
  await page.screenshot({ path: path.join(SHOTS, 'cold-after-hours.png') });
  await page.click('#sd-later');
  await expect(ca).toHaveAttribute('data-status', 'sent');
  await expect(ca).toContainText('15 Okt 2026');
  expect((await opened(page))[0]).toContain('Tanggal ambil: 15 Oktober 2026');
  // today anyway: sent, the history says the overtime risk was accepted
  const cb = page.locator(`.order[data-no="${b}"]`);
  await cb.locator('[data-act="send"]').click();
  await page.click('#sd-today');
  await expect(cb).toHaveAttribute('data-status', 'sent');
  await expect(cb.locator('[data-log]')).toContainText('risiko lembur disetujui');
  expect((await opened(page))[1]).toContain('Tanggal ambil: 14 Oktober 2026');
  // a pickup tomorrow goes without a question
  await page.locator(`.order[data-no="${c}"] [data-act="send"]`).click();
  await expect(page.locator(`.order[data-no="${c}"]`)).toHaveAttribute('data-status', 'sent');
  expect(await opened(page)).toHaveLength(3);
});

test('the car: Lalamove 40 min + 20 % from 16:20 = 17:08 → overtime, asked first; it enters 17:10 → 1 full hour Rp 300.000 with its cause; the door to the driver', async ({ page }) => {
  await coldLogin(page, '2026-10-14T16:20:00+07:00');
  const no = await mkOrder(page, '2026-10-14', toDispatch);
  await page.click('[data-tab="ord"]');
  const card = page.locator(`.order[data-no="${no}"]`);
  await card.locator('[data-act="truck"]').first().click();
  await page.fill('#tk-driver', 'Pak Budi');
  await page.fill('#tk-plate', 'B 1234 XY');
  await page.fill('#tk-dwa', '0812 3333 4444');
  await expect(page.locator('#tk-eta-hint')).toHaveText('Menit dari aplikasi Lalamove, ditambah 20% untuk macet.');
  await page.fill('#tk-eta', '20');
  await expect(page.locator('#tk-eta-at')).toHaveText('Perkiraan tiba 16:44');
  await expect(page.locator('#tk-eta-ok')).toHaveText('Tiba sebelum 17:00: tanpa lembur.');
  await page.fill('#tk-eta', '40');
  await expect(page.locator('#tk-eta-at')).toHaveText('Perkiraan tiba 17:08');
  await expect(page.locator('#tk-eta-late')).toHaveText('Tiba lewat 17:00: lembur 1 jam · Rp 300.000.');
  await page.click('#tk-save');
  await expect(page.locator('#tk-late-q')).toHaveText('Mobil diperkirakan tiba 17:08: lembur 1 jam · Rp 300.000. Terima lembur?');
  await page.click('#tk-accept');
  await expect(card).toHaveAttribute('data-status', 'driver');
  await expect(card.locator('[data-eta]')).toHaveText('Perkiraan tiba 17:08');
  // 17:15: the car is in since 17:10 — a cause is asked with the overtime
  await page.clock.setFixedTime(new Date('2026-10-14T17:15:00+07:00'));
  await card.locator('[data-act="arrived"]').click();
  await expect(page.locator('#ar-time')).toHaveValue('17:15');
  await page.fill('#ar-time', '16:55');
  await expect(page.locator('#ar-ot-text')).toHaveCount(0);
  await page.fill('#ar-time', '17:10');
  await expect(page.locator('#ar-ot-text')).toHaveText('Masuk lewat 17:00: lembur 1 jam · Rp 300.000');
  await page.fill('#ar-door', '3');
  await page.click('#ar-save');
  await expect(page.locator('#toast')).toContainText('Pilih sebabnya');
  await page.selectOption('#ar-cause', 'car_late');
  await page.fill('#ar-note', 'Macet di tol');
  await page.screenshot({ path: path.join(SHOTS, 'cold-arrived-ot.png') });
  await page.click('#ar-save');
  await expect(card).toHaveAttribute('data-status', 'arrived');
  await expect(card.locator('[data-arrived]')).toHaveText('Masuk 17:10 · Nomor pintu 3');
  await expect(card.locator('[data-ot]')).toHaveText('Lembur 1 jam · Rp 300.000 — Mobil telat · Macet di tol');
  await card.locator('[data-act="door-wa"]').click();
  const wa = (await opened(page)).pop();
  expect(wa).toContain('wa.me/6281233334444');
  expect(wa).toContain('PINTU 3');
  // loaded → the customer is told the goods left
  await card.locator('[data-act="pick"]').click();
  await page.click('#ask-ok');
  await expect(card).toHaveAttribute('data-status', 'picked');
  await card.locator('[data-act="depart-wa"]').click();
  const dep = (await opened(page)).pop();
  expect(dep).toContain('wa.me/6281300000020');
  expect(dep).toContain('sudah berangkat dari gudang: 10 karton');
  expect(dep).toContain('Plat: B 1234 XY');
  // the month's overtime on the home page
  await page.click('[data-tab="dash"]');
  await expect(page.locator('#ot-sum')).toHaveText('Lembur: 1 kali · 1 jam · Rp 300.000');
  await expect(page.locator('#ot-card [data-cause="car_late"]')).toHaveText('Mobil telat: Rp 300.000');
});

test('late in the day: pickups without a car are flagged on the home page; a cancelled car goes back to "book a car" with the warning', async ({ page }) => {
  await coldLogin(page, '2026-10-14T15:40:00+07:00');
  const no = await mkOrder(page, '2026-10-14', toDispatch);
  await expect(page.locator(`#ta-list [data-no="${no}"][data-ta="no_car"]`)).toContainText('Belum ada mobil — risiko lembur');
  await page.click('[data-tab="ord"]');
  const card = page.locator(`.order[data-no="${no}"]`);
  await card.locator('[data-act="truck"]').first().click();
  await page.fill('#tk-driver', 'Pak Andi');
  await page.fill('#tk-eta', '15');
  await page.click('#tk-save');
  await expect(card).toHaveAttribute('data-status', 'driver');
  await card.locator('[data-act="car-cancel"]').click();
  await page.fill('#ask-in', 'Sopir membatalkan');
  await page.click('#ask-ok');
  await expect(page.locator('#toast')).toHaveText('Sudah sore: pesan mobil lain segera. Lewat 17:00 ada lembur Rp 300.000 per jam.');
  await expect(page.locator('#truck')).toBeVisible(); // the car form again
  await expect(card).toHaveAttribute('data-status', 'dispatch');
  await expect(card.locator('[data-cancels]')).toHaveText('Mobil batal 1×');
  await expect(card.locator('[data-log]')).toContainText('Mobil batal: Pak Andi — Sopir membatalkan');
  // after 17:00 the home page says overtime is running
  await page.clock.setFixedTime(new Date('2026-10-14T17:05:00+07:00'));
  await page.click('#md-close');
  await page.click('[data-tab="dash"]');
  await expect(page.locator(`#ta-list [data-no="${no}"][data-ta="overtime"]`)).toContainText('Lewat 17:00: lembur berjalan');
});

test('Sunday: the order goes only with the extra cost agreed with the cooler (or moves to Monday); a public holiday is closed; a cooler\'s own hours', async ({ page }) => {
  await coldLogin(page, '2026-10-18T10:00:00+07:00', 'Pemilik', '1234');
  const a = await mkOrder(page, '2026-10-18'), b = await mkOrder(page, '2026-10-18');
  await page.click('[data-tab="ord"]');
  const ca = page.locator(`.order[data-no="${a}"]`);
  await ca.locator('[data-act="send"]').click();
  await expect(page.locator('#modal-box h3')).toHaveText('Min 18 Okt 2026: buka dengan perjanjian');
  await page.click('#sd-today');
  await expect(page.locator('#toast')).toHaveText('Isi biaya yang disepakati');
  await page.fill('#sd-cost', '500.000');
  await page.click('#sd-today');
  await expect(ca).toHaveAttribute('data-status', 'sent');
  await expect(ca.locator('[data-extra]')).toHaveText('Biaya tambahan: Rp 500.000 · Buka di luar hari kerja (perjanjian)');
  const cb = page.locator(`.order[data-no="${b}"]`);
  await cb.locator('[data-act="send"]').click();
  await expect(page.locator('#sd-later')).toHaveText('Ambil Sen 19 Okt 2026 (tanpa lembur)');
  await page.click('#sd-later');
  await expect(cb).toContainText('19 Okt 2026');
  // the owner's settings: a public holiday → orders for that day are refused
  await page.click('[data-tab="set"]');
  await page.fill('#set-hol', '2026-10-20 Libur test');
  await page.click('#hol-save');
  const r = await page.evaluate(() => api('order_save', { warehouse: 'DPP', order_date: '2026-10-20', dest_type: 'toko', lines: [{ pallet_code: 'H-1', cartons: 1 }] }).then(() => 'ok', e => e.error + ': ' + e.message));
  expect(r).toMatch(/^CLOSED: Gudang .* tutup tanggal 2026-10-20 \(Libur test\)/);
  // a cooler's own hours: DPP closes at 16:00, last order 15:00
  await page.locator('#set-wh tr[data-wh="DPP"] [data-act="wh-edit"]').click();
  await expect(page.locator('#wf-h-close')).toHaveValue('17:00');
  await page.fill('#wf-h-close', '16:00');
  await page.fill('#wf-h-last', '15:00');
  await page.locator('#wf-h-arr [data-dow="0"]').uncheck(); // no Sundays at all
  await page.click('#wf-save');
  const hrs = await page.evaluate(() => S.D.warehouses.find(w => w.code === 'DPP').hours);
  expect(hrs).toMatchObject({ close: '16:00', last: '15:00', arrange: [] });
  const r2 = await page.evaluate(() => api('order_save', { warehouse: 'DPP', order_date: '2026-10-25', dest_type: 'toko', lines: [{ pallet_code: 'H-1', cartons: 1 }] }).then(() => 'ok', e => e.error));
  expect(r2).toBe('CLOSED'); // the next Sunday
});

test('Arabic: the after-hours question and the arrival form read in Arabic', async ({ page }) => {
  await coldLogin(page, '2026-10-14T16:20:00+07:00');
  await page.evaluate(() => { S.lang = 'ar'; render(); });
  const no = await mkOrder(page, '2026-10-14');
  await page.click('[data-tab="ord"]');
  await page.locator(`.order[data-no="${no}"] [data-act="send"]`).click();
  await expect(page.locator('#modal-box h3')).toHaveText('بعد آخر وقت للطلبيات (16:00)');
  await expect(page.locator('#sd-later')).toContainText('بلا وقت إضافي');
  await expect(page.locator('#sd-today')).toHaveText('اليوم رغم ذلك (خطر وقت إضافي)');
  await page.screenshot({ path: path.join(SHOTS, 'cold-after-hours-ar.png') });
});
