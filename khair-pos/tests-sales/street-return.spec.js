// v36 (owner 2026-10-11: "remind the rep to go back to the best streets; the return time is set with the manager"): the streets
// the rep worked are scored (orders, customers, interest of the shops along them); a good one whose return time has passed is
// listed on Hari ini and in the planner, and goes into today's plan with one tap.
const H = require('./helpers'); const { test, expect } = H;

const ago = n => new Date(Date.now() + 7 * 3600000 - n * 86400000).toISOString().slice(0, 10);
/** A street worked 20 days ago through two customer shops (good, due at 14 days) and one worked 3 days ago (good, not due). */
const SETUP = `
  const cust = db.shops.filter(s => s.status === 'pelanggan' && s.lat != null).slice(0, 4);
  const line = (a, b) => [[[a.lat, a.lng], [b.lat, b.lng]]];
  db.route_plans = db.route_plans || [];
  db.route_plans.push({ plan_id: 'RPBACK1', user: 'Ahmad', plan_date: '${ago(20)}', start: null, end: null, note: '', stops: [], updated_at: '',
    streets: [{ ref: 'st:jalan uji kembali', name: 'Jalan Uji Kembali', lines: line(cust[0], cust[1]) }] });
  db.route_plans.push({ plan_id: 'RPBACK2', user: 'Ahmad', plan_date: '${ago(3)}', start: null, end: null, note: '', stops: [], updated_at: '',
    streets: [{ ref: 'st:jalan baru saja', name: 'Jalan Baru Saja', lines: line(cust[2], cust[3]) }] });
  db.route_plans.push({ plan_id: 'RPBACK3', user: 'Budi', plan_date: '${ago(30)}', start: null, end: null, note: '', stops: [], updated_at: '',
    streets: [{ ref: 'st:jalan budi', name: 'Jalan Budi', lines: line(cust[0], cust[1]) }] });
`;

/** The store key → the demo data is written (shops, orders …) before the test adds its streets. */
async function seeded(page) {
  await H.openSales(page);
  await page.fill('#lg-key', 'demo'); await page.click('[data-act="login-key"]');
  await expect(page.locator('#users [data-act="login-user"][data-name="Ahmad"]')).toBeVisible();
  await expect.poll(async () => ((await H.getDb(page)) || {}).shops?.length || 0).toBeGreaterThan(10);
}

test('Hari ini lists the good streets due again; one tap puts the street in today\'s plan (synced); the planner shows them too', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await seeded(page);
  await H.setDb(page, SETUP);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  const card = page.locator('#sr-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.sr-row')).toHaveCount(1); // his own due street only (not the fresh one, not Budi's)
  const row = card.locator('.sr-row[data-k="st:jalan uji kembali"]');
  await expect(row).toContainText('Jalan Uji Kembali');
  await expect(row).toContainText('lewat 6 hari');
  await expect(row.locator('[data-why]')).toContainText('2 pelanggan');
  await H.shot(page, 'phone-40-street-return');
  await row.locator('[data-act="sr-add"]').click();
  await expect(page.locator('.toast.ok', { hasText: 'Jalan Uji Kembali' })).toBeVisible();
  await expect(page.locator('#sr-card .sr-row[data-k="st:jalan uji kembali"] [data-inplan]')).toBeVisible();
  await expect(page.locator('#pl-card-streets')).toContainText('Jalan Uji Kembali');
  // the plan reached the server (mock) with the street line
  await expect.poll(async () => ((await H.getDb(page)).route_plans || []).filter(p => p.user === 'Ahmad' && p.plan_date === ago(0)).length).toBe(1);
  const plan = (await H.getDb(page)).route_plans.find(p => p.user === 'Ahmad' && p.plan_date === ago(0));
  expect(plan.streets.map(s => s.name)).toEqual(['Jalan Uji Kembali']);
  expect(plan.streets[0].lines[0].length).toBe(2);
  // the planner: the due list with "already in the plan"
  await page.click('#pl-open-today');
  await page.click('#pl-seg-plan');
  await expect(page.locator('#pl-sr .sr-row[data-k="st:jalan uji kembali"] [data-inplan]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Arabic: the "go back" card and its reasons are in Arabic; in the planner the street is added to the plan being made', async ({ page }) => {
  await seeded(page);
  await H.setDb(page, SETUP);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  await expect(page.locator('#sr-card')).toBeVisible();
  await page.click('#tb-menu'); await page.click('#lang-ar'); await H.closeModals(page);
  await expect(page.locator('#sr-card h3')).toContainText('العودة إلى أفضل الشوارع');
  await expect(page.locator('#sr-card [data-why]')).toContainText('عميل');
  await page.click('#pl-open-today');
  await page.click('#pl-seg-plan');
  await page.locator('#pl-sr [data-act="sr-add"]').click();
  await expect(page.locator('#pl-streets .pl-street')).toHaveCount(1);
  await expect(page.locator('#pl-sr [data-inplan]')).toBeVisible();
  await page.click('#pl-save');
  await expect(page.locator('#pl-card-streets')).toContainText('Jalan Uji Kembali');
});
