/**
 * 任务详情面板验证。
 *
 * 关注点不是"面板能不能渲染"，而是它和列表是否真的在同一份数据上工作：
 * 在详情里改的每一行，列表都要立刻跟着变，刷新后还要落得住。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge（与 Tauri 的 WebView2 同源）。
 * 前置：`node node_modules/vite/bin/vite.js` 已在跑（默认 http://localhost:1420/）。
 *
 * 用法：node tests/task-detail.mjs [--url http://localhost:1420/] [--keep]
 */

import { createRequire } from "node:module";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

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

const rows = () => page.locator("[data-task-id]");
/** 待办 + 工单的合并行选择器：列表是混排的，「第一行」只有它能代表 */
const allRows = () => page.locator("[data-task-id], [data-order-id]");
const detail = () => page.locator("[data-task-detail]");
const detailVisible = async () =>
  (await detail().count()) > 0 && (await detail().isVisible());
const detailWidth = async () => detail().evaluate((el) => el.getBoundingClientRect().width);
const detailMode = async () => await detail().getAttribute("data-detail-mode");

/**
 * 列表第一行是否处于选中态。
 *
 * 用 data-active 而不是比对标题来断言，是因为要跨两种渲染器（待办标题在 textarea 里、
 * 工单不是），高亮是唯一一处两边写法相同的信号。而"高亮的行 = 详情里那条"
 * 正是这一步要守的不变式。
 *
 * 读 dataset 而不是 class：选中态现在是"整行浮起来"（圆角 + 投影 + 抬 1px），
 * 那是一串样式类名，改动视觉时不该连带改测试；data-active 是它的**语义**。
 */
const firstRowSelected = async () =>
  (await allRows().first().getAttribute("data-active")) === "true";

/**
 * 点某一行的标题区打开详情（避开行内的按钮）。
 *
 * 用合并选择器：混排列表里"第 0 行"可能是工单，而工单标题是 span、
 * 待办标题是 div，所以两边的定位器都要给。
 */
async function openRow(i = 0) {
  await allRows().nth(i).locator("[data-order-title], div.truncate").first().click();
  await page.waitForTimeout(250);
}

console.log("\n1. 加载工作台，切到「全部」");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(700);

await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(500);

let n = await rows().count();
if (n === 0) {
  await page.locator('input[placeholder="添加任务"]').fill("详情面板验证任务");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  n = await rows().count();
}
info("任务行数", n);
check("列表有任务可点", n > 0, `rows=${n}`);

// 设计已改：右侧栏常驻，进来自动选中第一条（用户原话「右侧栏始终展开，默认展开第一个待办」）。
// 所以这里要验的不是"面板藏着"，而是"面板已经开着、而且开的正是第一行"。
check("初始即展开详情面板（不再需要手点）", await detailVisible());
check("初始默认选中列表第一行（高亮与详情同源）", await firstRowSelected());
check("初始详情有内容（不是空态）", (await detailMode()) !== "empty", `mode=${await detailMode()}`);

console.log("\n2. 点开一条待办，右侧出现任务详情");
// 列表是待办与工单混排的，这里专门取一条**待办**（工单详情是另一套，见 preview.mjs）
const firstTask = rows().first();
const firstTitle = (await firstTask.locator("div.truncate").first().textContent()) || "";
info("待办标题", firstTitle.trim());
await firstTask.locator("div.truncate").first().click();
await page.waitForTimeout(300);

check("详情面板已出现", await detailVisible());
check("详情处于待办模式", (await detailMode()) === "task", `mode=${await detailMode()}`);
const detailTitle = await detail().locator("textarea").first().inputValue();
info("详情标题", detailTitle);
check("详情标题与所点任务一致", detailTitle.trim() === firstTitle.trim(),
  `${detailTitle} vs ${firstTitle}`);

// 后面几步都盯住这一条：第 4 步会改它的截止日期，列表按日期重排后
// "第 0 行"可能已经不是它了 —— 按 id 定位才不会误伤别的任务
const taskId = await firstTask.getAttribute("data-task-id");
const rowOf = (id) => page.locator(`[data-task-id="${id}"]`);

const rowActive = (await rowOf(taskId).getAttribute("data-active")) === "true";
// 选中态现在是"整行浮起"（lib/rowStyle），语义写在 data-active 上
check("被选中的行有高亮态", rowActive, await rowOf(taskId).getAttribute("class"));
// 浮起的边界要真的立起来：自己的圆角不能缺（缺了就是被外层容器把直角蹭出圆角之外的那条脏边）
const lift = await rowOf(taskId).evaluate((el) => {
  const s = getComputedStyle(el);
  return { radius: parseFloat(s.borderTopLeftRadius), shadow: s.boxShadow, z: s.zIndex };
});
check("选中行是真浮起：有圆角", lift.radius >= 6, `radius=${lift.radius}`);
check("选中行是真浮起：有投影", lift.shadow !== "none", lift.shadow);
check("选中行是真浮起：盖在相邻行上", lift.z === "10", `z=${lift.z}`);
check("详情默认宽度 360（可拖宽，见 orders-view 套件）", (await detailWidth()) === 360);

console.log("\n3. 在详情里切换「我的一天」");
const myDayBtn = detail().locator("button").filter({ hasText: "我的一天" }).first();
const myDayBefore = (await myDayBtn.textContent()) || "";
await myDayBtn.click();
await page.waitForTimeout(500);
const myDayAfter = (await myDayBtn.textContent()) || "";
info("按钮文案", `${myDayBefore.trim()} → ${myDayAfter.trim()}`);
check("开关文案已翻转", myDayBefore.trim() !== myDayAfter.trim());

const rowText = (await rowOf(taskId).textContent()) || "";
const myDayOn = myDayAfter.includes("已添加");
check("列表行同步出现「我的一天」标记",
  myDayOn === rowText.includes("我的一天"),
  `详情=${myDayOn} 行=${rowText.includes("我的一天")}`);

console.log("\n4. 在详情里设置截止日期");
await detail().locator("button").filter({ hasText: /^明天$/ }).first().click();
await page.waitForTimeout(500);
const dateLine = (await detail().locator("div").filter({ hasText: "当前：" }).last().textContent()) || "";
info("日期行", dateLine.trim());
check("详情显示已设置为明天", dateLine.includes("明天"), dateLine.trim());

console.log("\n5. 备注防抖落库（刷新后仍在）");
const NOTE = "验证备注：由详情面板写入 " + Date.now();
await detail().locator("textarea").nth(1).fill(NOTE);
await page.waitForTimeout(900); // 防抖 400ms + 落库

await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(700);
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(500);
await rowOf(taskId).locator("div.truncate").first().click();
await page.waitForTimeout(300);

// 先确认"点开的就是那条"再看备注 —— 否则一旦选错对象，
// 下一条断言会伪装成"备注没落库"，把排查方向带偏（真踩过）
const reopened = (await detail().locator("textarea").first().inputValue()) || "";
const expectedTitle = ((await rowOf(taskId).locator("div.truncate").first().textContent()) || "").trim();
check("刷新后点开的是同一条任务", reopened.trim() === expectedTitle, `${reopened} vs ${expectedTitle}`);

const noteAfterReload = await detail().locator("textarea").nth(1).inputValue();
info("刷新后备注", noteAfterReload.slice(0, 40));
check("备注已持久化", noteAfterReload === NOTE, noteAfterReload.slice(0, 60));

console.log("\n6. 在详情里改标题，列表行跟着变");
const NEW_TITLE = "改名后的任务 " + String(Date.now()).slice(-4);
const titleBox = detail().locator("textarea").first();
await titleBox.fill(NEW_TITLE);
await titleBox.blur();
await page.waitForTimeout(600);
const rowTitle = (await rowOf(taskId).locator("div.truncate").first().textContent()) || "";
info("行标题", rowTitle.trim());
check("列表行标题已更新", rowTitle.trim() === NEW_TITLE, rowTitle.trim());

// 留一张截图：面板的视觉问题（挤压、错位、文字截断）自动化断言查不出来
import fs from "node:fs";
const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = `${SHOT_DIR}/workbench-task-detail.png`;
await page.screenshot({ path: SHOT });
info("截图", SHOT);

console.log("\n6b. 日期与提醒挨在一张卡片里");
const cards = await page.evaluate(() => {
  const due = document.querySelector('[data-detail-part="due"]');
  const rem = document.querySelector('[data-detail-part="reminder"]');
  if (!due || !rem) return "missing";
  const sameCard = due.parentElement === rem.parentElement;
  // nextElementSibling 而非"同父"：挨在一起要的是紧邻，不是同在一块大区域里
  return sameCard && due.nextElementSibling === rem ? "adjacent" : "separated";
});
check("截止日期与提醒在同一张卡片上下相邻", cards === "adjacent", cards);
check("「日期与提醒」是单独一个分区",
  (await detail().locator('[data-detail-section="schedule"]').count()) === 1);
check("详情一共就六块分区", (await page.locator("[data-detail-section]").count()) === 6,
  String(await page.locator("[data-detail-section]").count()));

console.log("\n6c. 设置里调整详情分区顺序");
const orderRows = () => page.locator("[data-detail-order-row]");
const readOrder = () =>
  orderRows().evaluateAll((els) => els.map((e) => e.getAttribute("data-detail-order-row")));
const readPanelOrder = () =>
  page
    .locator("[data-detail-section]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-detail-section")));

await page.locator('aside [data-nav="settings"]').click();
await page.locator("[data-settings]").waitFor({ timeout: 15000 });
await page.locator('[data-section="behavior"]').click();
await page.locator("[data-detail-order]").waitFor({ timeout: 15000 });

const order0 = await readOrder();
info("默认顺序", order0.join(" > "));
check("六块分区都列得出来", order0.length === 6, order0.join(","));
check("默认以子任务开头", order0[0] === "subtasks", order0[0]);

// 把「备注」一路顶到第一位
const upBtn = () => page.locator('[data-detail-order-row="note"] [data-act="detail-up"]');
for (let i = 0; i < 8; i++) {
  if (await upBtn().isDisabled()) break;
  await upBtn().click();
  await page.waitForTimeout(200);
}
const order1 = await readOrder();
info("调整后顺序", order1.join(" > "));
check("备注被顶到了第一位", order1[0] === "note", order1.join(","));
check("其余分区的相对顺序没被打乱",
  order1.slice(1).join(",") === "subtasks,schedule,repeat,list,links",
  order1.join(","));

await page.locator('button[data-act="close-settings"]').click();
await page.waitForTimeout(500);
await rows().first().locator("div.truncate").first().click();
await page.waitForTimeout(400);
const panel1 = await readPanelOrder();
info("面板实际顺序", panel1.join(" > "));
check("详情里的分区顺序立刻跟着变", panel1[0] === "note", panel1.join(","));
await page.screenshot({ path: `${SHOT_DIR}/15-detail-order.png` });

// 顺序是偏好，必须跨刷新 —— 否则每次打开应用都要重排一遍
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(700);
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(500);
await rows().first().locator("div.truncate").first().click();
await page.waitForTimeout(400);
const panel2 = await readPanelOrder();
check("刷新后顺序仍然保留", panel2[0] === "note", panel2.join(","));

// 复原：不还原的话，下一个进来的套件会看到备注排在第一位
await page.locator('aside [data-nav="settings"]').click();
await page.locator("[data-settings]").waitFor({ timeout: 15000 });
await page.locator('[data-section="behavior"]').click();
await page.locator('[data-act="detail-order-reset"]').click();
await page.waitForTimeout(400);
check("「恢复默认」把顺序复原", (await readOrder())[0] === "subtasks", (await readOrder()).join(","));
await page.locator('button[data-act="close-settings"]').click();
await page.waitForTimeout(400);

console.log("\n7. 关闭与切换视图");
// 「关闭」现在的语义是"清掉选中"，不是"把面板藏起来"：
// 面板常驻，关掉的只是内容（换成空态），宽度仍然是 360。
await detail().locator('button[title="关闭详情"]').click();
await page.waitForTimeout(300);
check("关闭后内容切成空态", (await detailMode()) === "empty", `mode=${await detailMode()}`);
check("关闭后面板仍占位（宽度保持 360）", (await detailWidth()) === 360);
check("空态给了明确文案，不是一块白板",
  ((await detail().textContent()) || "").includes("还没有选中"));

await openRow(0);
await page.waitForTimeout(200);
check("重新打开正常", await detailVisible() && (await detailMode()) !== "empty");

await page.locator('aside [data-nav="important"]').click();
await page.waitForTimeout(500);
check("切视图后详情仍展开", await detailVisible());
// 「重要」视图里可能一条都没有，此时空态才是正确结果 —— 所以分情况断言
if ((await allRows().count()) > 0) {
  check("切视图后自动选中新视图的第一条", await firstRowSelected());
} else {
  check("切视图后（新视图无内容）显示空态", (await detailMode()) === "empty",
    `mode=${await detailMode()}`);
}

console.log("\n8. 在详情里删除任务");
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(500);
const beforeDelete = await rows().count();
// 这条用例只测待办的删除，所以取第一条**待办**（混排列表的第一行可能是工单，
// 工单详情里没有"删除此任务"）
const victim = rows().first();
const victimId = (await victim.getAttribute("data-task-id")) ?? "";
await victim.locator("div.truncate").first().click();
await page.waitForTimeout(300);
check("删除前详情已打开", await detailVisible() && (await detailMode()) === "task",
  `mode=${await detailMode()}`);
// 记下被删这条的标题，处理完之后要确认它没有残留在面板里
const victimTitle = ((await detail().locator("textarea").first().inputValue()) || "").trim();
await detail().locator("button").filter({ hasText: "删除此任务" }).click();
await page.waitForTimeout(600);
check("列表少了一行", (await rows().count()) === beforeDelete - 1,
  `${beforeDelete} → ${await rows().count()}`);
check("已删除的任务行不复存在",
  (await page.locator(`[data-task-id="${victimId}"]`).count()) === 0, victimId);

// 删除后不是"收起来"，而是自动补选下一条（列表空了才落到空态）。
// 关键是不能再显示已经删掉的那条 —— 面板常驻会让这种残留特别显眼。
if ((await allRows().count()) > 0) {
  check("删除后自动补选了一条（不是空态）", (await detailMode()) !== "empty",
    `mode=${await detailMode()}`);
  if ((await detailMode()) === "task") {
    const shown = ((await detail().locator("textarea").first().inputValue()) || "").trim();
    check("删除后不再显示已删除的任务", shown !== victimTitle, `详情=${shown}`);
  }
} else {
  check("列表空了之后显示空态", (await detailMode()) === "empty", `mode=${await detailMode()}`);
}
check("删除后面板仍占位（宽度保持 360）", (await detailWidth()) === 360);

console.log("\n9. 工具视图下不显示详情");
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(400);
if ((await allRows().count()) > 0) await openRow(0);
await page.locator('aside [data-nav^="tool:"]').first().click();
await page.waitForTimeout(600);
check("打开工具后详情面板让位", !(await detailVisible()));

console.log("\n10. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

if (!argv.includes("--keep")) await browser.close();

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
