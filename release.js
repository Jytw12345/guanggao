#!/usr/bin/env node
/*
 * 自动按「源文件内容」计算版本号，彻底免去手动改版本号、漏改导致收不到更新的问题。
 *
 * 规则：
 *   - 版本号 = 核心文件内容的 SHA-256 前 8 位，形如 v1a2b3c4d。
 *   - 只要 index.html / styles.css / app.js / sw.js / 等任意文件有改动，哈希就变，
 *     浏览器会安装新 SW 并预缓存新文件 → 用户点「立即更新」或下次打开即生效。
 *   - 文件都没动 → 哈希不变 → 不重新生成版本号，避免无效刷新。
 *
 * 用法（推送前运行一次即可，无需任何参数）：
 *   node release.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;

// 参与版本计算的源文件（sw.js 的 CACHE/VERSION 行会被归一化，避免「写版本本身」造成无限自增）
const SOURCES = [
  "index.html",
  "styles.css",
  "app.js",
  "sw.js",
  "config.js",
  "vendor/supabase.min.js",
  "exceljs.min.js",
  "help.html",
  "manifest.webmanifest",
];

// 去掉文件里的版本行（sw.js 的 CACHE/VERSION、app.js 的 APP_VERSION），
// 使「版本字符串本身」不参与哈希计算，避免每次写入后又被算进下一次哈希导致无限自增。
function stripVersionLines(content) {
  return content
    .replace(/const CACHE = "[^"]*";/g, "")
    .replace(/const VERSION = "[^"]*";/g, "")
    .replace(/const APP_VERSION = "[^"]*";/g, "");
}

const h = crypto.createHash("sha256");
for (const f of SOURCES) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  let c = fs.readFileSync(p);
  if (f === "sw.js" || f === "app.js") c = Buffer.from(stripVersionLines(c.toString("utf8")));
  h.update(c);
}
const newVer = "v" + h.digest("hex").slice(0, 8);

const swPath = path.join(root, "sw.js");
const appPath = path.join(root, "app.js");

let sw = fs.readFileSync(swPath, "utf8");
const curVerMatch = sw.match(/const VERSION = "(v[0-9a-f]+)";/);
const curVer = curVerMatch ? curVerMatch[1] : null;

if (curVer === newVer) {
  console.log(`✓ 版本号未变化（当前 ${curVer}），无需更新。`);
  process.exit(0);
}

sw = sw.replace(/const CACHE = "ad-install-v[0-9a-f]+";/, `const CACHE = "ad-install-${newVer}";`);
sw = sw.replace(/const VERSION = "v[0-9a-f]+";/, `const VERSION = "${newVer}";`);
fs.writeFileSync(swPath, sw);

if (fs.existsSync(appPath)) {
  let app = fs.readFileSync(appPath, "utf8");
  if (app.includes("APP_VERSION")) {
    app = app.replace(/const APP_VERSION = "v[0-9a-f]+";/, `const APP_VERSION = "${newVer}";`);
    fs.writeFileSync(appPath, app);
  }
}

console.log(`✓ 版本号已更新：${curVer || "(无)"} → ${newVer}`);
console.log("  已写入：sw.js (CACHE/VERSION)、app.js (APP_VERSION)");
console.log("  下一步：提交并推送；用户端下次打开即提示更新。");
