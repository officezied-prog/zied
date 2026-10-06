// v16 Members: settings (limit + tiers), Member section (counts, tier per member), add with UU PDP consent, e-mail check,
// member discount applied by the POS (purchase number = visits + 1), remove membership (owner / manager only).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, getDb, nav, asUser, addBySearch, checkoutSkip, closeModals } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => (n < 0 ? '-Rp ' : 'Rp ') + NF.format(Math.abs(Math.round(n)));
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const tierPct = (tiers, visits) => tiers.reduce((a, t) => t.from <= visits + 1 && t.pct > a ? t.pct : a, 0);

test('settings: discount limit and member tiers; Member section counts, add with consent, member badge, remove', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await expect(page.locator('#st-maxdisc')).toHaveValue('3');
  await expect(page.locator('#st-tiers .st-tier')).toHaveCount(3);
  await page.fill('#st-maxdisc', '5');
  await page.click('#st-tier-add');
  await page.locator('#st-tiers .st-tier').last().locator('[data-tier-from]').fill('20');
  await page.locator('#st-tiers .st-tier').last().locator('[data-tier-pct]').fill('80');
  await page.click('[data-act="set-save-disc"]');
  await expect(page.locator('#st-disc-err')).toContainText('50%');
  await page.locator('#st-tiers .st-tier').last().locator('[data-tier-pct]').fill('7,5');
  await page.click('[data-act="set-save-disc"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  let db = await getDb(page);
  expect(db.settings.max_discount_pct).toBe(5);
  expect(db.settings.member_tiers).toEqual([{ from: 2, pct: 2 }, { from: 5, pct: 3 }, { from: 10, pct: 5 }, { from: 20, pct: 7.5 }]);
  expect(db.settings.member_enabled).toBe(true);

  // Member section
  await nav(page, 'members');
  const members = db.customers.filter(c => c.member === true), from30 = addDays(jktToday(), -29);
  await expect(page.locator('#mb-total')).toHaveText(String(members.length));
  await expect(page.locator('#mb-active')).toHaveText(String(members.filter(c => c.last_visit >= from30).length));
  const ummu = members.find(c => c.name === 'Ummu Khadijah');
  const row = page.locator(`#mb-table tr[data-cid="${ummu.id}"]`);
  await expect(row.locator('[data-mno]')).toHaveText(ummu.member_no);
  await expect(row.locator('[data-visits]')).toHaveText(String(ummu.visits));
  await expect(row.locator('[data-tier] b')).toHaveText(tierPct(db.settings.member_tiers, ummu.visits).toFixed(1).replace('.', ',') + '%');
  await page.fill('#mb-q', 'dewi');
  await expect(page.locator('#mb-table tbody tr')).toHaveCount(1);
  await page.fill('#mb-q', '');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-members.png') });

  // add: consent is required, e-mail is checked
  await page.click('#mb-add');
  await page.selectOption('#mb-pick', { label: 'Ibu Fatimah · 0812-4444-5566' });
  await page.fill('#mb-email', 'fatimah@');
  await page.click('#mb-save');
  await expect(page.locator('#mb-err')).toContainText('persetujuan');
  await page.check('#mb-consent');
  await page.click('#mb-save');
  await expect(page.locator('#mb-err')).toContainText('e-mail');
  await page.fill('#mb-email', 'Fatimah.Balekambang@Gmail.com');
  await page.click('#mb-save');
  await expect(page.locator('#mb-modal')).toHaveCount(0);
  db = await getDb(page);
  const fat = db.customers.find(c => c.name === 'Ibu Fatimah');
  expect(fat).toMatchObject({ member: true, email: 'fatimah.balekambang@gmail.com', member_since: jktToday(), visits: 0 });
  expect(fat.member_no).toMatch(/^M[A-Z0-9]{6}$/);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'member_baru', ref: fat.member_no });
  await expect(page.locator('#mb-total')).toHaveText(String(members.length + 1));
  // server rules: bad e-mail refused; a kasir may register but not remove a member
  expect(await asUser(page, 'Pemilik', '1234', 'save_customer', { id: fat.id, email: 'x@y' })).toMatchObject({ error: 'INVALID' });
  expect(await asUser(page, 'Siti', '1111', 'save_customer', { id: fat.id, member: false })).toMatchObject({ error: 'FORBIDDEN' });
  // badge in the customer list
  await nav(page, 'customers');
  await expect(page.locator('[data-act="cust-open"]').filter({ hasText: 'Ibu Fatimah' }).locator('.mem-badge')).toBeVisible();
  // remove membership (owner)
  await nav(page, 'members');
  await page.locator(`#mb-table tr[data-cid="${fat.id}"] [data-act="mb-remove"]`).click();
  await page.click('#cf-ok');
  await expect(page.locator(`#mb-table tr[data-cid="${fat.id}"]`)).toHaveCount(0);
  db = await getDb(page);
  expect(db.customers.find(c => c.id === fat.id).member).toBe(false);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'member_berhenti', level: 'warn' });
  await nav(page, 'activity');
  await expect(page.locator('#act-list .act-row[data-kind="member_baru"]').first()).toContainText('Member baru');
  await expect(page.locator('#act-list .act-row[data-kind="member_berhenti"]').first()).toContainText('Member dihapus');
  await nav(page, 'members');
  // phone + Arabic
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tb-lang');
  await expect(page.locator('#view-members h1')).toHaveText('الأعضاء');
  await page.screenshot({ path: path.join(SHOTS, 'phone-members-ar.png') });
});

test('POS: a member gets the tier discount automatically; the sale counts a visit; a void takes it back', async ({ page }) => {
  await login(page);
  let db = await getDb(page);
  const ummu = db.customers.find(c => c.name === 'Ummu Khadijah'), p = db.products.find(x => /Kurma Ajwa/.test(x.name));
  await addBySearch(page, 'ajwa');
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ummu Khadijah' }).click();
  const pctNow = tierPct([{ from: 2, pct: 2 }, { from: 5, pct: 3 }, { from: 10, pct: 5 }], ummu.visits);
  const md = Math.round(p.retail_price * pctNow / 100);
  await expect(page.locator('#cart-mem')).toBeVisible();
  await expect(page.locator('#cart-mem')).toContainText(`Diskon member ${pctNow}% · pembelian ke-${ummu.visits + 1}`);
  await expect(page.locator('#cart-total')).toHaveText(rp(p.retail_price - md));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-pos-member.png') });
  await checkoutSkip(page);
  db = await getDb(page);
  const sale = db.sales.slice(-1)[0];
  expect(sale).toMatchObject({ customer_id: ummu.id, discount: md, total: p.retail_price - md });
  expect(sale.notes).toContain(`[member ${pctNow}% · pembelian ke-${ummu.visits + 1}]`);
  expect(db.customers.find(c => c.id === ummu.id)).toMatchObject({ visits: ummu.visits + 1, last_visit: jktToday() });
  await closeModals(page);
  await asUser(page, 'Pemilik', '1234', 'void_sale', { invoice_no: sale.invoice_no, reason: 'uji member' });
  db = await getDb(page);
  expect(db.customers.find(c => c.id === ummu.id).visits).toBe(ummu.visits);
});
