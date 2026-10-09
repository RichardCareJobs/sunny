// Sunny Service Worker — cache only same-origin static assets
// Bump this name when you want to flush old caches
const CACHE_NAME = 'sunny-v7';
const CORE_ASSETS = [
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/marker.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isGet = event.request.method === 'GET';
  const isStaticAsset =
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.webmanifest');

  if (isSameOrigin && isGet && isStaticAsset) {
    // Use a query-param-free key so versioned URLs (e.g. app.js?v=x) don't
    // accumulate as separate cache entries on every deploy.
    const cacheKey = new Request(url.origin + url.pathname);
    const isCode = /\.(html|js|css|webmanifest)$/.test(url.pathname);
    if (isCode) {
      // Network-first for code so a deploy reaches returning visitors
      // straight away; the cached copy is only an offline fallback.
      event.respondWith(
        fetch(event.request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
          }
          return resp;
        }).catch(() => caches.match(cacheKey).then((cached) => cached || Response.error()))
      );
      return;
    }
    // Images and other static files: cache-first.
    event.respondWith(
      caches.match(cacheKey).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
          }
          return resp;
        });
      })
    );
    return;
  }

  // All other requests (cross-origin API calls, etc.) pass through to the
  // network without SW interception — not calling event.respondWith() here
  // lets the browser handle them natively and prevents duplicate requests.
});
