/**
 * 工单专属视图 e2e（侧边栏「工单」入口）。
 *
 * 工单平时混在「全部」「我的一天」里，但用户需要一个"只看手上的单子"的地方。
 * 这里验证的是这个入口的**行为**，不只是"界面画出来了"：
 *
 *   1. 侧边栏有「工单」入口、带未完结数量角标，点进去标题真的是「工单」
 *   2. 视图里只有工单、没有待办（取数层把待办挡掉了，而不是 CSS 藏起来）
 *   3. 分「进行中 / 已完成」两组
 *   4. 右侧详情自动进工单模式，且与「默认展开第一条」同源
 *   5. 底部创建栏锁死在造工单 —— 在这里造一条待办是不会出现在当前列表里的，
 *      留着那个"待办"按钮就是假入口
 *   6. 推进到终态后，工单真的从「进行中」挪到「已完成」组
 *   7. 「全部」里工单继续混排（用户明确要求保留，不因为有了专属入口就改掉）
 *
 * 用法：
 *   node tests/orders-view.mjs           # 复用当前演示库
 *   node tests/orders-view.mjs --fresh   # 先清掉演示库再跑（看的是种子数据的样子）
 *
 * 前置：dev server 已在 localhost:1420
 *   node node_modules/vite/bin/vite.js --port 1420
 */

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

// 用本机 Edge：与 Tauri 的 WebView2 同源，验证结果更贴近桌面端
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:1420/";

const FRESH = process.argv.includes("--fresh");

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.locator("aside").first().waitFor({ timeout: 15000 });

if (FRESH) {
  await page.evaluate(() => localStorage.removeItem("todo-workbench:demo-db"));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("aside").first().waitFor({ timeout: 15000 });
  console.log("已重置演示库\n");
}
await page.waitForTimeout(900);

/* ---- 1. 侧边栏入口 ---- */

const nav = page.locator('aside [data-nav="orders"]');
check("侧边栏有「工单」入口", (await nav.count()) === 1);
const navText = (await nav.count()) ? (await nav.innerText()).trim() : "";
check("入口带未完结数量角标", /\d/.test(navText), `实际文字 ${JSON.stringify(navText)}`);

/* ---- 2. 进视图 ---- */

await nav.click();
await page.waitForTimeout(900);

const h1 = (await page.locator("h1").first().innerText()).trim();
check("标题是「工单」", h1 === "工单", `实际「${h1}」`);

// 只看工单。注意要读的是**行数**而不是"待办行不可见" ——
// 取数层挡掉的话行数就是 0；如果只是 CSS 藏起来，行数还会骗人
const orderRows = await page.locator("[data-order-id]").count();
const taskRows = await page.locator("[data-task-id]").count();
check("视图里有工单", orderRows > 0, `工单行 ${orderRows}`);
check("视图里没有待办行", taskRows === 0, `混进 ${taskRows} 行待办`);

const listText = await page.locator("[data-bg-mode]").first().innerText();
check("有「进行中」分组", listText.includes("进行中"));

// 详情跟着进工单模式 —— 选中规则与列表排版共用 lib/rows.ts，
// 若这里 mode 不是 order，说明"默认展开第一条"在工单视图下失效了
const mode = await page.locator("aside[data-detail-mode]").getAttribute("data-detail-mode");
check("右侧详情处于工单模式", mode === "order", `实际「${mode}」`);

/* ---- 3. 创建栏锁死在造工单 ---- */

check("不出现「待办」创建入口", (await page.locator('[data-compose-tab="待办"]').count()) === 0);
const ph = await page.locator("[data-compose-input]").getAttribute("placeholder");
check("输入框提示在造工单", /工单标题/.test(ph ?? ""), `实际「${ph}」`);

/* ---- 4. 在这里建一张单，然后推进到终态 ---- */

await page.locator("[data-compose-input]").fill("验收流程的测试单");
await page.locator("[data-compose-submit]").click();
await page.waitForTimeout(600);

// 工单改为全参数创建：底部回车只打开表单，不该直接落库
const form = page.locator("[data-order-create]");
check("回车打开的是新建工单表单，没有直接建单", (await form.count()) === 1);
check(
  "表单里带进了刚打的标题",
  ((await page.locator("[data-oc-title]").inputValue()) || "").includes("验收流程的测试单"),
);
check("表单里有流程选择", (await page.locator("[data-oc-flow]").count()) === 1);
check("表单里有过程态选择", (await page.locator("[data-oc-stage]").count()) === 1);
check("表单里有交付日期", (await page.locator("[data-oc-due]").count()) === 1);
check("表单里有备注", (await page.locator("[data-oc-note]").count()) === 1);
check(
  "提交前列表里没有这张单",
  (await page.locator("[data-order-id]").filter({ hasText: "验收流程的测试单" }).count()) === 0,
);

await page.locator("[data-oc-submit]").click();
await page.waitForTimeout(900);

const newRow = page.locator("[data-order-id]").filter({ hasText: "验收流程的测试单" }).first();
check("工单视图里能建工单", (await newRow.count()) === 1);

if ((await newRow.count()) === 1) {
  const rowsBefore = await page.locator("[data-order-id]").count();
  // 一路推进：行上的「推进到 X」按钮在最后一个（终态）阶段会消失，
  // 按钮没了就是走完了。给 8 次余量是防止以后流程加阶段
  let advanced = 0;
  for (let i = 0; i < 8; i++) {
    const adv = newRow.locator("[data-order-advance]");
    if ((await adv.count()) === 0) break;
    await adv.first().click();
    advanced++;
    await page.waitForTimeout(700);
  }
  check("工单能推进到终态", advanced > 0, `只推进了 ${advanced} 次`);

  const stage = (await newRow.locator("[data-order-stage]").innerText()).trim();
  check("推进后处于终态「已完成」", stage === "已完成", `实际「${stage}」`);

  // 分组真的换了：「进行中」的段落里不再有它，「已完成」组出现
  const after = await page.locator("[data-bg-mode]").first().innerText();
  check("出现「已完成」分组", after.includes("已完成"));
  const closedIdx = after.indexOf("已完成");
  const openPart = closedIdx >= 0 ? after.slice(0, closedIdx) : after;
  check("已完结的单不再算进「进行中」组", !openPart.includes("验收流程的测试单"));

  const totalAfter = await page.locator("[data-order-id]").count();
  check("已完结的单仍在视图里（进历史组，不是消失）",
    totalAfter === rowsBefore, `推进前 ${rowsBefore} / 推进后 ${totalAfter}`);
}

/* ---- 5. 工单不进「我的一天」 ---- */

await page.locator('aside [data-nav="myday"]').first().click();
await page.waitForTimeout(800);
// 特殊单号（带时效的工单）会进「我的一天」——那是"提醒"的前线；
// 挡在外面的只有**普通**工单
check("「我的一天」里没有普通工单",
  (await page.locator('[data-order-kind="normal"]').count()) === 0);
check("「我的一天」里待办还在", (await page.locator("[data-task-id]").count()) > 0);

// 这里允许造工单，但**建出来不会出现在当前列表** —— 不说清楚用户会以为没建成
await page.locator('[data-compose-tab="工单"]').first().click();
await page.waitForTimeout(400);
const composeHint = (await page.locator("[data-compose-hint]").innerText()) || "";
check("「我的一天」里造工单会提示它不在当前列表", composeHint.includes("不进"), composeHint.trim());
await page.locator('[data-compose-tab="待办"]').first().click();
await page.waitForTimeout(300);

/* ---- 6. 右侧面板可以拖宽，并且记住 ---- */

const panel = page.locator("aside[data-task-detail]");
const widthOf = async () => Number(await panel.getAttribute("data-detail-width"));
const before = await widthOf();
check("面板有默认宽度", before === 360, `实际 ${before}`);

const handle = page.locator("[data-detail-resizer]");
check("存在调宽把手", (await handle.count()) === 1);

const box = await handle.boundingBox();
if (!box) {
  check("把手有可拖的命中区", false, "拿不到 boundingBox");
} else {
  // 往左拖 120px = 面板变宽 120px
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await widthOf();
  check("拖动后面板变宽了", after > before + 80, `${before} → ${after}`);

  // 上限：再狠拖一次也不该无限变宽（会把中间列表压没）
  const box2 = await handle.boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x - 900, box2.y + box2.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const capped = await widthOf();
  check("宽度有上限，不会被拖到占满屏幕", capped <= 720, `实际 ${capped}`);

  // 持久化：刷新后还是这个宽度
  await page.reload();
  await page.waitForTimeout(1600);
  const reloaded = await widthOf();
  check("刷新后宽度被记住", Math.abs(reloaded - capped) <= 2, `${capped} → ${reloaded}`);
}

/* ---- 7. 「全部」继续混排 ---- */

await page.locator('aside [data-nav="all"]').first().click();
await page.waitForTimeout(800);
const allOrders = await page.locator("[data-order-id]").count();
const allTasks = await page.locator("[data-task-id]").count();
check("「全部」里工单仍在混排", allOrders > 0, `${allOrders} 行`);
check("「全部」里待办也还在", allTasks > 0, `${allTasks} 行`);

await browser.close();

console.log("");
if (errors.length) {
  console.log(`控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log(`  ! ${e}`);
}
console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length || errors.length ? 1 : 0);
