// v3: protected changes (void requests, price changes), expenses, annual report.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { rp, pct, SHOTS, jktToday, login, getDb, productByName, nav, addBySearch, checkoutSkip, closeModals } = require('./helpers');

const copyDb = async (from, to) => { const raw = await from.evaluate(() => localStorage.getItem('kmock.db')); await to.evaluate(r => localStorage.setItem('kmock.db', r), raw); };
const ctxOpts = { viewport: { width: 1366, height: 768 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] };

test('manager requests a void → cannot decide it (owner only) → owner approves → sale void, re-make offered', async ({ page, browser }) => {
  await login(page, 'Jihan', '2222');
  const p = productByName(await getDb(page), /Kacang Almond/);
  await addBySearch(page, 'almond');
  await checkoutSkip(page);
  const inv = (await page.locator('.modal #receipt').innerText()).match(/KM\d{6}-\d{4}/)[0];
  await closeModals(page);
  await nav(page, 'history');
  await page.click('[data-act="hist-load"]');
  await page.locator(`[data-act="hist-open"][data-inv="${inv}"]`).first().click();
  await expect(page.locator('[data-act="void-sale"]')).toHaveCount(0);
  await page.click('[data-act="void-request"]');
  await page.fill('#cf-in', 'Pembeli batal, barang dikembalikan');
  await page.click('#cf-ok');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Permintaan pembatalan' })).toContainText('Permintaan pembatalan APR-');
  let db = await getDb(page);
  const ap = db.approvals.slice(-1)[0];
  expect(ap).toMatchObject({ kind: 'void', ref: inv, approver_role: 'owner', status: 'pending', cashier: 'Jihan' });
  expect(db.sales.find(s => s.invoice_no === inv).status).toBe('ok');

  // the manager sees it in the inbox but cannot decide
  await closeModals(page);
  await nav(page, 'approvals');
  await page.click('[data-act="apr-refresh"]');
  const mcard = page.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(mcard.locator('[data-owner-only]')).toHaveText(/Hanya pemilik/);
  await expect(mcard.locator('[data-d="approved"]')).toBeDisabled();
  const code = await page.evaluate(async id => { try { await api('decide_approval', { request_id: id, decision: 'approved', invoice_no: 'x' }); return 'ok'; } catch (e) { return e.code; } }, ap.request_id);
  expect(code).toBe('NEEDS_OWNER');

  // owner approves on another device → sale void, stock restored, re-make loads the cart
  const octx = await browser.newContext(ctxOpts);
  const owner = await octx.newPage();
  await login(owner);
  await copyDb(page, owner);
  await nav(owner, 'approvals');
  await owner.click('[data-act="apr-refresh"]');
  const card = owner.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card).toContainText(inv);
  await expect(card).toContainText('Pembeli batal');
  await card.locator('[data-d="approved"]').click();
  await expect(owner.locator('.modal')).toContainText('Buat ulang transaksi');
  db = await getDb(owner);
  expect(db.sales.find(s => s.invoice_no === inv).status).toBe('void');
  expect(productByName(db, /Kacang Almond/).stock).toBe(p.stock);
  await owner.click('#cf-ok');
  await expect(owner.locator('#view-pos')).toBeVisible();
  await expect(owner.locator('.cline')).toHaveCount(1);
  await expect(owner.locator('.cline')).toContainText('Kacang Almond');
  await octx.close();
});

test('manager changes the wholesale price directly; a cost change waits for the owner', async ({ page, browser }) => {
  await login(page, 'Jihan', '2222');
  const p = productByName(await getDb(page), /Ajwa/);
  await nav(page, 'products');
  await page.fill('#pr-q', 'ajwa');
  await expect(page.locator('#prod-table tbody tr')).toHaveCount(1);
  await page.click('#prod-table [data-act="price-change"]');
  await page.fill('#pc-whole', '158.000');
  await page.fill('#pc-reason', 'Harga grosir disesuaikan');
  await page.click('#pc-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Harga' })).toHaveText('Harga diubah');
  let db = await getDb(page);
  expect(productByName(db, /Ajwa/)).toMatchObject({ wholesale_price: 158000, retail_price: p.retail_price, cost_price: p.cost_price });
  expect(db.approvals.slice(-1)[0]).toMatchObject({ kind: 'price', status: 'auto', decided_by: 'Jihan', ref: p.id });
  await expect(page.locator('#prod-table')).toContainText(rp(158000));

  // cost change → pending (owner only)
  await page.click('#prod-table [data-act="price-change"]');
  await expect(page.locator('#pc-cost')).toHaveValue('');
  await page.fill('#pc-cost', '140.000');
  await page.fill('#pc-reason', 'Supplier naik harga');
  await page.click('#pc-save');
  await expect(page.locator('#pc-pending')).toContainText('Menunggu persetujuan');
  db = await getDb(page);
  expect(productByName(db, /Ajwa/).cost_price).toBe(p.cost_price);
  const ap = db.approvals.slice(-1)[0];
  expect(ap).toMatchObject({ kind: 'price', status: 'pending', approver_role: 'owner' });

  const octx = await browser.newContext(ctxOpts);
  const owner = await octx.newPage();
  await login(owner);
  await copyDb(page, owner);
  await nav(owner, 'approvals');
  await owner.click('[data-act="apr-refresh"]');
  const card = owner.locator(`.apr-card[data-req="${ap.request_id}"]`);
  await expect(card.locator('[data-price-changes]')).toContainText(rp(p.cost_price));
  await expect(card.locator('[data-price-changes]')).toContainText(rp(140000));
  await owner.screenshot({ path: path.join(SHOTS, 'desktop-approvals-price.png') });
  await card.locator('[data-d="approved"]').click();
  await expect(owner.locator('.toast.ok')).toContainText(ap.request_id);
  expect(productByName(await getDb(owner), /Ajwa/).cost_price).toBe(140000);
  expect(await owner.evaluate(id => KPOS.S.products.find(x => x.id === id).cost_price, p.id)).toBe(140000);
  await octx.close();
});

test('manager saves an expense; it appears in the month list', async ({ page }) => {
  await login(page, 'Jihan', '2222');
  await nav(page, 'expenses');
  await page.selectOption('#ex-cat', 'transport');
  await page.fill('#ex-amt', '250.000');
  await page.fill('#ex-note', 'Ongkir ambil kurma');
  await page.click('#ex-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Pengeluaran' })).toContainText(rp(250000));
  const db = await getDb(page);
  expect(db.expenses.slice(-1)[0]).toMatchObject({ category: 'transport', amount: 250000, note: 'Ongkir ambil kurma', user: 'Jihan', expense_date: jktToday(), paid_from: 'lain' }); // v15: no drawer for the manager
  const month = db.expenses.filter(x => x.expense_date.slice(0, 7) === jktToday().slice(0, 7));
  await expect(page.locator('[data-kpi="ex-total"] .v')).toHaveText(rp(month.reduce((a, x) => a + x.amount, 0)));
  await expect(page.locator('#ex-table tbody tr').first()).toContainText('Ongkir ambil kurma');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-expenses.png') });
});

test('annual report (owner): monthly table, P&L, products by profit, copy text', async ({ page }) => {
  await login(page);
  await nav(page, 'reports');
  await page.click('[data-act="rp-mode"][data-m="year"]');
  const Y = jktToday().slice(0, 4), m = +jktToday().slice(5, 7);
  await expect(page.locator('#yr-months tbody tr')).toHaveCount(12);
  const db = await getDb(page);
  const agg = (year, month) => {
    const pre = `${year}-${String(month).padStart(2, '0')}`;
    const ok = db.sales.filter(s => s.status !== 'void' && s.sale_date.startsWith(pre));
    const omzet = ok.reduce((a, s) => a + s.total, 0), hpp = ok.reduce((a, s) => a + s.total_cost, 0), laba = ok.reduce((a, s) => a + s.profit, 0);
    const exp = db.expenses.filter(x => x.expense_date.startsWith(pre)).reduce((a, x) => a + x.amount, 0);
    return { omzet, hpp, laba, exp, net: laba - exp };
  };
  const cur = agg(Y, m), prevM = agg(Y, m - 1), lastY = agg(+Y - 1, m);
  const row = page.locator(`#yr-months tr[data-m="${m}"]`);
  await expect(row.locator('[data-c="omzet"]')).toHaveText(rp(cur.omzet));
  await expect(row.locator('[data-c="hpp"]')).toHaveText(rp(cur.hpp));
  await expect(row.locator('[data-c="laba"]')).toHaveText(rp(cur.laba));
  await expect(row.locator('[data-c="exp"]')).toHaveText(rp(cur.exp));
  await expect(row.locator('[data-c="net"]')).toHaveText(rp(cur.net));
  await expect(row.locator('[data-c="margin"]')).toHaveText(pct(cur.laba / cur.omzet * 100));
  const delta = (a, b) => (a - b) / Math.abs(b) * 100;
  const fd = p => (p > 0 ? '+' : '') + pct(p);
  await expect(row.locator('[data-c="dprev"]')).toHaveText(fd(delta(cur.omzet, prevM.omzet)));
  expect(lastY.omzet).toBeGreaterThan(0);
  await expect(row.locator('[data-c="dyoy"]')).toHaveText(fd(delta(cur.omzet, lastY.omzet)));
  let tot = { omzet: 0, net: 0, exp: 0 };
  for (let k = 1; k <= 12; k++) { const a = agg(Y, k); tot.omzet += a.omzet; tot.net += a.net; tot.exp += a.exp; }
  await expect(page.locator('#yr-months tfoot [data-c="omzet"]')).toHaveText(rp(tot.omzet));
  await expect(page.locator('[data-kpi="y-net"] .v')).toHaveText(rp(tot.net));
  await expect(page.locator('#yr-pl')).toContainText(rp(tot.exp));
  // products by profit
  const okInv = new Set(db.sales.filter(s => s.status !== 'void' && s.sale_date.startsWith(Y)).map(s => s.invoice_no));
  const byP = {};
  db.items.filter(i => okInv.has(i.invoice_no)).forEach(i => { byP[i.name] = (byP[i.name] || 0) + i.line_profit; });
  const top = Object.entries(byP).sort((a, b) => b[1] - a[1])[0];
  await expect(page.locator('#yr-products tbody tr').first()).toContainText(top[0]);
  await expect(page.locator('#yr-products tbody tr').first()).toContainText(rp(top[1]));
  await expect(page.locator('#yr-exp .bar-row').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-annual.png') });
  await page.click('[data-act="yr-copy"]');
  await expect(page.locator('.toast.ok')).toHaveText('Tersalin');
  const txt = await page.evaluate(() => navigator.clipboard.readText());
  expect(txt).toContain(`*Laporan Tahunan ${Y}`);
  expect(txt).toContain('Laba bersih');
});
