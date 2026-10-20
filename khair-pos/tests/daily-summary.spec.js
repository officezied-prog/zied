// v65 (owner 2026-10-20: «هل هناك ملخص يومي للبيع؟ يجب أن يكون هناك ملخص يومي بالفواتير وكل فاتورة فيها كل المعطيات وتخزن دائمًا في التطبيق،
// وملخص للبيع اليومي لكل البضائع»): Laporan → Harian shows, under the day's numbers, EVERY invoice of the day (each opens with all its
// lines, discount, how it was paid, the debt, who and when) and EVERY product sold that day; "Cetak / PDF" and the two CSV files. The
// manager and the accountant see it too.
const { test, expect } = require('@playwright/test');
const { jktToday, login, getDb, nav, openApp, enterKey, staffSession, editDb } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => 'Rp ' + NF.format(Math.round(n));

async function openDaily(page, day) {
  await nav(page, 'reports');
  if (await page.locator('#rp-daily-btn').isVisible().catch(() => false)) await page.click('#rp-daily-btn');
  else await page.click('[data-act="rp-mode"][data-m="daily"]');
  await expect(page.locator('#dr-body')).toBeVisible();
  await page.fill('#dr-date', day);
  await page.locator('#dr-date').dispatchEvent('change');
}

test('every invoice of the day with all its lines, every product sold; print and CSV (manager)', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const day = jktToday(-1), db = await getDb(page);
  const sales = db.sales.filter(s => s.sale_date === day), ok = sales.filter(s => s.status !== 'void');
  expect(ok.length).toBeGreaterThan(3);
  await openDaily(page, day);
  const inv = page.locator('#dr-invoices');
  await expect(inv).toContainText(`(${ok.length})`);
  await expect(inv.locator('[data-ds-inv]')).toHaveCount(sales.length);
  // one invoice opens with every line
  const s0 = ok[0], lines = db.items.filter(i => i.invoice_no === s0.invoice_no);
  const row = inv.locator(`[data-ds-inv="${s0.invoice_no}"]`);
  await row.locator('summary').click();
  for (const l of lines) await expect(row).toContainText(l.name);
  await expect(row).toContainText(rp(s0.total + (s0.send_fee || 0)));
  // every product of the day, the total = the lines of the valid invoices
  const okInv = new Set(ok.map(s => s.invoice_no)), its = db.items.filter(i => okInv.has(i.invoice_no));
  const names = [...new Set(its.map(i => String(i.product_id)))];
  await expect(page.locator('#dr-products [data-ds-prod]')).toHaveCount(names.length);
  await expect(page.locator('#dr-products [data-ds-total]')).toHaveText(rp(its.reduce((a, i) => a + i.line_total, 0)));
  await expect(page.locator('#dr-invoices')).toContainText('tersimpan permanen');
  // print / PDF: the whole day goes to the print area
  await page.evaluate(() => { window.print = () => { window.__printed = document.querySelector('#print-area').innerText; }; });
  await page.click('#dr-print');
  await expect.poll(() => page.evaluate(() => window.__printed || '')).toContain(s0.invoice_no);
  expect(await page.evaluate(() => window.__printed)).toContain(lines[0].name);
  // CSV: one row per invoice line; one row per product
  const [d1] = await Promise.all([page.waitForEvent('download'), page.click('#dr-csv-inv')]);
  expect(d1.suggestedFilename()).toBe(`nota-${day}.csv`);
  const csv1 = require('fs').readFileSync(await d1.path(), 'utf8').trim().split(/\r?\n/);
  expect(csv1[0]).toContain('nota;status;kasir');
  expect(csv1.length - 1).toBe(db.items.filter(i => sales.some(s => s.invoice_no === i.invoice_no)).length);
  const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#dr-csv-prod')]);
  expect(d2.suggestedFilename()).toBe(`barang-${day}.csv`);
  expect(require('fs').readFileSync(await d2.path(), 'utf8').trim().split(/\r?\n/).length - 1).toBe(names.length);
});

test('the accountant opens the daily summary too; Arabic', async ({ page }) => {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `if (!db.users.some(u => u.name === 'Lestari')) db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  const day = jktToday(-1);
  await openDaily(page, day);
  await expect(page.locator('#dr-invoices [data-ds-inv]').first()).toBeVisible();
  await expect(page.locator('#dr-products [data-ds-prod]').first()).toBeVisible();
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#dr-invoices')).toContainText('كل فواتير اليوم');
  await expect(page.locator('#dr-products')).toContainText('المبيعات حسب الصنف');
});
