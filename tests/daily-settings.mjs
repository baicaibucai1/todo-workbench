/**
 * 每日任务 + 设置界面 + 主题的浏览器验证。
 *
 * 关注"改了之后界面有没有真的跟着变"：
 *   我的一天分两节、每日任务跨天重置、昵称改完侧边栏同步、
 *   主题切到深色生效且刷新后还在、启动视图改完重开落在那个视图。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/daily-settings.mjs [--url http://localhost:1420/]
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

const rows = () => page.locator("[data-task-id]");
const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });

async function boot() {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(800);
}

console.log("\n1. 我的一天分成「今日任务」和「每日任务」");
await boot();
await page.locator('aside [data-nav="myday"]').click();
await page.waitForTimeout(600);

const bodyText = (await page.locator("main, div").first().innerText().catch(() => "")) || "";
const pageText = await page.evaluate(() => document.body.innerText);
check("出现「今日任务」分组", pageText.includes("今日任务"));
check("出现「每日任务」分组", pageText.includes("每日任务"));

const badgeCount = await page.locator("[data-repeat-badge]").count();
info("每日标记数", badgeCount);
check("种子里的每日任务带「每日」标记", badgeCount >= 2, `count=${badgeCount}`);

// 每日任务应当落在「每日任务」那一节里，而不是混在今日任务中
const inDailySection = await page.evaluate(() => {
  const badge = document.querySelector("[data-repeat-badge]");
  if (!badge) return null;
  const row = badge.closest("[data-task-id]");
  const box = row?.parentElement?.parentElement;
  return box?.textContent?.includes("每日任务") ?? false;
});
check("每日任务归在「每日任务」一节", inDailySection === true, String(inDailySection));
await shot("01-myday-light");

console.log("\n2. 用「每日」开关新建每日任务");
await page.locator("[data-daily-toggle]").click();
await page.waitForTimeout(200);
const ph = await page.locator('input[placeholder="添加每日任务"]').count();
check("输入框提示切换为「添加每日任务」", ph === 1);

await page.locator('input[placeholder="添加每日任务"]').fill("每天喝水 2L");
await page.keyboard.press("Enter");
await page.waitForTimeout(700);

const newRow = rows().filter({ hasText: "每天喝水 2L" }).first();
check("新任务已创建", (await newRow.count()) === 1);
check("新任务带每日标记", (await newRow.locator("[data-repeat-badge]").count()) === 1);

console.log("\n3. 完成每日任务，状态正确");
// 勾完成后会立刻移出活动列表、收进「已完成」折叠区（与 To Do 一致）
await newRow.locator("button").first().click(); // 完成勾选圈
await page.waitForTimeout(700);
const stillActive = await rows().filter({ hasText: "每天喝水 2L" }).count();
check("勾选后从活动列表移出", stillActive === 0, `count=${stillActive}`);

await page.locator("button").filter({ hasText: "已完成" }).first().click();
await page.waitForTimeout(400);
const doneRow = rows().filter({ hasText: "每天喝水 2L" }).first();
check("已完成分组里能看到这条", (await doneRow.count()) === 1);
check("已完成行有删除线", (await doneRow.locator(".line-through").count()) === 1);

// 取消完成，让它回到未完成，后面的用例仍在干净状态上跑
await doneRow.locator("button").first().click();
await page.waitForTimeout(600);

console.log("\n4. 详情面板可以设置重复规则");
await page.locator("[data-task-id] div.truncate").first().click();
await page.waitForTimeout(400);
const detailEl = page.locator("[data-task-detail]");
check("详情面板已打开", (await detailEl.count()) === 1);
await detailEl.locator('[data-repeat="daily"]').click();
await page.waitForTimeout(600);
const repeatHint = (await detailEl.innerText()) || "";
info("重复提示", repeatHint.split("\n").find((l) => l.includes("每天")) ?? "");
check("切换为每天后出现说明文案", repeatHint.includes("每天出现") || repeatHint.includes("明天自动恢复"));
await shot("02-detail-repeat");

console.log("\n5. 设置界面：个人资料");
await page.locator('aside [data-nav="settings"]').click();
await page.waitForTimeout(500);
check("设置界面已打开", (await page.locator("[data-settings]").count()) === 1);

const nameInput = page.locator('[data-section="profile"]').isVisible;
info("分区导航可见", !!nameInput);
await page.locator('input[placeholder="想让别人怎么称呼你"]').fill("苏打水");
await page.keyboard.press("Enter");
await page.waitForTimeout(600);

const sideName = (await page.locator("[data-profile-name]").textContent()) || "";
info("侧边栏昵称", sideName.trim());
check("侧边栏昵称已同步", sideName.trim() === "苏打水", sideName);

await page.locator('input[placeholder="name@example.com"]').fill("soda@example.com");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
const sideText = (await page.locator('aside [data-nav="profile"]').textContent()) || "";
check("侧边栏邮箱已同步", sideText.includes("soda@example.com"), sideText.trim());
await shot("03-settings-profile");

console.log("\n6. 设置界面：外观主题");
await page.locator('[data-section="appearance"]').click();
await page.waitForTimeout(300);
await page.locator('[data-theme-option="dark"]').click();
await page.waitForTimeout(500);
const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
check("已切到深色主题", themeAttr === "dark", String(themeAttr));
await shot("04-settings-dark");

// 深色下回到任务视图看看整体效果
await page.locator('aside [data-nav="myday"]').click();
await page.waitForTimeout(600);
await shot("05-myday-dark");
const darkBg = await page.evaluate(
  () => getComputedStyle(document.querySelector("aside")).backgroundColor,
);
info("深色下侧边栏背景", darkBg);
check("深色下侧边栏已变深", /rgb\(3[0-9], 3[0-9]|rgb\(2[0-9], 2[0-9]/.test(darkBg), darkBg);

console.log("\n7. 设置刷新后仍然生效");
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
check("刷新后仍是深色", themeAfter === "dark", String(themeAfter));
const nameAfter = (await page.locator("[data-profile-name]").textContent()) || "";
check("刷新后昵称仍在", nameAfter.trim() === "苏打水", nameAfter);

console.log("\n8. 设置界面：数据、偏好、关于");
await page.locator('aside [data-nav="settings"]').click();
await page.waitForTimeout(400);
await page.locator('[data-section="data"]').click();
await page.waitForTimeout(600);
const dataText = (await page.locator("[data-settings]").innerText()) || "";
check("显示数据库信息", dataText.includes("内存库") || dataText.includes("SQLite"), dataText.slice(0, 60));
check("显示任务统计", /任务数[\s\S]{0,20}\d/.test(dataText), dataText.slice(0, 120));
await page.locator('[data-act="clear"]').click();
await page.waitForTimeout(300);
check("清空按钮弹出二次确认", (await page.locator('[data-act="confirm-clear"]').count()) === 1);
await page.locator("button").filter({ hasText: "取消" }).first().click();
await page.waitForTimeout(200);
await shot("06-settings-data");

await page.locator('[data-section="behavior"]').click();
await page.waitForTimeout(400);
await page.locator('[data-act="startup-view"]').selectOption("all");
await page.waitForTimeout(500);
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
const headerTitle = (await page.locator("h1").first().textContent()) || "";
info("重载后的视图标题", headerTitle.trim());
check("启动视图设置生效", headerTitle.includes("全部"), headerTitle);

await page.locator('aside [data-nav="settings"]').click();
await page.waitForTimeout(400);
await page.locator('[data-section="about"]').click();
await page.waitForTimeout(300);
const aboutText = (await page.locator("[data-settings]").innerText()) || "";
info("关于页文本", aboutText.replace(/\n+/g, " | ").slice(0, 160));
check("关于页显示版本号", /v\d+\.\d+\.\d+/.test(aboutText), aboutText.slice(0, 80));
check("关于页标注作者 Sogapopo", /Sogapopo/.test(aboutText), aboutText.slice(0, 80));

// 底部那句灰色小字：文案与样式都要在，改文案时这里会红，是故意的。
const motto = page.locator("[data-about-motto]");
check("关于页有底部题记", (await motto.count()) === 1);
if ((await motto.count()) === 1) {
  const mottoText = ((await motto.innerText()) || "").trim();
  const mottoClass = (await motto.getAttribute("class")) || "";
  check(
    "题记是约定的那句",
    mottoText === "我们的生命都相当无序甚至是荒谬，也许这款应用能帮您从中构建部分的秩序",
    mottoText,
  );
  check("题记用灰色小字（text-fg-dim）", mottoClass.includes("text-fg-dim"), mottoClass);
}

await page.locator('[data-act="check-update"]').click();
await page.waitForTimeout(600);
check("检查更新给出明确反馈", (await page.locator("[data-flash]").count()) === 1);

console.log("\n9. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
