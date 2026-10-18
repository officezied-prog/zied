// v61 (owner 2026-10-18: «ابدأ المرحلة الثانية: إرسال الواتساب تلقائيًا») — Khair Order Brad with automatic WhatsApp (demo: window.KBradMockWA
// plays the server as if WhatsApp were set up; KBradMock.waIn plays a message arriving from WhatsApp through the server's own rules).
// The step's message goes out by itself (no hand-sent window); the cold store's buttons and its "pintu 5" move the order; a tap
// from another number does not; the owner sees the WhatsApp state, registers the templates, sends a test, sets the month's cap.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS } = require('./helpers');

const COOLER = '6281200000001'; // DPP's WhatsApp in the demo
async function login(page, user = 'Jihan', pin = '2222') {
  await page.addInitScript(() => { window.KBradMockWA = true; });
  await page.clock.setFixedTime(new Date('2026-10-14T10:00:00+07:00'));
  await page.goto('brad/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kbrad.mock.db'); localStorage.removeItem('kcold.mock.db'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', user); await page.fill('#lg-pin', pin); await page.click('#lg-go');
  await expect(page.locator('#nav')).toBeVisible();
}
const card = (page, no) => page.locator(`.order[data-no="${no}"]`);
/** A message from WhatsApp, then the app's light check (the minute's poll, run now). */
async function fromWa(page, ev) {
  return page.evaluate(async ev => { const r = await KBradMock.waIn(ev); const p = await api('poll', {}); if (p.stamp !== S.D.stamp) await load(); return r; }, ev);
}

test('the order, the car and the door go out by themselves; the cold store\'s buttons and "pintu 5" move the order; another number does not', async ({ page }) => {
  await login(page);
  await page.click('#or-new');
  await page.selectOption('#of-lines [data-f="pallet_code"]', '2274537');
  await page.fill('#of-lines [data-f="cartons"]', '10');
  const opt = await page.locator('#of-cust option', { hasText: 'Toko Barokah' }).getAttribute('value');
  await page.selectOption('#of-cust', opt);
  await page.click('#of-save');
  const no = await page.evaluate(() => S.D.orders[0].order_no), c = card(page, no);
  // step 2: sent by the server — no hand-sent window, the card shows it went
  await c.locator('[data-act="send"]').click();
  await expect(page.locator('#toast')).toHaveText('Terkirim otomatis lewat WhatsApp ✓');
  await expect(page.locator('#modal')).toBeHidden();
  await expect(c.locator('[data-wa] [data-wa-dir="out"]')).toHaveText('10:00 → Order ke gudang ✓');
  // a tap from another number is shown, not applied
  await fromWa(page, { from: '6289999999999', payload: 'BRD|APPROVE|' + no, text: 'Setuju' });
  await expect(c.locator('[data-chip]')).toHaveText('2/9 Dikirim ke gudang');
  await expect(c.locator('[data-wa] [data-wa-dir="in"]').last()).toHaveText('10:00 ← “Setuju” · bukan nomor gudang — tidak diterapkan');
  // the cold store taps Setuju, then Barang siap
  await fromWa(page, { from: COOLER, payload: 'BRD|APPROVE|' + no, text: 'Setuju' });
  await expect(c.locator('[data-chip]')).toHaveText('3/9 Gudang setuju');
  await fromWa(page, { from: COOLER, payload: 'BRD|READY|' + no, text: 'Barang siap' });
  await expect(c.locator('[data-chip]')).toHaveText('4/9 Barang siap');
  await expect(c.locator('[data-log]')).toContainText('WhatsApp DPP Cold Storage');
  // step 5: the car, sent by itself
  await c.locator('[data-act="car"]').click();
  await page.fill('#tk-driver', 'Pak Budi'); await page.fill('#tk-dwa', '081299990000'); await page.fill('#tk-plate', 'B 1234 XYZ'); await page.fill('#tk-eta', '30');
  await page.click('#tk-save');
  await expect(page.locator('#toast')).toHaveText('Terkirim otomatis lewat WhatsApp ✓');
  await expect(page.locator('#modal')).toBeHidden();
  // the cold store answers the car message: "pintu 5" → in at door 5, and the door went on to the driver by itself
  await fromWa(page, { from: COOLER, text: 'Mobil sudah masuk pak, pintu 5', ctx_order_no: no });
  await expect(c.locator('[data-chip]')).toHaveText('7/9 Ke pintu');
  await expect(c.locator('[data-door]')).toHaveText('Pintu 5');
  await expect(c.locator('[data-wa] [data-wa-dir="out"]').last()).toHaveText('10:00 → Pintu ke sopir ✓');
  await page.screenshot({ path: path.join(SHOTS, 'brad-wa-card.png') });
  // the departure, sent by itself to the customer
  await c.locator('[data-act="load"]').click();
  await c.locator('[data-act="depart"]').click();
  await page.click('#dep-ok');
  await expect(page.locator('#toast')).toHaveText('Terkirim otomatis lewat WhatsApp ✓');
  await expect(page.locator('#modal')).toBeHidden();
  await expect(c.locator('[data-wa] [data-wa-dir="out"]').last()).toHaveText('10:00 → Info berangkat ke pelanggan ✓');
  // a message that belongs to no order (not a cold store's number) shows on the home page
  await fromWa(page, { from: '6281300000777', text: 'Halo, ada order baru?' });
  await page.click('[data-tab="today"]');
  await expect(page.locator('#wa-lost')).toContainText('6281300000777: “Halo, ada order baru?”');
});

test('the owner: WhatsApp active, the templates at Meta, register, a test message, the month\'s cap', async ({ page }) => {
  await login(page, 'Pemilik', '1234');
  await page.click('[data-tab="set"]');
  await expect(page.locator('#wa-on')).toHaveText('Aktif');
  await expect(page.locator('#wa-count')).toHaveText(/Bulan ini: \d+ dari 3000 pesan/);
  await expect(page.locator('#wa-hook')).toHaveText('Alamat webhook untuk Meta: https://khair-mart-jumla.officezied.workers.dev/webhook/wa');
  await page.click('#wa-check');
  await expect(page.locator('#wa-set')).toHaveText('✓ Token · ✓ Phone ID · ✓ WABA ID · ✓ App secret · ✓ Verify token');
  await expect(page.locator('#wa-tpl [data-tpl]')).toHaveCount(4);
  await expect(page.locator('#wa-tpl [data-tpl="khair_order_brad"]')).toHaveText('khair_order_brad: APPROVED');
  await page.screenshot({ path: path.join(SHOTS, 'brad-wa-settings.png') });
  await page.click('#wa-reg');
  await expect(page.locator('#toast')).toHaveText('Template dikirim ke Meta untuk ditinjau');
  await expect(page.locator('#wa-tpl [data-tpl="khair_pintu_brad"]')).toHaveText('khair_pintu_brad: PENDING');
  await page.fill('#wa-test-to', '0812 1111 0000');
  await page.click('#wa-test');
  await expect(page.locator('#toast')).toHaveText('Pesan tes terkirim');
  await page.fill('#wa-cap', '1500');
  await page.click('#wa-cap-save');
  await expect(page.locator('#toast')).toHaveText('Tersimpan');
  expect(await page.evaluate(() => S.D.wa_cap)).toBe(1500);
});

test('not set up: the settings say so and every step is sent by hand, as before', async ({ page }) => {
  await page.addInitScript(() => { window.KBradMockWA = false; });
  await page.clock.setFixedTime(new Date('2026-10-14T10:00:00+07:00'));
  await page.goto('brad/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kbrad.mock.db'); localStorage.removeItem('kcold.mock.db'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', 'Pemilik'); await page.fill('#lg-pin', '1234'); await page.click('#lg-go');
  await page.click('[data-tab="set"]');
  await expect(page.locator('#wa-on')).toHaveText('Belum aktif — pesan dikirim manual');
  await page.click('#wa-reg');
  await expect(page.locator('#toast')).toContainText('WhatsApp belum disiapkan');
  await page.click('[data-tab="today"]');
  await page.locator('.order[data-status="sent"] [data-act="rewa"]').first().click();
  await expect(page.locator('#wa-go')).toBeVisible(); // the hand-sent window, as in stage 1
});

// v61.1 (owner 2026-10-18: «اريد تجربة افتراضي لعملية كاملة») — the demo plays the whole automatic process: a switch (?wa=1 / ?wa=0,
// remembered on the device) and on each order the phone that got the step's message, with the cold store's buttons to tap.
test('demo: the switch, and the simulated phones — the cold store taps Setuju and Barang siap, answers "pintu 9"; the driver and the customer get theirs', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T10:00:00+07:00'));
  await page.goto('brad/index.html?mock=1');
  await page.evaluate(() => { try { ['kbrad.mock.db', 'kcold.mock.db', 'kbrad.mock.wa'].forEach(k => localStorage.removeItem(k)); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', 'Jihan'); await page.fill('#lg-pin', '2222'); await page.click('#lg-go');
  // off at first: sent by hand, no phone on the cards
  await expect(page.locator('#demo-wa-st')).toHaveText('mati — pesan dikirim manual');
  await expect(page.locator('.dm-phone')).toHaveCount(0);
  await page.click('#demo-wa-toggle');
  await expect(page.locator('#demo-wa-st')).toHaveText('Aktif');
  // the seeded order waiting at Kawanishi: its phone has the order with the three buttons
  const k = page.locator('.order[data-status="sent"]').first();
  await expect(k.locator('.dm-phone')).toContainText('📱 HP gudang Kawanishi menerima:');
  await expect(k.locator('[data-act^="dm-"]')).toHaveText(['Setuju', 'Tolak', 'Barang siap']);
  // remembered on the device; ?wa=0 turns it off, ?wa=1 on again
  await page.goto('brad/index.html?mock=1'); await expect(page.locator('#demo-wa-st')).toHaveText('Aktif');
  await page.goto('brad/index.html?mock=1&wa=0'); await expect(page.locator('#demo-wa-st')).toHaveText('mati — pesan dikirim manual');
  await page.goto('brad/index.html?mock=1&wa=1'); await expect(page.locator('#demo-wa-st')).toHaveText('Aktif');
  // a new order, sent by itself: DPP's phone shows the template with its values
  await page.click('#or-new');
  await page.selectOption('#of-lines [data-f="pallet_code"]', '2274537');
  await page.fill('#of-lines [data-f="cartons"]', '10');
  await page.selectOption('#of-cust', await page.locator('#of-cust option', { hasText: 'Toko Barokah' }).getAttribute('value'));
  await page.click('#of-save');
  const no = await page.evaluate(() => S.D.orders[0].order_no), c = card(page, no);
  await c.locator('[data-act="send"]').click();
  await expect(page.locator('#toast')).toHaveText('Terkirim otomatis lewat WhatsApp ✓');
  await expect(c.locator('.dm-phone')).toContainText('📱 HP gudang DPP Cold Storage menerima:');
  await expect(c.locator('[data-dm-text]')).toContainText('Order ambil Khair Mart ' + no + '\nTanggal ambil: Rabu, 14 Oktober 2026\nGudang: DPP Cold Storage\nTujuan: Toko Barokah (pelanggan)');
  // the cold store taps Setuju, then Barang siap
  await c.locator('[data-act="dm-approve"]').click();
  await expect(page.locator('#toast')).toHaveText('gudang setuju (otomatis)');
  await expect(c.locator('[data-chip]')).toHaveText('3/9 Gudang setuju');
  await c.locator('[data-act="dm-ready"]').click();
  await expect(c.locator('[data-chip]')).toHaveText('4/9 Barang siap');
  await expect(c.locator('.dm-phone')).toHaveCount(0); // now it is our turn: the car
  // the car goes to the cold store by itself; it answers "pintu 9" → in at door 9, and the door goes on to the driver
  await c.locator('[data-act="car"]').click();
  await page.fill('#tk-driver', 'Pak Budi'); await page.fill('#tk-dwa', '081299990000'); await page.fill('#tk-plate', 'B 1234 XYZ'); await page.fill('#tk-eta', '30');
  await page.click('#tk-save');
  await expect(page.locator('#modal')).toBeHidden();
  await expect(c.locator('[data-dm-text]')).toContainText('No. polisi: B 1234 XYZ\nSopir: Pak Budi (081299990000)');
  await expect(c.locator('[data-act="dm-in"]')).toHaveText('Mobil sudah masuk');
  await c.locator('[data-act="dm-door"]').click(); // no door typed: nothing sent
  await expect(c.locator('[data-chip]')).toHaveText('5/9 Mobil dipesan');
  await c.locator('[data-dm="door"]').fill('9');
  await c.locator('[data-act="dm-door"]').click();
  await expect(page.locator('#toast')).toHaveText('pintu dicatat (otomatis)');
  await expect(c.locator('[data-chip]')).toHaveText('7/9 Ke pintu');
  await expect(c.locator('.dm-phone')).toContainText('📱 HP sopir Pak Budi menerima:');
  await expect(c.locator('[data-dm-text]')).toContainText('PINTU 9');
  await page.screenshot({ path: path.join(SHOTS, 'brad-demo-phone.png') });
  // loading, then gone: the customer's phone
  await c.locator('[data-act="load"]').click();
  await c.locator('[data-act="depart"]').click();
  await page.click('#dep-ok');
  await expect(c.locator('[data-chip]')).toHaveText('9/9 Berangkat');
  await expect(c.locator('.dm-phone')).toContainText('📱 HP pelanggan Toko Barokah menerima:');
  await expect(c.locator('[data-dm-text]')).toContainText('sudah berangkat dari DPP Cold Storage jam 10:00. Mobil B 1234 XYZ');
  // in Arabic too
  await page.click('#lang');
  await expect(c.locator('.dm-phone')).toContainText('📱 هاتف الزبون Toko Barokah استلم:');
  await expect(page.locator('#demo-wa-toggle')).toHaveText('إيقاف');
});
