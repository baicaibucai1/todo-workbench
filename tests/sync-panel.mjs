/**
 * 设置页「同步」分区的浏览器验证。
 *
 * 同步本身跑不了（要桌面版 + 真实 WebDAV），这里验的是**界面这一层**：
 * 分区进得去、默认只勾待办、勾选能落库并跨刷新保持、
 * 一个都不勾时会被拦住、演示模式有明确说明、按钮在没法用时是禁用的。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/sync-panel.mjs [--url http://localhost:1420/]
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

const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });

/** 打开设置并切到「同步」分区 */
async function openSync() {
  await page.locator('aside [data-nav="settings"]').click();
  await page.waitForSelector("[data-settings]", { timeout: 20000 });
  await page.locator('[data-section="sync"]').click();
  await page.waitForTimeout(400);
}

const shardState = async () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-sync-shard]")].map((el) => [
        el.getAttribute("data-sync-shard"),
        el.getAttribute("data-on") === "1",
      ]),
    ),
  );

console.log("\n1. 同步分区在导航里，点得进去");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);

await page.locator('aside [data-nav="settings"]').click();
await page.waitForSelector("[data-settings]", { timeout: 20000 });

const sections = await page.evaluate(() =>
  [...document.querySelectorAll("[data-section]")].map((el) => el.getAttribute("data-section")),
);
info("设置分区", sections);
check("分区里有 sync", sections.includes("sync"));
check(
  "同步排在「数据与备份」之后（它是数据的事）",
  sections.indexOf("sync") === sections.indexOf("data") + 1,
  sections.join(" > "),
);

await page.locator('[data-section="sync"]').click();
await page.waitForTimeout(400);
const syncText = (await page.locator("[data-settings]").innerText()) || "";
check("标题是「同步」", syncText.includes("同步"));
check("写清了是坚果云 WebDAV", syncText.includes("坚果云"));
check("提到了「双向合并」的语义", syncText.includes("双向") || syncText.includes("后改听谁的"));
await shot("40-sync-section");

console.log("\n2. 账号信息：默认服务器 + 四个输入框");
const base = await page.locator('[data-field="sync-base"]').inputValue();
check("服务器地址默认是坚果云", base.includes("jianguoyun.com"), base);
check("账号输入框存在", (await page.locator('[data-field="sync-user"]').count()) === 1);
check("密码输入框存在", (await page.locator('[data-field="sync-pass"]').count()) === 1);
check("目录输入框存在", (await page.locator('[data-field="sync-dir"]').count()) === 1);
const dir = await page.locator('[data-field="sync-dir"]').inputValue();
check("目录默认是「待办工作台」", dir === "待办工作台", dir);
const passType = await page.locator('[data-field="sync-pass"]').getAttribute("type");
check("密码是掩码输入", passType === "password", String(passType));
check("提示了用的是应用密码而不是登录密码", syncText.includes("应用密码"));

console.log("\n3. 同步内容：默认只勾待办");
const st0 = await shardState();
info("默认勾选", st0);
check("四项都在（待办 / 流程任务 / 图库 / 附件）", Object.keys(st0).length === 4, Object.keys(st0).join(","));
check("待办默认勾上", st0.tasks === true);
check("流程任务默认不勾", st0.orders === false);
check("图库默认不勾", st0.gallery === false);
check("附件默认不勾", st0.attachments === false);
check("说明了只同步记录、不传文件本体", syncText.includes("原文件不会上传"));

console.log("\n4. 浏览器演示模式：说清为什么用不了，按钮是禁用的");
check("有演示模式的说明", syncText.includes("演示模式") || syncText.includes("localStorage"));
check(
  "说明了 PROPFIND / MKCOL 发不出去",
  syncText.includes("PROPFIND") || syncText.includes("发不出去"),
);
const testBtn = page.locator("[data-sync-test]");
const nowBtn = page.locator("[data-sync-now]");
check("「测试连接」按钮在", (await testBtn.count()) === 1);
check("「立即同步」按钮在", (await nowBtn.count()) === 1);
check("演示模式下「测试连接」是禁用的", await testBtn.isDisabled());
check("演示模式下「立即同步」是禁用的", await nowBtn.isDisabled());
check("没填账号时提示按钮为什么是灰的", syncText.includes("账号和应用密码"));
check("显示了「上次同步」且初始是「还没同步过」", syncText.includes("还没同步过"));

console.log("\n5. 勾选：能改、能落库、刷新后还在");
await page.locator('[data-sync-shard="gallery"]').click();
await page.waitForTimeout(300);
check("点一下图库就勾上了", (await shardState()).gallery === true);

await page.locator('[data-sync-shard="tasks"]').click();
await page.waitForTimeout(300);
let st1 = await shardState();
info("勾选变化后", st1);
check("取消待办生效", st1.tasks === false);
check("图库仍然勾着", st1.gallery === true);

// 一个都不勾是"点了同步却什么都不发生"，必须拦住
await page.locator('[data-sync-shard="gallery"]').click();
await page.waitForTimeout(300);
const st2 = await shardState();
info("试图取消最后一个", st2);
check("最后一个分片取消不掉", st2.gallery === true);
check("给出了明确原因", (await page.locator("[data-flash]").innerText()).includes("至少要同步一类"));
await shot("41-sync-shards");

await page.waitForTimeout(4200); // 等提示自己消失，免得干扰后面的断言

// 刷新后重新进设置：状态必须还在（说明真的写进了 core_settings）
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
await openSync();
const st3 = await shardState();
info("刷新后", st3);
check("刷新后仍然是「只勾图库」", st3.gallery === true && st3.tasks === false, JSON.stringify(st3));

console.log("\n6. 账号与目录能填能存");
await page.locator('[data-field="sync-user"]').fill("someone@example.com");
await page.locator('[data-field="sync-dir"]').fill("我的待办数据");
await page.locator('[data-field="sync-pass"]').fill("app-password-123");
await page.locator('[data-field="sync-dir"]').press("Enter");
await page.waitForTimeout(500);

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
await openSync();
check("账号存下来了", (await page.locator('[data-field="sync-user"]').inputValue()) === "someone@example.com");
check("目录存下来了", (await page.locator('[data-field="sync-dir"]').inputValue()) === "我的待办数据");
check("账号已填，但演示模式下按钮仍然禁用", await page.locator("[data-sync-now]").isDisabled());
const afterFill = (await page.locator("[data-settings]").innerText()) || "";
check("填完账号后不再提示「先填账号」", !afterFill.includes("账号和应用密码都填上之后"));
await shot("42-sync-filled");

console.log("\n7. 恢复成默认（只同步待办），别给后面的套件留脏状态");
await page.locator('[data-sync-shard="tasks"]').click();
await page.waitForTimeout(250);
await page.locator('[data-sync-shard="gallery"]').click();
await page.waitForTimeout(250);
await page.locator('[data-field="sync-user"]').fill("");
await page.locator('[data-field="sync-pass"]').fill("");
await page.locator('[data-field="sync-dir"]').fill("待办工作台");
await page.locator('[data-field="sync-dir"]').press("Enter");
await page.waitForTimeout(400);
const st4 = await shardState();
check("恢复成只勾待办", st4.tasks === true && st4.gallery === false, JSON.stringify(st4));

console.log("\n8. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
