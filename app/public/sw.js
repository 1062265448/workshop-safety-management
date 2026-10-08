/* 车间安全管理系统 Service Worker
 * 策略：
 *  - 页面导航（index.html）：network-first，保证拿到最新版本，离线时回退缓存
 *  - 带哈希的静态资源（/assets/…）：cache-first（内容随哈希变化，可长期缓存）
 *  - /api、/uploads 与非 GET：一律走网络，绝不缓存（隐患数据与照片必须实时）
 */
const CACHE_NAME = 'wsms-static-v3';
const PRECACHE = ['/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API、照片与非 GET 请求：直接走网络，不缓存
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/uploads') || event.request.method !== 'GET') {
    return;
  }

  // 页面导航：network-first（更新后立即生效），离线回退缓存的 index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone));
          }
          return resp;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 静态资源：cache-first，未命中则回源并写入缓存
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok && url.origin === self.location.origin) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      });
    })
  );
});
