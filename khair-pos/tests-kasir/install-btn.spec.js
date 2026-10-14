// v46 (owner 2026-10-14: «نعم ابنِ زر التثبيت»): Khair Kasir's login card offers the one-tap install (Chrome's offer, played
// here with a stand-in event); after login the cashier screen has no card.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, PHONE, openKasir, enterKey, login } = require('./helpers');

const offer = page => page.evaluate(() => {
  window.__prompted = window.__prompted || 0;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = () => { window.__prompted++; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
  window.dispatchEvent(e);
});

test('login card: "Pasang" opens the phone\'s install dialog; none after login', async ({ page }) => {
  await page.setViewportSize(PHONE.viewport);
  await openKasir(page);
  await expect(page.locator('#kinst')).toHaveCount(0);
  await offer(page);
  await expect(page.locator('#login .screen-card #kinst')).toContainText('Pasang aplikasi ini di HP');
  await enterKey(page);
  await expect(page.locator('#login .screen-card #kinst')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'install-btn.png') });
  await page.click('#kinst-go');
  expect(await page.evaluate(() => window.__prompted)).toBe(1);
  await expect(page.locator('#kinst')).toHaveCount(0);
  await login(page, 'Siti', '1111', { noGoto: true });
  await offer(page);
  await page.waitForTimeout(150);
  await expect(page.locator('#kinst')).toHaveCount(0);
});
