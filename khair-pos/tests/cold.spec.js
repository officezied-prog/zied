// Khair Gudang Dingin (gudang/?mock=1): demo login per role, dashboard alerts, daily check from pasted text and from an .xlsx
// report, pick order with FEFO → A4 / Word / Excel / WhatsApp → picked, truck, reverse a movement, owner app menu link.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { SHOTS, login } = require('./helpers');

const SAMPLE_TSV = fs.readFileSync(path.join(__dirname, '../backend/cold/sample-dpp.tsv'), 'utf8');
const SAMPLE_XLSX = path.join(__dirname, '../backend/cold/sample-dpp.xlsx');
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

async function coldLogin(page, user = 'Pemilik', pin = '1234') {
  await page.goto('gudang/index.html?mock=1');
  await page.evaluate(() => { try { localStorage.removeItem('kcold.mock.db'); } catch (e) { } });
  await page.reload();
  await page.fill('#lg-user', user);
  await page.fill('#lg-pin', pin);
  await page.click('#lg-go');
  await expect(page.locator('#nav')).toBeVisible();
}

test('owner: dashboard with three warehouses, expiry, missing checks, storage cost; explain a difference', async ({ page }) => {
  await coldLogin(page);
  await expect(page.locator('#who')).toContainText('Pemilik');
  await expect(page.locator('.kpi')).toHaveCount(3);
  await expect(page.locator('.kpi[data-wh="DPP"]')).toContainText('7 palet'); // 3619209 moved to Kawanishi
  await expect(page.locator('#al-exp tbody tr').first()).toBeVisible();
  await expect(page.locator('#al-exp tr[data-pallet="B-0104"]')).toBeVisible(); // Ajwa at Bosko, 20 days
  await expect(page.locator('#al-check [data-wh]')).toHaveCount(3);
  await expect(page.locator('#al-cost tr[data-wh="DPP"]')).toBeVisible();
  const diff = page.locator('#al-diff [data-check]');
  await expect(diff).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, 'cold-dashboard.png'), fullPage: true });
  await diff.locator('[data-act="explain"]').click();
  await page.fill('#ask-in', '2 ctn rusak, gudang sudah konfirmasi');
  await page.click('#ask-ok');
  await expect(page.locator('#al-diff [data-check]')).toHaveCount(0);
  // the stock report prints
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.click('#rep-print');
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('#print-area .kdoc h1')).toHaveText('LAPORAN STOK GUDANG DINGIN');
  await expect(page.locator('#print-area')).toContainText('Biaya sewa bulan ini');
});

test('daily check: pasted Excel copy shows differences, unknown and unread lines; saved; .xlsx file is read too', async ({ page }) => {
  await coldLogin(page, 'Jihan', '2222');
  await page.click('[data-tab="cek"]');
  await page.selectOption('#ck-wh', 'DPP');
  await page.fill('#ck-date', today());
  await page.fill('#ck-text', SAMPLE_TSV);
  await page.click('#ck-preview');
  const res = page.locator('#ck-result');
  await expect(res.locator('tr[data-key="2274537"] [data-diff]')).toHaveText('-6');   // they 280, we 286
  await expect(res.locator('tr[data-key="2274538"] [data-diff]')).toHaveText('+50');  // we 236 after the pick
  await expect(res.locator('tr[data-key="3619208"] [data-diff]')).toHaveText('0');
  await expect(res.locator('#ck-unknown')).toContainText('3619299');
  await expect(res.locator('#ck-missing')).toContainText('2274561');
  await expect(res.locator('#ck-unparsed')).toContainText('Catatan: palet 5 rusak sebagian');
  await expect(res.locator('#ck-import')).toHaveCount(0); // manager: no opening-stock import
  await page.click('#ck-save');
  await expect(page.locator('#ck-hist [data-check]').first()).toContainText('DPP Cold Storage');
  await expect(page.locator('#ck-result')).toHaveCount(0);
  // the same report as an .xlsx file
  await page.selectOption('#ck-wh', 'DPP');
  await page.fill('#ck-date', today());
  await page.setInputFiles('#ck-file', SAMPLE_XLSX);
  await expect(page.locator('#ck-result tr[data-key="2274537"] [data-diff]')).toHaveText('-6');
  await expect(page.locator('#ck-result #ck-unparsed')).toContainText('Catatan');
  await expect(page.locator('#ck-text')).toHaveValue(/2274538\t157-009/);
});

test('pick order: FEFO lines, A4 / Word / Excel / WhatsApp, truck, picked → stock out; cancel keeps it visible', async ({ page }) => {
  await coldLogin(page);
  await page.click('[data-tab="ord"]');
  await expect(page.locator('#or-list .order')).toHaveCount(1); // one open order in the demo
  await page.click('#or-new');
  await page.selectOption('#of-wh', 'DPP');
  await page.selectOption('#of-fp', 'SUKARI-3');
  await page.fill('#of-fc', '300');
  await page.click('#of-fefo');
  // 2274538 expires first; 100 of its 236 ctn are held by the open order
  await expect(page.locator('#of-lines tr')).toHaveCount(2);
  await expect(page.locator('#of-lines tr').nth(0).locator('[data-f="pallet_code"]')).toHaveValue('2274538');
  await expect(page.locator('#of-lines tr').nth(0).locator('[data-f="cartons"]')).toHaveValue('136');
  await expect(page.locator('#of-lines tr').nth(1).locator('[data-f="cartons"]')).toHaveValue('164');
  await page.fill('#of-pick', 'Wahyu');
  await page.click('#of-save');
  const card = page.locator('#or-list .order').filter({ hasText: '300 ctn' });
  await expect(card).toHaveCount(1);
  const no = (await card.getAttribute('data-no'));
  expect(no).toMatch(/^SPB-\d{6}-\d{3}$/);

  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await card.locator('[data-act="a4"]').click();
  await expect(page.locator('#print-area .kdoc h1')).toHaveText('SURAT PENGAMBILAN BARANG');
  await expect(page.locator('#print-area')).toContainText(no);
  await expect(page.locator('#print-area .sig')).toContainText('Penerima');
  let [dl] = await Promise.all([page.waitForEvent('download'), card.locator('[data-act="doc"]').click()]);
  expect(dl.suggestedFilename()).toBe(no + '.doc');
  [dl] = await Promise.all([page.waitForEvent('download'), card.locator('[data-act="xls"]').click()]);
  expect(dl.suggestedFilename()).toBe(no + '.xls');
  const xml = fs.readFileSync(await dl.path(), 'utf8');
  expect(xml).toContain('<Data ss:Type="Number">164</Data>');
  await page.evaluate(() => { window.open = u => { window.__opened = u; }; });
  await card.locator('[data-act="wa"]').click();
  const wa = decodeURIComponent(await page.evaluate(() => window.__opened));
  expect(wa).toContain('https://wa.me/6281200000001?text=');
  expect(wa).toContain('PID 2274538');

  await card.locator('[data-act="truck"]').click();
  await expect(page.locator('#tk-sug')).toHaveText('Van / blind van'); // 300 ctn × 3 kg = 900 kg net ≈ 990 kg gross
  await page.selectOption('#tk-drv', '0');
  await expect(page.locator('#tk-driver')).toHaveValue('Pak Udin');
  await page.fill('#tk-cost', '350.000');
  await page.click('#tk-save');
  await expect(card.locator('[data-trip]')).toContainText('Rp 350.000');

  await card.locator('[data-act="pick"]').click();
  await page.click('#ask-ok');
  await page.selectOption('#or-st', 'picked');
  await expect(page.locator(`#or-list .order[data-no="${no}"]`)).toHaveAttribute('data-status', 'picked');
  await page.click('[data-tab="stok"]');
  await page.selectOption('#st-wh', 'DPP');
  await expect(page.locator('#st-tbl tr[data-pallet="2274538"] [data-ctn]')).toHaveText('100');
  await expect(page.locator('#st-tbl tr[data-pallet="2274537"] [data-ctn]')).toHaveText('122');

  await page.click('[data-tab="ord"]');
  await page.selectOption('#or-st', 'open');
  const open = page.locator('#or-list .order').first();
  await open.locator('[data-act="cancel"]').click();
  await page.fill('#ask-in', 'Toko masih ada stok');
  await page.click('#ask-ok');
  await page.selectOption('#or-st', 'cancelled');
  await expect(page.locator('#or-list .order[data-status="cancelled"]')).toHaveCount(1);
});

test('movements: transfer, then reverse it; reversed rows stay', async ({ page }) => {
  await coldLogin(page, 'Jihan', '2222');
  await page.click('[data-tab="stok"]');
  await page.locator('#st-tbl tr[data-pallet="K-77003"] [data-act="transfer"]').click();
  await page.selectOption('#tr-to', 'BOSKO');
  await page.fill('#tr-n', '50');
  await page.click('#tr-save');
  await expect(page.locator('#st-tbl tr[data-pallet="K-77003"][data-wh="BOSKO"] [data-ctn]')).toHaveText('50');
  await page.click('[data-tab="mut"]');
  const tr = page.locator('#mu-tbl tr[data-type="TRANSFER"]').first();
  await tr.locator('[data-act="reverse"]').click();
  await page.fill('#ask-in', 'Salah gudang');
  await page.click('#ask-ok');
  await expect(page.locator('#mu-tbl tr[data-type="REVERSE"]')).toHaveCount(2);
  await page.click('[data-tab="stok"]');
  await expect(page.locator('#st-tbl tr[data-pallet="K-77003"]')).toHaveCount(1);
  await expect(page.locator('#st-tbl tr[data-pallet="K-77003"] [data-ctn]')).toHaveText('250');
});

test('roles: akuntan reads everything but cannot change; manager has no settings or costs; kasir is refused', async ({ page }) => {
  await coldLogin(page, 'Akuntan', '3333');
  await expect(page.locator('#who')).toContainText('Hanya lihat');
  await expect(page.locator('#al-cost')).toBeVisible();
  await expect(page.locator('[data-tab="set"]')).toHaveCount(0);
  await page.click('[data-tab="stok"]');
  await expect(page.locator('#st-in')).toHaveCount(0);
  await expect(page.locator('[data-act="transfer"]')).toHaveCount(0);
  await page.click('[data-tab="ord"]');
  await expect(page.locator('#or-new')).toHaveCount(0);
  await page.click('[data-tab="cek"]');
  await page.fill('#ck-text', 'Sukari 3kg 10 ctn');
  await page.click('#ck-preview');
  await expect(page.locator('#ck-result')).toBeVisible();
  await expect(page.locator('#ck-save')).toHaveCount(0);

  await page.click('#logout');
  await page.fill('#lg-user', 'Jihan'); await page.fill('#lg-pin', '2222'); await page.click('#lg-go');
  await expect(page.locator('[data-tab="set"]')).toHaveCount(0);
  await expect(page.locator('#al-cost')).toHaveCount(0);

  await page.click('#logout');
  await page.fill('#lg-user', 'Siti'); await page.fill('#lg-pin', '1111'); await page.click('#lg-go');
  await expect(page.locator('#lg-msg')).toContainText('Hanya pemilik, manajer dan akuntan');
});

test('owner settings: add a warehouse; Arabic layout; the owner app menu opens Gudang Dingin with the same login', async ({ page }) => {
  await coldLogin(page);
  await page.click('[data-tab="set"]');
  await page.click('#wh-add');
  await page.fill('#wf-code', 'GD4');
  await page.fill('#wf-rate_frozen', '650.000');
  await page.fill('#wf-rate_dry', '250.000');
  await page.fill('#wf-name', 'Gudang <b>Baru</b>');
  await page.fill('#wf-pic_wa', '0812 3456 7890');
  await page.fill('#wf-rate_chiller', '500.000');
  await page.click('#wf-save');
  const row = page.locator('#set-wh tr[data-wh="GD4"]');
  await expect(row).toContainText('Gudang b Baru /b'); // < > removed, shown as text
  await expect(row).toContainText('6281234567890');
  await expect(row).toContainText('Rp 650.000');
  // a product without a code (the owner's first try): the code is made from the name; cartons per pallet kept
  await page.click('#pr-add');
  await page.fill('#pf-name', 'تمر سكري');
  await page.fill('#pf-kg', '3');
  await page.fill('#pf-cpp', '240');
  await page.click('#pf-save');
  await expect(page.locator('#set-pr tr[data-pr="P6"] [data-cpp]')).toHaveText('240');
  // a container with origin, product and cartons; it shows in Stok with its arrival and what is left
  await page.click('[data-tab="cont"]');
  await page.click('#ct-add');
  await page.fill('#ct-no', 'msku 123 4567');
  await page.selectOption('#ct-wh', 'BOSKO');
  await page.fill('#ct-origin', 'Tunisia');
  await page.selectOption('#ct-prod', 'P6');
  await page.fill('#ct-ctn', '1200');
  await page.click('#ct-save');
  await expect(page.locator('#ct-tbl tr[data-cont="MSKU1234567"]')).toContainText('Tunisia');
  await page.click('[data-tab="stok"]');
  await expect(page.locator('#st-cont tr[data-cont="CGMU5288973"]')).toContainText('Kurma Sukari 3kg');
  await expect(page.locator('#st-cont tr[data-cont="MSKU1234567"] [data-fin]')).toHaveText('masih ada');
  await page.click('[data-tab="set"]');
  await page.click('#lang');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('[data-tab="stok"]')).toHaveText('المخزون');
  await page.screenshot({ path: path.join(SHOTS, 'cold-settings-ar.png'), fullPage: true });
  await page.click('#lang');

  // owner app → menu → Gudang Dingin: no second login (same tab session)
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.click('#nav [data-view="cold"]');
  await expect(page).toHaveURL(/gudang\/\?mock=1/);
  await expect(page.locator('#who')).toContainText('Pemilik');
  await expect(page.locator('.kpi').first()).toBeVisible();
});
