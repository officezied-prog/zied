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
  await page.fill('#sc-q', 'medjool');
  await expect(page.locator('#sc-sug [data-sc-add]')).toHaveCount(1);
  await expect(page.locator('#sc-sug')).not.toContainText(String(med.stock)); // suggestions show no stock
  await page.press('#sc-q', 'Enter');
  await page.fill('#sc-q', kha.sku);
  await page.press('#sc-q', 'Enter'); // barcode (SKU) + Enter
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(2);
  await page.fill(`[data-sc="${med.id}"]`, '21');
  await page.fill(`[data-sc="${kha.id}"]`, '79,5');
  await expect(page.locator('#sc-head')).toHaveText('Sudah dihitung: 2 dari 2');
  await expect(page.locator('#sc-send')).toContainText('Kirim (2)');
  // blind: no system stock, no difference
  for (const w of ['Sistem', 'Selisih', 'Stok']) await expect(m).not.toContainText(w);
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
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(2);
  await context.setOffline(false);

  // online: sent → approval for the owner; the answer (system stock, differences) is not shown
  await page.click('#sc-send');
  await page.click('#cf-ok');
  await expect(page.locator('#sc-sent')).toContainText('Terkirim ke pemilik untuk disetujui');
  const db = await H.getDb(page);
  const ap = db.approvals.find(a => a.kind === 'opname');
  expect(ap).toMatchObject({ status: 'pending', approver_role: 'owner', cashier: 'Siti' });
  const pl = JSON.parse(ap.payload);
  expect(pl).toMatchObject({ by: 'Siti', note: 'Rak depan' });
  const byId = (a, b) => a[0] - b[0];
  expect(pl.lines.map(l => [l.product_id, l.counted, l.system, l.diff]).sort(byId)).toEqual([[med.id, 21, med.stock, 21 - med.stock], [kha.id, 79.5, kha.stock, 79.5 - kha.stock]].sort(byId));
  await expect(page.locator('#sc-sent')).toContainText(ap.request_id);
  for (const w of ['Sistem', 'Selisih', '→', String(med.stock), String(kha.stock)]) await expect(m).not.toContainText(w);
  expect(H.productByName(db, /Medjool/).stock).toBe(med.stock); // not applied before the owner approves
  await expect(page.locator('#sc-lines [data-line]')).toHaveCount(0);
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
  await inp.fill('abc');
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
