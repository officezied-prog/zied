// v23 — supplier payments require the owner's approval via a manager-proposed pay plan.
// Flow: manager proposes a LIST → owner authorizes a SUBSET in the inbox → manager records the authorized payment.
const { test, expect } = require('@playwright/test');
const { login, switchUser, nav, getDb, asUser } = require('./helpers');

test('manager proposes a plan, owner authorizes a subset, manager records the authorized payment', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });

  // a manager cannot pay a supplier directly any more
  expect((await asUser(page, 'Jihan', '2222', 'pay_supplier', { supplier: 'PT Kurma Nusantara', amount: 250000, method: 'transfer' })).error).toBe('NEEDS_OWNER');

  // 1. the manager builds a list (two suppliers, most-urgent first) and sends it to the owner
  await nav(page, 'suppliers');
  await page.click('[data-act="sp-propose"]');
  await expect(page.locator('#propose-modal')).toBeVisible();
  const r1 = page.locator('#propose-modal .pp-row').nth(0);
  await r1.locator('[data-pp-sup]').fill('PT Kurma Nusantara');
  await r1.locator('[data-pp-amt]').fill('250.000');
  await r1.locator('[data-pp-note]').fill('paling mendesak');
  await page.click('#pp-add');
  const r2 = page.locator('#propose-modal .pp-row').nth(1);
  await r2.locator('[data-pp-sup]').fill('CV Buah Segar');
  await r2.locator('[data-pp-amt]').fill('100.000');
  await page.click('#pp-send');
  await expect(page.locator('.toast.ok')).toBeVisible();

  let db = await getDb(page);
  const plan = db.approvals.filter(a => a.kind === 'pay_plan').slice(-1)[0];
  expect(plan).toBeTruthy();
  expect(plan.status).toBe('pending');
  expect(plan.approver_role).toBe('owner');
  expect(plan.cashier).toBe('Jihan');
  expect(plan.total).toBe(350000);
  const items0 = JSON.parse(plan.payload).items;
  expect(items0.map(i => i.amount)).toEqual([250000, 100000]);
  expect(items0.every(i => i.approved === false && i.paid === false)).toBe(true);

  // 2. the owner sees the proposal in the inbox and authorizes only the first item
  await switchUser(page, 'Pemilik', '1234');
  await nav(page, 'approvals');
  const card = page.locator(`.apr-card[data-req="${plan.request_id}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-pp-item]')).toHaveCount(2);
  await card.locator('[data-pp-item][data-idx="1"]').uncheck(); // keep item 0, drop item 1
  await card.locator('[data-act="apr-decide"][data-d="approved"]').click();
  await expect(card).toHaveCount(0); // decided → removed from the inbox

  db = await getDb(page);
  const planA = db.approvals.find(a => a.request_id === plan.request_id);
  expect(planA.status).toBe('approved'); // authorized, not yet done
  const itemsA = JSON.parse(planA.payload).items;
  expect(itemsA[0].approved).toBe(true);
  expect(itemsA[1].approved).toBe(false);
  expect(itemsA.every(i => i.paid === false)).toBe(true);

  // 3. the manager records the authorized payment from the "siap dibayar" panel (only the authorized item is listed)
  await switchUser(page, 'Jihan', '2222');
  await nav(page, 'suppliers');
  await expect(page.locator('#sp-plans [data-act="pp-record"]')).toHaveCount(1);
  const recBtn = page.locator('#sp-plans [data-act="pp-record"][data-sup="PT Kurma Nusantara"]');
  await expect(recBtn).toBeVisible();
  await recBtn.click();
  await expect(page.locator('#pay-modal')).toBeVisible();
  await expect(page.locator('#py-amt')).toHaveValue('250.000'); // pre-filled from the authorized item
  await page.click('#py-save'); // transfer, no allocation
  await expect(page.locator('.toast.ok').filter({ hasText: 'PT Kurma Nusantara' })).toBeVisible();

  db = await getDb(page);
  const pay = db.payments.slice(-1)[0];
  expect(pay).toMatchObject({ direction: 'out', party_type: 'supplier', supplier: 'PT Kurma Nusantara', amount: 250000, method: 'transfer' });
  const planB = db.approvals.find(a => a.request_id === plan.request_id);
  const itemsB = JSON.parse(planB.payload).items;
  expect(itemsB[0]).toMatchObject({ approved: true, paid: true, pay_id: pay.pay_id });
  expect(itemsB[1].paid).toBe(false);
  expect(planB.status).toBe('done'); // every authorized item is paid

  // once paid, nothing is left to pay in the panel
  await nav(page, 'suppliers');
  await expect(page.locator('#sp-plans [data-act="pp-record"]')).toHaveCount(0);
});

test('the owner only monitors: no propose / direct-pay entry, and a direct pay_supplier is not his path', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'suppliers');
  // owner sees neither the manager "propose" entry nor a usable direct-pay button (money-out hidden by omon)
  await expect(page.locator('[data-act="sp-propose"]')).toHaveCount(0);
  await expect(page.locator('[data-act="sp-pay-new"]')).toBeHidden();
  // the cashier is still fully forbidden from paying suppliers
  expect((await asUser(page, 'Siti', '1111', 'propose_payment', { items: [{ supplier: 'PT Kurma Nusantara', amount: 1000 }] })).error).toBe('FORBIDDEN');
  expect((await asUser(page, 'Siti', '1111', 'pay_supplier', { supplier: 'PT Kurma Nusantara', amount: 1000, method: 'transfer' })).error).toBe('FORBIDDEN');
});
