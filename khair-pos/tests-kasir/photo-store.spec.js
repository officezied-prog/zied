// v36 (owner 2026-10-08: "فعّل حفظ الصور عبر Google Drive") — a photo taken in the cashier app is kept (Worker: R2; demo:
// IndexedDB 'kmock-photos', shared with the owner app of the same site) and linked from the photo row for the owner app.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

test('large-sale exit photo: the image itself is kept and the photo row links to it', async ({ page }) => {
  await H.login(page);
  await H.addItem(page, 'gula pasir');
  await H.openCart(page);
  await page.locator('.cl input[data-qty]').first().fill('20');
  await page.locator('.cl input[data-qty]').first().press('Enter');
  await page.click('#btn-pay');
  await page.click('#pay-ok');
  await expect(page.locator('#rc-modal #receipt')).toBeVisible();
  const file = await H.photoFile(page);
  await page.setInputFiles('#exit-photo', file);
  await expect(page.locator('#exit-box[data-match="cocok"]')).toBeVisible();
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  const ph = db.photos.find(p => p.photo_id === sale.exit_photo);
  expect(ph.drive_url).toBe('https://khair-mart-jumla.officezied.workers.dev/webhook/khair-pos-photo/file/' + ph.photo_id);
  expect(ph.drive_file_id).toMatch(new RegExp('^r2:photos/\\d{4}-\\d{2}/' + ph.photo_id + '\\.jpg$'));
  expect(JSON.stringify(db)).not.toMatch(/base64,/); // never inside the demo database
  const stored = await page.evaluate(id => new Promise(res => {
    const rq = indexedDB.open('kmock-photos', 1);
    rq.onsuccess = () => { const g = rq.result.transaction('img').objectStore('img').get(id); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); };
    rq.onerror = () => res(null);
  }), ph.photo_id);
  expect(stored).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]{100,}$/);
});
