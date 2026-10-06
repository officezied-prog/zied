// Owner app POS: the customer survey never blocks "Bayar & Simpan". The payment panel offers a voice survey that
// starts only after the consent tap (UU PDP) and stops when the sale is saved; the manual survey is an optional
// link. After payment the receipt asks for the customer's WhatsApp number; Pengaturan has the shop's WhatsApp
// number + voice switch; Pelanggan shows WA badges, a "Setuju promo WA" filter and a vCard export.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { SHOTS, login, nav, addBySearch, checkoutSkip, closeModals, getDb, editDb } = require('./helpers');

/** Fake Web Speech API: window.__srEmit(text, final) feeds results to the active recognition. */
function speechStub(opts = {}) {
  window.__sr = { started: 0, active: null, cancels: 0 };
  const synth = { speak() { }, cancel() { window.__sr.cancels++; }, getVoices() { return [{ lang: 'id-ID', name: 'Bahasa Indonesia' }]; } };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(t) { this.text = t; } }, configurable: true });
  if (opts.none) {
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
    return;
  }
  class FakeSR {
    start() { if (this.running) throw new Error('InvalidStateError'); this.running = true; window.__sr.started++; window.__sr.active = this; }
    stop() { if (!this.running) return; this.running = false; setTimeout(() => this.onend && this.onend(), 0); }
    abort() { this.stop(); }
  }
  window.__srEmit = (text, final = true) => {
    const r = window.__sr.active; if (!r || !r.running) return false;
    const res = [{ transcript: text, confidence: 0.9 }]; res.isFinal = final;
    r.onresult && r.onresult({ resultIndex: 0, results: [res] });
    return true;
  };
  window.__srEnd = () => { const r = window.__sr.active; if (r && r.running) { r.running = false; r.onend && r.onend(); } };
  Object.defineProperty(window, 'SpeechRecognition', { value: FakeSR, configurable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeSR, configurable: true });
}
const sr = page => page.evaluate(() => ({ started: window.__sr.started, running: !!(window.__sr.active && window.__sr.active.running), lang: window.__sr.active && window.__sr.active.lang }));
const lastSale = async page => (await getDb(page)).sales.slice(-1)[0];

test('voice survey in the payment panel: consent tap → recording → "Bayar & Simpan" stops it and saves the text', async ({ page }) => {
  await page.addInitScript(speechStub);
  await login(page);
  await expect(page.locator('#vs-wrap')).toHaveCount(0); // empty cart: no sale, no banner
  await addBySearch(page, 'ajwa');
  await addBySearch(page, 'kopi');
  await expect(page.locator('#survey')).toHaveCount(0);
  await expect(page.locator('#vs-ask')).toContainText('Survei suara — tanyakan izin pelanggan');
  expect((await sr(page)).started).toBe(0);
  await expect(page.locator('#btn-checkout')).toBeInViewport();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-pos-voice-consent.png') });
  await page.click('#vs-start');
  await expect(page.locator('#vs-rec')).toContainText('Merekam');
  // the questions come one at a time, in order (compact: the desktop cart keeps "Bayar & Simpan" on screen)
  await expect(page.locator('#vs-q')).toContainText('1/5');
  await expect(page.locator('#vs-q-text')).toHaveText('Apakah ini pertama kali belanja di Khair Mart?');
  await expect(page.locator('#vs-prev')).toBeDisabled();
  expect(await sr(page)).toMatchObject({ started: 1, running: true, lang: 'id-ID' });
  await page.evaluate(() => window.__srEmit('sudah sering belanja', true));
  await page.evaluate(() => window.__srEnd()); // silence on Android: listening restarts by itself
  await expect.poll(async () => (await sr(page)).started).toBe(2);
  await page.evaluate(() => window.__srEmit('tahu dari Instagram', true));
  // the cart keeps working while recording (a re-render keeps the recording and the text)
  await page.locator('.cline').first().locator('[data-act="qty-inc"]').click();
  await expect(page.locator('#vs-rec')).toBeVisible();
  await expect(page.locator('#vs-tx')).toHaveText('sudah sering belanja tahu dari Instagram');
  await page.click('#vs-next');
  await expect(page.locator('#vs-q')).toContainText('2/5');
  await expect(page.locator('#vs-q-text')).toHaveText('Tahu Khair Mart dari mana?');
  await expect(page.locator('#btn-checkout')).toBeInViewport();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-pos-voice-recording.png') });
  await checkoutSkip(page);
  expect((await sr(page)).running).toBe(false);
  const sale = await lastSale(page);
  expect(sale.survey_transcript).toBe('sudah sering belanja tahu dari Instagram');
  expect(JSON.parse(sale.survey)).toEqual([]);
  await closeModals(page);

  // "Lewati": no recording, nothing sent
  await addBySearch(page, 'gula');
  await page.click('#vs-skip');
  await expect(page.locator('#vs-ask')).toHaveCount(0);
  await expect(page.locator('#vs-ask-link')).toBeVisible();
  await checkoutSkip(page);
  expect((await lastSale(page)).survey_transcript).toBe('');
  expect((await sr(page)).started).toBe(2);
  await closeModals(page);

  // recording stops when the cashier leaves the POS screen
  await addBySearch(page, 'teh');
  await page.click('#vs-start');
  await expect(page.locator('#vs-rec')).toBeVisible();
  await nav(page, 'customers');
  expect((await sr(page)).running).toBe(false);
  await nav(page, 'pos');
  await expect(page.locator('#vs-done')).toContainText('Survei suara tercatat');
});

test('no SpeechRecognition: no voice banner; the manual survey link works and never blocks paying', async ({ page }) => {
  await page.addInitScript(speechStub, { none: true });
  await login(page);
  await addBySearch(page, 'zamzam');
  await expect(page.locator('#vs-ask, #vs-start, #vs-ask-link')).toHaveCount(0);
  await page.click('#vs-manual');
  await page.check('#sv-consent');
  await page.locator('[data-sq="1"]').fill('Google Maps');
  await page.click('#sv-save');
  await expect(page.locator('#vs-manual .badge')).toHaveText('terisi');
  await checkoutSkip(page);
  const sale = await lastSale(page);
  expect(JSON.parse(sale.survey)).toEqual([{ q: 'Tahu Khair Mart dari mana?', a: 'Google Maps' }]);
  expect(sale.survey_transcript).toBe('');
});

test('Pengaturan: shop WhatsApp number + voice switch (owner only); receipt phone card → customer + "Kirim ke WA toko"', async ({ page, context }) => {
  const opened = [];
  await context.route(/^https:\/\/wa\.me\//, route => { opened.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/plain', body: 'wa' }); });
  await page.addInitScript(speechStub);
  await login(page);
  await nav(page, 'settings');
  await expect(page.locator('#st-sv-voice')).toBeChecked();
  await expect(page.locator('#st-sv-auto')).toBeChecked();
  await page.fill('#st-wa-shop', '123');
  await page.click('[data-act="set-save-survey"]');
  await expect(page.locator('#st-sv-err')).toContainText('Nomor tidak valid');
  await page.fill('#st-wa-shop', '0812-8000-2700');
  await page.uncheck('#st-sv-voice');
  await page.click('[data-act="set-save-survey"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  let st = (await getDb(page)).settings;
  expect(st).toMatchObject({ wa_shop_number: '6281280002700', survey_voice: false, survey_auto: true });
  // voice survey off → only the manual link in the payment panel
  await nav(page, 'pos');
  await addBySearch(page, 'ajwa');
  await expect(page.locator('#vs-ask, #vs-ask-link')).toHaveCount(0);
  await expect(page.locator('#vs-manual')).toBeVisible();
  await nav(page, 'settings');
  await page.check('#st-sv-voice');
  await page.click('[data-act="set-save-survey"]');
  await expect.poll(async () => (await getDb(page)).settings.survey_voice).toBe(true);
  await nav(page, 'pos');
  await expect(page.locator('#vs-ask')).toBeVisible();

  const n0 = (await getDb(page)).customers.length;
  await checkoutSkip(page);
  const card = page.locator('.modal #wa-card');
  await expect(card).toContainText('Nomor WhatsApp pelanggan');
  await expect(card.locator('#wa-remind')).toHaveText('Jangan lupa minta nomor WhatsApp pelanggan');
  await card.locator('#wa-phone').fill('0813 9988 7766');
  await card.locator('#wa-name').fill('Pak Umar');
  await card.locator('#wa-save').click();
  await expect(card.locator('#wa-err')).toContainText('setuju dikirimi promo');
  await card.locator('#wa-optin').check();
  await card.locator('#wa-save').click();
  await expect(card.locator('#wa-done')).toContainText('+6281399887766');
  const db = await getDb(page);
  expect(db.customers.length).toBe(n0 + 1);
  expect(db.customers.slice(-1)[0]).toMatchObject({ name: 'Pak Umar', phone: '6281399887766', wa_optin: true, source: 'kasir', type: 'eceran' });
  const inv = (await lastSale(page)).invoice_no;
  const href = await card.locator('#wa-shop').getAttribute('href');
  const u = new URL(href);
  expect(u.origin + u.pathname).toBe('https://wa.me/6281280002700');
  expect(u.searchParams.get('text')).toMatch(new RegExp(`^Simpan nomor pelanggan baru: Pak Umar \\+6281399887766 \\(kasir Pemilik, \\d{2}/\\d{2}/\\d{4} \\d{2}:\\d{2}, nota ${inv}\\)$`));
  await expect(page.locator('.modal')).toContainText('WhatsApp akan terbuka, tekan Kirim');
  const [popup] = await Promise.all([page.waitForEvent('popup'), card.locator('#wa-shop').click()]);
  await popup.waitForLoadState();
  expect(opened).toEqual([href]);
  await popup.close();
  await closeModals(page);

  // the same number from the customer form: no duplicate, the existing customer comes back (existed)
  const r = await page.evaluate(() => apiRaw('save_customer', { phone: '+62 813-9988-7766', wa_optin: true }, { key: 'demo', user: KPOS.S.user, pin_hash: KPOS.S.pin_hash }));
  expect(r).toMatchObject({ existed: true, customer: { name: 'Pak Umar' } });
  expect((await getDb(page)).customers.length).toBe(n0 + 1);
});

test('Pelanggan: WhatsApp badge, "Setuju promo WA" filter, consent in the form, vCard export of opted-in numbers', async ({ page }) => {
  await login(page);
  // a number saved at the till (default name) + one opted-in customer without a usable phone (left out of the file)
  await editDb(page, `db.customers.push({ id: 901, name: 'Pelanggan 4321', phone: '6285700004321', type: 'eceran', address: '', notes: '', debt_balance: 0, wa_optin: true, source: 'kasir' }, { id: 902, name: 'Tanpa Nomor', phone: '', type: 'eceran', address: '', notes: '', debt_balance: 0, wa_optin: true, source: '' });`);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!(window.KPOS && KPOS.S.inApp && KPOS.S.customers.some(c => c.id === 902)))).toBe(true);
  await nav(page, 'customers');
  const list = page.locator('#cu-list');
  await expect(list.locator('[data-act="cust-open"]').filter({ hasText: 'Ibu Fatimah' }).locator('.wa-badge')).toBeVisible();
  await expect(list.locator('[data-act="cust-open"]').filter({ hasText: 'Pak Hasan Alatas' }).locator('.wa-badge')).toHaveCount(0);
  const all = await list.locator('[data-act="cust-open"]').count();
  await page.click('#cu-wa');
  await expect(page.locator('#cu-wa')).toHaveAttribute('aria-pressed', 'true');
  await expect(list.locator('[data-act="cust-open"]')).toHaveCount(4);
  await expect(list.locator('.wa-badge')).toHaveCount(4);
  await page.click('#cu-wa');
  await expect(list.locator('[data-act="cust-open"]')).toHaveCount(all);

  // consent checkbox in the customer form
  await page.click('[data-act="cust-new"]');
  await page.fill('[name="c_name"]', 'Bu Salma');
  await page.fill('[name="c_phone"]', '0877-1234-5678');
  await page.check('[name="c_wa_optin"]');
  await page.click('#ce-save');
  await expect(list.locator('[data-act="cust-open"]').filter({ hasText: 'Bu Salma' }).locator('.wa-badge')).toBeVisible();
  expect((await getDb(page)).customers.find(c => c.name === 'Bu Salma')).toMatchObject({ wa_optin: true, phone: '0877-1234-5678' });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cu-vcf')]);
  expect(dl.suggestedFilename()).toMatch(/^kontak-khair-mart-\d{4}-\d{2}-\d{2}\.vcf$/);
  const vcf = fs.readFileSync(await dl.path(), 'utf8');
  const cards = vcf.split('END:VCARD').filter(x => x.trim());
  expect(cards).toHaveLength(4);
  expect(vcf.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
  expect(vcf).toContain('FN:Bu Salma\r\nN:;Bu Salma;;;\r\nTEL;TYPE=CELL:+6287712345678\r\nEND:VCARD');
  expect(vcf).toContain('FN:Ibu Fatimah\r\nN:;Ibu Fatimah;;;\r\nTEL;TYPE=CELL:+6281244445566\r\nEND:VCARD');
  expect(vcf).toContain('TEL;TYPE=CELL:+6285700004321');
  expect(vcf).toContain('FN:Ustadzah Aisyah');
  expect(vcf).not.toContain('Tanpa Nomor');
  expect(vcf).not.toContain('Pak Hasan');
  expect([...vcf.matchAll(/^FN:(.*)$/gm)].map(m => m[1].trim())).toEqual(['Bu Salma', 'Ibu Fatimah', 'Pelanggan 4321', 'Ustadzah Aisyah']);
  await expect(page.locator('.toast.ok').last()).toContainText('4 kontak diekspor');
});

test('manager: no shop WhatsApp / voice fields (owner only); offline receipt number waits in "pending contacts"', async ({ page }) => {
  await page.addInitScript(speechStub);
  await login(page, 'Jihan', '2222');
  await nav(page, 'settings');
  await expect(page.locator('#st-wa-shop, #st-sv-voice')).toHaveCount(0);
  expect((await page.evaluate(() => apiRaw('save_settings', { settings: { wa_shop_number: '0811' } }, { key: 'demo', user: KPOS.S.user, pin_hash: KPOS.S.pin_hash }).catch(e => e.code)))).toBe('FORBIDDEN');
  await nav(page, 'pos');
  await addBySearch(page, 'almond');
  await checkoutSkip(page);
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  const card = page.locator('.modal #wa-card');
  await card.locator('#wa-phone').fill('8571112222');
  await card.locator('#wa-optin').check();
  await card.locator('#wa-save').click();
  await expect(card.locator('#wa-done')).toContainText('+628571112222');
  await expect(card.locator('#wa-done')).toContainText('Pelanggan 2222');
  const pend = await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.pending_contacts') || '[]'));
  expect(pend.map(p => p.data)).toEqual([{ name: '', phone: '628571112222', type: 'eceran', wa_optin: true, source: 'kasir' }]);
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  await page.evaluate(() => KPOS.syncOutbox(true));
  await expect.poll(async () => ((await getDb(page)).customers.find(c => c.phone === '628571112222') || {}).name).toBe('Pelanggan 2222');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.pending_contacts') || '[]').length)).toBe(0);
});
