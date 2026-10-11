/**
 * 列表内拖拽排序。
 *
 * ------------------------------------------------------------------
 * 验的是什么
 * ------------------------------------------------------------------
 * 1. 自定义顺序的分组里能拖，落点就是松手时看到的那个位置（拖动过程实时重排）；
 * 2. 拖完**落库** —— 刷新之后还是这个顺序（不是只在内存里动了一下）；
 * 3. 按日期排的分组里**不给把手** —— 那种分组里拖一下没有意义，
 *    松手它就会被日期排回去；给了把手却拖不动才最让人困惑；
 * 4. 头那个排序开关是真的开关（曾经只改 tooltip、没接到排序上）。
 *
 * ------------------------------------------------------------------
 * 为什么用 pointer 事件而不是 HTML5 draggable
 * ------------------------------------------------------------------
 * HTML5 的 dragstart/drop 在自动化里要合成一整串事件，而且不同浏览器行为
 * 不一。这里的拖拽是 pointerdown + window 上的 pointermove/pointerup，
 * 于是 e2e 用普通的 mouse.down / move / up 就能真拖一遍 —— 验的是用户
 * 真正会走的那条路径，不是专门给测试留的入口。
 *
 * 用法：node tests/task-drag.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import { prepareFreshWithSampleData } from "./_seed-sample-data.mjs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

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
const info = (label, v) =>
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1400, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

console.log("\n0. 准备一个干净的库");
await prepareFreshWithSampleData(page);
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(600);

/* 自己造三条待办：种子数据分布在两个清单里，数量与顺序都不是这里能定的，
   而拖拽要靠"第几条落在第几位"来断言，数据必须先确定下来。 */
console.log("\n1. 造一个专属清单，里面三条待办");
await page.evaluate(async () => {
  const repo = await import("/src/lib/repo.ts");
  const l = await repo.createList("拖拽验证");
  for (const t of ["甲条", "乙条", "丙条"]) {
    await repo.createTask({ title: t, listId: l.id });
  }
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(600);

await page.locator('aside [data-nav^="list:"]').last().click();
await page.waitForTimeout(500);

const rowsOf = (section) => page.locator(`[data-drag-row="${section}"]`);
const titles = (section) =>
  page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const line = el.querySelector("div.truncate");
      return (line ? line.textContent : el.textContent || "").trim();
    });
  }, `[data-drag-row="${section}"]`);

const before = await titles("active");
info("初始顺序", before);
check("清单里有三条待办", before.length === 3, `实际 ${before.length} 条`);

console.log("\n2. 清单视图默认是自定义顺序：有把手");
const handleCount = await page.locator("[data-drag-handle]").count();
check("三条行都有拖拽把手", handleCount === 3, `实际 ${handleCount} 个`);
check(
  "排序开关标着「自定义顺序」",
  (await page.getAttribute("[data-sort-by-date]", "data-sort-by-date")) === "0",
);

console.log("\n3. 把第一条拖到最后");
async function dragTo(fromIdx, toY) {
  const handle = rowsOf("active").nth(fromIdx).locator("[data-drag-handle]");
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  // 中途多走几步：pointermove 是落点的唯一来源，一步跳过去也能中，
  // 但那样验不到"跟手"这件事
  await page.mouse.move(hb.x + hb.width / 2, toY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

const boxes = [];
for (let i = 0; i < 3; i++) boxes.push(await rowsOf("active").nth(i).boundingBox());
// 最后一行的中点再往下一点 —— 越过它的中线，落点才是"排到最后"
await dragTo(0, boxes[2].y + boxes[2].height * 0.75);

const after = await titles("active");
info("拖完的顺序", after);
check(
  "被拖的那条排到了最后",
  after[after.length - 1] === before[0],
  `${before[0]} 应该在最后，实际 ${JSON.stringify(after)}`,
);
check("另外两条相对顺序不变", after[0] === before[1] && after[1] === before[2], JSON.stringify(after));

console.log("\n4. 落库了：刷新之后还是这个顺序");
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(600);
await page.locator('aside [data-nav^="list:"]').last().click();
await page.waitForTimeout(500);
const afterReload = await titles("active");
info("刷新后顺序", afterReload);
check("刷新后顺序不变", JSON.stringify(afterReload) === JSON.stringify(after), JSON.stringify(afterReload));

console.log("\n5. 「全部」默认按日期排：不给把手");
await page.locator('aside [data-nav="all"]').click();
await page.waitForTimeout(600);
check(
  "全部视图默认按日期排",
  (await page.getAttribute("[data-sort-by-date]", "data-sort-by-date")) === "1",
);
const allHandles = await page.locator("[data-drag-handle]").count();
check("按日期排时没有把手", allHandles === 0, `实际 ${allHandles} 个`);

console.log("\n6. 切到自定义顺序，把手出现（开关真的接上了）");
await page.locator("[data-sort-by-date]").click();
await page.waitForTimeout(500);
check(
  "开关切到自定义顺序",
  (await page.getAttribute("[data-sort-by-date]", "data-sort-by-date")) === "0",
);
const afterToggle = await page.locator("[data-drag-handle]").count();
info("切完之后把手数", afterToggle);
check("切完就有把手了", afterToggle > 0, `实际 ${afterToggle} 个`);

console.log("\n7. 拖到一半松手（落在原地）不该改动顺序");
const beforeNoop = await titles("active");
const b0 = await rowsOf("active").nth(0).boundingBox();
await dragTo(0, b0.y + 4); // 就在原地附近
const afterNoop = await titles("active");
check("原地松手顺序不变", JSON.stringify(afterNoop) === JSON.stringify(beforeNoop), JSON.stringify(afterNoop));

console.log("\n8. 控制台");
check("全程没有控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f);
}

await browser.close();
process.exit(failed ? 1 : 0);
