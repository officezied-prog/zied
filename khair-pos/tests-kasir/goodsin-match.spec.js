// v12 goods-in: what is typed is compared with the photographed supplier note (live and on the server: MISMATCH → fix or
// reason), the saved goods-in gets a purchase_no and is locked; a correction is only a request that a manager approves.
// Every step leaves a row in the owner's activity log.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const NOTE = items => ({ supplier: 'CV Timur Tengah Food', date: '', invoice_no: 'TTF-7731', total: 0, items });

async function scanNote(page, items) {
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE(items));
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-ok')).toContainText(`${items.length} baris`);
}

test('MISMATCH → reason; saved goods-in is read-only; correction request → manager approves → stock moves; activity rows', async ({ page, context }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const med = H.productByName(db0, /Medjool/), gula = H.productByName(db0, /Gula Pasir/);
  await scanNote(page, [
    { name: 'KURMA MEDJOOL JUMBO 1KG', qty: 10, unit: 'kg', unit_price: 170000, total: 1700000 },
    { name: 'GULA PASIR 1 KG', qty: 50, unit: 'pak', unit_price: 15000, total: 750000 }
  ]);
  const lines = page.locator('#pu-lines .pu-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toHaveAttribute('data-idx', '0');
  await expect(lines.nth(1)).toHaveAttribute('data-idx', '1');
  await expect(page.locator('#pu-match-box')).toHaveAttribute('data-status', 'cocok');
  await expect(page.locator('#pu-match-box')).toContainText('Cocok dengan nota');

  // typed 12 where the note says 10 → red line + live comparison
  await lines.nth(0).locator('[data-pu-qty]').fill('12');
  await expect(lines.nth(0)).toHaveClass(/diff/);
  await expect(lines.nth(0).locator('.noteq')).toContainText('Diketik 12, di nota 10');
  await expect(page.locator('#pu-match-box')).toHaveAttribute('data-status', 'tidak_cocok');
  await expect(page.locator('#pu-live-diffs tr.bad')).toHaveCount(1);
  await H.pickCarrier(page);
  await page.click('#pu-save');
  const mm = page.locator('#pu-mismatch');
  await expect(mm).toBeVisible();
  await expect(mm.locator('#pu-mm-diffs tr.bad')).toHaveCount(1);
  await expect(mm.locator('#pu-mm-diffs tr.bad')).toContainText('Medjool');
  await expect(mm.locator('#pu-mm-diffs tr.bad td').nth(1)).toHaveText('12');
  await expect(mm.locator('#pu-mm-diffs tr.bad td').nth(2)).toHaveText('10');
  await H.shot(page, 'phone-36-goodsin-mismatch', false, { noToasts: true });
  // nothing was saved by the refused request
  expect((await H.getDb(page)).purchases.length).toBe(db0.purchases.length);
  await page.click('#pu-mm-save');
  await expect(page.locator('#pu-mm-err')).toContainText('Wajib');
  await page.fill('#pu-mm-reason', '2 kg bonus dari supplier');
  await page.click('#pu-mm-save');

  // saved: purchase_no + match badge, read-only lines, locked
  const res = page.locator('#pu-res');
  await expect(res).toContainText('Barang masuk tersimpan');
  await expect(page.locator('#pu-mismatch')).toHaveCount(0);
  const no = (await page.locator('#pu-res-no').textContent()).trim();
  expect(no).toMatch(/^PB\d{6}-[A-Z0-9]{4}$/);
  await expect(page.locator('#pu-res-match')).toHaveText('Beda dengan nota');
  await expect(page.locator('#pu-res-reason')).toContainText('2 kg bonus dari supplier');
  await expect(res.locator('input, select, textarea')).toHaveCount(0);
  await expect(page.locator('#pu-res-locked')).toContainText('Jumlah terkunci');
  await expect(res).not.toContainText(/modal|HPP|170\.000/i);
  let db = await H.getDb(page);
  const rows = db.purchases.filter(r => r.purchase_no === no);
  expect(rows).toHaveLength(2);
  expect(rows.every(r => r.match_status === 'tidak_cocok' && r.user === 'Siti' && r.photo_id.startsWith('PH-'))).toBe(true);
  expect(rows[0].match_notes).toContain('alasan: 2 kg bonus dari supplier');
  expect(rows[0].match_notes).toContain('input 12 / nota 10');
  expect(H.productByName(db, /Medjool/).stock).toBe(med.stock + 12);
  expect(H.productByName(db, /Gula Pasir/).stock).toBe(gula.stock + 50);
  const masuk = db.activity.find(a => a.kind === 'masuk' && a.ref === no);
  expect(masuk).toMatchObject({ user: 'Siti', role: 'kasir', level: 'warn', amount: 12 * 170000 + 50 * 15000 });
  expect(masuk.summary).toContain('nota: tidak_cocok');

  // history (today and recent), grouped by purchase_no → "Minta koreksi"
  const h = page.locator(`#pu-hist .hist[data-no="${no}"]`);
  await expect(h).toContainText('Kurma Medjool Jumbo 1 kg');
  await expect(h).toContainText('12 kg');
  await h.locator('[data-act="pu-fix"]').click();
  const fx = page.locator('#pu-fix');
  await expect(fx).toBeVisible();
  await expect(fx).not.toContainText('Rp'); // the cashier never sees cost
  await fx.locator(`[data-fix-qty="${gula.id}"]`).fill('48');
  await page.click('#fx-send');
  await expect(page.locator('#fx-err')).toContainText('Alasan');
  await page.fill('#fx-reason', 'Dihitung ulang: 2 pak rusak');
  await expect(page.locator('#fx-err')).toHaveText('');
  await H.shot(page, 'phone-37-correction-request', false, { noToasts: true });
  await page.click('#fx-send');
  await expect(page.locator('#fx-pending')).toContainText('Menunggu persetujuan manajer');
  db = await H.getDb(page);
  const ap = db.approvals.find(a => a.kind === 'purchase_fix' && a.ref === no);
  expect(ap).toMatchObject({ status: 'pending', cashier: 'Siti', approver_role: 'manager', note: 'Dihitung ulang: 2 pak rusak' });
  expect(ap.summary).toContain('Gula Pasir 1 kg 50→48');
  expect(H.productByName(db, /Gula Pasir/).stock).toBe(gula.stock + 50); // nothing changes before the approval
  expect(db.activity.find(a => a.kind === 'minta_koreksi' && a.ref === no)).toMatchObject({ user: 'Siti', level: 'warn' });
  await H.closeModals(page);
  await expect(page.locator(`#pu-hist .hist[data-no="${no}"] [data-pending]`)).toContainText('Menunggu persetujuan manajer');
  await H.tab(page, 'more');
  await page.click('#m-myreq');
  await expect(page.locator(`#myreq [data-req="${ap.request_id}"]`)).toContainText(`Koreksi barang masuk ${no}`);
  await expect(page.locator(`#myreq [data-req="${ap.request_id}"] [data-status]`)).toHaveAttribute('data-status', 'pending');
  await H.closeModals(page);

  // as on the server, the decision must name the goods-in (purchase_no = approval.ref)
  const wrong = await page.evaluate(async id => { try { await apiRaw('decide_approval', { request_id: id, decision: 'approved', purchase_no: 'PB000000-XXXX' }, { key: 'demo', user: 'Jihan', pin_hash: await pinHash('demo', 'Jihan', '2222') }); return 'ok'; } catch (e) { return e.code; } }, ap.request_id);
  expect(wrong).toBe('INVALID');

  // the manager approves on her phone
  const p2 = await context.newPage();
  await p2.addInitScript(() => { localStorage.removeItem('kpos.mock.kasir.session'); });
  await H.login(p2, 'Jihan', '2222');
  await p2.click('#tb-appr');
  const card = p2.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'purchase_fix');
  await expect(card).toContainText(`Koreksi barang masuk ${no}`);
  await expect(card.locator('[data-pfix-lines]')).toContainText('Gula Pasir 1 kg');
  await expect(card.locator('[data-pfix-lines] td').nth(1)).toHaveText('50');
  await expect(card.locator('[data-pfix-lines] td').nth(2)).toContainText('48');
  await expect(card).not.toContainText('Rp');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  db = await H.getDb(p2);
  expect(H.productByName(db, /Gula Pasir/).stock).toBe(gula.stock + 48);
  const fix = db.purchases.filter(r => r.purchase_no === no && r.match_status === 'koreksi');
  expect(fix).toHaveLength(1);
  expect(fix[0]).toMatchObject({ product_id: gula.id, qty: -2, total: -30000, user: 'Jihan' });
  expect(fix[0].note).toContain(`KOREKSI ${no}: 50→48`);
  expect(fix[0].match_notes).toContain('diminta Siti, disetujui Jihan');
  expect(db.approvals.find(a => a.request_id === ap.request_id)).toMatchObject({ status: 'approved', decided_by: 'Jihan' });
  expect(db.activity.find(a => a.kind === 'keputusan' && a.ref === ap.request_id)).toMatchObject({ user: 'Jihan', role: 'manager', level: 'info' });

  // the cashier sees the decision; the history shows the corrected quantity and the correction
  await page.click('#m-myreq');
  await page.click('#mr-refresh');
  await expect(page.locator(`#myreq [data-req="${ap.request_id}"] [data-status]`)).toHaveAttribute('data-status', 'approved');
  await H.closeModals(page);
  await H.tab(page, 'masuk');
  await page.click('[data-act="pu-hist-refresh"]');
  const h2 = page.locator(`#pu-hist .hist[data-no="${no}"]`);
  await expect(h2).toContainText('48 pak');
  await expect(h2).toContainText('1 koreksi');
});

test('a manager corrects directly (no request), the owner sees it as koreksi_masuk; the server rules for unclear notes', async ({ page }) => {
  await H.login(page, 'Jihan', '2222');
  const db0 = await H.getDb(page);
  const gula = H.productByName(db0, /Gula Pasir/);
  await scanNote(page, [{ name: 'GULA PASIR 1 KG', qty: 20, unit: 'pak', unit_price: 15000, total: 300000 }]);
  await H.pickCarrier(page);
  await page.click('#pu-save');
  await expect(page.locator('#pu-res-match')).toHaveText('Cocok dengan nota');
  const no = (await page.locator('#pu-res-no').textContent()).trim();
  await page.click('#pu-res-fix');
  await page.locator(`#pu-fix [data-fix-qty="${gula.id}"]`).fill('21');
  await page.fill('#fx-reason', 'Satu pak terselip');
  await expect(page.locator('#fx-send')).toContainText('Simpan koreksi');
  await page.click('#fx-send');
  await expect(page.locator('#pu-fix')).toHaveCount(0);
  const db = await H.getDb(page);
  expect(H.productByName(db, /Gula Pasir/).stock).toBe(gula.stock + 21);
  expect(db.approvals.some(a => a.kind === 'purchase_fix' && a.ref === no)).toBe(false);
  expect(db.activity.find(a => a.kind === 'koreksi_masuk' && a.ref === no)).toMatchObject({ user: 'Jihan', level: 'warn', amount: 15000 });
  expect(db.activity.find(a => a.kind === 'masuk' && a.ref === no).level).toBe('info');
  // server matching rules (shared with the live check): name match without photo_index, missing qty → perlu_cek
  const r = await page.evaluate(() => {
    const M = window.KASIR.NoteMatch;
    return [
      M.match([{ name: 'Gula Pasir 1 kg', qty: 5 }], { items: [{ name: 'GULA PASIR 1KG', qty: 5 }] }).status,
      M.match([{ name: 'Gula Pasir 1 kg', qty: 5, photo_index: 0 }], { items: [{ name: 'GULA', qty: null }] }).status,
      M.match([{ name: 'Gula Pasir 1 kg', qty: 5 }], { readable: false, items: [] }).status,
      M.match([{ name: 'Tasbih Kayu', qty: 1 }], { items: [{ name: 'GULA PASIR 1KG', qty: 5 }] }).diffs.length
    ];
  });
  expect(r).toEqual(['cocok', 'perlu_cek', 'perlu_cek', 2]);
});
