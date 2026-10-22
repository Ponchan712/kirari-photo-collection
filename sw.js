// オフライン対応のService Worker
// 方針：通信できるときは常に最新のファイルを使い（network-first）、
// 通信できない・遅いときは保存済みのコピーで表示する。
// 所持データはIndexedDBにあり、ここでは扱わない（キャッシュ削除でも消えない）。
const VERSION = 'v1.4.1';
const CACHE = `kirari-${VERSION}`;
const CORE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/core.js',
  './data/series.json',
  './data/kirari_seed.json',
  './manifest.webmanifest',
  './icons/apple-touch-icon-v2.png',
  './icons/icon-192-v2.png',
  './icons/icon-512-v2.png',
  './icons/icon-maskable-512-v2.png',
  './icons/favicon-32-v2.png',
];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kirari-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    if (res.ok && res.type === 'basic') cache.put(stripQuery(req), res.clone());
    return res;
  } catch {
    const hit = (await cache.match(stripQuery(req))) ?? (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    if (hit) return hit;
    return new Response('オフラインのため表示できません', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// ?db=... などのクエリ付きでも同じファイルとして扱う
function stripQuery(req) {
  const u = new URL(req.url);
  if (!u.search) return req;
  u.search = '';
  return new Request(u.href);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
