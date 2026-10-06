// Customer survey never stops the selling: Bayar opens the payment window at once. Inside it, a voice survey
// starts only after the consent tap (UU PDP), records speech-to-text while paying, and stops when the payment is
// finished. After payment the receipt asks for the customer's WhatsApp number (promo consent) and can hand it to
// the shop's WhatsApp. SpeechRecognition / speechSynthesis are stubbed: window.__srEmit(text, final) feeds results.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

/** Fake Web Speech API: records instances; __srEmit / __srEnd / __srError drive the active one. */
function speechStub(opts = {}) {
  window.__sr = { started: 0, instances: [], active: null, cancels: 0, spoken: [] };
  class U { constructor(text) { this.text = text; } }
  const synth = { speak(u) { window.__sr.spoken.push(u.text); }, cancel() { window.__sr.cancels++; }, getVoices() { return [{ lang: 'id-ID', name: 'Bahasa Indonesia' }]; } };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true });
  if (opts.none) {
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
    return;
  }
  class FakeSR {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.running = false; window.__sr.instances.push(this); }
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
  window.__srEnd = () => { const r = window.__sr.active; if (r && r.running) { r.running = false; r.onend && r.onend(); } }; // Android: silence ends the session
  window.__srError = err => { const r = window.__sr.active; if (!r) return; r.onerror && r.onerror({ error: err }); if (r.running) { r.running = false; r.onend && r.onend(); } };
  Object.defineProperty(window, 'SpeechRecognition', { value: FakeSR, configurable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeSR, configurable: true });
}
const sr = page => page.evaluate(() => ({ started: window.__sr.started, running: !!(window.__sr.active && window.__sr.active.running), cancels: window.__sr.cancels, n: window.__sr.instances.length }));
const lastSale = async page => (await H.getDb(page)).sales.slice(-1)[0];
const outbox = page => page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.kasir.outbox') || '[]'));
/** Settings in the mock DB, then reload so the app bootstraps with them (the session and open shift stay). */
async function setSettings(page, patch) {
  await H.setDb(page, 'Object.assign(db.settings, arg)', patch);
  await page.reload();
  await expect(page.locator('#grid .pc').first()).toBeVisible();
  // the cached settings draw first; wait for the bootstrap answer
  await expect.poll(() => page.evaluate(p => Object.keys(p).every(k => JSON.stringify(KASIR.S.settings[k]) === JSON.stringify(p[k])), patch)).toBe(true);
}

test('Bayar opens the payment at once; consent tap starts recording; paying stops it and saves the transcript', async ({ page }) => {
  await page.addInitScript(speechStub);
  await H.login(page);
  await H.addItem(page, 'ajwa'); // no survey modal while selling (checked in addItem)
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  await expect(page.locator('#survey')).toHaveCount(0);
  const ask = page.locator('#vs-ask');
  await expect(ask).toContainText('Survei suara — tanyakan izin pelanggan');
  await expect(page.locator('#vs-start')).toHaveText('Pelanggan setuju — mulai rekam');
  await expect(page.locator('#vs-skip')).toHaveText('Lewati');
  await expect(page.locator('#vs-manual')).toContainText('Isi survei manual');
  expect((await sr(page)).started).toBe(0); // nothing is captured before the consent tap
  await H.shot(page, 'phone-30-pay-voice-consent', false, { noToasts: true });

  const cancels0 = (await sr(page)).cancels;
  await page.click('#vs-start');
  const rec = page.locator('#vs-rec');
  await expect(rec).toContainText('Merekam');
  await expect(page.locator('#vs-stop')).toBeVisible();
  await expect(page.locator('#vs-qs li')).toHaveCount(5);
  await expect(page.locator('#vs-qs li').first()).toContainText('Apakah ini pertama kali belanja');
  expect(await sr(page)).toMatchObject({ started: 1, running: true });
  expect((await sr(page)).cancels).toBeGreaterThan(cancels0); // spoken item names are cut off when recording starts
  expect(await page.evaluate(() => { const r = window.__sr.active; return [r.lang, r.continuous, r.interimResults]; })).toEqual(['id-ID', true, true]);

  await page.evaluate(() => window.__srEmit('iya pertama kali', true));
  await page.evaluate(() => window.__srEmit('tahu dari tik', false));
  await expect(page.locator('#vs-tx')).toContainText('iya pertama kali');
  await expect(page.locator('#vs-tx i')).toHaveText('tahu dari tik');
  // Android Chrome ends the session after a silence → listening starts again by itself
  await page.evaluate(() => window.__srEnd());
  await expect.poll(async () => (await sr(page)).started).toBe(2);
  await page.evaluate(() => window.__srEmit('tahu dari TikTok', true));
  await page.evaluate(() => window.__srError('no-speech')); // silence again: restarts, not an error
  await expect.poll(async () => (await sr(page)).started).toBe(3);
  await expect(page.locator('.toast.err')).toHaveCount(0);
  await page.evaluate(() => window.__srEmit('kurmanya segar', true));
  await page.locator('#vs-qs input').nth(0).check();
  await page.locator('#vs-qs input').nth(1).check();
  await expect(page.locator('#vs-tx')).toHaveText('iya pertama kali tahu dari TikTok kurmanya segar');
  await expect(page.locator('#vs-time')).toHaveText(/^0:0\d$/);
  // the payment form keeps working while recording (method switch redraws, recording continues)
  await page.click('#pm-qris');
  await page.click('#pm-tunai');
  await expect(rec).toBeVisible();
  await expect(page.locator('#vs-qs input').nth(1)).toBeChecked();
  await page.evaluate(() => window.__srEmit('ada yang lagi bicara', false));

  await page.click('#pay-ok'); // finishing the payment stops the recording; interim words are kept
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  expect((await sr(page)).running).toBe(false);
  const sale = await lastSale(page);
  expect(sale.survey_transcript).toBe('iya pertama kali tahu dari TikTok kurmanya segar ada yang lagi bicara');
  expect(JSON.parse(sale.survey)).toEqual([]);
  // nothing is recorded after the sale, and the next sale starts with the consent banner again
  await page.click('#rc-new');
  await H.addItem(page, 'pistachio');
  await H.pay(page);
  await expect(page.locator('#vs-ask')).toBeVisible();
  expect((await sr(page)).started).toBe(3);
});

test('the request carries survey_consent + survey_transcript (offline queue) and syncs into the sale', async ({ page }) => {
  await page.addInitScript(speechStub);
  await H.login(page);
  await H.addItem(page, 'kismis hitam');
  await H.pay(page);
  await page.click('#vs-start');
  await page.evaluate(() => window.__srEmit('lewat depan toko', true));
  await page.click('#vs-stop'); // stopped by hand: the text stays, recording can be resumed
  await expect(page.locator('#vs-done')).toContainText('Survei suara tercatat');
  await expect(page.locator('#vs-tx')).toHaveText('lewat depan toko');
  expect((await sr(page)).running).toBe(false);
  await page.click('#vs-resume');
  await expect(page.locator('#vs-rec')).toBeVisible();
  await page.evaluate(() => window.__srEmit('mau beli madu', true));
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  await page.click('#pay-ok');
  await expect(page.locator('#rc-state')).toContainText('offline');
  const q = (await outbox(page)).find(e => e.kind === 'sale');
  expect(q.data).toMatchObject({ survey_consent: true, survey_transcript: 'lewat depan toko mau beli madu', survey: [] });
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  await page.evaluate(() => KASIR.syncOutbox(true));
  await expect.poll(async () => (await lastSale(page)).client_id).toBe(q.id);
  expect((await lastSale(page)).survey_transcript).toBe('lewat depan toko mau beli madu');
});

test('"Lewati": nothing is recorded or sent; the banner can be brought back; survey_auto off shows only the link', async ({ page }) => {
  await page.addInitScript(speechStub);
  await H.login(page);
  await H.addItem(page, 'gula pasir');
  await H.pay(page);
  await page.click('#vs-skip');
  await expect(page.locator('#vs-ask')).toHaveCount(0);
  await expect(page.locator('#vs-ask-link')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal')).toBeVisible();
  const q = (await outbox(page)).find(e => e.kind === 'sale');
  expect(q.data).toMatchObject({ survey_consent: false, survey_transcript: '' });
  expect((await sr(page)).started).toBe(0);
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  await page.evaluate(() => KASIR.syncOutbox(true));
  await expect.poll(async () => (await lastSale(page)).client_id).toBe(q.id);
  expect((await lastSale(page)).survey_transcript).toBe('');
  await page.click('#rc-new');

  // the (mock) server never keeps a transcript sent without consent
  const kept = await page.evaluate(async () => {
    const u = JSON.parse(localStorage.getItem('kmock.db')).users.find(x => x.name === 'Siti');
    const r = await apiRaw('save_sale', { client_id: 'no-consent-1', items: [{ product_id: 1, qty: 1, unit_price: 175000, price_type: 'eceran' }], payment_method: 'tunai', paid_amount: 175000, survey_transcript: 'rahasia', survey_consent: false }, { key: 'demo', user: 'Siti', pin_hash: u.pin_hash });
    return r.sale.survey_transcript;
  });
  expect(kept).toBe('');
  // survey_auto off: no banner by itself, the small link opens it
  await setSettings(page, { survey_auto: false });
  await H.addItem(page, 'beras');
  await H.pay(page);
  await expect(page.locator('#vs-ask')).toHaveCount(0);
  await page.click('#vs-ask-link');
  await expect(page.locator('#vs-start')).toBeVisible();
  await page.click('#vs-start');
  await expect(page.locator('#vs-rec')).toBeVisible();
  // owner turned the voice survey off: no banner and no link, only the manual survey
  await H.closeModals(page);
  await setSettings(page, { survey_auto: true, survey_voice: false });
  await H.pay(page);
  await expect(page.locator('#vs-ask, #vs-ask-link, #vs-rec, #vs-done')).toHaveCount(0);
  await expect(page.locator('#vs-manual')).toBeVisible();
});

test('microphone refused → "Izin mikrofon ditolak", recording stops and the consent banner is back', async ({ page }) => {
  await page.addInitScript(speechStub);
  await H.login(page);
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#vs-start');
  await expect(page.locator('#vs-rec')).toBeVisible();
  await page.evaluate(() => window.__srError('not-allowed'));
  await expect(page.locator('.toast.err')).toContainText('Izin mikrofon ditolak');
  await expect(page.locator('#vs-rec')).toHaveCount(0);
  await expect(page.locator('#vs-start')).toBeVisible();
  await page.waitForTimeout(500);
  expect((await sr(page)).started).toBe(1); // no restart after a refusal
  await page.click('#vs-start');
  await page.evaluate(() => window.__srError('network'));
  await expect(page.locator('.toast.err').last()).toContainText('butuh internet');
  await expect(page.locator('#vs-rec')).toHaveCount(0);
  await page.click('#pay-ok');
  expect((await lastSale(page)).survey_transcript).toBe('');
});

test('no SpeechRecognition (iOS Safari, Firefox): no voice banner, the manual survey link still works', async ({ page }) => {
  await page.addInitScript(speechStub, { none: true });
  await H.login(page);
  await H.addItem(page, 'zamzam');
  await H.pay(page);
  await expect(page.locator('#vs-ask, #vs-start, #vs-ask-link')).toHaveCount(0);
  await page.click('#vs-manual');
  await expect(page.locator('#survey')).toBeVisible();
  await expect(page.locator('#survey .mic')).toHaveCount(0);
  await page.locator('[data-sq="1"]').fill('Dari pengajian');
  await page.click('#sv-save');
  await expect(page.locator('#sv-err')).toContainText('persetujuan');
  await page.check('#sv-consent');
  await page.click('#sv-save');
  await expect(page.locator('#survey')).toHaveCount(0);
  await expect(page.locator('#vs-manual .badge')).toHaveText('terisi');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const sale = await lastSale(page);
  expect(JSON.parse(sale.survey)).toEqual([{ q: 'Tahu Khair Mart dari mana?', a: 'Dari pengajian' }]);
  expect(sale.survey_transcript).toBe('');
});

test('Arabic UI: the recording panel is right-to-left, the customer is still heard in Indonesian', async ({ page }) => {
  await page.addInitScript(speechStub);
  await page.addInitScript(() => localStorage.setItem('kpos.mock.lang', JSON.stringify('ar')));
  await H.login(page);
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await expect(page.locator('#vs-start')).toHaveText('العميل موافق — ابدأ التسجيل');
  await page.click('#vs-start');
  await expect(page.locator('#vs-rec')).toContainText('جارٍ التسجيل');
  expect(await page.evaluate(() => [document.documentElement.dir, window.__sr.active.lang])).toEqual(['rtl', 'id-ID']);
  await page.evaluate(() => window.__srEmit('iya sudah sering ke sini', true));
  await page.locator('#vs-qs input').nth(0).check();
  await expect(page.locator('#vs-tx')).toHaveText('iya sudah sering ke sini');
  await H.shot(page, 'phone-31-recording', false, { noToasts: true });
});

test('receipt: WhatsApp number with promo consent → customer saved (normalised, wa_optin); same number updates; "Kirim ke WA toko"', async ({ page, context }) => {
  const opened = [];
  await context.route(/^https:\/\/wa\.me\//, route => { opened.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/plain', body: 'wa' }); });
  await page.addInitScript(speechStub);
  await H.login(page);
  await setSettings(page, { wa_shop_number: '0812-8000-2700' });
  const n0 = (await H.getDb(page)).customers.length;
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  const rc = page.locator('#rc-modal');
  await expect(rc.locator('#wa-card')).toContainText('Nomor WhatsApp pelanggan');
  await expect(rc.locator('#wa-remind')).toHaveText('Jangan lupa minta nomor WhatsApp pelanggan');
  await expect(rc.locator('#wa-phone')).toHaveAttribute('inputmode', 'tel');
  await expect(rc.locator('#wa-optin')).not.toBeChecked();
  await rc.locator('#wa-phone').fill('0812 3456 7890');
  await rc.locator('#wa-name').fill('Bu Rina');
  await rc.locator('#wa-save').click();
  await expect(rc.locator('#wa-err')).toContainText('setuju dikirimi promo'); // the consent checkbox is required
  await rc.locator('#wa-phone').fill('12345');
  await rc.locator('#wa-optin').check();
  await rc.locator('#wa-save').click();
  await expect(rc.locator('#wa-err')).toContainText('Nomor tidak valid');
  await rc.locator('#wa-phone').fill('0812345678901234567');
  await rc.locator('#wa-save').click();
  await expect(rc.locator('#wa-err')).toContainText('Nomor tidak valid');
  expect((await H.getDb(page)).customers.length).toBe(n0);
  await rc.locator('#wa-phone').fill('0812 3456 7890');
  await rc.locator('#wa-save').click();
  await expect(rc.locator('#wa-done')).toContainText('Bu Rina');
  await expect(rc.locator('#wa-done')).toContainText('+6281234567890');
  await expect(rc.locator('#wa-remind')).toHaveCount(0);
  let db = await H.getDb(page);
  expect(db.customers.length).toBe(n0 + 1);
  expect(db.customers.slice(-1)[0]).toMatchObject({ name: 'Bu Rina', phone: '6281234567890', type: 'eceran', wa_optin: true, source: 'kasir', debt_balance: 0 });
  // "Kirim ke WA toko": the shop's own number, a ready message; WhatsApp still needs the cashier's tap on Send
  const inv = (await lastSale(page)).invoice_no;
  const a = rc.locator('#wa-shop');
  await expect(a).toHaveText('Kirim ke WA toko');
  await expect(rc).toContainText('WhatsApp akan terbuka, tekan Kirim');
  await expect(a).toHaveAttribute('target', '_blank');
  const href = await a.getAttribute('href');
  const u = new URL(href);
  expect(u.origin + u.pathname).toBe('https://wa.me/6281280002700');
  expect(u.searchParams.get('text')).toMatch(new RegExp(`^Simpan nomor pelanggan baru: Bu Rina \\+6281234567890 \\(kasir Siti, \\d{2}/\\d{2}/\\d{4} \\d{2}:\\d{2}, nota ${inv}\\)$`));
  await H.shot(page, 'phone-32-receipt-phone', false, { noToasts: true });
  const [popup] = await Promise.all([page.waitForEvent('popup'), a.click()]);
  await popup.waitForLoadState();
  expect(opened).toEqual([href]);
  await popup.close();
  // the number is in the receipt memory: "Struk terakhir" shows it as saved
  await page.click('#rc-new');
  await H.tab(page, 'more');
  await page.click('[data-act="last-rc"]');
  await expect(page.locator('#rc-modal #wa-done')).toContainText('+6281234567890');
  await H.closeModals(page);
  await H.tab(page, 'sell');

  // the same number again (other spelling, no name): the existing customer is updated, not duplicated
  await H.addItem(page, 'tunisia');
  await H.pay(page);
  await page.click('#pay-ok');
  await rc.locator('#wa-phone').fill('+62 812-3456-7890');
  await rc.locator('#wa-optin').check();
  await rc.locator('#wa-save').click();
  await expect(page.locator('.toast.ok').last()).toContainText('Nomor sudah ada');
  await expect(rc.locator('#wa-done')).toContainText('Bu Rina');
  db = await H.getDb(page);
  expect(db.customers.length).toBe(n0 + 1);
  expect(db.customers.filter(c => c.phone === '6281234567890')).toHaveLength(1);
  await page.click('#rc-new');

  // a sale for a known customer with a phone: prefilled, "Sudah tersimpan", no reminder
  await H.addItem(page, 'almond');
  await H.pay(page);
  await page.click('#pay-cust');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Pak Hasan Alatas' }).click();
  await page.click('#pay-ok');
  await expect(rc.locator('#wa-known')).toHaveText('Sudah tersimpan');
  await expect(rc.locator('#wa-remind')).toHaveCount(0);
  await expect(rc.locator('#wa-phone')).toHaveValue('081155556677');
  await expect(rc.locator('#wa-name')).toHaveValue('Pak Hasan Alatas');
  await rc.locator('#wa-optin').check();
  await rc.locator('#wa-save').click();
  await expect(rc.locator('#wa-done')).toContainText('Pak Hasan Alatas');
  db = await H.getDb(page);
  expect(db.customers.find(c => c.name === 'Pak Hasan Alatas')).toMatchObject({ wa_optin: true, phone: '6281155556677' }); // the server stores the number normalised (62…)
  expect(db.customers.length).toBe(n0 + 1);
});

test('receipt number offline: queued in the outbox, saved on the next sync; no shop number → no WA button', async ({ page }) => {
  await page.addInitScript(speechStub);
  await H.login(page);
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  const rc = page.locator('#rc-modal');
  await expect(page.locator('#rc-state')).toHaveText('Transaksi tersimpan'); // the sale itself went through online
  await page.evaluate(() => localStorage.setItem('kmock.offline', '1'));
  await rc.locator('#wa-phone').fill('85712345678');
  await rc.locator('#wa-optin').check();
  await rc.locator('#wa-save').click();
  await expect(rc.locator('#wa-done')).toContainText('Pelanggan 5678');
  await expect(rc.locator('#wa-done')).toContainText('+6285712345678');
  await expect(rc.locator('#wa-shop')).toHaveCount(0);
  const q = (await outbox(page)).find(e => e.kind === 'contact');
  expect(q).toMatchObject({ action: 'save_customer', data: { name: '', phone: '6285712345678', type: 'eceran', wa_optin: true, source: 'kasir' } });
  await page.click('#rc-new');
  await expect(page.locator('#tb-outbox-n')).toHaveText('1');
  await page.click('#tb-outbox');
  await expect(page.locator('#outbox')).toContainText('Nomor pelanggan');
  await expect(page.locator('#outbox')).toContainText('+6285712345678');
  await page.evaluate(() => localStorage.removeItem('kmock.offline'));
  await page.click('#ob-sync');
  await expect(page.locator('#tb-outbox')).toBeHidden();
  const c = (await H.getDb(page)).customers.find(x => x.phone === '6285712345678');
  expect(c).toMatchObject({ name: 'Pelanggan 5678', wa_optin: true, source: 'kasir' });
  expect(await page.evaluate(id => KASIR.S.customers.some(x => x.id === id), c.id)).toBe(true);
});
