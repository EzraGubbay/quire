/* Quire service worker: cache-first for static assets, network-first for pages with an offline fallback.
   Bump VERSION to drop old caches after a deploy. */
const VERSION = 'quire-v1';
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((c) => c.add(OFFLINE_URL).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API, auth, or file streams.
  if (url.pathname.startsWith('/api/')) return;
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/pdf.worker.min.mjs' ||
    /\.(woff2?|png|svg|ico|css|js)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches
            .open(PAGES)
            .then((c) => c.put(req, copy))
            .catch(() => {});
          return res;
        })
        .catch(
          async () => (await caches.match(req)) || (await caches.match(OFFLINE_URL)) || Response.error(),
        ),
    );
  }
});
