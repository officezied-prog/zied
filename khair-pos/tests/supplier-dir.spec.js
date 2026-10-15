// v56 Pemasok → the supplier directory (owner 2026-10-15: «الموردون يمكن للمحاسب والمدير إضافة المورد جديد مع الاسم اسم الشركة اسم المكان المهنة
// المواد التي يقدمها التي يبيعها»): the accountant / manager add a supplier or complete one known from goods-in notes; the owner sees it.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, openApp, enterKey, getDb, nav, editDb, staffSession, closeModals, switchUser } = require('./helpers');

async function loginAkuntan(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555'); // through Khair Kasir
  await expect(page.locator('#app')).toBeVisible();
}
async function fillForm(page, v) {
  for (const [k, val] of Object.entries(v)) await page.fill('#sdf-' + k, val);
}
const NEW = { name: 'CV Kurma Madinah', company: 'CV Kurma Madinah Sejahtera', place: 'Tanah Abang, Jakarta Pusat', trade: 'Importir', goods: 'Kurma Ajwa, Kurma Sukkari, Kurma Medjool', phone: '0812 3456 7890', note: 'Kirim tiap Senin' };

test('the accountant adds a supplier: name, company, place, trade, goods; the list shows it, the search finds it by its goods; the owner is told and sees it', async ({ page }) => {
  await loginAkuntan(page);
  await nav(page, 'suppliers');
  await page.click('#sd-new');
  await expect(page.locator('#sd-form')).toBeVisible();
  await page.click('#sdf-save');
  await expect(page.locator('#sdf-err')).toHaveText('Isi nama pemasok.');
  await fillForm(page, { name: NEW.name });
  await page.click('#sdf-save');
  await expect(page.locator('#sdf-err')).toHaveText('Isi barang yang dijual pemasok ini.');
  await fillForm(page, NEW);
  await page.click('#sdf-save');
  await expect(page.locator('.toast.ok', { hasText: 'Pemasok CV Kurma Madinah ditambahkan' })).toBeVisible();
  await expect(page.locator('#sd-form')).toHaveCount(0);
  const db = await getDb(page);
  expect(db.settings.supplier_dir).toEqual([expect.objectContaining({ n: NEW.name, co: NEW.company, pl: NEW.place, tr: 'Importir', gd: NEW.goods, ph: '6281234567890', nt: NEW.note, by: 'Lestari' })]);
  const note = db.activity.filter(a => a.kind === 'notifikasi').pop();
  expect(note.ref).toBe('owner,manager');
  expect(note.summary).toBe('Pemasok baru: CV Kurma Madinah · CV Kurma Madinah Sejahtera · Tanah Abang, Jakarta Pusat · Importir — menjual: Kurma Ajwa, Kurma Sukkari, Kurma Medjool — oleh akuntan Lestari');
  // the list: a supplier with no goods-in note yet is there, with its trade and what it sells
  const row = page.locator(`#sp-rows [data-sup="${NEW.name}"]`);
  await expect(row.locator('[data-dir]')).toHaveText('Importir');
  await expect(row.locator('[data-dir-line]')).toContainText('Menjual: Kurma Ajwa, Kurma Sukkari');
  await page.fill('#sp-q', 'medjool'); // found by the goods it sells
  await expect(page.locator('#sp-rows [data-sup]')).toHaveCount(1);
  await page.fill('#sp-q', '');
  // the same name again is refused
  await page.click('#sd-new');
  await fillForm(page, { name: 'cv kurma madinah', goods: 'Kurma' });
  await page.click('#sdf-save');
  await expect(page.locator('#sdf-err')).toContainText('sudah ada');
  await closeModals(page);
  // the owner sees the data (no edit button: the accountant / manager keep it)
  await switchUser(page, 'Pemilik', '1234');
  await nav(page, 'suppliers');
  await page.click(`#sp-rows [data-sup="${NEW.name}"]`);
  const card = page.locator('#sd-card');
  await expect(card.locator('[data-f="company"]')).toContainText(NEW.company);
  await expect(card.locator('[data-f="place"]')).toContainText(NEW.place);
  await expect(card.locator('[data-f="trade"]')).toContainText('Importir');
  await expect(card.locator('[data-f="goods"]')).toContainText(NEW.goods);
  await expect(card.locator('[data-f="phone"] a')).toHaveAttribute('href', /wa\.me\/6281234567890/);
  await expect(card.locator('[data-who]')).toContainText('Ditambahkan oleh Lestari');
  await expect(page.locator('#sd-edit')).toHaveCount(0);
  await expect(page.locator('#sd-new')).toHaveCount(0);
});

test('the manager completes a supplier known from goods-in notes, then edits it (the name stays); goods-in offers directory names', async ({ page }) => {
  await login(page, 'Jihan', '2222');
  await editDb(page, `db.settings.supplier_dir = [{ n: 'Toko Kacang Haji Umar', gd: 'Kacang almond, pistachio', by: 'Lestari', at: new Date().toISOString() }];`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'suppliers');
  await page.click('#sp-rows [data-sup="PT Kurma Nusantara"]');
  await expect(page.locator('#sd-dir-none')).toContainText('belum punya data');
  await page.click('#sd-complete');
  await expect(page.locator('#sdf-name')).toHaveValue('PT Kurma Nusantara');
  await fillForm(page, { company: 'PT Kurma Nusantara Abadi', place: 'Surabaya', trade: 'Distributor', goods: 'Kurma Sukkari, Kurma Khalas' });
  await page.click('#sdf-save');
  await expect(page.locator('#sd-card [data-f="place"]')).toContainText('Surabaya');
  await H_shot(page);
  // edit: the name cannot change; the place does
  await page.click('#sd-edit');
  await expect(page.locator('#sdf-name')).toHaveAttribute('readonly', '');
  await expect(page.locator('#sdf-goods')).toHaveValue('Kurma Sukkari, Kurma Khalas');
  await page.fill('#sdf-place', 'Surabaya, Jawa Timur');
  await page.click('#sdf-save');
  await expect(page.locator('.toast.ok', { hasText: 'Data PT Kurma Nusantara disimpan' })).toBeVisible();
  await expect(page.locator('#sd-card [data-f="place"]')).toContainText('Surabaya, Jawa Timur');
  await expect(page.locator('#sd-card [data-who]')).toContainText('diubah oleh Jihan');
  const db = await getDb(page);
  expect(db.settings.supplier_dir.find(x => x.n === 'PT Kurma Nusantara')).toEqual(expect.objectContaining({ pl: 'Surabaya, Jawa Timur', by: 'Jihan', ub: 'Jihan' }));
  expect(db.activity.filter(a => a.kind === 'notifikasi').pop().summary).toBe('Data pemasok PT Kurma Nusantara diubah — tempat: Surabaya, Jawa Timur — oleh manajer Jihan');
  await closeModals(page);
  // goods-in: the supplier box offers the directory's names (one with no note yet too)
  await nav(page, 'purchases');
  await expect(page.locator('#dl-sup option[value="Toko Kacang Haji Umar"]')).toHaveCount(1);
});

test('Arabic: the supplier form reads in Arabic', async ({ page }) => {
  await login(page, 'Jihan', '2222');
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'suppliers');
  await expect(page.locator('#sd-new')).toContainText('مورد جديد');
  await page.click('#sd-new');
  await expect(page.locator('#sd-form')).toContainText('المهنة / النشاط');
  await expect(page.locator('#sd-form')).toContainText('المواد التي يبيعها');
  await expect(page.locator('#sd-form')).toContainText('اسم الشركة');
});

async function H_shot(page) { await page.evaluate(() => document.querySelectorAll('.toast').forEach(x => x.remove())); await page.screenshot({ path: path.join(SHOTS, 'supplier-dir.png') }); }
