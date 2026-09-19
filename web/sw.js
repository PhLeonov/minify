// BUILD_VERSION заменяется хешем файлов во время сборки.
// Новая версия ждёт закрытия старых окон: так JS и Go WASM обновляются вместе.
const PREFIX = 'minify-' + encodeURIComponent(self.registration.scope) + '-';
const CACHE = PREFIX + '__BUILD_VERSION__';
const ASSETS = ['./', './index.html', './style.css', './app.js', './worker.js', './wasm_exec.js', './minify.wasm', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const urls = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  // Удаляем только кеши Minify в области этого приложения, не кеши чужих сайтов.
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  const isStart = event.request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html');
  if (!urls.has(url.href) && !isStart) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(isStart ? self.registration.scope : event.request) || fetch(event.request);
  })());
});
