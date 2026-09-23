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
check("填完账号后提示消失了（说明配置判定认了这份配置）", (await page.locator("[data-sync-hint]").count()) === 0);
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

console.log("\n8. 换后端：OneDrive 该只问该问的，注册指引要能照做");
const providerState = async () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-sync-provider]")].map((el) => [
        el.getAttribute("data-sync-provider"),
        el.getAttribute("data-on") === "1",
      ]),
    ),
  );

let pv = await providerState();
info("后端选项", pv);
check("两个后端都在（坚果云 / OneDrive）", Object.keys(pv).length === 2, Object.keys(pv).join(","));
check("默认还是坚果云 WebDAV（老用户不受新后端影响）", pv.webdav === true, JSON.stringify(pv));
check("OneDrive 没被默认选中", pv.onedrive === false);

await page.locator('[data-sync-provider="onedrive"]').click();
await page.waitForTimeout(400);
pv = await providerState();
check("点一下就切过去了", pv.onedrive === true && pv.webdav === false, JSON.stringify(pv));
check("出现了 OneDrive 的字段区", (await page.locator("[data-sync-onedrive]").count()) === 1);
check("WebDAV 的账号框收起来了（不该再要坚果云的账号）", (await page.locator('[data-field="sync-user"]').count()) === 0);
check("服务器地址框也收起来了", (await page.locator('[data-field="sync-base"]').count()) === 0);
check("换成要「Azure 客户端 ID」", (await page.locator('[data-field="onedrive-client"]').count()) === 1);

const odText = (await page.locator("[data-settings]").innerText()) || "";
check("说清了数据放在 OneDrive 的「应用」文件夹", odText.includes("Apps") && odText.includes("应用"), "");
check(
  "提醒了网页版看不到那个文件夹是正常的",
  odText.includes("网页版默认不显示") || odText.includes("只有这个应用看得到"),
);
check("点了 client_id 不是密钥这件事（免得用户以为是敏感信息不敢填）", odText.includes("不是密钥"));

const guide = page.locator("[data-onedrive-guide]");
check("有可折叠的注册指引", (await guide.count()) === 1);
// <details> 默认是收着的：innerText 只会给出 summary 那一行。
// 先点开再读 —— 顺带把「指引点得开」这件事也验了。
await guide.locator("summary").click();
await page.waitForTimeout(300);
check("指引点得开", await guide.evaluate((el) => el.open === true));
const guideText = (await guide.innerText()) || "";
check("指引里点了 Azure 门户", guideText.includes("portal.azure.com"), guideText.slice(0, 80));
check("说清了重定向 URI 要勾 http://localhost（勾了就不必为端口操心）", guideText.includes("http://localhost"));
check("点明了最小权限 Files.ReadWrite.AppFolder", guideText.includes("Files.ReadWrite.AppFolder"));
check("提醒了「允许公共客户端流」要开，否则报 unauthorized_client", guideText.includes("公共客户端") && guideText.includes("unauthorized_client"));
check("说清了要选「个人 Microsoft 帐户」那一项，否则个人版登不进", guideText.includes("个人 Microsoft 帐户"));

const signin = page.locator("[data-onedrive-signin]");
check("「连接 OneDrive」按钮在", (await signin.count()) === 1);
check("还没填客户端 ID 时按钮是灰的", await signin.isDisabled());
check(
  "灰的原因写了（先填客户端 ID）",
  ((await page.locator("[data-sync-hint]").innerText()) || "").includes("客户端 ID"),
  (await page.locator("[data-sync-hint]").innerText()) || "",
);

await page.locator('[data-field="onedrive-client"]').fill("11111111-2222-3333-4444-555555555555");
await page.locator('[data-field="onedrive-client"]').press("Enter");
await page.waitForTimeout(500);
check("填了 ID 后仍然不给点（演示模式开不了本地端口收回调）", await signin.isDisabled());
check(
  "提示换成了「去点连接」",
  ((await page.locator("[data-sync-hint]").innerText()) || "").includes("连接 OneDrive"),
  (await page.locator("[data-sync-hint]").innerText()) || "",
);
await shot("43-sync-onedrive");

// 刷新后后端选择与 ID 都要在 —— 光切不存等于每次开机都要重选
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
await openSync();
pv = await providerState();
check("刷新后仍然是 OneDrive", pv.onedrive === true, JSON.stringify(pv));
check(
  "客户端 ID 存下来了",
  (await page.locator('[data-field="onedrive-client"]').inputValue()) === "11111111-2222-3333-4444-555555555555",
);

console.log("\n9. 来回切后端不该有成本（另一边的配置不许被清掉）");
await page.locator('[data-sync-provider="webdav"]').click();
await page.waitForTimeout(400);
pv = await providerState();
check("切回坚果云后选中态跟上了", pv.webdav === true && pv.onedrive === false, JSON.stringify(pv));
check("账号框回来了", (await page.locator('[data-field="sync-user"]').count()) === 1);
check("OneDrive 字段区收起来了", (await page.locator("[data-sync-onedrive]").count()) === 0);

await page.locator('[data-sync-provider="onedrive"]').click();
await page.waitForTimeout(400);
check(
  "再切回 OneDrive，客户端 ID 还在（这才叫「来回切成本为零」）",
  (await page.locator('[data-field="onedrive-client"]').inputValue()) === "11111111-2222-3333-4444-555555555555",
);

// 收尾：把后端恢复成默认的坚果云，别给共用同一浏览器 profile 的套件留脏状态。
// 客户端 ID 留着无妨（它有值也连不上，因为演示模式点不了「连接」）。
await page.locator('[data-sync-provider="webdav"]').click();
await page.waitForTimeout(400);
pv = await providerState();
check("收尾恢复成坚果云 WebDAV", pv.webdav === true, JSON.stringify(pv));

console.log("\n10. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
