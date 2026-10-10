/**
 * 「脱离工作台也是 web 工具」的回归。
 *
 * 验的是每一份工具 HTML **单独打开**时还算不算一个能用的网页：
 *   1. 一路 0 报错（pageerror / console.error）
 *   2. document.body.dataset.bindState 落到 standalone
 *   3. 界面上明说了"独立运行"，并且说清了数据存在哪
 *   4. 宿主专属的控件（图床 / 交给别的工具 / 表结构）全部**看不见** ——
 *      不是"禁用"，禁用在这儿解释不通（没有可升级的工作台）
 *   5. 核心动作真的能落地：写一条能存住、刷新后还在
 *
 * 打开方式是 file://（等于双击），这也是代码注释里承诺的那条活法。
 * 顺带也走一遍 http:// —— 工具挂到静态服务器上时同一个期望应该成立。
 *
 * ⚠️ 数据落到 localStorage 上（key 前缀 wbtool:<id>:）。
 * 每个用例开头会清掉自己那一段，所以跑完不留垃圾。
 *
 * 用法：node tests/tools-standalone.mjs
 */

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = path.join(ROOT, "docs", "screenshots", "logo.png");

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
const info = (label, v) => console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

/* ---------------- 一个够用的静态服务器（给 http:// 那一趟） ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = url.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(path.normalize(ROOT))) { res.writeHead(403).end(); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

/* ---------------- 采集界面事实 ---------------- */
function snapshot() {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const hostOnly = [...document.querySelectorAll("[data-host-only]")].map((el) => ({
      id: el.id || "",
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 24),
      visible: vis(el),
    }));

    // 界面上提到"独立 / 宿主 / 工作台"的可见文字
    const hints = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 90) continue;
      if (/独立|未连|已连|工作台|宿主/.test(t) && vis(el)) hints.push(t);
    }
    return {
      bindState: document.body.dataset.bindState,
      hostOnly,
      hostOnlyVisible: hostOnly.filter((h) => h.visible),
      hints,
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    };
  });
}

/** 打开一个工具并等状态落定（1200ms 兜底之后） */
async function openStandalone(id, scheme) {
  const url = scheme === "http"
    ? `${BASE}tools/${id}/index.html`
    : `file:///${ROOT.replace(/\\/g, "/")}/tools/${id}/index.html`;
  errors.length = 0;
  consoleErrors.length = 0;
  await page.goto(url, { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(2000);   // 越过 1200ms 的分类超时
  return snapshot();
}

/** 独立运行的四条通用期望 */
async function expectCommon(id, label, scheme, minHostOnly = 1) {
  const s = await openStandalone(id, scheme);
  const tag = `${label} [${scheme}]`;

  check(`${tag}：bindState 落到 standalone`, s.bindState === "standalone", String(s.bindState));
  check(`${tag}：0 个 pageerror`, errors.length === 0, errors.slice(0, 2).join(" | "));
  check(`${tag}：0 条 console.error`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  check(`${tag}：界面上说明了"独立运行"`, s.hints.some((h) => /独立(运行|打开)/.test(h)),
    JSON.stringify(s.hints));
  // 这条是给「宿主专属控件一个都没露出来」兜底用的：一个都没标的话那条断言是空的
  check(`${tag}：标了 ${minHostOnly} 处以上 data-host-only`, s.hostOnly.length >= minHostOnly,
    String(s.hostOnly.length));
  check(`${tag}：宿主专属控件一个都没露出来`, s.hostOnlyVisible.length === 0,
    JSON.stringify(s.hostOnlyVisible));
  return s;
}

/** 清掉这个工具在浏览器本地留下的数据 */
async function wipeLocal(id) {
  await page.evaluate((tid) => {
    try {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("wbtool:" + tid + ":") === 0) kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* 没开就算了 */ }
  }, id);
}

/* ==================================================================
 * 1. 模板（scratchpad）—— 归零，它本来就是"照着抄"的那份
 * ================================================================== */
console.log("\n=== 1. 模板 scratchpad ===");
{
  await expectCommon("scratchpad", "模板", "file");
  await wipeLocal("scratchpad");
  await openStandalone("scratchpad", "file");

  await page.fill("#title", "独立运行测试");
  await page.fill("#body", "这条不该丢");
  await page.click("#add");
  await page.waitForTimeout(500);

  const afterAdd = await page.evaluate(() => ({
    cards: document.querySelectorAll(".note").length,
    text: document.getElementById("list").innerText,
    meta: document.getElementById("meta").textContent,
  }));
  check("模板：能写进一条", afterAdd.cards === 1, `cards=${afterAdd.cards}`);
  check("模板：列表里看得见", afterAdd.text.includes("独立运行测试"), afterAdd.text.slice(0, 60));
  check("模板：副标题说清了数据存在浏览器里", /浏览器|localStorage/.test(afterAdd.meta), afterAdd.meta);

  await openStandalone("scratchpad", "file");
  const afterReload = await page.evaluate(() => ({
    cards: document.querySelectorAll(".note").length,
    text: document.getElementById("list").innerText,
  }));
  check("模板：刷新后还在（真的落盘了）", afterReload.cards === 1 && afterReload.text.includes("独立运行测试"),
    `cards=${afterReload.cards}`);

  await page.click('.note button[data-act="del"]');
  await page.waitForTimeout(400);
  const afterDel = await page.evaluate(() => document.querySelectorAll(".note").length);
  check("模板：删除也生效", afterDel === 0, String(afterDel));
  await wipeLocal("scratchpad");

  await expectCommon("scratchpad", "模板", "http");
}

/* ==================================================================
 * 2. 便签（notes）
 * ================================================================== */
console.log("\n=== 2. 便签 notes ===");
{
  // 便签唯一的宿主专属控件在编辑器里（「从图床挑」），静态 DOM 上没有，
  // 所以这里放宽到 0，改在下面开一次编辑器单独验。
  await expectCommon("notes", "便签", "file", 0);
  await wipeLocal("notes");
  await openStandalone("notes", "file");

  await page.click("#new");
  await page.waitForTimeout(600);
  const afterNew = await page.evaluate(() => ({
    cards: document.querySelectorAll("#grid .card").length,
    meta: document.getElementById("meta").textContent,
    emptyHidden: document.getElementById("empty").hidden,
    gallery: (() => {
      const b = document.getElementById("e-gallery");
      if (!b) return "missing";
      const r = b.getBoundingClientRect();
      return r.width > 0 && getComputedStyle(b).display !== "none" ? "visible" : "hidden";
    })(),
  }));
  check("便签：点「新建」能建出一张卡", afterNew.cards === 1, `cards=${afterNew.cards}`);
  check("便签：空态让位", afterNew.emptyHidden === true, String(afterNew.emptyHidden));
  check("便签：编辑器里的「从图床挑」不可见", afterNew.gallery === "hidden", afterNew.gallery);

  await openStandalone("notes", "file");
  const afterReload = await page.evaluate(() => document.querySelectorAll("#grid .card").length);
  check("便签：刷新后那张卡还在", afterReload === 1, String(afterReload));
  const meta = await page.evaluate(() => document.getElementById("meta").textContent);
  check("便签：副标题说清了数据存在浏览器里", /浏览器|本地/.test(meta), meta);
  await wipeLocal("notes");

  await expectCommon("notes", "便签", "http", 0);
}

/* ==================================================================
 * 3. 尺码表（size-chart）
 * ================================================================== */
console.log("\n=== 3. 尺码表 size-chart ===");
{
  await expectCommon("size-chart", "尺码表", "file");

  const before = await page.evaluate(() => document.getElementById("tableCountLabel").textContent);
  await page.click('button[title="增加行 (Ctrl+↓)"]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById("tableCountLabel").textContent);
  check("尺码表：能加一行（编辑器真的动起来）", /\d+ 行/.test(after) && after !== before,
    `${before} → ${after}`);

  await expectCommon("size-chart", "尺码表", "http");
}

/* ==================================================================
 * 4. 图片裁剪（image-crop）
 * ================================================================== */
console.log("\n=== 4. 图片裁剪 image-crop ===");
{
  const s = await expectCommon("image-crop", "图片裁剪", "file");
  check("图片裁剪：状态条写着「独立运行」",
    (await page.evaluate(() => document.getElementById("hostState")?.textContent)) === "独立运行",
    String(await page.evaluate(() => document.getElementById("hostState")?.textContent)));
  void s;

  // 真喂一张图进去 —— 这才叫"能用"
  const before = await page.evaluate(() => document.getElementById("listHint").textContent);
  await page.setInputFiles("#fileInput", SHOT);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    hint: document.getElementById("listHint").textContent,
    thumbs: document.querySelectorAll("#thumbList *").length,
  }));
  check("图片裁剪：能打开一张图（缩略图列表进了一条）", after.hint !== before && /1 张/.test(after.hint),
    `${before} → ${after.hint}`);
  check("图片裁剪：缩略图列表真的渲染出了东西", after.thumbs > 0, `thumbs=${after.thumbs}`);

  await expectCommon("image-crop", "图片裁剪", "http");
}

/* ==================================================================
 * 5. AI 生成（ai-gen）
 * ================================================================== */
console.log("\n=== 5. AI 生成 ai-gen ===");
{
  const s = await expectCommon("ai-gen", "AI 生成", "file");
  check("AI 生成：横幅明说了独立打开（配置只在内存）",
    s.hints.some((h) => /未连接宿主/.test(h) && /独立/.test(h)),
    JSON.stringify(s.hints));
  check("AI 生成：图床那一列的按钮不可见",
    (await page.evaluate(() => {
      const b = document.getElementById("btnRefFromImagebed");
      if (!b) return "missing";
      const r = b.getBoundingClientRect();
      return getComputedStyle(b).display === "none" || r.width === 0 ? "hidden" : "visible";
    })) === "hidden",
    String(await page.evaluate(() => document.getElementById("btnRefFromImagebed")?.getBoundingClientRect().width)));

  await expectCommon("ai-gen", "AI 生成", "http");
}

/* ---------------- 汇总 ---------------- */
await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n${"=".repeat(56)}`);
if (failed) {
  console.log(`独立运行体检：${passed} 通过 / ${failed} 失败`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`独立运行体检：${passed} 项全部通过`);
