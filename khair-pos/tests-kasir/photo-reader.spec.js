// v50 (owner 2026-10-15: «التطبيق لم يستطع قراءة ولا دراسة الفاتورة»): in Khair Kasir too, a note that is not read says why.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
test('reader off (no AI key): the cashier is told to type the goods and tell the owner', async ({ page }) => {
  await H.login(page);
  await page.evaluate(() => localStorage.setItem('kmock.scan', JSON.stringify('off')));
  await H.tab(page, 'masuk');
  await page.setInputFiles('#pu-photo', await H.photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-ok')).toContainText('0 ');
  await expect(page.locator('#pu-ai-note')).toHaveAttribute('data-ai', 'off');
  await expect(page.locator('#pu-ai-note')).toContainText('belum aktif');
});
