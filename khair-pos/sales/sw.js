/* Khair Sales — offline shell cache for the field-sales app (scope ./ = khair-pos/sales/).
   Network-first for the app files (+ the shared shop-type list, the shared mock script and Leaflet from ../vendor/leaflet),
   cache fallback when offline. API calls (POST to n8n) and map tiles are never cached here.
   Only old "khair-sales-*" caches are removed on activate. */
const CACHE = 'khair-sales-v5';
const SHELL = ['./', './index.html', './styles.css', './mock.js', './manifest.webmanifest', './icon.svg', '../shared/shop-types.js', '../shared/field-mock.js', '../shared/chat-ui.js', '../vendor/leaflet/leaflet.js', '../vendor/leaflet/leaflet.css'];
self.addEventListener('install', e => {
  // one file at a time: a file that cannot be fetched (e.g. the map library) must not leave the whole shell uncached
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).catch(() => {}));
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
  const mine = url.origin === self.location.origin && (url.pathname.startsWith(scope) || /\/shared\/(field-mock|shop-types|chat-ui)\.js$/.test(url.pathname) || /\/vendor\/leaflet\//.test(url.pathname));
  if (!mine) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(r => r || (mine ? c.match('./index.html') : Response.error()))))
  );
});
