/* TamanGuard Service Worker — v8
 *
 * HISTORY / WHY THIS SHAPE
 * v7 and earlier served every shell file cache-FIRST, including the HTML. That meant a
 * deployed change stayed invisible until the browser happened to re-fetch sw.js, install
 * a new worker and rotate the cache — minutes to hours, and Cloudflare caches sw.js for
 * 600s on top of that. Three times in one day the answer to "I don't see the update" was
 * "your cache is stale", which is a design fault, not a user fault.
 *
 * Now:
 *   HTML  -> NETWORK FIRST, cache as offline fallback. A reload always shows the truth.
 *   static assets (icons, manifests, logo) -> cache first. They change almost never.
 *   everything else (Firebase, CDNs) -> network first, cache fallback.
 *
 * Offline still works: the last good HTML is in the cache and is used when the network
 * fails. What no longer happens is serving week-old HTML while online.
 */
const CACHE = 'tamanguard-v45';

/* Pre-cached so the app opens with no network at all */
const HTML = ['/resident.html', '/payments.html', '/guard.html', '/guard/index.html'];
const STATIC = [
  '/manifest.json',
  '/manifest-guard.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/logo.jpg'
];
const SHELL = HTML.concat(STATIC);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // leave Firebase/CDNs alone

  const accept = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || accept.includes('text/html') || url.pathname.endsWith('.html');

  if (isHTML) {
    /* A page is always worth a round-trip: it carries the current build. */
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => { });
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('/resident.html')))
    );
    return;
  }

  if (STATIC.includes(url.pathname)) {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => { });
        return res;
      }))
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => { });
        return res;
      })
      .catch(() => caches.match(req))
  );
});
