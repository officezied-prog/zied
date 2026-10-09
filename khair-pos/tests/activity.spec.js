// v12 Activity log for the owner: entries for price changes, goods-in and corrections; unread badge; filters.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, productByName, nav, asUser, CARRIER } = require('./helpers');

test('price change, goods-in and a correction REQUEST by the manager reach the owner: unread badge, Beranda note, feed with filters', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // read everything that is there so far
  await nav(page, 'activity');
  await expect(page.locator('#act-list')).toBeVisible();
  await expect(page.locator('#tb-act-n')).toHaveCount(0);
  await nav(page, 'home');

  const gula = productByName(await getDb(page), /Gula Pasir/);
  const pc = await asUser(page, 'Jihan', '2222', 'change_price', { product_id: gula.id, wholesale_price: gula.wholesale_price + 500, reason: 'Harga pasar naik' });
  expect(pc.applied).toBe(true);
  const ph = await asUser(page, 'Jihan', '2222', 'scan_purchase', { image_base64: 'AAAA', mime: 'image/jpeg' });
  const pu = await asUser(page, 'Jihan', '2222', 'save_purchase', { carrier: CARRIER, supplier: 'Agen Sembako Pasar Induk', photo_id: ph.photo_id, items: [{ product_id: gula.id, qty: 50, cost_price: 15000, photo_index: 1, exp_none: true }], mismatch_reason: 'Kurma dan madu menyusul' });
  const fx = await asUser(page, 'Jihan', '2222', 'request_purchase_fix', { purchase_no: pu.purchase_no, lines: [{ product_id: gula.id, qty: 48 }], reason: '2 pak sobek' });
  expect(fx.applied).toBe(false); // owner monitoring: the manager REQUESTS the correction, the owner approves it
  expect(fx.approver_role).toBe('owner');

  await page.evaluate(() => refreshData(true));
  await expect(page.locator('#tb-act-n')).toHaveText('3');
  await expect(page.locator('#tb-act-n')).toHaveClass(/warn/);
  await page.evaluate(() => refreshAttention());
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-key="act"]')).toContainText('3 catatan penting baru');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-activity-badge.png') });
  await page.locator('.modal-bg [data-act="modal-close"]').first().click();

  await page.click('#tb-act');
  await expect(page.locator('#view-activity')).toBeVisible();
  await expect(page.locator('#tb-act-n')).toHaveCount(0);
  const rows = page.locator('#act-list .act-row');
  await expect(rows.first()).toHaveAttribute('data-kind', 'minta_koreksi');
  await expect(rows.first()).toContainText(`Koreksi barang masuk ${pu.purchase_no}`);
  await expect(rows.first()).toContainText('50→48');
  await expect(rows.first()).toHaveClass(/warn/);
  await expect(rows.first()).toContainText('Jihan');
  await expect(rows.first().locator('.s')).toContainText(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  await expect(rows.nth(1)).toHaveAttribute('data-kind', 'masuk');
  await expect(rows.nth(1)).toContainText(`Barang masuk ${pu.purchase_no} dari Agen Sembako Pasar Induk`);
  await expect(rows.nth(1)).toContainText('tidak_cocok');
  await expect(rows.nth(2)).toHaveAttribute('data-kind', 'harga');
  await expect(rows.nth(2)).toContainText(`wholesale_price ${gula.wholesale_price}→${gula.wholesale_price + 500}`);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-activity.png') });
  // filters: group, user, search
  await page.click('#act-groups [data-g="harga"]');
  await expect(page.locator('#act-list .act-row:not([data-group="harga"])')).toHaveCount(0);
  await expect(page.locator('#act-list .act-row[data-kind="harga"]').first()).toContainText(gula.name);
  await page.click('#act-groups [data-g=""]');
  await page.selectOption('#act-user', 'Jihan');
  const db = await getDb(page);
  const T = db.activity.slice(-1)[0].act_date, from = new Date(Date.parse(T) - 6 * 86400000).toISOString().slice(0, 10);
  await expect(page.locator('#act-list .act-row')).toHaveCount(db.activity.filter(a => a.user === 'Jihan' && a.act_date >= from && a.act_date <= T).length);
  await page.fill('#act-q', pu.purchase_no);
  await expect(page.locator('#act-list .act-row')).toHaveCount(2);
  // range: today only
  await page.fill('#act-q', '');
  await page.selectOption('#act-user', '');
  await page.click('#act-presets [data-p="today"]');
  await expect(page.locator('#act-list .act-row')).toHaveCount(db.activity.filter(a => a.act_date === T).length);
  // the manager does not see the log
  expect((await asUser(page, 'Jihan', '2222', 'list_activity', { from: T, to: T })).error).toBe('FORBIDDEN');
  expect((await asUser(page, 'Jihan', '2222', 'bootstrap')).activity_recent).toEqual([]);
});

test('phone + Arabic: activity feed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.click('#tb-lang');
  await page.click('#tb-act');
  await expect(page.locator('#view-activity h1')).toHaveText('سجل النشاط');
  await expect(page.locator('#act-list .act-row').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'phone-activity-ar.png') });
});
