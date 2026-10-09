// "الكاشير يرى الطلبيات فقط" — the counter cashier SEES field reps' orders, read-only (to prepare/fulfil them).
// Separate backend (khair-field): the kasir role may reach ONLY the read-only cashier_orders action.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

/** A direct call to the field backend with explicit credentials (like chat.spec.js), returning the error code on failure. */
function fieldAs(page, user, pin, action, data = {}) {
  const pin_hash = H.sha(`demo:${user.toLowerCase()}:${pin}`);
  return page.evaluate(async ({ user, pin_hash, action, data }) => {
    try { return await apiRawInner(action, data, { key: 'demo', user, pin_hash }, { field: true }); }
    catch (e) { return { error: e.code, message: e.message }; }
  }, { user, pin_hash, action, data });
}

test('cashier sees field reps\' open orders, read-only; shop + total shown, no cost', async ({ page }) => {
  await H.login(page, 'Siti', '1111');
  // the API answer carries open orders and NO cost anywhere
  const res = await fieldAs(page, 'Siti', '1111', 'cashier_orders');
  expect(res.ok).toBe(true);
  expect(Array.isArray(res.orders)).toBe(true);
  expect(res.orders.length).toBeGreaterThan(0);
  expect(res.orders.every(o => o.status === 'baru' || o.status === 'diproses')).toBe(true); // open only
  expect(JSON.stringify(res.orders)).not.toMatch(/cost_price|total_cost|"profit"|line_profit|"cost"/);
  const first = res.orders[0];

  // the view: Lainnya → Pesanan Lapangan
  await H.tab(page, 'more');
  await page.click('#m-field');
  const modal = page.locator('#field-orders');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.spinner')).toHaveCount(0); // finished loading
  // seeded open orders are listed: shop name + an Rp total are on screen
  await expect(modal.locator('.list .li').first()).toBeVisible();
  const cards = await modal.locator('.list > .li').count();
  expect(cards).toBe(res.orders.length);
  await expect(modal).toContainText(first.shop_name);
  await expect(modal).toContainText(first.user); // the rep's name
  await expect(modal.locator('.num').first()).toContainText('Rp');

  // READ-ONLY: the list body has no controls at all (no update / status / edit / place buttons),
  // only the footer carries Refresh + Close.
  expect(await modal.locator('.modal-b button').count()).toBe(0);
  const footActs = await modal.locator('.modal-f button[data-act]').evaluateAll(els => els.map(e => e.dataset.act));
  expect(footActs).toEqual(['modal-close']);
  expect(await modal.locator('[data-act="order-open"], [data-act="update_order"], [id^="fo-ship"], [id^="fo-process"], [id^="fo-cancel"]').count()).toBe(0);
});

test('the field backend refuses every write action for the kasir (read-only enforced server-side)', async ({ page }) => {
  await H.login(page, 'Siti', '1111');
  // cashier_orders is allowed…
  expect((await fieldAs(page, 'Siti', '1111', 'cashier_orders')).ok).toBe(true);
  // …but placing an order, changing status, listing full field data, and the bootstrap are all forbidden for a kasir
  for (const action of ['field_order', 'update_order', 'list_field', 'field_bootstrap', 'check_in', 'set_product_image']) {
    const r = await fieldAs(page, 'Siti', '1111', action, {});
    expect(r.error, `${action} must be FORBIDDEN for kasir`).toBe('FORBIDDEN');
  }
});
