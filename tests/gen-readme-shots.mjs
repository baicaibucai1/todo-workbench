/**
 * 重拍 README「界面速览」用的截图。
 *
 * 为什么单独有这个脚本：README 里的图必须跟着界面走，而界面这几轮改得很勤
 * （顶栏删了、右侧「计划内」视图删了、待办行改整行浮起、详情拆成分区卡片…）。
 * 图旧了比没有图更糟 —— 读者会拿旧图去对界面，然后发现对不上。
 *
 * 刻意**不**从 e2e 里截图：那些套件跑起来会改数据（新建 / 勾完成 / 删库），
 * 顺手截出来的图状态不可控。这里只做"清库 → 点导航 → 按快门"三件事。
 *
 * 用法（dev server 要先在 1420 上跑）：
 *   node tests/gen-readme-shots.mjs                       # 全部重拍
 *   node tests/gen-readme-shots.mjs --only settings-tools # 只拍指定的（可跟多个）
 *
 * `--only` 是为了改一处界面时别把 15 张图全换掉 —— 全量重拍会让 diff 里
 * 混进一堆毫无变化的二进制文件，评审时根本看不出真正改的是哪张。
 *
 * 产物写到 docs/screenshots/，文件名与 README 里的引用**一一对应**。
 * 这里每加一个 `shot()`，README 就得同步加一行引用；反过来 README 里删了
 * 引用，这里的 `shot()` 也要跟着删 —— 否则下一次全量重拍就会留下一张没人
 * 引用的孤儿图（`docs/screenshots/settings.png` 曾经就是这么来的：这里拍了、
 * README 没引用，于是白占 97 KB 还让人以为是漏了什么）。
 *
 * 「设置 · 关于」不在这儿拍，它在 tests/gen-about-shot.mjs。
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { prepareFreshWithSampleData } from "./_seed-sample-data.mjs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");
const { enableModule } = await import("./_enable-module.mjs");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:1420/";
const OUT = path.resolve("docs/screenshots");

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({
  viewport: { width: 1500, height: 940 },
  deviceScaleFactor: 1.5, // README 里是缩放显示的，高一点更清晰
});
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

/** 只拍这几张；不给 --only 就是全拍 */
const onlyArg = process.argv.indexOf("--only");
const ONLY =
  onlyArg === -1
    ? null
    : new Set(process.argv.slice(onlyArg + 1).filter((a) => !a.startsWith("--")));
const want = (name) => !ONLY || ONLY.has(name);

const shot = async (name) => {
  if (!want(name)) return;
  await page.waitForTimeout(700);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${name}.png`);
};

/** 清掉演示库再刷新：截图要的是种子数据的样子，不是上一条用例残留的状态。
 *  v20 起示例数据选装，裸清出来的是真空库（连「工作」清单都没有），
 *  必须走 helper 把开关打开，种子的样子才会回来。 */
console.log("准备干净的演示库…");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
const shotPrepared = await prepareFreshWithSampleData(page);
console.log(`  演示库准备: ${shotPrepared}`);

/** 点侧边栏某个导航项；工具与视图都用 data-nav。
 *  选装模块没开时侧栏里就没有那一项 —— 不是"点了没反应"，是压根不存在，
 *  所以这里宁可早点炸在一句人话上，也别让它卡满 30 秒超时。 */
const nav = async (key) => {
  const item = page.locator(`aside[data-sidebar-width] [data-nav="${key}"]`).first();
  if ((await item.count()) === 0) {
    throw new Error(
      `侧边栏里没有 data-nav="${key}" —— 多半是它所在的选装模块没打开（见下方 enableModule）`,
    );
  }
  await item.click();
  await page.waitForTimeout(600);
};

/** 这两个模块默认关闭，而 README 里要截它们的界面，所以先按真实界面打开它们 */
await enableModule(page, "special");
await enableModule(page, "gallery");

console.log("开始截图：");

await nav("myday");
await shot("my-day");

await nav("all");
await shot("all-tasks");

/* 面板可拖拽：按住在把手上面拖一段，截图要的是"拖动中"那一刻 ——
   常驻的淡竖线看不出手感，拖动时才浮出的宽度读数才说明问题。 */
const handle = page.locator('[data-resizer="detail"]');
if ((await handle.count()) > 0) {
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 12 });
    await shot("resizable-panels");
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
}

await nav("orders");
await shot("orders");

/* 流程任务详情：视图里默认就展开第一条，所以紧接着再拍一张拿到的是**一模一样的
   画面**（两张 md5 相同，README 里却挂了两个不同标题 —— 等于骗人）。
   这里把详情面板滚到「流转记录」，既换了画面，也让"过程态流转留痕"真的入镜。
   刻意**不改数据**：不点阶段条（那会真的推进流程），只滚动。 */
{
  const trace = page.getByText("流转记录", { exact: true }).first();
  if ((await trace.count()) > 0) {
    await trace.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  }
}
await shot("order-detail");

await nav("special");
await shot("special-orders");

await nav("gallery");
await shot("gallery");

// 紧急区不是导航项 —— 它是侧边栏底部那个常驻面板，回「全部」让它露出来即可
await nav("all");
await shot("urgent");

await nav("settings");
await shot("settings");
await page.locator('[data-section="tools"]').click();
await shot("settings-tools");

// 「设置 · 同步」：演示模式下按钮是灰的、并有一段说明 —— 截的就是这个真实状态
await page.locator('[data-section="sync"]').click();
await shot("settings-sync");

// 工具：每个工具位都进去截一张，README 里按 <id> 引用
const toolNavs = page.locator('aside[data-sidebar-width] [data-nav^="tool:"]');
const toolCount = await toolNavs.count();
const wantTools = !ONLY || [...ONLY].some((x) => x.startsWith("tool-"));
if (toolCount && wantTools) console.log(`  发现 ${toolCount} 个工具位`);
for (let i = 0; wantTools && i < toolCount; i++) {
  const item = toolNavs.nth(i);
  const id = ((await item.getAttribute("data-nav")) || "").replace("tool:", "");
  await item.click();
  await page.waitForTimeout(1600); // 工具是 iframe，得等它自己渲染完
  await shot(`tool-${id}`);
}

await browser.close();

if (errors.length) {
  console.log(`\n⚠️ 页面报错 ${errors.length} 条：`);
  for (const e of errors.slice(0, 5)) console.log(`  ${e}`);
}
console.log("\n完成。");