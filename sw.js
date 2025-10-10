// Sunny Service Worker — network-first for HTML + code
// Bump this name when you want to flush old caches
const CACHE_NAME = 'sunny-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1) Always hit the network for top-level navigations (HTML) and .html files.
  //    Falls back to cache if offline.
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // 2) Always hit the network for the app code + version marker (so new deploys win)
  if (url.pathname.endsWith('/app.js') || url.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // 3) Everything else: simple cache-first (good for images, tiles, CSS)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      });
    })
  );
});
