// v5: the cashier's device speaks each item (name + quantity) — never prices or customer data.
const { test, expect } = require('@playwright/test');
const { login, getDb, nav, addBySearch, checkoutSkip, closeModals } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__spoken = [];
    class U { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; } }
    const stub = { speak(u) { window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate }); }, cancel() { window.__cancels = (window.__cancels || 0) + 1; }, getVoices() { return [{ lang: 'id-ID', name: 'Bahasa Indonesia' }, { lang: 'ar-SA', name: 'Arabic' }]; } };
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true });
  });
});
const spoken = page => page.evaluate(() => window.__spoken.map(x => x.text));
const clearSpoken = page => page.evaluate(() => { window.__spoken.length = 0; });

test('speaks name + quantity on add (tap, scanner), speakable units, debounced "jumlah N" on qty change', async ({ page }) => {
  await login(page);
  await addBySearch(page, 'ajwa');
  await expect.poll(() => spoken(page)).toEqual(['Kurma Ajwa Al-Madinah 1 kilo, 1']);
  const first = await page.evaluate(() => window.__spoken[0]);
  expect(first).toMatchObject({ lang: 'id-ID', rate: 1.1 });

  // barcode scanner adds the same item again → new line quantity
  const sku = (await getDb(page)).products.find(p => /Ajwa/.test(p.name)).sku;
  await page.locator('#pos-search').focus();
  await page.keyboard.type(sku, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await spoken(page)).slice(-1)[0]).toBe('Kurma Ajwa Al-Madinah 1 kilo, 2');

  // units and pcs
  for (const [q, said] of [['tunisia', 'Kurma Tunisia Tangkai 500 gram, 1'], ['minyak goreng', 'Minyak Goreng 2 liter, 1'], ['zaitun', 'Minyak Zaitun Extra Virgin 500 mili, 1'], ['finjan', 'Finjan Set 12, 1']]) {
    await addBySearch(page, q);
    await expect.poll(async () => (await spoken(page)).slice(-1)[0]).toBe(said);
  }

  // stepper: two quick taps → one utterance after ~500 ms
  await clearSpoken(page);
  const inc = page.locator('[data-act="qty-inc"]').first();
  await inc.click(); await inc.click();
  await page.waitForTimeout(250);
  expect(await spoken(page)).toEqual([]);
  await expect.poll(() => spoken(page), { timeout: 3000 }).toEqual(['jumlah 4']);
  // typed quantity (decimal for kg)
  await clearSpoken(page);
  await page.locator('.cline input[data-qty]').first().fill('2,5');
  await expect.poll(() => spoken(page), { timeout: 3000 }).toEqual(['jumlah 2,5']);
});

test('mute button silences only the current sale; no price, total or customer data is ever spoken', async ({ page }) => {
  await login(page);
  const db = await getDb(page);
  await addBySearch(page, 'pistachio');
  await page.click('#cart-mute');
  await expect(page.locator('#cart-mute')).toHaveAttribute('aria-pressed', 'true');
  await clearSpoken(page);
  await addBySearch(page, 'almond');
  await page.locator('[data-act="qty-inc"]').first().click();
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).click();
  await page.waitForTimeout(800);
  expect(await spoken(page)).toEqual([]);
  await checkoutSkip(page);
  await closeModals(page);
  // next sale: voice is back
  await expect(page.locator('#cart-mute')).toHaveAttribute('aria-pressed', 'false');
  await addBySearch(page, 'kismis hitam');
  await expect.poll(async () => (await spoken(page)).slice(-1)[0]).toBe('Kismis Hitam 500 gram, 1');

  // a full sale with customer, discount and debt: nothing sensitive is spoken
  await page.click('#cart-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Toko Berkah' }).click();
  await page.fill('#cart-disc', '1000');
  await page.click('[data-act="method"][data-m="hutang"]');
  await checkoutSkip(page);
  const all = (await spoken(page)).join(' | ');
  const prices = db.products.flatMap(p => [p.retail_price, p.wholesale_price, p.cost_price]).flatMap(n => [String(n), new Intl.NumberFormat('id-ID').format(n)]);
  expect(all).not.toMatch(/Rp|rupiah|total|diskon|hutang|tunai|transfer|qris|Berkah|Fatimah/i);
  for (const p of prices) expect(all).not.toContain(p);
});

test('Pengaturan → Suara kasir off (per device) stops all speech; on again restores it', async ({ page }) => {
  await login(page);
  await nav(page, 'settings');
  await page.click('[data-act="voice-on"][data-v="0"]');
  expect(await page.evaluate(() => localStorage.getItem('kpos.mock.voice_on'))).toBe('false');
  await nav(page, 'pos');
  await expect(page.locator('#cart-mute')).toHaveCount(0);
  await clearSpoken(page);
  await addBySearch(page, 'ajwa');
  await page.waitForTimeout(700);
  expect(await spoken(page)).toEqual([]);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'settings');
  await expect(page.locator('[data-act="voice-on"][data-v="0"]')).toHaveClass(/on/);
  await page.click('[data-act="voice-on"][data-v="1"]');
  await page.selectOption('#st-voice-lang', 'ar-SA');
  await nav(page, 'pos');
  await addBySearch(page, 'sukkari');
  await expect.poll(() => page.evaluate(() => window.__spoken.slice(-1)[0])).toMatchObject({ text: 'Kurma Sukkari Al-Qassim Box 1 kilo, 1', lang: 'ar-SA' });
});

test('no speechSynthesis available → selling still works silently', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await login(page);
  await addBySearch(page, 'ajwa');
  await page.locator('[data-act="qty-inc"]').first().click();
  await page.waitForTimeout(700);
  await checkoutSkip(page);
  expect(errors).toEqual([]);
});

test('"Senyap" button next to the payment mutes this sale only', async ({ page }) => {
  await login(page);
  await addBySearch(page, 'ajwa');
  await expect.poll(async () => (await spoken(page)).length).toBe(1);
  await page.click('#pay-mute');
  await expect(page.locator('#pay-mute')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pay-mute')).toContainText('Senyap');
  await expect(page.locator('#cart-mute')).toHaveAttribute('aria-pressed', 'true');
  await addBySearch(page, 'minyak goreng');
  await page.waitForTimeout(700);
  expect((await spoken(page)).length).toBe(1);
  await page.click('#pay-mute');
  await expect(page.locator('#pay-mute')).toContainText('Suara');
  await addBySearch(page, 'pistachio');
  await expect.poll(async () => (await spoken(page)).length).toBe(2);
});
