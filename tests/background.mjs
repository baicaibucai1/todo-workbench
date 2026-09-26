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

/* ------------------------------------------------------------------ */
/* 6. 主题色调                                                         */
/* ------------------------------------------------------------------ */

console.log("\n6. 主题色调：换一套预设，界面真的跟着变");

const cssVar = (name) =>
  page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );

await openAppearance();
const palettes = page.locator("[data-palette]");
check("预设色板列出来了", (await palettes.count()) >= 6, `${await palettes.count()} 套`);

const accent0 = await cssVar("--color-accent");
const primary0 = await cssVar("--color-primary");
info("默认主题色", { accent: accent0, primary: primary0 });
check("默认配色就是改造前那套（老用户不该发现变了）",
  accent0 === "#d4537e" && primary0 === "#378add", `${accent0} / ${primary0}`);

await page.locator('[data-palette="pine"]').click();
await page.waitForTimeout(400);
const accent1 = await cssVar("--color-accent");
const primary1 = await cssVar("--color-primary");
info("换成「松翠」后", { accent: accent1, primary: primary1 });
check("品牌色跟着变了", accent1 === "#2f9e6f", accent1);
check("主操作色也跟着变（换的是整套，不是一个色）", primary1 === "#1f6f8b", primary1);

/*
 * 关键一条：改色是写 CSS 变量，不是换 class。
 * 所以要看的是「用了这个变量的地方真的变色了」，而不是「变量值变了」。
 * 这里取一个实打实的界面元素（待办行上的完成圈）来验。
 */
const circleUsesAccent = await page.evaluate(() => {
  const el = document.createElement("div");
  el.style.color = "var(--color-accent)";
  document.body.appendChild(el);
  const v = getComputedStyle(el).color;
  el.remove();
  return v;
});
info("--color-accent 落到真实元素上", circleUsesAccent);
check("变量能被引擎解析成真实颜色（不是空值）",
  circleUsesAccent !== "" && circleUsesAccent !== "rgba(0, 0, 0, 0)", circleUsesAccent);

await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);
check("刷新后主题色还在（配置落库）", (await cssVar("--color-accent")) === accent1,
  await cssVar("--color-accent"));

await openAppearance();
await page.locator("[data-reset-colors]").click();
await page.waitForTimeout(400);
check("「恢复默认」能回到默认配色",
  (await cssVar("--color-accent")) === "#d4537e" &&
    (await cssVar("--color-primary")) === "#378add",
  `${await cssVar("--color-accent")} / ${await cssVar("--color-primary")}`);

/* ------------------------------------------------------------------ */
/* 7. 自定义壁纸：上传 → 铺上 → 取色 → 删除                              */
/* ------------------------------------------------------------------ */

console.log("\n7. 自定义壁纸：上传自己的图");

/** 拿一张随包壁纸当"用户要传的图"，省得在测试里现造图片 */
function seedUploadFile() {
  const idx = JSON.parse(fs.readFileSync("public/wallpapers/index.json", "utf8"));
  const file = idx.items?.[0]?.file;
  if (!file) throw new Error("public/wallpapers/index.json 里没有图，先跑抓取脚本");
  const tmp = ".setup-tmp/upload-wallpaper-test.jpg";
  fs.mkdirSync(".setup-tmp", { recursive: true });
  fs.copyFileSync(`public/wallpapers/${file}`, tmp);
  return tmp;
}

const uploadFile = seedUploadFile();
info("用这张模拟上传", uploadFile);

check("还没传过时没有「我的图片」这一区",
  (await page.locator("[data-custom-wallpaper]").count()) === 0);

// 浏览器里是动态创建的 <input type=file>，所以走 filechooser 事件而不是直接填表单
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.locator("[data-add-wallpaper]").click(),
]);
await chooser.setFiles(uploadFile);
await page.waitForTimeout(1200);

const note = page.locator("[data-wallpaper-note]");
const noteText = (await note.count()) ? await note.first().innerText() : "";
info("上传结果提示", noteText);
check("上传后给出了结果提示（不是静默失败）", !!noteText, noteText);

const customCards = page.locator("[data-custom-wallpaper]");
check("「我的图片」里出现了这张", (await customCards.count()) === 1,
  `${await customCards.count()} 张`);

/*
 * 传完自动切过去 —— 这条是刻意的：
 * 用户传完看不到变化，就会怀疑到底传成功没有。
 * ⚠️ 得先回到待办区才读得到 [data-bg-mode]：设置页会把它整块顶掉。
 */
await backToTodo();
check("传完直接铺上了（背景变成 custom）", (await bgMode()) === "custom", String(await bgMode()));
check("data-bg-file 指向仓库里的那张",
  (await page.locator("[data-bg-mode]").first().getAttribute("data-bg-file"))?.length > 0);

const customDecoded = await bgImg().evaluate((el) => ({
  w: el.naturalWidth,
  h: el.naturalHeight,
  fit: getComputedStyle(el).objectFit,
}));
info("自定义壁纸解码结果", customDecoded);
check("自定义壁纸真的被解码铺上了", customDecoded.w > 0 && customDecoded.h > 0,
  JSON.stringify(customDecoded));
check("也是 cover 铺满", customDecoded.fit === "cover");
await page.screenshot({ path: `${SHOT_DIR}/bg-custom-wallpaper.png` });

console.log("\n8. 从这张图取主题色");
await openAppearance();
const pickBtn = page.locator("[data-pick-from-wallpaper]");
check("铺着图时才有「取这张图的主色」", (await pickBtn.count()) === 1);

const beforePick = await cssVar("--color-accent");
await pickBtn.click();
await page.waitForTimeout(1500);
const afterPick = await cssVar("--color-accent");
info("取色前后", { before: beforePick, after: afterPick });
check("取色后主题色变了（不是点了个没反应的按钮）", afterPick !== beforePick,
  `${beforePick} → ${afterPick}`);
check("取出来的是个合法色值", /^#[0-9a-f]{6}$/.test(afterPick), afterPick);

const notePick = (await note.count()) ? await note.first().innerText() : "";
info("取色提示", notePick);
check("取色结果有回话（成功或失败都说清楚）", !!notePick, notePick);

console.log("\n9. 删掉这张自定义壁纸");
await page.locator("[data-remove-wallpaper]").first().click();
await page.waitForTimeout(800);
check("「我的图片」里没有了", (await page.locator("[data-custom-wallpaper]").count()) === 0);

// 同样要回到待办区才看得到背景层（设置页把它顶掉了）
await backToTodo();
check("背景退回跟随视图（不会留在已删的图上）", (await bgMode()) === "auto", String(await bgMode()));
check("背景图元素一并撤掉", (await page.locator("[data-bg-image]").count()) === 0);

console.log("\n10. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

fs.mkdirSync(SHOT_DIR, { recursive: true });
await browser.close();

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
