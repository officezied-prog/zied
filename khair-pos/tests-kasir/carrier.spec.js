// v16 goods-in: "Siapa yang membawa barang?" is required — public transport (kind + vehicle number), a friend (name),
// the supplier's driver (optional name / plate) or one of our staff (name); optional phone. Stored on every goods-in row.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
const NOTE = { supplier: 'CV Timur Tengah Food', date: '', invoice_no: 'TTF-7001', total: 0, items: [{ name: 'GULA PASIR 1 KG', qty: 12, unit: 'pak', unit_price: 15000, total: 180000 }] };
async function scan(page) {
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE);
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-ok')).toContainText('1 ');
}

test('carrier required: public transport needs the vehicle number; stored on the rows and in the activity log', async ({ page }) => {
  await H.login(page);
  await scan(page);
  await expect(page.locator('#pu-car-pick')).toHaveText('Pilih salah satu.');
  await expect(page.locator('#pu-block')).toHaveText('Pilih siapa yang membawa barang');
  await expect(page.locator('#pu-save')).toBeDisabled();
  await H.pickCarrier(page, 'umum');
  await expect(page.locator('#pu-save')).toBeEnabled();
  await expect(page.locator('#pu-car-kind')).toHaveValue('ojek');
  await page.click('#pu-save');
  await expect(page.locator('#pu-car-err')).toHaveText('Tulis nomor kendaraannya (plat / nomor angkot)');
  await expect(page.locator('#pu-car-vehicle')).toBeFocused();
  await H.pickCarrier(page, 'umum', { kind: 'angkot', vehicle: 'm-06 <jkt>', phone: '0812-7788 99x' });
  await expect(page.locator('#pu-car-vehicle')).toHaveValue('M-06 JKT');
  await expect(page.locator('#pu-car-phone')).toHaveValue('0812778899');
  await expect(page.locator('#pu-car-vehicle')).toHaveAttribute('maxlength', '40');
  await expect(page.locator('#pu-car-phone')).toHaveAttribute('inputmode', 'tel');
  // the choice survives a re-render of the screen (draft)
  await H.tab(page, 'sell'); await H.tab(page, 'masuk');
  await expect(page.locator('#pu-car')).toHaveAttribute('data-type', 'umum');
  await expect(page.locator('#pu-car-vehicle')).toHaveValue('M-06 JKT');
  await page.evaluate(() => document.querySelector('#pu-car').scrollIntoView({ block: 'center' }));
  await H.shot(page, 'phone-51-carrier', false, { noToasts: true });
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-match')).toHaveText('Cocok dengan nota');
  const no = (await page.locator('#pu-res-no').textContent()).trim();
  const db = await H.getDb(page);
  expect(db.purchases.find(r => r.purchase_no === no)).toMatchObject({ carrier_type: 'umum', carrier_name: 'angkot', carrier_vehicle: 'M-06 JKT', carrier_phone: '62812778899' });
  expect(db.activity.find(a => a.kind === 'masuk' && a.ref === no).summary).toContain('dibawa kendaraan umum angkot M-06 JKT');
  // the next goods-in starts without a carrier
  await expect(page.locator('#pu-car')).toHaveAttribute('data-type', '');
});

test('friend / staff need a name; the server answers CARRIER_REQUIRED; setting require_carrier off; Arabic', async ({ page }) => {
  await H.login(page);
  const api = (d) => page.evaluate(async x => { try { await api('save_purchase', x); return 'ok'; } catch (e) { return e.code + ' ' + e.message; } }, d);
  const pid = (await H.getDb(page)).products[0].id;
  const base = { items: [{ product_id: pid, qty: 1, cost_price: 1000 }], supplier: 'Toko Uji' };
  await H.setDb(page, `db.settings.require_purchase_photo = false;`);
  expect(await api(base)).toBe('CARRIER_REQUIRED Pilih siapa yang membawa barang (kendaraan umum / teman / sopir pemasok / karyawan)');
  expect(await api({ ...base, carrier: { type: 'teman' } })).toBe('CARRIER_REQUIRED Tulis nama orang yang membawa barang');
  expect(await api({ ...base, carrier: { type: 'karyawan', name: '9 Budi' } })).toBe('CARRIER_REQUIRED Nama pembawa barang hanya boleh huruf');
  expect(await api({ ...base, carrier: { type: 'umum', vehicle: 'B#1' } })).toBe('CARRIER_REQUIRED Nomor kendaraan hanya boleh huruf dan angka');
  expect(await api({ ...base, carrier: { type: 'pemasok', phone: '12' } })).toBe('CARRIER_REQUIRED Nomor HP pembawa tidak valid');
  expect(await api({ ...base, supplier: '<Toko>', carrier: { type: 'pemasok' } })).toBe('ok'); // < > are removed before the checks
  expect(await api({ ...base, supplier: '-Toko', carrier: { type: 'pemasok' } })).toBe('INVALID Nama pemasok hanya boleh huruf dan angka');
  await H.setDb(page, `db.settings.require_carrier = false;`);
  expect(await api(base)).toBe('ok');
  await H.setDb(page, `db.settings.require_carrier = true; db.settings.require_purchase_photo = true;`);
  await page.evaluate(() => refreshData(true));

  await H.tab(page, 'more');
  await page.click('#lang-ar');
  await scan(page);
  await H.pickCarrier(page, 'karyawan');
  await page.click('#pu-save');
  await expect(page.locator('#pu-car-err')).toHaveText('اكتب اسم الشخص الذي أحضر البضاعة');
  await H.pickCarrier(page, 'karyawan', { name: 'رشيد <ب>' });
  await expect(page.locator('#pu-car-name')).toHaveValue('رشيد ب');
  await H.shot(page, 'phone-52-carrier-ar', false, { noToasts: true });
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-no')).toBeVisible();
  const no = (await page.locator('#pu-res-no').textContent()).trim();
  expect((await H.getDb(page)).purchases.find(r => r.purchase_no === no)).toMatchObject({ carrier_type: 'karyawan', carrier_name: 'رشيد ب' });
});
