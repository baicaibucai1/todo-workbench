/**
 * 真实浏览器渲染验证。
 *
 * 目的：在 Chromium 里真正加载应用，确认 React 能挂载、界面无运行时错误、
 * 关键交互（新增任务 / 切换视图 / 打开工具）真的可用。
 *
 * 依赖 QQbot 项目里已安装的 playwright，避免重复下载浏览器。
 */

import { createRequire } from "node:module";

// playwright 装在隔壁 QQbot 项目里，直接复用，避免重复下载 Chromium。
// 它是 CJS 包，用 createRequire 引入才能拿到具名导出。
const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

// 直接用本机 Edge 而不是 Playwright 自带的 Chromium：
// 一来不必额外下载浏览器，二来 Edge 与 Tauri 在 Windows 上使用的 WebView2 同源，
// 验证结果更贴近打包后的真实运行环境。
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const BASE = "http://localhost:1420/";

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

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });

// 侧边栏里的条目。带计数角标的项，可访问名称会变成「全部 6」，
// 所以用按钮内首个文本节点做精确匹配，而不是整名字符串相等。
const navItem = (name) => page.locator("aside button").filter({ hasText: name }).first();

// 收集控制台错误与页面异常，这是发现运行时问题的关键
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

console.log("\n1. 页面加载");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

check("标题正确", (await page.title()) === "待办工作台");
check("应用已挂载（非空白页）", (await page.locator("aside").count()) > 0);
check(
  "无控制台错误",
  errors.length === 0,
  errors.slice(0, 3).join(" | "),
);

console.log("\n2. 侧边栏");
const sidebarText = await page.locator("aside").innerText();
check("显示我的一天", sidebarText.includes("我的一天"));
check("显示重要", sidebarText.includes("重要"));
check("显示计划内", sidebarText.includes("计划内"));
check("显示全部", sidebarText.includes("全部"));
check("显示工具分区", sidebarText.includes("工具"));
check("显示内置图片裁剪工具", sidebarText.includes("图片裁剪"));
check("显示工作列表", sidebarText.includes("工作"));
check("显示个人列表", sidebarText.includes("个人"));
check("显示新建列表入口", sidebarText.includes("新建列表"));
check("显示账户邮箱", sidebarText.includes("name@example.com"));

console.log("\n3. 顶栏状态");
const headerText = await page.locator("body").innerText();
check("显示数据库驱动状态", headerText.includes("内存库") || headerText.includes("SQLite"));
check("显示 schema 版本", headerText.includes("schema v1"));

console.log("\n4. 我的一天视图（默认）");
check("标题为我的一天", (await page.locator("h1").first().innerText()) === "我的一天");
const headerBlock = await page.locator("h1").first().evaluate((el) => el.parentElement.parentElement.innerText);
check("显示日期副标题", /\d+月\d+日,星期/.test(headerBlock), JSON.stringify(headerBlock));
check("存在种子任务 1027 改码发货", headerText.includes("1027 改码发货"));
check("显示底部添加任务输入框", (await page.getByPlaceholder("添加任务").count()) > 0);
check("显示建议按钮（我的一天专属）", (await page.locator('[title="建议"]').count()) > 0);

console.log("\n5. 新增任务");
const input = page.getByPlaceholder("添加任务");
await input.fill("浏览器测试任务");
await input.press("Enter");
await page.waitForTimeout(500);
const afterAdd = await page.locator("body").innerText();
check("新任务出现在列表中", afterAdd.includes("浏览器测试任务"));
check("输入框已清空", (await input.inputValue()) === "");

console.log("\n6. 完成任务");
const taskRow = page.locator("div.group", { hasText: "浏览器测试任务" }).first();
await taskRow.locator('button[title="标记为已完成"]').click();
await page.waitForTimeout(500);
const afterDone = await page.locator("body").innerText();
check("出现已完成分组", afterDone.includes("已完成"));
check("已完成分组显示计数 1", /已完成\s*1/.test(afterDone), afterDone.match(/已完成.{0,6}/)?.[0] ?? "");

// 展开已完成分组，确认任务确实移入其中
await page.getByText("已完成").first().click();
await page.waitForTimeout(400);
const expanded = await page.locator("body").innerText();
check("展开后可见已完成任务", expanded.includes("浏览器测试任务"));

console.log("\n7. 切换到重要视图");
await navItem("重要").click();
await page.waitForTimeout(500);
check("标题切换为重要", (await page.locator("h1").first().innerText()) === "重要");
check(
  "只显示重要任务",
  (await page.locator("body").innerText()).includes("1027 改码发货"),
);

console.log("\n8. 切换到计划内视图");
await navItem("计划内").click();
await page.waitForTimeout(500);
check("标题切换为计划内", (await page.locator("h1").first().innerText()) === "计划内");
const plannedText = await page.locator("body").innerText();
check("显示日期分组（今天）", plannedText.includes("今天"));

console.log("\n9. 切换到全部视图与列表视图");
await navItem("全部").click();
await page.waitForTimeout(400);
check("标题切换为全部", (await page.locator("h1").first().innerText()) === "全部");

await navItem("个人").click();
await page.waitForTimeout(400);
check("标题切换为个人", (await page.locator("h1").first().innerText()) === "个人");

console.log("\n9b. 列表不重复渲染");
const sidebarText2 = await page.locator("aside").innerText();
const dupCheck = (name) => sidebarText2.split("\n").filter((l) => l.trim() === name).length;
check("工作列表只出现一次", dupCheck("工作") === 1, `出现 ${dupCheck("工作")} 次`);
check("个人列表只出现一次", dupCheck("个人") === 1, `出现 ${dupCheck("个人")} 次`);

console.log("\n10. 搜索（跨列表检索）");
const searchBox = page.getByPlaceholder("搜索");
await searchBox.fill("订单");
await page.waitForTimeout(600);
const searchText = await page.locator("body").innerText();
// 此时页面停在「个人」列表，但「整理本周订单记录」属于「工作」，
// 搜索必须跨列表才能命中——这正是要验证的点
check("跨列表搜索能命中", searchText.includes("整理本周订单记录"));
check("显示搜索结果计数", searchText.includes("条结果"));
check("标题切换为搜索结果", (await page.locator("h1").first().innerText()).startsWith("搜索"));
await searchBox.fill("");
await page.waitForTimeout(500);

console.log("\n11. 新建列表");
await page.getByText("新建列表").click();
await page.waitForTimeout(200);
const listInput = page.getByPlaceholder("列表名称");
await listInput.fill("测试清单");
await listInput.press("Enter");
await page.waitForTimeout(600);
const listText = await page.locator("body").innerText();
check("新列表出现在侧边栏", listText.includes("测试清单"));
check("自动切换到新列表", (await page.locator("h1").first().innerText()) === "测试清单");

console.log("\n12. 工具模块");
await navItem("图片裁剪").click();
await page.waitForTimeout(700);
const toolText = await page.locator("body").innerText();
check("退出待办进入工具页", !(await page.locator("h1").first().isVisible().catch(() => false)));
check("显示工具名", toolText.includes("图片裁剪"));
check("显示浏览器演示模式提示", toolText.includes("浏览器演示模式"));
check("显示工具接入契约", toolText.includes("工具接入契约"));
check("显示 manifest 示例", toolText.includes("manifest.json"));
check("显示数据隔离说明", toolText.includes("数据隔离"));

console.log("\n13. 工具数据库连通性验证");
await page.getByText("建表并写入示例订单").click();
await page.waitForTimeout(900);
const demoText = await page.locator("body").innerText();
check("工具表已创建", demoText.includes("tool_image_crop_orders"));
check("示例订单数据已写入", demoText.includes("SO-20260917-001"));
check("金额格式化正确", demoText.includes("¥1280.50"));

console.log("\n14. 返回待办并确认数据未受影响");
await page.getByText("返回待办").click();
await page.waitForTimeout(600);
check("成功返回待办", await page.locator("h1").first().isVisible());
check("返回后仍在进入工具前的列表", (await page.locator("h1").first().innerText()) === "测试清单");
check("之前新建的列表仍在", (await page.locator("body").innerText()).includes("测试清单"));

// 通过搜索确认已完成的任务没有被工具操作影响（搜索跨列表，不受当前视图限制）
await page.getByPlaceholder("搜索").fill("浏览器测试任务");
await page.waitForTimeout(600);
check(
  "搜索能找回该任务，证明工具未污染待办数据",
  (await page.locator("body").innerText()).includes("浏览器测试任务"),
);
await page.getByPlaceholder("搜索").fill("");
await page.waitForTimeout(500);

console.log("\n15. 数据持久化（刷新页面）");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
const reloadText = await page.locator("body").innerText();
check("刷新后列表仍在", reloadText.includes("测试清单"));
check("刷新后未完成任务仍在", reloadText.includes("1027 改码发货"));

// 完成任务后刷新，应从「我的一天」消失（To Do 的既有行为），但数据不能丢
await page.getByPlaceholder("搜索").fill("浏览器测试任务");
await page.waitForTimeout(600);
check(
  "刷新后已完成任务可通过搜索找回",
  (await page.locator("body").innerText()).includes("浏览器测试任务"),
);

console.log("\n16. 无累积运行时错误");
check(
  "全程无控制台错误",
  errors.length === 0,
  errors.slice(0, 5).join(" | "),
);

await browser.close();

console.log(`\n${"=".repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(52));

process.exit(failed ? 1 : 0);
