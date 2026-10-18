// v36 (owner 2026-10-11) — Khair Gudang Dingin (gudang/?mock=1):
//  • the pick order (A4 / Word, Excel, share file, WhatsApp text) carries the CONTAINER number, the truck PLATE and whether
//    each line is a FULL PALLET or only some cartons of it;
//  • «في أمر جديد يُسجَّل الزبون دائمًا مع العنوان والهاتف وتخرج قائمة بالزبائن»: the order form always shows the customer list
//    (also while it is empty) with "+ new customer" and a phone field, and every customer order saves its customer to the list.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { login } = require('./helpers');

async function coldLogin(page, user = 'Pemilik', pin = '1234') {
  await page.goto('gudang/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kcold.mock.db'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', user);
  await page.fill('#lg-pin', pin);
  await page.click('#lg-go');
  await expect(page.locator('#nav')).toBeVisible();
}

test('order documents: container number, plate and full pallet vs cartons in A4, Word, Excel and WhatsApp', async ({ page }) => {
  await coldLogin(page);
  await page.evaluate(() => { window.open = u => { window.__opened = u; }; window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.click('[data-tab="ord"]');
  await page.click('#or-new');
  await page.selectOption('#of-wh', 'DPP');
  const rows = page.locator('#of-lines tr');
  await rows.nth(0).locator('[data-f="pallet_code"]').selectOption('2274561'); // Ruthab, 286 ctn, nothing reserved
  await rows.nth(0).locator('[data-f="full"]').click(); // take the whole pallet
  await expect(rows.nth(0).locator('[data-f="cartons"]')).toHaveValue('286');
  await expect(rows.nth(0).locator('[data-f="full"]')).toHaveClass(/pri/);
  await page.click('#of-add');
  await rows.nth(1).locator('[data-f="pallet_code"]').selectOption('3619210'); // Medjool, 120 ctn
  await rows.nth(1).locator('[data-f="cartons"]').fill('20');
  await expect(rows.nth(1).locator('[data-f="full"]')).not.toHaveClass(/pri/);
  await page.fill('#of-pick', 'Wahyu');
  await page.fill('#of-veh', 'Engkel (CDE)');
  await page.fill('#of-plate', 'b 9123 kxt');
  await page.click('#of-save');
  const card = page.locator('#or-list .order').filter({ hasText: '306 ctn' });
  await expect(card).toHaveCount(1);
  const no = await card.getAttribute('data-no');
  // the card lists each pallet with its container and the full-pallet mark
  await expect(card.locator('[data-pl="2274561"]')).toHaveAttribute('data-full', '1');
  await expect(card.locator('[data-pl="2274561"]')).toContainText('CGMU5288973');
  await expect(card.locator('[data-pl="2274561"]')).toContainText('Palet utuh');
  await expect(card.locator('[data-pl="3619210"]')).toHaveAttribute('data-full', '0');
  await expect(card.locator('[data-plate]')).toContainText('B 9123 KXT');

  // A4 / print (Word is the same HTML)
  await card.locator('[data-act="a4"]').click();
  const doc = page.locator('#print-area');
  await expect(doc.locator('th', { hasText: 'Kontainer' })).toHaveCount(1);
  await expect(doc.locator('tr[data-line="2274561"]')).toContainText('CGMU5288973');
  await expect(doc.locator('tr[data-line="2274561"]')).toContainText('PALET UTUH');
  await expect(doc.locator('tr[data-line="3619210"]')).toContainText('Sebagian (20 dari 120 ctn)');
  await expect(doc.locator('.plate')).toContainText('B 9123 KXT');
  await expect(doc).toContainText('1 palet utuh dari 2');
  let [dl] = await Promise.all([page.waitForEvent('download'), card.locator('[data-act="doc"]').click()]);
  const word = fs.readFileSync(await dl.path(), 'utf8');
  expect(word).toContain('CGMU5288973'); expect(word).toContain('PALET UTUH'); expect(word).toContain('B 9123 KXT');

  // Excel: container column, full-pallet column, vehicle + plate rows
  [dl] = await Promise.all([page.waitForEvent('download'), card.locator('[data-act="xls"]').click()]);
  expect(dl.suggestedFilename()).toBe(no + '.xls');
  const xml = fs.readFileSync(await dl.path(), 'utf8');
  expect(xml).toContain('<Data ss:Type="String">Kontainer</Data>');
  expect(xml).toContain('<Data ss:Type="String">CGMU5288973</Data>');
  expect(xml).toContain('<Data ss:Type="String">PALET UTUH</Data>');
  expect(xml).toContain('<Data ss:Type="String">Sebagian (20 dari 120 ctn)</Data>');
  expect(xml).toContain('<Data ss:Type="String">Plat nomor</Data></Cell><Cell><Data ss:Type="String">B 9123 KXT</Data>');
  expect(xml).toContain('<Data ss:Type="String">Engkel (CDE)</Data>');

  // the share-file path builds the same sheet (the desktop browser falls back to the download)
  [dl] = await Promise.all([page.waitForEvent('download'), card.locator('[data-act="share"]').click()]);
  expect(fs.readFileSync(await dl.path(), 'utf8')).toContain('<Data ss:Type="String">B 9123 KXT</Data>');

  // WhatsApp text to the warehouse
  await card.locator('[data-act="wa"]').click();
  const wa = decodeURIComponent(await page.evaluate(() => window.__opened));
  expect(wa).toContain('Plat nomor: B 9123 KXT');
  expect(wa).toContain('PID 2274561 — Kont. CGMU5288973');
  expect(wa).toContain('*PALET UTUH* (286 ctn)');
  expect(wa).toContain('20 ctn (sebagian palet)');

  // the truck form's plate (when the truck changes) wins in the documents
  await card.locator('[data-act="truck"]').click();
  await page.fill('#tk-plate', 'B 1111 ZZ');
  await page.fill('#tk-driver', 'Pak Baru');
  await page.click('#tk-save');
  await card.locator('[data-act="wa"]').click();
  expect(decodeURIComponent(await page.evaluate(() => window.__opened))).toContain('Plat nomor: B 1111 ZZ');
});

test('customers: the picker shows even when the list is empty; a new customer in an order is saved with address and phone, then picked', async ({ page }) => {
  await coldLogin(page, 'Jihan', '2222');
  // start from an EMPTY customer list (the owner's first order)
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('kcold.mock.db')); d.customers = []; localStorage.setItem('kcold.mock.db', JSON.stringify(d)); });
  await page.reload();
  await expect(page.locator('#nav')).toBeVisible();
  await page.click('[data-tab="cust"]');
  await expect(page.locator('#cu-tbl')).toHaveCount(0);
  await page.click('[data-tab="ord"]');
  await page.click('#or-new');
  await expect(page.locator('#of-cust')).toBeVisible();
  await expect(page.locator('#of-cu-auto')).toBeVisible();
  await page.selectOption('#of-cust', 'new');
  await expect(page.locator('#of-dtype')).toHaveValue('pelanggan');
  await page.fill('#of-dname', 'Toko Sumber Rezeki');
  await page.fill('#of-daddr', 'Jl. Kramat Jati 7, Jakarta Timur');
  await page.fill('#of-dphone', '0813 5555 6666');
  await page.selectOption('#of-wh', 'BOSKO');
  await page.locator('#of-lines tr').nth(0).locator('[data-f="pallet_code"]').selectOption('B-0102');
  await page.locator('#of-lines tr').nth(0).locator('[data-f="cartons"]').fill('10');
  await page.click('#of-save');
  await expect(page.locator('#or-list .order').filter({ hasText: 'Toko Sumber Rezeki' })).toHaveCount(1);
  // it is in the customer list with address and phone
  await page.click('[data-tab="cust"]');
  const row = page.locator('#cu-tbl tr', { hasText: 'Toko Sumber Rezeki' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Jl. Kramat Jati 7');
  await expect(row).toContainText('6281355556666');
  // next order: tap the customer → name, address and phone are filled
  await page.click('[data-tab="ord"]');
  await page.click('#or-new');
  const opt = await page.locator('#of-cust option', { hasText: 'Toko Sumber Rezeki' }).getAttribute('value');
  await page.selectOption('#of-cust', opt);
  await expect(page.locator('#of-dname')).toHaveValue('Toko Sumber Rezeki');
  await expect(page.locator('#of-daddr')).toHaveValue('Jl. Kramat Jati 7, Jakarta Timur');
  await expect(page.locator('#of-dphone')).toHaveValue('6281355556666');
  // a new address typed in this order updates the same customer (no duplicate)
  await page.fill('#of-daddr', 'Jl. Baru 2, Bekasi');
  await page.selectOption('#of-wh', 'BOSKO');
  await page.locator('#of-lines tr').nth(0).locator('[data-f="pallet_code"]').selectOption('B-0102');
  await page.locator('#of-lines tr').nth(0).locator('[data-f="cartons"]').fill('5');
  await page.click('#of-save');
  await page.click('[data-tab="cust"]');
  await expect(page.locator('#cu-tbl tr', { hasText: 'Toko Sumber Rezeki' })).toHaveCount(1);
  await expect(page.locator('#cu-tbl tr', { hasText: 'Toko Sumber Rezeki' })).toContainText('Jl. Baru 2');
  // Arabic labels exist for the new fields
  await page.click('[data-tab="ord"]');
  await page.click('#lang');
  await page.click('#or-new');
  await expect(page.locator('#of-cu-auto')).toContainText('يُحفظ زبون هذا الأمر');
  await expect(page.locator('#of-cust option[value="new"]')).toContainText('زبون جديد');
});

// v36 (owner 2026-10-11: «أريد الدردشة مع كل الفريق المسجل وكل من له يحمل هذا التطبيق»): the cold-storage page opened on its own
// has the same team chat; inside the owner app it does not add a second launcher (the owner app's chat is there).
test('cold page on its own: team chat with a private room; inside the owner app no second launcher', async ({ page }) => {
  await coldLogin(page, 'Akuntan', '3333');
  await page.evaluate(() => { try { localStorage.removeItem('kcold.chat.db'); } catch (e) { } });
  const fab = page.locator('.kchat-fab');
  await expect(fab).toBeVisible();
  await fab.click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  for (const n of ['Pemilik', 'Jihan', 'Siti']) await expect(page.locator(`.kchat-member[data-name="${n}"]`)).toBeVisible();
  await expect(page.locator('.kchat-member[data-name="Akuntan"]')).toHaveCount(0);
  await page.locator('.kchat-member[data-name="Jihan"]').click();
  await page.locator('.kchat-ta').fill('Jihan, laporan stok DPP sudah saya cek.');
  await page.locator('.kchat-ic.send').click();
  await expect(page.locator('.kchat-msg.me').last()).toContainText('laporan stok DPP');
  await expect(page.locator('.kchat-msg.me').last()).not.toHaveClass(/pending|failed/);
  await page.locator('.kchat-x').click();
  await page.click('#logout');
  await expect(fab).toHaveCount(0); // stopped on logout
  // Jihan logs in on the same page: the private note waits for her with a badge
  await page.fill('#lg-user', 'Jihan'); await page.fill('#lg-pin', '2222'); await page.click('#lg-go');
  await expect(page.locator('.kchat-fab .kchat-badge')).toBeVisible();
  await page.locator('.kchat-fab').click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  await expect(page.locator('.kchat-member[data-name="Akuntan"] .kchat-mbadge')).toHaveText('1');
  // embedded in the owner app (same-site frame): the owner app's launcher only, none inside the frame
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.click('#nav [data-view="cold"]');
  const cold = page.frameLocator('#cold-frame');
  await expect(cold.locator('.kpi').first()).toBeVisible();
  await expect(page.locator('.kchat-fab')).toHaveCount(1);
  await expect(cold.locator('.kchat-fab')).toHaveCount(0);
});
