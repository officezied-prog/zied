// v34: the owner / manager press "Tes Google" on the field page — one real Google search near the store — and read in
// plain words whether the key works, or what to fix (no key on the server, key not valid, API not enabled / billing …).
const { test, expect } = require('@playwright/test');
const { login, nav, editDb } = require('./helpers');

test('Tes Google: no key on the server → says where to add it; with the key → works, with the month count', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'field');
  await page.click('#fd-gtest');
  await expect(page.locator('#fd-gtest-msg')).toHaveAttribute('data-ok', '0');
  await expect(page.locator('#fd-gtest-msg')).toContainText('GOOGLE_PLACES_KEY');
  // the demo stands in for Google once the key is "set"
  await editDb(page, `db.google_enabled = true; db.google_results = { 'toko kurma': [{ id: 'g1', name: 'Kurma Al-Madinah', address: 'Jl. Raya Condet', lat: -6.2745, lng: 106.8583, types: ['store'], primary: 'store', url: '', status: 'OPERATIONAL' }] };`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'field');
  await expect(page.locator('#fd-google')).toContainText('0');
  await page.click('#fd-gtest');
  await expect(page.locator('#fd-gtest-msg')).toHaveAttribute('data-ok', '1');
  await expect(page.locator('#fd-gtest-msg')).toContainText('1 tempat');
  await expect(page.locator('#fd-google')).toHaveAttribute('data-n', '1');
  // Google refuses the key: the owner reads our advice AND Google's own words
  await editDb(page, `db.google_error = 'Google: 400 INVALID_ARGUMENT — API key not valid. Please pass a valid API key.';`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'field');
  await page.click('#fd-gtest');
  await expect(page.locator('#fd-gtest-msg')).toHaveAttribute('data-ok', '0');
  await expect(page.locator('#fd-gtest-msg')).toContainText('GOOGLE_PLACES_KEY');
  await expect(page.locator('#fd-gtest-msg')).toContainText('API key not valid');
  // a 400 that is NOT about the key shows Google's words as the reason
  await editDb(page, `db.google_error = 'Google: 400 INVALID_ARGUMENT — Invalid JSON payload received.';`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'field');
  await page.click('#fd-gtest');
  await expect(page.locator('#fd-gtest-msg')).toContainText('Invalid JSON payload');
});
