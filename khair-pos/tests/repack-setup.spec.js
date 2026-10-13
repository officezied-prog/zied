// v43 (owner 2026-10-13: «اختيار البضائع لاعادة التعبئة للمواد يقوم بها المدير ليس المالك و يصل اشعار للمالك و المحاسب»):
// in Gudang → Kemas ulang the manager chooses the pack product, its bulk source and how much goes in a pack (no product
// form); the owner and the accountant are told. The accountant does not get the panel.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, productByName, nav, asUser } = require('./helpers');

async function openRepackTab(page) {
  await nav(page, 'gudang');
  await page.click('[data-act="gd-tab"][data-tab="repack"]');
  await expect(page.locator('#rp-form')).toBeVisible();
}

test('the manager sets up a repack product in Gudang; the owner and the accountant are told; it can be changed and removed', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  const db0 = await getDb(page);
  const bulk = productByName(db0, /Gula Pasir/), pack = productByName(db0, /Kismis Hitam/);
  expect(Number(pack.repack_from) || 0).toBe(0);
  await openRepackTab(page);
  const panel = page.locator('#rp-setup');
  await expect(panel).toContainText('Atur barang kemas ulang');
  await expect(panel).toContainText('Pemilik dan akuntan diberi tahu');
  await page.selectOption('#rs-pack', String(pack.id));
  await page.selectOption('#rs-bulk', String(bulk.id));
  await expect(page.locator('#rs-unit')).toHaveText(bulk.unit);
  // nothing chosen as size → refused in the form
  await page.click('#rs-save');
  await expect(page.locator('#rs-err')).toContainText('isi per kemasan');
  await page.fill('#rs-qty', '0,5');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-repack-setup.png') });
  await page.click('#rs-save');
  await expect(page.locator('.toast.ok').filter({ hasText: 'Pengaturan kemas ulang disimpan' })).toBeVisible();
  let db = await getDb(page);
  expect(productByName(db, /Kismis Hitam/)).toMatchObject({ repack_from: bulk.id, repack_qty: 0.5 });
  const n = db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0];
  expect(n).toMatchObject({ ref: 'owner,akuntan', user: 'Jihan' });
  expect(n.summary).toContain(`Kemas ulang diatur: ${pack.name} dibuat dari ${bulk.name}, 0.5 ${bulk.unit} per ${pack.unit}`);
  // it shows up at once: in the list, under its bulk product, and in the repack form
  await expect(page.locator(`#rs-list tr[data-rs="${pack.id}"]`)).toContainText(bulk.name);
  await expect(page.locator(`#rp-bulks [data-bulk="${bulk.id}"] tr[data-pack="${pack.id}"]`)).toBeVisible();
  await expect(page.locator(`#rp-to option[value="${pack.id}"]`)).toHaveCount(1);
  // change: "Ubah" fills the form with the current setting
  await page.click(`#rs-list [data-act="rs-edit"][data-id="${pack.id}"]`);
  await expect(page.locator('#rs-bulk')).toHaveValue(String(bulk.id));
  await page.fill('#rs-qty', '0,25');
  await page.click('#rs-save');
  await expect.poll(async () => productByName(await getDb(page), /Kismis Hitam/).repack_qty).toBe(0.25);
  // remove
  await page.click(`#rs-list [data-act="rs-del"][data-id="${pack.id}"]`);
  await page.click('#cf-ok');
  await expect.poll(async () => Number(productByName(await getDb(page), /Kismis Hitam/).repack_from) || 0).toBe(0);
  await expect(page.locator(`#rs-list tr[data-rs="${pack.id}"]`)).toHaveCount(0);
  db = await getDb(page);
  expect(db.activity.filter(a => a.kind === 'notifikasi').slice(-1)[0].summary).toContain(`Kemas ulang dihapus: ${pack.name}`);
  // the server rules: a cashier and the accountant cannot set it
  for (const [u, pin] of [['Siti', '1111']]) expect((await asUser(page, u, pin, 'set_repack', { product_id: pack.id, repack_from: bulk.id, repack_qty: 1 })).error).toBe('FORBIDDEN');
});

test('the owner gets the same panel (the manager and the accountant are told); Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await openRepackTab(page);
  await expect(page.locator('#rp-setup')).toContainText('Manajer dan akuntan diberi tahu');
  await page.click('#tb-lang');
  await expect(page.locator('#rp-setup h3')).toContainText('ضبط بضائع إعادة التعبئة');
});
