// 軽量サービスワーカー: アプリの外枠（HTML/JS/CSS/アイコン）をキャッシュしてオフラインでも開けるように。
// /api/* は決してキャッシュしない（常にネットワーク・no-store）。
const CACHE = 'trip-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {}),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // API・地図タイル等の動的/外部リソースはSWを通さない（ネットワーク直）。
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // HTML（ナビゲーション）はネット優先・失敗時キャッシュ（更新を取りこぼさない）。
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || caches.match(req))),
    );
    return;
  }

  // 静的アセットはキャッシュ優先（速い）。無ければ取得してキャッシュ。
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit),
    ),
  );
});
