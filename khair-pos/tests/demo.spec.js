// ?demo=1: demo data with an open login (no store key, no PIN) so staff can try the apps from a link.
const { test, expect } = require('@playwright/test');

test('?demo=1&u=Jihan opens the owner app as Jihan without key or PIN', async ({ page }) => {
  await page.goto('index.html?demo=1&u=Jihan');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Jihan');
  expect(await page.evaluate(() => KPOS.S.role)).toBe('manager');
});

test('?demo=1 skips the store key; tapping a name logs in, a cashier lands in Khair Kasir', async ({ page }) => {
  await page.goto('index.html?demo=1');
  await expect(page.locator('#lg-key')).toHaveCount(0);
  await page.click('[data-act="login-user"][data-name="Pemilik"]');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#tb-user')).toHaveText('Pemilik');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('index.html?demo=1');
  await page.click('[data-act="login-user"][data-name="Siti"]');
  await page.waitForURL(/kasir\/\?demo=1&u=Siti/);
  await expect(page.locator('#gate #shift-open')).toBeVisible();
});

test('Khair Sales ?demo=1&u=Ahmad opens the rep app directly; a kasir name is refused', async ({ page }) => {
  await page.goto('sales/index.html?demo=1&u=Ahmad');
  await expect(page.locator('#app')).toBeVisible();
  expect(await page.evaluate(() => SALES.S.user)).toBe('Ahmad');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('sales/index.html?demo=1&u=Siti');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
});

test('real mode (no demo flag) still asks for the store key', async ({ page }) => {
  await page.goto('index.html');
  await expect(page.locator('#lg-key')).toBeVisible();
});

// The closing switch is skipped on localhost, so serve the app under a fake host name.
const fs = require('fs');
const path = require('path');
async function serveAs(page, state) {
  await page.route('http://khair.test/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/demo.json') return state.open === null ? route.fulfill({ status: 404, body: 'nf' }) : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ open: state.open }) });
    let p = path.join(__dirname, '..', decodeURIComponent(u.pathname));
    if (p.endsWith('/')) p += 'index.html';
    if (!fs.existsSync(p)) return route.fulfill({ status: 404, body: 'nf' });
    const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'application/javascript' : p.endsWith('.json') || p.endsWith('.webmanifest') ? 'application/json' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
    return route.fulfill({ contentType: type, body: fs.readFileSync(p) });
  });
  await page.route(/cdnjs\.cloudflare\.com|openstreetmap/, r => r.abort());
}

test('closing demo.json shuts every trial link and wipes the trial data; real mode still opens', async ({ page }) => {
  const state = { open: true };
  await serveAs(page, state);
  await page.goto('http://khair.test/index.html?demo=1&u=Jihan');
  await expect(page.locator('#tb-user')).toHaveText('Jihan');
  expect(await page.evaluate(() => !!localStorage.getItem('kmock.db'))).toBe(true);
  state.open = false;
  for (const p of ['index.html?demo=1&u=Jihan', 'index.html?mock=1', 'kasir/index.html?demo=1&u=Siti', 'sales/index.html?demo=1&u=Ahmad']) {
    await page.goto('http://khair.test/' + p);
    await expect(page.getByText('Link uji coba sudah ditutup')).toBeVisible();
  }
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kmock.') || k.startsWith('kpos.mock.')))).toEqual([]);
  state.open = null; // file deleted → also closed
  await page.goto('http://khair.test/kasir/index.html?demo=1');
  await expect(page.getByText('Link uji coba sudah ditutup')).toBeVisible();
  await page.goto('http://khair.test/index.html');
  await expect(page.locator('#lg-key')).toBeVisible();
});
