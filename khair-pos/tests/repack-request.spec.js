// v38 (owner 2026-10-12: «المالك يصله إشعار فقط، والمدير والمحاسب يوافق على الكمية والعملية كلها، والكاشير هو الذي يطلب القيام بها، لكن
// يجب التأكد: ممكن 2 كاشير يقوم بنفس الطلب والتعليب، انتبه منها») in the owner app (mock backend = same rules as backend/process.js):
// a cashier's repack request is decided by the manager OR the accountant (quantities may be corrected), the bulk stock is checked again at
// approval, nothing is repacked twice, the history says who asked and who approved, and the owner only gets the notices.
const { test, expect } = require('@playwright/test');
const { login, openApp, enterKey, staffSession, getDb, productByName, nav, editDb, asUser } = require('./helpers');

const fq = n => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(n);
const r3 = n => Math.round(n * 1000) / 1000;
async function addAkuntan(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await enterKey(page);
}
const cid = () => 'test-' + Math.random().toString(36).slice(2);

test('v38 manager: a cashier\'s repack request — bulk vs stock, corrected quantities with live yield, approve → stock moves; history shows who asked / approved; owner told', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kurma Rabia Curah/), pack = productByName(db0, /Kurma Rabia Kemas 500/);
  const rq = await asUser(page, 'Siti', '1111', 'request_repack', { client_id: cid(), to_product_id: pack.id, to_qty: 8, from_qty: 4.5, note: 'pagi' });
  expect(rq.request_id, JSON.stringify(rq)).toBeTruthy();
  expect(rq.approval).toMatchObject({ kind: 'repack', approver_role: 'mgr_akuntan', status: 'pending', cashier: 'Siti' });
  // nothing moved yet
  expect(productByName(await getDb(page), /Kurma Rabia Curah/).stock).toBe(bulk.stock);
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${rq.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'repack');
  await expect(card).toContainText('Kemas ulang: ' + pack.name);
  await expect(card).toContainText('Siti');
  await expect(card.locator('[data-repack-sum]')).toContainText(bulk.name);
  await expect(card.locator('[data-rk-stock]')).toContainText(fq(bulk.stock));
  await expect(card.locator('[data-rk-preview] [data-yield]')).toContainText('88,9%'); // 8 of 9 expected
  await expect(card.locator('[data-rk-preview]')).toHaveClass(/low/);
  // the manager corrects: 9 packs from 4.5 kg → 100 %
  await card.locator('[data-rk-to]').fill('9');
  await expect(card.locator('[data-rk-preview] [data-yield]')).toContainText('100,0%');
  await expect(card.locator('[data-rk-preview]')).not.toHaveClass(/low/);
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  const db = await getDb(page);
  expect(productByName(db, /Kurma Rabia Curah/).stock).toBe(r3(bulk.stock - 4.5));
  expect(productByName(db, /Kurma Rabia Kemas 500/).stock).toBe(pack.stock + 9);
  const rp = db.repacks.slice(-1)[0];
  expect(rp).toMatchObject({ requested_by: 'Siti', approved_by: 'Jihan', request_id: rq.request_id, user: 'Siti', to_qty: 9, from_qty: 4.5, yield_pct: 100 });
  expect(db.approvals.find(a => a.request_id === rq.request_id)).toMatchObject({ status: 'approved', decided_by: 'Jihan' });
  expect(JSON.parse(db.approvals.find(a => a.request_id === rq.request_id).payload).final).toMatchObject({ to_qty: 9, from_qty: 4.5, corrected: true });
  // the owner's notices: one for the request, one for the decision (with the correction); no generic "keputusan" line
  const nts = db.activity.filter(a => a.kind === 'notifikasi' && /kemas ulang/i.test(a.summary));
  expect(nts.map(a => a.ref)).toEqual(['owner,manager,akuntan', 'owner,akuntan']);
  expect(nts[1].summary).toMatch(/Kemas ulang DISETUJUI oleh Jihan \(diminta Siti .* WIB\).* x9 \(hasil 100%.*dikoreksi dari 4.5 kg → x8/);
  expect(db.activity.some(a => a.kind === 'keputusan' && a.ref === rq.request_id)).toBe(false);
  // the cashier is told who decided
  const ck = await asUser(page, 'Siti', '1111', 'check_approval', { request_id: rq.request_id });
  expect(ck.approval).toMatchObject({ status: 'approved', decided_by: 'Jihan' });
  // the history in Gudang → Kemas ulang shows who asked and who approved
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="repack"]');
  await expect(page.locator(`#rp-hist tr[data-rp="${rp.repack_id}"] [data-rp-by]`)).toHaveText('Diminta Siti · disetujui Jihan');
});

test('v38 accountant decides from the management screens; the manager a moment later is told it was already decided; a rejection moves nothing', async ({ page }) => {
  await addAkuntan(page);
  const pack = productByName(await getDb(page), /Kacang Mete Arab/);
  const rq = await asUser(page, 'Siti', '1111', 'request_repack', { client_id: cid(), to_product_id: pack.id, to_qty: 4 });
  expect(rq.request_id, JSON.stringify(rq)).toBeTruthy();
  const bulk = productByName(await getDb(page), /Kacang Mete Curah/); // (the demo's repack products are added on the first request)
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${rq.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'repack');
  await expect(card.locator('[data-rk-to]')).toBeEnabled();
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  const db = await getDb(page);
  expect(productByName(db, /Kacang Mete Curah/).stock).toBe(r3(bulk.stock - 4 * productByName(db, /Kacang Mete Arab/).repack_qty));
  expect(db.repacks.slice(-1)[0]).toMatchObject({ requested_by: 'Siti', approved_by: 'Lestari' });
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'owner,manager' });
  const late = await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: rq.request_id, decision: 'approved' });
  expect(late.error).toBe('INVALID');
  expect(late.message).toContain('oleh Lestari');
  // a second request, rejected: nothing moves
  const rq2 = await asUser(page, 'Siti', '1111', 'request_repack', { client_id: cid(), to_product_id: pack.id, to_qty: 2 });
  await nav(page, 'approvals');
  const c2 = page.locator(`.apr-card[data-req="${rq2.request_id}"]`);
  await c2.locator('[data-note]').fill('belum perlu');
  await c2.locator('[data-d="rejected"]').click();
  await expect(c2).toHaveCount(0);
  const db2 = await getDb(page);
  expect(productByName(db2, /Kacang Mete Curah/).stock).toBe(productByName(db, /Kacang Mete Curah/).stock);
  expect(db2.approvals.find(a => a.request_id === rq2.request_id)).toMatchObject({ status: 'rejected', decided_by: 'Lestari' });
  expect(db2.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toMatch(/DITOLAK oleh Lestari.*belum perlu — stok tidak berubah/);
});

test('v38 no double repack: a second request for the same bulk is refused with who asked; the manager\'s direct repack waits too; not enough bulk at approval', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kurma Rabia Curah/), p500 = productByName(db0, /Kurma Rabia Kemas 500/), p250 = productByName(db0, /Kurma Rabia Kemas 250/);
  const c1 = cid();
  const rq = await asUser(page, 'Siti', '1111', 'request_repack', { client_id: c1, to_product_id: p500.id, to_qty: 4 });
  // double tap / resend: the same request
  const again = await asUser(page, 'Siti', '1111', 'request_repack', { client_id: c1, to_product_id: p500.id, to_qty: 4 });
  expect(again).toMatchObject({ duplicate: true, request_id: rq.request_id });
  // another cashier, another pack of the SAME bulk → refused, naming Siti
  const hashR = await page.evaluate(() => KPOS.pinHash('demo', 'Rina', '3333'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Rina')) db.users.push({ name: 'Rina', role: 'kasir', pin_hash: arg, active: true });`, hashR);
  const busy = await asUser(page, 'Rina', '3333', 'request_repack', { client_id: cid(), to_product_id: p250.id, to_qty: 4 });
  expect(busy.error).toBe('REPACK_PENDING');
  expect(busy.message).toMatch(/oleh Siti/);
  expect((await getDb(page)).approvals.filter(a => a.kind === 'repack' && a.status === 'pending').length).toBe(1);
  // the manager's own direct repack of that bulk is refused too, with who asked
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="repack"]');
  await page.selectOption('#rp-to', String(p250.id));
  await page.fill('#rp-qty', '2');
  await page.click('#rp-save');
  await expect(page.locator('#rp-err')).toContainText('Siti sudah meminta kemas ulang ' + bulk.name);
  await expect(page.locator('#rp-err')).toContainText('Persetujuan');
  // meanwhile the bulk was sold down to 1 kg → the approval is refused, nothing moves; corrected to 2 packs it goes through
  await editDb(page, `db.products.find(p => p.id === arg).stock = 1;`, bulk.id);
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${rq.request_id}"]`);
  await page.click('[data-act="apr-refresh"]');
  await card.locator('[data-d="approved"]').click();
  await expect(page.locator('.toast.err')).toContainText('Stok curah tidak cukup lagi');
  await expect(card).toHaveCount(1);
  expect(productByName(await getDb(page), /Kurma Rabia Curah/).stock).toBe(1);
  await card.locator('[data-rk-to]').fill('2');
  await card.locator('[data-rk-from]').fill('1');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  const db = await getDb(page);
  expect(productByName(db, /Kurma Rabia Curah/).stock).toBe(0);
  expect(productByName(db, /Kurma Rabia Kemas 500/).stock).toBe(p500.stock + 2);
});

test('v38 the owner only gets notices: request + decision in his activity; his own direct repack sends none; the manager\'s direct repack is told', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db0 = await getDb(page);
  const pack = productByName(db0, /Kacang Mete Arab/);
  const n0 = db0.activity.filter(a => a.kind === 'notifikasi').length;
  await asUser(page, 'Jihan', '2222', 'repack', { to_product_id: pack.id, to_qty: 2 });
  let db = await getDb(page);
  expect(db.activity.filter(a => a.kind === 'notifikasi').length).toBe(n0 + 1);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0]).toMatchObject({ ref: 'owner', user: 'Jihan' });
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toMatch(/Kemas ulang oleh manajer Jihan/);
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="repack"]');
  await page.selectOption('#rp-to', String(pack.id));
  await page.fill('#rp-qty', '1');
  await page.click('#rp-save');
  await expect(page.locator('#rp-res')).toBeVisible();
  db = await getDb(page);
  expect(db.activity.filter(a => a.kind === 'notifikasi').length).toBe(n0 + 1);
  // a cashier's request reaches the owner's activity as a notice (Pemberitahuan)
  await asUser(page, 'Siti', '1111', 'request_repack', { client_id: cid(), to_product_id: pack.id, to_qty: 1 });
  await nav(page, 'activity');
  await expect(page.locator('#view-activity')).toContainText('Permintaan kemas ulang oleh Siti');
  await expect(page.locator('#view-activity')).toContainText('Pemberitahuan');
});
