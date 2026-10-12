// Repacking in Khair Kasir (bulk → small packs).
// v39 (owner 2026-10-12: «طلب التعليب لا يحتاج إلى موافقات، إن شاهد العمال نقص في البضائع فعليهم أن يقوموا بالتعليب، بس يقوم بإرسال معلومات
// للمدير ولي أنا وللمحاسب»): the cashier SAVES the repack — the stock moves at once and the owner, manager and accountant are told; a double
// tap is recorded once; a second cashier repacking the same bulk within 2 h is shown who did it and when and must confirm it is another
// repack (v38: «ممكن 2 كاشير يقوم بنفس الطلب والتعليب، انتبه منها»); a v38 request still pending is finished by the manager in her inbox.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

// a bulk product (10 kg sack) with two shop packs, added to the demo data before the login (bootstrap then carries them)
const ADD = `
  const nid = () => (db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1);
  if (db.products.some(p => p.sku === 'RKB1')) return;
  const base = { category: 'Kurma', wholesale_price: 0, wholesale_min_qty: 0, min_stock: 0, active: true, notes: '' };
  const b = Object.assign({ id: nid(), sku: 'RKB1', name: 'Kurma Curah Karung', unit: 'kg', cost_price: 50000, retail_price: 70000, stock: 20, shop_stock: 0, repack_from: 0, repack_qty: 0 }, base);
  db.products.push(b);
  db.products.push(Object.assign({ id: nid(), sku: 'RKP1', name: 'Kurma Pak 500 g', unit: 'pak', cost_price: 26000, retail_price: 35000, stock: 4, shop_stock: 4, repack_from: b.id, repack_qty: 0.5 }, base));
  db.products.push(Object.assign({ id: nid(), sku: 'RKP2', name: 'Kurma Pak 250 g', unit: 'pak', cost_price: 13000, retail_price: 19000, stock: 0, shop_stock: 0, repack_from: b.id, repack_qty: 0.25 }, base));
`;
async function loginWithPacks(page, user = 'Siti', pin = '1111') {
  await H.openKasir(page);
  await H.setDb(page, ADD);
  await H.login(page, user, pin, { noGoto: true });
}
const prod = (db, sku) => db.products.find(p => p.sku === sku);
async function openForm(page) {
  await H.tab(page, 'more');
  await page.click('#m-repack');
  await expect(page.locator('#repack')).toBeVisible();
}

test('cashier: pick the pack, packs made + bulk used → yield preview; SAVE → stock moves at once, owner + manager + accountant told; a double tap is one repack', async ({ page }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page), p500 = prod(db0, 'RKP1');
  await openForm(page);
  await expect(page.locator('#repack')).toContainText('Stok langsung berubah');
  await expect(page.locator('#rk-to option')).toHaveCount(3); // "pick" + the two packs
  await page.selectOption('#rk-to', String(p500.id));
  await expect(page.locator('#rk-bulk-stock')).toContainText('20 kg');
  await page.fill('#rk-qty', '9');
  await page.fill('#rk-from', '5');
  await expect(page.locator('#rk-preview')).toContainText('seharusnya 10 kemasan');
  await expect(page.locator('#rk-preview [data-yield]')).toContainText('90,0%');
  await expect(page.locator('#rk-preview')).toHaveClass(/low/);
  await page.fill('#rk-note', 'pagi');
  await expect(page.locator('#rk-ok')).toContainText('Simpan kemas ulang');
  await H.shot(page, 'phone-repack-direct', false, { noToasts: true });
  await page.dblclick('#rk-ok'); // a double tap
  await expect(page.locator('#rk-done')).toBeVisible();
  await expect(page.locator('#rk-done')).toContainText('Kemas ulang tersimpan');
  await expect(page.locator('#rk-told')).toHaveText('Pemilik, manajer dan akuntan diberi tahu.');
  const db = await H.getDb(page);
  expect(db.approvals.filter(a => a.kind === 'repack').length).toBe(0); // no approval at all
  expect(db.repacks.filter(r => r.user === 'Siti').length).toBe(1);
  expect(db.repacks.slice(-1)[0]).toMatchObject({ user: 'Siti', to_qty: 9, from_qty: 5, yield_pct: 90, loss_qty: 0.5, note: 'pagi' });
  expect(prod(db, 'RKB1').stock).toBe(15);
  expect(prod(db, 'RKP1').stock).toBe(13);
  const n = db.activity.filter(a => a.kind === 'notifikasi' && /Kemas ulang oleh kasir Siti/.test(a.summary));
  expect(n.map(a => a.ref)).toEqual(['owner,manager,akuntan']);
  expect(n[0].summary).toContain('stok Kurma Curah Karung 20 → 15 kg, stok Kurma Pak 500 g 4 → 13 pak');
  // the grid shows the new stock
  await H.closeModals(page);
  // a resend of the same repack (same client id) — e.g. after a lost answer — is not recorded again
  const cid = db.repacks.slice(-1)[0].client_id;
  const again = await page.evaluate(c => api('repack', { client_id: c, to_product_id: 0, to_qty: 1 }), cid);
  expect(again.duplicate).toBe(true);
  expect(prod(await H.getDb(page), 'RKB1').stock).toBe(15);
});

test('two cashiers on the same bulk: the second is told who repacked it and when — "Bukan" stops, "Ya, ini kemas ulang baru" saves it', async ({ page, context }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page);
  const r1 = await page.evaluate(id => api('repack', { client_id: 'k-siti-1', to_product_id: id, to_qty: 6 }), prod(db0, 'RKP1').id);
  expect(r1.repack.repack_id).toBeTruthy();
  // (the demo leaves Rina's drawer of yesterday open — close it, she opens today's)
  await H.setDb(page, `db.shifts.filter(x => x.cashier === 'Rina' && x.status === 'open').forEach(x => { x.status = 'closed'; x.closed_at = new Date().toISOString(); x.counted_cash = x.opening_cash; });`);
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Rina', '3333');
  await openForm(p2);
  await p2.selectOption('#rk-to', String(prod(db0, 'RKP2').id)); // another pack of the SAME bulk
  await p2.fill('#rk-qty', '8');
  await p2.click('#rk-ok');
  await expect(p2.locator('#rk-recent')).toBeVisible();
  await expect(p2.locator('#rk-recent')).toHaveAttribute('data-by', 'Siti');
  await expect(p2.locator('#rk-recent')).toContainText('Siti sudah mengemas ulang Kurma Curah Karung 3 kg → Kurma Pak 500 g × 6');
  await expect(p2.locator('#rk-recent')).toContainText('Jangan dicatat dua kali');
  await H.shot(p2, 'phone-repack-recent', false, { noToasts: true });
  expect(prod(await H.getDb(p2), 'RKB1').stock).toBe(17);
  // "Bukan, itu yang sama" → closes, nothing recorded
  await p2.click('#rk-same');
  await expect(p2.locator('#repack')).toHaveCount(0);
  let db = await H.getDb(p2);
  expect(db.repacks.filter(r => r.user === 'Rina').length).toBe(0);
  expect(prod(db, 'RKB1').stock).toBe(17);
  // it really is another one → confirm
  await openForm(p2);
  await p2.selectOption('#rk-to', String(prod(db0, 'RKP2').id));
  await p2.fill('#rk-qty', '8');
  await p2.click('#rk-ok');
  await p2.click('#rk-again');
  await expect(p2.locator('#rk-done')).toBeVisible();
  db = await H.getDb(p2);
  expect(prod(db, 'RKB1').stock).toBe(15);
  expect(prod(db, 'RKP2').stock).toBe(8);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toContain('dikonfirmasi bukan kemas ulang ganda');
});

test('a v38 request still pending: it blocks that bulk; the manager approves it in her inbox (corrected, bulk checked again) → stock moves', async ({ page, context }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page), bulk = prod(db0, 'RKB1'), p500 = prod(db0, 'RKP1');
  const pl = { to_product_id: p500.id, to_name: p500.name, to_unit: 'pak', from_product_id: bulk.id, from_name: bulk.name, from_unit: 'kg', pack_size: 0.5, to_qty: 18, from_qty: 10, expected_qty: 20, yield_pct: 90, loss_qty: 1, bulk_stock: 20, packaging_cost: 0, exp_date: '', note: '' };
  await H.setDb(page, `db.approvals.push({ id: 9901, request_id: 'APOLD38', kind: 'repack', approver_role: 'mgr_akuntan', ref: String(arg.from_product_id), client_id: 'old', cashier: 'Siti', status: 'pending', created_at: new Date().toISOString(), summary: 'Minta kemas ulang', payload: JSON.stringify(arg), total: 0 });`, pl);
  const busy = await page.evaluate(id => api('repack', { client_id: 'k-b', to_product_id: id, to_qty: 2 }).then(() => 'ok', e => e.code), p500.id);
  expect(busy).toBe('REPACK_PENDING');
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await p2.click('#tb-appr');
  const card = p2.locator('.apr-card[data-req="APOLD38"]');
  await expect(card).toHaveAttribute('data-kind', 'repack');
  await expect(card.locator('[data-rk-stock]')).toContainText('20 kg');
  await card.locator('[data-rk-to]').fill('19');
  await expect(card.locator('[data-rk-preview] [data-yield]')).toContainText('95,0%');
  await H.setDb(p2, `db.products.find(p => p.sku === 'RKB1').stock = 6;`);
  await card.locator('[data-d="approved"]').click();
  await expect(p2.locator('.toast.err')).toContainText('Stok curah tidak cukup lagi');
  await H.setDb(p2, `db.products.find(p => p.sku === 'RKB1').stock = 20;`);
  await card.locator('[data-d="approved"]').click();
  await expect(p2.locator('.toast.ok', { hasText: 'APOLD38' })).toBeVisible();
  const db = await H.getDb(p2);
  expect(prod(db, 'RKB1').stock).toBe(10);
  expect(prod(db, 'RKP1').stock).toBe(23);
  expect(db.repacks.slice(-1)[0]).toMatchObject({ requested_by: 'Siti', approved_by: 'Jihan', to_qty: 19, from_qty: 10 });
});

test('manager in Khair Kasir repacks the same way (the owner and the accountant are told); Arabic texts', async ({ page }) => {
  await loginWithPacks(page, 'Jihan', '2222');
  const db0 = await H.getDb(page);
  await openForm(page);
  await expect(page.locator('#rk-ok')).toContainText('Simpan kemas ulang');
  await page.selectOption('#rk-to', String(prod(db0, 'RKP2').id));
  await page.fill('#rk-qty', '8');
  await page.click('#rk-ok');
  await expect(page.locator('#rk-done')).toBeVisible();
  await expect(page.locator('#rk-told')).toHaveText('Pemilik dan akuntan diberi tahu.');
  const db = await H.getDb(page);
  expect(prod(db, 'RKB1').stock).toBe(18);
  expect(prod(db, 'RKP2').stock).toBe(8);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'owner,akuntan', user: 'Jihan' });
  await H.closeModals(page);
  await page.click('#lang-ar');
  await expect(page.locator('#m-repack')).toContainText('إعادة التعبئة');
  await expect(page.locator('#m-repack')).toContainText('يتغير المخزون فورًا');
  await page.click('#m-repack');
  await expect(page.locator('#repack')).toContainText('عدد العبوات الناتجة');
  await expect(page.locator('#rk-ok')).toContainText('حفظ إعادة التعبئة');
});
