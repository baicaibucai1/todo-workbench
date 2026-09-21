/**
 * 面板宽度可拖：左右两侧都要能调、都要记得住。
 *
 * 这件的价值不在"能拖"，而在"拖完下次打开还在"以及"边界不失控" ——
 * 宽度一旦算成 NaN 或 0，表现就是面板凭空消失，且没有任何报错可查。
 * 所以除了拖动本身，这里还钉了持久化、边界夹取、复位三条。
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const URL = "http://localhost:1420/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const FRESH = process.argv.includes("--fresh");

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? `  → ${extra}` : ""}`);
  }
};
const info = (k, v) => console.log(`        ${k}: ${v}`);
const section = (t) => console.log(`\n${t}`);

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
if (FRESH) {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
}
await page.waitForTimeout(1200);

/** 造一条任务并打开详情：面板只有选中对象后才展开 */
await page.evaluate(async () => {
  const repo = await import("/src/lib/repo.ts");
  const l = await repo.createList("宽度验证", "#d4537e");
  await repo.createTask({ title: "宽度验证任务", listId: l.id });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.locator("[data-task-id]").first().locator("div.truncate").first().click();
await page.waitForTimeout(600);

const detailW = () =>
  page.getAttribute("[data-detail-width]", "data-detail-width").then(Number);
const sidebarW = () =>
  page
    .getAttribute("aside[data-sidebar-width]", "data-sidebar-width")
    .then(Number);

/** 抓住把手拖一段，顺带在松手前读一次宽度气泡 */
async function drag(sel, dx) {
  const box = await page.locator(sel).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, 420);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, 420, { steps: 12 });
  const readout = await page
    .locator("[data-resizer-readout]")
    .first()
    .innerText()
    .catch(() => "");
  await page.mouse.up();
  await page.waitForTimeout(350);
  return readout;
}

/* ------------------------------ 1. 把手要看得见 ------------------------------ */

section("1. 把手必须能被发现（原来是一条 5px 透明线）");

check("右侧面板有把手", (await page.locator("[data-resizer='detail']").count()) === 1);
check("左侧边栏有把手", (await page.locator("[data-resizer='sidebar']").count()) === 1);

const hit = await page.evaluate(() => {
  const g = (k) => {
    const el = document.querySelector(`[data-resizer='${k}']`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, 420);
    return {
      w: Math.round(r.width),
      cursor: getComputedStyle(el).cursor,
      reachable: top === el || el.contains(top),
      focusable: el.tabIndex >= 0,
      role: el.getAttribute("role"),
    };
  };
  return { detail: g("detail"), sidebar: g("sidebar") };
});
info("把手", JSON.stringify(hit));
// 5px 时抓不住（原来就是这么细），8px 是能稳定命中的下限
check("右侧把手命中区 ≥ 6px", (hit.detail?.w ?? 0) >= 6, String(hit.detail?.w));
check("左侧把手命中区 ≥ 6px", (hit.sidebar?.w ?? 0) >= 6, String(hit.sidebar?.w));
check("鼠标移到把手上时不会被别的元素挡住", !!hit.detail?.reachable && !!hit.sidebar?.reachable);
check("把手是 col-resize 光标", hit.detail?.cursor === "col-resize", String(hit.detail?.cursor));
check("把手可聚焦（键盘也能调）", !!hit.detail?.focusable && !!hit.sidebar?.focusable);
check("语义是 separator", hit.detail?.role === "separator", String(hit.detail?.role));

/* ------------------------------ 2. 拖动 ------------------------------ */

section("2. 拖动：方向要对（左侧往右变宽 / 右侧往左变宽）");

const d0 = await detailW();
const s0 = await sidebarW();
info("默认", `详情 ${d0} · 侧栏 ${s0}`);
check("默认详情 360", d0 === 360, String(d0));
check("默认侧栏 280", s0 === 280, String(s0));

const dRead = await drag("[data-resizer='detail']", -120);
const d1 = await detailW();
info("详情拖了 -120", `${d0} → ${d1}，气泡「${dRead}」`);
check("右侧面板往左拖是变宽", d1 > d0, `${d0} → ${d1}`);
check("拖动时显示宽度读数", /\d+\s*px/.test(dRead), dRead);
check("读数与最终宽度一致", dRead.replace(/\s/g, "") === `${d1}px`, `${dRead} vs ${d1}`);

const sRead = await drag("[data-resizer='sidebar']", 90);
const s1 = await sidebarW();
info("侧栏拖了 +90", `${s0} → ${s1}，气泡「${sRead}」`);
check("左侧边栏往右拖是变宽", s1 > s0, `${s0} → ${s1}`);
check("侧栏拖动时也有读数", /\d+\s*px/.test(sRead), sRead);

// 留一张"正在拖"的截图：松手后气泡就消失了，
// 只有拖到一半才能同时看到蓝色把手和宽度读数
{
  const box = await page.locator("[data-resizer='detail']").first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, 420);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, 420, { steps: 8 });
  await page.waitForTimeout(200);
  const dir = path.join(process.cwd(), "shots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, "16-panel-resize.png") });
  info("截图", path.join(dir, "16-panel-resize.png"));
  await page.mouse.up();
  await page.waitForTimeout(300);
}


/* ------------------------------ 3. 键盘与复位 ------------------------------ */

section("3. 键盘微调与双击复位");

await page.locator("[data-resizer='sidebar']").first().focus();
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(350);
const s2 = await sidebarW();
check("侧栏按右方向键变宽（每次 16px）", s2 === s1 + 32, `${s1} → ${s2}`);
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(350);
check("按左方向键变窄", (await sidebarW()) === s2 - 16, String(await sidebarW()));

await page.locator("[data-resizer='detail']").first().dblclick();
await page.waitForTimeout(350);
check("双击把手把详情复位到 360", (await detailW()) === 360, String(await detailW()));
await page.locator("[data-resizer='sidebar']").first().dblclick();
await page.waitForTimeout(350);
check("双击把手把侧栏复位到 280", (await sidebarW()) === 280, String(await sidebarW()));

/* ------------------------------ 4. 持久化 ------------------------------ */

section("4. 刷新后还得是这个宽度（拖完重来一次等于没这功能）");

await drag("[data-resizer='detail']", -200);
await drag("[data-resizer='sidebar']", -50);
const before = { d: await detailW(), s: await sidebarW() };
info("刷新前", JSON.stringify(before));

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1300);
await page.locator("[data-task-id]").first().locator("div.truncate").first().click();
await page.waitForTimeout(500);
const after = { d: await detailW(), s: await sidebarW() };
info("刷新后", JSON.stringify(after));
check("详情宽度跨刷新保留", after.d === before.d, `${before.d} → ${after.d}`);
check("侧栏宽度跨刷新保留", after.s === before.s, `${before.s} → ${after.s}`);

/* ------------------------------ 5. 边界 ------------------------------ */

section("5. 边界：拖过头必须夹住，不能算出 0 或负值");

await drag("[data-resizer='sidebar']", -900);
check("侧栏拖到底夹在下限 220", (await sidebarW()) === 220, String(await sidebarW()));
await drag("[data-resizer='sidebar']", 900);
check("侧栏拖到顶夹在上限 420", (await sidebarW()) === 420, String(await sidebarW()));

await drag("[data-resizer='detail']", 900);
check("详情拖到底夹在下限 280", (await detailW()) === 280, String(await detailW()));
await drag("[data-resizer='detail']", -900);
check("详情拖到顶夹在上限 720", (await detailW()) === 720, String(await detailW()));

/* ------------------------------ 6. 收起时不该能拖 ------------------------------ */

section("6. 工具占满右半区时，详情把手要跟着消失");

await page.locator('aside [data-nav^="tool:"]').first().click();
await page.waitForTimeout(800);
check("打开工具后详情把手不存在", (await page.locator("[data-resizer='detail']").count()) === 0);
// 注意 data-detail-width 记的是**用户设定的宽度**（收起时也要留住，否则切回来
// 又变回默认值），要看"是否让位"得量真实渲染宽度
const rendered = await page.evaluate(() => {
  const el = document.querySelector("[data-detail-width]");
  return el ? Math.round(el.getBoundingClientRect().width) : -1;
});
info("工具打开时详情渲染宽度", rendered);
check("详情面板真的让位（渲染宽度为 0）", rendered === 0, String(rendered));
check("让位期间仍记得用户设定的宽度", (await detailW()) === 720, String(await detailW()));
check("侧栏把手仍在（侧栏不参与让位）", (await page.locator("[data-resizer='sidebar']").count()) === 1);

await page.locator('aside [data-nav="all"]').first().click();
await page.waitForTimeout(700);
check("切回待办后把手回来了", (await page.locator("[data-resizer='detail']").count()) === 1);
const backW = await page.evaluate(() => {
  const el = document.querySelector("[data-detail-width]");
  return el ? Math.round(el.getBoundingClientRect().width) : -1;
});
check("切回后按记住的宽度恢复（720）", backW === 720, String(backW));

/* ------------------------------ 收尾 ------------------------------ */

check("全程没有控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log("\n" + "=".repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log("=".repeat(52));

await browser.close();
process.exit(fail ? 1 : 0);
