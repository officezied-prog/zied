// Hold sale ("Tahan"): park the cart while a customer looks for more goods, serve the next customer,
// resume later. Held carts stay on this device (per store key) and are priced again on resume.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
const HELD_KEY = 'kpos.mock.kasir.held.demo';
const heldStored = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]'), HELD_KEY);
const spoken = page => page.evaluate(() => (window.__spoken || []).map(x => x.text));

/** Phone: open the cart sheet → Tahan → optional label → confirm. */
async function hold(page, label) {
  await H.openCart(page);
  await page.click('#btn-hold');
  await expect(page.locator('#hold-prompt')).toBeVisible();
  if (label) await page.fill('#hold-label', label);
  await page.click('#hold-ok');
  await expect(page.locator('#hold-prompt')).toHaveCount(0);
}
async function openHeldList(page) {
  if (await page.locator('#cart.open').count()) await page.click('#cart [data-act="cart-close"]');
  await page.click('#held-chip');
  await expect(page.locator('#held-list')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__spoken = [];
    class U { constructor(text) { this.text = text; this.lang = ''; } }
    const stub = { speak(u) { window.__spoken.push({ text: u.text }); }, cancel() { }, getVoices() { return [{ lang: 'id-ID', name: 'Bahasa Indonesia' }]; } };
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true });
  });
});

test('hold with a label → next customer pays → resume the held cart (same items, same total) → pay', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Ajwa/), tun = H.productByName(db0, /Tunisia/);
  await H.addItem(page, 'ajwa', { qty: 2 });
  await H.addItem(page, 'tunisia', { qty: 3 });
  const total = 2 * 175000 + 3 * 38000;
  await expect(page.locator('#paybar-total')).toHaveText(H.rp(total));
  await expect(page.locator('#held-chip')).toBeHidden();

  await H.openCart(page);
  await expect(page.locator('#btn-hold')).toBeVisible();
  const said = (await spoken(page)).length;
  await page.click('#btn-hold');
  await expect(page.locator('#hold-label')).toHaveAttribute('placeholder', 'Pelanggan 1');
  await page.fill('#hold-label', 'Baju merah');
  await H.shot(page, 'phone-23-hold', false, { noToasts: true });
  await page.click('#hold-ok');
  await expect(page.locator('.toast.ok', { hasText: 'Ditahan: Baju merah' })).toBeVisible();
  // an empty cart for the next customer
  await expect(page.locator('#cart.open')).toHaveCount(0);
  await expect(page.locator('#paybar-pay')).toBeDisabled();
  await expect(page.locator('#paybar-total')).toHaveText(H.rp(0));
  await expect(page.locator('#held-chip')).toBeVisible();
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  const st = await heldStored(page);
  expect(st).toHaveLength(1);
  expect(st[0]).toMatchObject({ label: 'Baju merah', by: 'Siti' });
  expect(st[0].held_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(st[0].cart.lines.map(l => [l.product_id, l.qty])).toEqual([[ajwa.id, 2], [tun.id, 3]]);
  expect(JSON.stringify(st[0])).not.toMatch(/unit_price|retail_price|cost/); // prices are never stored

  // the next customer buys and pays
  await H.addItem(page, 'gula pasir');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  await page.click('#rc-new');
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');

  // the first customer is back
  await openHeldList(page);
  const row = page.locator('#held-items .held');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Baju merah');
  await expect(row.locator('[data-ref="n"]')).toHaveText('2 barang');
  await expect(row.locator('[data-ref="ago"]')).toHaveText(/baru saja|1 menit lalu/);
  await expect(row.locator('[data-ref="total"]')).toHaveText(H.rp(total));
  await expect(row.locator('.badge.warn')).toHaveCount(0);
  await H.shot(page, 'phone-24-held-list', false, { noToasts: true });
  await row.locator('[data-act="held-resume"]').click();
  await expect(page.locator('.toast.ok', { hasText: 'Dilanjutkan: Baju merah' })).toBeVisible();
  await expect(page.locator('#held-chip')).toBeHidden();
  await expect(page.locator('#cart.open')).toBeVisible();
  await expect(page.locator(`.cl[data-pid="${ajwa.id}"] input[data-qty]`)).toHaveValue('2');
  await expect(page.locator(`.cl[data-pid="${tun.id}"] input[data-qty]`)).toHaveValue('3');
  await expect(page.locator('#cart-total')).toHaveText(H.rp(total));
  expect(await heldStored(page)).toEqual([]);
  // holding and resuming are silent (and never speak money)
  const all = await spoken(page);
  expect(all.slice(said).filter(s => !/^Gula Pasir/.test(s))).toEqual([]);
  for (const s of all) expect(s).not.toMatch(/Rp|rupiah|ribu|juta|total|\d{4,}/i);

  await page.click('#btn-pay');
  await expect(page.locator('#pay-total')).toHaveText(H.rp(total));
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(sale).toMatchObject({ total, status: 'ok', cashier: 'Siti' });
  expect(db.items.filter(i => i.invoice_no === sale.invoice_no).map(i => [i.product_id, i.qty]).sort()).toEqual([[ajwa.id, 2], [tun.id, 3]].sort());
});

test('resume while another cart has items → the current cart is held automatically (swap)', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Ajwa/), suk = H.productByName(db0, /Sukkari/);
  await H.addItem(page, 'ajwa');
  await hold(page); // default label
  await expect(page.locator('.toast.ok', { hasText: 'Ditahan: Pelanggan 1' })).toBeVisible();
  await H.addItem(page, 'sukkari', { qty: 2 });
  await openHeldList(page);
  await page.locator('#held-items .held', { hasText: 'Pelanggan 1' }).locator('[data-act="held-resume"]').click();
  await expect(page.locator('.toast.ok', { hasText: 'Keranjang tadi' })).toHaveText('Keranjang tadi ditahan sebagai "Pelanggan 2". Dilanjutkan: Pelanggan 1');
  await expect(page.locator('#lines .cl')).toHaveCount(1);
  await expect(page.locator(`.cl[data-pid="${ajwa.id}"]`)).toBeVisible();
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  await openHeldList(page);
  const row = page.locator('#held-items .held');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Pelanggan 2');
  await expect(row.locator('[data-ref="total"]')).toHaveText(H.rp(2 * 115000));
  const st = await heldStored(page);
  expect(st[0].cart.lines).toMatchObject([{ product_id: suk.id, qty: 2 }]);
  // the default label is the customer's name when one is chosen
  await H.closeModals(page);
  await page.click('#cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).click();
  await hold(page);
  await expect(page.locator('.toast.ok', { hasText: 'Ditahan: Ibu Fatimah' })).toBeVisible();
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (2)');
});

test('delete a held cart (with confirm); an 11th hold is refused', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'almond');
  await hold(page, 'Bapak topi hitam');
  await openHeldList(page);
  await page.locator('[data-act="held-del"]').click();
  await expect(page.locator('.modal', { hasText: 'Hapus transaksi ditahan "Bapak topi hitam"?' })).toBeVisible();
  await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').last().click(); // Batal
  await expect(page.locator('#held-items .held')).toHaveCount(1);
  await page.locator('[data-act="held-del"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('.toast.ok', { hasText: 'Transaksi ditahan dihapus' })).toBeVisible();
  await expect(page.locator('#held-list')).toContainText('Tidak ada transaksi ditahan');
  expect(await heldStored(page)).toEqual([]);
  await H.closeModals(page);
  await expect(page.locator('#held-chip')).toBeHidden();

  // fill up to 10 held carts
  for (let i = 1; i <= 10; i++) {
    await H.addItem(page, 'gula pasir', { qty: i });
    await hold(page);
  }
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (10)');
  await H.addItem(page, 'tasbih');
  await H.openCart(page);
  await page.click('#btn-hold');
  await expect(page.locator('.toast.err')).toContainText('Sudah 10 transaksi ditahan');
  await expect(page.locator('#hold-prompt')).toHaveCount(0);
  await expect(page.locator('#lines .cl')).toHaveCount(1); // the cart is untouched
  expect(await heldStored(page)).toHaveLength(10);
  // swapping keeps the count at 10 (one out, one in)
  await openHeldList(page);
  await page.locator('#held-items .held').first().locator('[data-act="held-resume"]').click();
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (10)');
});

test('held carts survive reload, lock and a cashier change on the same device', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'pistachio', { qty: 2 });
  await hold(page, 'Ibu jilbab biru');
  await page.reload();
  await expect(page.locator('#grid .pc').first()).toBeVisible();
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  // lock → PIN → still there
  await page.click('#tb-lock');
  await H.typePin(page, '1111');
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  // another cashier at this counter can resume it
  await H.tab(page, 'more');
  await page.click('#m-logout');
  await H.login(page, 'Jihan', '2222', { noGoto: true });
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  await openHeldList(page);
  await expect(page.locator('#held-items .held')).toContainText('Ibu jilbab biru');
  await expect(page.locator('#held-items .held')).toContainText('Siti');
  await page.locator('[data-act="held-resume"]').click();
  await expect(page.locator('#cart-total')).toHaveText(H.rp(2 * 135000));
});

test('resume prices the cart with current product data; gone/inactive products are dropped with a message', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const ajwa = H.productByName(db0, /Ajwa/), tun = H.productByName(db0, /Tunisia/);
  await H.addItem(page, 'ajwa', { qty: 2 });
  await H.addItem(page, 'tunisia');
  await hold(page, 'Harga berubah');
  // the owner changes a price and deactivates a product meanwhile
  await H.setDb(page, `db.products.find(p => p.id === arg[0]).retail_price = 180000; db.products.find(p => p.id === arg[1]).active = false;`, [ajwa.id, tun.id]);
  await page.reload(); // fresh product data from the server
  await expect(page.locator('#held-chip')).toHaveText('Ditahan (1)');
  await openHeldList(page);
  const row = page.locator('#held-items .held');
  await expect(row.locator('[data-ref="total"]')).toHaveText(H.rp(2 * 180000));
  await expect(row).toContainText('1 barang tidak tersedia lagi');
  await row.locator('[data-act="held-resume"]').click();
  await expect(page.locator('.toast.warn')).toContainText('Kurma Tunisia Tangkai 500 g');
  await expect(page.locator('#lines .cl')).toHaveCount(1);
  await expect(page.locator(`.cl[data-pid="${ajwa.id}"] [data-ref="up"]`)).toHaveText('× ' + H.rp(180000));
  await expect(page.locator('#cart-total')).toHaveText(H.rp(360000));
  await page.click('#btn-pay');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const db = await H.getDb(page);
  expect(db.sales[db.sales.length - 1].total).toBe(360000);
});

test('no "Tahan" while the pay sheet is open or a credit approval is pending', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'kismis hijau');
  await H.openCart(page);
  await expect(page.locator('#btn-hold')).toBeVisible();
  await page.click('#btn-pay');
  await expect(page.locator('#pay')).toBeVisible();
  expect(await page.evaluate(() => canHold())).toBe(false);
  await page.click('#pm-hutang');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Warung Bu Halimah' }).click();
  await page.click('#pay-ok');
  await expect(page.locator('#apr-step')).toBeVisible();
  await page.click('#ap-remote');
  await expect(page.locator('#apr-wait')).toBeVisible();
  await page.click('#aw-cancel'); // stop waiting: the request stays pending for this cart
  await expect(page.locator('#apr-wait')).toHaveCount(0);
  await H.closeModals(page);
  expect(await page.evaluate(() => window.KASIR.S.cart.remote && window.KASIR.S.cart.remote.request_id)).toBeTruthy();
  await H.openCart(page);
  await expect(page.locator('#lines .cl')).toHaveCount(1);
  await expect(page.locator('#btn-hold')).toBeHidden();
});

test('Arabic chip and list; closing the shift warns about held carts and keeps them', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'ajwa');
  await hold(page, 'Baju merah');

  await H.tab(page, 'more');
  await page.click('#lang-ar');
  await H.tab(page, 'sell');
  await expect(page.locator('#held-chip')).toHaveText('المعلّقة (1)');
  await page.click('#held-chip');
  await expect(page.locator('#held-list')).toContainText('العمليات المعلّقة');
  await expect(page.locator('[data-act="held-resume"]')).toHaveText('متابعة');
  await expect(page.locator('#held-items [data-ref="n"]')).toHaveText('1 أصناف');
  await H.shot(page, 'phone-25-held-list-ar', false, { noToasts: true });
  await H.closeModals(page);
  await H.tab(page, 'more');
  await page.click('#lang-id');

  await H.tab(page, 'kas');
  await page.click('#kas-close');
  await expect(page.locator('.modal', { hasText: 'Masih ada 1 transaksi ditahan' })).toBeVisible();
  await page.locator('.modal-bg').last().locator('[data-act="modal-close"]').last().click(); // Batal
  await expect(page.locator('#shift-close')).toHaveCount(0);
  await page.click('#kas-close');
  await expect(page.locator('#cf-ok')).toHaveText('Tetap tutup');
  await page.click('#cf-ok');
  await expect(page.locator('#shift-close')).toBeVisible();
  await page.fill('#cs-counted', '500000');
  await page.click('#cs-ok');
  await expect(page.locator('#shift-result')).toBeVisible();
  expect(await heldStored(page)).toHaveLength(1);
});
