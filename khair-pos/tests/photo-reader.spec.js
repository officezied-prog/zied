// v50 (owner 2026-10-15: «لما فتحت التطبيق على الحاسوب ونزلت صورة الفاتورة التطبيق لم يستطع قراءة ولا دراسة الفاتورة فاضطررنا إلى
// تعمير كل شيء بأنفسنا»): a read note fills supplier, items, quantities and prices; when nothing is read the screen says WHY
// (the reader is off = no AI key in the Worker; the note unreadable), and Pengaturan shows whether the reader is on + how to turn it on.
const { test, expect } = require('@playwright/test');
const { login, nav, photoFile } = require('./helpers');

const NOTE = { supplier: 'CV Sumber Makmur', date: null, invoice_no: 'SH-77', total: 950000, items: [{ name: 'AIR ZAM ZAM 1 LITER', qty: 50, unit: 'pcs', unit_price: 19000, total: 950000 }] };

test('a read note fills the form: supplier, the item, quantity and price', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.evaluate(n => localStorage.setItem('kmock.scan', JSON.stringify(n)), NOTE);
  await nav(page, 'purchases');
  await page.setInputFiles('#pu-photo', await photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-photo-card')).toHaveClass(/done/);
  await expect(page.locator('#pu-photo-status')).toContainText('Nota terbaca: 1 baris');
  await expect(page.locator('#pu-ai-note')).toHaveCount(0);
  await expect(page.locator('#pu-sup')).toHaveValue('CV Sumber Makmur');
  await expect(page.locator('#pu-lines tbody tr[data-line]')).toHaveCount(1);
  await expect(page.locator('[data-pu-qty]').first()).toHaveValue('50');
  await expect(page.locator('[data-pu-cost]').first()).toHaveValue('19.000');
});

test('reader off (no AI key): the screen says so — the owner sees how to turn it on in Pengaturan', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await page.evaluate(() => localStorage.setItem('kmock.scan', JSON.stringify('off')));
  await nav(page, 'purchases');
  await page.setInputFiles('#pu-photo', await photoFile(page, 'nota.png'));
  await expect(page.locator('#pu-ai-note')).toHaveAttribute('data-ai', 'off');
  await expect(page.locator('#pu-ai-note')).toContainText('Pembaca nota otomatis (AI) belum aktif');
  await expect(page.locator('#pu-ai-note')).toContainText('beri tahu pemilik');
});

test('Pengaturan: the photo reader on / off; off → the owner gets the steps (Arabic too)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');
  await expect(page.locator('#st-ai')).toHaveAttribute('data-ai', 'on');
  await expect(page.locator('#st-ai')).toContainText('aktif');
  await page.evaluate(() => localStorage.setItem('kmock.ai', 'off'));
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'settings');
  await expect(page.locator('#st-ai')).toHaveAttribute('data-ai', 'off');
  await expect(page.locator('#st-ai')).toContainText('BELUM AKTIF');
  await page.locator('#st-ai summary').click();
  await expect(page.locator('#st-ai')).toContainText('ANTHROPIC_API_KEY');
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'settings');
  await expect(page.locator('#st-ai')).toContainText('غير مفعّل');
});
