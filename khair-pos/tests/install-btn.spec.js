// v46 (owner 2026-10-14: «نعم ابنِ زر التثبيت»): one-tap "install the app" on the login card. Chrome's own offer
// (beforeinstallprompt — played here with a stand-in event) becomes a green card: "Pasang" → the phone's install dialog.
// iPhone: how to add it. Never inside the app after login, never in the owner app's frame, not again for 3 days after ✕.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, openApp, enterKey, typePin, login } = require('./helpers');

const CTX = { viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'id-ID', timezoneId: 'Asia/Jakarta' };
/** What Chrome does when the app can be installed: one beforeinstallprompt; prompt() opens its dialog. */
const offer = (page, outcome = 'accepted') => page.evaluate(o => {
  window.__prompted = window.__prompted || 0;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = () => { window.__prompted++; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: o, platform: 'web' });
  window.dispatchEvent(e);
}, outcome);

test('login card: Chrome\'s offer → "Pasang" opens the phone\'s install dialog; Arabic; gone once installed', async ({ browser }) => {
  const ctx = await browser.newContext(CTX);
  const page = await ctx.newPage();
  await openApp(page);
  await expect(page.locator('#kinst')).toHaveCount(0); // nothing until Chrome offers it (already installed / other browser)
  await offer(page);
  const card = page.locator('#login .login-card #kinst');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Pasang aplikasi ini di HP');
  await expect(card).toHaveAttribute('data-mode', 'offer');
  // the card stays in the login card when the app redraws it (key → user list)
  await enterKey(page);
  await expect(page.locator('#login .login-card #kinst')).toBeVisible();
  await page.click('[data-act="set-lang"][data-lang="ar"]');
  await expect(page.locator('#kinst')).toContainText('ثبّت التطبيق على هاتفك');
  await expect(page.locator('#kinst-go')).toHaveText('تثبيت');
  await page.screenshot({ path: path.join(SHOTS, 'phone-install-btn-ar.png'), fullPage: false });
  await page.click('#kinst-go');
  expect(await page.evaluate(() => window.__prompted)).toBe(1);
  await expect(page.locator('#kinst')).toHaveCount(0);
  // installed: a later offer (another tab) is not shown again in this page
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await offer(page);
  await page.waitForTimeout(150);
  await expect(page.locator('#kinst')).toHaveCount(0);
  await ctx.close();
});

test('✕ (Tutup) hides it for 3 days; a declined dialog keeps it for later; never shown inside the app', async ({ browser }) => {
  const ctx = await browser.newContext(CTX);
  const page = await ctx.newPage();
  await openApp(page);
  await offer(page, 'dismissed');
  await page.click('#kinst-go');
  await expect(page.locator('#kinst')).toHaveCount(0); // the offer is used up; Chrome offers again later
  await offer(page);
  await expect(page.locator('#kinst')).toBeVisible();
  await page.click('#kinst-x');
  await expect(page.locator('#kinst')).toHaveCount(0);
  expect(Number(await page.evaluate(() => localStorage.getItem('kinst.closed')))).toBeGreaterThan(0);
  await offer(page);
  await page.waitForTimeout(150);
  await expect(page.locator('#kinst')).toHaveCount(0);
  // 4 days later it is offered again
  await page.evaluate(() => localStorage.setItem('kinst.closed', String(Date.now() - 4 * 864e5)));
  await offer(page);
  await expect(page.locator('#kinst')).toBeVisible();
  // after login: the app itself, no card
  await enterKey(page);
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await typePin(page, '1234');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#kinst')).toHaveCount(0);
  await offer(page);
  await page.waitForTimeout(150);
  await expect(page.locator('#kinst')).toHaveCount(0);
  await ctx.close();
});

test('iPhone: the card says how to add it (Share → Add to Home Screen), no button', async ({ browser }) => {
  const ctx = await browser.newContext(Object.assign({}, CTX, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', isMobile: true, hasTouch: true }));
  const page = await ctx.newPage();
  await openApp(page);
  const card = page.locator('#login .login-card #kinst');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-mode', 'ios');
  await expect(card).toContainText('Tambah ke Layar Utama');
  await expect(page.locator('#kinst-go')).toHaveCount(0);
  await ctx.close();
});

test('cold storage: on its own login card; inside the owner app\'s frame never', async ({ browser }) => {
  const ctx = await browser.newContext(CTX);
  const page = await ctx.newPage();
  await page.goto('gudang/index.html?mock=1');
  await expect(page.locator('#lg-pin')).toBeVisible();
  await offer(page);
  await expect(page.locator('#app > .card #kinst')).toBeVisible();
  await page.click('#kinst-go');
  expect(await page.evaluate(() => window.__prompted)).toBe(1);
  // framed (the owner app shows the cold-storage page in a frame): the script stays quiet
  await page.goto('install.html');
  await page.evaluate(() => { const f = document.createElement('iframe'); f.id = 'f'; f.src = 'gudang/index.html?mock=1'; f.style.cssText = 'width:390px;height:700px'; document.body.appendChild(f); });
  const fr = page.frameLocator('#f');
  await expect(fr.locator('#lg-pin')).toBeVisible();
  await page.frame({ url: /gudang\/index\.html/ }).evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => Promise.resolve(); e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  await page.waitForTimeout(150);
  await expect(fr.locator('#kinst')).toHaveCount(0);
  await ctx.close();
});

test('after the owner logs in: no offer kept, nothing added to the app', async ({ browser }) => {
  const ctx = await browser.newContext(CTX);
  const page = await ctx.newPage();
  await login(page, 'Pemilik', '1234', '', { stay: true });
  expect(await page.evaluate(() => typeof window.KInstall === 'object' && window.KInstall.available() === false)).toBe(true);
  await expect(page.locator('#kinst')).toHaveCount(0);
  await ctx.close();
});
