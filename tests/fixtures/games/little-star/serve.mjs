/**
 * Little Star —— 本地静态服务器（开发预览用）
 * =====================================================================
 * 用法：node serve.mjs [端口，默认 4321]
 *
 * 端口约定：4321 = 常驻预览（本脚本），4322 = 回归测试（verify.mjs 自带的
 *          进程内服务器）。两者错开，所以随时能跑测试而不打扰预览。
 *
 * 已开 Cache-Control: no-cache —— 改完代码直接刷新页面即可，无需重启。
 * 建议常驻后台跑；重启后 4321 可用 netstat 确认：
 *   netstat -ano | grep LISTENING | grep :4321
 *
 * ★ v0.7 起 game.js 是 src/ 片段的**拼装产物**：本服务只警告「源比产物新」，
 *   不自动重拼（磁盘上的 game.js 必须与实际运行的代码一致；偷偷重拼会让
 *   「文件是旧的、浏览器是新的」变成新的灵异问题）。
 *
 * 仅监听 127.0.0.1，不做目录穿越（请求路径必须落在本目录内）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.argv[2] || 4321);
const DIST = path.join(HERE, "game.js");
const SRCDIR = path.join(HERE, "src");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

/* 源片段是否比拼装产物新（同一状态只提示一次，别刷屏） */
let warned = false;
function stale() {
  try {
    const distMs = fs.statSync(DIST).mtimeMs;
    let newest = 0;
    for (const f of fs.readdirSync(SRCDIR)) {
      if (!f.endsWith(".js")) continue;
      const ms = fs.statSync(path.join(SRCDIR, f)).mtimeMs;
      if (ms > newest) newest = ms;
    }
    return newest > distMs;
  } catch (e) {
    return false;                 /* 目录结构不完整时保持安静，别把预览服务搞崩 */
  }
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(HERE, p);
  if (!file.startsWith(HERE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  if (p === "/game.js") {
    const s = stale();
    if (s && !warned) {
      warned = true;
      console.log("⚠ src/ 比 game.js 新 —— 跑 node scripts/build.mjs 重新拼装（本次仍按磁盘上的旧产物提供）");
    } else if (!s) {
      warned = false;
    }
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Little Star 已启动: http://127.0.0.1:${PORT}/`);
  console.log("提示：源码在 src/，改完跑 node scripts/build.mjs 拼成 game.js 再刷新。");
});
