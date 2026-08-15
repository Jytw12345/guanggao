// 缓存策略：版本号（由 release.js 按文件内容自动计算）作为更新闸门。
// - 版本号不变 → 直接命中本地缓存：秒开、零流量、可离线。
// - 版本号变化（任意源文件改动后由 release.js 重新计算）→ 浏览器安装新 SW、预缓存新文件，
//   用户点「立即更新」或下次打开即生效。
// 推送前运行 `node release.js` 即可自动更新版本号，无需手动改这里的数字。
const CACHE = "ad-install-ve5ae109d";
const VERSION = "ve5ae109d";

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./vendor/supabase.min.js",
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

// 防御式缓存策略：版本号未变时命中本地缓存（秒开、零流量、可离线）；
// 缓存未命中或缓存被系统回收（安卓长时间后台常见）时回源网络并重新写入缓存；
// 网络也失败时用内置兜底页面兜底，确保「冷启动」绝不白屏。
// 关键点：只匹配「当前 SW 自己版本的缓存」，绝不跨旧缓存命中。
// 否则新 SW 接管后 reload 会跨缓存命中「旧 app.js」，导致 APP_VERSION 与 controller 版本
// 永远不一致，更新弹窗陷入死循环（点了立即更新仍弹）。
let _cacheReady = null;
function getActiveCache() {
  if (!_cacheReady) _cacheReady = caches.open(CACHE);
  return _cacheReady;
}

// 最后兜底页面：当缓存被系统回收且完全离线时，返回轻量页面而非纯白屏，
// 并给出「重新加载」按钮，联网后可一键恢复。
const OFFLINE_FALLBACK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>广告安装管理</title><style>
  html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#475569}
  .box{text-align:center;padding:24px}
  .box h1{font-size:18px;margin:0 0 8px;color:#1e293b}
  .box p{font-size:14px;margin:4px 0;line-height:1.6}
  .btn{margin-top:16px;padding:10px 20px;border:1px solid #6366f1;border-radius:8px;
    background:#6366f1;color:#fff;font-size:14px;cursor:pointer}
</style></head>
<body><div class="box">
  <h1>暂时无法连接到网络</h1>
  <p>应用资源未缓存，或缓存已被系统回收。</p>
  <p>请在联网后点击下方按钮重新加载。</p>
  <button class="btn" onclick="location.reload()">重新加载</button>
</div></body></html>`;

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(handleFetch(req));
});

async function handleFetch(req) {
  const isNav = req.mode === "navigate";
  let cache = null;
  try { cache = await getActiveCache(); } catch (_) { cache = null; }

  // 1) 先尝试命中当前版本缓存（导航与子资源都走这里，秒开/离线友好）
  if (cache) {
    try {
      const cached = await cache.match(req);
      if (cached) return cached;
    } catch (_) { /* 缓存读取异常，继续走网络 */ }
  }

  // 2) 缓存未命中（或被回收）→ 回源网络，并把结果写入缓存供下次使用
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === "basic" && cache) {
      try { cache.put(req, res.clone()); } catch (_) { /* 写入失败不影响本次响应 */ }
    }
    return res;
  } catch (err) {
    // 3) 网络也失败 → 兜底（确保 Promise 永不 reject，避免白屏）
    if (isNav) {
      if (cache) {
        try {
          const fb = await cache.match("./index.html");
          if (fb) return fb;
        } catch (_) {}
      }
      // 缓存与网络均无 → 返回兜底页面，而非纯白屏
      return new Response(OFFLINE_FALLBACK, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    // 子资源（js/css 等）加载失败且无缓存：返回空响应，由页面自行处理
    return new Response("", { status: 504, statusText: "offline" });
  }
}

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "GET_VERSION") {
    e.ports[0].postMessage({ type: "VERSION_RESPONSE", version: VERSION });
  }
  if (e.data && e.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
