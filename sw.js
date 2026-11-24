// Service worker for the Credit Card Payoff Tracker.
// - Opens offline: keeps a copy of the page, but always prefers the live version.
// - Shows due-date reminders sent by the cc-push Worker, even when the app is closed.

const CACHE = 'payoff-tracker-v4';
const SHELL = ['./', './index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network first for the page itself, so updates show up right away;
// fall back to the saved copy when offline. Everything else goes straight to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode !== 'navigate') return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const copy = fresh.clone();
      caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
      return fresh;
    } catch (e) {
      return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Payoff Tracker', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Payoff Tracker';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'payoff-reminder',
    renotify: true,
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); return; }
    }
    await self.clients.openWindow(target);
  })());
});
