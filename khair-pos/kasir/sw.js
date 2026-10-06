/* Khair Kasir — offline shell cache for the cashier app only (scope ./ = khair-pos/kasir/).
   Network-first for the app files, cache fallback when offline. API calls (POST to n8n) are
   never cached or intercepted. The cache name is distinct from the owner app's ("khair-pos-v1"),
   and only old "khair-kasir-*" caches are removed on activate. */
const CACHE = 'khair-kasir-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('khair-kasir-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(r => r || c.match('./index.html'))))
  );
});
