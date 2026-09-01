// logTimer Service Worker
// キャッシュ名を変えると古いキャッシュを破棄して入れ替わる。
// このアプリの版数はここ1箇所だけ。ページ側もこの名前を聞きに来る（タイトルをタップしたときの更新確認）
const CACHE_NAME = 'logtimer-v6';

// アプリ本体（同一オリジン）。相対パスなのでサブディレクトリ配信でも動く
const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    './icon-180.png',
    './icon-192.png',
    './icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // 1つ失敗しても他は入れたいので個別に取得する
        await Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

// ページからの問い合わせと指示
self.addEventListener('message', (event) => {
    // 端末に入っている版を返す（更新の確認に使う）
    if (event.data === 'cache-name' && event.ports[0]) event.ports[0].postMessage(CACHE_NAME);
    // 待機中のまま止まらないように、新しい版へ入れ替える
    if (event.data === 'skip-waiting') self.skipWaiting();
});

// キャッシュに入れてよいレスポンスか（opaque はCDNのスクリプト等）
const isCacheable = (res) => res && (res.status === 200 || res.type === 'opaque');

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;

    // 自分自身（版の確認に使う）はキャッシュを挟まない。古い版を返すと更新に気づけない
    if (sameOrigin && url.pathname.endsWith('/service-worker.js')) return;

    // ページ遷移: まずネットワーク、失敗したらキャッシュ（更新を取りこぼさないため）
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const res = await fetch(req);
                if (isCacheable(res)) {
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(req, res.clone());
                }
                return res;
            } catch (e) {
                const cached = await caches.match(req);
                return cached || await caches.match('./index.html');
            }
        })());
        return;
    }

    if (sameOrigin) {
        // 自前のファイル: キャッシュを即返しつつ裏で更新する
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(req);
            const network = fetch(req).then((res) => {
                if (isCacheable(res)) cache.put(req, res.clone());
                return res;
            }).catch(() => null);
            return cached || await network || Response.error();
        })());
        return;
    }

    // CDN（React / Tailwind / Babel）: 一度取得したらキャッシュから返す＝オフラインでも起動する
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
            const res = await fetch(req);
            if (isCacheable(res)) cache.put(req, res.clone());
            return res;
        } catch (e) {
            return Response.error();
        }
    })());
});
