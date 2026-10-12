// Hitung stok (Lainnya): blind stock count by the cashier → owner approval (kind 'opname').
// The cashier never sees system stock or differences; the draft survives a reload and offline periods.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('blind stock count: draft survives reload and offline, submit creates an owner approval', async ({ page, context }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const med = H.productByName(db0, /Medjool/), kha = H.productByName(db0, /Kurma Khalas/);
  await H.tab(page, 'more');
  await expect(page.locator('#m-count')).toContainText('Hitung stok');
  await page.click('#m-count');
  const m = page.locator('#stock-count');
  await expect(m).toBeVisible();
  // v40: every product is a row of the table with its own count box (no searching needed)
  const active = db0.products.filter(p => p.active !== false);
  await expect(page.locator('#sc-head')).toHaveText(`Sudah dihitung: 0 dari ${active.length} barang`);
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(Math.min(60, active.length));
  await expect(page.locator(`#sc-lines [data-line="${med.id}"]`)).not.toContainText(String(med.stock)); // rows show no stock
  // search narrows the table; Enter jumps into the count box
  await page.fill('#sc-q', 'medjool');
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(1);
  await page.press('#sc-q', 'Enter');
  await expect(page.locator(`[data-sc="${med.id}"]`)).toBeFocused();
  await page.keyboard.type('21');
  await page.keyboard.press('Enter'); // last row of the view → back to the search box for the next scan
  await expect(page.locator('#sc-q')).toBeFocused();
  await page.fill('#sc-q', kha.sku);
  await page.press('#sc-q', 'Enter'); // barcode (SKU) + Enter
  await expect(page.locator(`[data-sc="${kha.id}"]`)).toBeFocused();
  await page.keyboard.type('79,5');
  // owner 2026-10-12: right under the search, "Semua barang" (all in one table) and "Per kategori" (pick a category)
  await page.fill('#sc-q', '');
  await expect(page.locator('#sc-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sc-all')).toContainText(String(active.length));
  await expect(page.locator('#sc-cats')).toBeHidden();
  await page.click('#sc-bycat');
  await expect(page.locator('#sc-cats')).toBeVisible();
  await expect(page.locator('#sc-empty')).toContainText('Pilih kategori');
  await page.click(`#sc-cats [data-sc-cat="${kha.category}"]`);
  const inCat = active.filter(p => p.category === kha.category);
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(Math.min(60, inCat.length));
  await expect(page.locator(`#sc-lines [data-line="${kha.id}"] [data-sc]`)).toHaveValue('79,5');
  await page.locator(`#sc-lines [data-line="${kha.id}"] [data-sc]`).fill('80'); // a fix right in the category table
  await page.locator(`#sc-lines [data-line="${kha.id}"] [data-sc]`).fill('79,5');
  await page.click('#sc-done');
  await expect(page.locator('#sc-done')).toHaveText('Sudah dihitung (2)');
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(2);
  await expect(page.locator('#sc-lines .sc-row.done')).toHaveCount(2);
  await expect(page.locator('#sc-head')).toHaveText(`Sudah dihitung: 2 dari ${active.length} barang`);
  await expect(page.locator('#sc-send')).toContainText('Kirim (2)');
  // blind: no system stock, no difference
  for (const w of ['Sistem', 'Selisih', 'Stok']) await expect(m).not.toContainText(w);
  await page.click('#sc-all');
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(Math.min(60, active.length));
  await H.shot(page, 'phone-33-stock-count', false, { noToasts: true });

  // draft survives a reload
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await H.tab(page, 'more');
  await page.click('#m-count');
  await expect(page.locator(`[data-sc="${med.id}"]`)).toHaveValue('21');
  await expect(page.locator(`[data-sc="${kha.id}"]`)).toHaveValue('79,5');
  await page.fill('#sc-note', 'Rak depan');

  // offline: kept, "butuh internet untuk mengirim"
  await context.setOffline(true);
  await page.click('#sc-send');
  await page.click('#cf-ok');
  await expect(page.locator('#sc-err')).toContainText('Butuh internet untuk mengirim');
  expect((await H.getDb(page)).approvals.filter(a => a.kind === 'opname')).toHaveLength(0);
  await expect(page.locator('#sc-lines .sc-row.done')).toHaveCount(2);
  await context.setOffline(false);

  // online: sent → ONE approval for the manager (v40), the owner is told; the answer (system stock, differences) is not shown
  await page.click('#sc-send');
  await page.click('#cf-ok');
  await expect(page.locator('#sc-sent')).toContainText('Terkirim ke manajer untuk disetujui');
  const db = await H.getDb(page);
  const ap = db.approvals.find(a => a.kind === 'opname');
  expect(ap).toMatchObject({ status: 'pending', approver_role: 'manager', cashier: 'Siti' });
  expect(db.activity.filter(a => a.kind === 'notifikasi' && a.ref === 'owner').slice(-1)[0].summary).toContain('Stok opname dari Siti: 2 barang');
  const pl = JSON.parse(ap.payload);
  expect(pl).toMatchObject({ by: 'Siti', note: 'Rak depan' });
  const byId = (a, b) => a[0] - b[0];
  expect(pl.lines.map(l => [l.product_id, l.counted, l.system, l.diff]).sort(byId)).toEqual([[med.id, 21, med.stock, 21 - med.stock], [kha.id, 79.5, kha.stock, 79.5 - kha.stock]].sort(byId));
  await expect(page.locator('#sc-sent')).toContainText(ap.request_id);
  for (const w of ['Sistem', 'Selisih', '→']) await expect(m).not.toContainText(w);
  for (const w of [String(med.stock), String(kha.stock)]) await expect(page.locator('#sc-res')).not.toContainText(w);
  expect(H.productByName(db, /Medjool/).stock).toBe(med.stock); // not applied before the manager approves
  await expect(page.locator('#sc-lines .sc-row.done')).toHaveCount(0);
  await expect(page.locator(`[data-sc="${med.id}"]`)).toHaveValue('');
  await H.closeModals(page);

  // my requests: pending; the kasir cannot decide it
  await page.click('#m-myreq');
  await expect(page.locator(`#myreq [data-req="${ap.request_id}"]`)).toContainText('Hitung stok 2 barang');
  await expect(page.locator(`#myreq [data-req="${ap.request_id}"] [data-status]`)).toHaveText('Menunggu');
  await H.closeModals(page);
  const pin = await page.evaluate(() => KASIR.pinHash('demo', 'Siti', '1111'));
  const dec = await page.evaluate(async ([pin, id]) => { try { return await apiRaw('decide_approval', { request_id: id, decision: 'approved' }, { key: 'demo', user: 'Siti', pin_hash: pin }); } catch (e) { return { error: e.code }; } }, [pin, ap.request_id]);
  expect(dec.error).toBe('FORBIDDEN');

  // the draft is empty after sending, also after a reload
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await H.tab(page, 'more');
  await page.click('#m-count');
  await expect(page.locator('#sc-head')).toHaveText(`Sudah dihitung: 0 dari ${active.length} barang`);
  await page.click('#sc-done');
  await expect(page.locator('#sc-empty')).toBeVisible();
  await expect(page.locator('#sc-send')).toBeDisabled();
});

test('stock count input rules: nothing counted, invalid quantity', async ({ page }) => {
  await H.login(page);
  await H.tab(page, 'more');
  await page.click('#m-count');
  await expect(page.locator('#sc-send')).toBeDisabled();
  await page.fill('#sc-q', 'ajwa');
  await page.press('#sc-q', 'Enter');
  const inp = page.locator('#sc-lines [data-sc]').first();
  await expect(inp).toBeFocused();
  await inp.fill('abc'); // v16: letters are refused while typing
  await expect(inp).toHaveValue('');
  await expect(page.locator('#rule-hint')).toHaveText('Angka saja');
  await inp.fill('.,');
  await page.click('#sc-send');
  await expect(page.locator('#sc-err')).toContainText('Jumlah tidak valid');
  await inp.fill('0');
  await page.click('#sc-send');
  await page.click('#cf-ok');
  await expect(page.locator('#sc-sent')).toContainText('Terkirim');
  const ap = (await H.getDb(page)).approvals.find(a => a.kind === 'opname');
  expect(JSON.parse(ap.payload).lines[0].counted).toBe(0);
  // the approvals inbox of this app (manager / owner) renders the opname lines
  const html = await page.evaluate(a => aprBodyHTML(a), ap);
  expect(html).toContain('Stok opname: 1 barang, 1 selisih');
  expect(html).toContain('data-opname-lines');
});

// v40 (owner 2026-10-12): two counts by the cashier make ONE table; the manager approves it all at once; the owner is told.
test('two counts by the cashier → one table; the manager approves everything in one tap; the owner is notified', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const [p1, p2] = db0.products.filter(p => p.active !== false).slice(0, 2);
  const send = async (p, qty) => {
    await H.tab(page, 'more');
    await page.click('#m-count');
    await page.fill('#sc-q', p.sku || p.name);
    await page.press('#sc-q', 'Enter');
    await page.locator(`[data-sc="${p.id}"]`).fill(String(qty));
    await page.click('#sc-send');
    await page.click('#cf-ok');
    await expect(page.locator('#sc-sent')).toBeVisible();
    const txt = await page.locator('#sc-sent').textContent();
    await H.closeModals(page);
    return txt;
  };
  expect(await send(p1, num(p1.stock) + 3)).toContain('Terkirim ke manajer');
  expect(await send(p2, Math.max(0, num(p2.stock) - 1))).toContain('Ditambahkan ke daftar hitung');
  let db = await H.getDb(page);
  const aps = db.approvals.filter(a => a.kind === 'opname' && a.status === 'pending');
  expect(aps).toHaveLength(1);
  expect(JSON.parse(aps[0].payload).lines).toHaveLength(2);
  // the manager decides the whole table once (in this app's inbox)
  const pin = await page.evaluate(() => KASIR.pinHash('demo', 'Jihan', '2222'));
  const dec = await page.evaluate(async ([pin, id]) => apiRaw('decide_approval', { request_id: id, decision: 'approved' }, { key: 'demo', user: 'Jihan', pin_hash: pin }), [pin, aps[0].request_id]);
  expect(dec.ok !== false).toBe(true);
  db = await H.getDb(page);
  expect(db.products.find(p => p.id === p1.id).stock).toBe(num(p1.stock) + 3);
  expect(db.products.find(p => p.id === p2.id).stock).toBe(Math.max(0, num(p2.stock) - 1));
  const last = db.activity.filter(a => a.kind === 'notifikasi' && a.ref === 'owner').slice(-1)[0];
  expect(last.summary).toContain('DISETUJUI oleh Jihan: 2 barang');
});
// owner 2026-10-12: «المدير هو من يقوم بالتغيير ويصل مجرد إعلام فقط للمالك» — the manager's own count is applied at once
test('the manager\'s own count in the cashier app is applied at once; the owner only gets a notice', async ({ page }) => {
  await H.login(page, 'Jihan', '2222');
  const db0 = await H.getDb(page);
  const p = db0.products.filter(x => x.active !== false)[0];
  await H.tab(page, 'more');
  await page.click('#m-count');
  await expect(page.locator('#stock-count')).toContainText('langsung diterapkan');
  await page.fill('#sc-q', p.sku);
  await page.press('#sc-q', 'Enter');
  await page.locator(`[data-sc="${p.id}"]`).fill(String(num(p.stock) + 2));
  await page.click('#sc-send');
  await expect(page.locator('.modal').last()).toContainText('pemilik diberi tahu');
  await page.click('#cf-ok');
  await expect(page.locator('#sc-sent')).toContainText('Stok diperbarui — pemilik diberi tahu');
  const db = await H.getDb(page);
  expect(db.products.find(x => x.id === p.id).stock).toBe(num(p.stock) + 2);
  expect(db.approvals.filter(a => a.kind === 'opname')).toHaveLength(0);
  expect(db.activity.filter(a => a.kind === 'notifikasi' && a.ref === 'owner').slice(-1)[0].summary).toContain('Stok opname oleh manajer Jihan langsung diterapkan: 1 barang, 1 selisih');
});
function num(v) { const x = Number(v); return isFinite(x) ? x : 0; }
