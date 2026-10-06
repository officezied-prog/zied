// v16 plain-text inputs in Khair Sales: shop / owner names, phone and quantities take only what the server accepts,
// every text field has a maxlength, < > never get in; the main API cleans the data like the server.
const H = require('./helpers'); const { test, expect } = H;

const unlimited = page => page.evaluate(() => [...document.querySelectorAll('input, textarea')]
  .filter(el => el.offsetParent !== null && !['checkbox', 'radio', 'file', 'date', 'hidden'].includes(el.type))
  .filter(el => !(el.maxLength > 0) || !el.dataset.rule).map(el => el.id || el.outerHTML.slice(0, 60)));

test('new shop form and order quantities: strict fields with maxlength; Arabic hint', async ({ page, context }) => {
  await H.login(page);
  expect(await unlimited(page)).toEqual([]);
  await H.setPos(context, -6.2580, 106.8640, 9);
  await H.startDay(page);
  await H.tab(page, 'visit');
  await page.click('#ci-new');
  await page.fill('#ci-name', 'Toko <Kurma> Pak Umar; 2');
  await expect(page.locator('#ci-name')).toHaveValue('Toko Kurma Pak Umar 2');
  await page.fill('#ci-owner', 'Pak Umar (pemilik)');
  await expect(page.locator('#ci-owner')).toHaveValue('Pak Umar pemilik');
  await page.fill('#ci-phone', '+62 812-3456-7890');
  await expect(page.locator('#ci-phone')).toHaveValue('6281234567890');
  await expect(page.locator('#ci-phone')).toHaveAttribute('type', 'tel');
  await page.fill('#ci-address', 'Jl. Raya <Condet> No. 99');
  await expect(page.locator('#ci-address')).toHaveValue('Jl. Raya Condet No. 99');
  await expect(page.locator('#rule-hint')).toHaveText('Tanda < > tidak boleh');
  expect(await unlimited(page)).toEqual([]);
  await H.shot(page, 'phone-31-input-rules');
  await H.closeModals(page);

  await H.tab(page, 'order');
  await page.fill('#po-q', 'ajwa');
  await page.locator('#po-sug [data-act="po-add"]').first().click();
  const q = page.locator('[data-po-qty]').first();
  await q.fill('3 dus');
  await expect(q).toHaveValue('3');
  expect(await unlimited(page)).toEqual([]);

  await page.click('#tb-menu');
  await page.click('#lang-ar');
  await H.closeModals(page);
  await q.fill('٤x');
  await expect(q).toHaveValue('4');
  await expect(page.locator('#rule-hint')).toHaveText('أرقام فقط');
});

test('the main API cleans the data like the server (tags and < > removed)', async ({ page }) => {
  await H.login(page);
  const r = await page.evaluate(async () => { try { return await api('change_pin', { new_pin_hash: '<b>' + 'a'.repeat(64) + '</b>' }); } catch (e) { return { error: e.code, message: e.message }; } });
  expect(r).toMatchObject({ ok: true }); // the hash arrives clean
  const db = await H.getDb(page);
  expect(db.users.find(u => u.name === 'Ahmad').pin_hash).toBe('a'.repeat(64));
});
