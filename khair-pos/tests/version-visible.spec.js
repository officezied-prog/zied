// v69 (owner 2026-10-20: «عند فتح التطبيق اريد ان ارى عدد الإصدار»): the version shows the moment an app opens — in the top bar
// of every screen (the owner app hid it on phones), in the headers of Gudang and Order Brad (they had none), and the first
// time a new version opens on a phone a short green note says "Aplikasi diperbarui ke versi …" (never on a first install;
// it never blocks a tap).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { SHOTS, login } = require('./helpers');

const ver = f => /const APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))[1];
const OWNER = ver('index.html'), GUDANG = ver('gudang/index.html'), BRAD = ver('brad/index.html');
const PHONE = { width: 375, height: 740 };
const seenAs = (page, v) => page.evaluate(v => { for (const k of Object.keys(localStorage)) if (k.startsWith('kupd.seen:')) localStorage.setItem(k, v); }, v);

test('owner app on a phone: the version in the top bar on every screen, the store key left out', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const sub = page.locator('#tb-sub');
  await expect(sub).toBeVisible();
  await expect(sub).toContainText('POS · v' + OWNER);
  await expect(sub.locator('.hide-phone')).toBeHidden(); // the store key: computers only
  expect(await sub.innerText()).toBe('POS · v' + OWNER);
  await page.click('#nav-more'); await page.locator('[data-act="go"][data-view="settings"]:visible').first().click();
  await expect(sub).toBeVisible();
  await expect(page.locator('#kupd-ok')).toHaveCount(0); // the first time on this phone: no note
  await page.screenshot({ path: path.join(SHOTS, 'phone-topbar-version.png'), clip: { x: 0, y: 0, width: 375, height: 64 } });
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(sub).toContainText('POS · v' + OWNER + ' · demo'); // a computer still shows the store key too
});

test('the first open of a new version: a short note (Arabic too), once, and it never blocks a tap', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await seenAs(page, '3.0.0'); // this phone last ran an older version
  await page.reload();
  const note = page.locator('#kupd-ok');
  await expect(note).toHaveText('✅ Aplikasi diperbarui ke versi ' + OWNER);
  expect(await note.evaluate(e => getComputedStyle(e).pointerEvents)).toBe('none');
  await page.screenshot({ path: path.join(SHOTS, 'phone-version-note.png') });
  await expect(note).toHaveCount(0, { timeout: 9000 }); // gone by itself after a few seconds
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(note).toHaveCount(0); // the same version again: nothing
  await page.evaluate(() => setLang('ar'));
  await seenAs(page, '3.0.0');
  await page.reload();
  await expect(note).toHaveText('✅ تم تحديث التطبيق إلى النسخة ' + OWNER);
});

for (const [app, v, title] of [['gudang', GUDANG, 'Khair Gudang Dingin'], ['brad', BRAD, 'Khair Order Brad']]) {
  test(`${app}: the version under the title, before and after login; the tabs stay under the header`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(app + '/index.html?mock=1');
    await expect(page.locator('#title')).toHaveText(title);
    await expect(page.locator('#hd-ver')).toHaveText('Versi ' + v);
    await page.fill('#lg-user', 'Pemilik'); await page.fill('#lg-pin', '1234'); await page.click('#lg-go');
    await expect(page.locator('#nav')).toBeVisible();
    await expect(page.locator('#hd-ver')).toBeVisible();
    const fit = () => page.evaluate(() => parseInt(getComputedStyle(document.getElementById('nav')).top, 10) - document.querySelector('header').offsetHeight);
    await expect.poll(fit).toBe(0);
    await page.click('#lang');
    await expect(page.locator('#hd-ver')).toHaveText('النسخة ' + v);
  });
}
