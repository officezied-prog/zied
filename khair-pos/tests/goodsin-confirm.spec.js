// v65 (owner 2026-10-20: «عند استقبال البضاعة و التأكد منها من الموظف، المدير و المحاسب يصادق عليها و يكتب هل تم الدفع و بأي وسيلة دفع او
// تاريخ الدفع المتفق عليه و يدخل في المصاريف او الدين»): a goods-in note received by the cashier waits for the manager / accountant
// ("Menunggu konfirmasi", Perhatian), who confirm it as paid (how) or to be paid by an agreed date (the supplier's debt, due / late).
const { test, expect } = require('@playwright/test');
const { jktToday, login, getDb, nav, editDb, openApp, enterKey, staffSession } = require('./helpers');

// two notes the cashier Siti received today (as save_purchase leaves them)
const SEED = `
  const t = arg.today, p = db.products.filter(x => x.active !== false && !x.repack_from).slice(0, 2);
  db.seq = db.seq || {};
  const row = (no, sup, pr, qty, cost) => ({ id: (db.seq.purchase = Math.max(db.seq.purchase || 0, ...db.purchases.map(r => r.id || 0)) + 1), purchase_date: t, supplier: sup, product_id: pr.id, name: pr.name, qty, cost_price: cost, total: qty * cost, note: '', user: 'Siti', photo_id: '', exp_date: '', purchase_no: no, match_status: 'cocok', match_notes: '' });
  if (!db.purchases.some(r => r.purchase_no === 'PBT-0001')) { db.purchases.push(row('PBT-0001', 'CV Timur Tengah Food', p[0], 10, 50000)); db.purchases.push(row('PBT-0002', 'PT Kurma Jaya', p[1], 4, 150000)); }
`;

test('the manager confirms one note as paid by transfer, the accountant the other as "pay by the agreed date"; Perhatian shows them', async ({ page }) => {
  const today = jktToday(0), due = jktToday(2);
  await openApp(page);
  await editDb(page, SEED, { today });
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await login(page, 'Jihan', '2222', '', { stay: true });
  await expect.poll(() => page.evaluate(() => KPOS.S.pchecks ? KPOS.S.pchecks.waiting.map(x => x.purchase_no).sort() : null)).toEqual(['PBT-0001', 'PBT-0002']);
  await nav(page, 'purchases');
  const r1 = page.locator('#pu-hist tr[data-no="PBT-0001"]');
  await expect(r1.locator('[data-check="wait"]')).toBeVisible();
  await r1.locator('[data-act="pu-confirm"]').click();
  await expect(page.locator('#pc-modal')).toContainText('CV Timur Tengah Food');
  await expect(page.locator('#pc-total')).toHaveText('Rp 500.000');
  await page.fill('#pc-bank', 'BCA');
  await page.fill('#pc-ref', 'TRX-881');
  await page.click('#pc-ok');
  await expect(page.locator('#pc-modal')).toHaveCount(0);
  await expect(r1.locator('[data-check="lunas"]')).toContainText('Lunas · Transfer');
  let db = await getDb(page);
  const pay = db.payments.find(x => x.supplier === 'CV Timur Tengah Food' && x.direction === 'out' && x.transfer_ref === 'TRX-881'); // (the demo has older payments to this supplier)
  expect(pay).toMatchObject({ amount: 500000, method: 'transfer', bank: 'BCA', transfer_ref: 'TRX-881', match_status: 'lunas' });
  expect(JSON.parse(pay.alloc)).toEqual([{ ref: 'PBT-0001', amount: 500000 }]);
  expect(db.purchases.filter(r => r.purchase_no === 'PBT-0001').map(r => [r.check_status, r.checked_by, r.pay_status])).toEqual([['dikonfirmasi', 'Jihan', 'lunas']]);
  const n1 = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(n1.ref).toBe('owner,akuntan');
  expect(n1.summary).toMatch(/PBT-0001 dari CV Timur Tengah Food .* dikonfirmasi manajer Jihan: sudah dibayar transfer Rp 500\.000 BCA ref TRX-881$/);
  // the accountant: "bayar nanti" by the agreed date
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'purchases');
  const r2 = page.locator('#pu-hist tr[data-no="PBT-0002"]');
  await r2.locator('[data-act="pu-confirm"]').click();
  await page.click('#pc-k-tempo');
  await page.fill('#pc-due', jktToday(-1));
  await page.click('#pc-ok');
  await expect(page.locator('#pc-err')).toContainText('tanggal bayar');
  await page.fill('#pc-due', due);
  await page.fill('#pc-note', 'janji 2 hari');
  await page.click('#pc-ok');
  await expect(page.locator('#pc-modal')).toHaveCount(0);
  await expect(r2.locator('[data-check="tempo"]')).toBeVisible();
  db = await getDb(page);
  expect(db.purchases.filter(r => r.purchase_no === 'PBT-0002').map(r => [r.checked_by, r.pay_status, r.due_date])).toEqual([['Lestari', 'tempo', due]]);
  expect(db.payments.some(x => x.supplier === 'PT Kurma Jaya')).toBe(false); // nothing paid, nothing out of the day
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toMatch(new RegExp('BAYAR NANTI — jatuh tempo ' + due + ' \\(hutang ke pemasok\\) \\| janji 2 hari$'));
  // the next open: no note waits; the one on credit is due within 3 days
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await expect.poll(() => page.evaluate(() => KPOS.S.pchecks && KPOS.S.pchecks.due.map(x => [x.purchase_no, x.days, x.total]))).toEqual([['PBT-0002', 2, 600000]]);
  expect(await page.evaluate(() => KPOS.S.pchecks.waiting.length)).toBe(0);
  // Arabic
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'purchases');
  await expect(page.locator('#pu-hist tr[data-no="PBT-0002"] [data-check="tempo"]')).toContainText('آجل حتى');
});
