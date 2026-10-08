const CACHE_NAME = 'ameen-pwa-v2';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/pwa-icon.svg'];

// Only these request destinations represent static application resources.
// API/data requests are intentionally excluded from the Service Worker cache.
const STATIC_DESTINATIONS = new Set([
  'script',
  'style',
  'image',
  'font',
  'manifest',
  'worker',
  'sharedworker'
]);

const API_PREFIXES = ['/api', '/api/'];

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;

  // Never cache application/API responses or other dynamic endpoints.
  if (API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return false;

  // The SPA shell is explicitly cacheable for offline navigation.
  if (APP_SHELL.includes(url.pathname)) return true;

  // Cache only requests that the browser identifies as static resources.
  return STATIC_DESTINATIONS.has(request.destination);
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (!isCacheableRequest(event.request)) return;

  const request = event.request;
  event.respondWith(
    fetch(request).then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
  );
});
