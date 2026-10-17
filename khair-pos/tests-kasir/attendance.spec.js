// v17 attendance in Khair Kasir: the shop device screen ("Lainnya → Absensi pekerja"); a kasir may record, never read reports.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { window.KFACE_STUB = { descriptor: null }; }); });

test('kasir opens the attendance screen; a worker checks in by face; reports stay closed to the kasir', async ({ page }) => {
  await H.login(page);
  await H.tab(page, 'more');
  await page.click('#m-att');
  const k = page.locator('#att-kiosk.kak');
  await expect(k.locator('.kak-w')).toHaveCount(3);
  await page.evaluate(() => { window.KFACE_STUB.descriptor = window.KAttMock.demoFace(1); });
  await k.locator('.kak-w', { hasText: 'Slamet Riyadi' }).click();
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '1');
  await expect(k.locator('#kak-result .big')).toContainText('MASUK');
  await H.shot(page, 'phone-70-absensi', false, { noToasts: true });
  const db = await H.getDb(page);
  expect(db.att.records.slice(-1)[0]).toMatchObject({ kind: 'in', worker_name: 'Slamet Riyadi', by_user: 'Siti', face_ok: true });
  const r = await page.evaluate(async () => { try { await api('att_report', { from: '2026-01-01', to: '2026-01-31' }, { att: true }); return 'ok'; } catch (e) { return e.code; } });
  expect(r).toBe('FORBIDDEN');
  await k.locator('#kak-close').click();
  await expect(k).toHaveCount(0);
});

test('Arabic attendance screen', async ({ page }) => {
  await H.login(page);
  await page.evaluate(() => { S.lang = 'ar'; });
  await H.tab(page, 'more');
  await page.click('#m-att');
  const k = page.locator('#att-kiosk.kak');
  await expect(k).toHaveAttribute('dir', 'rtl');
  await expect(k).toContainText('اضغط على اسمك');
  await H.shot(page, 'phone-71-absensi-ar', false, { noToasts: true });
});

// v59 (owner 2026-10-17: «لا يمكن استعمال الكميرا في تسجيل الحضور»): when the camera does not open, the screen says why and how to allow
// it (a refusal stays until it is changed in the browser's site settings), and "Coba lagi" checks the same worker in.
/** The real camera path: getUserMedia answers with these errors in turn, then a blank picture; the face reading stays a stand-in. */
async function camera(page, errors) {
  await page.evaluate(errs => {
    window.__gum = [];
    delete window.KFACE_STUB;
    KFace.load = () => Promise.resolve(true);
    KFace.read = () => Promise.resolve({ descriptor: KAttMock.demoFace(1), thumb: '', score: 0.99 });
    navigator.mediaDevices.getUserMedia = c => {
      window.__gum.push(c);
      const n = errs.shift();
      if (n) return Promise.reject(new DOMException('test', n));
      const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480; cv.getContext('2d').fillRect(0, 0, 640, 480);
      return Promise.resolve(cv.captureStream(5));
    };
  }, errors);
}
async function tapWorker(page) {
  await H.tab(page, 'more');
  await page.click('#m-att');
  const k = page.locator('#att-kiosk.kak');
  await k.locator('.kak-w', { hasText: 'Slamet Riyadi' }).click();
  return k;
}

test('v59 camera refused, inside the Khair Kasir app: why, the steps, a button to the camera permission; Coba lagi checks the same worker in', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('kprint.app', 'com.khairmart.kasir'); } catch (e) { } });
  await H.login(page);
  await camera(page, ['NotAllowedError']);
  await page.evaluate(() => { window.__go = []; KPrint.go = u => window.__go.push(u); });
  const k = await tapWorker(page);
  const help = k.locator('#kak-cam-help');
  await expect(help).toHaveAttribute('data-reason', 'denied');
  await expect(help).toContainText('Izin kamera ditolak di HP ini');
  await expect(help).toContainText('Tekan «Buka izin kamera» → Kamera → Izinkan');
  await expect(help).toContainText('Setelan situs → Kamera → ' + new URL(page.url()).host + ' → Izinkan'); // an older app: the Chrome way
  await expect(help).toContainText('Setelan HP → Aplikasi → Chrome → Izin → Kamera');
  await H.shot(page, 'phone-72-absensi-kamera', false, { noToasts: true });
  await help.locator('#kak-perm').click();
  expect(await page.evaluate(() => window.__go)).toEqual(['intent:site-settings#Intent;scheme=khairprint;package=com.khairmart.kasir;end;']);
  // allowed now → "Coba lagi" opens the camera again for the same worker
  await k.locator('#kak-again').click();
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '1');
  await expect(k.locator('#kak-result .big')).toContainText('MASUK');
  await expect(k.locator('#kak-result .who')).toHaveText('Slamet Riyadi');
  expect(await page.evaluate(() => window.__gum.length)).toBe(2); // a refusal is not asked twice in a row; the retry asks again
});

test('v59 a busy camera is tried again by itself; busy twice → "used by another app"; no front camera → any camera', async ({ page }) => {
  await H.login(page);
  await camera(page, ['NotReadableError']);
  let k = await tapWorker(page);
  await expect(k.locator('#kak-result')).toHaveAttribute('data-ok', '1');
  expect(await page.evaluate(() => window.__gum.length)).toBe(2);
  await k.locator('#kak-close').click();
  await camera(page, ['NotReadableError', 'NotReadableError']);
  k = await tapWorker(page);
  await expect(k.locator('#kak-cam-help')).toHaveAttribute('data-reason', 'busy');
  await expect(k.locator('#kak-cam-help')).toContainText('Kamera sedang dipakai aplikasi lain');
  await expect(k.locator('#kak-perm')).toHaveCount(0);
  await k.locator('#kak-close').click();
  await camera(page, ['OverconstrainedError']);
  const asked = await page.evaluate(() => KFace.startCamera(document.createElement('video')).then(s => { s.getTracks().forEach(t => t.stop()); return window.__gum; }));
  expect(asked[0].video.facingMode).toBe('user');
  expect(asked[1]).toEqual({ video: true, audio: false });
});

test('v59 Arabic, in Chrome (not the app): the steps through Chrome\'s site settings with this site\'s address, no app button', async ({ page }) => {
  await H.login(page);
  await page.evaluate(() => { S.lang = 'ar'; });
  await camera(page, ['NotAllowedError']);
  const k = await tapWorker(page);
  const help = k.locator('#kak-cam-help');
  await expect(help).toContainText('تم رفض إذن الكاميرا على هذا الهاتف');
  await expect(help).toContainText('إعدادات المواقع ← الكاميرا ← ' + new URL(page.url()).host + ' ← سماح');
  await expect(k.locator('#kak-perm')).toHaveCount(0);
  await expect(k.locator('#kak-again')).toHaveText('حاول مجددًا');
});
