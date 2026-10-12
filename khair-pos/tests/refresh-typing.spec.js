// v38: a background refresh redraws the open page but keeps what the person had typed (only the fields they changed).
// Found by CI: the manager's "Pekerja harian" name in Settings was wiped when the login's own data load arrived late.
const { test, expect } = require('@playwright/test');
const { login, editDb } = require('./helpers');

test('a late background refresh keeps the typed fields and refreshes the untouched ones', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.click('#nav [data-view="settings"]');
  await page.fill('#nu-name', 'Joko Angkut');
  await page.fill('#st-addr', 'Jl. Baru 9');
  await editDb(page, `db.settings.phone = '0811-1111-2222';`); // changed elsewhere meanwhile
  await page.evaluate(() => refreshData(true));
  expect(await page.inputValue('#nu-name')).toBe('Joko Angkut');
  expect(await page.inputValue('#st-addr')).toBe('Jl. Baru 9');
  expect(await page.inputValue('#st-phone')).toBe('0811-1111-2222'); // not typed here → the fresh value
  // saved, then refreshed again: the saved values stay on screen and are in the data
  await page.click('[data-act="set-save-store"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  await page.evaluate(() => refreshData(true));
  expect(await page.inputValue('#st-addr')).toBe('Jl. Baru 9');
  expect(await page.evaluate(() => settings().address)).toBe('Jl. Baru 9');
});

test('the manager\'s daily-worker name survives a late refresh and opens the attendance form', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.click('#nav [data-view="settings"]');
  await page.fill('#nu-name', 'Joko Angkut');
  await page.evaluate(() => refreshData(true));
  await page.click('[data-act="user-add"]');
  await expect(page.locator('#view-absensi')).toBeVisible();
  await expect(page.locator('#att-editor #aw-name')).toHaveValue('Joko Angkut');
});
