/**
 * 「特殊单号」原生视图 e2e。
 *
 * 这个功能原来是个 iframe 占位工具，现在搬进了原生界面。为什么值得单独一套测试：
 * 它的每一条规则都有一条**容易悄悄坏掉**的边界 ——
 *
 *   1. 侧边栏有「特殊单号」入口、带未完结数量角标，标题真的是「特殊单号」
 *   2. 视图里只有特殊单号：待办取数为 0，普通工单也不进来（取数层挡掉，不是 CSS 藏）
 *   3. 它是**正规的记录界面**：搜索框（命中含相关信息字段）、状态/流程/时效分类、
 *      排序、统计条，而不是待办那套轻松样式
 *   4. 登记入口在头部；建单弹窗：快递单号必填、时效必填（先拦后建），
 *      相关信息能一次绑完，行上也能整组复制
 *   5. 行上的时效胶囊是真的在算（逾期红 / 临期黄），不是写死的文案
 *   6. 详情里改时效、绑/删/复制相关信息（复制要真的进了剪贴板）
 *   7. 推进过程态后时效按时长重设（这是"时效挂在过程态上"的落点）
 *   8. 「工单」视图里仍然能看到它（专属入口是过滤器，不是围墙）
 *
 * 用法：
 *   node tests/special-orders.mjs           # 复用当前演示库
 *   node tests/special-orders.mjs --fresh   # 先清掉演示库（看种子数据的样子）
 *
 * 前置：dev server 已在 localhost:1420
 *   node node_modules/vite/bin/vite.js --port 1420
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:1420/";
const FRESH = process.argv.includes("--fresh");
const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });

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
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1240, height: 860 } });
// 复制按钮要真读剪贴板来验证，所以得先拿到权限
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/${n}.png` });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.locator("aside").first().waitFor({ timeout: 20000 });

if (FRESH) {
  await page.evaluate(() => localStorage.removeItem("todo-workbench:demo-db"));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("aside").first().waitFor({ timeout: 20000 });
  console.log("已重置演示库\n");
}
await page.waitForTimeout(900);

/* ---- 1. 入口 ---- */

console.log("\n1. 侧边栏入口");
const nav = page.locator('aside [data-nav="special"]');
check("侧边栏有「特殊单号」入口", (await nav.count()) === 1);
const navText = (await nav.count()) ? (await nav.innerText()).trim() : "";
check("入口带未完结数量角标", /\d/.test(navText), `实际文字 ${JSON.stringify(navText)}`);
check(
  "它是原生视图，不是工具（工具区里没有它）",
  (await page.locator('aside [data-nav="tool:special-orders"]').count()) === 0,
);

/* ---- 2. 进视图 ---- */

console.log("\n2. 视图内容");
await nav.click();
await page.waitForTimeout(1000);

const h1 = (await page.locator("h1").first().innerText()).trim();
check("标题是「特殊单号」", h1 === "特殊单号", `实际「${h1}」`);

const orderRows = await page.locator("[data-order-id]").count();
const taskRows = await page.locator("[data-task-id]").count();
check("视图里有工单行", orderRows > 0, `${orderRows} 行`);
// 关键：待办是取数层挡掉的。若哪天 fetchTasks 落进 switch 的 default，
// 这里会立刻变成"没有条件"，整张待办表都会倒进这个视图
check("视图里没有待办行", taskRows === 0, `混进 ${taskRows} 行待办`);

const mode = await page.locator("aside[data-detail-mode]").getAttribute("data-detail-mode");
check("右侧详情处于工单模式", mode === "order", `实际「${mode}」`);

// 视图里每一行都该挂着时效胶囊（这类单子的核心信息）
const dueCaps = await page.locator("[data-order-due]").count();
const plainRows = orderRows - dueCaps;
check("每一行都带时效标记", dueCaps > 0 && plainRows === 0, `${dueCaps} 个胶囊 / ${orderRows} 行`);

/* ---- 3. 正规记录界面：工具栏（搜索 / 分类 / 统计）与登记入口 ---- */

console.log("\n3. 记录界面工具栏");
// 这是**记录管理**界面，不是待办那种随手输入栏：不该再有「待办/工单」创建切换
check("不出现「待办」创建入口", (await page.locator('[data-compose-tab="待办"]').count()) === 0);
check("不出现「普通工单」创建入口", (await page.locator('[data-compose-tab="工单"]').count()) === 0);
check("没有待办式的底部输入栏", (await page.locator("[data-compose-input]").count()) === 0);
// 搜索是"在这批记录里翻账"，命中范围含相关信息字段
check("有搜索框", (await page.locator("[data-sp-search]").count()) === 1);
const spPh = await page.locator("[data-sp-search]").getAttribute("placeholder");
check("搜索框说清了能搜什么", /快递单号/.test(spPh ?? "") && /相关信息/.test(spPh ?? ""),
  `实际「${spPh}」`);
// 分类：状态 / 流程 / 时效各一份，外加排序
check("有状态分类（全部 / 处理中 / 已完结）",
  (await page.locator("[data-sp-status]").count()) === 3);
check("有流程分类下拉", (await page.locator("[data-sp-flow]").count()) === 1);
check("有时效分类下拉", (await page.locator("[data-sp-due]").count()) === 1);
check("有排序下拉", (await page.locator("[data-sp-sort]").count()) === 1);
const statsLine = (await page.locator("[data-sp-stats]").innerText()).replace(/\s+/g, " ");
check("有记录统计条", /共 \d+ 条记录/.test(statsLine), statsLine);
check("统计条里有处理中 / 已超时 / 临期 / 已完结四档",
  /处理中 \d+/.test(statsLine) && /已超时 \d+/.test(statsLine) &&
  /临期 \d+/.test(statsLine) && /已完结 \d+/.test(statsLine), statsLine);
const regLabel = (await page.locator("[data-sp-register]").innerText()).trim();
check("登记入口叫「登记单号」", regLabel === "登记单号", `实际「${regLabel}」`);
check("头部有「编辑流程」", (await page.locator("[data-sp-edit-flows]").count()) === 1);

/* ---- 4. 建单弹窗：快递单号与时效都是硬要求 ---- */

console.log("\n4. 登记弹窗");
const TRACK = `SF${Date.now().toString().slice(-10)}`;
await page.locator("[data-sp-register]").click();
await page.waitForTimeout(600);

const form = page.locator("[data-order-create]");
check("登记按钮打开的是登记表单", (await form.count()) === 1);
check("标题栏是「登记特殊单号」", (await form.innerText()).includes("登记特殊单号"));
check("类型默认选中「特殊单号」", (await page.locator('[data-oc-kind="特殊单号"]').count()) === 1);
check("光标直接落在快递单号上（这类单子从号起）",
  await page.locator("[data-oc-no]").evaluate((el) => el === document.activeElement));
check("没有重复问第二遍单号", (await page.locator("[data-oc-no]").count()) === 1);
check(
  "标题不强制（这类单子靠号认）",
  (await page.locator("[data-oc-title]").getAttribute("placeholder"))?.includes("快递单号当标题"),
);
check("有时效快捷按钮", (await page.locator("[data-oc-due-preset]").count()) >= 4);
check("有时效输入框", (await page.locator("[data-oc-due-input]").count()) === 1);
check("有相关信息区块", (await page.locator("[data-oc-fields]").count()) === 1);
check("相关信息预置了两行（这类单子几乎总要绑点什么）",
  (await page.locator("[data-oc-field-label]").count()) === 2);

// 先把它清空，验证「没起点不让建」
await page.locator("[data-oc-no]").fill("");
await page.locator("[data-oc-submit]").click();
await page.waitForTimeout(400);
let err = (await page.locator("[data-oc-error]").innerText().catch(() => "")) || "";
check("空快递单号被拦住且说清了原因", err.includes("快递单号"), err.trim());
check("被拦住时没有落库", (await page.locator("[data-order-create]").count()) === 1);

// 再验证「没时效不让建」—— 时效是这类单子的意义所在
await page.locator("[data-oc-no]").fill(TRACK);
const clearBtn = page.locator("[data-oc-due-input]").locator("xpath=../button");
if ((await clearBtn.count()) > 0) await clearBtn.first().click();
else await page.locator("[data-oc-due-input]").fill("");
await page.waitForTimeout(300);
await page.locator("[data-oc-submit]").click();
await page.waitForTimeout(400);
err = (await page.locator("[data-oc-error]").innerText().catch(() => "")) || "";
check("空时效被拦住", err.includes("时效"), err.trim());

/* ---- 5. 填完建出来 ---- */

console.log("\n5. 登记入库");
await page.locator('[data-oc-due-preset="2 小时"]').click();
await page.waitForTimeout(200);
await page.locator('[data-oc-field-label="0"]').fill("补发单号");
await page.locator('[data-oc-field-value="0"]').fill("YT0000111122");
await page.locator('[data-oc-field-label="1"]').fill("客户");
await page.locator('[data-oc-field-value="1"]').fill("张三");
await shot("30-special-create");
await page.locator("[data-oc-submit]").click();
// 等弹窗**真的消失**，而不是固定 sleep 一段时间：建单要走一次全量 refresh，
// 慢的时候会超过一秒，用固定等待就会在弹窗还开着的时候去点后面的东西，
// 被遮罩拦住 → 超时 → 看起来像"没建出来"
await form.waitFor({ state: "detached", timeout: 25000 }).catch(() => {});
const stillOpen = (await form.count()) > 0;
const submitErr = stillOpen
  ? await page.locator("[data-oc-error]").innerText().catch(() => "(读不到错误条)")
  : "";
if (stillOpen) info("弹窗没关掉，错误是", submitErr);

// 列表刷新是异步的，轮询等它出现，别按"大概 1 秒够了"去赌
const newRow = page.locator("[data-order-id]").filter({ hasText: TRACK }).first();
for (let i = 0; i < 40 && (await newRow.count()) === 0; i++) await page.waitForTimeout(250);
check(
  "列表里出现了这张单",
  (await newRow.count()) === 1,
  stillOpen ? `弹窗未关：${submitErr.replace(/\s+/g, " ")}` : "弹窗已关但列表里没有它",
);

if ((await newRow.count()) === 1) {
  check("行上带时效胶囊", (await newRow.locator("[data-order-due]").count()) === 1);
  const st = await newRow.locator("[data-order-due]").getAttribute("data-order-due");
  // 用「2 小时」而不是「30 分钟」：临期窗口就是 30 分钟，选 30 分钟建出来
  // 立刻就是 soon，那不是"刚建好"该有的样子
  check("刚建的单是「还早」", st === "ok", `实际 ${st}`);
  check("胶囊上有确切的到期时刻", !!(await newRow.locator("[data-order-due]").getAttribute("data-order-due-at")));

  /* ---- 5b. 记录检索与分类 ---- */

  console.log("\n5b. 检索与分类");
  const rowCount = () => page.locator("[data-order-id]").count();
  // 筛选是本地状态，几乎即时生效；但整表重渲染偶有延迟，
  // 固定 sleep 一旦撞上后台的提醒扫描就会读到旧 DOM —— 一律轮询等条件成立
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await page.waitForTimeout(150);
    }
    return false;
  };
  // 按**相关信息字段的值**搜：用户记得的往往是客户名或补发单号，不是标题
  await page.locator("[data-sp-search]").fill("张三");
  await page.waitForTimeout(400);
  check("按相关信息的值能搜到记录",
    (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 1);
  check("搜索时无关记录被滤掉", (await rowCount()) === 1, `剩 ${await rowCount()} 行`);

  await page.locator("[data-sp-search]").fill("肯定搜不到的关键字XYZ");
  await page.waitForTimeout(400);
  check("搜不到时表格清空", (await rowCount()) === 0, `剩 ${await rowCount()} 行`);
  check("搜不到时给出空态提示", (await page.locator("text=没有匹配的记录").count()) === 1);

  await page.locator("[data-sp-search]").fill("YT0000111122");
  await page.waitForTimeout(400);
  check("按补发单号也能反查到它",
    (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 1);

  // 清除筛选：要从搜索框里那两个字的状态回到全量
  await page.locator("[data-sp-clear]").first().click();
  await page.waitForTimeout(400);
  check("清除筛选后全部记录回来", (await rowCount()) >= 2, `剩 ${await rowCount()} 行`);
  check("清除后搜索框也空了", (await page.locator("[data-sp-search]").inputValue()) === "");

  // 状态分类：这张单刚建，是进行中
  await page.locator('[data-sp-status="closed"]').click();
  check(
    "「已完结」分类里没有它",
    await until(async () =>
      (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 0),
    `还有 ${await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()} 行`,
  );
  await page.locator('[data-sp-status="open"]').click();
  check(
    "「处理中」分类里看得到它",
    await until(async () =>
      (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 1),
  );

  // 时效分类：它此刻是「正常」，正常档里有、超时档里没有
  await page.locator("[data-sp-due]").selectOption("ok");
  check(
    "时效分类「正常」里有它",
    await until(async () =>
      (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 1),
  );
  await page.locator("[data-sp-due]").selectOption("overdue");
  check(
    "时效分类「已超时」里没有它",
    await until(async () =>
      (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 0),
  );
  await page.locator("[data-sp-due]").selectOption("all");
  await page.waitForTimeout(300);

  // 行内整组复制：不用打开详情也能拿走这单绑的信息
  await page.locator("[data-sp-field-copy]").first().click();
  await page.waitForTimeout(400);
  const rowClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  info("行内复制", rowClip.replace(/\n/g, " | "));
  check("行上能整组复制相关信息", rowClip.includes("补发单号：") || rowClip.includes("客户："), rowClip);

  /* ---- 6. 详情：时效与相关信息 ---- */

  console.log("\n6. 详情面板");
  await newRow.click();
  await page.waitForTimeout(800);

  const detailNo = await page.locator("[data-order-no-input]").inputValue();
  check("详情里的单号就是快递单号", detailNo === TRACK, `实际「${detailNo}」`);
  check("详情里有处理时效区块", (await page.locator("[data-order-due-block]").count()) === 1);
  const dState = await page.locator("[data-order-due-state]").getAttribute("data-order-due-state");
  check("时效状态与列表同源", dState === "ok", `实际 ${dState}`);
  const headline = (await page.locator("[data-order-due-state]").innerText()).trim();
  check("时效说的是「还剩多久」", headline.startsWith("还剩"), headline);

  check("详情里有相关信息区块", (await page.locator("[data-wo-fields]").count()) === 1);
  const fieldRows = await page.locator("[data-wo-field]").count();
  check("绑上的两条信息都在", fieldRows === 2, `实际 ${fieldRows} 行`);

  // 复制单个值：要真的进剪贴板，不能只是弹个"已复制"
  await page.locator("[data-wo-field-copy]").first().click();
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  check("复制单个值进了剪贴板", clip === "YT0000111122", `实际「${clip}」`);

  // 复制全部：按「字段名：值」逐行
  await page.locator("[data-wo-copy-all]").click();
  await page.waitForTimeout(400);
  const clipAll = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  info("复制全部", clipAll.replace(/\n/g, " | "));
  check("复制全部带上字段名", clipAll.includes("补发单号：YT0000111122") && clipAll.includes("客户：张三"), clipAll);

  // 空行不该落库：没填东西时「加一行」是禁用的
  check("没填内容时「加一行」不可点", await page.locator("[data-wo-field-new-add]").isDisabled());
  await page.locator("[data-wo-field-new-label]").fill("电话");
  await page.locator("[data-wo-field-new-value]").fill("13800000000");
  await page.waitForTimeout(200);
  check("填了内容后「加一行」可点", !(await page.locator("[data-wo-field-new-add]").isDisabled()));
  await page.locator("[data-wo-field-new-value]").press("Enter");
  await page.waitForTimeout(800);
  check("回车绑上新的一行", (await page.locator("[data-wo-field]").count()) === 3,
    `实际 ${await page.locator("[data-wo-field]").count()} 行`);

  // 删一行
  await page.locator("[data-wo-field-del]").last().click();
  await page.waitForTimeout(800);
  check("删掉一行后行数回落", (await page.locator("[data-wo-field]").count()) === 2);

  // 改时效：选「4 小时」后状态必须重算
  await page.locator('[data-order-due-preset="4 小时"]').click();
  await page.waitForTimeout(800);
  const newHead = (await page.locator("[data-order-due-state]").innerText()).trim();
  info("改期后", newHead);
  check("改成 4 小时后又变回「还早」", newHead.startsWith("还剩"), newHead);

  /* ---- 7. 推进过程态：时效按目标步重设 ---- */

  console.log("\n7. 推进后时效重设");
  // 先把时效改成 30 分钟 —— 目标步「处理中」的默认时效是 240 分钟，
  // 两者不同才能看出"重设"而不是"继续倒计时"（改期那一步把它设成了 4 小时，
  // 正好和目标步的默认值一样，那就什么都看不出来）
  await page.locator('[data-order-due-preset="30 分钟"]').click();
  await page.waitForTimeout(800);
  const dueBefore = await page.locator("[data-order-due-state]").innerText();
  await newRow.locator("[data-order-advance]").first().click();
  await page.waitForTimeout(1200);
  const dueAfter = await page.locator("[data-order-due-state]").innerText();
  info("推进前 / 后", `${dueBefore.trim()} → ${dueAfter.trim()}`);
  check("推进后时效按时长重设，而不是继续减", dueAfter !== dueBefore, `${dueBefore.trim()} vs ${dueAfter.trim()}`);
  // 目标步的默认时效是 240 分钟，界面上就该显示「还剩 4 小时」
  check("重设用的是目标步的默认时效（240 分钟）", dueAfter.includes("4 小时"), dueAfter.trim());
  const stageName = (await newRow.locator("[data-order-stage]").innerText()).trim();
  check("过程态真的推进了", stageName !== "待处理", stageName);
  await shot("31-special-detail");
}

/* ---- 8. 流程编辑器里能配每步的默认时效 ---- */

console.log("\n8. 过程态的默认时效");
// 从**详情面板**的「编辑流程」进去：它会聚焦到这张单所属的那套流程，
// 也就是种子那套「特殊单号处理」
await page.locator("aside[data-task-detail] [data-edit-flows]").first().click();
await page.locator("[data-flow-editor]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);
check("打开的是流程编辑器", (await page.locator("[data-flow-editor]").count()) === 1);
const flowName = (await page.locator("[data-flow-name]").innerText().catch(() => "")).trim();
check("聚焦的是这张单所属的流程", flowName.includes("特殊单号"), flowName);
const minInputs = await page.locator("[data-stage-minutes]").count();
check("每一步都有一个默认时效输入框", minInputs > 0, `${minInputs} 个`);
if (minInputs > 0) {
  const mins = await page
    .locator("[data-stage-minutes]")
    .evaluateAll((els) => els.map((e) => e.value || "0"));
  info("各步默认时效（分钟）", mins.join(", "));
  // 种子那套「特殊单号处理」是 30 / 240 / 1440 / 0（终态不给时长）
  check("默认时效读的是库里的值（30/240/1440/0）",
    mins.length === 4 && mins[0] === "30" && mins[1] === "240" && mins[2] === "1440" && mins[3] === "0",
    mins.join(", "));
  // 改一个字要真的落库：把第一步的默认时效改成 45，再改回 30，
  // 轮询等回读值（写库要走一次全量 refresh，固定 sleep 偶尔会撞上
  // 30 秒一次的提醒扫描，导致编辑器中途被重挂）
  const firstMin = page.locator("[data-stage-minutes]").first();
  await firstMin.fill("45");
  await firstMin.press("Enter");
  let after = "";
  for (let i = 0; i < 30; i++) {
    after = await firstMin.inputValue().catch(() => "");
    if (after === "45") break;
    await page.waitForTimeout(300);
  }
  check("默认时效可以被改掉", after === "45", `实际「${after}」`);
  await firstMin.fill("30");
  await firstMin.press("Enter");
}
await page.locator("[data-flow-editor] button[title='关闭']").first().click();
await page.locator("[data-flow-editor]").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
await page.waitForTimeout(300);

/* ---- 8b. 头部的「编辑流程」不是假按钮 ---- */

console.log("\n8b. 头部的「编辑流程」");
await page.locator("[data-sp-edit-flows]").first().click();
await page.locator("[data-flow-editor]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
check("创建栏的「编辑流程」能打开编辑器", (await page.locator("[data-flow-editor]").count()) === 1);
await page.locator("[data-flow-editor] button[title='关闭']").first().click();
await page.locator("[data-flow-editor]").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
check("关闭后编辑器真的收起来了", (await page.locator("[data-flow-editor]").count()) === 0);

/* ---- 9. 它同时还是工单 ---- */

console.log("\n9. 与「工单」视图的关系");
await page.locator('aside [data-nav="orders"]').first().click();
await page.waitForTimeout(900);
const inOrders = await page
  .locator("[data-order-id]")
  .filter({ hasText: TRACK })
  .count();
check("「工单」视图里也能看到这张特殊单号", inOrders === 1);
// 专属入口是"只看等不起的那些"的过滤器，不是一道围墙
const ordersText = await page.locator("[data-bg-mode]").first().innerText();
check("「工单」视图下仍有进行中分组", ordersText.includes("进行中"));

console.log("\n10. 出现在「我的一天」并自己进底部紧急区");
await page.locator('aside [data-nav="myday"]').first().click();
await page.waitForTimeout(900);
const mydayHit = await page
  .locator("[data-order-id]")
  .filter({ hasText: TRACK })
  .count();
check("「我的一天」里看得到这张单", mydayHit === 1, `${mydayHit} 行`);
check("它带着特殊单号标记",
  (await page.locator('[data-order-kind="special"]').filter({ hasText: TRACK }).count()) === 1);
// 待办的领地只放行特殊单号这一类工单 —— 普通工单仍然被挡在外面
check("「我的一天」里没有普通工单",
  (await page.locator('[data-order-kind="normal"]').count()) === 0);
const mydayText = await page.locator("[data-bg-mode]").first().innerText();
check("「我的一天」里有「特殊单号」分组", mydayText.includes("特殊单号"));
// 角标必须和列表对得上：待办行数 + 特殊单行数，点进去不多不少
const mydayTaskRows = await page.locator("[data-task-id]").count();
const specialRows = await page.locator('[data-order-kind="special"]').count();
const navText2 = (await page.locator('aside [data-nav="myday"]').first().innerText()).trim();
const badge = Number((navText2.match(/\d+/) || ["-1"])[0]);
check("「我的一天」角标 = 待办 + 特殊单号",
  badge === mydayTaskRows + specialRows, `角标 ${badge} vs ${mydayTaskRows}+${specialRows}`);
// 底部紧急区：还在时效窗口内的单子自己出现，不需要谁手动排
const urgentRows = page.locator("[data-urgent-item]").filter({ hasText: TRACK });
const urgentHit = await urgentRows.count();
check("时效临近的单子自己进了底部紧急区", urgentHit === 1, `${urgentHit} 行`);
const urgentState = urgentHit
  ? await urgentRows.first().getAttribute("data-urgent-state")
  : null;
check("它标着临期/逾期状态", urgentState === "soon" || urgentState === "overdue", String(urgentState));
const urgentText = urgentHit ? (await urgentRows.first().innerText()).replace(/\s+/g, " ") : "";
check("行上写着还剩多久", /还剩|已超/.test(urgentText), urgentText);

/* ---- 11. 提醒卡片 ---- */

console.log("\n11. 超时提醒卡片");
// 直接把这条单的时效改成一个已经过去的时刻，看提醒卡片会不会浮出来
await page.locator('aside [data-nav="special"]').first().click();
await page.waitForTimeout(900);
const urgentRow = page.locator("[data-order-id]").filter({ hasText: TRACK }).first();
if ((await urgentRow.count()) === 1) {
  await urgentRow.click();
  await page.waitForTimeout(700);

  // 先把时效落在**临期窗口**里（还剩 10 分钟）：临期就必须是红的 ——
  // 不是琥珀色的"预警"，用户的预期是"这一单开始要命了"
  const soon = new Date(Date.now() + 10 * 60_000);
  const p = (n) => String(n).padStart(2, "0");
  const local = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  await page.locator("[data-order-due-input]").fill(local(soon));
  await page.locator("[data-order-due-input]").blur();
  await page.waitForTimeout(1200);
  const soonSt = await page.locator("[data-order-due-state]").getAttribute("data-order-due-state");
  check("落在临期窗口里", soonSt === "soon", `实际 ${soonSt}`);
  if (soonSt === "soon") {
    const soonColor = await page
      .locator('[data-order-id] [data-order-due="soon"]')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    // light 主题的 --color-danger = #c0392b
    check("临期的时效胶囊是红色", soonColor === "rgb(192, 57, 43)", soonColor);
  }

  // 再改成已经过去的时刻，看逾期档与提醒卡片
  const past = new Date(Date.now() - 5 * 60_000);
  await page.locator("[data-order-due-input]").fill(local(past));
  await page.locator("[data-order-due-input]").blur();
  await page.waitForTimeout(1200);

  const dState2 = await page.locator("[data-order-due-state]").getAttribute("data-order-due-state");
  check("改成过去时刻后状态变逾期", dState2 === "overdue", `实际 ${dState2}`);
  const overdueColor = await page
    .locator('[data-order-id] [data-order-due="overdue"]')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  check("逾期的时效胶囊也是红色（更重）", overdueColor === "rgb(192, 57, 43)", overdueColor);

  // 建单时给的 30 分钟正好落在临期窗口里，所以可能已经有一张「即将超时」的卡片。
  // 先把它们收掉，再看逾期那一档会不会单独浮出来 —— 两档是分开去重的。
  for (let i = 0; i < 20 && (await page.locator("[data-order-due-card]").count()) > 0; i++) {
    await page.locator('[data-act="order-due-dismiss"]').first().click();
    await page.waitForTimeout(300);
  }

  // 提醒扫描是定时跑的，等一轮
  let overdueCard = 0;
  for (let i = 0; i < 45; i++) {
    overdueCard = await page.locator('[data-order-due-level="overdue"]').count();
    if (overdueCard > 0) break;
    await page.waitForTimeout(1000);
  }
  check("逾期后浮出提醒卡片", overdueCard > 0, `${overdueCard} 张`);
  if (overdueCard > 0) {
    const cardText = await page.locator('[data-order-due-level="overdue"]').first().innerText();
    check("卡片标的是「已超时」", cardText.includes("已超时"), cardText.replace(/\s+/g, " "));
    check("卡片上就是这张单", cardText.includes(TRACK), cardText.replace(/\s+/g, " "));
    await shot("32-special-overdue");
    await page.locator('[data-order-due-level="overdue"] [data-act="order-due-dismiss"]').first().click();
    await page.waitForTimeout(500);
    check("「知道了」能把卡片收起来",
      (await page.locator('[data-order-due-level="overdue"]').count()) === 0);
  }
}

await browser.close();

console.log("");
if (errors.length) {
  console.log(`控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log(`  ! ${e}`);
}
console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length || errors.length ? 1 : 0);
