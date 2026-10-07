// v17 attendance by face: workers without accounts, enrolment with consent, the shop-device screen,
// report with the chain check (wages only for the owner), monthly A4 / CSV, tamper detection. Faces: window.KFACE_STUB.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, login, getDb, nav, editDb } = require('./helpers');

test.use({ geolocation: { latitude: -6.27630, longitude: 106.85770 }, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { window.KFACE_STUB = { descriptor: null }; }); });
const face = (page, i) => page.evaluate(n => { window.KFACE_STUB.descriptor = n === null ? null : window.KAttMock.demoFace(n); }, i);

test('owner: seeded workers with wages, report verified, monthly A4 and CSV', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'absensi');
  await expect(page.locator('#att-w-tbl tbody tr')).toHaveCount(3);
  await expect(page.locator('#att-w-tbl tr').filter({ hasText: 'Budi Santoso' }).locator('[data-wage]')).toHaveText('Rp 120.000');
  await expect(page.locator('#att-w-tbl [data-face="1"]')).toHaveCount(3);
  await page.click('[data-act="att-preset"][data-p="7d"]');
  await expect(page.locator('#att-verify')).toHaveAttribute('data-ok', '1');
  await expect(page.locator('#att-verify')).toContainText('Data utuh');
  const budi = page.locator('#att-tot tr').filter({ hasText: 'Budi Santoso' });
  // last 7 days incl. today: Budi absent 4 days ago and (not yet) today
  await expect(budi.locator('[data-present]')).toHaveText('5');
  await expect(budi.locator('[data-due]')).toHaveText('Rp 600.000');
  const slamet = page.locator('#att-tot tr').filter({ hasText: 'Slamet Riyadi' });
  expect(Number(await slamet.locator('[data-late]').innerText().then(s => s.split(' ')[0]))).toBeGreaterThan(0);
  await expect(page.locator('#att-events [data-kind="fail"]').first()).toBeAttached();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-absensi.png'), fullPage: true });

  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.click('#att-print');
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('#print-area .kdoc h1')).toHaveText('LAPORAN ABSENSI');
  await expect(page.locator('#print-area')).toContainText('TOTAL UPAH');
  await expect(page.locator('#print-area')).toContainText('Data utuh');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#att-csv')]);
  expect(dl.suggestedFilename()).toMatch(/^absensi-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('add a worker → consent → face enrolled; kiosk: in, double tap, wrong face, out-of-shop', async ({ page, context }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'absensi');
  await page.click('#att-add');
  await page.fill('#aw-name', 'Joko Susilo');
  await page.fill('#aw-job', 'Kuli angkut');
  await page.fill('#aw-wage', '100.000');
  await page.click('#aw-save');
  const k = page.locator('#att-kiosk.kak');
  await expect(k).toContainText('Daftarkan wajah: Joko Susilo');
  await face(page, 7);
  await k.locator('#kak-start').click();
  await expect(k.locator('#kak-msg')).toHaveText('Centang persetujuan pekerja dulu');
  await k.locator('#kak-consent').check();
  await k.locator('#kak-start').click();
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '1');
  await k.locator('#kak-done').click();
  await expect(page.locator('#att-w-tbl tr').filter({ hasText: 'Joko Susilo' }).locator('[data-face="1"]')).toBeVisible();
  let db = await getDb(page);
  const joko = db.att.workers.find(w => w.name === 'Joko Susilo');
  expect(joko).toMatchObject({ daily_wage: 100000, consent_by: 'Pemilik' });
  expect(db.att.records.slice(-1)[0]).toMatchObject({ kind: 'enroll', worker_name: 'Joko Susilo' });
  // the same face cannot be enrolled for another worker
  await page.locator('#att-w-tbl tr').filter({ hasText: 'Budi Santoso' }).locator('[data-act="att-enroll"]').click();
  await face(page, 7);
  await k.locator('#kak-consent').check();
  await k.locator('#kak-start').click();
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '0');
  await expect(k).toContainText('sudah terdaftar atas nama Joko Susilo');
  await k.locator('#kak-close').click();

  await context.setGeolocation({ latitude: -6.30, longitude: 106.86 }); // 3.7 km away
  await page.click('#att-kiosk');
  await expect(k.locator('.kak-w')).toHaveCount(4);
  await face(page, 0);
  await k.locator('.kak-w', { hasText: 'Budi Santoso' }).click();
  await expect(k.locator('#kak-result')).toContainText('Absen hanya di toko');
  await k.locator('#kak-close').click();
  await context.setGeolocation({ latitude: -6.27630, longitude: 106.85770 });
  await page.evaluate(() => new Promise(r => navigator.geolocation.getCurrentPosition(r, r, { maximumAge: 0 }))); // fresh fix in the shop
  await page.click('#att-kiosk');
  await expect(k.locator('.kak-w')).toHaveCount(4);
  await face(page, 7);
  await k.locator('.kak-w', { hasText: 'Joko Susilo' }).click();
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '1');
  await expect(k.locator('#kak-result .big')).toContainText('MASUK');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-absensi-kiosk.png') });
  await expect(k.locator('.kak-w', { hasText: 'Joko Susilo' })).toContainText('Masuk', { timeout: 8000 });
  await k.locator('.kak-w', { hasText: 'Joko Susilo' }).click(); // double tap: nothing new
  await expect(k.locator('#kak-result')).toContainText('barusan');
  await expect(k.locator('.kak-w').first()).toBeVisible({ timeout: 8000 });
  await face(page, 7); // Joko's face on Budi's name
  await k.locator('.kak-w', { hasText: 'Budi Santoso' }).click();
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '0');
  await expect(k.locator('#kak-result')).toContainText('Wajah tidak cocok dengan Budi Santoso');
  db = await getDb(page);
  const last = db.att.records.slice(-3).map(r => r.kind + ':' + r.worker_name + (r.note ? ':' + r.note.split(' (')[0] : ''));
  expect(last).toEqual(['fail:Budi Santoso:di luar toko', 'in:Joko Susilo', 'fail:Budi Santoso:wajah tidak cocok']);
  await k.locator('#kak-close').click();
  await expect(page.locator('#att-today-tbl tr').filter({ hasText: 'Joko Susilo' })).toContainText(/Hadir|Terlambat/); // depends on the clock
});

test('manager: attendance and hours only — no wages, no settings, cannot delete faces', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'absensi');
  await expect(page.locator('#att-w-tbl tbody tr')).toHaveCount(3);
  await expect(page.locator('#att-w-tbl [data-wage]')).toHaveCount(0);
  await expect(page.locator('#att-w-tbl [data-act="att-forget"]')).toHaveCount(0);
  await expect(page.locator('#att-set')).toHaveCount(0);
  await expect(page.locator('#att-tot [data-due]')).toHaveCount(0);
  await expect(page.locator('#att-tot tbody tr').first()).toBeVisible();
  await page.click('#att-add');
  await expect(page.locator('#aw-wage')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const r = await page.evaluate(async () => { try { await api('worker_save', { name: 'X Y', daily_wage: 1 }, { att: true }); return 'ok'; } catch (e) { return e.code; } });
  expect(r).toBe('FORBIDDEN');
});

test('a changed or deleted record shows as a warning in the report; settings with the pre-Ramadan season', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'absensi');
  await page.click('[data-act="att-preset"][data-p="7d"]'); // the edited rows are in the last week
  await expect(page.locator('#att-verify')).toHaveAttribute('data-ok', '1');
  // someone edits the stored data directly: Slamet's late check-in becomes 07:59
  await editDb(page, `const r = db.att.records.filter(x => x.worker_name === 'Slamet Riyadi' && x.kind === 'in' && x.at.slice(11, 16) === '01:40').pop(); r.at = r.at.slice(0, 11) + '00:59:00.000Z';`);
  await page.click('#att-load');
  await expect(page.locator('#att-verify')).toHaveAttribute('data-ok', '0');
  await expect(page.locator('#att-issues')).toContainText('diubah');
  await editDb(page, `const r = db.att.records.filter(x => x.worker_name === 'Slamet Riyadi' && x.kind === 'in' && x.at.slice(11, 16) === '00:59').pop(); r.at = r.at.slice(0, 11) + '01:40:00.000Z';`);
  await page.click('#att-load');
  await expect(page.locator('#att-verify')).toHaveAttribute('data-ok', '1');
  await editDb(page, `const i = db.att.records.map(x => x.kind).lastIndexOf('fail'); db.att.records.splice(i, 1);`);
  await page.click('#att-load');
  await expect(page.locator('#att-verify')).toHaveAttribute('data-ok', '0');

  await page.fill('#att-se-name', 'Menjelang Ramadan');
  await page.fill('#att-se-from', '2026-12-08');
  await page.fill('#att-se-to', '2027-03-09');
  await page.fill('#att-se-end', '23:00');
  await page.click('#att-save-set');
  await expect(page.locator('.toast.ok')).toBeVisible();
  const db = await getDb(page);
  expect(db.att.settings.att_seasons).toEqual([{ name: 'Menjelang Ramadan', from: '2026-12-08', to: '2027-03-09', work_end: '23:00' }]);
  expect(db.att.records.slice(-1)[0]).toMatchObject({ kind: 'setting' });
});
