// v37 (owner 2026-10-12): «هل في التطبيق المتابعة اليومية للفواتير التي تم تنزيلها مع الكميات الموجودة والكميات التي يتم جردها آخر كل شهرين،
// وأي فاتورة يتم تنزيلها مصادَق عليها لا يمكن تغييرها إلا بموافقة المدير، وإرسال إشعار إلى المالك: تم تغيير فاتورة، بالتاريخ والوقت، بالتدقيق،
// ومن قام بتغييرها ومن طلب تغييرها»
//   1. every change to a saved invoice → owner notice (bell "Faktur diubah") + the "Perubahan faktur" audit view (period, filter, print);
//   2. a full stock count every opname_every_days (default 60): reminder for owner + manager, last/next on the stock-count tab;
//   3. the daily report lists today's goods-in notes with their lines, qty received, stock now and the day's invoice changes.
const { test, expect } = require('@playwright/test');
const { login, openApp, getDb, editDb, asUser, nav, jktToday, staffSession, enterKey } = require('./helpers');
/** The attention list is computed in the background after the app opens: wait for an item (or settle), then open the bell. */
async function bell(page, key, present = true) {
  if (present) await page.waitForFunction(k => ATT.items.some(x => x.key === k), key);
  else await page.waitForTimeout(800);
  await page.click('#tb-bell');
}

async function goodsInAndFix(page, approve = true) {
  await editDb(page, `db.settings.require_purchase_photo = false;`);
  const db = await getDb(page);
  const p1 = db.products[0], p2 = db.products[1];
  const sp = await asUser(page, 'Siti', '1111', 'save_purchase', { supplier: 'PT Sumber Rejeki', purchase_date: jktToday(), carrier: { type: 'pemasok', name: 'Sopir' },
    items: [{ product_id: p1.id, qty: 10, cost_price: 20000, exp_date: '2027-06-01' }, { product_id: p2.id, qty: 4, cost_price: 41000, exp_none: true }] });
  expect(sp.purchase_no).toBeTruthy();
  const rq = await asUser(page, 'Siti', '1111', 'request_purchase_fix', { purchase_no: sp.purchase_no, reason: 'salah hitung', lines: [{ product_id: p1.id, qty: 8 }] });
  expect(rq.applied).toBe(false);
  if (approve) {
    const d = await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: rq.request_id, decision: 'approved', purchase_no: sp.purchase_no });
    expect(d.error).toBeUndefined();
  }
  return { no: sp.purchase_no, p1, p2 };
}

test('goods-in correction approved by the manager: the owner is told (bell) and sees it in "Perubahan faktur" with who asked / approved', async ({ page }) => {
  await openApp(page);
  const { no, p1 } = await goodsInAndFix(page);
  const db = await getDb(page);
  const rec = db.activity.find(a => a.kind === 'ubah_faktur' && a.ref === no);
  expect(rec).toMatchObject({ user: 'Jihan', level: 'warn' });
  expect(rec.summary).toMatch(/FAKTUR DIUBAH — Koreksi barang masuk/);
  expect(rec.summary).toContain('qty 10→8');
  expect(rec.summary).toMatch(/diminta Siti .* WIB, disetujui Jihan .* WIB/);
  expect(JSON.parse(rec.detail)).toMatchObject({ doc: 'masuk', what: 'koreksi_masuk', no, requested_by: 'Siti', approved_by: 'Jihan', reason: 'salah hitung', party: 'PT Sumber Rejeki' });
  // the saved goods-in rows themselves were never edited: the correction is its own row
  expect(db.purchases.filter(r => r.purchase_no === no && r.match_status !== 'koreksi').map(r => r.qty)).toEqual([10, 4]);

  await enterKey(page);
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  for (const d of '1234') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#app')).toBeVisible();
  await bell(page, 'invchg');
  const item = page.locator('#bell-att [data-key="invchg"]');
  await expect(item).toContainText('Faktur diubah (1)');
  await item.click();
  await expect(page.locator('#view-invchg')).toBeVisible();
  const row = page.locator('#ic-table tbody tr').first();
  await expect(row).toHaveAttribute('data-what', 'koreksi_masuk');
  await expect(row).toContainText(no);
  await expect(row).toContainText('PT Sumber Rejeki');
  await expect(row).toContainText(`${p1.name}: qty 10 → 8`);
  await expect(row).toContainText('Rp'); // the owner sees the purchase price
  await expect(row).toContainText('salah hitung');
  await expect(row.locator('[data-who]')).toContainText(/Diminta Siti \(.*\) · disetujui Jihan \(.*\)/);
  // opening the view clears the notice
  await bell(page, 'invchg', false);
  await expect(page.locator('#bell-att [data-key="invchg"]')).toHaveCount(0);
  await page.locator('.modal-bg [data-act="modal-close"]').first().click().catch(() => {});
  // filter: sales invoices only → none; print
  await page.click('#ic-docs [data-d="jual"]');
  await expect(page.locator('#ic-empty')).toBeVisible();
  await page.click('#ic-docs [data-d=""]');
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  await page.click('#ic-print');
  await expect(page.locator('#print-area #ic-print-table')).toContainText(no);
  // Arabic
  await page.evaluate(() => { S.lang = 'ar'; RENDER.invchg(); });
  await expect(page.locator('#view-invchg h1')).toHaveText('تغييرات الفواتير');
  await expect(page.locator('#ic-table tbody tr').first().locator('[data-who]')).toContainText('طلبه Siti');
});

test('the manager sees "Perubahan faktur" with quantities only; the owner\'s own void is logged as a change', async ({ page }) => {
  await openApp(page);
  const { no } = await goodsInAndFix(page);
  // the owner voids a sale himself → a change record (his own: "langsung")
  const inv = (await getDb(page)).sales.find(s => s.status !== 'void');
  const v = await asUser(page, 'Pemilik', '1234', 'void_sale', { invoice_no: inv.invoice_no, reason: 'tes batal' });
  expect(v.error).toBeUndefined();
  const rec = (await getDb(page)).activity.find(a => a.kind === 'ubah_faktur' && a.ref === inv.invoice_no);
  expect(JSON.parse(rec.detail)).toMatchObject({ what: 'batal', requested_by: 'Pemilik', approved_by: 'Pemilik' });
  expect(rec.summary).toContain('diubah langsung oleh Pemilik');
  await enterKey(page);
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'invchg');
  const rows = page.locator('#ic-table tbody tr');
  await expect(rows).toHaveCount(2);
  const fixRow = page.locator(`#ic-table tbody tr[data-what="koreksi_masuk"]`);
  await expect(fixRow).toContainText('qty 10 → 8');
  await expect(fixRow).not.toContainText('Rp'); // no purchase prices for the manager (akuntan_sees_cost off)
  await expect(page.locator('#ic-table tbody tr[data-what="batal"]')).toContainText(inv.invoice_no);
  // the manager is not told by the bell (the notice is the owner's)
  await bell(page, 'invchg', false);
  await expect(page.locator('#bell-att [data-key="invchg"]')).toHaveCount(0);
  // the server answer for a cashier: forbidden
  const f = await asUser(page, 'Siti', '1111', 'list_invoice_changes', { from: jktToday(), to: jktToday() });
  expect(f.error).toBe('FORBIDDEN');
  expect(no).toBeTruthy();
});

test('stock count every two months: reminder for owner and manager, last/next on the stock-count tab, interval 7–180, overdue notice once', async ({ page }) => {
  await openApp(page);
  const back = n => new Date(Date.now() + 7 * 3600000 - n * 86400000).toISOString().slice(0, 10);
  await editDb(page, `db.settings.opname_state = { since: '2026-01-01', last_full: arg, last_full_by: 'Pemilik' };`, back(55));
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await bell(page, 'opname-due');
  const item = page.locator('#bell-att [data-key="opname-due"]');
  await expect(item).toContainText('Stok opname penuh jatuh tempo');
  await expect(item).toContainText('(5 hari lagi)');
  await item.click();
  await expect(page.locator('#view-gudang')).toBeVisible();
  const due = page.locator('#gdo-due');
  await expect(due).toHaveAttribute('data-status', 'due');
  await expect(page.locator('#gdo-due-line')).toContainText('Terakhir:');
  await expect(page.locator('#gdo-due-badge')).toHaveText('5 hari lagi');
  // a bad interval is refused; 90 days → not due any more
  await page.fill('#gdo-every', '3');
  await page.click('#gdo-every-save');
  await expect(page.locator('#gdo-every-err')).toHaveText('Isi 7–180 hari');
  await page.fill('#gdo-every', '90');
  await page.click('#gdo-every-save');
  await expect(page.locator('#gdo-due')).toHaveAttribute('data-status', 'ok');
  expect((await getDb(page)).settings.opname_every_days).toBe(90);
  // overdue (back to 60, last full 70 days ago): the next app start writes ONE notice for owner + manager
  await editDb(page, `db.settings.opname_every_days = 60; db.settings.opname_state = { since: '2026-01-01', last_full: arg };`, back(70));
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await bell(page, 'opname-due');
  await expect(page.locator('#bell-att [data-key="opname-due"]')).toContainText('TERLAMBAT 10 hari');
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  const notes = (await getDb(page)).activity.filter(a => a.kind === 'notifikasi' && /Stok opname penuh TERLAMBAT/.test(a.summary));
  expect(notes).toHaveLength(1);
  expect(notes[0].ref).toBe('owner,manager');
  // the manager sees the reminder too
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await bell(page, 'opname-due');
  await expect(page.locator('#bell-att [data-key="opname-due"]')).toBeVisible();
});

test('a full count (≥ 90 % of active products) by the owner resets the clock; Arabic texts', async ({ page }) => {
  await openApp(page);
  await editDb(page, `db.settings.opname_state = { since: '2026-01-01' };`);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const ids = (await getDb(page)).products.filter(p => p.active !== false).map(p => ({ product_id: p.id, counted: p.stock }));
  expect(ids.length).toBeGreaterThan(0);
  const r = await page.evaluate(async c => await api('stock_count', { counts: c }), ids);
  expect(r.opname.last_full).toBe(jktToday());
  expect(r.opname.status).toBe('ok');
  await page.evaluate(o => applyOpnameResp(o), r.opname);
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="opname"]');
  await expect(page.locator('#gdo-due')).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('#gdo-due-badge')).toHaveText('60 hari lagi');
  expect((await getDb(page)).activity.some(a => a.kind === 'opname_penuh')).toBe(true);
  await page.evaluate(() => { S.lang = 'ar'; gdDrawOpname($('#gd-body'), true); });
  await expect(page.locator('#gdo-due h3')).toContainText('الجرد الكامل الدوري');
  await expect(page.locator('#gdo-due-badge')).toHaveText('بعد 60 يوم');
});

test('daily report: today\'s goods-in notes with lines, qty received, stock now; corrections of the day; cost only for the owner', async ({ page }) => {
  await openApp(page);
  const { no, p1, p2 } = await goodsInAndFix(page);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'reports');
  await page.click('[data-act="rp-mode"][data-m="daily"]');
  const gi = page.locator('#dr-goods-in');
  await expect(gi).toContainText('Barang masuk hari ini (1 nota)');
  const note = gi.locator(`.dr-gi[data-no="${no}"]`);
  await expect(note).toContainText('PT Sumber Rejeki');
  await expect(note).toContainText('Siti');
  await expect(note).toContainText('dikoreksi 1×');
  const db = await getDb(page);
  const st1 = db.products.find(p => p.id === p1.id).stock;
  await expect(note.locator(`tr[data-pid="${p1.id}"] [data-gi-qty]`)).toContainText('10');
  await expect(note.locator(`tr[data-pid="${p1.id}"] [data-gi-stock]`)).toHaveText(String(st1).replace('.', ','));
  await expect(note.locator(`tr[data-pid="${p2.id}"] [data-gi-qty]`)).toContainText('4');
  await expect(gi).toContainText('Rp 20.000'); // the owner sees the purchase price
  await expect(page.locator('#dr-invchg')).toContainText('Perubahan faktur hari ini (1)');
  await expect(page.locator('#dr-invchg')).toContainText('qty 10 → 8');
  const text = await page.locator('#dr-text').textContent();
  expect(text).toContain('Barang masuk hari ini: 1 nota');
  expect(text).toContain(`${no} PT Sumber Rejeki`);
  expect(text).toContain('Perubahan faktur hari ini: 1');
  expect(text).toContain('diminta Siti, disetujui Jihan');
  // the manager: lines and stock, no purchase prices
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'reports');
  await page.click('[data-act="rp-mode"][data-m="daily"]');
  await expect(page.locator(`#dr-goods-in .dr-gi[data-no="${no}"]`)).toBeVisible();
  await expect(page.locator('#dr-goods-in')).not.toContainText('Rp 20.000');
  // Arabic heading
  await page.evaluate(() => { S.lang = 'ar'; drawDaily(); });
  await expect(page.locator('#dr-goods-in h3')).toContainText('البضاعة الواردة اليوم');
});
