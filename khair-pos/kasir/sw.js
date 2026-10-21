/* Khair Kasir — offline shell cache for the cashier app only (scope ./ = khair-pos/kasir/).
   Network-first for the app files, cache fallback when offline. API calls (POST to n8n) are
   never cached or intercepted. The cache name is distinct from the owner app's ("khair-pos-v1"),
   and only old "khair-kasir-*" caches are removed on activate. */
const CACHE = 'khair-kasir-v37';
// ../shared/docs.js (A4 documents, v17), ../shared/chat-ui.js (chat, Phase 3) and ../shared/field-mock.js (field reps' orders, read-only) are outside this scope's folder but loaded by the page, so they are cached and served here too.
const SHELL = ['./', './index.html', './styles.css', './mock.js', './manifest.webmanifest', './icon.svg', '../logo.png', '../shared/docs.js', '../shared/face.js', '../shared/att-kiosk.js', '../shared/chat-ui.js', '../shared/field-mock.js', '../shared/gmaps-import.js', '../shared/tamper-guard.js', '../shared/install-btn.js', '../shared/barcode-cam.js', '../shared/app-update.js', '../shared/pin-guard.js', '../shared/pick.js', '../shared/pay-split.js', '../shared/bank-slip.js', '../shared/printer.js', '../shared/scan-wedge.js', '../vendor/zxing/zxing.min.js'];
// v49 (owner 2026-10-14: «لم تظهرت النسخة الجديدة»): pages and code are checked with the site on every fetch ("no-cache":
// a few bytes, "304", when unchanged), so the phone's 10-minute copy (GitHub Pages) never hides a new version. Images as before.
const fresh = (req, url) => {
  if (req.mode !== 'navigate' && !/(\/|\.(html|js|css|webmanifest|json))$/.test(url.pathname)) return req;
  try { return new Request(req, { cache: 'no-cache' }); } catch (e) { return req; } // a browser that refuses: as before
};
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' })))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('khair-kasir-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !(url.pathname.startsWith(new URL('./', self.registration.scope).pathname) || ['../shared/docs.js', '../shared/face.js', '../shared/att-kiosk.js', '../shared/chat-ui.js', '../shared/field-mock.js', '../shared/gmaps-import.js', '../shared/tamper-guard.js', '../shared/install-btn.js', '../shared/barcode-cam.js', '../shared/app-update.js', '../shared/pin-guard.js', '../shared/pick.js', '../shared/pay-split.js', '../shared/bank-slip.js', '../shared/printer.js', '../vendor/zxing/zxing.min.js'].some(f => url.pathname === new URL(f, self.registration.scope).pathname))) return;
  e.respondWith(
    fetch(fresh(req, url)).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(r => r || c.match('./index.html'))))
  );
});
