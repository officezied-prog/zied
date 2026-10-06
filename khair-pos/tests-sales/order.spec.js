// Pesanan: shop defaults to the last check-in, items from the catalog, prices from the product table (server-side).
const H = require('./helpers'); const { test, expect } = H;

test('field order: shop from the check-in, eceran/grosir by quantity, server recomputes prices, my orders list', async ({ page, context }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const shop = db0.shops.find(s => !s.customer_id && s.status === 'prospek') || db0.shops[5];
  await H.setPos(context, shop.lat, shop.lng, 10);
  await H.startDay(page);
  await H.tab(page, 'visit');
  await page.locator(`#ci-near [data-id="${shop.shop_id}"]`).click();
  await page.click('#oc-order');
  await page.click('#ci-ok');
  await expect(page.locator('#po-shop')).toContainText(shop.name);
  // add two products; Ajwa reaches wholesale at 5
  const ajwa = db0.products.find(p => /Ajwa/.test(p.name)), suk = db0.products.find(p => /Sukkari/.test(p.name));
  await page.fill('#po-q', 'ajwa'); await page.locator('#po-sug [data-act="po-add"]').first().click();
  await page.fill('#po-q', 'sukkari'); await page.locator('#po-sug [data-act="po-add"]').first().click();
  const l0 = page.locator('#po-lines .oline').first();
  await expect(l0.locator('[data-ref="pt"]')).toHaveText('Eceran');
  await l0.locator('[data-po-qty]').fill('5'); await l0.locator('[data-po-qty]').press('Enter');
  await expect(page.locator('#po-lines .oline').first().locator('[data-ref="pt"]')).toHaveText('Grosir');
  await expect(page.locator('#po-lines .oline').first().locator('[data-ref="up"]')).toHaveText(H.rp(ajwa.wholesale_price));
  await expect(page.locator('#po-total')).toHaveText(H.rp(5 * ajwa.wholesale_price + suk.retail_price));
  expect(await page.locator('#po-lines input[data-ref="up"], #po-lines [contenteditable]').count()).toBe(0); // price not editable
  await page.fill('#po-notes', 'Antar sebelum Jumat');
  await H.shot(page, 'phone-14-order');
  await page.click('#po-ok');
  await expect(page.locator('#order-done')).toBeVisible();
  await expect(page.locator('#od-total')).toHaveText(H.rp(5 * ajwa.wholesale_price + suk.retail_price));
  await H.shot(page, 'phone-15-order-sent');
  await H.closeModals(page);
  let db = await H.getDb(page);
  const o = db.field_orders[db.field_orders.length - 1];
  const visit = db.visits[db.visits.length - 1];
  expect(o).toMatchObject({ shop_id: shop.shop_id, visit_id: visit.visit_id, status: 'baru', notes: 'Antar sebelum Jumat', total: 5 * ajwa.wholesale_price + suk.retail_price });
  expect(JSON.parse(o.items).map(i => [i.product_id, i.qty, i.unit_price, i.price_type])).toEqual([[ajwa.id, 5, ajwa.wholesale_price, 'grosir'], [suk.id, 1, suk.retail_price, 'eceran']]);
  await expect(page.locator(`#po-list [data-order="${o.order_id}"] [data-status="baru"]`)).toBeVisible();

  // a tampered request (lower price, wrong type) is recomputed by the server
  const r = await page.evaluate(async ([sid, pid]) => (await api('field_order', { client_id: 'tamper-1', shop_id: sid, items: [{ product_id: pid, qty: 1, unit_price: 1000, price_type: 'grosir' }] })).order, [shop.shop_id, ajwa.id]);
  expect(JSON.parse(r.items)[0]).toMatchObject({ unit_price: ajwa.retail_price, price_type: 'eceran' });
  expect(r.total).toBe(ajwa.retail_price);
  // idempotent resend
  const again = await page.evaluate(async sid => (await api('field_order', { client_id: 'tamper-1', shop_id: sid, items: [{ product_id: 2, qty: 9 }] })), shop.shop_id);
  expect(again.duplicate).toBe(true);

  // the owner moves it to "diproses" → the rep sees the status after a refresh
  await H.setDb(page, `const o = db.field_orders.find(x => x.order_id === '${o.order_id}'); o.status = 'diproses';`);
  await page.click('#tb-menu'); await page.click('[data-act="refresh"]');
  await H.tab(page, 'order');
  await expect(page.locator(`#po-list [data-order="${o.order_id}"] [data-status="diproses"]`)).toBeVisible();
  // seeded history shows mixed statuses
  expect(await page.locator('#po-list [data-status="dikirim"]').count()).toBeGreaterThan(0);
});
