/* LottoPick Lab 서비스 워커: 앱 셸을 캐시해 오프라인에서도 열리도록 한다.
 * 버전을 올리면(CACHE_VERSION) 이전 캐시가 정리된다.
 * 주의: 서비스 워커는 HTTPS 또는 localhost 에서만 등록된다. */
const CACHE_VERSION = 'lottopick-v1';
const SHELL = [
  './index.html',
  './install.html',
  './app-config.js',
  './css/style.css',
  './js/engine.js',
  './js/app.js',
  './js/vendor/qrcode-generator.js',
  './data/draws.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 네트워크 우선, 실패하면 캐시 (항상 최신 데이터를 우선한다)
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === '/__lan') return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html')))
  );
});
