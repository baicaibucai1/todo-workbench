/**
 * 待办背景（壁纸）验证。
 *
 * 关注点：壁纸不只是一张图铺上去 ——
 *   1) 清单真的读到了（不是"有按钮但点了没反应"）
 *   2) 铺上去的图**被浏览器真的解码了**（naturalWidth > 0）
 *      这一条不能省：src 写错时 <img> 也在 DOM 里，不看解码结果就会误判成功
 *   3) 遮罩跟着强度变（亮照片上白字要看得清）
 *   4) 刷新后仍在（配置落库），切回「跟随视图」能干净地撤掉
 *
 * 依赖 QQbot 里已装的 playwright + 本机 Edge。
 * 前置：`node node_modules/vite/bin/vite.js` 在跑（http://localhost:1420/）。
 *
 * 用法：node tests/background.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";

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

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

/** 待办区（左侧列表容器）的背景层状态 */
const bgMode = () => page.locator("[data-bg-mode]").first().getAttribute("data-bg-mode");
const bgImg = () => page.locator("[data-bg-image]").first();
const scrimColor = () =>
  page.evaluate(() => {
    const layer = document.querySelector("[data-bg-image]")?.parentElement;
    const scrimEl = layer?.children[1];
    return scrimEl ? getComputedStyle(scrimEl).backgroundColor : "";
  });

async function openAppearance() {
  await page.locator('aside [data-nav="settings"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-section="appearance"]').click();
  await page.waitForTimeout(500);
}

async function backToTodo() {
  await page.locator('aside [data-nav="myday"]').click();
  await page.waitForTimeout(500);
}

console.log("\n1. 打开设置 → 外观");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
await openAppearance();

const options = page.locator("[data-bg-option]");
const count = await options.count();
info("背景选项数（含「跟随视图」）", count);
check("背景分区存在且读到了壁纸清单", count >= 2, `count=${count}`);

const autoBtn = page.locator('[data-bg-option="auto"]');
check("有「跟随视图」这个默认项", (await autoBtn.count()) === 1);

// 清单是随包发布的，最少也得有几张 —— 一张都没有说明 public/wallpapers 没同步过来
check("壁纸至少 3 张可用", count - 1 >= 3, `${count - 1} 张`);

// 缩略图带 loading="lazy"，首屏之外的还没开始加载是正常的；
// 真正要挡的是"src 写错"——那种情况 complete 为真但 naturalWidth 是 0
const thumbs = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll("[data-bg-option] img")];
  return {
    total: imgs.length,
    decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
  };
});
info("缩略图解码情况", thumbs);
check("缩略图没有坏图", thumbs.broken === 0, JSON.stringify(thumbs));
check("已加载的缩略图能真解码", thumbs.decoded >= 3, JSON.stringify(thumbs));

console.log("\n2. 选一张壁纸，待办区应该铺上图");
const picked = await options.nth(1).getAttribute("data-bg-option");
info("选中的壁纸文件", picked);
await options.nth(1).click();
await page.waitForTimeout(600);

await backToTodo();
check("待办区进入壁纸模式", (await bgMode()) === "image", String(await bgMode()));
check("data-bg-file 与所选一致", (await page.locator("[data-bg-mode]").first().getAttribute("data-bg-file")) === picked);

const decoded = await bgImg().evaluate((el) => ({
  complete: el.complete,
  w: el.naturalWidth,
  h: el.naturalHeight,
}));
info("背景图解码结果", decoded);
check("背景图真的被浏览器解码（不是坏图）", decoded.complete && decoded.w > 0 && decoded.h > 0);
check("背景图铺满容器（cover）",
  (await bgImg().evaluate((el) => getComputedStyle(el).objectFit)) === "cover");

// 负 z-index 是这套东西的关键：写错了图会把列表整块盖住
const behind = await page.evaluate(() => {
  const layer = document.querySelector("[data-bg-image]")?.parentElement;
  if (!layer) return null;
  const z = getComputedStyle(layer).zIndex;
  const row = document.querySelector("[data-task-id]");
  if (!row) return { z, rowAbove: null };
  // 点在列表行中央，若命中的是行本身（而不是背景层），说明背景确实垫在下面
  const r = row.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { z, rowAbove: !!hit?.closest("[data-task-id]") };
});
info("背景层 z-index / 列表行是否在可点层", behind);
check("背景层压在内容之下（-z-10）", behind?.z === "-10", `z=${behind?.z}`);
check("列表行仍然可点（不被背景层挡住）", behind?.rowAbove === true);

await page.screenshot({ path: `${SHOT_DIR}/bg-wallpaper-myday.png` });
info("截图", `${SHOT_DIR}/bg-wallpaper-myday.png`);

console.log("\n3. 遮罩强度可调");
await openAppearance();
const scrimBtns = page.locator("[data-bg-scrim]");
check("选中壁纸后才出现遮罩设置", (await scrimBtns.count()) === 3, `${await scrimBtns.count()} 档`);

// 遮罩层只在待办区里，而设置界面会把它顶掉 —— 所以每换一档都要回到待办区去读
await scrimBtns.nth(0).click();
await page.waitForTimeout(400);
await backToTodo();
const soft = await scrimColor();
info("弱档遮罩色", soft);

await openAppearance();
await page.locator("[data-bg-scrim]").nth(2).click();
await page.waitForTimeout(400);
await backToTodo();
const strong = await scrimColor();
info("强档遮罩色", strong);

check("遮罩层确实存在", !!soft && soft !== "rgba(0, 0, 0, 0)", `soft=${soft}`);
check("遮罩强度确实改变了遮罩层", soft !== strong, `${soft} vs ${strong}`);

console.log("\n4. 刷新后仍然生效（配置落库）");
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);
check("刷新后仍是壁纸背景", (await bgMode()) === "image", String(await bgMode()));
check("刷新后还是同一张", (await page.locator("[data-bg-mode]").first().getAttribute("data-bg-file")) === picked);
const afterReload = await bgImg().evaluate((el) => el.naturalWidth > 0);
check("刷新后图片依然解码成功", afterReload);

console.log("\n5. 切回「跟随视图」应干净撤掉");
await openAppearance();
await autoBtn.click();
await page.waitForTimeout(500);
check("遮罩设置随之收起", (await page.locator("[data-bg-scrim]").count()) === 0);

await backToTodo();
check("待办区回到渐变模式", (await bgMode()) === "auto", String(await bgMode()));
check("背景图元素已移除", (await page.locator("[data-bg-image]").count()) === 0);

console.log("\n6. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

fs.mkdirSync(SHOT_DIR, { recursive: true });
await browser.close();

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
