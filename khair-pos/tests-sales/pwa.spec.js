// PWA: own manifest and a service worker scoped to sales/ with a khair-sales-* cache.
const { test, expect } = require('./helpers');

test.use({ serviceWorkers: 'allow' });

test('manifest + service worker (scope sales/, cache khair-sales-v1)', async ({ page, request }) => {
  const m = await (await request.get('sales/manifest.webmanifest')).json();
  expect(m).toMatchObject({ name: 'Khair Sales', start_url: './', scope: './', theme_color: '#1E40AF' });
  expect((await request.get('sales/icon.svg')).ok()).toBe(true);
  await page.goto('sales/index.html?mock=1');
  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !(await caches.keys()).includes('khair-sales-v1'); i++) await new Promise(r => setTimeout(r, 100));
    const c = await caches.open('khair-sales-v1');
    return { scope: reg.scope, keys: await caches.keys(), mock: !!(await c.match('../shared/field-mock.js')) };
  });
  expect(info.scope).toMatch(/\/sales\/$/);
  expect(info.keys).toContain('khair-sales-v1');
  expect(info.keys.filter(k => k.startsWith('khair-sales-'))).toEqual(['khair-sales-v1']);
});
