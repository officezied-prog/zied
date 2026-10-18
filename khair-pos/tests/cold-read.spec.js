// v60 (owner 2026-10-17, stage 1b) — Khair Gudang Dingin (gudang/?mock=1): the order read from a photo of the written sheet
// («ورقة مكتوب فيها الكمية النوع رقم البلات و الكود للبضاعة») or from a customer's WhatsApp message. The form is filled as a draft
// (the pallet as written, else FEFO), what was not understood is listed, and the manager saves it as any order. The demo has
// no AI: a stand-in answers for the photo like the AI would; a pasted message is read by the server's fixed rules.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS } = require('./helpers');

// a real (tiny) PNG, so the page can open and shrink it like a phone photo
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4//8/AxJgYGBgAACQhAP9kw2fBQAAAABJRU5ErkJggg==', 'base64');
async function coldLogin(page) {
  await page.clock.setFixedTime(new Date('2026-10-14T10:00:00+07:00')); // a Wednesday, 10:00 WIB
  await page.goto('gudang/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kcold.mock.db'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', 'Jihan');
  await page.fill('#lg-pin', '2222');
  await page.click('#lg-go');
  await expect(page.locator('#nav')).toBeVisible();
}
const rows = page => page.locator('#of-lines tr').evaluateAll(trs => trs.map(tr => [tr.querySelector('[data-f="pallet_code"]').value, Number(tr.querySelector('[data-f="cartons"]').value)]));

test('a photo of the order sheet → the draft: cooler, customer, the written pallet, "1 palet" by FEFO, the unknown line listed; saved as an order', async ({ page }) => {
  await coldLogin(page);
  await page.click('[data-tab="ord"]');
  await page.click('#or-new');
  await page.click('#of-read summary');
  await expect(page.locator('#of-rd-hint')).toContainText('Foto kertas pesanan');
  await page.click('#of-rd-go'); // nothing chosen yet
  await expect(page.locator('#toast')).toHaveText('Pilih foto atau tempel pesan dulu');
  await page.setInputFiles('#of-rd-photo', { name: 'pesanan.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#of-rd-go');
  await expect(page.locator('#of-rd-note')).toHaveAttribute('data-by', 'demo');
  await expect(page.locator('#of-rd-sum')).toHaveText('3 baris terbaca → 2 palet di form · dibaca AI');
  await expect(page.locator('#of-wh')).toHaveValue('DPP');
  await expect(page.locator('#of-dname')).toHaveValue('Toko Barokah');
  await expect(page.locator('#of-dtype')).toHaveValue('pelanggan');
  const barokah = await page.evaluate(() => String(S.D.customers.find(c => c.name === 'Toko Barokah').id));
  await expect(page.locator('#of-cust')).toHaveValue(barokah);
  expect(await rows(page)).toEqual([['2274537', 40], ['3619208', 100]]); // 3619208: 121 ctn, 21 already booked by another order
  await expect(page.locator('#of-rd-un [data-reason="unknown"]')).toHaveText('Zahidi · 10 ctn — produk tidak dikenal');
  await expect(page.locator('#of-sum')).toHaveText('Total: 140 ctn');
  await page.evaluate(() => { document.querySelector('#toast').style.display = 'none'; });
  await page.screenshot({ path: path.join(SHOTS, 'cold-read-photo.png') });
  await page.click('#of-save');
  const card = page.locator('.order').first();
  await expect(card).toContainText('Toko Barokah');
  await expect(card).toContainText('2274537');
  await expect(card).toContainText('3619208');
});

test('a pasted WhatsApp message (no AI): the customer from the list, "besok", PID, FEFO in the cooler of the written pallet; an AI that is off is said', async ({ page }) => {
  await page.addInitScript(() => { window.KColdMockAI = false; }); // the owner has not added the AI key yet
  await coldLogin(page);
  await page.click('[data-tab="ord"]');
  await page.click('#or-new');
  await page.click('#of-read summary');
  await expect(page.locator('#of-rd-hint')).toHaveText('Pembaca foto (AI) belum aktif — pesan yang ditempel tetap dibaca.');
  // a photo cannot be read without the AI: it says so
  await page.setInputFiles('#of-rd-photo', { name: 'pesanan.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#of-rd-go');
  await expect(page.locator('#of-rd-err')).toContainText('Pembaca foto (AI) belum aktif');
  await page.setInputFiles('#of-rd-photo', []);
  await page.fill('#of-rd-text', 'Selamat pagi pak\nKirim ke Toko Al Amin besok ya\n1. Medjool 30 ctn\n2. PID K-77003 20 dus\n3. Mangga 2 ctn\nTerima kasih');
  await page.click('#of-rd-go');
  await expect(page.locator('#of-rd-note')).toHaveAttribute('data-by', 'rules');
  await expect(page.locator('#of-rd-sum')).toHaveText('3 baris terbaca → 2 palet di form · dibaca tanpa AI');
  await expect(page.locator('#of-wh')).toHaveValue('KAWANISHI');
  await expect(page.locator('#of-date')).toHaveValue('2026-10-15');
  await expect(page.locator('#of-dname')).toHaveValue('Toko Al Amin');
  expect(await rows(page)).toEqual([['K-77001', 30], ['K-77003', 20]]);
  await expect(page.locator('#of-rd-un [data-reason="unknown"]')).toHaveText('Mangga 2 ctn — produk tidak dikenal');
});

test('Arabic: the reading panel and its result', async ({ page }) => {
  await coldLogin(page);
  await page.evaluate(() => { S.lang = 'ar'; render(); });
  await page.click('[data-tab="ord"]');
  await page.click('#or-new');
  await page.click('#of-read summary');
  await expect(page.locator('#of-read summary')).toHaveText('📷 قراءة الطلبية من صورة أو رسالة واتساب');
  await page.setInputFiles('#of-rd-photo', { name: 'pesanan.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#of-rd-go');
  await expect(page.locator('#of-rd-sum')).toHaveText('قُرئ 3 سطر ← 2 بلات في النموذج · قرأها الذكاء الاصطناعي');
  await expect(page.locator('#of-rd-un [data-reason="unknown"]')).toHaveText('Zahidi · 10 ctn — صنف غير معروف');
  await page.screenshot({ path: path.join(SHOTS, 'cold-read-ar.png') });
});
