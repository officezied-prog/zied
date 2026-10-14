// v46 (owner 2026-10-14: «نعم ابنِ زر التثبيت»): Khair Sales' login card offers the one-tap install (Chrome's offer, played
// here with a stand-in event); after login the rep's screens have no card.
const H = require('./helpers');
const { test, expect } = H;

const offer = page => page.evaluate(() => {
  window.__prompted = window.__prompted || 0;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = () => { window.__prompted++; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
  window.dispatchEvent(e);
});

test('login card: "Pasang" opens the phone\'s install dialog; none after login', async ({ page }) => {
  await H.openSales(page);
  await expect(page.locator('#kinst')).toHaveCount(0);
  await offer(page);
  await expect(page.locator('#login .screen-card #kinst')).toContainText('Pasang aplikasi ini di HP');
  await H.shot(page, 'install-btn');
  await page.click('#kinst-go');
  expect(await page.evaluate(() => window.__prompted)).toBe(1);
  await expect(page.locator('#kinst')).toHaveCount(0);
  await H.login(page, 'Ahmad', '4444', { noGoto: true });
  await offer(page);
  await page.waitForTimeout(150);
  await expect(page.locator('#kinst')).toHaveCount(0);
});
