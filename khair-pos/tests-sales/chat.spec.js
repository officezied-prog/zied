// Phase 3 chat in Khair Sales (field rep): the rep sees the general channel only and can send.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test('rep: chat launcher, general only, send a message', async ({ page }) => {
  await H.login(page, 'Ahmad', '4444');
  const fab = page.locator('.kchat-fab');
  await expect(fab).toBeVisible();
  await fab.click();
  await expect(page.locator('.kchat-wrap.open')).toBeVisible();
  await expect(page.locator('.kchat-tab')).toHaveCount(0); // single channel → tab bar hidden
  const msg = 'Dari lapangan ' + Date.now();
  await page.locator('.kchat-ta').fill(msg);
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText(msg);
});
