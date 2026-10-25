// v74 (owner 2026-10-25: the shop stopped when the server's free day ran out, «أريد أصلح هذه نهائياً … مجانية وآمنة»):
//  - a server fault (SERVER) or the server's quota guard (QUOTA) is kept like a lost connection: the cashier signs in offline with
//    the PIN this phone already knows, a sale goes into the outbox (receipt "BELUM TERKIRIM") and is sent later;
//  - an outbox item the server REFUSES is not sent again by itself every 30 s any more (that read thousands of rows each time, all
//    day): it waits in the outbox with the reason, to send again by hand or drop; after a server fault the next try waits longer.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

/** The demo server answers like the real one in trouble: window.__fault = 'SERVER' | 'QUOTA' | 'INVALID' (only for the actions in
 *  window.__faultOn, when set); window.__calls counts what reached the server. */
async function faultable(page) {
  await page.evaluate(() => {
    if (window.__realReq) return;
    window.__realReq = MockServer.request; window.__calls = {};
    MockServer.request = async (b, o) => {
      window.__calls[b.action] = (window.__calls[b.action] || 0) + 1;
      if (window.__fault && (!window.__faultOn || window.__faultOn.includes(b.action))) {
        return { ok: false, error: window.__fault, message: window.__fault === 'QUOTA' ? 'Kuota server hari ini menipis' : window.__fault === 'SERVER' ? 'Server error' : 'Ditolak server' };
      }
      return window.__realReq(b, o);
    };
  });
}
const setFault = (page, fault, on) => page.evaluate(([f, o]) => { window.__fault = f; window.__faultOn = o || null; }, [fault, on || null]);
const calls = (page, action) => page.evaluate(a => (window.__calls || {})[a] || 0, action);
const outbox = page => page.evaluate(() => JSON.parse(JSON.stringify(S.outbox)));

test('a server fault while selling: the sale waits in the outbox (not an error) and goes out when the server is back', async ({ page }) => {
  await H.login(page);
  await faultable(page);
  const db0 = await H.getDb(page);
  await setFault(page, 'SERVER');
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-state')).toContainText('offline');
  await expect(page.locator('#rc-modal #receipt')).toContainText('BELUM TERKIRIM');
  await page.click('#rc-new');
  await expect(page.locator('#tb-outbox-n')).toHaveText('1');
  // the automatic round tries it once more; still a server fault → it waits longer before the next try
  await page.evaluate(() => syncOutbox());
  await expect.poll(async () => (await outbox(page))[0].why).toBe('SERVER');
  const [e] = await outbox(page);
  expect(e.error).toBe('NETWORK'); // never offered to be dropped: it is only waiting
  expect(e.next_at).toBeGreaterThan(Date.now());
  // the automatic round leaves it alone until then
  const n0 = await calls(page, 'save_sale');
  await page.evaluate(() => syncOutbox());
  expect(await calls(page, 'save_sale')).toBe(n0);
  // the server is back: "Kirim sekarang" sends it at once
  await setFault(page, null);
  await page.click('#tb-outbox');
  await page.click('#ob-sync');
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 10000 });
  const db = await H.getDb(page);
  expect(db.sales.length).toBe(db0.sales.length + 1);
});

test('a server fault at sign-in: the cashier signs in offline with the PIN this phone already knows', async ({ page }) => {
  await H.login(page); // the phone learns the PIN (online)
  await faultable(page);
  await page.click('#tb-lock');
  await expect(page.locator('#pin-who')).toHaveText('Siti');
  await setFault(page, 'SERVER');
  await H.typePin(page, '1111');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.toast.warn')).toContainText('offline');
  expect(await page.evaluate(() => S.user)).toBe('Siti');
});

test('an outbox item the server refuses waits for a person (no automatic resend every 30 s); sent by hand it goes', async ({ page }) => {
  await H.login(page);
  await faultable(page);
  await setFault(page, 'SERVER');
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  await page.click('#rc-new');
  // the server now refuses this sale (a business error, not a fault)
  await setFault(page, 'INVALID', ['save_sale']);
  await page.evaluate(() => { S.outbox.forEach(e => { e.next_at = 0; }); syncOutbox(); });
  await expect.poll(async () => (await outbox(page))[0].held).toBe(true);
  const [e] = await outbox(page);
  expect(e.error).toBe('INVALID');
  const n = await calls(page, 'save_sale');
  for (let i = 0; i < 3; i++) await page.evaluate(() => syncOutbox()); // three automatic rounds
  expect(await calls(page, 'save_sale')).toBe(n); // not sent again by itself
  await page.click('#tb-outbox');
  await expect(page.locator('#outbox .li')).toContainText('INVALID');
  // fixed on the server side: sent by hand, it goes
  await setFault(page, null);
  await page.click('#ob-sync');
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 10000 });
});

test('QUOTA (the server\'s daily limit is near) is kept like offline: the sale waits, the reason is shown', async ({ page }) => {
  await H.login(page);
  await faultable(page);
  await setFault(page, 'QUOTA');
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toContainText('BELUM TERKIRIM');
  await page.click('#rc-new');
  await page.evaluate(() => syncOutbox());
  await expect.poll(async () => (await outbox(page))[0].why).toBe('QUOTA');
  const [e] = await outbox(page);
  expect(e.error).toBe('NETWORK');
  expect(await page.evaluate(() => errMsg(serverDown({ error: 'QUOTA', message: 'Kuota server hari ini menipis' })))).toBe('Kuota server hari ini menipis');
});
