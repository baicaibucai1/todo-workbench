/**
 * 「便签」工具的冒烟验证。
 *
 * 验的是这条链路是不是真的通了：
 *   1. 侧边栏出现「便签」入口（注册成功）
 *   2. iframe 真的加载出界面（不是"找不到入口"的兜底页）
 *   3. 新建 → 卡片出现 → 刷新后还在（数据真的落库，不是内存里）
 *   4. 建表成功（tool_notes_notes 这张表真的存在）
 *   5. 反复开关编辑器**不会多出重复卡**（2026-10-04 的真实 bug 回归）
 *   6. 图床模块没开也能附图（降级为内联 dataURL 随签直存）
 *   7. 图床开着时走 gallery.put（图进图床，签里只存 id）
 *
 * 前置：dev server 已在 http://localhost:1420/ 跑着。
 * 用法：node tests/notes-tool.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fsSync from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

const TOOL_ID = "notes";
const TOOL_NAME = "便签";
const TABLE = "tool_notes_notes";

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

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1240, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

/** 开/关图床模块（选装；注册表里默认开，但用户可以手动关 —— 降级路径就靠它测） */
async function setImagebed(on) {
  await page.evaluate(async (v) => {
    const repo = await import("/src/lib/repo.ts");
    await repo.setSettings({ "ext.imagebed.enabled": v ? "1" : "0" });
  }, on);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
}

/** 拿工具 iframe 的 frame */
async function toolFrame() {
  const h = await page.locator(`iframe[data-tool-frame="${TOOL_ID}"]`).elementHandle();
  return h ? await h.contentFrame() : null;
}

/** 重新进入工具（宿主页面刷新后 iframe 引用会失效，都要重新点一遍） */
async function reopenTool(wait = 1800) {
  await page.locator(`aside [data-nav="tool:${TOOL_ID}"]`).first().click();
  await page.waitForTimeout(wait);
  return toolFrame();
}

/** 在 iframe 里发一个 op（与宿主真实通道，不是伪造） */
async function askInTool(op, payload, timeout = 15000) {
  const frame = await toolFrame();
  if (!frame) return { noFrame: true };
  return frame.evaluate(
    async ([op, payload, timeout]) => {
      return await new Promise((resolve) => {
        const id = "probe-" + Math.random().toString(36).slice(2);
        const onMsg = (e) => {
          if (!e.data || e.data.source !== "workbench-host" || e.data.type !== "tool:response") return;
          if (e.data.id !== id) return;
          window.removeEventListener("message", onMsg);
          resolve({ ok: e.data.ok, data: e.data.data, error: e.data.error });
        };
        window.addEventListener("message", onMsg);
        window.parent.postMessage({ source: "workbench-tool", type: "tool:request", id, op, payload }, "*");
        setTimeout(() => resolve({ timeout: true }), timeout);
      });
    },
    [op, payload, timeout],
  );
}

/* ================= 开场 ================= */

console.log("\n0. 打开工作台（图床保持默认：关）");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);

console.log("\n1. 注册：侧边栏要有「便签」");
const nav = page.locator(`aside [data-nav="tool:${TOOL_ID}"]`);
check("侧边栏出现「便签」入口", (await nav.count()) === 1, `count=${await nav.count()}`);
const navText = (await nav.count()) ? await nav.innerText() : "";
info("入口文案", navText.replace(/\s+/g, " ").trim());
check("入口文案里有工具名", navText.includes(TOOL_NAME), navText);

console.log("\n2. 打开：iframe 要真的加载出界面");
await nav.first().click();
await page.waitForTimeout(1600);
const frame = await toolFrame();
check("拿到工具的 iframe", !!frame);
if (!frame) {
  console.log("\n没有 iframe，后面的用例没法跑");
  await browser.close();
  process.exit(1);
}
// 兜底页（契约演示）出现说明入口解析失败
const fallback = await page.locator("[data-tool-contract-demo]").count();
check("没有落到「找不到入口」的兜底页", fallback === 0, `fallback=${fallback}`);
const hasTitle = await frame.locator("h1").first().innerText().catch(() => "");
info("工具标题", hasTitle);
check("工具界面渲染出来了", hasTitle.includes("便签"), hasTitle);

console.log("\n3. 建表：tool_notes_notes 要真的存在");
const schema = await askInTool("schema.info", {});
const tables = (schema && schema.data && schema.data.tables) || [];
info("表清单", tables.map((t) => (t.name || t)).join(", ") || "(空)");
check(`建出了 ${TABLE}`, tables.some((t) => (t.name || t) === "notes"), JSON.stringify(tables));

console.log("\n4. 新建便签 → 卡片出现");
const emptyBefore = await frame.locator(".card").count();
info("新建前卡片数", emptyBefore);
await frame.locator("#new").click();
await page.waitForTimeout(1200);
// 新建会自动打开编辑面板，先关掉看卡片
await frame.locator("#e-done").click().catch(() => {});
await page.waitForTimeout(600);
const cards = await frame.locator(".card").count();
info("新建后卡片数", cards);
check("卡片网格里多了一张", cards === emptyBefore + 1, `${emptyBefore} → ${cards}`);

console.log("\n5. 输入内容 → 输入即存 → 刷新后还在");
await frame.locator(".card").first().click();
await page.waitForTimeout(700);
await frame.locator("#e-title").fill("买牛奶");
await frame.locator("#e-body").fill("晚上回来顺路，别忘");
await frame.locator("#e-tag").fill("生活");
await page.waitForTimeout(900); // 等 debounce 落库
await frame.locator("#e-done").click();
await page.waitForTimeout(500);

const shownTitle = await frame.locator(".card .t").first().innerText().catch(() => "");
info("卡片标题", shownTitle);
check("卡片上显示了输入的标题", shownTitle.includes("买牛奶"), shownTitle);

// 刷新整个应用，验证真的落库
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const f2 = await reopenTool();
const afterReload = await f2.locator(".card").count();
const t2 = await f2.locator(".card .t").first().innerText().catch(() => "");
info("刷新后卡片数 / 标题", `${afterReload} / ${t2}`);
check("刷新后便签还在（落的是库不是内存）", afterReload >= 1 && t2.includes("买牛奶"), `${afterReload} / ${t2}`);

console.log("\n5.5 反回归：反复开关编辑器，不能凭空多便签");
// 曾经的 bug：close() 发出保存后同步清掉 editing，保存回包到达时
// findIndex 落空走了 unshift 兜底 —— 视图里每次「点开→关闭」都多一张
// 一模一样的卡（库里只有一条，全是幻影）。
// 图床是注册表里的默认开模块；这里**显式关掉**，模拟用户手动关过的库
// （否则 fresh 库走不到降级路径）。
await setImagebed(false);
const fG = await reopenTool();
const ctxImagebedOff = await fG.evaluate(() => window.__ctxImagebed);
info("ctx.gallery（显式关掉图床）", ctxImagebedOff);
check("图床没开时工具知道要降级", ctxImagebedOff === false, String(ctxImagebedOff));
for (let round = 1; round <= 2; round++) {
  await fG.locator(".card").first().click();
  await page.waitForTimeout(700);
  await fG.locator("#e-title").fill(`买牛奶·第${round}次改`);
  await page.waitForTimeout(600);
  await fG.locator("#e-done").click();
  await page.waitForTimeout(900); // 等保存回包到达（幻影就在回包之后出现）
  const c = await fG.locator(".card").count();
  info(`第 ${round} 轮开关后的卡片数`, c);
  check(`开关编辑器不产生重复卡（第 ${round} 轮）`, c === 1, `cards=${c}`);
}

console.log("\n6. 图床没开也能附图（降级为内联直存）");
// 走真实入口：编辑面板里的文件选择框塞一张 1x1 PNG
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
await fG.locator(".card").first().click();
await page.waitForTimeout(700);
await fG.setInputFiles("#e-file", [{ name: "a.png", mimeType: "image/png", buffer: tinyPng }]);
await page.waitForTimeout(1200);
const editorImgs = await fG.locator("#e-imgs img").count();
info("编辑器里的附图数", editorImgs);
check("图床没开也能把图挂上", editorImgs >= 1, `imgs=${editorImgs}`);
const inlineSrc = await fG.locator("#e-imgs img").first().getAttribute("src").catch(() => "");
check("走的是内联 dataURL（不依赖图床）", String(inlineSrc).startsWith("data:"), String(inlineSrc).slice(0, 40));
// 关掉编辑器 → 刷新 → 卡片上的图还在
await fG.locator("#e-done").click();
await page.waitForTimeout(600);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const f3 = await reopenTool(2000);
const cardImgs = await f3.locator(".card .thumbs img").count();
info("刷新后卡片上的缩略图数", cardImgs);
check("刷新后随签直存的图还在", cardImgs >= 1, `imgs=${cardImgs}`);
const cardSrc = cardImgs ? await f3.locator(".card .thumbs img").first().getAttribute("src").catch(() => "") : "";
check("落库的确实是 dataURL 本体", String(cardSrc).startsWith("data:"), String(cardSrc).slice(0, 40));

console.log("\n7. 图床开着时：走 gallery.put，签里只存 id");
await setImagebed(true);
const f4 = await reopenTool(2000);
const ctxImagebedOn = await f4.evaluate(() => window.__ctxImagebed);
info("ctx.gallery（开了图床）", ctxImagebedOn);
check("图床开启后上下文翻了牌", ctxImagebedOn === true, String(ctxImagebedOn));
const put = await askInTool("gallery.put", {
  dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  title: "便签附图-e2e",
});
info("gallery.put 结果", put && put.ok ? "ok id=" + (put.data && put.data.id) : JSON.stringify(put));
check("图存进了图床", !!(put && put.ok && put.data && put.data.id), JSON.stringify(put));

if (put && put.ok && put.data && put.data.id) {
  const gid = put.data.id;
  // 把这张图挂到便签上：直接写库，验证 images 列能存、也能读回来
  const now = new Date().toISOString();
  await askInTool("row.update", {
    table: "notes",
    id: await f4.evaluate(() => document.querySelector(".card").getAttribute("data-id")),
    patch: { images: JSON.stringify([gid]), updated_at: now },
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const f5 = await reopenTool(2000);
  const imgs = await f5.locator(".card .thumbs img").count();
  info("卡片上的缩略图数", imgs);
  check("便签卡片上出现了附图", imgs >= 1, `imgs=${imgs}`);
}

console.log("\n8. 控制台");
const real = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
if (real.length) real.slice(0, 5).forEach((e) => console.log("    !", e.slice(0, 160)));
check("没有控制台错误", real.length === 0, `${real.length} 条`);

// 留一张截图：卡片长什么样只能靠眼睛看，断言验不了。
// （换主题/改配色后，翻出这张图对比就能看出是不是退化了）
const OUT = "C:/AI_Production/Tools/.workbuddy/tools/out";
fsSync.mkdirSync(OUT, { recursive: true });
const shot = `${OUT}/workbench-notes.png`;
await page.screenshot({ path: shot, fullPage: false });
info("截图", shot);

await browser.close();

console.log("\n====================================================");
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log("失败清单：");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(failed ? 1 : 0);
