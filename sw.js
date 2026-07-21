// ⚠️ 每次把新版本上传到云端，【必须】把这里的版本号 +1（v146 → v147 → …）。
// 否则浏览器认为 sw.js 没变，永远不会安装新版本，客户端也就永远停留在旧程序。
const CACHE = "ad-install-v147";
const VERSION = "v147";

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./exceljs.min.js",
  "./manifest.webmanifest",
  "./help.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

// 应用外壳：每次都需要拿到最新代码，fetch 时走“网络优先”
const APP_SHELL = ["index.html", "app.js", "config.js", "styles.css"];
function isAppShell(url) {
  const file = url.pathname.split("/").pop();
  return APP_SHELL.includes(file) || url.pathname.endsWith("/");
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((url) => c.add(url).catch((err) => console.warn("预缓存失败:", url, err)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
      self.clients.claim()
    ]).then(() => {
      self.clients.matchAll({ type: "window" }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: "VERSION_UPDATED", version: VERSION });
        });
      });
    })
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 应用外壳：网络优先，保证上传新版本后客户端能立即拿到最新代码（不再serve旧缓存）
  if (isAppShell(url)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // 静态资源（图标、exceljs 等）：缓存优先 + 后台更新，保证离线可用
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

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "GET_VERSION") {
    e.ports[0].postMessage({ type: "VERSION_RESPONSE", version: VERSION });
  }
  if (e.data && e.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
