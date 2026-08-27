const CACHE_NAME = 'mood-tracker-v6';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
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
  const url = event.request.url;

  // 날씨 API는 항상 네트워크로
  if (url.includes('open-meteo.com')) {
    event.respondWith(fetch(event.request).catch(() => new Response('{}')));
    return;
  }

  // Gist 동기화와 푸시 서버는 절대 캐시하지 않는다 (캐시되면 옛 데이터를 계속 읽게 됨)
  if (url.includes('api.github.com') || url.includes('gist.githubusercontent.com') || url.includes('.workers.dev')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// ============ 저녁 리마인더 푸시 ============
// 발송은 Cloudflare Worker(push-worker/)가 매일 20:00 KST에 한다.
// iOS는 홈화면에 추가한 웹앱에서만 푸시를 받을 수 있다.
self.addEventListener('push', (event) => {
  const fallback = {
    title: '오늘 하루를 짚어볼 시간',
    body: '1분이면 돼요',
    url: './'
  };
  let data = fallback;
  if (event.data) {
    try {
      data = Object.assign({}, fallback, event.data.json());
    } catch (e) {
      data = Object.assign({}, fallback, { body: event.data.text() || fallback.body });
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon.svg',
      badge: './icon.svg',
      tag: 'mood-reminder',
      renotify: true,
      data: { url: data.url }
    })
  );
});

// 알림을 탭하면 이미 열린 앱 창을 살리고, 없으면 새로 연다.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.includes('mood-tracker') && 'focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
