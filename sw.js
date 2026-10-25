/* 전담 콜북 — 오프라인 캐시. 앱 파일을 바꾸면 VERSION을 올리세요. */
const VERSION = 'callbook-v4';
const FONT_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const SHELL = ['./', 'index.html', 'engine.js', 'app.js', 'xlsxw.js', 'admin.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method === 'GET' && FONT_HOSTS.includes(u.hostname)) { // 글꼴: 한 번 받으면 오프라인에서도
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const c = res.clone(); caches.open(VERSION).then(x => x.put(e.request, c)); return res; })));
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/data/')) return; // 데이터·외부 API는 항상 네트워크
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
