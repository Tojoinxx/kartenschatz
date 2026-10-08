// Kartenschatz service worker: keeps the app itself available offline.
// Card images and the text-recognition files are left to the normal browser cache.
const VERSION = '1.0.0-202610081755';
const SHELL_CACHE = 'ks-shell-' + VERSION;
const SHELL = ['./', './index.html', './app.js', './app.css', './config.js', './archivo.woff2', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ks-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // revalidate with the server so updates (e.g. a new config.js) arrive right away
    const res = req.mode === 'navigate' ? await fetch(req) : await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(req));
});
