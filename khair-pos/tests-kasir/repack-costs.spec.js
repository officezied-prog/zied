// v48 (owner 2026-10-14: «اجعل للمدير له خانات يمكن ان يضيفها للتكلفة التعبية»): the manager lists a pack's materials (sticker, lid, jar …)
// with their cost per pack in the owner app; the cashier's repack form shows their NAMES (never the prices) and the server adds
// materials × packs to the pack's cost. The typed field is now "Biaya lain" (other, optional).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const ADD = `
  const nid = () => (db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1);
  if (db.products.some(p => p.sku === 'RCB1')) return;
  const base = { category: 'Kurma', wholesale_price: 0, wholesale_min_qty: 0, min_stock: 0, active: true, notes: '' };
  const b = Object.assign({ id: nid(), sku: 'RCB1', name: 'Kurma Sukari Curah', unit: 'kg', cost_price: 60000, retail_price: 80000, stock: 10, shop_stock: 0, repack_from: 0, repack_qty: 0 }, base);
  db.products.push(b);
  db.products.push(Object.assign({ id: nid(), sku: 'RCP1', name: 'Kurma Sukari Toples 500 g', unit: 'toples', cost_price: 0, retail_price: 45000, stock: 0, shop_stock: 0, repack_from: b.id, repack_qty: 0.5,
    repack_costs: JSON.stringify([{ n: 'Toples', c: 2500 }, { n: 'Stiker', c: 400 }, { n: 'Tutup segel', c: 600 }]) }, base));
`;

test("cashier: the materials' names show (no prices); the repack carries materials × packs in its cost", async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, ADD);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  const db0 = await H.getDb(page), pk = db0.products.find(p => p.sku === 'RCP1');
  await H.tab(page, 'more');
  await page.click('#m-repack');
  await expect(page.locator('#repack')).toBeVisible();
  await page.selectOption('#rk-to', String(pk.id));
  await expect(page.locator('#rk-mats')).toHaveText('Bahan kemasan: Toples, Stiker, Tutup segel (biayanya dihitung otomatis)');
  await expect(page.locator('#rk-mats')).not.toContainText('Rp');
  await expect(page.locator('label[for="rk-cost"]')).toContainText('Biaya lain');
  await page.fill('#rk-qty', '6');
  await H.shot(page, 'phone-repack-materials', false, { noToasts: true });
  await page.click('#rk-ok');
  await expect(page.locator('#rk-done')).toBeVisible();
  const db = await H.getDb(page);
  const rp = db.repacks.slice(-1)[0];
  expect(rp).toMatchObject({ user: 'Siti', to_qty: 6, from_qty: 3, materials_cost: 21000, packaging_cost: 21000 });
  expect(rp.unit_cost).toBe(Math.round((3 * 60000 + 21000) / 6));
  // the cashier's own product list never carries the prices of the materials
  const names = await page.evaluate(id => JSON.parse(S.products.find(p => p.id === id).repack_costs), pk.id);
  expect(names).toEqual([{ n: 'Toples' }, { n: 'Stiker' }, { n: 'Tutup segel' }]);
});
