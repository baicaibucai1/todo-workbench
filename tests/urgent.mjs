/**
 * 侧边栏底部的「紧急区」。
 *
 * 钉的是三条容易悄悄坏掉的事：
 *   1. **紧不急是算出来的** —— 截止时刻不同的字段（提醒时间 / 到期日 / 步骤时效）
 *      要合并成同一把尺子，且取更早的那个；
 *   2. **阈值真的能调** —— 改完立刻生效、刷新后还在、脏值不会让整区空掉；
 *   3. **不欠的不出现** —— 已完成的待办、已完结的工单不许混进来。
 *
 * 顺带钉一件更基础的事：计划表已经下线，界面上不该再有任何"加入今日计划"的入口
 * （留着就是点了没反应的死按钮）。
 *
 * 依赖 QQbot 项目里已安装的 playwright 与本机 Edge，前置 dev server 在 1420。
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const URL = "http://localhost:1420/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const FRESH = process.argv.includes("--fresh");
const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
if (FRESH) {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
}
await page.waitForTimeout(1200);

const setThreshold = async (minutes) => {
  await page.evaluate(async (m) => {
    const repo = await import("/src/lib/repo.ts");
    await repo.setSettings({ "urgent.thresholdMinutes": String(m) });
  }, minutes);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
};

const reload = async () => {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
};

const panel = () => page.locator("[data-urgent-panel]");
const items = () => page.locator("[data-urgent-item]");
const keys = async () =>
  (await items().evaluateAll((els) => els.map((e) => e.getAttribute("data-urgent-item")))) ?? [];
const threshold = () =>
  page.getAttribute("[data-urgent-panel]", "data-urgent-threshold").then(Number);

/* ------------------------------ 1. 空态 ------------------------------ */

section("1. 阈值收到最小时，种子数据不该被算成紧急");

await setThreshold(5);
check("紧急区挂在侧边栏底部", (await panel().count()) === 1);
check("阈值为 5 分钟", (await threshold()) === 5, String(await threshold()));
const emptyText = (await page.locator("[data-urgent-empty]").innerText().catch(() => "")) || "";
check("没有临期条目时给了空态说明", emptyText.length > 0, emptyText.slice(0, 40));
check("空态里说清了窗口有多长", emptyText.includes("5 分钟"), emptyText.replace(/\s+/g, " "));
check("已下线的计划表不再出现", (await page.locator("[data-plan-list]").count()) === 0);
check("「加入今日计划」的按钮也没有了", (await page.locator("[data-order-plan]").count()) === 0);

/* ------------------------------ 2. 造数据 ------------------------------ */

section("2. 临期与逾期的会被算出来");

const ids = await page.evaluate(async () => {
  const repo = await import("/src/lib/repo.ts");
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const today = repo.today();

  // 先清场：种子数据里"今天到期"的待办在阈值调到 1 天时会一起涌进来，
  // 而紧急区最多只摆 8 条 —— 那样被截掉的说不定正是我们要断言的那条。
  for (const t of await repo.fetchTasks({ view: "all", includeDone: true })) {
    if (t.dueDate === today) await repo.updateTask(t.id, { dueDate: null });
  }

  const lists = await repo.fetchLists();
  const listId = lists[0]?.id ?? (await repo.createList("紧急验证", "#d4537e")).id;

  const mk = async (title, patch) => {
    const t = await repo.createTask({ title, listId });
    await repo.updateTask(t.id, patch);
    return t.id;
  };
  const a = await mk("三十分钟后提醒", { remindAt: at(30 * 60_000) });
  const b = await mk("已经超时四十分钟", { remindAt: at(-40 * 60_000) });
  const c = await mk("三天后才提醒", { remindAt: at(3 * 24 * 60 * 60_000) });

  const flow = (await repo.fetchFlows())[0];
  // 交付日在五天后，但当前步骤 50 分钟后就到点 —— 该按步骤时效算
  const e = (
    await repo.createWorkOrder({
      title: "步骤时效快到了",
      flowId: flow.id,
      dueDate: repo.addDays(repo.today(), 5),
      stageDueAt: at(50 * 60_000),
    })
  ).id;
  // 已完结的单子：推到这套流程的终态
  const term = (await repo.fetchStages()).find(
    (s) => s.flowId === flow.id && s.isTerminal,
  );
  const f = (await repo.createWorkOrder({ title: "已经完结的单", flowId: flow.id })).id;
  if (term) await repo.moveOrderToStage(f, term.id, "测试用：推到终态");
  // 既没时效、交付日也在五天后
  const g = (
    await repo.createWorkOrder({
      title: "还早得很的单",
      flowId: flow.id,
      dueDate: repo.addDays(repo.today(), 5),
    })
  ).id;

  return { a, b, c, e, f, g };
});
info("造出来的 id", JSON.stringify(ids));

await reload();
await setThreshold(120);

let list = await keys();
info("紧急区", list.join(" | "));
check("三十分钟后提醒的待办进来了", list.includes(`task:${ids.a}`));
check("已超时的待办进来了", list.includes(`task:${ids.b}`));
check("三天后的待办没进来", !list.includes(`task:${ids.c}`));
check("步骤时效在窗口内的工单进来了", list.includes(`order:${ids.e}`));
check("已完结的工单没进来", !list.includes(`order:${ids.f}`));
check("没有时效、交付日也远的工单没进来", !list.includes(`order:${ids.g}`));

const first = await items().first().getAttribute("data-urgent-item");
check("逾期的排在最前", first === `task:${ids.b}`, String(first));

const st = async (key) =>
  (await page.locator(`[data-urgent-item="${key}"]`).getAttribute("data-urgent-state")) ?? "";
const remain = async (key) =>
  (await page.locator(`[data-urgent-item="${key}"]`).getAttribute("data-urgent-remain")) ?? "";
check("逾期的标着 overdue", (await st(`task:${ids.b}`)) === "overdue");
check("未逾期的标着 soon", (await st(`task:${ids.a}`)) === "soon");
check("逾期行写着「已超」", (await remain(`task:${ids.b}`)).includes("已超"), await remain(`task:${ids.b}`));
check("临期行写着「还剩」", (await remain(`task:${ids.a}`)).includes("还剩"), await remain(`task:${ids.a}`));

const badge = Number(
  (await page.locator("[data-urgent-count]").innerText().catch(() => "0")) || "0",
);
check("角标数字 = 紧急条数", badge === list.length, `${badge} vs ${list.length}`);

// 步骤时效优先于交付日：这条的交付日在五天后，能出现只能是因为步骤时效
const eTitle = (await page.locator(`[data-urgent-item="order:${ids.e}"]`).getAttribute("title")) ?? "";
check("行上写清了凭什么算它紧急", eTitle.includes("当前步骤时效"), eTitle);
check("并且给出了截止时刻", /\d+月\d+日 \d+:\d+/.test(eTitle), eTitle);

await page.locator("[data-urgent-panel]").screenshot({ path: `${SHOT_DIR}/20-urgent-panel.png` });

/* ------------------------------ 3. 完成的不再欠 ------------------------------ */

section("3. 做完了就从紧急区撤走");

await page.evaluate(async (id) => {
  const repo = await import("/src/lib/repo.ts");
  await repo.updateTask(id, { done: true });
}, ids.a);
await reload();
list = await keys();
check("勾掉之后不再算紧急", !list.includes(`task:${ids.a}`), list.join(" | "));
check("同批的逾期项不受影响", list.includes(`task:${ids.b}`));

await page.evaluate(async (id) => {
  const repo = await import("/src/lib/repo.ts");
  await repo.updateTask(id, { done: false });
}, ids.a);
await reload();

/* ------------------------------ 4. 阈值真的能调 ------------------------------ */

section("4. 阈值：改完立刻生效、刷新还在");

await setThreshold(5);
list = await keys();
check("阈值 5 分钟时，30 分钟后那条退出了", !list.includes(`task:${ids.a}`), list.join(" | "));
check("已经逾期的永远在（它比阈值更急）", list.includes(`task:${ids.b}`));

await setThreshold(1440);
list = await keys();
check("阈值放到 1 天，步骤时效那条仍在", list.includes(`order:${ids.e}`));
check("三天后的那条还是不进（超出窗口）", !list.includes(`task:${ids.c}`), list.join(" | "));

// 走界面改一次：设置里的下拉必须真的落到数据上
await page.locator('aside [data-nav="settings"]').first().click();
await page.locator("[data-settings]").waitFor({ timeout: 15000 });
await page.locator('[data-section="behavior"]').click();
await page.locator('[data-act="urgent-minutes"]').waitFor({ timeout: 15000 });
const sel = page.locator('[data-act="urgent-minutes"]');
check("设置里有紧急阈值这一项", (await sel.count()) === 1);
await sel.selectOption("30");
await page.waitForTimeout(500);
check("改完立即生效（不用刷新）", (await threshold()) === 30, String(await threshold()));
list = await keys();
check("阈值 30 分钟时，30 分钟后那条仍在窗口内", list.includes(`task:${ids.a}`), list.join(" | "));

// 自定义档位：下拉切到「自定义」后能填分钟数
await sel.selectOption("custom");
await page.locator("[data-act='urgent-custom']").waitFor({ timeout: 15000 });
const custom = page.locator("[data-act='urgent-custom']");
check("选「自定义」后出现分钟输入框", (await custom.count()) === 1);
await custom.fill("60");
await custom.press("Enter");
await page.waitForTimeout(500);
check("自定义分钟数生效", (await threshold()) === 60, String(await threshold()));

// 脏值：写进库里的不是数字也要有兜底
await page.evaluate(async () => {
  const repo = await import("/src/lib/repo.ts");
  await repo.setSettings({ "urgent.thresholdMinutes": "abc" });
});
await reload();
check("脏值被夹回默认（紧急区不会莫名全空）", (await threshold()) === 480, String(await threshold()));

await setThreshold(120);
await reload();
check("阈值跨刷新保留", (await threshold()) === 120, String(await threshold()));

/* ------------------------------ 5. 点得开 ------------------------------ */

section("5. 点一下就能打开那条");

await page.locator(`[data-urgent-item="task:${ids.b}"]`).click();
await page.waitForTimeout(700);
const mode1 = await page.getAttribute("aside[data-detail-mode]", "data-detail-mode");
check("点待办打开的是待办详情", mode1 === "task", String(mode1));
// 标题是个 input，innerText 读不到它的 value —— 得按表单控件去取
const detailTitle = await page.evaluate(() => {
  const el = document.querySelector("aside[data-detail-mode]");
  if (!el) return "";
  return Array.from(el.querySelectorAll("input, textarea"))
    .map((i) => i.value)
    .join(" | ");
});
check("详情里正是点的那条", detailTitle.includes("已经超时四十分钟"), detailTitle.slice(0, 80));

await page.locator(`[data-urgent-item="order:${ids.e}"]`).click();
await page.waitForTimeout(700);
const mode2 = await page.getAttribute("aside[data-detail-mode]", "data-detail-mode");
check("点工单打开的是工单详情", mode2 === "order", String(mode2));

/* ------------------------------ 6. 控制台 ------------------------------ */

section("6. 控制台");
check("没有报错", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n汇总: ${pass} 通过 / ${fail} 失败`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
