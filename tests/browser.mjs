/**
 * 真实浏览器渲染验证。
 *
 * 目的：在 Chromium 里真正加载应用，确认 React 能挂载、界面无运行时错误、
 * 关键交互（新增任务 / 切换视图 / 打开工具）真的可用。
 *
 * 依赖 QQbot 项目里已安装的 playwright，避免重复下载浏览器。
 */

import { createRequire } from "node:module";
import { prepareFreshWithSampleData } from "./_seed-sample-data.mjs";
import { enableModule } from "./_enable-module.mjs";

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
//
// 两处必须限定：
// - 只认侧边栏那个 aside（详情面板也是 aside）
// - 排除账户按钮：资料没设置时它显示「点击设置个人资料」，
//   用 hasText("个人") 会先命中它，一下把设置面板点开，后面全线崩。
const navItem = (name) =>
  page
    .locator('aside[data-sidebar-width] button:not([data-nav="profile"])')
    .filter({ hasText: name })
    .first();

// 收集控制台错误与页面异常，这是发现运行时问题的关键
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

console.log("\n1. 页面加载");

/*
 * 先把库准备成「新装 + 示例数据开关打开」，再让应用启动。
 *
 * v20 起示例数据是选装、默认关：空库进来干干净净，一个清单都没有。
 * 而本套件后面的跨列表搜索、混排渲染这些断言天然需要一批数据 ——
 * 与其自己造（那验的就不是真实首跑的样子），不如**打开那个开关**，
 * 让应用自己种。顺带这也把"开关真的能让种子跑起来"验在了浏览器里。
 *
 * 具体怎么做（为什么要跑两轮）见 _seed-sample-data.mjs 的文件头。
 */
const prepared = await prepareFreshWithSampleData(page);
check("已准备「新装 + 示例数据」的库", prepared === "ok", prepared);

check("标题正确", (await page.title()) === "待办工作台");
check("应用已挂载（非空白页）", (await page.locator("aside").count()) > 0);
check(
  "无控制台错误",
  errors.length === 0,
  errors.slice(0, 3).join(" | "),
);

console.log("\n2. 侧边栏");
// 详情面板也是 aside，别抓错 —— 侧边栏有专属的 data-sidebar-width 标记
const sidebarText = await page.locator("aside[data-sidebar-width]").innerText();
check("显示我的一天", sidebarText.includes("我的一天"));
check("显示重要", sidebarText.includes("重要"));
check("显示全部", sidebarText.includes("全部"));
check("显示工具分区", sidebarText.includes("工具"));
check("显示内置图片裁剪工具", sidebarText.includes("图片裁剪"));
check("显示工作列表", sidebarText.includes("工作"));
check("显示个人列表", sidebarText.includes("个人"));
check("显示新建列表入口", sidebarText.includes("新建列表"));
// 资料区有两种合法状态：种了默认邮箱（name@example.com），或用户清空过资料
// （显示「点击设置个人资料」占位）—— 快照状态不同，别写死一种
check("显示账户区（邮箱或未设置占位）",
  sidebarText.includes("name@example.com") || sidebarText.includes("点击设置个人资料"));

console.log("\n3. 顶栏（已移除）");
const topText = await page.locator("body").innerText();
// 顶栏整条删掉后，界面里不应再出现标题文案与数据库/schema 徽标
check("顶栏已移除（无标题文案）", !topText.includes("待办工作台"));
check("顶栏已移除（无 schema 徽标）", !topText.includes("schema v"));
// 侧边栏收起后，恢复入口由顶栏按钮改为左上角悬浮按钮 —— 这是唯一入口，必须有
await page.locator('[title="收起侧边栏"]').click();
await page.waitForTimeout(200);
check("侧边栏收起后出现悬浮恢复按钮", (await page.locator("[data-sidebar-reopen]").count()) === 1);
await page.locator("[data-sidebar-reopen]").click();
await page.waitForTimeout(200);
check("点悬浮按钮侧边栏恢复", (await page.locator("aside[data-sidebar-width]").count()) > 0);

console.log("\n4. 我的一天视图（默认）");
check("标题为我的一天", (await page.locator("h1").first().innerText()) === "我的一天");
const headerBlock = await page.locator("h1").first().evaluate((el) => el.parentElement.parentElement.innerText);
check("显示日期副标题", /\d+月\d+日,星期/.test(headerBlock), JSON.stringify(headerBlock));
check("存在种子任务 1027 改码发货", topText.includes("1027 改码发货"));
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

console.log("\n8. 底部区块：图库在设置正上方");
// 「计划内」整个视图已删（侧边栏入口也一起没了），这里顺手守住"它不会再回来"
check("侧边栏不再有计划内", !sidebarText.includes("计划内"));

/*
 * ⚠️ 图库是**选装模块**（v18 起，默认关），侧边栏里默认没有它。
 *
 * 这里原先直接断言"图库与设置都在侧边栏底部"，在选装改版之后就一直是红的
 * —— 而这条红是"没人去按那个开关"，不是功能坏了。修它的正确做法是
 * **先按开关**，而不是把断言删掉或改成"允许没有"：
 * 后两者都会让"图库紧挨设置上面"这个真的会被改坏的顺序约束失去守卫。
 *
 * 用 _enable-module.mjs 走真实界面（它顺带验了"设置页里找得到这个开关"），
 * 然后回到待办视图 —— 启用完人会站在设置页上。
 */
await enableModule(page, "gallery");
await page.locator('aside [data-nav="myday"]').first().click();
await page.waitForTimeout(600);

const bottomNav = await page
  .locator("aside[data-sidebar-width] [data-nav]")
  .evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));
const gi = bottomNav.indexOf("gallery");
const si = bottomNav.indexOf("settings");
console.log(`    · 底部顺序: 图库@${gi} 设置@${si}`);
check("图库与设置都在侧边栏底部", gi !== -1 && si !== -1, bottomNav.join(","));
check("图库紧挨在设置上面", gi !== -1 && si === gi + 1, `${gi} vs ${si}`);

console.log("\n9. 切换到全部视图与列表视图");
await navItem("全部").click();
await page.waitForTimeout(400);
check("标题切换为全部", (await page.locator("h1").first().innerText()) === "全部");

await navItem("个人").click();
await page.waitForTimeout(400);
check("标题切换为个人", (await page.locator("h1").first().innerText()) === "个人");

console.log("\n9b. 列表不重复渲染");
const sidebarText2 = await page.locator("aside[data-sidebar-width]").innerText();
const dupCheck = (name) => sidebarText2.split("\n").filter((l) => l.trim() === name).length;
check("工作列表只出现一次", dupCheck("工作") === 1, `出现 ${dupCheck("工作")} 次`);
check("个人列表只出现一次", dupCheck("个人") === 1, `出现 ${dupCheck("个人")} 次`);

console.log("\n10. 搜索（跨列表检索）");
// 详情面板常驻在 DOM 里（收起只是宽度归零），它也有搜索框 —— 必须圈定侧边栏
const searchBox = page.locator("aside[data-sidebar-width]").getByPlaceholder("搜索");
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
await page.waitForTimeout(900);
const toolText = await page.locator("body").innerText();
check("退出待办进入工具页", !(await page.locator("h1").first().isVisible().catch(() => false)));
check("显示工具名", toolText.includes("图片裁剪"));
// 工具是跑在 iframe 里的**真页面**。
// 契约说明页（「工具接入契约」「manifect.json」「数据隔离」那些）只在
// 入口解析不出来时才兜底显示 —— 工具能正常加载时页面里根本没有这些字，
// 所以这里要验的是"iframe 真的挂上了并且有内容"。
const toolFrames = page.frames().filter((f) => f !== page.mainFrame());
check("工具 iframe 已挂载", toolFrames.length > 0, `frames=${toolFrames.length}`);
const frameHtml = toolFrames.length ? await toolFrames[0].content() : "";
check("工具页面真的载入了内容", frameHtml.length > 200, `${frameHtml.length} 字符`);

console.log("\n14. 返回待办并确认数据未受影响");
await page.getByText("返回待办").click();
await page.waitForTimeout(600);
check("成功返回待办", await page.locator("h1").first().isVisible());
check("返回后仍在进入工具前的列表", (await page.locator("h1").first().innerText()) === "测试清单");
check("之前新建的列表仍在", (await page.locator("body").innerText()).includes("测试清单"));

// 通过搜索确认已完成的任务没有被工具操作影响（搜索跨列表，不受当前视图限制）
//
// 用上面那个已经圈定侧边栏的 searchBox，不用 getByPlaceholder("搜索")：
// 详情面板里还有一个「搜索要关联的任务」，裸写会同时命中两个
// （strict mode 直接报错，而且报得莫名其妙 —— 见第 15 节那处的长注释）。
await searchBox.fill("浏览器测试任务");
await page.waitForTimeout(600);
check(
  "搜索能找回该任务，证明工具未污染待办数据",
  (await page.locator("body").innerText()).includes("浏览器测试任务"),
);
await searchBox.fill("");
await page.waitForTimeout(500);

console.log("\n15. 数据持久化（刷新页面）");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
const reloadText = await page.locator("body").innerText();
check("刷新后列表仍在", reloadText.includes("测试清单"));
check("刷新后未完成任务仍在", reloadText.includes("1027 改码发货"));

// 完成任务后刷新，应从「我的一天」消失（To Do 的既有行为），但数据不能丢
//
// ⚠️ 这里必须圈定侧边栏的那个搜索框：详情面板里还有一个
// 「搜索要关联的任务」（也是 placeholder 含"搜索"），刷新后它就在 DOM 里，
// getByPlaceholder("搜索") 会同时命中两个，strict mode 直接报错。
// 前面几处之所以没炸，是因为那时详情面板还没展开 —— 这种"看运气"的写法
// 迟早会在某次改动后集中爆发，所以这里一次性改成和上面同一套定位。
const searchAfterReload = page
  .locator("aside[data-sidebar-width]")
  .getByPlaceholder("搜索");
await searchAfterReload.fill("浏览器测试任务");
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
