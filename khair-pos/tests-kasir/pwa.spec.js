// PWA: own manifest and a service worker scoped to kasir/ with its own cache name.
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path');
const SW_CACHE = fs.readFileSync(path.join(__dirname, '..', 'kasir', 'sw.js'), 'utf8').match(/const CACHE = '([^']+)'/)[1]; // the current cache name (bumped each release)

test.use({ serviceWorkers: 'allow' });

test('manifest + service worker (scope kasir/, its own khair-kasir-* cache)', async ({ page, request }) => {
  const m = await (await request.get('kasir/manifest.webmanifest')).json();
  expect(m).toMatchObject({ name: 'Khair Kasir', start_url: './', scope: './', theme_color: '#1E40AF' });
  expect((await request.get('kasir/icon.svg')).ok()).toBe(true);
  await page.goto('kasir/index.html?mock=1');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');
  const info = await page.evaluate(async want => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !(await caches.keys()).includes(want); i++) await new Promise(r => setTimeout(r, 100));
    return { scope: reg.scope, keys: await caches.keys() };
  }, SW_CACHE);
  expect(info.scope).toMatch(/\/kasir\/$/);
  expect(SW_CACHE).toMatch(/^khair-kasir-v\d+$/);
  expect(info.keys).toContain(SW_CACHE);
  expect(info.keys).not.toContain('khair-pos-v1');
});

test('v49: under the service worker the page and its code are re-checked with the site; offline it still opens', async ({ page, context }) => {
  await page.goto('kasir/index.html?mock=1');
  await page.evaluate(async want => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !(await caches.keys()).includes(want); i++) await new Promise(r => setTimeout(r, 100));
  }, SW_CACHE);
  await page.reload(); // now through the service worker ("no-cache" navigation)
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.locator('#login-ver')).toBeVisible();
  expect(await page.evaluate(() => KUpdate.check())).toBe('same'); // the app's own check goes through it too
  expect(await page.evaluate(async () => { // in the offline shell (install may still be filling it)
    for (let i = 0; i < 50 && !(await caches.match('../shared/app-update.js')); i++) await new Promise(r => setTimeout(r, 100));
    return (await caches.match('../shared/app-update.js')) ? 'cached' : 'missing';
  })).toBe('cached');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#login-ver')).toBeVisible();
  await context.setOffline(false);
});
