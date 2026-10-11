// v36 (owner 2026-10-11: «صور من يحاول كتابة الكود هذا ضروري جدا», earlier «الكاميرا الأمامية تكفي مع لافتة» and
// «… أرقام متتالية … يغلق التطبيق»): a code attempt — or a run of 8+ sequential / repeated digits in a FREE-TEXT field —
// locks the account and sends a FRONT-camera photo of whoever typed it to the owner. Camera refused / no camera →
// recorded "no photo", the lock still works. The camera is asked once at login; the login screen carries the notice.
// Numbers, money, quantities, barcodes (scanner into the search), phones and PINs never trip the digit rule.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

// Chromium's fake camera (a moving test pattern) and an automatic "Allow" on the permission prompt.
test.use(Object.assign({}, H.PHONE, { launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } }));

/** Counts getUserMedia calls (and their constraints) without changing what they do. */
function gumSpy() {
  window.__gum = [];
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
  let granted = false;
  md.getUserMedia = c => { window.__gum.push(JSON.parse(JSON.stringify(c))); return orig(c).then(s => { granted = true; return s; }); };
  // a new store device: the camera has not been asked yet ("prompt") until the first grant
  const q = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = d => d && d.name === 'camera' ? Promise.resolve({ state: granted ? 'granted' : 'prompt' }) : q(d);
  // remembers the cover shown while the photo is taken (it is gone again within a second)
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => { const v = document.getElementById('kg-veil'); if (v) window.__veil = v.textContent; }).observe(document.body, { childList: true }));
}
/** The camera is refused (the person tapped "Block"). */
function gumDenied() {
  window.__gum = [];
  navigator.mediaDevices.getUserMedia = c => { window.__gum.push(c); return Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); };
  const q = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = d => d && d.name === 'camera' ? Promise.resolve({ state: 'prompt' }) : q(d);
}
const shots = async page => (await H.getDb(page)).tamper_shots || [];
async function openKasNote(page) {
  await H.tab(page, 'kas');
  await page.click('#kas-out');
  await expect(page.locator('#cm-note')).toBeVisible();
}

test('code attempt: the screen is covered, the account locks at once and the front-camera photo reaches the owner; notice + camera asked at login', async ({ page }) => {
  await page.addInitScript(gumSpy);
  await H.openKasir(page);
  // the permanent notice on the login screen (store key step, names, PIN pad)
  await expect(page.locator('#cam-note')).toHaveText('📷 Perangkat ini diawasi kamera untuk keamanan');
  await H.login(page, 'Siti', '1111', { noGoto: true });
  // the camera permission is asked once at a staff login (front camera), so the shot later is silent
  await expect.poll(() => page.evaluate(() => window.__gum.length)).toBe(1);
  expect(await page.evaluate(() => window.__gum[0].video.facingMode)).toBe('user');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kpos.cam_primed'))).toBe('1');

  await openKasNote(page);
  await page.fill('#cm-note', 'Es batu ${document.cookie}');
  await expect(page.locator('#app')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#login')).toContainText('dikunci');
  await expect(page.locator('#kg-veil')).toHaveCount(0);
  expect(await page.evaluate(() => window.__veil)).toBe('🔒 Akun ini dikunci setelah percobaan menulis kode. Hanya pemilik yang membukanya.');
  await expect(page.locator('#cam-note')).toBeVisible();
  const db = await H.getDb(page);
  expect(db.settings.locked_accounts).toContain('siti');
  expect(db.tamper_shots).toHaveLength(1);
  const s = db.tamper_shots[0];
  expect(s).toMatchObject({ user: 'Siti', role: 'kasir', place: 'cm-note', kind: 'code', photo_status: 'ok' });
  expect(s.photo).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
  expect(s.photo.length).toBeLessThan(250000); // small: 640 px, JPEG
  expect(s.shot_id).toMatch(/^TS[A-Z0-9]{12}$/);
  expect(await page.evaluate(() => window.__gum.length)).toBe(2); // the shot itself
  const acts = db.activity.filter(a => a.kind === 'tamper' && a.user === 'Siti').map(a => a.summary);
  expect(acts).toEqual(['Percobaan menulis kode — akun dikunci (cm-note) · foto menyusul', 'Foto percobaan kode tersimpan (cm-note)']);
  // the decoded photo is a real JPEG of at most 640 px
  const size = await page.evaluate(src => new Promise(ok => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.onerror = () => ok(null); i.src = src; }), s.photo);
  expect(size && Math.max(...size)).toBeGreaterThan(0);
  expect(Math.max(...size)).toBeLessThanOrEqual(640);
  // the cashier cannot come back in: only the owner opens the account
  await H.login(page, 'Siti', '1111', { noGoto: true, openShift: false }).catch(() => { });
  await expect(page.locator('#login')).toContainText('dikunci');
});

test('camera refused → "no photo (camera refused)" is recorded; the digit run locks all the same', async ({ page }) => {
  await page.addInitScript(gumDenied);
  await H.login(page);
  await openKasNote(page);
  await page.fill('#cm-note', 'Es batu 12345678');
  await expect(page.locator('#app')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#login')).toContainText('dikunci');
  const db = await H.getDb(page);
  expect(db.settings.locked_accounts).toContain('siti');
  expect(db.tamper_shots).toHaveLength(1);
  expect(db.tamper_shots[0]).toMatchObject({ user: 'Siti', place: 'cm-note', kind: 'digits', sample: '12345678', photo_status: 'denied', photo: '' });
  const acts = db.activity.filter(a => a.kind === 'tamper' && a.user === 'Siti').map(a => a.summary);
  expect(acts).toEqual(['Angka berurutan "12345678" — akun dikunci (cm-note) · foto menyusul', 'Percobaan kode: tanpa foto (kamera ditolak) (cm-note)']);
});

test('a code attempt the SERVER catches (sent past the field check) gets the front-camera photo too', async ({ page }) => {
  await page.addInitScript(gumSpy);
  await H.login(page);
  const code = await page.evaluate(async () => { try { await api('check_approval', { request_id: '${document.cookie}' }); return 'ok'; } catch (e) { return e.code; } });
  expect(code).toBe('TAMPER');
  await expect(page.locator('#app')).toBeHidden({ timeout: 15000 });
  await expect.poll(async () => ((await shots(page))[0] || {}).photo_status, { timeout: 15000 }).toBe('ok');
  const s = (await shots(page))[0];
  expect(s).toMatchObject({ user: 'Siti', place: 'server:check_approval', kind: 'code' });
  expect(s.photo).toMatch(/^data:image\/jpeg;base64,/);
  expect((await H.getDb(page)).settings.locked_accounts).toContain('siti');
});

test('digit rule whitelist: barcode scans into the search, money, quantities, phones, short / real numbers in a note never lock', async ({ page }) => {
  await page.addInitScript(gumSpy);
  await H.login(page);
  const still = async () => {
    await page.waitForTimeout(300);
    await expect(page.locator('#app')).toBeVisible();
    expect(await page.evaluate(() => KASIR.S.inApp)).toBe(true);
    await expect(page.locator('#kg-veil')).toHaveCount(0);
    expect(await shots(page)).toHaveLength(0);
  };
  // barcode reader (keyboard wedge) and pasted numbers into the product search
  await page.locator('#q').click();
  await page.keyboard.type('12345678');
  await page.fill('#q', '11111111');
  await page.fill('#q', '1234567890123');
  await still();
  await page.fill('#q', '');
  // a scanner burst into a NOTE (8 characters in a few ms) is a scan, not typing
  await openKasNote(page);
  await page.evaluate(() => {
    const el = document.getElementById('cm-note'); el.focus();
    for (const ch of '87654321') { el.value += ch; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true })); }
  });
  await still();
  // money: digits only
  await page.fill('#cm-amt', '12345678');
  await page.fill('#cm-amt', '11111111');
  // real numbers inside a note: a phone, an invoice date, 7 digits in a row
  await page.fill('#cm-note', 'Hubungi 081234567890 / 0812 3456 7890, nota 20261011, kode 1234567');
  await still();
  await H.closeModals(page);
  await H.tab(page, 'sell');
  // quantity, paid amount, discount, a new customer's phone
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.fill('#pay-cash', '11111111');
  await page.fill('#pay-disc', '12345678');
  await page.click('#pay-cust');
  await page.click('#cp-new summary');
  await page.fill('#cn-phone', '081111111111');
  await page.fill('#cn-phone', '12345678901');
  await still();
  // …but the same run in the customer's NAME is tampering
  await page.fill('#cn-name', 'Toko 12345678');
  await expect(page.locator('#app')).toBeHidden({ timeout: 15000 });
  const s = await shots(page);
  expect(s).toHaveLength(1);
  expect(s[0]).toMatchObject({ place: 'cn-name', kind: 'digits', sample: '12345678', photo_status: 'ok' });
});

test('KGuard: which digit runs are a pattern, and which fields are free text', async ({ page }) => {
  await H.openKasir(page);
  const r = await page.evaluate(() => {
    const runs = ['12345678', '87654321', '1234567890', '90123456', '11111111', '12121212', '123123123', '12341234', '٠١٢٣٤٥٦٧', 'abc 99999999 def',
      '1234567', '081234567890', '20261011', '8991234567890', '0812 3456 7890', '12345678a', 'Rp 1.234.567', '13579246'];
    const mk = (tag, attrs) => { const el = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)); document.body.appendChild(el); return el; };
    const fields = {
      note: KGuard.freeText(mk('input', { id: 'x-note' }), 'text'),
      textarea: KGuard.freeText(mk('textarea', { id: 'x-msg' }), 'long'),
      name: KGuard.freeText(mk('input', { id: 'x-name', 'data-rule': 'name' }), 'name'),
      search: KGuard.freeText(mk('input', { id: 'x-s', type: 'search' }), 'search'),
      num: KGuard.freeText(mk('input', { id: 'x-n', 'data-rule': 'num' }), 'num'),
      phone: KGuard.freeText(mk('input', { id: 'x-p', inputmode: 'tel' }), 'text'),
      pin: KGuard.freeText(mk('input', { id: 'x-pin', type: 'password' }), 'pin'),
      ref: KGuard.freeText(mk('input', { id: 'py-ref' }), 'text'),
      sku: KGuard.freeText(mk('input', { id: 'pf-sku' }), 'text'),
      denom: KGuard.freeText(mk('input', { 'data-denom': '100000' }), 'text'),
      promo: KGuard.freeText(mk('input', { id: 'cart-promo' }), 'text'),
      pasted: KGuard.freeText(mk('textarea', { id: 'gl-text', 'data-digits-ok': '' }), 'long')
    };
    return { runs: runs.map(v => [v, KGuard.digitRun(v)]), fields };
  });
  expect(r.runs).toEqual([['12345678', '12345678'], ['87654321', '87654321'], ['1234567890', '1234567890'], ['90123456', '90123456'], ['11111111', '11111111'],
    ['12121212', '12121212'], ['123123123', '123123123'], ['12341234', '12341234'], ['٠١٢٣٤٥٦٧', '01234567'], ['abc 99999999 def', '99999999'],
    ['1234567', ''], ['081234567890', ''], ['20261011', ''], ['8991234567890', ''], ['0812 3456 7890', ''], ['12345678a', '12345678'], ['Rp 1.234.567', ''], ['13579246', '']]);
  expect(r.fields).toEqual({ note: true, textarea: true, name: true, search: false, num: false, phone: false, pin: false, ref: false, sku: false, denom: false, promo: false, pasted: false });
});
