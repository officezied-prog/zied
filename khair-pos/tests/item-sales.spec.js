// v55 Gudang → "Penjualan barang" (owner 2026-10-15: «أضع التمر عجوة تخرج لي كل المبيعات التمر العجوة على المدة المرجوة … إمكانية البحث حسب
// النوع أو حسب الكمية أو حسب التعبية لكل الأصناف»): the sales of each product over a period, by name, category and packaging, sorted by
// quantity, every sale line of one product. Expected numbers are recomputed from the mock DB.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { rp, SHOTS, jktToday, login, getDb, nav, editDb, switchUser } = require('./helpers');

const NFQ = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r3 = q => Math.round(q * 1000) / 1000;

/** Sold lines of the products matching `ok`, between from and to, void sales left out. */
function soldLines(db, ok, from, to) {
  const voided = new Set(db.sales.filter(s => s.status === 'void').map(s => s.invoice_no));
  return db.items.filter(i => !voided.has(i.invoice_no) && i.sale_date >= from && i.sale_date <= to && ok(db.products.find(p => p.id === i.product_id)));
}
async function openSold(page) {
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="sold"]');
  await expect(page.locator('#gs-table')).toBeVisible();
}

test('Kurma Ajwa over 30 days: its total, every sale line (newest first), the manager sees it too; a void sale drops out', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openSold(page);
  await expect(page.locator('[data-act="gs-preset"][data-p="30d"]')).toHaveClass(/on/);
  const T = jktToday(), from = addDays(T, -29);
  let db = await getDb(page);
  const ajwa = db.products.find(p => /Ajwa/.test(p.name));
  let lines = soldLines(db, p => p && p.id === ajwa.id, from, T);
  expect(lines.length).toBeGreaterThan(1);
  await page.fill('#gs-q', 'kurma ajwa');
  const row = page.locator('#gs-table tr[data-act="gs-open"]');
  await expect(row).toHaveCount(1); // one product found → its sale lines open by themselves
  await expect(row).toHaveAttribute('data-pid', String(ajwa.id));
  await expect(row.locator('[data-col="sold"]')).toContainText(NFQ.format(r3(lines.reduce((a, i) => a + i.qty, 0))));
  await expect(row.locator('[data-col="omzet"]')).toHaveText(rp(lines.reduce((a, i) => a + i.line_total, 0)));
  await expect(row.locator('[data-col="inv"]')).toHaveText(String(new Set(lines.map(i => i.invoice_no)).size));
  const shown = page.locator(`[data-lines-table="p${ajwa.id}"] tbody tr`);
  await expect(shown).toHaveCount(lines.length);
  const newest = lines.slice().sort((a, b) => b.sale_date.localeCompare(a.sale_date))[0];
  const firstInv = await shown.first().getAttribute('data-line');
  expect(lines.find(i => i.invoice_no === firstInv).sale_date).toBe(newest.sale_date);
  await expect(page.locator('#gs-sum [data-kpi="gs-profit"]')).toBeVisible(); // the owner sees the profit
  await page.screenshot({ path: path.join(SHOTS, 'gudang-item-sales.png'), fullPage: false });
  // tapping the row closes / opens its lines… (one product: always open) — a broader search lists several
  await page.fill('#gs-q', 'kurma');
  await expect.poll(() => row.count()).toBeGreaterThan(1);
  await expect(page.locator('.gs-lines')).toHaveCount(0);
  await page.click(`#gs-table tr[data-pid="${ajwa.id}"]`);
  await expect(page.locator(`[data-lines="p${ajwa.id}"]`)).toBeVisible();
  // a void sale is not counted
  const gone = lines[0];
  await editDb(page, 'db.sales.find(s => s.invoice_no === arg).status = "void";', gone.invoice_no);
  await page.click('[data-act="gd-refresh"]');
  await page.fill('#gs-q', 'kurma ajwa');
  await expect(row).toHaveCount(1);
  db = await getDb(page);
  lines = soldLines(db, p => p && p.id === ajwa.id, from, T);
  await expect(row.locator('[data-col="sold"]')).toContainText(NFQ.format(r3(lines.reduce((a, i) => a + i.qty, 0))));
  await expect(page.locator(`[data-lines-table="p${ajwa.id}"] tr[data-line="${gone.invoice_no}"]`)).toHaveCount(0);
  // the manager has the same tab, without the profit (purchase prices stay the owner's)
  await switchUser(page, 'Jihan', '2222');
  await openSold(page);
  await page.fill('#gs-q', 'kurma ajwa');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-col="sold"]')).toContainText(NFQ.format(r3(lines.reduce((a, i) => a + i.qty, 0))));
  await expect(page.locator('#gs-sum [data-kpi="gs-profit"]')).toHaveCount(0);
});

test('by category, packaging and unit; sorted by quantity; unsold goods on request; today only; a period of over a year is cut to one', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openSold(page);
  const T = jktToday(), from = addDays(T, -29), db = await getDb(page);
  const qtyOf = rows => rows.reduce((a, i) => a + i.qty, 0);
  const ids = async () => page.locator('#gs-table tr[data-act="gs-open"]').evaluateAll(trs => trs.map(tr => Number(tr.dataset.pid)));
  const solds = async () => page.locator('#gs-table tr[data-act="gs-open"] [data-col="sold"] b').allTextContents();
  // category: only Kismis, the most sold first
  await page.selectOption('#gs-cat', 'Kismis');
  const kis = db.products.filter(p => p.category === 'Kismis').map(p => p.id);
  const kisSold = kis.map(id => ({ id, q: r3(qtyOf(soldLines(db, p => p && p.id === id, from, T))) })).filter(x => x.q > 0).sort((a, b) => b.q - a.q);
  await expect.poll(ids).toEqual(kisSold.map(x => x.id));
  // least sold first
  await page.selectOption('#gs-sort', 'qty_asc');
  await expect.poll(ids).toEqual(kisSold.slice().reverse().map(x => x.id));
  // packaging: the store's own packs (repacked)
  await page.selectOption('#gs-cat', '');
  await page.selectOption('#gs-pack', 'pk:pack');
  const packIds = new Set(db.products.filter(p => Number(p.repack_from) > 0).map(p => p.id));
  for (const id of await ids()) expect(packIds.has(id)).toBe(true);
  // unsold goods too: every pack product shows, 0 for those not sold
  await page.check('#gs-zero');
  await expect.poll(async () => (await ids()).length).toBe(db.products.filter(p => packIds.has(p.id) && p.active !== false).length);
  // unit: kg only
  await page.uncheck('#gs-zero');
  await page.selectOption('#gs-pack', 'u:kg');
  for (const id of await ids()) expect(String(db.products.find(p => p.id === id).unit).toLowerCase()).toBe('kg');
  // today only
  await page.selectOption('#gs-pack', '');
  await page.selectOption('#gs-sort', 'qty');
  await page.click('[data-act="gs-preset"][data-p="today"]');
  const todayLines = soldLines(db, p => !!p, T, T);
  await expect(page.locator('#gs-sum [data-kpi="gs-items"] .v')).toHaveText(String(new Set(todayLines.map(i => i.product_id)).size));
  await expect(page.locator('#gs-sum [data-kpi="gs-omzet"] .v')).toHaveText(rp(todayLines.reduce((a, i) => a + i.line_total, 0)));
  expect((await solds()).length).toBe(new Set(todayLines.map(i => i.product_id)).size);
  // chosen dates: years ago → nothing (one get_sales call); from 2020 to today → cut to one year
  await page.click('[data-act="gs-preset"][data-p="custom"]');
  await page.fill('#gs-from', '2020-01-01'); // the end date follows: one year at most
  await expect(page.locator('#gs-to')).toHaveValue('2020-12-31');
  await expect(page.locator('#gs-capped')).toBeVisible();
  await page.fill('#gs-to', '2020-01-31');
  await expect(page.locator('#gs-none')).toBeVisible();
  await expect(page.locator('#gs-capped')).toHaveCount(0);
  await page.fill('#gs-to', T); // from 2020 to today → the start moves to a year back
  await expect(page.locator('#gs-capped')).toBeVisible();
  await expect(page.locator('#gs-from')).toHaveValue(addDays(T, -365));
  await expect(page.locator('#gs-sum [data-kpi="gs-items"] .s')).toContainText('366');
});

test('Arabic: the item sales tab reads in Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.evaluate(() => setLang('ar'));
  await openSold(page);
  await expect(page.locator('#gd-tabs [data-tab="sold"]')).toHaveText('مبيعات الأصناف');
  await expect(page.locator('#gs-hint')).toContainText('تمر عجوة');
  await expect(page.locator('#gs-sort')).toContainText('الأكثر كمية');
  await expect(page.locator('#gs-table thead')).toContainText('المباع');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('on a phone the page fits the screen: product, sold and value, then each line with its time, quantity and amount', async ({ page }) => {
    await login(page, 'Pemilik', '1234', '', { stay: true });
    await openSold(page);
    await page.fill('#gs-q', 'kurma ajwa');
    const row = page.locator('#gs-table tr[data-act="gs-open"]');
    await expect(row).toHaveCount(1);
    const fits = async loc => { const b = await loc.boundingBox(); return b.x >= 0 && b.x + b.width <= 390; };
    for (const col of ['sold', 'omzet']) expect(await fits(row.locator(`[data-col="${col}"]`))).toBe(true);
    const line = page.locator('[data-lines-table] tbody tr').first();
    for (const col of ['qty', 'total']) expect(await fits(line.locator(`[data-col="${col}"]`))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.evaluate(() => document.querySelector('#gs-table').scrollIntoView());
    await page.screenshot({ path: path.join(SHOTS, 'phone-item-sales.png') });
  });
});
