// Offline cache for the trainer page. Change CACHE when files change so phones pick up the update.
const CACHE = 'attendance-v0.1.0';
const FILES = ['./', 'index.html', 'app.js', 'config.js', 'jsQR.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Serve from cache at once (works offline), refresh the cache in the background when online.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then((resp) => {
      if (resp && resp.ok) cache.put(e.request, resp.clone());
      return resp;
    }).catch(() => null);
    e.waitUntil(network);
    return cached || (await network) || new Response('Offline', { status: 503 });
  }));
});
