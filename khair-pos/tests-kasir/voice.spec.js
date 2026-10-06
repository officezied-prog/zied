// The device speaks product name + quantity (speechSynthesis stub) — never prices, totals or customer data.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__spoken = [];
    class U { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; } }
    const stub = { speak(u) { window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate }); }, cancel() { }, getVoices() { return [{ lang: 'id-ID', name: 'Bahasa Indonesia' }, { lang: 'ar-SA', name: 'Arabic' }]; } };
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true });
  });
});
const spoken = page => page.evaluate(() => window.__spoken.map(x => x.text));

test('speaks name + qty on add and on qty change; never prices, totals or customer names; mute per sale', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'ajwa');
  await expect.poll(() => spoken(page)).toEqual(['Kurma Ajwa Al-Madinah 1 kilo, 1']);
  expect(await page.evaluate(() => window.__spoken[0])).toMatchObject({ lang: 'id-ID', rate: 1.1 });
  await H.addItem(page, 'minyak goreng');
  await expect.poll(async () => (await spoken(page)).slice(-1)[0]).toBe('Minyak Goreng 2 liter, 1');
  await H.openCart(page);
  const inc = page.locator('.cl').first().locator('[data-act="qty-inc"]');
  await inc.click(); await inc.click();
  await expect.poll(async () => (await spoken(page)).slice(-1)[0], { timeout: 3000 }).toBe('jumlah 3');
  // customer + payment: nothing about money or the customer is spoken
  await page.click('#btn-pay');
  await page.click('#pay-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).click();
  await page.fill('#pay-cash', '1000000');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const all = await spoken(page);
  for (const s of all) {
    expect(s).not.toMatch(/Rp|rupiah|ribu|juta|total|bayar|kembali|Fatimah|tunai|hutang|\d{3,}/i);
  }
  // mute just this sale
  await page.click('#rc-new');
  await H.addItem(page, 'pistachio');
  const n = (await spoken(page)).length;
  await H.openCart(page);
  await page.click('#cart-mute');
  await expect(page.locator('#cart-mute')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.cl').first().locator('[data-act="qty-inc"]').click();
  await page.waitForTimeout(800);
  expect((await spoken(page)).length).toBe(n);
  // voice off in Lainnya
  await page.click('[data-act="cart-close"]');
  await H.tab(page, 'more');
  await page.click('#voice-off');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.voice_on')))).toBe(false);
});

test('customer asks for silence: "Senyap" on the sell screen or in payment mutes this sale only', async ({ page }) => {
  await H.login(page);
  // before the first item: tap the labelled chip on the sell screen
  await page.click('#mute-chip');
  await expect(page.locator('#mute-chip')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mute-chip')).toContainText('Senyap');
  await H.addItem(page, 'ajwa');
  await H.addItem(page, 'minyak goreng');
  await page.waitForTimeout(600);
  expect(await spoken(page)).toEqual([]);
  // the payment window shows the same state and can switch it back
  await H.openCart(page);
  await page.click('#btn-pay');
  await expect(page.locator('#pay-mute')).toHaveAttribute('aria-pressed', 'true');
  await H.shot(page, 'phone-28-pay-silent', false, { noToasts: true });
  await page.click('[data-act="modal-close"]');
  await H.shot(page, 'phone-29-sell-silent', false, { noToasts: true });
  await H.openCart(page);
  await page.click('#btn-pay');
  await page.click('#pay-mute');
  await expect(page.locator('#pay-mute')).toContainText('Suara');
  await page.click('#pay-mute');
  await page.fill('#pay-cash', '1000000');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  expect(await spoken(page)).toEqual([]);
  // next customer: sound is back on by default
  await page.click('#rc-new');
  await expect(page.locator('#mute-chip')).toHaveAttribute('aria-pressed', 'false');
  await H.addItem(page, 'pistachio');
  await expect.poll(async () => (await spoken(page)).length).toBe(1);
});
