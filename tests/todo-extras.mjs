/**
 * 待办进阶功能的浏览器验证：子任务、提醒、任务关联、面板动效。
 *
 * 这里只验证"用起来对不对"，不重复 smoke 已覆盖的数据层行为。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/todo-extras.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });

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

const detail = () => page.locator("[data-task-detail]");
const rows = () => page.locator("[data-task-id]");
const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/${n}.png` });

const detailOpen = async () =>
  (await detail().count()) > 0 && (await detail().isVisible());

async function openRow(i = 0) {
  await rows().nth(i).locator("div.truncate").first().click();
  await page.waitForTimeout(350);
}

/** 提醒扫描是 30 秒一轮，测试里用"窗口重新可见"这条即时通道触发 */
const pokeReminders = () =>
  page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

console.log("\n1. 子任务（步骤）");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(500);

await openRow(0);
check("详情面板已展开", await detailOpen());

for (const s of ["核对尺寸表", "导出图片", "发给客户"]) {
  await page.locator("[data-step-input]").fill(s);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
}
check("步骤进度显示 0/3", (await page.locator("[data-step-progress]").textContent()) === "0/3");

// 勾掉第一个步骤
await page.locator("[data-step-toggle]").first().click();
await page.waitForTimeout(450);
check("勾选后进度变为 1/3", (await page.locator("[data-step-progress]").textContent()) === "1/3");
check("列表行同步显示步骤进度",
  (await rows().nth(0).locator("[data-step-badge]").textContent())?.includes("1/3"));
await shot("10-steps");

const taskId = await rows().nth(0).getAttribute("data-task-id");
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(500);
check("刷新后步骤仍在",
  (await rows().nth(0).locator("[data-step-badge]").textContent())?.includes("1/3"),
  String(await rows().nth(0).locator("[data-step-badge]").count()));

console.log("\n2. 定时提醒");
await page.locator(`[data-task-id="${taskId}"] div.truncate`).first().click();
await page.waitForTimeout(350);
// 填一个已经过去的时间 = 立刻到点
await page.locator("[data-reminder-input]").fill("2026-09-01T09:00");
await page.waitForTimeout(500);
const hint = (await page.locator("[data-reminder-hint]").textContent()) || "";
info("提醒提示", hint.trim());
check("详情显示提醒时间", hint.includes("提醒") && hint.includes("已到点"));

await pokeReminders();
await page.waitForTimeout(700);
check("到点后弹出提醒卡片", (await page.locator("[data-reminder]").count()) === 1);
await shot("11-reminder");

await page.locator('[data-act="reminder-snooze"]').click();
await page.waitForTimeout(600);
check("推迟后卡片消失", (await page.locator("[data-reminder]").count()) === 0);
check("推迟后提醒时间被改到将来",
  !((await page.locator("[data-reminder-hint]").textContent()) || "").includes("已到点"));

// 再次设成过去时间，应当还能提醒 —— 验证推迟不是"永久静音"
await page.locator("[data-reminder-input]").fill("2026-09-01T09:00");
await page.waitForTimeout(400);
await pokeReminders();
await page.waitForTimeout(700);
check("重新到点仍会提醒", (await page.locator("[data-reminder]").count()) === 1);

await page.locator('[data-act="reminder-done"]').click();
await page.waitForTimeout(700);
check("「完成」后卡片消失", (await page.locator("[data-reminder]").count()) === 0);
check("「完成」后任务被勾掉", (await rows().count()) >= 0);

console.log("\n3. 任务关联");
await page.locator('[data-nav="myday"]').click();
await page.waitForTimeout(400);
await page.locator('input[placeholder="添加任务"]').fill("关联目标任务");
await page.keyboard.press("Enter");
await page.waitForTimeout(600);

// 新建的任务排在最前，宿主任务要挑第二条，否则搜到的候选就是它自己
await openRow(1);
const hostId = await rows().nth(1).getAttribute("data-task-id");
const hostTitle = await detail().locator("textarea").first().inputValue();
info("主任务", hostTitle);
check("宿主任务不是刚建的那条", !hostTitle.includes("关联目标"), hostTitle);

await page.locator("[data-link-search]").fill("关联目标");
await page.waitForTimeout(400);
const optionCount = await page.locator("[data-link-option]").count();
check("搜索能找到候选任务", optionCount >= 1, `count=${optionCount}`);
await page.locator("[data-link-option]").first().click();
await page.waitForTimeout(600);
check("关联已建立", (await page.locator("[data-linked]").count()) === 1);
await shot("12-links");

// 点关联项应跳到那条任务的详情
await page.locator("[data-linked] button").first().click();
await page.waitForTimeout(500);
const jumpedTitle = await detail().locator("textarea").first().inputValue();
info("跳转后标题", jumpedTitle);
check("点关联任务可跳转详情", jumpedTitle.includes("关联目标"), jumpedTitle);

// 回到主任务解除关联
await page.locator(`[data-task-id="${hostId}"] div.truncate`).first().click();
await page.waitForTimeout(400);
await page.locator("[data-linked] button").last().click();
await page.waitForTimeout(600);
check("解除关联生效", (await page.locator("[data-linked]").count()) === 0);

console.log("\n3b. 新建的任务要立刻能搜到");
// 面板就停在主任务上不动。新建任务**不会**让面板重建（选中的那条还活着，
// selectFirst 不会切走），于是"候选池只在挂载时取一次"这种写法就会让
// 刚建好的任务永远不在候选里 —— 表现是"明明建好了却搜不到"。
await page.locator('input[placeholder="添加任务"]').fill("刚建好就要关联");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
const hostStill = await detail().locator("textarea").first().inputValue();
check("新建任务不会把详情面板顶走", hostStill === hostTitle, hostStill);

await page.locator("[data-link-search]").fill("刚建好就要关联");
await page.waitForTimeout(800);
const freshHits = await page.locator("[data-link-option]").count();
check("刚建的任务立刻出现在候选里", freshHits >= 1, `count=${freshHits}`);
await page.locator("[data-link-search]").fill("");
await page.waitForTimeout(300);

console.log("\n4. 面板动效");
await page.locator(`[data-task-id="${hostId}"] div.truncate`).first().click();
await page.waitForTimeout(400);
const animName = await page.evaluate(() => {
  const el = document.querySelector("[data-task-detail] .animate-panel-in");
  return el ? getComputedStyle(el).animationName : "none";
});
info("入场动画", animName);
check("内容块带入场动画", animName === "panel-in", animName);

const openedWidth = await detail().evaluate((el) => el.getBoundingClientRect().width);
check("展开时宽度 360", Math.round(openedWidth) === 360, String(openedWidth));

const transitionProp = await detail().evaluate((el) => getComputedStyle(el).transitionProperty);
info("过渡属性", transitionProp);
check("宽度带过渡（有滑入滑出）", transitionProp.includes("width"), transitionProp);

// 「关闭」的语义变了：面板常驻，关掉的只是内容（切成空态），宽度不动。
// 面板整体让位只发生在"工具/设置占满右半区"时。
await page.locator('[data-task-detail] button[title="关闭详情"]').click();
await page.waitForTimeout(500);
const closedWidth = await detail().evaluate((el) => el.getBoundingClientRect().width);
check("关闭后宽度仍是 360（面板常驻，不整块收起）",
  Math.round(closedWidth) === 360, String(closedWidth));
const closedMode = await detail().getAttribute("data-detail-mode");
check("关闭后内容切成空态", closedMode === "empty", String(closedMode));

console.log("\n5. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
