// v68 (owner 2026-10-20: «نعم يسجله الكاشير ويأخذ صورة للسيارة أو ما دفع له ويكتب التفاصيل بالوقت متى وكيف ولماذا دفع هذا المبلغ. يكتب في مصاريف
// الكاشير التي دفعها وخرجت من الكاشير، ويقوم التطبيق بوضعها في المكان المناسب في الإدارة المالية»): the cash the cashier paid from his drawer when
// the goods arrived (Khair Kasir) shows in the owner app — a "Tunai dari laci" badge in Sejarah barang masuk (its photo opens), and the
// confirmation: a note paid in full that way is confirmed "Sudah dibayar" (no second payment, no "tempo"); a delivery fee does not pay the goods.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, editDb, openApp, asUser } = require('./helpers');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

/** The cashier Siti (own drawer open) receives two notes: one paid in full from the drawer, one with a delivery fee from it. */
async function receiveWithCash(page) {
  await openApp(page);
  await editDb(page, `db.settings.require_purchase_photo = false;`);
  expect((await asUser(page, 'Siti', '1111', 'open_shift', { opening_cash: 1000000 })).shift).toBeTruthy();
  const ph = await asUser(page, 'Siti', '1111', 'scan_expense', { image_base64: 'data:image/png;base64,' + PNG_B64, mime: 'image/png' });
  const ph2 = await asUser(page, 'Siti', '1111', 'scan_expense', { image_base64: 'data:image/png;base64,' + PNG_B64, mime: 'image/png' });
  const prods = await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')).products.filter(p => p.active !== false && !p.repack_from && p.category !== 'Bahan kemasan').slice(0, 2).map(p => p.id));
  const note = (pid, qty, cost, sup, dp) => asUser(page, 'Siti', '1111', 'save_purchase', { supplier: sup, carrier: { type: 'pemasok', name: 'Sopir' }, items: [{ product_id: pid, qty, cost_price: cost, exp_none: true }], drawer_pay: dp });
  const a = await note(prods[0], 10, 70000, 'CV Timur Tengah Food', { amount: 700000, purpose: 'barang', note: 'Sopir minta tunai, nota lunas', photo_id: ph.photo_id });
  const b = await note(prods[1], 4, 150000, 'PT Kurma Jaya', { amount: 50000, purpose: 'ongkir', note: 'Ongkos pickup', photo_id: ph2.photo_id });
  expect(a.purchase_no, JSON.stringify(a)).toBeTruthy(); expect(b.purchase_no, JSON.stringify(b)).toBeTruthy();
  expect(a.drawer_pay).toMatchObject({ purpose: 'barang', amount: 700000, full: true });
  expect(b.drawer_pay).toMatchObject({ purpose: 'ongkir', amount: 50000, full: false });
  return { a: a.purchase_no, b: b.purchase_no, photo: ph.photo_id };
}

test('the manager sees "Tunai dari laci" (with its photo); a note paid in full from the drawer is confirmed without a second payment', async ({ page }) => {
  const { a, b, photo } = await receiveWithCash(page);
  let db = await getDb(page);
  const pays0 = db.payments.filter(x => x.supplier === 'CV Timur Tengah Food').length;
  const exps0 = db.expenses.length;
  expect(db.payments.find(x => x.proof_photo_id === photo)).toMatchObject({ direction: 'out', method: 'tunai', amount: 700000, paid_from: 'kas', match_status: 'lunas' });
  expect(db.expenses.slice(-1)[0]).toMatchObject({ category: 'transport', amount: 50000, paid_from: 'kas', note: 'Barang masuk ' + b + ' — Ongkos kirim / sopir: Ongkos pickup' });
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'purchases');
  const ra = page.locator(`#pu-hist tr[data-no="${a}"]`), rb = page.locator(`#pu-hist tr[data-no="${b}"]`);
  await expect(ra.locator('[data-dp="barang"]')).toContainText('Tunai dari laci Rp 700.000');
  await expect(ra.locator('[data-check="wait"]')).toBeVisible(); // still waits for the confirmation
  await expect(rb.locator('[data-dp="ongkir"]')).toContainText('Tunai dari laci Rp 50.000');
  // its photo (the car / the receipt) opens in the photo viewer
  await ra.locator('[data-dp-photo]').click();
  await expect(page.locator('#photo-view-img')).toHaveAttribute('src', 'data:image/png;base64,' + PNG_B64);
  await page.click('#photo-viewer [data-act="modal-close"]');

  // the confirmation: who paid how much, why, when, the note — "Sudah dibayar" only
  await ra.locator('[data-act="pu-confirm"]').click();
  const cod = page.locator('#pc-cod');
  await expect(page.locator('#pc-modal .modal-h h2')).toContainText('Konfirmasi barang masuk · ' + a); // (not the PIN screen's title)
  await expect(page.locator('#pc-modal')).not.toContainText('PIN');
  await expect(page.locator('#pc-ok')).toContainText('Konfirmasi');
  await expect(cod).toHaveAttribute('data-full', '1');
  await expect(cod).toContainText('Dibayar tunai oleh kasir Siti Rp 700.000 dari laci');
  await expect(cod).toContainText('Bayar barang (ke pemasok/sopir)');
  await expect(cod).toContainText('Sopir minta tunai, nota lunas');
  await expect(cod).toContainText('tidak ada pembayaran kedua');
  await expect(page.locator('#pc-cod-photo')).toBeVisible();
  await expect(page.locator('#pc-k-lunas')).toHaveClass(/on/);
  await expect(page.locator('#pc-k-tempo')).toBeDisabled();
  await expect(page.locator('#pc-m')).toBeHidden();
  await expect(page.locator('#pc-tf')).toBeHidden();
  await expect(page.locator('#pc-kas-row')).toBeHidden();
  await expect(page.locator('#pc-before-row')).toBeHidden();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-v68-confirm-drawer-pay.png') });
  await page.click('#pc-ok');
  await expect(page.locator('#pc-modal')).toHaveCount(0);
  await expect(ra.locator('[data-check="lunas"]')).toContainText('Lunas · Tunai');
  db = await getDb(page);
  expect(db.payments.filter(x => x.supplier === 'CV Timur Tengah Food').length).toBe(pays0); // no second payment
  expect(db.purchases.filter(r => r.purchase_no === a).map(r => [r.check_status, r.checked_by, r.pay_status, r.pay_method])).toEqual([['dikonfirmasi', 'Jihan', 'lunas', 'tunai']]);
  expect(db.activity.filter(x => x.kind === 'notifikasi').slice(-1)[0].summary).toMatch(new RegExp(a + ' .* dikonfirmasi manajer Jihan: sudah dibayar tunai oleh kasir Siti Rp 700\\.000 dari laci saat barang masuk \\(tanpa pembayaran baru\\)$'));

  // a delivery fee does not pay the goods: the usual choice (here "bayar nanti")
  await rb.locator('[data-act="pu-confirm"]').click();
  await expect(cod).toHaveAttribute('data-full', '0');
  await expect(cod).toHaveAttribute('data-purpose', 'ongkir');
  await expect(page.locator('#pc-cod-what')).toContainText('pengeluaran kasir dari laci (Transport)');
  await expect(page.locator('#pc-k-tempo')).toBeEnabled();
  await page.click('#pc-k-tempo');
  await page.fill('#pc-due', jktToday(7));
  await page.click('#pc-ok');
  await expect(page.locator('#pc-modal')).toHaveCount(0);
  await expect(rb.locator('[data-check="tempo"]')).toBeVisible();
  expect((await getDb(page)).expenses.length).toBe(exps0);

  // Arabic + the phone (no horizontal scroll)
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'purchases');
  await expect(page.locator(`#pu-hist tr[data-no="${a}"] [data-dp="barang"]`)).toContainText('نقدًا من الدرج');
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.locator(`#pu-hist tr[data-no="${b}"] [data-dp="ongkir"]`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.locator(`#pu-hist tr[data-no="${a}"] [data-dp="barang"]`).scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(x => x.remove()));
  await page.screenshot({ path: path.join(SHOTS, 'phone-v68-goodsin-history-ar.png') });
});

test('the accountant confirms a note the cashier paid in full from the drawer; the server refuses "tempo" for it', async ({ page }) => {
  const { a } = await receiveWithCash(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  expect((await asUser(page, 'Lestari', '5555', 'confirm_purchase', { purchase_no: a, supplier: 'CV Timur Tengah Food', pay: 'tempo', due_date: jktToday(3) })).message).toMatch(/sudah dibayar tunai oleh kasir Siti Rp 700\.000/);
  await login(page, 'Lestari', '5555', '', { stay: true });
  await nav(page, 'purchases');
  const ra = page.locator(`#pu-hist tr[data-no="${a}"]`);
  await ra.locator('[data-act="pu-confirm"]').click();
  await expect(page.locator('#pc-cod')).toHaveAttribute('data-full', '1');
  await expect(page.locator('#pc-k-tempo')).toBeDisabled();
  await page.click('#pc-ok');
  await expect(page.locator('#pc-modal')).toHaveCount(0);
  await expect(ra.locator('[data-check="lunas"]')).toContainText('Lunas · Tunai');
  const db = await getDb(page);
  expect(db.payments.filter(x => x.supplier === 'CV Timur Tengah Food' && JSON.parse(x.alloc || '[]').some(al => al.ref === a)).length).toBe(1);
  expect(db.activity.filter(x => x.kind === 'notifikasi').slice(-1)[0].ref).toBe('owner,manager');
  // Arabic: the confirmation's texts
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'purchases');
  await expect(page.locator(`#pu-hist tr[data-no="${a}"] [data-dp="barang"]`)).toContainText('نقدًا من الدرج');
  expect(await page.evaluate(() => [t('pd.full'), t('pd.head', { name: 'Siti', amount: 'Rp 1' }), t('pd.no_tempo')])).toEqual(['هذه الفاتورة دُفعت بالكامل من درج الكاشير عند وصول البضاعة — صدّقها على أنها «مدفوعة»؛ لا تُسجَّل دفعة ثانية.', 'دفعه الكاشير Siti نقدًا Rp 1 من الدرج', 'دُفعت نقدًا من درج الكاشير']);
});
