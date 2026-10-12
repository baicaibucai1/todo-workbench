/**
 * 侧栏排序（`behavior.sidebarOrder`）。
 *
 * 验的是「左侧那一列能不能按用户的意思排」这件事的**可见结果**：
 * 设置页里看到的顺序 == 左侧栏真实顺序、改完立刻生效、刷新后还在、
 * 恢复默认回到原样。
 *
 * ★ 侧栏是**三段结构**：智能视图 / 工具 / 清单，段与段不互通。
 *   能改的是段**内**的先后，不能把清单拖进工具段中间 ——
 *   一项"是什么"是它自己的属性，不该由排序决定（混排的后果就是
 *   清单看着像工具组的一截）。所以这里守住「段边界」。
 *
 * 两条**不能改坏**的既有约束也在这儿守着：
 *   · 「图床」紧挨在「设置」正上方（browser.mjs 也有一条，这里再看一遍，
 *     因为把位置区挪进排序流是最容易犯的改法）；
 *   · 侧栏里每一行只出现一次（排序是重排，不是复制）。
 *
 * 数据：自己种一份「新装 + 示例数据」（prepareFreshWithSampleData），
 * 所以不依赖别的套件留下什么；它开头会清库，排在 _run-all-e2e.mjs 最后。
 */

import { createRequire } from "node:module";
import { prepareFreshWithSampleData } from "./_seed-sample-data.mjs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const BASE = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "http://127.0.0.1:1420/";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? "  ← " + detail : ""}`);
  }
}

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const keys = async () => {
  const raw = await page
    .locator("aside[data-sidebar-width] [data-sidebar-order]")
    .first()
    .getAttribute("data-sidebar-order");
  return (raw || "").split(",").filter(Boolean);
};

/** 打开设置 → 行为偏好，并等「侧栏顺序」那一块渲染出来 */
async function openBehavior() {
  await page.locator('aside[data-sidebar-width] [data-nav="settings"]').first().click();
  await page.waitForSelector('[data-settings=""] [data-section="behavior"]', { timeout: 10000 });
  await page.locator('[data-section="behavior"]').click();
  await page.waitForSelector('[data-sidebar-order-list="nav"]', { timeout: 10000 });
  await page.waitForTimeout(300);
}

/** 某一组里列出的行；段名就是键前缀（nav / tool / list） */
const settingRows = (kind) =>
  page
    .locator(`[data-sidebar-order-list="${kind}"] [data-sidebar-order-row]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-sidebar-order-row")));

console.log("\n1. 准备（新装 + 示例数据）");
const prepared = await prepareFreshWithSampleData(page);
check("库已准备成「新装 + 示例数据」", prepared === "ok", prepared);
await page.waitForTimeout(800);

// 上一轮（或手改设置）可能留着一份顺序，先恢复默认，免得"默认顺序"那几条
// 断言验的其实是别人的残留。
await openBehavior();
await page.locator('[data-act="sidebar-order-reset"]').click();
await page.waitForTimeout(500);
await page.locator('[data-act="close-settings"]').click();
await page.waitForTimeout(600);

console.log("\n2. 默认顺序 = 各来源各排（视图 → 工具 → 清单）");
const k0 = await keys();
console.log(`    ${k0.join(",")}`);
check("读得到侧栏顺序口径", k0.length > 0, k0.join(","));
check("第一项是智能视图", k0[0]?.startsWith("nav:"), k0[0]);
check("清单在最后一段", k0.some((k) => k.startsWith("list:")), k0.join(","));
const t0 = k0.findIndex((k) => k.startsWith("tool:"));
const l0 = k0.findIndex((k) => k.startsWith("list:"));
check("顺序是 视图 → 工具 → 清单", t0 > 0 && l0 > t0, `tool@${t0} list@${l0}`);
// 「位置」类（图床 / 工作区）不参与排序：它固定在侧栏最底部
check("默认顺序里没有 place:", !k0.some((k) => k.startsWith("place:")));

console.log("\n3. 设置页按三段分开列，且与左侧栏逐行对得上");
await openBehavior();
const navRows = await settingRows("nav");
const toolRows = await settingRows("tool");
const listRows = await settingRows("list");
console.log(`    视图(${navRows.length}) 工具(${toolRows.length}) 清单(${listRows.length})`);
check("三段都列出了行", navRows.length > 0 && toolRows.length > 0 && listRows.length > 0);
check("每段只含本段类型", [
  navRows.every((k) => k.startsWith("nav:")),
  toolRows.every((k) => k.startsWith("tool:")),
  listRows.every((k) => k.startsWith("list:")),
].every(Boolean), `${navRows} | ${toolRows} | ${listRows}`);
check(
  "三段的拼接 == 左侧栏真实顺序",
  [...navRows, ...toolRows, ...listRows].join(",") === k0.join(","),
  k0.join(","),
);

console.log("\n4. 段内下移第一项 → 立刻生效且刷新后还在");
await page
  .locator('[data-sidebar-order-list="nav"] [data-sidebar-order-row] [data-act="sidebar-down"]')
  .first()
  .click();
await page.waitForTimeout(700);
const k1 = await keys();
check("前两项互换", k1[0] === k0[1] && k1[1] === k0[0], `${k1.slice(0, 2).join(",")}`);
check("项数不变", k1.length === k0.length, `${k1.length} vs ${k0.length}`);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("aside[data-sidebar-width]", { timeout: 15000 });
await page.waitForTimeout(1200);
const k2 = await keys();
check("刷新后顺序不变（真的落库了）", k2.join(",") === k1.join(","), k2.join(","));

console.log("\n5. 段边界：清单顶不到工具段里去");
await openBehavior();
const listKeys = await settingRows("list");
const firstList = listKeys[0];
const toolCount = (await settingRows("tool")).length;
// 连点上移（次数远超需要），它最多停在清单段第一位
for (let i = 0; i < toolCount + 4; i++) {
  const btn = page.locator(
    `[data-sidebar-order-row="${firstList}"] [data-act="sidebar-up"]`,
  );
  if (await btn.isDisabled()) break;
  await btn.click();
  await page.waitForTimeout(320);
}
await page.waitForTimeout(500);
const kB = await keys();
console.log(`    ${kB.join(",")}`);
const firstListPos = kB.indexOf(firstList);
const lastToolPos = kB.reduce((a, k, i) => (k.startsWith("tool:") ? i : a), -1);
check("清单段第一位仍是清单", kB[firstListPos]?.startsWith("list:"), kB[firstListPos]);
check(
  "没有清单跑到工具段之前",
  lastToolPos >= 0 && firstListPos > lastToolPos,
  `末个工具@${lastToolPos} 首个清单@${firstListPos}`,
);
check("上移到头后按钮禁用", await page
  .locator(`[data-sidebar-order-row="${firstList}"] [data-act="sidebar-up"]`)
  .isDisabled());
check("项数不变", kB.length === k0.length, `${kB.length}`);

console.log("\n6. 恢复默认");
await openBehavior();
await page.locator('[data-act="sidebar-order-reset"]').click();
await page.waitForTimeout(700);
const k3 = await keys();
check("恢复后 == 最初的默认顺序", k3.join(",") === k0.join(","), k3.join(","));

console.log("\n7. 既有约束没被改坏");
await page.locator('[data-act="close-settings"]').click();
await page.waitForTimeout(600);
const navs = await page
  .locator("aside[data-sidebar-width] [data-nav]")
  .evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));
const gi = navs.indexOf("imagebed");
const si = navs.indexOf("settings");
check("图床与设置都在侧边栏", gi !== -1 && si !== -1, navs.join(","));
check("图床紧挨在设置上面", gi !== -1 && si === gi + 1, `图床@${gi} 设置@${si}`);

const txt = await page.locator("aside[data-sidebar-width]").innerText();
const dup = (n) => txt.split("\n").filter((l) => l.trim() === n).length;
check("「新建列表」只出现一次", dup("新建列表") === 1, `x${dup("新建列表")}`);
check("「工具」标题只出现一次", dup("工具") <= 1, `x${dup("工具")}`);

console.log("\n8. 控制台无报错");
check("没有运行时报错", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failures.length) console.log("失败项：" + failures.join("、"));

await browser.close();
process.exit(failed ? 1 : 0);
