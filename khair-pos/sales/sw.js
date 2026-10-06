/* Khair Sales — offline shell cache for the field-sales app (scope ./ = khair-pos/sales/).
   Network-first for the app files (+ the shared mock script and the Leaflet files from cdnjs),
   cache fallback when offline. API calls (POST to n8n) and map tiles are never cached here.
   Only old "khair-sales-*" caches are removed on activate. */
const CACHE = 'khair-sales-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', '../shared/field-mock.js'];
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('khair-sales-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL('./', self.registration.scope).pathname;
  const mine = url.origin === self.location.origin && (url.pathname.startsWith(scope) || url.pathname.endsWith('/shared/field-mock.js'));
  if (!mine && !req.url.startsWith(LEAFLET)) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(r => r || (mine ? c.match('./index.html') : Response.error()))))
  );
});
