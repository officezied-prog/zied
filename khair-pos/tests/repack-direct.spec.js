// Repacking in the owner app (mock backend = same rules as backend/process.js).
// v39 (owner 2026-10-12: «طلب التعليب لا يحتاج إلى موافقات، إن شاهد العمال نقص في البضائع فعليهم أن يقوموا بالتعليب، بس يقوم بإرسال معلومات
// للمدير ولي أنا وللمحاسب حتى يتم إدخال كل المعلومات في المخزون ومراقبة المخزون»): a cashier's repack moves the stock at once and reaches the
// owner, the manager and the accountant as a notice with the stock before → after; the same bulk repacked again within 2 h is confirmed
// first (no double recording); a v38 request still pending is finished by the manager / accountant.
const { test, expect } = require('@playwright/test');
const { login, openApp, enterKey, staffSession, getDb, productByName, nav, editDb, asUser, pick } = require('./helpers');

const fq = n => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(n);
const r3 = n => Math.round(n * 1000) / 1000;
async function addAkuntan(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await enterKey(page);
}
const cid = () => 'test-' + Math.random().toString(36).slice(2);

test('v39 a cashier repacks directly: stock moves at once; the owner, manager and accountant each get the full record', async ({ page }) => {
  await addAkuntan(page);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kurma Rabia Curah/), pack = productByName(db0, /Kurma Rabia Kemas 500/);
  const r = await asUser(page, 'Siti', '1111', 'repack', { client_id: cid(), to_product_id: pack.id, to_qty: 8, from_qty: 4.5, note: 'pagi' });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const db = await getDb(page);
  expect(productByName(db, /Kurma Rabia Curah/).stock).toBe(r3(bulk.stock - 4.5));
  expect(productByName(db, /Kurma Rabia Kemas 500/).stock).toBe(pack.stock + 8);
  expect(db.approvals.filter(a => a.kind === 'repack').length).toBe(0);
  expect(db.repacks.slice(-1)[0]).toMatchObject({ user: 'Siti', to_qty: 8, from_qty: 4.5, note: 'pagi' });
  const n = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(n).toMatchObject({ ref: 'owner,manager,akuntan', user: 'Siti', level: 'warn' });
  expect(n.summary).toContain('Kemas ulang oleh kasir Siti');
  expect(n.summary).toContain(`stok ${bulk.name} ${r3(bulk.stock)} → ${r3(bulk.stock - 4.5)} kg, stok ${pack.name} ${pack.stock} → ${pack.stock + 8} pak`);
  // the owner sees it as a notice (Pemberitahuan) in his activity
  await nav(page, 'activity');
  await expect(page.locator('#view-activity')).toContainText('Kemas ulang oleh kasir Siti');
  await expect(page.locator('#view-activity')).toContainText('Pemberitahuan');
  // the manager and the accountant get it in their notices too
  for (const [u, pin] of [['Jihan', '2222'], ['Lestari', '5555']]) {
    const bo = await asUser(page, u, pin, 'bootstrap', {});
    expect((bo.notifications || []).some(x => /Kemas ulang oleh kasir Siti/.test(x.summary)), u).toBe(true);
  }
  // the history in Gudang → Kemas ulang names the cashier
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="repack"]');
  await expect(page.locator('#view-gudang')).toContainText('manajer mengonfirmasi kemasan yang jadi');
  await expect(page.locator(`#rp-hist tr[data-rp="${r.repack.repack_id}"]`)).toContainText('Siti');
});

test('v39 no double recording: the same bulk repacked again within 2 h asks first — "Ya, ini kemas ulang baru" saves it; a resend is one repack', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kurma Rabia Curah/), p500 = productByName(db0, /Kurma Rabia Kemas 500/), p250 = productByName(db0, /Kurma Rabia Kemas 250/);
  const c1 = cid();
  const r1 = await asUser(page, 'Siti', '1111', 'repack', { client_id: c1, to_product_id: p500.id, to_qty: 4 });
  expect(r1.ok, JSON.stringify(r1)).toBe(true);
  const again = await asUser(page, 'Siti', '1111', 'repack', { client_id: c1, to_product_id: p500.id, to_qty: 4 });
  expect(again).toMatchObject({ ok: true, duplicate: true });
  expect(productByName(await getDb(page), /Kurma Rabia Curah/).stock).toBe(r3(bulk.stock - 2));
  // another cashier on the same bulk → asked first, naming Siti
  const hashR = await page.evaluate(() => KPOS.pinHash('demo', 'Rina', '3333'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Rina')) db.users.push({ name: 'Rina', role: 'kasir', pin_hash: arg, active: true });`, hashR);
  const busy = await asUser(page, 'Rina', '3333', 'repack', { client_id: cid(), to_product_id: p250.id, to_qty: 4 });
  expect(busy.error).toBe('REPACK_RECENT');
  expect(busy.message).toMatch(/^Siti sudah mengemas ulang/);
  expect(busy.message).toContain('Ya, ini kemas ulang baru');
  // the manager in Gudang → Kemas ulang: the same question, then confirmed
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="repack"]');
  await pick(page, 'rp-bulk', 'rabia curah', bulk.id);
  await pick(page, 'rp-pack', 'kemas 250', p250.id);
  await page.fill('#rp-amount', '0,5');
  await expect(page.locator('#rp-planned')).toHaveAttribute('data-planned', '2');
  await page.click('#rp-start');
  await expect(page.locator('#rp-recent')).toContainText('Siti sudah mengemas ulang ' + bulk.name);
  await expect(page.locator('#rp-recent')).toContainText('Jangan dicatat dua kali');
  expect(productByName(await getDb(page), /Kurma Rabia Curah/).stock).toBe(r3(bulk.stock - 2));
  await page.click('#rp-again');
  await expect(page.locator('#rp-res')).toBeVisible();
  const db = await getDb(page);
  expect(productByName(db, /Kurma Rabia Curah/).stock).toBe(r3(bulk.stock - 2.5));
  const n = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(n).toMatchObject({ ref: 'owner', user: 'Jihan' }); // v50: started (the bulk is out); the result is confirmed afterwards
  expect(n.summary).toMatch(/^Mulai kemas ulang oleh manajer Jihan .*dikonfirmasi bukan kemas ulang ganda/);
});

test('v39 a v38 request still pending: the bulk waits for it, and the accountant finishes it from the management screens', async ({ page }) => {
  await addAkuntan(page);
  await asUser(page, 'Siti', '1111', 'bootstrap', {}); // (the demo's repack products are added on the first request)
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Kacang Mete Curah/), pack = productByName(db0, /Kacang Mete Arab/);
  const pl = { to_product_id: pack.id, to_name: pack.name, to_unit: pack.unit, from_product_id: bulk.id, from_name: bulk.name, from_unit: 'kg', pack_size: 0.25, to_qty: 4, from_qty: 1, expected_qty: 4, yield_pct: 100, loss_qty: 0, bulk_stock: bulk.stock, packaging_cost: 0, exp_date: '', note: '' };
  await editDb(page, `db.approvals.push({ id: 99901, request_id: 'APOLD38', kind: 'repack', approver_role: 'mgr_akuntan', ref: String(arg.from_product_id), client_id: 'old', cashier: 'Siti', status: 'pending', created_at: new Date().toISOString(), summary: 'Minta kemas ulang', payload: JSON.stringify(arg), total: 0 });`, pl);
  const busy = await asUser(page, 'Siti', '1111', 'repack', { client_id: cid(), to_product_id: pack.id, to_qty: 2 });
  expect(busy.error).toBe('REPACK_PENDING');
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'approvals');
  const card = page.locator('.apr-card[data-req="APOLD38"]');
  await expect(card).toHaveAttribute('data-kind', 'repack');
  await card.locator('[data-d="approved"]').click();
  await expect(card).toHaveCount(0);
  const db = await getDb(page);
  expect(productByName(db, /Kacang Mete Curah/).stock).toBe(r3(bulk.stock - 1));
  expect(db.repacks.slice(-1)[0]).toMatchObject({ requested_by: 'Siti', approved_by: 'Lestari' });
});
