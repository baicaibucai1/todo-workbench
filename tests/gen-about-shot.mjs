/**
 * 单独抓「设置 → 关于」的截图，用来核对作者标注与底部题记。
 * 顺手把关于页的文本打出来，方便肉眼确认。
 *
 * 用法：node tests/gen-about-shot.mjs   （dev server 需在 1420）
 */

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:1420/";

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({
  viewport: { width: 1500, height: 940 },
  deviceScaleFactor: 1.5,
});
const page = await context.newPage();

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(1000);
await page.locator('aside[data-sidebar-width] [data-nav="settings"]').first().click();
await page.waitForTimeout(500);
await page.locator('[data-section="about"]').click();
await page.waitForTimeout(600);

const text = await page.locator("[data-settings]").innerText();
console.log("关于页文本：");
console.log(text.split("\n").filter(Boolean).join("\n"));

await page.screenshot({ path: path.resolve("docs/screenshots/about.png") });
console.log("\n已写 docs/screenshots/about.png");
await browser.close();