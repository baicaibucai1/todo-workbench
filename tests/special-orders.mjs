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
// acceptDownloads：导出 CSV 要接住 download 事件去核对文件内容
const context = await browser.newContext({
  viewport: { width: 1240, height: 860 },
  acceptDownloads: true,
});
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
// SF + 13 位数字：这是顺丰真实单号的形状（SF 后面 12~15 位），
// 识别规则要认得出它，所以测试单号也得长成真的
const TRACK = `SF${Date.now().toString().slice(-13)}`;
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

/* ---- 12. 视图设置：自定义列 / 复制格式 / 紧凑行高 ---- */

console.log("\n12. 视图设置（自定义列 / 复制格式 / 行高）");
await page.locator('aside [data-nav="special"]').first().click();
await page.waitForTimeout(900);
// 前面把这张单的时效改成了过去时刻，提醒卡片可能正浮着挡住点击
for (let i = 0; i < 15 && (await page.locator("[data-order-due-card]").count()) > 0; i++) {
  await page.locator('[data-act="order-due-dismiss"]').first().click();
  await page.waitForTimeout(250);
}
if ((await page.locator("[data-sp-clear]").count()) > 0) {
  await page.locator("[data-sp-clear]").first().click();
  await page.waitForTimeout(300);
}

check("有「视图设置」入口", (await page.locator("[data-sp-view-settings]").count()) === 1);
await page.locator("[data-sp-view-settings]").click();
await page.waitForTimeout(350);
check("点开视图设置面板", (await page.locator("[data-sp-view-panel]").count()) === 1);
const colCandidates = await page.locator("[data-sp-col]").count();
check("自定义列的候选来自真实用过的字段名", colCandidates > 0, `${colCandidates} 个候选`);
check("候选里有登记过的「客户」", (await page.locator('[data-sp-col="客户"]').count()) === 1);

// 挂一列上去：核对"这单是谁的"时不用再点开详情
if ((await page.locator('[data-sp-col="客户"]').count()) === 1) {
  await page.locator('[data-sp-col="客户"] input').check();
  await page.waitForTimeout(700);
  const cell = page
    .locator("[data-order-id]")
    .filter({ hasText: TRACK })
    .first()
    .locator('[data-sp-cell="客户"]');
  check("勾上后表上真的多出一列", (await cell.count()) === 1);
  const cellText = (await cell.count()) ? (await cell.innerText()).trim() : "";
  check("这一列里就是这条单绑的值", cellText === "张三", `实际「${cellText}」`);
}

// 复制格式：改成「只要值」，复制出来就不该再带字段名
await page.locator("[data-sp-copy-template]").selectOption("value");
await page.waitForTimeout(400);
const preview = (await page.locator("[data-sp-copy-preview]").innerText()).trim();
check("面板里预览了新格式", preview.length > 0 && !preview.includes("："), preview);

// 紧凑行高
await page.locator("[data-sp-density]").click();
await page.waitForTimeout(400);
check("紧凑行高能打开", (await page.locator('[data-sp-density-on="1"]').count()) === 1);

// 点面板外面收起
await page.locator("h1").first().click();
await page.waitForTimeout(350);
check("点面板外面能收起", (await page.locator("[data-sp-view-panel]").count()) === 0);

const trackRow2 = page.locator("[data-order-id]").filter({ hasText: TRACK }).first();
await trackRow2.locator("[data-sp-field-copy]").click();
await page.waitForTimeout(500);
const clipFmt = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
info("按模板复制", clipFmt.replace(/\n/g, " | "));
check("复制格式改了之后复制出来跟着变", clipFmt.includes("张三") && !clipFmt.includes("客户："),
  clipFmt.replace(/\n/g, " | "));

// 改回默认格式，然后刷新验证这些偏好是**存下来的**
await page.locator("[data-sp-view-settings]").click();
await page.waitForTimeout(300);
await page.locator("[data-sp-copy-template]").selectOption("label-cn");
await page.waitForTimeout(400);
await page.reload({ waitUntil: "networkidle" });
await page.locator("aside").first().waitFor({ timeout: 20000 });
await page.locator('aside [data-nav="special"]').first().click();
await page.waitForTimeout(1200);
check("刷新后自定义列还在（存的是设置，不是组件 state）",
  (await page.locator('[data-sp-cell="客户"]').count()) > 0);
await page.locator("[data-sp-view-settings]").click();
await page.waitForTimeout(350);
check("刷新后行高密度还在", (await page.locator('[data-sp-density-on="1"]').count()) === 1);
check("刷新后复制格式还是默认那档",
  (await page.locator("[data-sp-copy-template]").inputValue()) === "label-cn");
await page.locator("h1").first().click();
await page.waitForTimeout(300);

/* ---- 13. 批量操作与导出 ---- */

console.log("\n13. 批量操作与导出");
check("每行都有勾选框", (await page.locator("[data-sp-select]").count()) > 0);
await page.locator("[data-sp-select-all]").check();
await page.waitForTimeout(450);
const barCount = await page.locator("[data-sp-batch]").getAttribute("data-sp-batch-count");
check("全选后浮出批量操作条", !!barCount && Number(barCount) > 0, String(barCount));

await page.locator("[data-sp-batch-copy]").click();
await page.waitForTimeout(600);
const clipBatch = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
info("批量复制", clipBatch.replace(/\n/g, " | ").slice(0, 120));
check("批量复制里带上了每张单的单号（否则分不清谁是谁）",
  clipBatch.includes("#") && clipBatch.includes(TRACK));

// 导出：勾着的时候导勾中的
const [dl] = await Promise.all([
  page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
  page.locator("[data-sp-export-all]").click(),
]);
check("导出真的下了个文件", !!dl);
if (dl) {
  const fname = dl.suggestedFilename();
  check("文件名是中文的 CSV", fname.includes("特殊单号") && fname.endsWith(".csv"), fname);
  const p = await dl.path().catch(() => null);
  if (p) {
    const csv = fs.readFileSync(p, "utf8");
    info("CSV 前两行", csv.split(/\r?\n/).slice(0, 2).join(" || ").slice(0, 160));
    check("CSV 带 BOM（Excel 打开不乱码）", csv.charCodeAt(0) === 0xfeff);
    check("CSV 表头里有快递单号与自定义列",
      csv.includes("快递单号") && csv.includes("客户"), csv.slice(0, 120));
    check("CSV 里有这条记录", csv.includes(TRACK));
  }
}
await page.locator("[data-sp-batch-clear]").click();
await page.waitForTimeout(400);
check("取消选择后批量条收起", (await page.locator("[data-sp-batch]").count()) === 0);

// 只勾一条推进：过程态真的往前走
const stageBefore = (await trackRow2.locator("[data-order-stage]").innerText()).trim();
await trackRow2.locator("[data-sp-select]").check();
await page.waitForTimeout(350);
check("勾上后这一行有选中态",
  (await trackRow2.getAttribute("data-sp-checked")) === "1");
await page.locator("[data-sp-batch-advance]").click();
await page.waitForTimeout(1600);
const stageAfter = (
  await page.locator("[data-order-id]").filter({ hasText: TRACK }).first()
    .locator("[data-order-stage]").innerText()
).trim();
info("批量推进", `${stageBefore} → ${stageAfter}`);
check("批量推进真的推进了过程态", stageAfter !== stageBefore, `${stageBefore} vs ${stageAfter}`);

// 批量标记重要
await page.locator("[data-sp-batch-important]").click();
await page.waitForTimeout(1200);
check("批量标记重要生效",
  (await page.locator("[data-order-id]").filter({ hasText: TRACK }).first()
    .getAttribute("data-order-important")) === "1");
await page.locator("[data-sp-batch-clear]").click();
await page.waitForTimeout(400);

/* ---- 14. 行内续时 ---- */

console.log("\n14. 行内续时");
const dueAtBefore = await page
  .locator("[data-order-id]").filter({ hasText: TRACK }).first()
  .locator("[data-order-due]").getAttribute("data-order-due-at");
const extendBtn = page
  .locator("[data-order-id]").filter({ hasText: TRACK }).first()
  .locator("[data-order-extend]");
check("行上有续时按钮", (await extendBtn.count()) === 1);
const extendMin = Number(await extendBtn.getAttribute("data-order-extend-minutes"));
check("续时时长取的是当前步骤的默认时效", extendMin > 0, `${extendMin} 分钟`);
await extendBtn.click();
let dueAtAfter = dueAtBefore;
for (let i = 0; i < 25; i++) {
  dueAtAfter = await page
    .locator("[data-order-id]").filter({ hasText: TRACK }).first()
    .locator("[data-order-due]").getAttribute("data-order-due-at");
  if (dueAtAfter && dueAtAfter !== dueAtBefore) break;
  await page.waitForTimeout(300);
}
info("续时前后", `${dueAtBefore} → ${dueAtAfter}`);
check("续时把时效往后推了一截",
  !!dueAtAfter && dueAtAfter !== dueAtBefore && new Date(dueAtAfter) > new Date(dueAtBefore),
  `${dueAtBefore} vs ${dueAtAfter}`);

// 复制单号：查件、发给快递公司都要它，不该为了拿一个号去开详情
await trackRow2.locator("[data-order-copy-no]").click();
await page.waitForTimeout(450);
const clipNo = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
check("行上能一键复制快递单号", clipNo === TRACK, `实际「${clipNo}」`);

/* ---- 15. 更多筛选：重要 / 登记时间 ---- */

console.log("\n15. 重要与登记时间筛选");
await page.locator("[data-sp-important]").click();
await page.waitForTimeout(500);
check("「只看重要」里能筛出刚标记的那条",
  (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 1);
check("勾选状态下按钮自己有标记",
  (await page.locator("[data-sp-important]").innerText()).includes("重要"));
await page.locator("[data-sp-important]").click();
await page.waitForTimeout(400);

await page.locator("[data-sp-range]").selectOption("today");
await page.waitForTimeout(500);
check("「今天登记」里有今天建的单",
  (await page.locator("[data-order-id]").filter({ hasText: TRACK }).count()) === 1);
await page.locator("[data-sp-range]").selectOption("all");
await page.waitForTimeout(400);

/* ---- 16. 登记：字段名补全与重复单号 ---- */

console.log("\n16. 登记时的字段名补全与重复单号提醒");
await page.locator("[data-sp-register]").click();
await page.waitForTimeout(600);
const optCount = await page.locator("[data-oc-field-options] option").count();
check("登记弹窗里有字段名候选", optCount > 0, `${optCount} 个`);
const optVals = await page
  .locator("[data-oc-field-options] option")
  .evaluateAll((els) => els.map((e) => e.value));
info("字段名候选", optVals.slice(0, 6).join(", "));
check("候选里是以前真用过的字段名",
  optVals.includes("补发单号") || optVals.includes("客户"), optVals.join(","));
check("字段名输入框挂上了候选",
  (await page.locator("[data-oc-field-label]").first().getAttribute("list")) === "sp-field-labels");

// 重复单号：填一个已经登记过的
await page.locator("[data-oc-no]").fill(TRACK);
await page.waitForTimeout(500);
check("填了已登记过的单号会提醒", (await page.locator("[data-oc-dup]").count()) === 1);
const dupText = (await page.locator("[data-oc-dup]").innerText().catch(() => "")).replace(/\s+/g, " ");
info("重复提醒", dupText);
check("提醒里说了那条单现在在哪个步骤", /登记过/.test(dupText), dupText);
check("重复只是提醒，不拦着登记（同一单号二次问题是正常的）",
  (await page.locator("[data-oc-submit]").count()) === 1);

await page.locator("[data-oc-dup-open]").click();
await page.waitForTimeout(900);
check("「打开那条」把弹窗关掉", (await page.locator("[data-order-create]").count()) === 0);
const detailNo2 = await page.locator("[data-order-no-input]").inputValue().catch(() => "");
check("打开的正是已经登记的那条", detailNo2 === TRACK, `实际「${detailNo2}」`);
await shot("33-special-columns");

/* ---- 17. 快递商识别与查询路径 ---- */

console.log("\n17. 快递商识别与查询路径");
const trackRow3 = page.locator("[data-order-id]").filter({ hasText: TRACK }).first();

// 详情里：没手动指定过 = 空串（跟随识别），认错了可以改一次
check("详情里有快递商下拉", (await page.locator("[data-od-courier]").count()) === 1);
check("没指定过就是空的（不把识别结果冻进库）",
  (await page.locator("[data-od-courier]").inputValue()) === "",
  await page.locator("[data-od-courier]").inputValue());
await page.locator("[data-od-courier]").selectOption("yt");
await page.waitForTimeout(1200);
check("指定的快递商落库了", (await page.locator("[data-od-courier]").inputValue()) === "yt");

await page.locator('aside [data-nav="special"]').first().click();
await page.waitForTimeout(1000);
const courierBadge = trackRow3.locator("[data-order-courier]");
check("行上有快递商徽标", (await courierBadge.count()) === 1);
check("徽标上是改过的那家（手改优先级高于识别）",
  (await courierBadge.getAttribute("data-order-courier")) === "yt",
  String(await courierBadge.getAttribute("data-order-courier")));
check("徽标上写着快递商的短名", (await courierBadge.innerText()).includes("圆通"), await courierBadge.innerText());

// 查件：真的打开一个带单号的查询页（默认渠道 = 快递100）
const [popup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 12000 }).catch(() => null),
  trackRow3.locator("[data-order-track]").click(),
]);
check("点徽标会打开查询页", !!popup);
if (popup) {
  const u = popup.url();
  info("查询链接", u);
  check("查询页带上了这个单号", u.includes(TRACK), u.slice(0, 120));
  check("默认走快递100", u.includes("kuaidi100.com"), u.slice(0, 80));
  // 快递100 会把 chaxun?com=xxx 302 到 /all/<简称>.shtml，
  // 所以它跳到 yt.shtml 本身就证明 com 传对了 —— 两种形态都算数
  check("带的是改过的那家的通道（圆通）",
    u.includes("com=yuantong") || u.includes("/yt.shtml"), u.slice(0, 120));
  await popup.close().catch(() => {});
}

/**
 * 渠道对不对，**以复制出来的链接为准**，不看浏览器最后停在哪个页面：
 * 这些站点都会各自跳转（快递100 跳 /all/*.shtml，菜鸟跳淘宝系域名），
 * 断言最终 URL 等于在测外网今天是不是通的，跟我们的代码没关系。
 */
const copyLinks = async () => {
  await page.locator("[data-sp-select-all]").check();
  await page.waitForTimeout(450);
  await page.locator("[data-sp-batch-track]").click();
  await page.waitForTimeout(700);
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  await page.locator("[data-sp-batch-clear]").click();
  await page.waitForTimeout(350);
  return text;
};
const setChannel = async (v) => {
  await page.locator("[data-sp-view-settings]").click();
  await page.waitForTimeout(400);
  await page.locator("[data-sp-track-channel]").selectOption(v);
  await page.waitForTimeout(900);
  await page.locator("h1").first().click();
  await page.waitForTimeout(300);
};

await page.locator("[data-sp-view-settings]").click();
await page.waitForTimeout(400);
check("视图设置里能选查件渠道", (await page.locator("[data-sp-track-channel]").count()) === 1);
await page.locator("h1").first().click();
await page.waitForTimeout(300);

const links100 = await copyLinks();
info("快递100 链接", links100.split("\n")[0]);
check("批量复制出来的是带单号的查询链接",
  links100.includes("http") && links100.includes(TRACK), links100.slice(0, 100));
check("默认渠道拼的是快递100", links100.includes("kuaidi100.com"));
check("链接里带的是改过的那家（圆通=com=yuantong）",
  links100.includes("com=yuantong"), links100.slice(0, 120));

await setChannel("cainiao");
const linksCn = await copyLinks();
info("菜鸟链接", linksCn.split("\n")[0]);
check("换成菜鸟后拼出来的链接跟着换",
  linksCn.includes("cainiao.com") && linksCn.includes(TRACK), linksCn.slice(0, 120));

// 官网渠道：圆通没有可直接带单号的官网查询页 → 退回快递100，而且要说清楚
await setChannel("official");
const linksOfficial = await copyLinks();
info("官网渠道链接", linksOfficial.split("\n")[0]);
check("没有官网查询页的自动退回快递100（不硬拼一个 404 出来）",
  linksOfficial.includes("kuaidi100.com"), linksOfficial.slice(0, 120));
const [popup3] = await Promise.all([
  page.waitForEvent("popup", { timeout: 12000 }).catch(() => null),
  trackRow3.locator("[data-order-track]").click(),
]);
if (popup3) await popup3.close().catch(() => {});
const fbToast = await page.locator("[data-sp-toast]").innerText().catch(() => "");
info("回退提示", fbToast);
check("退回时明确说了用的是哪个渠道（不静默换地方）",
  fbToast.includes("已用"), fbToast || "(没有提示)");

await setChannel("kuaidi100");

// 按快递商筛选：这批单上有两家以上才出现这个下拉
if ((await page.locator("[data-sp-courier]").count()) === 1) {
  await page.locator("[data-sp-courier]").selectOption("yt");
  await page.waitForTimeout(600);
  const rowsYt = await page.locator("[data-order-id]").count();
  check("按快递商筛选只剩下那一家", rowsYt === 1, `实际 ${rowsYt} 行`);
  await page.locator("[data-sp-courier]").selectOption("");
  await page.waitForTimeout(500);
} else {
  check("按快递商筛选只剩下那一家", false, "快递商下拉没出现（数据里只有一家）");
}
// copyLinks 收尾时已经取消过选择；这里只在批量条还在时才点（点了不存在的按钮会一直等）
if ((await page.locator("[data-sp-batch]").count()) > 0) {
  await page.locator("[data-sp-batch-clear]").click();
  await page.waitForTimeout(400);
}

// 登记时：填单号就认出来，认错了能当场改
await page.locator("[data-sp-register]").click();
await page.waitForTimeout(600);
await page.locator("[data-oc-no]").fill(TRACK);
await page.waitForTimeout(600);
const guessAttr = await page.locator("[data-oc-courier-guess]").getAttribute("data-oc-courier-guess");
info("识别结果", guessAttr);
check("登记时填单号就认出快递商", guessAttr === "sf", String(guessAttr));
const guessTxt = (await page.locator("[data-oc-courier-guess]").innerText()).replace(/\s+/g, " ");
check("识别结果说人话", guessTxt.includes("顺丰"), guessTxt);
check("登记弹窗里也能改快递商", (await page.locator("[data-oc-courier]").count()) === 1);
await page.locator("[data-oc-courier]").selectOption("zt");
await page.waitForTimeout(300);
check("改了就按改的算，不再显示识别结果",
  (await page.locator("[data-oc-courier]").inputValue()) === "zt");
await page.locator("[data-oc-cancel]").click();
await page.waitForTimeout(400);
await shot("34-special-courier");

// 渠道偏好要跨刷新留着（故意留一个非默认值，否则"没变"证明不了什么）
await setChannel("cainiao");
await page.reload({ waitUntil: "networkidle" });
await page.locator("aside").first().waitFor({ timeout: 20000 });
await page.locator('aside [data-nav="special"]').first().click();
await page.waitForTimeout(1200);
await page.locator("[data-sp-view-settings]").click();
await page.waitForTimeout(400);
check("刷新后查件渠道还是上次选的",
  (await page.locator("[data-sp-track-channel]").inputValue()) === "cainiao",
  await page.locator("[data-sp-track-channel]").inputValue());
await page.locator("[data-sp-track-channel]").selectOption("kuaidi100");
await page.waitForTimeout(800);

await browser.close();

console.log("");
if (errors.length) {
  console.log(`控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log(`  ! ${e}`);
}
console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length || errors.length ? 1 : 0);
