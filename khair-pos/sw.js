/* Khair Mart POS — offline shell cache. Network-first for the app page, cache fallback when offline.
   API calls (POST to n8n) are never cached or intercepted. */
const CACHE = 'khair-pos-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './shared/shop-types.js', './shared/docs.js', './shared/face.js', './shared/att-kiosk.js', './shared/chat-ui.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.indexOf('khair-pos-') === 0 && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // The cashier app under kasir/ has its own service worker and cache.
  if (url.pathname.indexOf(new URL('./kasir/', self.registration.scope).pathname) === 0) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
