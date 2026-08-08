// 缓存策略：版本号（由 release.js 按文件内容自动计算）作为更新闸门。
// - 版本号不变 → 直接命中本地缓存：秒开、零流量、可离线。
// - 版本号变化（任意源文件改动后由 release.js 重新计算）→ 浏览器安装新 SW、预缓存新文件，
//   用户点「立即更新」或下次打开即生效。
// 推送前运行 `node release.js` 即可自动更新版本号，无需手动改这里的数字。
const CACHE = "ad-install-v3c47fe5a";
const VERSION = "v3c47fe5a";

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./help.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

// 同源 GET 请求统一走下方「缓存优先」策略。


self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((url) => c.add(url).catch((err) => console.warn("预缓存失败:", url, err)))))
      .then(() => {
        // 通知当前已打开的页面：有新版本待更新（新 SW 停在 waiting，等用户点「立即更新」才接管）
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
          clients.forEach((client) => client.postMessage({ type: "VERSION_UPDATED", version: VERSION }));
        });
        // 注意：此处不再调用 self.skipWaiting()，避免新 SW 一下载就自动激活接管，
        // 导致旧 app.js 收到重复广播而反复弹出更新横幅。是否接管由前端「立即更新」触发。
      })
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
      self.clients.claim()
    ])
  );
});

// 缓存优先：版本号未变时直接命中本地缓存（秒开、零流量、可离线）；
// 仅在缓存未命中时才回源，并把结果写入缓存供下次使用。
// 关键点：只匹配「当前 SW 自己版本的缓存」，绝不跨旧缓存命中。
// 否则新 SW 接管后 reload 会跨缓存命中「旧 app.js」，导致 APP_VERSION 与 controller 版本
// 永远不一致，更新弹窗陷入死循环（点了立即更新仍弹）。
let _cacheReady = null;
function getActiveCache() {
  if (!_cacheReady) _cacheReady = caches.open(CACHE);
  return _cacheReady;
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    getActiveCache().then((cache) =>
      cache.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res && res.ok && res.type === "basic") {
              const copy = res.clone();
              cache.put(req, copy);
            }
            return res;
          })
          .catch(() => (req.mode === "navigate" ? cache.match("./index.html") : undefined));
      })
    )
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "GET_VERSION") {
    e.ports[0].postMessage({ type: "VERSION_RESPONSE", version: VERSION });
  }
  if (e.data && e.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
