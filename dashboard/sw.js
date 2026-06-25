const CACHE_VERSION = '2026-06-25.trader-dashboard-shell.1';
const SHELL_CACHE = `trader-dashboard-shell-${CACHE_VERSION}`;
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/status',
  '/status.html',
  '/policy',
  '/policy.html',
  '/exit-rules',
  '/exit-rules.html',
  '/alerts',
  '/alerts.html',
  '/control',
  '/control.html',
  '/styles.css',
  '/app.js',
  '/status.js',
  '/policy.js',
  '/exit-rules.js',
  '/alerts.js',
  '/control.js',
  '/mobile.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const NO_CACHE_PREFIXES = [
  '/api',
  '/ws',
  '/events',
  '/stream',
  '/orders',
  '/positions',
  '/account',
  '/broker',
  '/scanner',
  '/health',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (NO_CACHE_PREFIXES.some((prefix) => requestUrl.pathname === prefix || requestUrl.pathname.startsWith(`${prefix}/`))) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put(event.request, response.clone());
        return response;
      } catch {
        const cached = await caches.match('/index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  if (['style', 'script', 'image', 'font'].includes(event.request.destination) || SHELL_ASSETS.includes(requestUrl.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      const cache = await caches.open(SHELL_CACHE);
      cache.put(event.request, response.clone());
      return response;
    })());
  }
});
