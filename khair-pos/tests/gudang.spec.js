// Gudang (warehouse): overview, stock list, stock card, expiry (FIFO estimate), stock count (opname) with owner
// approval, Barang Masuk expiry date, Beranda attention items. Expected numbers are recomputed from the mock DB.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { rp, SHOTS, jktToday, login, typePin, getDb, productByName, nav, closeModals, photoFile, asUser, editDb, pickCarrier, CARRIER, switchUser } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const NFQ = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
const fq = q => NFQ.format(q);
const r3 = q => Math.round(q * 1000) / 1000;
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const ADJ = ['PENYESUAIAN STOK', 'STOK OPNAME'];

/** Quantity sold per product id over the last 30 days (today included), void sales excluded. */
function sold30(db, T = jktToday()) {
  const from = addDays(T, -29), voided = new Set(db.sales.filter(s => s.status === 'void').map(s => s.invoice_no)), m = {};
  db.items.forEach(i => { if (!voided.has(i.invoice_no) && i.sale_date >= from && i.sale_date <= T) m[i.product_id] = (m[i.product_id] || 0) + i.qty; });
  return m;
}
/** FIFO: the current stock is made of the newest purchases (last 12 months); batches with exp_date within `within` days. */
function fifo(db, within, T = jktToday()) {
  const from = addDays(T, -364), out = [];
  for (const p of db.products.filter(x => x.active !== false)) {
    const rows = db.purchases.filter(r => r.product_id === p.id && !ADJ.includes(r.supplier) && r.qty > 0 && r.purchase_date >= from)
      .sort((a, b) => b.purchase_date.localeCompare(a.purchase_date) || b.id - a.id);
    let left = Math.max(0, p.stock);
    for (const r of rows) {
      if (left <= 0) break;
      const rem = r3(Math.min(r.qty, left)); left = r3(left - rem);
      if (r.exp_date && daysBetween(T, r.exp_date) <= within) out.push({ p, r, rem, days: daysBetween(T, r.exp_date) });
    }
  }
  return out;
}
function statusOf(p, sold) {
  const avg = (sold[p.id] || 0) / 30, days = avg > 0 ? Math.max(0, p.stock) / avg : null;
  return p.stock <= 0 ? 'habis' : p.stock <= p.min_stock ? 'menipis' : (!(avg > 0) || days > 90) ? 'lebih' : 'aman';
}
async function openGudang(page, tab) {
  await nav(page, 'gudang');
  await expect(page.locator('#gd-tabs')).toBeVisible();
  if (tab) await page.click(`[data-act="gd-tab"][data-tab="${tab}"]`);
}
async function refreshGudang(page) {
  await page.click('[data-act="gd-refresh"]');
  await expect(page.locator('body')).not.toHaveClass(/busy/);
}
function saleData(p, qty, price) {
  return { client_id: 'gd-' + Math.random().toString(36).slice(2), sale_date: jktToday(), items: [{ product_id: p.id, qty, unit_price: price || p.retail_price, price_type: 'eceran' }], discount: 0, payment_method: 'tunai', paid_amount: Math.round(qty * (price || p.retail_price)) };
}
async function relogin(page, user, pin) { await switchUser(page, user, pin); }

test('overview numbers match the mock DB; urgent list and Beranda expiry item link into Gudang', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const db = await getDb(page), T = jktToday();
  const act = db.products.filter(p => p.active !== false), pos = p => Math.max(0, p.stock);
  // Beranda: expiring batches (≤ 30 days, FIFO) → "N barang hampir kedaluwarsa"
  const exp30 = new Set(fifo(db, 30).map(b => b.p.id));
  expect(exp30.size).toBeGreaterThanOrEqual(2);
  const att = page.locator('#home-att [data-act="att-go"][data-go="gudang"][data-tab="expiry"]');
  await expect(att).toContainText(`${exp30.size} barang hampir kedaluwarsa`);
  await att.click();
  await expect(page.locator('#view-gudang')).toBeVisible();
  await expect(page.locator('#gd-exp-table')).toBeVisible();
  await page.click('[data-act="gd-tab"][data-tab="overview"]');

  await expect(page.locator('[data-kpi="gd-items"] .v')).toHaveText(NF.format(act.length));
  await expect(page.locator('[data-kpi="gd-units"] .v')).toHaveText(fq(act.reduce((a, p) => a + pos(p), 0)));
  await expect(page.locator('[data-kpi="gd-cost"] .v')).toHaveText(rp(act.reduce((a, p) => a + pos(p) * p.cost_price, 0)));
  await expect(page.locator('[data-kpi="gd-retail"] .v')).toHaveText(rp(act.reduce((a, p) => a + pos(p) * p.retail_price, 0)));
  await expect(page.locator('[data-kpi="gd-habis"] .v')).toHaveText(String(act.filter(p => p.stock <= 0).length));
  await expect(page.locator('[data-kpi="gd-menipis"] .v')).toHaveText(String(act.filter(p => p.stock > 0 && p.stock <= p.min_stock).length));
  await expect(page.locator('[data-kpi="gd-exp"] .v')).toHaveText(String(exp30.size));
  // the most urgent: the batch expiring within 7 days is listed with a red badge and opens its stock card
  const soon = fifo(db, 7)[0];
  const u = page.locator(`#gd-urgent [data-act="gd-card"][data-id="${soon.p.id}"]`);
  await expect(u).toContainText(soon.p.name);
  await expect(u.locator('.badge.red')).toHaveText(`${soon.days} hari`);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-gudang.png') });
  await u.click();
  await expect(page.locator('#gd-card-modal')).toContainText(soon.p.name);
  await closeModals(page);
  // KPI tile → filtered list
  await page.click('[data-kpi="gd-menipis"]');
  await expect(page.locator('#gd-status .chip.on')).toHaveAttribute('data-status', 'menipis');
  await expect(page.locator('#gd-table tbody tr[data-pid]')).toHaveCount(act.filter(p => p.stock > 0 && p.stock <= p.min_stock).length);
});

test('stock list: filters, status, days left and reorder suggestion for a product with known sales', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // a fresh product whose whole sales history is made here: stock 30, min 10
  const np = (await asUser(page, 'Pemilik', '1234', 'save_product', { name: 'Uji Madu Gudang 250 g', category: 'Madu', unit: 'btl', cost_price: 40000, retail_price: 55000, stock: 30, min_stock: 10 })).product;
  for (const q of [5, 5, 5]) expect((await asUser(page, 'Pemilik', '1234', 'save_sale', saleData(np, q))).invoice_no).toBeTruthy();
  await editDb(page, `db.products.find(p => /Tasbih/.test(p.name)).stock = 0;`);
  await openGudang(page, 'list');
  await refreshGudang(page);
  const row = page.locator(`#gd-table tr[data-pid="${np.id}"]`);
  // sold 15 in 30 days → 0,5 per day; stock 15 → 30 days; not low → no suggestion
  await expect(row.locator('[data-col="days"]')).toHaveText('30 hari');
  await expect(row.locator('[data-col="status"] [data-status]')).toHaveText('Aman');
  await expect(row.locator('[data-col="reorder"]')).toHaveText('—');
  // 7 more sold → stock 8 ≤ min 10; avg 22/30 per day; 8 ÷ 0,7333 = 10,9 days; reorder ceil(14 × 0,7333 − 8) = 3
  await asUser(page, 'Pemilik', '1234', 'save_sale', saleData(np, 7));
  await refreshGudang(page);
  await expect(row.locator('[data-col="stock"]')).toContainText('8');
  await expect(row.locator('[data-col="days"]')).toHaveText('10 hari');
  await expect(row.locator('[data-col="status"] [data-status]')).toHaveText('Menipis');
  await expect(row.locator('[data-col="reorder"]')).toContainText('+3');

  const db = await getDb(page), sold = sold30(db), act = db.products.filter(p => p.active !== false);
  const count = st => act.filter(p => statusOf(p, sold) === st).length;
  for (const st of ['menipis', 'habis', 'lebih']) {
    await page.click(`#gd-status [data-status="${st}"]`);
    await expect(page.locator('#gd-table tbody tr[data-pid]')).toHaveCount(count(st));
    await expect(page.locator(`#gd-table tbody [data-col="status"] [data-status="${st}"]`)).toHaveCount(count(st));
    if (st === 'habis') await expect(page.locator('#gd-table')).toContainText('Tasbih');
  }
  await page.click('#gd-status [data-status="kedaluwarsa"]');
  await expect(page.locator('#gd-table tbody tr[data-pid]')).toHaveCount(new Set(fifo(db, 30).map(b => b.p.id)).size);
  await page.click('#gd-status [data-status=""]');
  await page.selectOption('#gd-cat', 'Kurma');
  await expect(page.locator('#gd-table tbody tr[data-pid]')).toHaveCount(act.filter(p => p.category === 'Kurma').length);
  await page.selectOption('#gd-cat', '');
  await page.fill('#gd-q', 'pistachio');
  await expect(page.locator('#gd-table tbody tr[data-pid]')).toHaveCount(1);
  await page.fill('#gd-q', '');
  // sort by days left: the first row has the fewest days among products with sales
  await page.selectOption('#gd-sort', 'days');
  const withDays = act.filter(p => (sold[p.id] || 0) > 0).map(p => ({ p, d: Math.max(0, p.stock) / (sold[p.id] / 30) })).sort((a, b) => a.d - b.d || a.p.stock - b.p.stock || a.p.name.localeCompare(b.p.name));
  await expect(page.locator('#gd-table tbody tr[data-pid]').first()).toHaveAttribute('data-pid', String(withDays[0].p.id));
  await expect(page.locator('#gd-table tbody tr[data-pid]')).toHaveCount(act.length);
});

test('stock card: running balance ends at the current stock; purchase, sales and opname rows; CSV export', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const T = jktToday(), p = productByName(await getDb(page), /Kurma Ajwa/);
  const ph = await asUser(page, 'Pemilik', '1234', 'scan_purchase', { image_base64: 'AAAA', mime: 'image/jpeg' });
  await asUser(page, 'Pemilik', '1234', 'save_purchase', { carrier: CARRIER, purchase_date: T, supplier: 'PT Uji Kartu Stok', photo_id: ph.photo_id, items: [{ product_id: p.id, qty: 10, cost_price: 130000, exp_date: addDays(T, 200) }], mismatch_reason: 'uji kartu stok' });
  await asUser(page, 'Pemilik', '1234', 'save_sale', saleData(p, 3));
  const cur = productByName(await getDb(page), /Kurma Ajwa/).stock;
  const op = await asUser(page, 'Pemilik', '1234', 'stock_count', { counts: [{ product_id: p.id, counted: cur - 1 }], note: 'Uji kartu' });
  expect(op).toMatchObject({ applied: true });
  expect(op.lines[0]).toMatchObject({ product_id: p.id, system: cur, counted: cur - 1, diff: -1 });

  await openGudang(page, 'list');
  await refreshGudang(page);
  await page.fill('#gd-q', 'ajwa');
  await expect(page.locator(`#gd-table tr[data-pid="${p.id}"] [data-col="stock"]`)).toContainText(fq(cur - 1));
  await page.locator(`#gd-table tr[data-pid="${p.id}"]`).locator("td").first().click();
  const card = page.locator('#gd-card-modal');
  await expect(card.locator('#gd-card-table')).toBeVisible();
  await expect(card.locator('#gdc-range .chip.on')).toHaveText('30 hari');
  await expect(card.locator('tr[data-kind="in"]').filter({ hasText: 'PT Uji Kartu Stok' })).toContainText(`exp ${addDays(T, 200).split('-').reverse().join('/')}`);
  await expect(card.locator('tr[data-kind="out"]').first()).toBeVisible();
  await expect(card.locator('tr[data-kind="opname"]')).toContainText('dihitung');
  await expect(card.locator('tr[data-kind="opname"]')).toContainText('−1');
  // each row: previous balance + in − out = balance; the last one is the current stock
  const parse = s => Number(String(s || '').replace(/[^\d,]/g, '').replace(',', '.')) || 0; // absolute value
  const rows = await card.locator('#gd-card-table tbody tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim())));
  const end = cur - 1;
  let bal = parse(rows[0][4]);
  for (const r of rows.slice(1, -1)) { bal = r3(bal + parse(r[2]) - parse(r[3])); expect(parse(r[4])).toBe(bal); }
  expect(bal).toBe(end);
  await expect(card.locator('#gdc-end')).toHaveText(fq(end));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-stock-card.png') });
  // 7-day range: the opening balance changes but the card still ends at the current stock
  await card.locator('#gdc-range [data-n="7"]').click();
  await expect(card.locator('#gdc-range .chip.on')).toHaveText('7 hari');
  await expect(card.locator('#gdc-end')).toHaveText(fq(end));
  const [dl] = await Promise.all([page.waitForEvent('download'), card.locator('#gdc-csv').click()]);
  expect(dl.suggestedFilename()).toMatch(/^kartu-stok-.*\.csv$/);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  expect(csv).toContain('Saldo awal');
  expect(csv).toContain('Stok opname');
  expect(csv.trim().split('\n').pop()).toContain(`"${end}"`);
});

test('expiry list: FIFO estimate of what is left per batch, badges by days left', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openGudang(page, 'expiry');
  let db = await getDb(page);
  let list = fifo(db, 60);
  await expect(page.locator('#gd-exp-hint')).toContainText('barang masuk terbaru');
  await expect(page.locator('#gd-exp-table tbody tr[data-batch]')).toHaveCount(list.length);
  for (const b of list) {
    const tr = page.locator(`#gd-exp-table tr[data-batch="${b.r.id}"]`);
    await expect(tr.locator('[data-col="rem"]')).toContainText(`±${fq(b.rem)}`);
    await expect(tr.locator('[data-exp-days]')).toHaveClass(b.days <= 7 ? /red/ : b.days <= 30 ? /amber/ : /gray/);
  }
  const choc = list.find(b => /Cokelat Arab/.test(b.p.name));
  expect(choc.days).toBeLessThanOrEqual(7);
  expect(choc.rem).toBe(12);
  expect(list.find(b => /Sukkari/.test(b.p.name)).days).toBeLessThanOrEqual(30);
  // only 5 left in stock → the newest batch (12, short-dated) can hold at most 5
  await editDb(page, `db.products.find(p => /Cokelat Arab/.test(p.name)).stock = 5;`);
  await refreshGudang(page);
  db = await getDb(page); list = fifo(db, 60);
  await expect(page.locator(`#gd-exp-table tr[data-batch="${choc.r.id}"] [data-col="rem"]`)).toContainText('±5');
  await expect(page.locator('#gd-exp-table tbody tr[data-batch]')).toHaveCount(list.length);
});

test('owner opname: blind count, draft survives reload, applies immediately and logs STOK OPNAME', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const med = productByName(await getDb(page), /Medjool/), kha = productByName(await getDb(page), /Kurma Khalas/);
  await openGudang(page, 'opname');
  await page.fill('#gdo-q', 'medjool');
  await page.press('#gdo-q', 'Enter');
  await page.fill('#gdo-q', kha.sku);
  await page.press('#gdo-q', 'Enter'); // barcode (SKU) + Enter
  await expect(page.locator('#gdo-table tbody tr')).toHaveCount(2);
  // blind: no system stock / difference before "Tampilkan selisih"
  await expect(page.locator('#gdo-table thead')).not.toContainText('Sistem');
  await expect(page.locator('[data-gdo-sys]')).toHaveCount(0);
  await page.fill(`[data-gdo="${med.id}"]`, String(med.stock - 3));
  await page.fill(`[data-gdo="${kha.id}"]`, `${kha.stock},5`); // kg: decimal comma
  await expect(page.locator('#gdo-progress')).toHaveText('2 dari 2 barang sudah dihitung');
  await page.reload();
  await openGudang(page, 'opname');
  await expect(page.locator('#gdo-table')).toBeVisible();
  await expect(page.locator(`[data-gdo="${med.id}"]`)).toHaveValue(String(med.stock - 3));
  await page.click('#gdo-show');
  await expect(page.locator(`[data-gdo-sys="${med.id}"]`)).toHaveText(fq(med.stock));
  await expect(page.locator(`[data-gdo-diff="${med.id}"]`)).toHaveText('-3');
  await expect(page.locator(`[data-gdo-diff="${kha.id}"]`)).toHaveText('+0,5');
  await expect(page.locator('#gdo-progress')).toContainText('2 selisih');
  await page.fill('#gdo-note', 'Opname akhir bulan');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-opname.png') });
  await page.click('#gdo-submit');
  await page.click('#cf-ok');
  await expect(page.locator('#gdo-res[data-applied="1"]')).toContainText('2 selisih');
  await expect(page.locator('.toast.ok')).toContainText('Stok opname diterapkan');
  await expect(page.locator('#gdo-table')).toHaveCount(0);
  const db = await getDb(page);
  expect(productByName(db, /Medjool/).stock).toBe(med.stock - 3);
  expect(productByName(db, /Kurma Khalas/).stock).toBe(kha.stock + 0.5);
  const rows = db.purchases.filter(r => r.supplier === 'STOK OPNAME');
  expect(rows.map(r => [r.product_id, r.qty, r.total, r.user])).toEqual([[med.id, -3, 0, 'Pemilik'], [kha.id, 0.5, 0, 'Pemilik']]);
  expect(rows[0].note).toContain(`dihitung ${med.stock - 3}, sistem ${med.stock}`);
  expect(rows[0].note).toContain('Opname akhir bulan');
  // the draft is gone; the stock list shows the new number
  await page.reload();
  await openGudang(page, 'opname');
  await expect(page.locator('#gdo-empty')).toBeVisible();
  // opname rows are adjustments, not purchases: Barang Masuk "recent" list and report totals skip them
  await nav(page, 'reports');
  await expect(page.locator('[data-kpi="purchases"] .s')).toContainText('2 penyesuaian stok');
});

test('manager opname → owner approval; approved diff is added to the CURRENT stock; manager never sees cost', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const kha = productByName(await getDb(page), /Kurma Khalas/);
  await openGudang(page);
  await expect(page.locator('[data-kpi="gd-retail"]')).toBeVisible();
  await expect(page.locator('[data-kpi="gd-cost"]')).toHaveCount(0);
  await expect(page.locator('#view-gudang')).not.toContainText('Modal');
  await page.click('[data-act="gd-tab"][data-tab="opname"]');
  await page.fill('#gdo-q', 'khalas');
  await page.press('#gdo-q', 'Enter');
  await page.fill(`[data-gdo="${kha.id}"]`, String(kha.stock - 3));
  await expect(page.locator('#gdo-submit')).toContainText('Kirim ke pemilik');
  await page.click('#gdo-submit');
  await page.click('#cf-ok');
  await expect(page.locator('#gdo-res[data-applied="0"]')).toContainText('Menunggu persetujuan pemilik');
  let db = await getDb(page);
  const ap = db.approvals.find(a => a.kind === 'opname');
  expect(ap).toMatchObject({ status: 'pending', approver_role: 'owner', cashier: 'Jihan' });
  expect(ap.summary).toBe(`Stok opname 1 barang, 1 selisih: ${kha.name} ${kha.stock}→${kha.stock - 3}`);
  expect(JSON.parse(ap.payload)).toMatchObject({ by: 'Jihan', lines: [{ product_id: kha.id, system: kha.stock, counted: kha.stock - 3, diff: -3 }] });
  expect(productByName(db, /Kurma Khalas/).stock).toBe(kha.stock); // nothing applied yet
  await expect(page.locator(`#gdo-pending [data-req="${ap.request_id}"]`)).toBeVisible();
  // manager: read-only card, "Butuh pemilik", retail value only; deciding is refused
  await nav(page, 'approvals');
  await page.click('[data-act="apr-refresh"]');
  const card = page.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'opname');
  await expect(card.locator('[data-owner-only]')).toHaveText('Butuh pemilik');
  await expect(card.locator('[data-d="approved"]')).toBeDisabled();
  await expect(card.locator(`[data-opname-lines] tr[data-pid="${kha.id}"] [data-val="retail"]`)).toHaveText(rp(-3 * kha.retail_price));
  await expect(card.locator('[data-val="cost"]')).toHaveCount(0);
  await expect(card).not.toContainText('Modal');
  expect((await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: ap.request_id, decision: 'approved' })).error).toBe('NEEDS_OWNER');
  const g = await asUser(page, 'Jihan', '2222', 'get_sales', { from: addDays(jktToday(), -30), to: jktToday() });
  expect(g.purchases.length).toBeGreaterThan(5);
  expect(JSON.stringify(g.purchases)).not.toContain('cost_price');

  // a sale happens between the count and the approval
  await asUser(page, 'Pemilik', '1234', 'save_sale', saleData(kha, 2));
  await relogin(page, 'Pemilik', '1234');
  await expect.poll(() => page.evaluate(() => ATT.items.map(x => x.text).join(' | '))).toContain('Opname menunggu persetujuan (1)');
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-act="att-go"][data-tab="opname"]')).toContainText('Opname menunggu persetujuan (1)');
  await closeModals(page);
  await nav(page, 'approvals');
  await page.click('[data-act="apr-refresh"]');
  const oc = page.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(oc).toContainText('Stok opname: 1 barang, 1 selisih');
  await expect(oc.locator(`tr[data-pid="${kha.id}"] [data-val="cost"]`)).toHaveText(rp(-3 * kha.cost_price));
  await expect(oc.locator('[data-total="retail"]')).toHaveText(rp(-3 * kha.retail_price));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-approvals-opname.png') });
  await oc.locator('[data-d="approved"]').click();
  await expect(page.locator('.toast.ok').filter({ hasText: ap.request_id })).toBeVisible();
  db = await getDb(page);
  expect(productByName(db, /Kurma Khalas/).stock).toBe(kha.stock - 2 - 3);
  const log = db.purchases.filter(r => r.supplier === 'STOK OPNAME').pop();
  expect(log).toMatchObject({ product_id: kha.id, qty: -3, total: 0, user: 'Jihan' });
  expect(log.note).toContain('disetujui Pemilik');
  expect(db.approvals.find(a => a.request_id === ap.request_id)).toMatchObject({ status: 'approved', decided_by: 'Pemilik' });
  // the owner app shows the new stock right away
  await openGudang(page, 'list');
  await page.fill('#gd-q', 'khalas');
  await expect(page.locator(`#gd-table tr[data-pid="${kha.id}"] [data-col="stock"]`)).toContainText(fq(kha.stock - 5));
});

test('Barang Masuk: optional expiry date per line is sent as exp_date and shows up in the expiry list', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true }); // goods-in is the manager's job; the owner only watches
  const T = jktToday(), p = productByName(await getDb(page), /Kismis Hitam/);
  await openGudang(page, 'expiry'); // loads (and caches) the 12-month data first
  await expect(page.locator('#gd-exp-table')).toBeVisible();
  await nav(page, 'purchases');
  await page.setInputFiles('#pu-photo', await photoFile(page));
  await expect(page.locator('#pu-photo-card')).toHaveClass(/done/);
  await page.click('[data-act="pu-clear"]');
  await page.fill('#pu-sup', 'CV Uji Kedaluwarsa');
  await page.fill('#pu-q', 'kismis hitam');
  await page.locator('[data-act="pu-add"]').first().click();
  await page.locator('[data-pu-qty="0"]').fill('6');
  await page.locator('[data-pu-cost="0"]').fill('26.000');
  await page.locator('[data-pu-exp="0"]').fill(addDays(T, 12));
  await pickCarrier(page);
  await page.click('#pu-save');
  await page.fill('#pu-reason', 'Nota lain');
  await page.click('#pu-save-reason');
  await expect(page.locator('#pu-res')).toBeVisible();
  const db = await getDb(page);
  expect(db.purchases.slice(-1)[0]).toMatchObject({ supplier: 'CV Uji Kedaluwarsa', product_id: p.id, qty: 6, exp_date: addDays(T, 12) });
  await openGudang(page, 'expiry');
  const tr = page.locator(`#gd-exp-table tr[data-batch="${db.purchases.slice(-1)[0].id}"]`);
  await expect(tr).toContainText('CV Uji Kedaluwarsa');
  await expect(tr.locator('[data-exp-days]')).toHaveText('12 hari');
  await expect(tr.locator('[data-col="rem"]')).toContainText('±6');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('Gudang lives in the Lainnya menu; Arabic RTL screenshot', async ({ page }) => {
    await login(page, 'Pemilik', '1234', '', { stay: true });
    await expect(page.locator('#nav [data-view="gudang"]')).toBeHidden();
    await page.click('#nav-more');
    await expect(page.locator('#more-list [data-view="gudang"]')).toContainText('Gudang');
    await page.click('#more-list [data-view="gudang"]');
    await expect(page.locator('#view-gudang')).toBeVisible();
    await expect(page.locator('[data-kpi="gd-exp"] .v')).not.toHaveText('…');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, 'phone-gudang.png') });
    await page.click('#tb-lang');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('#view-gudang h1')).toHaveText('المخزن');
    await expect(page.locator('#gd-tabs')).toContainText('جرد المخزون');
    await page.click('[data-act="gd-tab"][data-tab="list"]');
    await expect(page.locator('#gd-table thead')).toContainText('ينفد خلال');
    await page.click('[data-act="gd-tab"][data-tab="overview"]');
    await expect(page.locator('[data-kpi="gd-retail"] .k')).toHaveText('قيمة المخزون (بسعر التجزئة)');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, 'phone-gudang-ar.png') });
    await page.click('#tb-lang');
  });
});
