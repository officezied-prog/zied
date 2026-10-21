// v68 (owner 2026-10-20: «نعم يسجله الكاشير ويأخذ صورة للسيارة أو ما دفع له ويكتب التفاصيل بالوقت متى وكيف ولماذا دفع هذا المبلغ. يكتب في مصاريف
// الكاشير التي دفعها وخرجت من الكاشير، ويقوم التطبيق بوضعها في المكان المناسب في الإدارة المالية»): on the goods-in screen the cashier records the cash
// he paid from his drawer when the goods arrived — how much, why, the time (by itself), a note and a photo. The goods' price becomes a
// supplier payment for the note, a delivery fee / porters a cashier expense; both are cash out of his drawer (Kas, the drawer close).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

/** Goods-in screen with one line (Kurma Ajwa 5 × 140.000 = 700.000, no expiry), a supplier and who brought it. */
async function fillNote(page, sup = 'CV Timur Tengah Food') {
  await H.setDb(page, `db.settings.require_purchase_photo = false;`);
  await page.evaluate(() => refreshData(true));
  await H.tab(page, 'masuk');
  await page.fill('#pu-sup', sup);
  await page.fill('#pu-q', 'Ajwa');
  await page.locator('[data-act="pu-add"]').first().click();
  await page.locator('[data-pu-qty="0"]').fill('5');
  await page.locator('[data-pu-cost="0"]').fill('140.000');
  await page.locator('[data-pu-expnone="0"]').check();
  await H.pickCarrier(page);
  await expect(page.locator('#pu-total')).toHaveText(H.rp(700000));
}
const myShift = db => db.shifts.find(s => s.cashier === 'Siti' && s.status === 'open');

test('"bayar barang" from the drawer: amount, why, time, note and photo → a supplier payment for the note; Kas and the drawer close show the cash out', async ({ page }) => {
  await H.login(page, 'Siti', '1111', { openingCash: 1000000 });
  await fillNote(page);
  // off by default: the goods-in screen is as before
  await expect(page.locator('#pu-dp')).toHaveAttribute('data-on', '0');
  await expect(page.locator('#pu-dp-body')).toHaveCount(0);
  await expect(page.locator('#pu-dp-noshift')).toHaveCount(0);
  await page.check('#pu-dp-on');
  await expect(page.locator('#pu-dp-body')).toBeVisible();
  await expect(page.locator('#pu-dp-why-barang')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#pu-dp-where')).toHaveAttribute('data-where', 'payment');
  await expect(page.locator('#pu-dp-how')).toContainText('tunai dari laci kasir');
  await expect(page.locator('#pu-dp-when')).toContainText(new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10).split('-').reverse().join('/'));
  await page.click('#pu-dp-use-total');
  await expect(page.locator('#pu-dp-amt')).toHaveValue('700.000');
  const n0 = (await H.getDb(page)).purchases.length;
  // the note and the photo are required; the goods' price never more than the note's total
  await page.click('#pu-save');
  await expect(page.locator('#pu-err')).toContainText('kenapa / untuk apa');
  await page.fill('#pu-dp-note', 'Sopir minta tunai, nota lunas');
  await page.click('#pu-save');
  await expect(page.locator('#pu-err')).toContainText('Foto wajib');
  await page.setInputFiles('#pu-dp-photo', await H.photoFile(page, 'mobil.png'));
  await expect(page.locator('#pu-dp-photo-ok')).toBeVisible();
  await expect(page.locator('#pu-dp-thumb')).toBeVisible();
  await page.fill('#pu-dp-amt', '800.000');
  await page.click('#pu-save');
  await expect(page.locator('#pu-err')).toContainText('tidak boleh lebih dari total nota ' + H.rp(700000));
  expect((await H.getDb(page)).purchases.length).toBe(n0);
  await page.click('#pu-dp-use-total');
  await page.locator('#pu-dp').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await H.shot(page, 'phone-v68-goodsin-drawer-pay', false, { noToasts: true });
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-no')).toBeVisible();
  const no = await page.locator('#pu-res').getAttribute('data-no');
  await expect(page.locator('#pu-res-dp')).toHaveAttribute('data-purpose', 'barang');
  await expect(page.locator('#pu-res-dp')).toContainText('Tunai dari laci ' + H.rp(700000));
  await expect(page.locator('#pu-res-dp')).toContainText('nota lunas');
  // the form is clear again, the section closed
  await expect(page.locator('#pu-dp')).toHaveAttribute('data-on', '0');

  const db = await H.getDb(page), sh = myShift(db);
  const pay = db.payments[db.payments.length - 1], photo = db.photos.find(p => p.photo_id === pay.proof_photo_id);
  expect(pay).toMatchObject({ direction: 'out', party_type: 'supplier', supplier: 'CV Timur Tengah Food', method: 'tunai', amount: 700000, paid_from: 'kas', shift_id: sh.shift_id, match_status: 'lunas', cashier: 'Siti' });
  expect(JSON.parse(pay.alloc)).toEqual([{ ref: no, amount: 700000 }]);
  expect(pay.note).toBe('Barang masuk ' + no + ' dibayar tunai oleh kasir Siti [dari kas] | Sopir minta tunai, nota lunas');
  expect(photo).toMatchObject({ kind: 'biaya', user: 'Siti', match_status: '' });
  expect(photo.extracted.stored_only).toBe(true); // v70: an evidence photo, kept but never read by AI (no cost, no wait)
  const lines = db.purchases.filter(r => r.purchase_no === no);
  expect(lines.map(r => [r.pay_status, r.pay_method, r.check_status || ''])).toEqual([['lunas', 'tunai', '']]); // paid, still waiting for the manager
  expect(JSON.parse(lines[0].drawer_pay)).toMatchObject({ amount: 700000, purpose: 'barang', note: 'Sopir minta tunai, nota lunas', by: 'Siti', photo_id: photo.photo_id, pay_id: pay.pay_id });
  const notice = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(notice.ref).toBe('owner,manager,akuntan');
  expect(notice.summary).toMatch(new RegExp('^Tunai dari laci Siti Rp 700\\.000 saat barang masuk ' + no + ' dari CV Timur Tengah Food — Bayar barang \\(ke pemasok/sopir\\): "Sopir minta tunai, nota lunas" \\(.* WIB, foto terlampir\\)'));
  // the history marks the note
  await expect(page.locator(`#pu-hist .hist[data-no="${no}"] [data-dp="barang"]`)).toContainText('Tunai dari laci ' + H.rp(700000));

  // Kas: cash out of the drawer and its line
  await H.tab(page, 'kas');
  await expect(page.locator('#kas-cout')).toHaveText('-' + H.rp(700000));
  await expect(page.locator('#kas-moves')).toContainText(`Bayar pemasok CV Timur Tengah Food (${no})`);
  // the drawer close: 1.000.000 − 700.000 = 300.000 expected
  await page.click('#kas-close');
  await page.fill('#cs-counted', '300000');
  await page.click('#cs-ok');
  await expect(page.locator('#sr-expected')).toContainText(H.rp(300000));
  await expect(page.locator('#sr-diff')).toHaveAttribute('data-diff', '0');
  await expect(page.locator('#shift-report')).toContainText('-' + H.rp(700000));
});

test('delivery fee from the drawer = a cashier expense (transport) with the photo and the note; Arabic', async ({ page }) => {
  await H.login(page, 'Siti', '1111', { openingCash: 500000 });
  await fillNote(page);
  const pays0 = (await H.getDb(page)).payments.length;
  await page.check('#pu-dp-on');
  await page.click('#pu-dp-why-ongkir');
  await expect(page.locator('#pu-dp-where')).toHaveAttribute('data-where', 'expense');
  await expect(page.locator('#pu-dp-where')).toContainText('Transport');
  await expect(page.locator('#pu-dp-use-total')).toHaveCount(0); // only for the goods' price
  await page.fill('#pu-dp-amt', '50.000');
  await page.fill('#pu-dp-note', 'Ongkos pickup dari Tanah Abang');
  await page.setInputFiles('#pu-dp-photo', await H.photoFile(page, 'struk.png'));
  await expect(page.locator('#pu-dp-photo-ok')).toBeVisible();
  // Arabic, before saving
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#pu-dp')).toContainText('دُفع من درج الكاشير');
  await expect(page.locator('#pu-dp-why-ongkir')).toHaveText('أجرة التوصيل / السائق');
  await expect(page.locator('#pu-dp-where')).toContainText('مصروفًا للكاشير');
  await expect(page.locator('#pu-dp-how')).toContainText('نقدًا من درج الكاشير');
  await expect(page.locator('#pu-dp-amt')).toHaveValue('50.000'); // the draft survives the redraw
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-dp')).toHaveAttribute('data-purpose', 'ongkir');
  await expect(page.locator('#pu-res-dp')).toContainText('سُجّل مصروفًا للكاشير');
  const no = await page.locator('#pu-res').getAttribute('data-no');
  const db = await H.getDb(page), ex = db.expenses[db.expenses.length - 1];
  expect(ex).toMatchObject({ category: 'transport', amount: 50000, paid_from: 'kas', shift_id: myShift(db).shift_id, user: 'Siti', note: 'Barang masuk ' + no + ' — Ongkos kirim / sopir: Ongkos pickup dari Tanah Abang' });
  expect(db.photos.find(p => p.photo_id === ex.photo_id)).toMatchObject({ kind: 'biaya' });
  expect(db.payments.length).toBe(pays0); // not a payment: the goods are still to be paid
  expect(db.purchases.filter(r => r.purchase_no === no).map(r => r.pay_status || '')).toEqual(['']);
  await page.evaluate(() => setLang('id'));
  await H.tab(page, 'kas');
  await expect(page.locator('#kas-cout')).toHaveText('-' + H.rp(50000));
  await expect(page.locator('#kas-moves')).toContainText('Pengeluaran: transport — Barang masuk ' + no);
});

test('without an own open drawer (the manager selling without one) the section says so and cannot be used; Arabic', async ({ page }) => {
  await H.login(page, 'Jihan', '2222');
  await H.tab(page, 'masuk');
  await expect(page.locator('#pu-dp-on')).toBeDisabled();
  await expect(page.locator('#pu-dp-noshift')).toContainText('Buka laci kasir dulu');
  await expect(page.locator('#pu-dp-body')).toHaveCount(0);
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#pu-dp-noshift')).toContainText('افتح درج الكاشير أولًا');
  // the server refuses it too (no request can take cash out of a drawer that is not open)
  const r = await page.evaluate(async () => { try { return await api('save_purchase', { supplier: 'CV X', items: [{ product_id: KASIR.S.products[0].id, qty: 1, cost_price: 1000, exp_none: true }], carrier: { type: 'pemasok' }, drawer_pay: { amount: 1000, purpose: 'lain', note: 'x', photo_id: 'PH-1' } }); } catch (e) { return { error: e.code }; } });
  expect(r.error).toBe('SHIFT_REQUIRED');
  // no horizontal scroll on the phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
