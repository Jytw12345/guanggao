/* ============================================================
 * Service Worker —— 让系统可安装到桌面/主屏，并在离线时可用
 * 策略：应用外壳(app shell)走 stale-while-revalidate（先返回缓存、
 *       同时后台更新）；第三方请求(Supabase / CDN)一律走网络不缓存。
 * 每次改动前端资源时，把 CACHE 版本号 +1 即可让旧缓存失效。
 * ============================================================ */
const CACHE = "ad-install-v1";

/* 需要预缓存的应用外壳资源（相对路径，兼容子目录部署，如 GitHub Pages） */
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 仅接管同源资源；Supabase 数据、Supabase 实时、CDN 脚本等第三方请求直接走网络
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached || (req.mode === "navigate" ? caches.match("./index.html") : undefined));
      return cached || network;
    })
  );
});
