// Tapping a product asks the quantity (bottom sheet with −/+, keypad input, quick chips, live price incl. grosir).
// Barcode scans still add 1 directly; a per-device setting turns the sheet off (tap adds 1 again).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const spoken = page => page.evaluate(() => (window.__spoken || []).map(x => x.text));
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__spoken = [];
    class U { constructor(text) { this.text = text; this.lang = ''; } }
    const stub = { speak(u) { window.__spoken.push({ text: u.text }); }, cancel() { }, getVoices() { return [{ lang: 'id-ID', name: 'Bahasa Indonesia' }]; } };
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true });
  });
});
const tapCard = async (page, query) => { await page.fill('#q', query); await page.locator('#grid .pc').first().click(); };

test.describe('phone', () => {
  test.use(H.PHONE);

  test('tap → type 12 on the keypad → grosir price from wholesale_min_qty; Enter confirms; voice says name + qty once', async ({ page }) => {
    await H.login(page);
    const beras = H.productByName(await H.getDb(page), /Beras Premium/); // Rp 76.000, grosir Rp 72.500 from 10
    await tapCard(page, 'beras');
    const sheet = page.locator('#qty-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.modal-h h2')).toHaveText(beras.name);
    await expect(sheet.locator('.qs-info .pr')).toContainText(H.rp(76000));
    await expect(page.locator('#qs-gr')).toHaveText('Grosir Rp 72.500 · ≥10');
    await expect(page.locator('#qs-qty')).toHaveValue('1');
    await expect(page.locator('#qs-qty')).toHaveAttribute('inputmode', 'numeric'); // "karung": whole numbers
    await expect(page.locator('#qs-total')).toHaveText(H.rp(76000));
    await expect(page.locator('#qs-pt')).toHaveText('Eceran');
    await expect(page.locator('#qs-ok')).toHaveText('Tambah');
    expect(await spoken(page)).toEqual([]); // nothing is said before confirming
    await page.locator('#qs-qty').fill('');
    await page.locator('#qs-qty').pressSequentially('12');
    await expect(page.locator('#qs-total')).toHaveText(H.rp(12 * 72500));
    await expect(page.locator('#qs-pt')).toHaveText('Grosir');
    await expect(page.locator('#qs-up')).toHaveText('12 × ' + H.rp(72500));
    await expect(page.locator('#qs-warn')).toHaveText('');
    await expect(sheet).not.toContainText(/modal|HPP|laba/i);
    await H.shot(page, 'phone-26-qty-sheet', false, { noToasts: true });
    await page.locator('#qs-qty').press('Enter');
    await expect(sheet).toHaveCount(0);
    await H.skipSurvey(page);
    await H.openCart(page);
    const line = page.locator(`.cl[data-pid="${beras.id}"]`);
    await expect(line.locator('input[data-qty]')).toHaveValue('12');
    await expect(line.locator('[data-ref="pt"]')).toHaveText('Grosir');
    await expect(line.locator('[data-ref="up"]')).toHaveText('× ' + H.rp(72500));
    await expect(page.locator('#cart-total')).toHaveText(H.rp(870000));
    await expect.poll(() => spoken(page)).toEqual(['Beras Premium 5 kilo, 12']);
  });

  test('quick chips (incl. the grosir chip), edit an existing line ("Ubah"), scan still adds 1', async ({ page }) => {
    await H.login(page);
    const db0 = await H.getDb(page);
    const tun = H.productByName(db0, /Tunisia/), ajwa = H.productByName(db0, /Ajwa/);
    await tapCard(page, 'tunisia');
    await expect(page.locator('#qs-chips [data-q]')).toHaveText(['1', '2', '3', '5', '10', 'Grosir 10']);
    await page.click('#qs-chips [data-q="5"]');
    await expect(page.locator('#qs-qty')).toHaveValue('5');
    await expect(page.locator('#qs-chips [data-q="5"]')).toHaveClass(/on/);
    await expect(page.locator('#qs-total')).toHaveText(H.rp(5 * 38000));
    await page.click('#qs-chip-g');
    await expect(page.locator('#qs-qty')).toHaveValue('10');
    await expect(page.locator('#qs-total')).toHaveText(H.rp(10 * 33000));
    await expect(page.locator('#qs-pt')).toHaveText('Grosir');
    await page.click('#qs-chips [data-q="3"]');
    await page.click('#qs-inc');
    await expect(page.locator('#qs-qty')).toHaveValue('4');
    await page.click('#qs-dec');
    await expect(page.locator('#qs-qty')).toHaveValue('3');
    await page.click('#qs-ok');
    await H.skipSurvey(page);
    await expect(page.locator(`#grid .pc[data-id="${tun.id}"] .incart`)).toHaveText('3');

    // tap it again: the sheet opens on the current quantity and sets it
    await tapCard(page, 'tunisia');
    await expect(page.locator('#qs-qty')).toHaveValue('3');
    await expect(page.locator('#qs-ok')).toHaveText('Ubah');
    await page.click('#qs-inc'); await page.click('#qs-inc');
    await page.click('#qs-ok');
    await expect(page.locator(`#grid .pc[data-id="${tun.id}"] .incart`)).toHaveText('5'); // set to 5, not 3 + 5
    // weight unit → decimal keypad; a stock shortage is shown in the sheet
    await tapCard(page, 'ajwa');
    await expect(page.locator('#qs-qty')).toHaveAttribute('inputmode', 'decimal');
    await page.fill('#qs-qty', '41');
    await expect(page.locator('#qs-warn')).toContainText('Stok');
    await page.fill('#qs-qty', '0');
    await expect(page.locator('#qs-ok')).toBeDisabled();
    await page.fill('#qs-qty', '1,5');
    await expect(page.locator('#qs-total')).toHaveText(H.rp(1.5 * 175000));
    await page.click('#qs-ok');
    await H.openCart(page);
    await expect(page.locator(`.cl[data-pid="${ajwa.id}"] input[data-qty]`)).toHaveValue('1,5');
    await page.click('[data-act="cart-close"]');

    // barcode scanner (fast typing + Enter): +1, no sheet
    await page.fill('#q', '');
    await page.locator('#q').focus();
    await page.keyboard.type(tun.sku, { delay: 5 });
    await page.keyboard.press('Enter');
    await expect(page.locator('#qty-sheet')).toHaveCount(0);
    await expect(page.locator(`#grid .pc[data-id="${tun.id}"] .incart`)).toHaveText('6');
    // a typed name with a single match + Enter is a pick → sheet
    await page.fill('#q', 'pistachio');
    await page.locator('#q').press('Enter');
    await expect(page.locator('#qty-sheet')).toBeVisible();
    await page.locator('#qty-sheet [data-act="modal-close"]').first().click();
    await expect(page.locator('#qty-sheet')).toHaveCount(0);
  });

  test('setting OFF restores tap-adds-1 (per device); Arabic sheet', async ({ page }) => {
    await H.login(page);
    const almond = H.productByName(await H.getDb(page), /Almond/);
    await H.tab(page, 'more');
    await expect(page.locator('#askqty-on')).toHaveClass(/on/);
    await page.click('#askqty-off');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.ask_qty')))).toBe(false);
    await H.tab(page, 'sell');
    await tapCard(page, 'almond');
    await H.skipSurvey(page);
    await expect(page.locator('#qty-sheet')).toHaveCount(0);
    await page.locator('#grid .pc').first().click();
    await expect(page.locator(`#grid .pc[data-id="${almond.id}"] .incart`)).toHaveText('2');
    await expect(page.locator('#qty-sheet')).toHaveCount(0);
    // back on, in Arabic
    await H.tab(page, 'more');
    await page.click('#askqty-on');
    await page.click('#lang-ar');
    await H.tab(page, 'sell');
    await tapCard(page, 'beras');
    await expect(page.locator('#qs-ok')).toHaveText('إضافة');
    await expect(page.locator('#qs-gr')).toContainText('جملة');
    await page.click('#qs-chips [data-q="10"]');
    await expect(page.locator('#qs-pt')).toHaveText('جملة');
    await H.shot(page, 'phone-27-qty-sheet-ar', false, { noToasts: true });
    await page.click('#qs-ok');
    await expect(page.locator('#qty-sheet')).toHaveCount(0);
  });
});

test.describe('tablet', () => {
  test.use(H.TABLET);
  test('keyboard: the quantity box has focus, type + Enter adds', async ({ page }) => {
    await H.login(page);
    const gula = H.productByName(await H.getDb(page), /Gula Pasir/);
    await tapCard(page, 'gula pasir');
    await expect(page.locator('#qs-qty')).toBeFocused();
    await page.keyboard.type('7');
    await expect(page.locator('#qs-qty')).toHaveValue('7');
    await page.keyboard.press('Enter');
    await H.skipSurvey(page);
    await expect(page.locator(`.cl[data-pid="${gula.id}"] input[data-qty]`)).toHaveValue('7');
    await expect(page.locator('#q')).toBeFocused();
    // a scan while the sheet is open is a scan (+1 of the scanned item), not a giant quantity
    const tasbih = H.productByName(await H.getDb(page), /Tasbih/);
    await tapCard(page, 'gula pasir');
    await expect(page.locator('#qs-qty')).toBeFocused();
    await page.keyboard.type(tasbih.sku, { delay: 5 });
    await page.keyboard.press('Enter');
    await expect(page.locator('#qty-sheet')).toHaveCount(0);
    await expect(page.locator(`.cl[data-pid="${gula.id}"] input[data-qty]`)).toHaveValue('7');
    await expect(page.locator(`.cl[data-pid="${tasbih.id}"] input[data-qty]`)).toHaveValue('1');
  });
});
