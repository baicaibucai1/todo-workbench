/**
 * 图片裁剪工具的「AI 补全」加载链路验证。
 *
 * 为什么单独开一个套件（2026-09-21 的真实事故）：
 *   tools/image-crop/ai/（ONNX Runtime + MI-GAN 模型，约 50MB）**从来没被同步进工具目录**。
 *   于是每个安装包里的工具都在跑降级路径 —— 界面上写一句「缺少 ai/ort.js · 将改用本地算法」，
 *   而源目录双击打开那份却是好好的。两边看起来都正常，只是行为差一档。
 *
 *   打包门禁（check-installer 的 1b）挡的是"有没有进包"，
 *   这个套件挡的是"进了包能不能真的跑起来"，两者缺一不可：
 *   当时前者根本不存在，所以这个 bug 一路出到了用户手里。
 *
 * ai/ 缺失时**跳过而非失败**：它是可选能力（见 scripts/sync-tools.mjs 的 DIR_SOURCES），
 * 没有它工具会退回纯 JS 补全算法，功能照用。别人 clone 公开仓库后跑 e2e 就是这种情况。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge（与 Tauri 的 WebView2 同源）。
 * 前置：dev server 已在 localhost:1420。
 *
 * 用法：node tests/image-crop-ai.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AI_DIR = path.resolve(__dirname, "..", "tools", "image-crop", "ai");

const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

/* ------------------------------------------------------------------ */
/* 0. ai/ 在不在？不在就整份跳过                                          */
/* ------------------------------------------------------------------ */

console.log("\n0. AI 资源目录");

const AI_FILES = ["ort.js", "ort-wasm.js", "migan.js", "LICENSE.txt"];
let hasAll = true;
for (const f of AI_FILES) {
  const ok = fs.existsSync(path.join(AI_DIR, f));
  if (!ok) hasAll = false;
  info(f, ok ? `${(fs.statSync(path.join(AI_DIR, f)).size / 1048576).toFixed(2)} MB` : "缺失");
}

if (!hasAll) {
  console.log("\n  [跳过] tools/image-crop/ai/ 不完整。");
  console.log("         它是可选能力（工具会退回纯 JS 算法），也可能是 clone 仓库后没同步。");
  console.log("         本地要验证 AI：node scripts/sync-tools.mjs（从源目录搬运）。");
  console.log("\n汇总: 0 通过 / 0 失败（已跳过）");
  process.exit(0);
}
check("ai/ 四个文件齐备", true);

/* ------------------------------------------------------------------ */
/* 1. 在工作台里打开工具                                                  */
/* ------------------------------------------------------------------ */

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

console.log("\n1. 工具装载");
await page.goto(`${BASE}?tool=image-crop`, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(1500);

// 主页面 URL 里也带 ?tool=image-crop，所以必须按路径里的 /tools/ 匹配
const fr = page.frames().find((f) => f.url().includes("/tools/image-crop/"));
check("iframe 已装载", !!fr);
if (!fr) {
  await browser.close();
  console.log("\n汇总: " + passed + " 通过 / " + failed + " 失败");
  process.exit(1);
}

const scope = await fr.evaluate(() => ({
  ai: typeof ai,
  aiEnsure: typeof aiEnsure,
  state: typeof ai === "object" ? ai.state : null,
}));
info("作用域", scope);
check("工具脚本已执行（ai 变量可见）", scope.ai === "object", JSON.stringify(scope));
check("初始未加载", scope.state === "idle", String(scope.state));

/* ------------------------------------------------------------------ */
/* 2. 真的把模型加载起来                                                  */
/* ------------------------------------------------------------------ */

console.log("\n2. 加载模型（约 50MB，耐心等）");
const t0 = Date.now();
const r = await fr.evaluate(async () => {
  // 「失败过就不再重试」是工具的设计（免得每次操作都白等一轮），
  // 这里手动重置一次，模拟"刚打开就加载"的正常路径。
  if (ai.state === "failed") {
    ai.state = "idle";
    ai.why = "";
  }
  try {
    await aiEnsure();
    return { state: ai.state, why: ai.why, served: ai.served, hasSession: !!ai.sess };
  } catch (e) {
    return { state: ai.state, why: ai.why, err: String(e && e.message ? e.message : e) };
  }
});
info("耗时", `${((Date.now() - t0) / 1000).toFixed(1)}s`);
info("结果", r);

check("模型加载成功（state=ready）", r.state === "ready", r.why || r.err || "");
check("推理会话已建立", r.hasSession === true);
// served 是「ORT 要 .wasm 时被内存字节顶替」的次数。它 ≥1 才说明
// script 标签加载 + wasm 请求劫持这一整套 file:// 规避方案真的生效了 ——
// 只看 state=ready 是不够的，那只能说明模型文件读进来了。
check("wasm 请求已被内存字节顶替", typeof r.served === "number" && r.served >= 1, `served=${r.served}`);

console.log("\n3. 界面状态");
const txt = await fr.locator("#fillStateTxt").textContent().catch(() => "");
info("fillStateTxt", txt);
check("状态行不再报「缺少 ai/ort.js」", !/缺少\s*ai\//.test(txt), txt);

console.log("\n4. 控制台");
check("无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

/* ------------------------------------------------------------------ */
/* 5. asset 协议语义：装出来的应用里那条 URL 形状                          */
/* ------------------------------------------------------------------ */

/*
 * 这一节复现的是**桌面端专属**的 URL 形状，dev server 永远造不出来。
 *
 * Tauri 的 convertFileSrc 把整条 Windows 路径 encodeURIComponent 成一个路径段
 * （tauri/scripts/core.js）：
 *     http://asset.localhost/C%3A%5C...%5Ctools%5Cimage-crop%5Cindex.html
 * 这条 URL 里只有开头一个 '/'，所以按 URL 规范，相对引用 'ai/ort.js' 会被
 * 解析到站点根 /ai/ort.js —— 而不是工具目录下的 ai/。
 *
 * 2026-09-21 的真实事故：工具写的是 `const AI_DIR = 'ai/'`，于是**每个安装包**
 * 里的 AI 补全都在静默降级（只写一句"缺少 ai/ort.js"，不白屏不报错），
 * 而 dev 下一切正常 —— 因为 /tools/image-crop/index.html 有真实的目录层级。
 *
 * 所以这里用一个本地静态服务伪造同样的 URL 形状（文件仍从真实工具目录取），
 * 断言 ai/ 真的能被取到。**别删这一节**：它是这条链路上唯一的守门人，
 * 打包门禁只管"文件有没有进包"，管不到"进了包能不能加载"。
 */

const TOOL_DIR = path.resolve(__dirname, "..", "tools", "image-crop");
const FAKE_ROOT = "C:\\fake\\tools\\image-crop";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
/** 服务收到的原始请求路径（解码前），用来证明请求没有落到站点根 */
const seen = [];

const server = http.createServer((rq, rs) => {
  const raw = rq.url.split(/[?#]/)[0];
  // favicon 由浏览器自己来要，跟被测链路无关；不回 404 是为了别让它
  // 在控制台里留一条 "Failed to load resource"，污染下面的错误计数。
  if (raw === "/favicon.ico") {
    rs.writeHead(204);
    rs.end();
    return;
  }
  seen.push(raw);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* 解不开就按原样处理，下面自然会 404 */
  }
  const rel = decoded
    .replace(/^[/\\]+/, "")
    .replace(/^C:[\\/]fake[\\/]tools[\\/]image-crop[\\/]?/i, "")
    .replace(/\\/g, "/");
  const file = path.join(TOOL_DIR, rel || "index.html");
  if (!file.startsWith(TOOL_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    rs.writeHead(404, { "Content-Type": "text/plain" });
    rs.end("not found");
    return;
  }
  rs.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(rs);
});

console.log("\n5. asset 协议语义（桌面端 URL 形状）");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
// 与 Tauri 的 convertFileSrc 逐字节同构：整条路径编码成一个路径段
const assetish = `http://127.0.0.1:${port}/${encodeURIComponent(`${FAKE_ROOT}\\index.html`)}`;
info("伪造的 asset 形态 URL", assetish);

const page2 = await context.newPage();
const errors2 = [];
page2.on("console", (m) => {
  if (m.type() === "error") errors2.push(m.text());
});
page2.on("pageerror", (e) => errors2.push(`pageerror: ${e.message}`));

await page2.goto(assetish, { waitUntil: "load" });
await page2.waitForTimeout(800);

const scope2 = await page2.evaluate(() => ({
  ai: typeof ai,
  href: location.href,
}));
check("工具在这种 URL 下能起来", scope2.ai === "object", JSON.stringify(scope2));

const r2 = await page2.evaluate(async () => {
  if (typeof ai === "undefined") return { state: "n/a" };
  try {
    await aiEnsure();
  } catch {
    /* 失败信息在 ai.why 里 */
  }
  return { state: ai.state, why: ai.why, served: ai.served, dir: AI_DIR };
});
info("AI_DIR", r2.dir);
info("结果", { state: r2.state, why: r2.why, served: r2.served });

// 单独的"没退回本地算法"这条是有意留的：它和下面那条的失败信息不同 ——
// 退回时能直接打出 ai.why（比如"缺少 ai/ort.js"），一眼看出是哪一步断的。
check("asset 形态下没有退回本地算法", r2.state !== "failed", String(r2.why || ""));
check("asset 形态下模型加载成功（state=ready）", r2.state === "ready", String(r2.why || r2.state));
check("asset 形态下 wasm 被内存字节顶替", typeof r2.served === "number" && r2.served >= 1, `served=${r2.served}`);
// 关键断言：ai/ort.js 必须落在工具目录下，而不是站点根
const decodedSeen = seen.map((p) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
});
check(
  "ai/ort.js 请求落在工具目录下（未解析到站点根）",
  decodedSeen.some((p) => /image-crop[\\/]ai[\\/]ort\.js$/i.test(p)) && !decodedSeen.includes("/ai/ort.js"),
  decodedSeen.slice(0, 4).join(" | "),
);
info("服务收到的前几个请求", decodedSeen.slice(0, 5));
info("asset 形态下的控制台错误", errors2.length);

await page2.close();
await new Promise((r) => server.close(r));

await browser.close();

console.log(`\n汇总: ${passed} 通过 / ${failed} 失败`);
if (failures.length) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f);
}
process.exit(failed ? 1 : 0);
