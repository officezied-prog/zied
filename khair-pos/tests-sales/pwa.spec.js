// PWA: own manifest and a service worker scoped to sales/ with a khair-sales-* cache.
const { test, expect } = require('./helpers');

test.use({ serviceWorkers: 'allow' });

test('manifest + service worker (scope sales/, cache khair-sales-v4)', async ({ page, request }) => {
  const m = await (await request.get('sales/manifest.webmanifest')).json();
  expect(m).toMatchObject({ name: 'Khair Sales', start_url: './', scope: './', theme_color: '#1E40AF' });
  expect((await request.get('sales/icon.svg')).ok()).toBe(true);
  await page.goto('sales/index.html?mock=1');
  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    // wait until install has put the shell in the cache (addAll may still be running when the cache name appears)
    const has = async u => (await caches.keys()).includes('khair-sales-v4') && !!(await (await caches.open('khair-sales-v4')).match(u));
    for (let i = 0; i < 50 && !((await has('../shared/field-mock.js')) && (await has('../shared/shop-types.js'))); i++) await new Promise(r => setTimeout(r, 100));
    const c = await caches.open('khair-sales-v4');
    return { scope: reg.scope, keys: await caches.keys(), mock: !!(await c.match('../shared/field-mock.js')), types: !!(await c.match('../shared/shop-types.js')), leaflet: !!(await c.match('../vendor/leaflet/leaflet.js')) };
  });
  expect(info.scope).toMatch(/\/sales\/$/);
  expect(info.mock && info.types).toBe(true); // shared mock + shop-type list are in the offline shell
  expect(info.leaflet).toBe(true); // the map library (vendor/leaflet) is in the offline shell too
  expect(info.keys).toContain('khair-sales-v4');
  expect(info.keys.filter(k => k.startsWith('khair-sales-'))).toEqual(['khair-sales-v4']);
});
