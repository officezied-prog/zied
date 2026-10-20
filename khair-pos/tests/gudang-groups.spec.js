// v12 Gudang "Daftar stok" grouped by category / supplier / expiry band / sales speed (ABC) / packaging, with subtotals.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, productByName, nav } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => 'Rp ' + NF.format(Math.round(n));
async function openList(page) {
  await nav(page, 'gudang');
  await page.click('#gd-tabs [data-tab="list"]');
  await expect(page.locator('#gd-table')).toBeVisible();
  await expect(page.locator('#gd-count')).not.toContainText('Memuat'); // 12 months loaded
}
const group = (page, k) => page.locator(`#gd-table tbody[data-group="${k}"]`);
/** The product's most urgent batch still in stock, in days (FIFO over the last 12 months, as the app): at night, before the day's
 *  sales, the stock can reach an older batch already past its date. */
function worstDays(db, p, T = jktToday()) {
  const day = s => Date.parse(s + 'T00:00:00Z') / 86400000, from = new Date((day(T) - 364) * 86400000).toISOString().slice(0, 10);
  const rows = db.purchases.filter(r => r.product_id === p.id && !['PENYESUAIAN STOK', 'STOK OPNAME'].includes(r.supplier) && r.qty > 0 && r.purchase_date >= from)
    .sort((a, b) => b.purchase_date.localeCompare(a.purchase_date) || b.id - a.id);
  let left = Math.max(0, p.stock), worst = null;
  for (const r of rows) { if (left <= 0) break; left -= Math.min(r.qty, left); if (r.exp_date) { const d = Math.round(day(r.exp_date) - day(T)); worst = worst === null ? d : Math.min(worst, d); } }
  return worst;
}

test('group by category: one section per category with items, units and value subtotals (cost for the owner only)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openList(page);
  await page.selectOption('#gd-group', 'category');
  const db = await getDb(page);
  const act = db.products.filter(p => p.active !== false);
  const cats = [...new Set(act.map(p => p.category || ''))];
  await expect(page.locator('#gd-table tbody[data-group]')).toHaveCount(cats.length);
  const kurma = act.filter(p => p.category === 'Kurma');
  const g = group(page, 'Kurma');
  await expect(g.locator('tr[data-pid]')).toHaveCount(kurma.length);
  await expect(g.locator('[data-sub="items"]')).toHaveText(`${kurma.length} barang`);
  await expect(g.locator('[data-sub="retail"]')).toContainText(rp(kurma.reduce((a, p) => a + Math.max(0, p.stock) * p.retail_price, 0)));
  await expect(g.locator('[data-sub="cost"]')).toContainText(rp(kurma.reduce((a, p) => a + Math.max(0, p.stock) * p.cost_price, 0)));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-gudang-groups.png') });
});

test('group by packaging, supplier, expiry band and ABC; the manager sees no cost subtotal', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await openList(page);
  const db = await getDb(page);
  const P = re => productByName(db, re);
  // packaging
  await page.selectOption('#gd-group', 'pack');
  for (const re of [/Kurma Rabia Curah/, /Kacang Mete Curah/]) await expect(group(page, 'bulk').locator(`tr[data-pid="${P(re).id}"]`)).toHaveCount(1);
  for (const re of [/Rabia Kemas 500/, /Rabia Kemas 250/, /Kacang Mete Arab/]) await expect(group(page, 'pack').locator(`tr[data-pid="${P(re).id}"]`)).toHaveCount(1);
  await expect(group(page, 'orig').locator(`tr[data-pid="${P(/Kurma Ajwa/).id}"]`)).toHaveCount(1);
  await expect(page.locator('[data-sub="cost"]')).toHaveCount(0);
  // supplier ("Pemasok utama" of the product)
  await page.selectOption('#gd-group', 'supplier');
  await expect(group(page, 'pt kurma nusantara').locator(`tr[data-pid="${P(/Kurma Rabia Curah/).id}"]`)).toHaveCount(1);
  await expect(group(page, 'grosir kramat jati').locator(`tr[data-pid="${P(/Kacang Mete Curah/).id}"]`)).toHaveCount(1);
  // expiry band: the short-dated chocolate batch (5 days) is in "≤ 7 hari"
  await page.selectOption('#gd-group', 'expiry');
  const cok = P(/Cokelat Arab Kerang/), wd = worstDays(db, cok), band = wd < 0 ? 'lewat' : 'le7';
  await expect(group(page, band).locator(`tr[data-pid="${cok.id}"]`)).toHaveCount(1);
  await expect(group(page, band).locator('tr.gd-grp')).toContainText(band === 'lewat' ? 'Sudah lewat' : '≤ 7 hari');
  // ABC: A = top 80 % of the sales value of the last 30 days
  await page.selectOption('#gd-group', 'abc');
  const from = jktToday(-29), T = jktToday(), voided = new Set(db.sales.filter(s => s.status === 'void').map(s => s.invoice_no));
  const val = {};
  db.items.filter(i => i.sale_date >= from && i.sale_date <= T && !voided.has(i.invoice_no)).forEach(i => { val[i.product_id] = (val[i.product_id] || 0) + i.line_total; });
  const ranked = Object.entries(val).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((a, e) => a + e[1], 0);
  let cum = 0; const cls = {};
  ranked.forEach(([id, v]) => { const before = cum / total * 100; cls[id] = before < 80 ? 'A' : before < 95 ? 'B' : 'C'; cum += v; });
  const active = db.products.filter(p => p.active !== false);
  for (const k of ['A', 'B', 'C']) await expect(group(page, k).locator('tr[data-pid]')).toHaveCount(active.filter(p => cls[p.id] === k).length);
  await expect(group(page, 'none').locator('tr[data-pid]')).toHaveCount(active.filter(p => !cls[p.id]).length);
  await expect(group(page, 'A').locator(`tr[data-pid="${ranked[0][0]}"]`)).toHaveCount(1);
  // the choice is remembered on this device
  await page.reload();
  await openList(page);
  await expect(page.locator('#gd-group')).toHaveValue('abc');
});
