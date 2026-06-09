// 軽量サービスワーカー: アプリの外枠（HTML/JS/CSS/アイコン）をキャッシュしてオフラインでも開けるように。
// 方針: 同一オリジンの資産は「ネット優先（デプロイを即反映）・失敗時のみキャッシュ」。
// ※ 以前は静的資産をキャッシュ優先で返していたため、デプロイしても古い app.js が
//    配信され続ける不具合があった（HTMLだけ新しく、JSが古いまま動く）。ネット優先に変更し、
//    キャッシュ名も更新して古いキャッシュ(trip-v1)を破棄する。
// /api/* は決してキャッシュしない（常にネットワーク・no-store）。
const CACHE = 'trip-v2';
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

  // ナビゲーション(HTML)はキー '/' に正規化してキャッシュする。
  const isNav = req.mode === 'navigate';
  const cacheKey = isNav ? '/' : req;

  // ネット優先: サーバーに更新確認(no-cache)して最新を配信＋キャッシュ更新。失敗時のみキャッシュ。
  // ブラウザのHTTPキャッシュに古い app.js が残っていても、ここで再検証して取りこぼさない。
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(cacheKey, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(cacheKey).then((hit) => hit || caches.match('/'))),
  );
});
