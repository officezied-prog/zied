// v38 (owner 2026-10-12: «المالك يصله إشعار فقط، والمدير والمحاسب يوافق على الكمية والعملية كلها، والكاشير هو الذي يطلب القيام بها، لكن
// يجب التأكد: ممكن 2 كاشير يقوم بنفس الطلب والتعليب، انتبه منها») in Khair Kasir: the cashier REQUESTS a repack (nothing moves), sees its status
// in "Permintaan saya"; a second cashier on the same bulk is told who asked first; a double tap / resend is one request; the manager approves
// (corrected quantities) in her inbox; a request waiting 24 h can be cancelled; the manager here repacks directly.
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

test('cashier: pick the pack, packs made + bulk used → yield preview; SEND a request — nothing moves; status in "Permintaan saya"; a double tap is one request', async ({ page }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page), bulk = prod(db0, 'RKB1'), p500 = prod(db0, 'RKP1');
  await openForm(page);
  await expect(page.locator('#rk-to option')).toHaveCount(3); // "pick" + the two packs
  await page.selectOption('#rk-to', String(p500.id));
  await expect(page.locator('#rk-bulk-stock')).toContainText('20 kg');
  await page.fill('#rk-qty', '9');
  await page.fill('#rk-from', '5');
  await expect(page.locator('#rk-preview')).toContainText('seharusnya 10 kemasan');
  await expect(page.locator('#rk-preview [data-yield]')).toContainText('90,0%');
  await expect(page.locator('#rk-preview')).toHaveClass(/low/);
  await page.fill('#rk-note', 'pagi');
  await H.shot(page, 'phone-repack-request', false, { noToasts: true });
  await page.dblclick('#rk-ok'); // a double tap
  await expect(page.locator('#rk-pending')).toBeVisible();
  await expect(page.locator('#rk-pending')).toContainText('Menunggu persetujuan manajer / akuntan');
  const db = await H.getDb(page);
  const reqs = db.approvals.filter(a => a.kind === 'repack');
  expect(reqs.length).toBe(1);
  expect(reqs[0]).toMatchObject({ status: 'pending', cashier: 'Siti', approver_role: 'mgr_akuntan', ref: String(bulk.id) });
  expect(JSON.parse(reqs[0].payload)).toMatchObject({ to_qty: 9, from_qty: 5, yield_pct: 90, loss_qty: 0.5, note: 'pagi' });
  expect(prod(db, 'RKB1').stock).toBe(20);
  expect(prod(db, 'RKP1').stock).toBe(4);
  // the owner (and the deciders) got ONE notice
  expect(db.activity.filter(a => a.kind === 'notifikasi' && /Permintaan kemas ulang oleh Siti/.test(a.summary)).map(a => a.ref)).toEqual(['owner,manager,akuntan']);
  // a resend of the same request (same client id) — e.g. after a lost answer — returns the same request
  const cid = reqs[0].client_id;
  const again = await page.evaluate(c => api('request_repack', { client_id: c, to_product_id: 0, to_qty: 1 }), cid);
  expect(again).toMatchObject({ duplicate: true, request_id: reqs[0].request_id });
  expect((await H.getDb(page)).approvals.filter(a => a.kind === 'repack').length).toBe(1);
  // "Permintaan saya"
  await H.closeModals(page);
  await page.click('#m-myreq');
  const row = page.locator(`#myreq [data-req="${reqs[0].request_id}"]`);
  await expect(row).toContainText('Kemas ulang Kurma Pak 500 g × 9');
  await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'pending');
  await expect(row.locator('[data-act="req-cancel"]')).toHaveCount(0); // not before 24 h
});

test('two cashiers on the same bulk: the second one is told who asked and when; nothing is requested twice', async ({ page, context }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page);
  const r1 = await page.evaluate(id => api('request_repack', { client_id: 'k-siti-1', to_product_id: id, to_qty: 6 }), prod(db0, 'RKP1').id);
  expect(r1.request_id).toBeTruthy();
  // (the demo leaves Rina's drawer of yesterday open — close it, she opens today's)
  await H.setDb(page, `db.shifts.filter(x => x.cashier === 'Rina' && x.status === 'open').forEach(x => { x.status = 'closed'; x.closed_at = new Date().toISOString(); x.counted_cash = x.opening_cash; });`);
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Rina', '3333');
  await openForm(p2);
  await p2.selectOption('#rk-to', String(prod(db0, 'RKP2').id)); // another pack of the SAME bulk
  await p2.fill('#rk-qty', '8');
  await p2.click('#rk-ok');
  await expect(p2.locator('#rk-busy')).toBeVisible();
  await expect(p2.locator('#rk-busy')).toHaveAttribute('data-by', 'Siti');
  await expect(p2.locator('#rk-busy')).toContainText('Siti sudah meminta kemas ulang Kurma Curah Karung (Kurma Pak 500 g × 6)');
  await expect(p2.locator('#rk-busy')).toContainText('Tunggu keputusan manajer / akuntan');
  await H.shot(p2, 'phone-repack-busy', false, { noToasts: true });
  const db = await H.getDb(p2);
  expect(db.approvals.filter(a => a.kind === 'repack').length).toBe(1);
  expect(prod(db, 'RKB1').stock).toBe(20);
});

test('manager approves in her inbox (corrects the packs, live yield) → stock moves; the cashier sees "Disetujui · Jihan"; not enough bulk is refused at approval', async ({ page, context }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page), p500 = prod(db0, 'RKP1');
  const r1 = await page.evaluate(id => api('request_repack', { client_id: 'k-appr-1', to_product_id: id, to_qty: 18, from_qty: 10 }), p500.id);
  await page.evaluate(([id, label]) => trackMyRequest(id, 'repack', label), [r1.request_id, 'Kemas ulang Kurma Pak 500 g × 18']);
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Jihan', '2222');
  await p2.click('#tb-appr');
  const card = p2.locator(`.apr-card[data-req="${r1.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'repack');
  await expect(card).toContainText('Kemas ulang: Kurma Pak 500 g');
  await expect(card).toContainText('Siti');
  await expect(card.locator('[data-rk-stock]')).toContainText('20 kg');
  await expect(card.locator('[data-rk-preview] [data-yield]')).toContainText('90,0%');
  await card.locator('[data-rk-to]').fill('19');
  await expect(card.locator('[data-rk-preview] [data-yield]')).toContainText('95,0%');
  await H.shot(p2, 'phone-repack-approve', false, { noToasts: true });
  // meanwhile most of the bulk is gone → refused, nothing moves
  await H.setDb(p2, `db.products.find(p => p.sku === 'RKB1').stock = 6;`);
  await card.locator('[data-d="approved"]').click();
  await expect(p2.locator('.toast.err')).toContainText('Stok curah tidak cukup lagi');
  expect(prod(await H.getDb(p2), 'RKB1').stock).toBe(6);
  await H.setDb(p2, `db.products.find(p => p.sku === 'RKB1').stock = 20;`);
  await card.locator('[data-d="approved"]').click();
  await expect(p2.locator('.toast.ok', { hasText: r1.request_id })).toBeVisible();
  const db = await H.getDb(p2);
  expect(prod(db, 'RKB1').stock).toBe(10);
  expect(prod(db, 'RKP1').stock).toBe(23);
  expect(db.repacks.slice(-1)[0]).toMatchObject({ requested_by: 'Siti', approved_by: 'Jihan', to_qty: 19, from_qty: 10 });
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'owner,akuntan' });
  // the cashier's "Permintaan saya": approved, by whom
  await H.tab(page, 'more');
  await page.click('#m-myreq');
  const row = page.locator(`#myreq [data-req="${r1.request_id}"]`);
  await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'approved');
  await expect(row).toContainText('Jihan');
});

test('a request waiting 24 h: the cashier cancels it from "Permintaan saya" and the bulk is free again', async ({ page }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page), p500 = prod(db0, 'RKP1');
  const r1 = await page.evaluate(id => api('request_repack', { client_id: 'k-old-1', to_product_id: id, to_qty: 2 }), p500.id);
  // too early → refused
  const early = await page.evaluate(id => api('cancel_repack', { request_id: id }).then(() => 'ok', e => e.code), r1.request_id);
  expect(early).toBe('TOO_EARLY');
  await H.setDb(page, `const a = db.approvals.find(x => x.request_id === arg); a.created_at = new Date(Date.now() - 25 * 3600000).toISOString();`, r1.request_id);
  await page.evaluate(([id, label]) => { trackMyRequest(id, 'repack', label); MYREQ.list.find(r => r.id === id).at = Date.now() - 25 * 3600000; }, [r1.request_id, 'Kemas ulang Kurma Pak 500 g × 2']);
  await H.tab(page, 'more');
  await page.click('#m-myreq');
  const row = page.locator(`#myreq [data-req="${r1.request_id}"]`);
  await row.locator('[data-act="req-cancel"]').click();
  await expect(page.locator('.toast.ok', { hasText: 'Permintaan kemas ulang dibatalkan' })).toBeVisible();
  await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'cancelled');
  await expect(row.locator('[data-status]')).toHaveText('Dibatalkan');
  const db = await H.getDb(page);
  expect(db.approvals.find(a => a.request_id === r1.request_id)).toMatchObject({ status: 'cancelled', decided_by: 'Siti' });
  expect(prod(db, 'RKB1').stock).toBe(20);
  const r2 = await page.evaluate(id => api('request_repack', { client_id: 'k-new-2', to_product_id: id, to_qty: 2 }), p500.id);
  expect(r2.request_id).toBeTruthy();
});

test('manager in Khair Kasir repacks directly (stock moves at once, the owner is told); Arabic texts', async ({ page }) => {
  await loginWithPacks(page, 'Jihan', '2222');
  const db0 = await H.getDb(page);
  await openForm(page);
  await expect(page.locator('#rk-ok')).toContainText('Simpan kemas ulang');
  await page.selectOption('#rk-to', String(prod(db0, 'RKP2').id));
  await page.fill('#rk-qty', '8');
  await page.click('#rk-ok');
  await expect(page.locator('#rk-done')).toBeVisible();
  await expect(page.locator('#rk-done')).toContainText('Kemas ulang tersimpan');
  const db = await H.getDb(page);
  expect(prod(db, 'RKB1').stock).toBe(18);
  expect(prod(db, 'RKP2').stock).toBe(8);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'owner', user: 'Jihan' });
  await H.closeModals(page);
  await page.click('#lang-ar');
  await expect(page.locator('#m-repack')).toContainText('إعادة التعبئة');
  await page.click('#m-repack');
  await expect(page.locator('#repack')).toContainText('عدد العبوات الناتجة');
  await expect(page.locator('#rk-ok')).toContainText('حفظ إعادة التعبئة');
});
