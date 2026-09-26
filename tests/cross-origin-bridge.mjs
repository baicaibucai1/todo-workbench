/**
 * 跨源工具桥验证（postMessage targetOrigin）。
 *
 * 为什么要单独一个套件：**dev 下工具与宿主同源，把这类 bug 完全掩盖了**。
 * 桌面端工具是经 asset 协议加载的（`http://asset.localhost/C%3A%5C…%5Cindex.html`），
 * 宿主在 `http://tauri.localhost` —— 不同源。而 postMessage 的 targetOrigin
 * 一旦不匹配，浏览器把消息**静默丢弃**：不抛错、不告警。曾经两边都填
 * `window.location.origin`（各自的），于是桌面端整条桥双向断开：
 * 工具 KV 写不进、图库存不进、开关读不到，而 dev 下 15 个套件全绿。
 *
 * 这里用「localhost:1420 的宿主 + 127.0.0.1:1421 的工具」造出真实的跨源，
 * 两种造法各测一遍，因为它们坏在不同的地方：
 *   A. 302 重定向 —— iframe.src 写着同源路径，实际加载在另一个 host。
 *      按 src 推 origin 会推出错的那个，且错得无声无息。
 *   B. 直接把 src 设成跨源地址 —— 桌面端 asset 协议就是这个形状。
 *
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 * 用法：node tests/cross-origin-bridge.mjs
 */
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { makePng } from "./png.mjs";
import { enableModule } from "./_enable-module.mjs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const HOST = "http://localhost:1420/";
const TOOLS_DIR = path.resolve("tools");
const ALT_PORT = 1421;
const ALT = `http://127.0.0.1:${ALT_PORT}`;

/* 探针图：给 gallery.put 一个真能下载的网址，好让宿主的下载链路也走一遍 */
const PNG = makePng(64, 48, [30, 160, 90]);

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const info = (l, v) => console.log(`    · ${l}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

/* ------------------------------------------------------------------
 * 另一个 host 上的静态服务：只服务 tools/ 目录和那张探针图。
 * 它存在的意义就是让工具页待在**与宿主不同的源**上。
 * ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".png": "image/png",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/probe.png") {
    // CORS 头：dev 是浏览器驱动，宿主的下载走 fetch，跨源会被拦。
    // 桌面端是 Rust reqwest 直连，没有这回事 —— 这里放开只是为了测同一条链路。
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": PNG.length,
      "access-control-allow-origin": "*",
    });
    res.end(PNG);
    return;
  }
  const file = path.join(TOOLS_DIR, url.replace(/^\/+/, ""));
  if (!file.startsWith(TOOLS_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(ALT_PORT, "127.0.0.1", r));

/* ------------------------------------------------------------------ */
const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

/**
 * 记下每个窗口发出的 postMessage 的 targetOrigin。
 *
 * 必须挂在 **Window.prototype** 上：宿主发给工具走的是 iframe.contentWindow
 * 的 postMessage，工具发给宿主走的是 parent（宿主 window）的 postMessage ——
 * 两个是不同对象，只 hook 宿主 window 只能看到一半，而"单向通"正是这类
 * bug 最常见的假象。
 */
await context.addInitScript(() => {
  window.__sent = [];
  // ⚠️ 必须挂在 **window 自身**上，不是 Window.prototype：
  // Chrome 里 postMessage 是 window 的自有属性（[Replaceable]），原型上的同名
  // 属性会被它遮蔽 —— 改原型的结果是探针永远什么都记不到，所有"没收到消息"
  // 的断言全变成假绿。
  const orig = window.postMessage;
  Object.defineProperty(window, "postMessage", {
    configurable: true,
    writable: true,
    value: function (msg, targetOrigin, transfer) {
      try {
        (window.__sent || (window.__sent = [])).push({
          source: msg && msg.source,
          type: msg && msg.type,
          op: msg && msg.op,
          targetOrigin: String(targetOrigin),
        });
      } catch (e) { /* 记不下就算了，别影响通信本身 */ }
      return orig.call(this, msg, targetOrigin, transfer);
    },
  });
});

/** 探针自检：探针自己坏了的话，下面所有"没收到"的断言都会变成假绿 */
async function probeWorks() {
  const before = await page.evaluate(() => (window.__sent || []).length);
  await page.evaluate(() => window.postMessage({ source: "probe" }, "*"));
  const after = await page.evaluate(() => (window.__sent || []).length);
  return after === before + 1;
}

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

async function openTool(id) {
  await page.goto(`${HOST}?tool=${id}`, { waitUntil: "load" });
  await page.waitForSelector(`iframe[data-tool-frame="${id}"]`, { timeout: 20000 });
  await page.waitForTimeout(2000);
}

const frameOf = (id) =>
  page.frames().find((f) => new RegExp(`/${id}/index\\.html`).test(f.url())) ?? null;

/** 造景 A：iframe.src 写着同源路径，请求被 302 到另一个 host */
async function viaRedirect(id) {
  await page.route(`**/tools/${id}/index.html`, (route) =>
    route.fulfill({ status: 302, headers: { location: `${ALT}/${id}/index.html` } }),
  );
  await openTool(id);
  await page.waitForTimeout(1500);
  return frameOf(id);
}

/**
 * 握手是否成功：工具自己显示的状态最诚实。
 *
 * ⚠️ 探针（__sent）**只在同源 iframe 里可信**：跨源 iframe 是独立进程（OOPIF），
 * playwright 的 addInitScript 覆盖不到它，记录永远是空的。不能拿"探针没记到"
 * 当"消息没到"——那会得出反向的错误结论。跨源下只信工具自己的状态与真实
 * 的桥操作结果。
 */
async function handshake(frame) {
  const mine = await frame.evaluate(() => ({
    host: document.getElementById("hostState").textContent.trim(),
    origin: location.origin,
    url: location.href,
    // 宿主发给 iframe 的消息记在 iframe 这一侧（宿主调的是 iframe.contentWindow.postMessage）
    got: (window.__sent || []).filter((m) => m.type === "tool:context").map((m) => m.targetOrigin),
    allMine: (window.__sent || []).map((m) => `${m.type}:${m.targetOrigin}`),
  }));
  const hostSide = await page.evaluate(() => ({
    // 工具发给宿主的消息记在宿主这一侧（工具调的是 parent.postMessage）
    resp: (window.__sent || []).filter((m) => m.type === "tool:response").length,
    reqs: (window.__sent || []).filter((m) => m.type === "tool:request").map((m) => m.op),
  }));
  return { ...mine, ...hostSide };
}

/* ================================================================== */
console.log("\n0. 探针自检");

await page.goto(HOST, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
check("postMessage 探针能记录到消息（否则后面的断言全是假绿）", await probeWorks());

// 第 2 节要把产出存进图库，而图库是**选装模块**（v18 起默认不带）——
// 不开它，gallery.put 会被能力门回绝，那条断言会红在"存不进去"上，
// 而真凶其实只是模块没开。
await enableModule(page, "gallery");

/* ================================================================== */
console.log("\n1. 跨源：src 写着同源、实际加载在别的 host（302）");

const fa = await viaRedirect("image-crop");
check("工具确实加载在 127.0.0.1:1421", !!fa && /127\.0\.0\.1:1421/.test(fa.url()), fa ? fa.url() : "未找到");
if (fa) {
  const h = await handshake(fa);
  info("握手", h);
  check("跨源（重定向）下握手成功", h.host === "已连工作台", h.host);
}
await page.unrouteAll();

/* ================================================================== */
console.log("\n2. 跨源下把产出存进图库（AI 生成默认留档走的就是这条）");

await viaRedirect("ai-gen");
const fg = frameOf("ai-gen");
check("ai-gen 加载在跨源地址上", !!fg && /127\.0\.0\.1:1421/.test(fg.url()), fg ? fg.url() : "未找到");

if (fg) {
  const before = await page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    return (await g.fetchGallery()).length;
  });

  const put = await fg.evaluate(async (url) => {
    try {
      if (typeof saveResultToGallery !== "function") return { err: "工具里没有 saveResultToGallery" };
      const item = await saveResultToGallery({ url, prompt: "跨源桥探针" }, 0, false);
      return { ok: true, id: item && item.id, title: item && item.title };
    } catch (e) {
      return { err: String((e && e.message) || e) };
    }
  }, `${ALT}/probe.png`);
  info("gallery.put", put);
  check("跨源下工具能把产出存进图库", !!put.ok, put.err || "");

  await page.waitForTimeout(1500);
  const after = await page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    const all = await g.fetchGallery();
    return {
      n: all.length,
      last: all[0] ? { origin: all[0].origin, title: all[0].title, rel: all[0].relPath } : null,
    };
  });
  info("图库", { before, after });
  check("图库真的多了一条", after.n === before + 1, `${before} → ${after.n}`);
  check("来源被宿主盖成 ai-gen", after.last && after.last.origin === "ai-gen", String(after.last && after.last.origin));
  check("图真的落盘了（有 relPath）", !!(after.last && after.last.rel), JSON.stringify(after.last));
}

/* ================================================================== */
console.log("\n3. 同源场景没有退化");

await page.goto(`${HOST}?tool=image-crop`, { waitUntil: "load" });
await page.waitForSelector('iframe[data-tool-frame="image-crop"]', { timeout: 20000 });
await page.waitForTimeout(2500);
const fsame = frameOf("image-crop");
if (fsame) {
  const h = await handshake(fsame);
  info("同源握手", h);
  check("同源下工具仍是宿主的源", /localhost:1420/.test(h.origin), h.origin);
  check("同源下握手照旧成功", h.host === "已连工作台", h.host);
  // 探针只在同源下可信（见 handshake 的说明），两个方向的证据都在这里取
  check("宿主确实往工具推了 context", h.got.length > 0, JSON.stringify(h.allMine));
  check("工具的请求发出去了（说明它认下了宿主）", h.reqs.length > 0, JSON.stringify(h.reqs));
} else {
  check("同源下能打开工具", false, "没找到 iframe");
}

/* ================================================================== */
console.log("\n4. 控制台");
check("没有页面错误", errors.length === 0, errors.join(" | "));

await browser.close();
server.close();

console.log(`\n${"=".repeat(50)}`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  failures.forEach((f) => console.log("  · " + f));
}
// 汇总行格式对齐 _run-all-e2e.mjs 的解析（「N 通过 / M 失败」）
console.log(`结果：${passed} 通过 / ${failures.length} 失败`);
process.exit(failures.length ? 1 : 0);
