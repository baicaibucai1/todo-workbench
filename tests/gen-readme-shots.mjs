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
 *   node tests/gen-readme-shots.mjs
 *
 * 产物写到 docs/screenshots/，文件名与 README 里的引用一一对应。
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

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

const shot = async (name) => {
  await page.waitForTimeout(700);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${name}.png`);
};

/** 清掉演示库再刷新：截图要的是种子数据的样子，不是上一条用例残留的状态 */
console.log("准备干净的演示库…");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("todo-workbench")) localStorage.removeItem(k);
  }
});
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(1200);

/** 点侧边栏某个导航项；工具与视图都用 data-nav */
const nav = async (key) => {
  await page.locator(`aside[data-sidebar-width] [data-nav="${key}"]`).first().click();
  await page.waitForTimeout(600);
};

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

// 工单详情：进工单视图后默认就展开了第一条，这里把面板拖宽一点更像"详情"该有的样子
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

// 工具：每个工具位都进去截一张，README 里按 <id> 引用
const toolNavs = page.locator('aside[data-sidebar-width] [data-nav^="tool:"]');
const toolCount = await toolNavs.count();
console.log(`  发现 ${toolCount} 个工具位`);
for (let i = 0; i < toolCount; i++) {
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