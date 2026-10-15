// v52 (owner 2026-10-15: «بعض البضائع المعروضة بالجملة ويأخذ الزبون كما يشاء الكمية … الشوكولاتة المعروضة بالكمية الكبيرة بدون ميزان تختار
// الزبون 250 غرام يدخل الموظف للتطبيق فيطلب نوع الشوكولاتة التي هي معروضة فيخرج له مباشرة طلب الكمية كم فيكتب الكمية ويضغط مواصلة يحسب
// التطبيق كل شيء»): goods shown loose open the weight sheet at once (grams typed or chosen), the price is worked out, the stock goes
// down in kg; a "Curah" chip shows only them; the cart line keeps the grams.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

const ADD = `
  const nid = () => (db.seq.product = Math.max(db.seq.product || 0, ...db.products.map(p => p.id)) + 1);
  if (db.products.some(p => p.sku === 'LZ1')) return;
  const base = { wholesale_price: 0, wholesale_min_qty: 0, min_stock: 0, active: true, notes: '', cost_price: 90000, repack_from: 0, repack_qty: 0 };
  db.products.push(Object.assign({ id: nid(), sku: 'LZ1', name: 'Cokelat Curah Lezzo', category: 'Cokelat', unit: 'kg', retail_price: 120000, stock: 5, shop_stock: 5, loose: true }, base));
  db.products.push(Object.assign({ id: nid(), sku: 'AL1', name: 'Almond Curah Panggang', category: 'Kacang', unit: 'kg', retail_price: 200000, stock: 3, shop_stock: 3, loose: true }, base));
`;
async function loginLoose(page) {
  await H.openKasir(page);
  await H.setDb(page, ADD);
  await H.login(page, 'Siti', '1111', { noGoto: true });
}

test('tap a loose product → the weight sheet at once: 250 g → the price; the cart keeps the grams; the stock goes down in kg', async ({ page }) => {
  await loginLoose(page);
  const db0 = await H.getDb(page), cok = db0.products.find(p => p.sku === 'LZ1');
  // the "Curah" chip shows only the goods shown loose
  await expect(page.locator('#loose-chip')).toBeVisible();
  await page.click('#loose-chip');
  await expect(page.locator('#loose-chip')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#grid .pc')).toHaveCount(2);
  await expect(page.locator(`#grid .pc[data-id="${cok.id}"] [data-loose]`)).toHaveText('⚖ Curah');
  await page.click(`#grid .pc[data-id="${cok.id}"]`);
  const ws = page.locator('#weight-sheet');
  await expect(ws).toBeVisible();
  await expect(page.locator('#ws-ok')).toBeDisabled();
  await expect(page.locator('#ws-up')).toHaveText('Ketik beratnya dalam gram, mis. 250');
  await page.fill('#ws-g', '250');
  await expect(page.locator('#ws-total')).toHaveText(H.rp(30000));
  await expect(page.locator('#ws-up')).toHaveText(`250 g × ${H.rp(120000)}/kg`);
  await page.click('#ws-chips [data-g="500"]');
  await expect(page.locator('#ws-g')).toHaveValue('500');
  await expect(page.locator('#ws-total')).toHaveText(H.rp(60000));
  await page.fill('#ws-g', '250');
  await H.shot(page, 'phone-loose-weight', false, { noToasts: true });
  await page.click('#ws-ok');
  await expect(ws).toHaveCount(0);
  await expect(page.locator(`#grid .pc[data-id="${cok.id}"] .incart`)).toHaveText('250 g');
  await H.openCart(page);
  const line = page.locator(`.cl[data-pid="${cok.id}"]`);
  await expect(line.locator('.ws-edit')).toContainText('250 g');
  await expect(line.locator('[data-act="qty-inc"]')).toHaveCount(0); // no "+1 kg" button on a loose line
  await expect(page.locator('#cart-total')).toHaveText(H.rp(30000));
  // the line's button opens the weight again: 1 kg
  await line.locator('.ws-edit').click();
  await expect(page.locator('#ws-g')).toHaveValue('250');
  await page.click('#ws-chips [data-g="1000"]');
  await page.click('#ws-ok');
  await expect(line.locator('.ws-edit')).toContainText('1 kg');
  await expect(page.locator('#cart-total')).toHaveText(H.rp(120000));
  await line.locator('.ws-edit').click();
  await page.fill('#ws-g', '250');
  await page.click('#ws-ok');
  await page.click('#btn-pay'); // (the cart sheet is open: its own pay button)
  await expect(page.locator('#pay')).toBeVisible();
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toContainText('Cokelat Curah Lezzo');
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  const it = db.items.filter(i => i.invoice_no === sale.invoice_no);
  expect(it).toHaveLength(1);
  expect(it[0]).toMatchObject({ product_id: cok.id, qty: 0.25, unit_price: 120000, line_total: 30000 });
  expect(db.products.find(p => p.id === cok.id).stock).toBe(4.75);
});

test('a loose product found by typing its name (Enter) also asks the weight; others keep the quantity sheet; Arabic texts', async ({ page }) => {
  await loginLoose(page);
  await page.fill('#q', 'almond curah');
  await page.press('#q', 'Enter');
  await expect(page.locator('#weight-sheet')).toBeVisible();
  await page.fill('#ws-g', '100');
  await expect(page.locator('#ws-total')).toHaveText(H.rp(20000));
  await page.click('#ws-ok');
  // a product not shown loose → the usual "how many?" sheet
  await page.fill('#q', 'tunisia');
  await page.press('#q', 'Enter');
  await expect(page.locator('#qty-sheet')).toBeVisible();
  await expect(page.locator('#weight-sheet')).toHaveCount(0);
  await H.closeModals(page);
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#loose-chip')).toContainText('سائب');
  await page.fill('#q', 'almond curah');
  await page.press('#q', 'Enter');
  await expect(page.locator('#weight-sheet label[for="ws-g"]')).toHaveText('الوزن المأخوذ (غرام)');
  await H.shot(page, 'phone-loose-weight-ar', false, { noToasts: true });
});
