/**
 * 「异常单号登记」v0.8.0 的一次性示例生成：登记一条示例单 →
 * 记两步流程（带时间）→ 设一个已到点的提醒 → 把整条链路截图给用户看。
 *
 * 拍四张：
 *   1. 工具详情页 —— 流程时间线（已联系快递 09:30 → 平台申诉中 现在）+ 提醒块「已到点」
 *   2. 工作台待办列表 —— 那条「⏰ 异常单提醒」带着「异常单号登记」来源标记
 *   3. 到点弹出的提醒卡（右下角）
 *   4. 点提醒卡「查看」后的待办详情 —— 来源说明
 *
 * ⚠️ 这条示例会真的登记进用户浏览器（127.0.0.1:1420 的 localStorage）里 ——
 * 脚本开头先把整个 localStorage 备份成 JSON，要还原随时能回。
 *
 * 前置：dev server 已在 http://127.0.0.1:1420/ 运行。
 * 用法：node tests/gen-abnormal-demo.mjs
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://127.0.0.1:1420/";
const OUT = "C:/AI_Production/Tools/main/.setup-tmp/abnormal-demo";
fs.mkdirSync(OUT, { recursive: true });

/** Date → datetime-local 的值（本地时区，分钟精度） */
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

/* ---------- 0. 备份用户的 localStorage（示例会往里写数据） ---------- */
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(1200);
const backup = await page.evaluate(() =>
  JSON.stringify(Object.fromEntries(Object.entries(localStorage)), null, 1),
);
fs.writeFileSync(`${OUT}/localstorage-backup.json`, backup, "utf8");
console.log(`  · 已备份 localStorage（${Object.keys(JSON.parse(backup)).length} 个键）→ localstorage-backup.json`);

/* ---------- 1. 打开工具，登记示例单 ---------- */
await page.goto(`${BASE}?tool=abnormal-ticket`, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
const frameEl = page.locator('iframe[data-tool-frame="abnormal-ticket"]');
await frameEl.waitFor({ state: "attached", timeout: 15000 });
await page.waitForTimeout(1500);
const frame = page.frames().find((f) => /\/tools\/abnormal-ticket\//.test(f.url()));
if (!frame) throw new Error("找不到工具 iframe");
check("工具已连上宿主（bindState=bound）",
  (await frame.evaluate(() => document.body.dataset.bindState)) === "bound");

const ORDER_SN = "261012-990127453301582";
// 店铺/快递/情况：优先选语义匹配的项，配置里没有就用第一个非空项（不预设用户的配置内容）
async function pick(selectId, want) {
  return frame.evaluate(([id, w]) => {
    const sel = document.getElementById(id);
    const opts = [...sel.options].map((o) => o.value).filter(Boolean);
    return w ? (opts.find((v) => v.includes(w)) || opts[0] || "") : (opts[0] || "");
  }, [selectId, want]);
}
await frame.selectOption("#store", await pick("store", "拼多多5"));
await frame.fill("#orderSn", ORDER_SN);
await frame.fill("#trackingNo", "YT7482013371295");
await frame.selectOption("#courier", await pick("courier", "圆通"));
await frame.fill("#shipped", "2026-10-11");
await frame.selectOption("#category", await pick("category", ""));
await frame.fill("#title", "示例：包裹显示已签收但客户说没收到，快递员电话没人接，先联系快递网点再走平台申诉。");
console.log("  · 表单预检：", await frame.evaluate(() => ({
  bind: document.body.dataset.bindState,
  store: document.getElementById("store").value,
  orderSn: document.getElementById("orderSn").value,
  courier: document.getElementById("courier").value,
  category: document.getElementById("category").value,
})));
await frame.click("#add");
await page.waitForTimeout(800);
console.log("  · 登记后：", await frame.evaluate(() => ({
  toast: (document.getElementById("toast") || {}).textContent || "",
  listN: document.querySelectorAll("#list .ticket").length,
  view: document.querySelector(".tabs [aria-selected=\"true\"]") || {},
  viewId: (document.querySelector(".tabs [aria-selected=\"true\"]") || {}).id || "",
})));

/* ---------- 2. 查看页：记两步流程 ---------- */
await frame.click("#tab-browse");
await page.waitForTimeout(500);
// 选中是记忆式的 —— 显式点中刚登记的这条。
// 行首 code 显示的是**快递单号**（tracking_no 优先，没填才退到订单号）。
const demoId = await frame.evaluate((code) => {
  const row = [...document.querySelectorAll(".ticket")].find(
    (r) => (r.querySelector(".code") || {}).textContent === code,
  );
  return row ? row.getAttribute("data-id") : "";
}, "YT7482013371295");
if (!demoId) throw new Error("示例单没登记上（列表里找不到 YT7482013371295）");
check("示例单已登记（列表里找得到）", true);
await frame.click(`.ticket[data-id="${demoId}"]`);
await page.waitForTimeout(500);

// 第一步：已联系快递（时刻改到今天 09:30，像一条补记的轨迹）
await frame.selectOption("#flowName", "已联系快递");
await frame.fill("#flowAt", toLocalInput(new Date(new Date().toDateString() + " 09:30:00")));
await frame.click('#detail button[data-act="flow-add"]');
await page.waitForTimeout(500);
// 第二步：平台申诉中（默认现在）
await frame.selectOption("#flowName", "平台申诉中");
await frame.click('#detail button[data-act="flow-add"]');
await page.waitForTimeout(500);
const flow = await frame.evaluate(() => ({
  steps: document.querySelectorAll("#detail .flow-step").length,
  cur: ((document.querySelector("#detail .flow-step.cur .flow-name") || {}).textContent || "").trim(),
  badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
}));
check("流程记了两步，徽标 = 最后一步（平台申诉中）",
  flow.steps === 2 && flow.cur === "平台申诉中 · 当前" && flow.badge === "平台申诉中", JSON.stringify(flow));

/* ---------- 3. 设一个 5 分钟前到点的提醒 ---------- */
await frame.fill("#remindAt", toLocalInput(Date.now() - 5 * 60_000));
await frame.click('[data-act="remind-set"]');
await page.waitForTimeout(1200);
const remind = await frame.evaluate(() => ({
  hint: (document.getElementById("remindHint") || {}).textContent || "",
  toast: (document.getElementById("toast") || {}).textContent || "",
}));
console.log(`  · 工具提示：${remind.toast || remind.hint}`);
check("提醒订上了（状态文案说已到点）", /到点/.test(remind.hint), remind.hint);

const shot1 = `${OUT}/1-工具详情-流程与提醒.png`;
await page.screenshot({ path: shot1 });

/* ---------- 4. 工作台待办：来源标记 ---------- */
// 侧栏导航是 To Do 风格（我的一天 / 重要 / 全部）——「全部」能看到所有清单
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(1000);
let originRow = page.locator('[data-tool-origin="abnormal-ticket"]').locator("..").locator("..");
if ((await originRow.count()) === 0) {
  // 待办视图可能默认停在没有那条单子的清单上 —— 点第一个清单导航兜底
  const firstList = page.locator('aside [data-nav^="list:"]').first();
  if ((await firstList.count()) > 0) { await firstList.click(); await page.waitForTimeout(800); }
  originRow = page.locator('[data-tool-origin="abnormal-ticket"]').locator("..").locator("..");
}
const originCount = await originRow.count();
check("待办里出现了带来源标记的那条提醒", originCount > 0, `data-tool-origin 命中 ${originCount}`);
const shot2 = `${OUT}/2-待办列表-来源标记.png`;
if (originCount > 0) {
  const rowText = (await originRow.first().innerText()).replace(/\s+/g, " ").slice(0, 80);
  console.log(`  · 待办行：${rowText}`);
  await originRow.first().screenshot({ path: shot2 });
} else {
  await page.screenshot({ path: shot2 });
}

/* ---------- 5. 到点提醒卡 ---------- */
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
let cardVisible = false;
for (let i = 0; i < 8 && !cardVisible; i++) {
  cardVisible = (await page.locator("[data-reminder]").count()) > 0;
  if (!cardVisible) {
    await page.waitForTimeout(4000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  }
}
check("到点弹出了提醒卡（右下角）", cardVisible);
const shot3 = `${OUT}/3-提醒卡片.png`;
await page.screenshot({ path: shot3 });
if (cardVisible) {
  await page.locator("[data-reminder]").first().screenshot({ path: `${OUT}/3b-提醒卡片特写.png` });
}

/* ---------- 6. 点「查看」→ 待办详情里的来源说明 ---------- */
const shot4 = `${OUT}/4-待办详情-来源说明.png`;
if (cardVisible) {
  await page.locator('[data-act="reminder-open"]').first().click();
  await page.waitForTimeout(900);
  const note = await page.locator("[data-tool-origin-detail]").count();
  check("待办详情里挂着来源说明", note > 0, `data-tool-origin-detail 命中 ${note}`);
  await page.screenshot({ path: shot4 });
} else {
  await page.screenshot({ path: shot4 });
}

/* ---------- 汇总 ---------- */
console.log("\n—— 示例截图 ——");
for (const f of fs.readdirSync(OUT).filter((n) => n.endsWith(".png"))) {
  console.log(`  ${OUT}/${f}  (${Math.round(fs.statSync(`${OUT}/${f}`).size / 1024)} KB)`);
}
check("全程无页面错误", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(failed === 0 ? "\n示例生成完成，全部检查通过" : `\n${failed} 项检查未通过`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
