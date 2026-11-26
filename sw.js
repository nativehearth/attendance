// Offline cache for the trainer page. VERSION must match the ?v= in index.html.
const VERSION = '0.6.0';
const CACHE = 'attendance-v' + VERSION;
const FILES = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'config.js?v=' + VERSION, 'jsQR.js?v=' + VERSION, 'sender.js?v=' + VERSION, 'app.js?v=' + VERSION];

// Background sending: Chrome fires 'sync' when the phone is online again, even if the app is closed.
self.window = self; // config.js writes to window.APP_CONFIG
try { importScripts('config.js?v=' + VERSION, 'sender.js?v=' + VERSION); } catch (e) { /* page still sends */ }
self.addEventListener('sync', (e) => {
  if (e.tag !== 'send' || typeof SENDER === 'undefined') return;
  e.waitUntil(SENDER.sendAll((self.APP_CONFIG || {}).API_URL)); // a failure makes Chrome retry later
});

// Install one complete set of files for this version, so the phone never mixes old and new files.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(FILES.map((f) => fetch(f, { cache: 'reload' }).then((r) => { if (!r.ok) throw new Error(f); return c.put(f, r); }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (fresh files when online); the installed set is used when offline or the network is slow.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const page = e.request.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await Promise.race([fetch(e.request), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
      if (net && net.ok && !page) cache.put(e.request, net.clone());
      return net;
    } catch (err) {
      return (await cache.match(page ? 'index.html' : e.request)) || new Response('Offline', { status: 503 });
    }
  })());
});
