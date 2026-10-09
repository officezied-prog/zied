// Owner/manager live sales monitor: the home dashboard carries a "live" badge and auto-refreshes (quietly, fresh
// data every 30s) while the 'today' preset is selected; the badge is gone on any other range. Frontend-only.
const { test, expect } = require('@playwright/test');
const { login, nav } = require('./helpers');

test('home: live badge + updated time on today; gone on other ranges; back on today', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'home');
  // default 'today' preset → the live monitor is active, with an "updated HH:MM" stamp set after the load
  await expect(page.locator('#home-live')).toBeVisible();
  await expect(page.locator('#home-live')).toContainText('Langsung'); // 'live' label (default UI language is Indonesian)
  await expect(page.locator('#home-updated')).toContainText(/\d/);
  // a non-today range turns the live monitor off (no live badge)
  await page.click('[data-act="home-preset"][data-p="7d"]');
  await expect(page.locator('#home-live')).toHaveCount(0);
  // back to today → live again, stamp re-set
  await page.click('[data-act="home-preset"][data-p="today"]');
  await expect(page.locator('#home-live')).toBeVisible();
  await expect(page.locator('#home-updated')).toContainText(/\d/);
});

test('home: the manager also gets the live monitor on today', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'home');
  await expect(page.locator('#home-live')).toBeVisible();
});
