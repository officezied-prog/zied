// v12 Goods-in checked against the photographed supplier note; locked after saving; corrections with approval.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, productByName, nav, photoFile, asUser, typePin, pickCarrier, CARRIER, switchUser } = require('./helpers');

const NOTE = { supplier: 'PT Kurma Nusantara', date: null, invoice_no: 'KN-7781', total: 2450000,
  items: [{ name: 'KURMA MEDJOOL JUMBO 1KG', qty: 10, unit: 'kg', unit_price: 170000, total: 1700000 }, { name: 'GULA PASIR 1 KG', qty: 50, unit: 'pak', unit_price: 15000, total: 750000 }] };
async function scanNote(page) {
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE);
  await nav(page, 'purchases');
  await page.setInputFiles('#pu-photo', await photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-card')).toHaveClass(/done/);
  await expect(page.locator('#pu-lines tbody tr[data-line]')).toHaveCount(2);
}

test('live comparison with the note; MISMATCH shows the differences; fix quantities → saved "cocok" with a purchase number', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db0 = await getDb(page), med = productByName(db0, /Medjool/), gula = productByName(db0, /Gula Pasir/);
  await scanNote(page);
  await expect(page.locator('#pu-cmp-panel')).toHaveAttribute('data-status', 'cocok');
  await expect(page.locator('#pu-cmp tr[data-cmp="ok"]')).toHaveCount(2);
  await page.locator('[data-pu-qty="0"]').fill('12');
  await expect(page.locator('#pu-cmp-panel')).toHaveAttribute('data-status', 'tidak_cocok');
  await expect(page.locator('#pu-cmp tr[data-cmp="diff"]')).toContainText('KURMA MEDJOOL');
  // the app sends photo_index with every line
  await page.evaluate(() => { window.__bodies = []; const o = MockServer.request; MockServer.request = (b, x) => { window.__bodies.push(JSON.parse(JSON.stringify(b))); return o(b, x); }; });
  await pickCarrier(page);
  await page.click('#pu-save');
  await expect(page.locator('#pu-mismatch')).toBeVisible();
  await expect(page.locator('#pu-mm-diffs tbody tr.diff')).toHaveCount(1);
  await expect(page.locator('#pu-mm-diffs tbody tr')).toContainText('12');
  await expect(page.locator('#pu-mm-diffs tbody tr')).toContainText('10');
  const sent = (await page.evaluate(() => window.__bodies)).find(b => b.action === 'save_purchase');
  expect(sent.data.items.map(i => i.photo_index)).toEqual([0, 1]);
  expect((await getDb(page)).purchases.filter(r => r.supplier === 'PT Kurma Nusantara' && r.note === 'Nota KN-7781').length).toBe(0); // nothing saved
  await page.screenshot({ path: path.join(SHOTS, 'desktop-goodsin-mismatch.png') });
  // "Perbaiki jumlah": use the quantity of the note
  await page.click('#pu-fixqty');
  await expect(page.locator('#pu-mismatch')).toHaveCount(0);
  await page.locator('#pu-cmp [data-act="pu-usenote"]').click();
  await expect(page.locator('[data-pu-qty="0"]')).toHaveValue('10');
  await expect(page.locator('#pu-cmp-panel')).toHaveAttribute('data-status', 'cocok');
  await pickCarrier(page);
  await page.click('#pu-save');
  await expect(page.locator('#pu-res')).toBeVisible();
  await expect(page.locator('#pu-match-badge')).toHaveAttribute('data-status', 'cocok');
  const no = await page.locator('#pu-no').textContent();
  expect(no).toMatch(/^PB\d{6}-[A-Z0-9]{4}$/);
  const db = await getDb(page);
  const rows = db.purchases.filter(r => r.purchase_no === no);
  expect(rows.map(r => [r.product_id, r.qty, r.match_status])).toEqual([[med.id, 10, 'cocok'], [gula.id, 50, 'cocok']]);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'masuk', ref: no, level: 'info' });
  // the history shows the note with its status and a "Koreksi" button
  await expect(page.locator(`#pu-hist tr[data-no="${no}"] [data-status="cocok"]`)).toBeVisible();
});

test('"Simpan dengan alasan" saves a different quantity as tidak_cocok with the reason; the owner corrects later (cost visible)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const gula = productByName(await getDb(page), /Gula Pasir/);
  await scanNote(page);
  await page.locator('[data-pu-qty="1"]').fill('52');
  await pickCarrier(page);
  await page.click('#pu-save');
  await expect(page.locator('#pu-mismatch')).toBeVisible();
  await page.fill('#pu-reason', '2 pak bonus dari sales');
  await page.click('#pu-save-reason');
  await expect(page.locator('#pu-match-badge')).toHaveAttribute('data-status', 'tidak_cocok');
  const no = await page.locator('#pu-no').textContent();
  let db = await getDb(page);
  const g0 = db.purchases.find(r => r.purchase_no === no && r.product_id === gula.id);
  expect(g0.match_notes).toContain('alasan: 2 pak bonus dari sales');
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'masuk', level: 'warn' });
  const before = productByName(db, /Gula Pasir/);

  // correction by the owner: applied at once, cost field visible
  await page.locator(`#pu-hist tr[data-no="${no}"] [data-act="pu-fix"]`).click();
  await expect(page.locator(`#fx-table [data-fix-cost="${gula.id}"]`)).toBeVisible();
  await page.fill(`#fx-table [data-fix-qty="${gula.id}"]`, '50');
  await page.click('#fx-save');
  await expect(page.locator('#fx-err')).toContainText('Alasan');
  await page.fill('#fx-reason', 'Bonus dikembalikan');
  await page.click('#fx-save');
  await expect(page.locator('.toast.ok').filter({ hasText: no })).toBeVisible();
  db = await getDb(page);
  const fix = db.purchases.filter(r => r.purchase_no === no && r.match_status === 'koreksi');
  expect(fix).toHaveLength(1);
  expect(fix[0]).toMatchObject({ product_id: gula.id, qty: -2, total: -2 * 15000 });
  const after = productByName(db, /Gula Pasir/);
  expect(after.stock).toBe(before.stock - 2);
  const ns = before.stock - 2;
  expect(after.cost_price).toBe(Math.round((before.stock * before.cost_price - 30000) / ns));
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'koreksi_masuk', level: 'warn', ref: no });
  await expect(page.locator(`#pu-hist tr[data-no="${no}"] [data-status="koreksi"]`)).toBeVisible();
});

test('a cashier\'s correction waits for the manager: before → after card without cost, approve with purchase_no; stock and cost updated', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const med = productByName(await getDb(page), /Medjool/);
  await scanNote(page);
  await pickCarrier(page);
  await page.click('#pu-save');
  const no = await page.locator('#pu-no').textContent();
  // locked: the kasir can only ask
  const req = await asUser(page, 'Siti', '1111', 'request_purchase_fix', { purchase_no: no, lines: [{ product_id: med.id, qty: 8 }], reason: '2 dus rusak dikembalikan' });
  expect(req).toMatchObject({ applied: false });
  expect(req.approval).toMatchObject({ kind: 'purchase_fix', ref: no, approver_role: 'manager' });
  expect((await asUser(page, 'Siti', '1111', 'request_purchase_fix', { purchase_no: no, lines: [{ product_id: med.id, qty: 8 }], reason: '' })).error).toBe('INVALID');
  // decide without purchase_no → refused
  expect((await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: req.request_id, decision: 'approved' })).error).toBe('INVALID');

  const before = productByName(await getDb(page), /Medjool/);
  await switchUser(page, 'Jihan', '2222');
  await expect(page.locator('#tb-user')).toHaveText('Jihan');
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${req.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'purchase_fix');
  await expect(card.locator('[data-fix-changes] tr[data-pid]')).toContainText('10');
  await expect(card.locator('[data-fix-changes] tr[data-pid]')).toContainText('8');
  await expect(card.locator('[data-fix-changes] th')).toHaveCount(3); // no money column for the manager
  await expect(card).not.toContainText('Rp 1.700.000');
  await expect(card).toContainText('2 dus rusak dikembalikan');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approvals-purchase-fix.png') });
  await card.locator('[data-d="approved"]').click();
  await expect(page.locator('.toast.ok').filter({ hasText: req.request_id })).toBeVisible();
  const db = await getDb(page);
  const fix = db.purchases.filter(r => r.purchase_no === no && r.match_status === 'koreksi');
  expect(fix).toHaveLength(1);
  expect(fix[0]).toMatchObject({ product_id: med.id, qty: -2, total: -340000, cost_price: 170000 });
  expect(fix[0].note).toContain('disetujui Jihan');
  const after = productByName(db, /Medjool/);
  expect(after.stock).toBe(before.stock - 2);
  expect(after.cost_price).toBe(Math.round((before.stock * before.cost_price - 340000) / (before.stock - 2)));
  expect(db.approvals.find(a => a.request_id === req.request_id).status).toBe('approved');
  expect(db.activity.filter(a => a.kind === 'keputusan').slice(-1)[0].summary).toContain('purchase_fix');
  // the manager's correction form has no cost fields
  await nav(page, 'purchases');
  await page.locator(`#pu-hist tr[data-no="${no}"] [data-act="pu-fix"]`).click();
  await expect(page.locator('#fx-table [data-fix-qty]')).toHaveCount(2);
  await expect(page.locator('#fx-table [data-fix-cost]')).toHaveCount(0);
});
