'use strict';

// El workflow de GitHub Pages reemplaza __BUILD_ID__ por el commit publicado,
// así cada despliegue crea una caché nueva y borra la anterior.
const CACHE = 'mi-bot-__BUILD_ID__';
const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'pwa.css',
  'app.js',
  'manifest.json',
  'vendor/qrcode.min.js',
  'vendor/jsQR.js',
  'data/payloads_generados.json',
  'assets/plantilla-hd.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' evita guardar copias viejas de la caché HTTP del navegador.
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('mi-bot-') && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (error) {
      if (request.mode === 'navigate') {
        const page = await cache.match('index.html');
        if (page) return page;
      }
      throw error;
    }
  })());
});
