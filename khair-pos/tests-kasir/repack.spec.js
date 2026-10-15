// Repacking in Khair Kasir (bulk → small packs).
// v50 (owner 2026-10-15: «تنطلق عملية التعبية باختيار العنصر الكبير … ثم الحاسوب يحسب مباشرة الكمية … وبعد عملية التعليب تقع الموافقة على
// الكمية التي تمت عن طريق المدير»): two steps — the cashier picks the bulk (typing a whole word), then its pack, and how much bulk is
// packed: the packs are worked out at once and the bulk leaves the stock; the manager then confirms the packs really made and the bulk
// left over (back to stock). The older notes below (v38/v39) still hold for the guards: no double work, a v38 request decided first.
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

test('cashier: type the bulk, its packs only, amount → packs worked out; START takes the bulk out; the manager confirms fewer + the rest back', async ({ page, context }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page), bulk = prod(db0, 'RKB1'), p500 = prod(db0, 'RKP1');
  await openForm(page);
  await expect(page.locator('#repack')).toContainText('manajer mengonfirmasi kemasan yang jadi');
  // a whole word finds the bulk (not only the first letter); only that bulk's packs are offered, biggest first
  await H.pick(page, 'rk-bulk', 'curah karung', bulk.id);
  await expect(page.locator('#rk-bulk-stock')).toContainText('20 kg');
  await page.locator('#rk-pack-q').click();
  await expect(page.locator('#rk-pack-list [data-pick]')).toHaveCount(2);
  await H.pick(page, 'rk-pack', '500', p500.id);
  await expect(page.locator('#rk-unit')).toHaveText('kg');
  await page.fill('#rk-amount', '5');
  await expect(page.locator('#rk-planned')).toHaveAttribute('data-planned', '10');
  await expect(page.locator('#rk-calc')).toContainText('5 kg ÷ 0,5 kg = 10 pak');
  await page.fill('#rk-amount', '5,2');
  await expect(page.locator('#rk-planned')).toHaveAttribute('data-planned', '10');
  await expect(page.locator('#rk-calc [data-left]')).toContainText('Sisa 0,2 kg');
  await page.fill('#rk-note', 'pagi');
  await expect(page.locator('#rk-ok')).toContainText('Mulai kemas');
  await H.shot(page, 'phone-repack-direct', false, { noToasts: true });
  await page.dblclick('#rk-ok'); // a double tap
  await expect(page.locator('#rk-done')).toBeVisible();
  await expect(page.locator('#rk-done')).toContainText('Mulai dikemas: 5,2 kg → Kurma Pak 500 g (rencana 10)');
  await expect(page.locator('#rk-told')).toHaveText('Setelah selesai, manajer mengonfirmasi jumlah kemasan yang jadi.');
  await expect(page.locator('#rk-open-list')).toContainText('menunggu konfirmasi manajer');
  await expect(page.locator('#rk-open-list [data-act="rk-fin"]')).toHaveCount(0); // a cashier does not confirm
  let db = await H.getDb(page);
  expect(db.approvals.filter(a => a.kind === 'repack').length).toBe(0);
  const mine = db.repacks.filter(r => r.started_by === 'Siti');
  expect(mine.length).toBe(1);
  expect(mine[0]).toMatchObject({ status: 'proses', from_qty: 5.2, planned_qty: 10, note: 'pagi' });
  expect(prod(db, 'RKB1').stock).toBe(14.8); // the bulk is on the packing table
  expect(prod(db, 'RKP1').stock).toBe(4); // the packs come in when the manager confirms
  const n = db.activity.filter(a => a.kind === 'notifikasi' && /Mulai kemas ulang oleh kasir Siti/.test(a.summary));
  expect(n.map(a => a.ref)).toEqual(['owner,manager']);
  expect(n[0].summary).toContain('= 10 kemasan rencana, sisa 0.2 kg | stok Kurma Curah Karung 20 → 14.8 kg');
  // a resend of the same start (same client id) is not recorded again
  const again = await page.evaluate(c => api('repack_start', { client_id: c, from_product_id: 0, to_product_id: 0, from_qty: 1 }), mine[0].client_id);
  expect(again.duplicate).toBe(true);
  expect(prod(await H.getDb(page), 'RKB1').stock).toBe(14.8);
  await H.closeModals(page);
  // another cashier cannot start the same pack of the same bulk while it is being packed
  await H.setDb(page, `db.shifts.filter(x => x.cashier === 'Rina' && x.status === 'open').forEach(x => { x.status = 'closed'; x.closed_at = new Date().toISOString(); x.counted_cash = x.opening_cash; });`);
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Rina', '3333');
  await openForm(p2);
  await H.pick(p2, 'rk-bulk', 'kurma curah', bulk.id);
  await H.pick(p2, 'rk-pack', 'pak 500', p500.id);
  await p2.fill('#rk-amount', '2');
  await p2.click('#rk-ok');
  await expect(p2.locator('#rk-busy')).toHaveAttribute('data-by', 'Siti');
  await expect(p2.locator('#rk-busy')).toContainText('Siti sedang mengemas Kurma Curah Karung 5,2 kg → Kurma Pak 500 g');
  expect(prod(await H.getDb(p2), 'RKB1').stock).toBe(14.8);
  // the manager (her own phone) confirms: 9 packs made (1 fewer), the rest of the bulk goes back to stock
  const p3 = await H.otherPhone(context);
  await H.login(p3, 'Jihan', '2222');
  await openForm(p3);
  const row = p3.locator(`#rk-open-list [data-rk-open="${mine[0].repack_id}"]`);
  await expect(row).toContainText('rencana 10 pak');
  await expect(row).toContainText('dimulai Siti');
  await row.locator('[data-act="rk-fin"]').click();
  await expect(p3.locator('#rkf-made')).toHaveValue('10');
  await expect(p3.locator('#rkf-rem')).toHaveValue('0,2');
  await p3.fill('#rkf-made', '9');
  await expect(p3.locator('#rkf-rem')).toHaveValue('0,7'); // worked out from the packs (she can still change it)
  await expect(p3.locator('#rkf-pv [data-short]')).toContainText('Kurang 1 pak dari rencana');
  await H.shot(p3, 'phone-repack-confirm', false, { noToasts: true });
  await p3.click('#rkf-ok');
  await expect(p3.locator('.toast.ok', { hasText: 'Hasil kemas ulang dikonfirmasi' })).toBeVisible();
  db = await H.getDb(p3);
  expect(db.repacks.find(r => r.repack_id === mine[0].repack_id)).toMatchObject({ status: 'selesai', to_qty: 9, from_qty: 4.5, remaining_qty: 0.7, confirmed_by: 'Jihan', yield_pct: 100 });
  expect(prod(db, 'RKB1').stock).toBe(15.5);
  expect(prod(db, 'RKP1').stock).toBe(13);
  const fin = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(fin).toMatchObject({ ref: 'owner,akuntan', user: 'Jihan' });
  expect(fin.summary).toContain('Kemas ulang selesai, dikonfirmasi manajer Jihan');
  expect(fin.summary).toContain('rencana 10, jadi 9; sisa curah 0.7 kg kembali ke stok — KURANG 1 dari rencana');
  // done: no longer in "Sedang dikemas"
  await expect(p3.locator('#rk-open-list')).toHaveCount(0);
});

test('two cashiers on the same bulk: the second is told who repacked it and when — "Bukan" stops, "Ya, ini kemas ulang baru" starts it', async ({ page, context }) => {
  await loginWithPacks(page);
  const db0 = await H.getDb(page);
  const r1 = await page.evaluate(id => api('repack', { client_id: 'k-siti-1', to_product_id: id, to_qty: 6 }), prod(db0, 'RKP1').id);
  expect(r1.repack.repack_id).toBeTruthy();
  // (the demo leaves Rina's drawer of yesterday open — close it, she opens today's)
  await H.setDb(page, `db.shifts.filter(x => x.cashier === 'Rina' && x.status === 'open').forEach(x => { x.status = 'closed'; x.closed_at = new Date().toISOString(); x.counted_cash = x.opening_cash; });`);
  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Rina', '3333');
  const fill = async () => {
    await openForm(p2);
    await H.pick(p2, 'rk-bulk', 'karung', prod(db0, 'RKB1').id);
    await H.pick(p2, 'rk-pack', '250', prod(db0, 'RKP2').id); // another pack of the SAME bulk
    await p2.fill('#rk-amount', '2');
    await expect(p2.locator('#rk-planned')).toHaveAttribute('data-planned', '8');
    await p2.click('#rk-ok');
  };
  await fill();
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
  expect(db.repacks.filter(r => r.started_by === 'Rina').length).toBe(0);
  expect(prod(db, 'RKB1').stock).toBe(17);
  // it really is another one → confirm
  await fill();
  await p2.click('#rk-again');
  await expect(p2.locator('#rk-done')).toBeVisible();
  db = await H.getDb(p2);
  expect(prod(db, 'RKB1').stock).toBe(15);
  expect(db.repacks.filter(r => r.started_by === 'Rina')[0]).toMatchObject({ status: 'proses', planned_qty: 8 });
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

test('manager in Khair Kasir starts it and confirms it herself (cancel puts the bulk back); Arabic texts', async ({ page }) => {
  await loginWithPacks(page, 'Jihan', '2222');
  const db0 = await H.getDb(page);
  await openForm(page);
  await expect(page.locator('#rk-ok')).toContainText('Mulai kemas');
  await H.pick(page, 'rk-bulk', 'kurma', prod(db0, 'RKB1').id);
  await H.pick(page, 'rk-pack', 'pak 250', prod(db0, 'RKP2').id);
  await page.fill('#rk-amount', '2');
  await page.click('#rk-ok');
  await expect(page.locator('#rk-done')).toBeVisible();
  await expect(page.locator('#rk-told')).toHaveText('Setelah selesai, konfirmasi hasilnya di "Sedang dikemas".');
  let db = await H.getDb(page);
  expect(prod(db, 'RKB1').stock).toBe(18);
  expect(prod(db, 'RKP2').stock).toBe(0);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'owner', user: 'Jihan' });
  // nothing was packed after all → cancel: the bulk goes back, no packs made
  const id = db.repacks.slice(-1)[0].repack_id;
  await page.locator(`#rk-open-list [data-rk-open="${id}"] [data-act="rk-fin"]`).click();
  await page.click('#rkf-cancel');
  await page.click('#cf-ok');
  await expect(page.locator('.toast.ok', { hasText: 'Kemas ulang dibatalkan' })).toBeVisible();
  db = await H.getDb(page);
  expect(db.repacks.find(r => r.repack_id === id)).toMatchObject({ status: 'batal', to_qty: 0, remaining_qty: 2 });
  expect(prod(db, 'RKB1').stock).toBe(20);
  expect(prod(db, 'RKP2').stock).toBe(0);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'owner,akuntan', user: 'Jihan' });
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toContain('Kemas ulang DIBATALKAN oleh manajer Jihan');
  await H.closeModals(page);
  await page.click('#lang-ar');
  await expect(page.locator('#m-repack')).toContainText('إعادة التعبئة');
  await expect(page.locator('#m-repack')).toContainText('يؤكد المدير النتيجة');
  await page.click('#m-repack');
  await expect(page.locator('label[for="rk-bulk-q"]')).toContainText('الصنف السائب (الكبير)');
  await expect(page.locator('label[for="rk-pack-q"]')).toContainText('العبوة الصغيرة (الناتج)');
  await expect(page.locator('label[for="rk-amount"]')).toContainText('كمية السائب التي تُعبّأ');
  await expect(page.locator('#rk-ok')).toContainText('ابدأ التعبئة');
});
