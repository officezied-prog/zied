// PWA: own manifest and a service worker scoped to kasir/ with its own cache name.
const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'allow' });

test('manifest + service worker (scope kasir/, cache khair-kasir-v5)', async ({ page, request }) => {
  const m = await (await request.get('kasir/manifest.webmanifest')).json();
  expect(m).toMatchObject({ name: 'Khair Kasir', start_url: './', scope: './', theme_color: '#1E40AF' });
  expect((await request.get('kasir/icon.svg')).ok()).toBe(true);
  await page.goto('kasir/index.html?mock=1');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');
  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !(await caches.keys()).includes('khair-kasir-v5'); i++) await new Promise(r => setTimeout(r, 100));
    return { scope: reg.scope, keys: await caches.keys() };
  });
  expect(info.scope).toMatch(/\/kasir\/$/);
  expect(info.keys).toContain('khair-kasir-v5');
  expect(info.keys).not.toContain('khair-pos-v1');
});
