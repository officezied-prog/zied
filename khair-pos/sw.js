/* Khair Mart POS — offline shell cache. Network-first for the app page, cache fallback when offline.
   API calls (POST to n8n) are never cached or intercepted. */
const CACHE = 'khair-pos-v13';
const SHELL = ['./', './index.html', './styles.css', './mock.js', './manifest.webmanifest', './icon.svg', './shared/shop-types.js', './shared/docs.js', './shared/face.js', './shared/att-kiosk.js', './shared/chat-ui.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.indexOf('khair-pos-') === 0 && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const ownPage = url => { const root = new URL('./', self.registration.scope).pathname; return url.pathname === root || url.pathname === root + 'index.html'; };
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
    // Offline: the cached copy, else (only for this app's own page) the cached shell. Pages of the other apps
    // that live under this scope (gudang/, shown inside the owner app) must never get the owner page instead.
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (ownPage(url) ? caches.match('./index.html') : Response.error())))
  );
});
