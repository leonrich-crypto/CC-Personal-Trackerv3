// Bump this version string every time you deploy a new version of the app,
// so the service worker knows to replace its cached copy. If you forget to
// bump it, the app will still work (network-first means online users always
// get the live version) -- this only affects the OFFLINE fallback copy.
const CACHE_VERSION = 'cc-tracker-v1';
const CACHE_NAME = `cc-tracker-cache-${CACHE_VERSION}`;

// Everything needed to load the app shell with no network connection.
const APP_SHELL = [
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache each shell resource independently (not with addAll, which is
      // all-or-nothing) so a failure on one -- e.g. the Chart.js CDN being
      // briefly unreachable -- doesn't prevent the core app page itself
      // from being cached for offline use.
      return Promise.allSettled(
        APP_SHELL.map((url) => {
          const isCrossOrigin = /^https?:\/\//.test(url);
          // Cross-origin resources are requested no-cors so a missing CORS
          // header on the CDN's end can't block caching an opaque copy.
          const req = isCrossOrigin ? new Request(url, { mode: 'no-cors' }) : url;
          return cache.add(req);
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith('cc-tracker-cache-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests for the app shell and its CDN dependency.
  // Supabase sync calls and anything else pass straight through to the
  // network untouched -- we never want to accidentally serve stale synced
  // data from a cache.
  const req = event.request;
  if (req.method !== 'GET') return;

  const isAppShellRequest =
    req.mode === 'navigate' ||
    req.url.endsWith('/index.html') ||
    req.url.includes('cdnjs.cloudflare.com/ajax/libs/Chart.js');

  if (!isAppShellRequest) return;

  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        // Online: always prefer the live version, and refresh the offline
        // fallback copy in the background so it stays reasonably current.
        const clone = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return networkRes;
      })
      .catch(() => {
        // Offline: fall back to whatever was last successfully cached.
        return caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
      })
  );
});
