/* TamanGuard Service Worker — v1 */
const CACHE = 'tamanguard-v1';
const SHELL = [
  '/resident.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/logo.jpg'
];

/* Pre-cache app shell on install */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

/* Activate: clean old caches, take control */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Fetch: cache-first for app shell, network-first for everything else */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  /* Only handle same-origin requests */
  if (url.origin !== self.location.origin) return;

  /* App shell files — cache first */
  if (SHELL.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
    return;
  }

  /* Everything else (Firebase, CDN assets) — network first, cache fallback */
  e.respondWith(
    fetch(e.request).then((res) => {
      const clone = res.clone();
      caches.open(CACHE).then((cache) => cache.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
