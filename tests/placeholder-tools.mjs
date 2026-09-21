/**
 * 工具槽位的浏览器验证：AI 生成（已接入真实接口）+ 表名越界防护。
 *
 * 这里验的是可证伪的事实，不是"看着有"：
 *   · 侧边栏真的出现工具项，点开后 iframe 真的指向各自的入口
 *   · AI 生成页的三个能力页签来自服务商描述符，没配密钥时按钮必须是禁用的
 *   · 宿主下发的主题能传进 iframe（切深色后工具内部也要变）
 *   · 工具只能发裸表名，宿主强制拼前缀 —— 无论它说要哪张表都碰不到 core_*
 *
 * 注意「特殊单号记录」原来是个占位工具（tools/special-orders），
 * 现在改成了**原生专属视图**（见 tests/special-orders.mjs）：
 * 它的时效要挂在流转过程态上、要进底部紧急区、要参与排序，
 * 而工具在物理上碰不到 core_* 表，塞不进去。所以这里只剩三个工具。
 *
 * 更深一层的 AI 接口验证在 tests/ai-gen.mjs（配置持久化 / 真实请求 / 错误映射）。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/placeholder-tools.mjs [--url http://localhost:1420/]
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
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/${n}.png` });

/** 打开某个工具，返回它的 iframe（找不到返回 null） */
async function openTool(id) {
  await page.goto(`${BASE}?tool=${id}`, { waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(1500);
  const el = page.locator(`iframe[data-tool-frame="${id}"]`);
  if ((await el.count()) === 0) return null;
  await el.waitFor({ state: "attached" });
  await page.waitForTimeout(900);
  return page.frames().find((f) => /\/tools\/[^/]+\//.test(f.url())) ?? null;
}

console.log("\n1. 工具槽位：侧边栏");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);

const sidebar = page.locator("aside button");
check("侧边栏出现「AI 生成」", (await sidebar.filter({ hasText: "AI 生成" }).count()) > 0);
check("侧边栏出现「尺码表生成器」", (await sidebar.filter({ hasText: "尺码表生成器" }).count()) > 0);
check("侧边栏出现「图片裁剪」", (await sidebar.filter({ hasText: "图片裁剪" }).count()) > 0);
// 占位工具已下线：它曾经以 iframe 工具的形式挂在侧边栏「工具」区里
check(
  "「特殊单号记录」工具项已下线",
  (await sidebar.filter({ hasText: "特殊单号记录" }).count()) === 0,
);
// 但它并没有消失，而是变成了原生智能视图 —— 一个文字都不该少
check(
  "「特殊单号」以原生视图出现",
  (await page.locator('aside [data-nav="special"]').count()) === 1,
);
info("工具数", await page.locator('aside [data-nav^="tool:"]').count());
check("工具区正好三个工具", (await page.locator('aside [data-nav^="tool:"]').count()) === 3);
check("初始无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

// 越界防护：工具只能发裸表名，宿主强制拼前缀 ——
// 所以无论工具说要哪张表，都只会落在自己的命名空间里。
const prefixed = await page.evaluate(async () => {
  const mod = await import("/src/lib/tools.ts");
  return mod.toolTable("image-crop", "core_tasks");
});
info("工具请求 core_tasks 实际得到", prefixed);
check(
  "任何表名都会被强制加工具前缀，碰不到核心表",
  prefixed === "tool_image_crop_core_tasks" && prefixed !== "core_tasks",
  prefixed,
);

console.log("\n2. AI 生成：已从占位升级成真工具");
const f2 = await openTool("ai-gen");
check("iframe 指向 ai-gen 入口", !!f2, f2 ? f2.url() : "未找到 iframe");

if (f2) {
  // 三个能力页签 —— 少了哪个都说明描述符没被界面读出来
  const tabs = await f2.locator("#tabs .tab").evaluateAll((els) =>
    els.map((e) => `${e.dataset.tab}${e.disabled ? "(disabled)" : ""}`),
  );
  info("页签", tabs.join(", "));
  check("生图 / 生视频 / 对话 三个页签都在", tabs.length === 3, tabs.join(","));
  check("Agnes 三种能力都启用", tabs.every((t) => !t.includes("disabled")), tabs.join(","));

  // 服务商是数据驱动的，所以下拉里必须有 Agnes
  const provs = await f2.locator("#provSel option").evaluateAll((els) => els.map((e) => e.value));
  info("服务商", provs.join(", "));
  check("服务商下拉含 agnes", provs.includes("agnes"), provs.join(","));
  check("预置了第二种服务商（证明是可扩展的，不是写死一家）", provs.length >= 2, provs.join(","));

  // 关键事实：还没配密钥时，生成按钮必须是禁用的，而且要说清楚缺什么
  const imgDisabled = await f2.locator("#btnGenImg").isDisabled();
  check("未配置时生图按钮禁用", imgDisabled);
  // 注意只断言"缺 API Key"：Base URL 对 Agnes 是有默认值的，本来就不缺 ——
  // 断言两个都缺是在测我的想象，不是在测程序。
  const notice = await f2.locator("#notices").innerText();
  info("提示条", notice.replace(/\s+/g, " ").slice(0, 100));
  check("提示条点名了缺什么（API Key）", notice.includes("API Key"), notice.replace(/\s+/g, " ").slice(0, 80));
  check("提示条说了去哪里补（配置）", notice.includes("配置"), notice.replace(/\s+/g, " ").slice(0, 80));

  const st = await f2.evaluate(() => document.body.dataset.configState);
  info("配置状态", st);
  check("配置状态来自数据库读取", st === "loaded" || st === "empty", String(st));

  const bound = await f2.evaluate(() => document.body.dataset.bindState);
  check("已通过宿主通道连上数据库", bound === "bound", `bindState=${bound}`);

  check("不再自称占位", (await f2.locator("text=占位 · 待接入 API").count()) === 0);
  await shot("14-ai-gen");
}

console.log("\n3. 主题下发：宿主切深色，iframe 内部跟随");
await page.evaluate(async () => {
  const mod = await import("/src/lib/settings.ts");
  mod.applyTheme("dark");
});
await page.waitForTimeout(700);
if (f2) {
  const theme = await f2.evaluate(() => document.documentElement.dataset.theme);
  check("深色主题传进了 iframe", theme === "dark", `iframe theme=${theme}`);
  const bg = await f2.evaluate(() => getComputedStyle(document.body).backgroundColor);
  info("iframe 背景色", bg);
  check("深色下背景确实变暗（用的是深色令牌值）", bg === "rgb(23, 23, 21)", bg);
  await shot("15-ai-gen-dark");
}
await page.evaluate(async () => {
  const mod = await import("/src/lib/settings.ts");
  mod.applyTheme("light");
});

console.log("\n4. 控制台");
check("全程无 console 错误 / pageerror", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();

console.log(`\n====================================================`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
console.log(`====================================================`);
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
