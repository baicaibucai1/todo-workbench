/**
 * 助手的**沙箱与注入组件**验证（浏览器真跑，不需要连任何模型）。
 *
 * ------------------------------------------------------------------
 * 这个套件补的是 tests/agent.mjs 补不了的那一块
 * ------------------------------------------------------------------
 * 沙箱的核心是"把候选 HTML 真的放进 iframe 跑一遍"，而这件事
 * **只能在真浏览器里验** —— 单测跑在 jsdom 里，jsdom 不执行 iframe 中的脚本
 * （agent-unit 第 10 段专门断言了"它会如实说跑不了"）。
 * 所以这里验的是那条链路上最要紧的三件事：
 *
 *   1. 干净的工具 → 真跑过（报告里有耗时）、发了通行证
 *   2. 会报错的工具 → **没发通行证**，且报告里写清报的是什么错
 *   3. 没有通行证 → install_tool 被拒在**写盘之前**
 *
 * ------------------------------------------------------------------
 * 注入组件为什么靠一个夹具
 * ------------------------------------------------------------------
 * 浏览器演示模式装不了工具（没有可写的文件系统），于是"工具嵌进待办详情"
 * 这件事在浏览器里本来没有可注入的对象。`?fixtureTools=1` 在 dev 下把
 * tests/fixtures/tools/ 里的夹具灌进注册表（见 lib/tools.ts 的说明，
 * 三重闸门，打包后这段整段不成立）。夹具会调 `task.get` 并把标题显示出来，
 * 于是"注入组件真的读到了它挂着的那条待办"这件事**能被断言**，
 * 而不是只能看一眼"有个框"。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/agent-sandbox.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = (ui !== -1 ? argv[ui + 1] : "http://localhost:1420/") + "?fixtureTools=panel-demo";

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
function section(t) {
  console.log(`\n${t}`);
}

/* ---------- 假模型 ---------- */

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const textReply = (t) => () => [{ choices: [{ delta: { content: t } }] }];

/**
 * 模型用**文本通道**发动作，源码另起一个 ```html 块。
 *
 * 这是真机上的形态（整份 HTML 塞进 JSON 参数极易转义坏），
 * 所以这里照着真机走，顺便把 htmlFromBlocks 那条路也验了。
 */
const fenced = (tool, args, html, prose = "") => () => [
  {
    choices: [
      {
        delta: {
          content:
            `${prose}\n\n\`\`\`workbench\n${JSON.stringify({ tool, args })}\n\`\`\`\n` +
            (html ? `\n\`\`\`html\n${html}\n\`\`\`\n` : ""),
        },
      },
    ],
  },
];

/* ---------- 源码样本 ---------- */

/** 干净：自包含、有可见内容、会调一次桥接 */
const GOOD = [
  "<html><head><meta charset='utf-8'><style>body{font:14px system-ui;padding:12px}</style></head><body>",
  "<h1>加班记录</h1><div id='out'>等宿主上下文</div>",
  "<script>",
  'try{parent.postMessage({source:"workbench-tool",type:"tool:request",id:"r1",op:"kv.get",payload:{key:"a"}},"*");}catch(e){}',
  "document.getElementById('out').textContent='已就绪';",
  "</script></body></html>",
].join("");

/** 一进来就往控制台报错 —— 装上去用户看到的就是"点什么都没反应" */
const THROWS = [
  "<html><body><h1>坏工具</h1><script>",
  "console.error('读不到配置：undefined is not an object');",
  "</script></body></html>",
].join("");

/** 什么都没渲染：典型的"打开就是白屏" */
const BLANK = "<html><body></body></html>";

/** 用 row.* 却没声明表 */
const ROWS_NO_SCHEMA =
  "<html><body><h1>记账</h1><script>call('row.insert',{table:'recs',row:{}})</script></body></html>";

/* ---------- 启动 ---------- */

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const queue = [];
await page.route("**/chat/completions", async (route) => {
  const step = queue.shift();
  const events = (step ?? textReply("（队列空了）"))();
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: sse(events),
  });
});

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(600);

/* ---------- 界面操作的小工具 ---------- */

const gotoAgent = async () => {
  if ((await page.locator("[data-agent-window]").count()) === 0) {
    await page.locator("[data-agent-ball]").click();
  }
  await page.waitForSelector("[data-agent]", { timeout: 20000 });
  await page.waitForTimeout(300);
};

const waitIdle = async () => {
  await page.waitForFunction(() => !document.querySelector("[data-agent-stop]"), null, { timeout: 40000 });
  await page.waitForTimeout(250);
};

const send = async (text) => {
  await page.locator("[data-agent-input]").fill(text);
  await page.locator("[data-agent-send]").click();
  await page.waitForTimeout(400);
};


/** 等 iframe 里的某个属性变成期望值（getAttribute 不会等，只能自己轮询） */
const waitAttr = async (scope, sel, attr, want, ms = 12000) => {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await scope.frameLocator("iframe").locator(sel).getAttribute(attr).catch(() => null);
    if (last === want) return last;
    await page.waitForTimeout(300);
  }
  return last;
};

/** 动作卡上的"看细节"里那一段（折叠着也能读，用 textContent） */
const cardDetail = async (tool) => {
  const card = page.locator(`[data-agent-action="${tool}"]`).last();
  return (await card.locator("pre").first().textContent()) ?? "";
};
const cardOk = async (tool) =>
  (await page.locator(`[data-agent-action="${tool}"]`).last().getAttribute("data-agent-action-ok")) === "1";
/** 动作卡上可见的整段文字（含红色错误行） */
const cardText = async (tool) =>
  (await page.locator(`[data-agent-action="${tool}"]`).last().innerText()) ?? "";

/* ================================================================== */
section("1. 配置助手（地址填假，路由拦掉 —— 这个套件永不碰真接口）");
/* ================================================================== */

{
  await gotoAgent();
  await page.locator("[data-agent-settings]").click();
  await page.waitForSelector("[data-settings]", { timeout: 20000 });
  await page.locator('[data-section="ai"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-field="agent-base-url"]').fill("https://mock.local/v1");
  await page.locator('[data-field="agent-key"]').fill("sk-mock-key");
  await page.locator('[data-field="agent-key"]').press("Tab");
  await page.locator('[data-field="agent-model"]').fill("mock-model");
  await page.locator('[data-field="agent-model"]').press("Tab");
  await page.waitForTimeout(400);
  await page.locator('button[data-act="close-settings"]').click();
  await page.waitForTimeout(300);
  await gotoAgent();
  check("配置齐了，门槛卡消失", (await page.locator("[data-agent-gate]").count()) === 0);
}

/* ================================================================== */
section("2. 沙箱：干净的源码真跑一遍并发通行证");
/* ================================================================== */

let TICKET = "";
{
  queue.push(
    fenced("sandbox_run", { id: "overtime-log", name: "加班记录" }, GOOD, "我先把它放进沙箱跑一遍。"),
    textReply("跑通了，现在装进去。"),
  );
  await send("做一个记录加班时长的工具");
  await page.waitForSelector('[data-agent-action="sandbox_run"]', { timeout: 40000 });
  await waitIdle();

  check("出现了一张沙箱试跑的动作卡", (await page.locator('[data-agent-action="sandbox_run"]').count()) >= 1);
  const detail = await cardDetail("sandbox_run");
  info("试跑报告", detail.slice(0, 400));

  check("它真的跑起来了（报告里有耗时，不是「没跑」）", /试跑：\d+ ms/.test(detail), detail.slice(0, 120));
  check("渲染出了可见内容", detail.includes("渲染：有可见内容"), detail.slice(0, 200));
  check("记下了它调过的桥接", detail.includes("kv.get"), detail.slice(0, 300));
  check("通过并发了通行证", /通行证：v1\./.test(detail), detail.slice(0, 300));

  TICKET = /通行证：(v1\.\S+)/.exec(detail)?.[1] ?? "";
  check("通行证能被取出来（下一步要带进 install_tool）", /^v1\./.test(TICKET), TICKET);
}

/* ================================================================== */
section("3. 通行证门：没票拒在写盘之前，有票才走到写盘");
/* ================================================================== */

{
  // ---- 没票 ----
  queue.push(fenced("install_tool", { id: "overtime-log", name: "加班记录" }, GOOD, "直接装。"), textReply("装好了。"));
  await send("直接装，别验了");
  await page.waitForSelector('[data-agent-action="install_tool"]', { timeout: 40000 });
  await waitIdle();

  check("没票时动作卡是失败的", (await cardOk("install_tool")) === false);
  const err = await cardText("install_tool");
  info("拒的原因", err);
  check("拒的原因点名 sandbox_run（告诉它下一步该做什么）", err.includes("sandbox_run"), err);
  check("不是「浏览器装不了」那句 —— 那是再往后一步才遇到的", !err.includes("浏览器演示模式"), err);

  // ---- 有票（浏览器装不了，但**必须走到那一步**才证明门票生效）----
  queue.push(
    fenced("install_tool", { id: "overtime-log", name: "加班记录", ticket: TICKET }, GOOD, "带票装。"),
    textReply("这个环境装不了。"),
  );
  await send("带票再装一次");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-agent-action="install_tool"]').length >= 2,
    null,
    { timeout: 40000 },
  );
  await waitIdle();

  const err2 = await cardText("install_tool");
  info("带票之后", err2);
  check("带真票才走到写盘那一步（本机是浏览器，到此为止）", err2.includes("浏览器演示模式"), err2);
  check("票对得上就没有再提通行证", !err2.includes("通行证"), err2);
}

/* ================================================================== */
section("4. 沙箱：会报错 / 白屏 / 声明对不上，一律不发通行证");
/* ================================================================== */

{
  const runAndRead = async (html, args = {}) => {
    queue.push(
      fenced("sandbox_run", { id: "bad-tool", name: "坏工具", ...args }, html, "再验一遍。"),
      textReply("没过。"),
    );
    const before = await page.locator('[data-agent-action="sandbox_run"]').count();
    await send("改好了，再验一遍");
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-agent-action="sandbox_run"]').length > n,
      before,
      { timeout: 40000 },
    );
    await waitIdle();
    return cardDetail("sandbox_run");
  };

  const before = await page.locator('[data-agent-action="sandbox_run"]').count();

  // 一进来就 console.error
  let d = await runAndRead(THROWS);
  info("报错那份的报告", d.slice(0, 400));
  check("运行时报错被抓出来了", d.includes("SANDBOX_ERROR"), d.slice(0, 300));
  check("报错时**没有**发通行证（不许带着错装上去）", !d.includes("通行证"), d.slice(0, 300));
  check("报告里写了具体是什么错", d.includes("console.error"), d.slice(0, 300));

  // 白屏
  d = await runAndRead(BLANK);
  info("白屏那份的报告", d.slice(0, 300));
  check("什么都没渲染被判成硬伤", d.includes("BLANK"), d.slice(0, 300));
  check("白屏也不发票", !d.includes("通行证"), d.slice(0, 300));

  // 用了 row.* 却没声明表 —— 静态体检就该拦下，连跑都不必跑
  d = await runAndRead(ROWS_NO_SCHEMA);
  info("没声明表那份的报告", d.slice(0, 300));
  check("用了 row.* 却没声明表 → 静态体检就拦下", d.includes("ROW_WITHOUT_SCHEMA"), d.slice(0, 300));

  check("四次试跑都留下了动作卡（没执行就是没执行，但**有痕迹**）", (await page.locator('[data-agent-action="sandbox_run"]').count()) === before + 3);
}

/* ================================================================== */
section("5. 注入组件：工具嵌进待办详情，并真的读到那条待办");
/* ================================================================== */

{
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await page.locator('aside [data-nav="all"]').click();
  await page.waitForTimeout(400);

  const TITLE = "注入组件验证任务";
  await page.locator('input[placeholder="添加任务"]').fill(TITLE);
  await page.locator('input[placeholder="添加任务"]').press("Enter");
  await page.waitForTimeout(600);

  // 演示库里自带几条示例待办，"第一行"不是我们刚建的那条 —— 按标题定位
  await page.locator("[data-task-id]").filter({ hasText: TITLE }).first().locator("div.truncate").first().click();
  await page.waitForSelector("[data-task-detail]", { timeout: 20000 });
  await page.waitForTimeout(500);

  // ---- 详情分区 ----
  const sec = page.locator('[data-inject-section="panel-demo"]');
  check("详情面板底部出现了工具注入的分区", (await sec.count()) === 1, String(await sec.count()));
  check("分区里有 iframe（它就是那个组件）", (await sec.locator("iframe").count()) === 1);

  /*
    最关键的一条：**组件真的读到了它挂着的那条待办**。
    夹具收到 tool:context 后调 task.get，拿到标题才把 data-bind-state 置为 bound ——
    所以断言的是"宿主 → 桥 → 组件"整条链路，而不是"这里有个框"。
  */
  const bodyState = await waitAttr(sec, "body", "data-bind-state", "bound");
  check("组件拿到了自己挂在哪（tool:context 里有 inject）", bodyState !== null, String(bodyState));
  check("组件读到了那条待办（task.get 端到端通了）", bodyState === "bound", String(bodyState));

  const shown = await sec.frameLocator("iframe").locator("#title").textContent();
  check("它显示的正是这一条的标题", (shown ?? "").includes(TITLE), String(shown));
  const kind = await sec.frameLocator("iframe").locator("#kind").textContent();
  check("它知道自己挂在 detailSection 上", (kind ?? "").includes("detailSection"), String(kind));

  await page.screenshot({ path: `${SHOT_DIR}/inject-detail.png` });

  // ---- 详情头部的按钮 ----
  const headBtn = page.locator('[data-inject-action="panel-demo"][data-inject-kind="detailAction"]');
  check("详情头部有注入的按钮", (await headBtn.count()) === 1);
  await headBtn.click();
  await page.waitForSelector('[data-inject-panel="panel-demo"]', { timeout: 10000 });
  check("点开是一个装着组件的面板", (await page.locator('[data-inject-panel="panel-demo"] iframe').count()) === 1);
  await page.locator("[data-inject-close]").first().click();
  await page.waitForTimeout(200);
  check("收起后面板关掉", (await page.locator('[data-inject-panel="panel-demo"]').count()) === 0);

  // ---- 行内按钮 ----
  const rowBtn = page.locator('[data-inject-action="panel-demo"][data-inject-kind="rowAction"]').first();
  check("列表行上有注入的按钮", (await rowBtn.count()) >= 1);
  await rowBtn.click();
  await page.waitForSelector('[data-inject-panel="panel-demo"]', { timeout: 10000 });
  // textContent 不会等 —— 先等它把状态置成 bound（那说明上下文已到、task.get 也回了），
  // 再去读它显示的东西，否则读到的永远是初始那句"等上下文"
  const rowState = await waitAttr(page.locator('[data-inject-panel="panel-demo"]'), "body", "data-bind-state", "bound");
  check("行里点开的那个组件同样读到了那条待办", rowState === "bound", String(rowState));
  const rowKind = await page
    .locator('[data-inject-panel="panel-demo"]')
    .frameLocator("iframe")
    .locator("#kind")
    .textContent()
  check("行里点开的那个组件知道自己挂在 rowAction 上", (rowKind ?? "").includes("rowAction"), String(rowKind));

  check("全程没有页面级报错", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: `${SHOT_DIR}/inject-row.png` });
}

/* ================================================================== */
section("汇总");
/* ================================================================== */

console.log("\n====================================================");
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log("====================================================");
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}

await browser.close();
process.exit(failed ? 1 : 0);
