/**
 * 内置 AI 助手的浏览器验证（不需要真的连任何模型）。
 *
 * ------------------------------------------------------------------
 * 这个套件为什么敢说"验完了"
 * ------------------------------------------------------------------
 * 模型那一侧用 page.route 拦掉对话端点（形如 <base>/chat/completions），
 * 返回我们自己拼的 SSE 分片。
 * 于是这里能验的是**真的端到端**：界面把话发出去 → 运行时解析分片 →
 * 动作层执行 → 回灌结果 → 再要一轮 → 落库 → 界面显示。
 *
 * 其中最有价值的一条是：**日程真的进了库**（切到「全部」能看见那条待办）。
 * 只断言"界面上出现了一张成功卡片"是不够的 —— 那正是"它说它做了"和
 * "它真做了"的区别，而这个功能最需要被区分的就是这一点。
 *
 * 第二有价值的是**回灌出去的请求体本身合法**（第 10 段）：模型给的参数串
 * 可能是坏 JSON，那种调用一旦被原样回灌，服务端会 400 掉整次请求，
 * 而界面看起来只是"助手报了个看不懂的接口错误"（2026-09-23 的"做个五子棋"
 * 就卡在这）。这条只能在"拦下来的请求体"这一层断言。
 *
 * ------------------------------------------------------------------
 * 这个套件**验不到**什么
 * ------------------------------------------------------------------
 * 装工具那条路在浏览器里走不通（要写文件系统，演示模式下 isTauri() 为假），
 * 所以这里只能验它会**诚实地拒绝**、并把源码留在动作卡上可复制。
 * 真正落盘 + 装完能打开，得在**打包后的桌面版**里手验
 * （见 tests/agent-unit.mjs 文件头与 tests/desktop-app.mjs 的注释）。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/agent.mjs [--url http://localhost:1420/]
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

/* ---------- 假模型：把自己拼的 SSE 分片喂回去 ---------- */

/** 拼一段 SSE 响应体。刻意**每个事件单独一个 chunk 的空行结尾**，与真接口一致 */
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

/** 模型说一句话 */
const textReply = (t) => () => [{ choices: [{ delta: { content: t } }] }];

/** 模型发起一次原生工具调用（一个分片给全，最省事也最接近"小网关"的行为） */
const toolReply = (name, args) => () => [
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  },
];

/**
 * 模型发来一个**坏 JSON** 的参数串（原样喂进去，不做任何转义）。
 *
 * 真机上的形态：它把整份 HTML 塞进 install_tool 的参数里，字符串里的换行是
 * **真的换行字节**而不是 `\n`。这种串一旦被原样回灌进下一轮请求，
 * 服务端会 400 掉整次请求（"arguments must be valid JSON"）——
 * 2026-09-23 那次"做个五子棋"就卡在这。
 */
const brokenToolReply = (name, rawArgs) => () => [
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: rawArgs } }],
        },
      },
    ],
  },
];

/** 模型不改工具调用，而是把动作写成约定格式的代码块（第二条通道） */
const fencedReply = (tool, args, prose = "") => () => [
  { choices: [{ delta: { content: `${prose}\n\n\`\`\`workbench\n${JSON.stringify({ tool, args })}\n\`\`\`\n` } }] },
];

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });

/* 从空库开始 —— 助手要建的日程、要落的对话，都在这一份干净数据上 */
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(600);

/* 假模型：一个响应队列，用完了就回一句兜底文本 */
const queue = [];
const captured = [];
await page.route("**/chat/completions", async (route) => {
  let body = {};
  try {
    body = JSON.parse(route.request().postData() || "{}");
  } catch {
    body = {};
  }
  captured.push(body);
  const step = queue.shift();
  const events = (step ?? textReply("（队列空了，这是兜底回复）"))();
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: sse(events),
  });
});

const gotoSettings = async (section) => {
  await page.locator("[data-agent-settings]").click();
  await page.waitForSelector("[data-settings]", { timeout: 20000 });
  if (section) await page.locator(`[data-section="${section}"]`).click();
  await page.waitForTimeout(300);
};

/**
 * 打开助手窗口。
 *
 * 入口只有右下角那颗球（2026-09-23 起侧栏那一项去掉了）。球是**开关**，
 * 所以这里先看一眼窗口在不在 —— 不看就点，会把已经开着的窗口关掉。
 */
const gotoAgent = async () => {
  if ((await page.locator("[data-agent-window]").count()) === 0) {
    await page.locator("[data-agent-ball]").click();
  }
  await page.waitForSelector("[data-agent]", { timeout: 20000 });
  await page.waitForTimeout(300);
};

/**
 * 切到「全部」视图去看结果。
 *
 * ⚠️ 必须先收起助手窗口：2026-09-24 起窗口默认落在**左下**，正好压着侧边栏，
 * 开着窗口点 nav 会被它挡住 —— 真实用户走这一步也是先按 Esc。
 * 这是"把左边界留给侧栏"和"听用户的话放左下"之间的取舍结果：
 * 换来的是窗口不再遮住中间那条任务列表，代价是换视图得先把它收起来。
 */
const gotoAll = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await page.locator('aside [data-nav="all"]').click();
  await page.waitForTimeout(600);
};

/** 等这一轮跑完（停止按钮消失 = 不忙了） */
const waitIdle = async () => {
  await page.waitForFunction(() => !document.querySelector("[data-agent-stop]"), null, { timeout: 30000 });
  await page.waitForTimeout(200);
};

const send = async (text) => {
  await page.locator("[data-agent-input]").fill(text);
  await page.locator("[data-agent-send]").click();
  await page.waitForTimeout(400);
};

/* ================================================================== */
console.log("\n1. 入口（只剩那颗球）与窗口形态");
/* ================================================================== */

{
  const nav = await page.evaluate(() =>
    [...document.querySelectorAll("aside [data-nav]")].map((el) => el.getAttribute("data-nav")),
  );
  info("侧边栏入口", nav.join(" "));
  // 这条也是**故意断言"不存在"**：2026-09-23 用户要求把侧栏那一项去掉，
  // 助手只剩球一个入口。两个入口做同一件事时，用户先得猜哪个是"真的"。
  check("侧栏里没有助手入口（入口只有那颗球）", !nav.includes("agent"), nav.join(" "));
  check("入口是那颗悬浮球（随手就能用，不必先找侧栏）", (await page.locator("[data-agent-ball]").count()) === 1);

  await gotoAgent();
  check("助手窗口打开了", (await page.locator("[data-agent-window]").count()) === 1);
  check("对话主体在窗口里", (await page.locator("[data-agent]").count()) === 1);

  /*
    窗口**不铺满、没有全屏遮罩** —— 位置则是"上次关掉时在哪儿，这次还在哪儿"，
    首次打开才落到左下角（2026-09-24 用户要求）。

    前两条只能用**几何**来写：铺满整屏的模态对话框同样会让上面那些
    元素"都存在"，只有量尺寸才能区分。而它背后是一条真实的设计约束 ——
    助手干的是慢活（写一份 30 KB 的工具源码、装进去、再回来报告结果），
    那段时间用户得能翻待办、看紧急区，不能被一层遮罩挡住。
  */
  const vp = page.viewportSize();
  const win = await page.locator("[data-agent-window]").boundingBox();
  info("窗口", {
    x: Math.round(win.x),
    y: Math.round(win.y),
    w: Math.round(win.width),
    h: Math.round(win.height),
    vp: `${vp.width}x${vp.height}`,
  });
  // 高度用的是 `<= 视口 - 20` 而不是百分比：窗口高 = min(视口-24, 820)，
  // 百分比阈值在矮屏上会误判（见 AgentWindow 的 h/max-h 两个类）。
  check(
    "窗口没铺满整屏（四边都还露着主界面）",
    win.width < vp.width * 0.85 && win.height <= vp.height - 20,
    `${Math.round(win.width)}x${Math.round(win.height)} / ${vp.width}x${vp.height}`,
  );
  check(
    "首次打开落在左下方（右侧留着紧急区，别压它）",
    Math.abs(win.x - 12) <= 2 && Math.abs(vp.height - win.y - win.height - 12) <= 2,
    `左 ${Math.round(win.x)} / 下 ${Math.round(vp.height - win.y - win.height)}`,
  );
  check(
    "左下 → 左边留白比右边窄得多（是靠边，不是居中）",
    win.x < vp.width - win.x - win.width,
    `左 ${Math.round(win.x)} / 右 ${Math.round(vp.width - win.x - win.width)}`,
  );
  // 这条是**故意断言"不存在"**：以后谁想给助手加全屏遮罩，先得把这条删掉
  // 并想清楚"它干活的时候用户还能干什么"。无声无息地加上去是不行的。
  check("没有全屏遮罩（主界面没被盖住）", (await page.locator("[data-agent-mask]").count()) === 0);
  check("用户手上那条任务还在（助手不打断正在看的东西）", (await page.locator('[data-task-detail="open"]').count()) === 1);
  await shot("agent-01-view");
}

/* ================================================================== */
console.log("\n2. 没配模型时的门槛：说清缺什么、把入口点开到设置");
/* ================================================================== */

{
  check("未配置时显示门槛卡", (await page.locator("[data-agent-gate]").count()) === 1);
  check("头上的标记是「未配置」", (await page.locator("[data-agent-provider]").innerText()).includes("未配置"));
  check("发送按钮是禁用的（否则用户按了没反应）", await page.locator("[data-agent-send]").isDisabled());

  const gateText = await page.locator("[data-agent-gate]").innerText();
  info("门槛卡", gateText.replace(/\n+/g, " | ").slice(0, 160));
  check("门槛卡点名缺 API Key", gateText.includes("API Key"));
  check("门槛卡说了去哪一页配（那句话必须能照着走）", gateText.includes("设置 → AI 助手"));

  /*
    这一条针对的是"只告诉人缺什么，不告诉他从哪儿弄"：
    没接过 API 的人卡住的从来不是"填哪一格"，而是 **Key 从哪儿来**。
    所以门槛卡里必须有一条能直接走的路 —— 推荐的那家要自带注册地址，
    而且两处（窗口 / 设置页）说的是同一家（数据源在 providers.ts）。
  */
  const signupBtn = page.locator("[data-agent-gate] [data-agent-signup]");
  check("门槛卡上有「去注册」的那条路", (await signupBtn.count()) === 1);
  const signupUrl = await signupBtn.getAttribute("data-agent-signup");
  info("注册地址", signupUrl);
  check("它指向的是一个能注册的平台域名", String(signupUrl).includes("platform.agnes-ai.com"), String(signupUrl));
  check("注册按钮写的是 https（不是裸 http、不是文档页）", String(signupUrl).startsWith("https://"), String(signupUrl));

  await page.locator("[data-agent-goto-settings]").click();
  await page.waitForSelector("[data-settings]", { timeout: 20000 });
  await page.waitForTimeout(300);
  check("一句话就能落到 AI 助手分区（不用自己在八个分区里找）", (await page.locator('[data-field="agent-model"]').count()) === 1);
  check("分区导航里也有 ai 这一项", (await page.locator('[data-section="ai"]').count()) === 1);
  await shot("agent-02-settings");

  /* ---- 同一张引导在设置页也要有（两处说法必须一致） ---- */
  {
    check("这一页也给了一张引导卡（没接 Model 时不该只说缺什么）", (await page.locator("[data-agent-signup-guide]").count()) === 1);
    const guide = await page.locator("[data-agent-signup-guide]").innerText();
    info("设置页引导卡", guide.replace(/\n+/g, " | ").slice(0, 180));
    check("引导卡给的是一条完整路径（注册→建 Key→粘回来）", guide.includes("注册") && guide.includes("Key"));
    check(
      "引导卡里的地址与窗口那张是同一个",
      (await page.locator("[data-agent-signup-guide] [data-agent-signup]").getAttribute("data-agent-signup")) ===
        signupUrl,
    );
    check("「我手上已经有别的 Key」没有藏起来（推荐≠绑定）", guide.includes("已经有别的 Key"));
  }

  /* ---- AI 助手总开关 ---- */
  {
    const row = page.locator("[data-agent-enabled-row]");
    check("这一页有「启用 AI 助手」这个总开关", (await row.count()) === 1);
    check("默认是开着的（老用户装上来不会少东西）", (await row.getAttribute("data-on")) === "1");

    await row.locator("[data-switch]").click();
    await page.waitForTimeout(250);
    check("关掉后开关状态是关", (await row.getAttribute("data-on")) === "0");
    check("关掉后配置项收起来了（不是留一堆点不动的框）", (await page.locator('[data-field="agent-model"]').count()) === 0);
    check("关掉后明确说了球去哪了", (await page.locator("[data-agent-off]").innerText()).includes("悬浮球"));

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("关掉之后悬浮球真的不在了", (await page.locator("[data-agent-ball]").count()) === 0);
    check("助手窗口也不留残影", (await page.locator("[data-agent-window]").count()) === 0);

    // 再开回来 —— "关了还能开"比"能关"更重要
    await page.locator('[data-section="ai"]').click();
    await page.waitForSelector("[data-agent-enabled-row]", { timeout: 10000 });
    await page.locator("[data-agent-enabled-row] [data-switch]").click();
    await page.waitForTimeout(250);
    check("重新打开后开关回到开", (await page.locator("[data-agent-enabled-row]").getAttribute("data-on")) === "1");
    check("配置项回来了", (await page.locator('[data-field="agent-model"]').count()) === 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("悬浮球回来了", (await page.locator("[data-agent-ball]").count()) === 1);

    // 后面的段落还会在设置页里接着配，回到那一处
    await page.locator("[data-agent-ball]").click();
    await gotoAgent();
    await page.locator("[data-agent-goto-settings]").click();
    await page.waitForSelector("[data-settings]", { timeout: 20000 });
    await page.waitForTimeout(300);
  }
}

/* ================================================================== */
console.log("\n3. 配置：选服务商、填地址与 Key、测试连接");
/* ================================================================== */

{
  const providers = await page.evaluate(() =>
    [...document.querySelectorAll("[data-agent-provider]")].map((el) => el.getAttribute("data-agent-provider")),
  );
  info("可选服务商", providers.join(" "));
  check("四家服务商都在", providers.join(",") === "agnes,aliyun,deepseek,custom", providers.join(","));
  check("默认选中 agnes", await page.locator('[data-agent-provider="agnes"]').getAttribute("data-on").then((v) => v === "1"));

  check("配置不全时测试连接是禁用的", await page.locator("[data-agent-test]").isDisabled());

  // 地址填成假的，配合路由拦截 —— 保证这个套件**永远不会**碰到真接口
  await page.locator('[data-field="agent-base-url"]').fill("https://mock.local/v1");
  await page.locator('[data-field="agent-key"]').fill("sk-mock-key");
  await page.locator('[data-field="agent-key"]').press("Tab");
  await page.locator('[data-field="agent-model"]').fill("mock-model");
  await page.locator('[data-field="agent-model"]').press("Tab");
  await page.waitForTimeout(400);

  check("配全了测试连接就能点", !(await page.locator("[data-agent-test]").isDisabled()));

  await page.locator("[data-agent-test]").click();
  await page.waitForTimeout(600);
  const flash = await page.locator("[data-flash]").innerText().catch(() => "");
  info("测试连接结果", flash);
  check("测试连接拿到了回复（真发了一次短对话）", flash.includes("连接成功"), flash);
  check("测试连接只发一次请求", captured.length === 1, String(captured.length));
  check(
    "请求体是 OpenAI 形状（model + messages + stream）",
    captured[0]?.model === "mock-model" && Array.isArray(captured[0]?.messages) && captured[0].stream === true,
    JSON.stringify({ model: captured[0]?.model, stream: captured[0]?.stream }),
  );
  check("测试连接有意不带工具定义（它只发一句短对话，不该烧一轮工具）", captured[0]?.tools === undefined);
  check("Key 不会出现在请求体里（它只走请求头）", !JSON.stringify(captured[0]).includes("sk-mock-key"));
}

/* ================================================================== */
console.log("\n4. 整条工具循环：模型调用动作 → 真建日程 → 再要一轮");
/* ================================================================== */

{
  captured.length = 0;
  const TITLE = "给客户回电话（e2e）";
  queue.push(
    toolReply("create_schedules", {
      items: [
        {
          title: TITLE,
          list: "工作",
          due_date: "2026-10-01",
          due_time: "15:00",
          steps: [{ title: "找出合同", due_at: "2026-10-01T14:00" }],
        },
      ],
    }),
    textReply("已经记到工作清单里了，10 月 1 日下午 3 点提醒你。"),
  );

  await gotoAgent();
  check("配置齐了，门槛卡消失了", (await page.locator("[data-agent-gate]").count()) === 0);
  check("头上的标记变成了服务商与模型", (await page.locator("[data-agent-provider]").innerText()).includes("mock-model"));

  await send("明天下午三点提醒我给客户回电话");
  await page.waitForSelector('[data-agent-action="create_schedules"]', { timeout: 30000 });
  await waitIdle();

  check("用户那句话在界面上", (await page.locator('[data-agent-msg="user"]').count()) === 1);
  check("助手的答复在界面上", (await page.locator('[data-agent-msg="assistant"]').count()) === 1);

  const card = page.locator('[data-agent-action="create_schedules"]');
  check("有动作卡（助手做过什么必须看得见）", (await card.count()) === 1);
  check("动作卡标了成功", (await card.getAttribute("data-agent-action-ok")) === "1");
  const cardText = await card.innerText();
  info("动作卡", cardText.replace(/\n+/g, " | ").slice(0, 140));
  check("动作卡用了中文动作名（不是 create_schedules）", cardText.includes("创建日程"));
  check("动作卡报了条数", cardText.includes("1 条"), cardText.slice(0, 40));
  check("动作卡能展开看细节", (await card.locator("details").count()) >= 1);
  await card.locator("details").first().click();
  await page.waitForTimeout(200);
  check("细节里能看到那条日程的标题", (await card.innerText()).includes(TITLE));
  await shot("agent-03-loop");

  // 助手消息正文里不该出现给程序看的 JSON
  const replyText = await page.locator('[data-agent-msg="assistant"]').innerText();
  check("正文里没有动作 JSON（那是给程序看的）", !replyText.includes('"tool"') && !replyText.includes("workbench"), replyText.slice(0, 60));

  check("一共两轮模型调用（动手 → 看到结果再答复）", captured.length === 2, String(captured.length));
  const second = captured[1]?.messages ?? [];
  check("第二轮把执行结果**回灌**了（role=tool）", second.some((m) => m.role === "tool"), JSON.stringify(second.map((m) => m.role)));
  check("回灌的内容里带上了真实结果", second.some((m) => typeof m.content === "string" && m.content.includes("已建 1 条待办")));
  check("system prompt 在第一轮最前面", captured[0]?.messages?.[0]?.role === "system");
  check("system prompt 里有当前时间（模型算日期全靠它）", captured[0].messages[0].content.includes("当前本地时间"));
  check("system prompt 里有技能硬规则", captured[0].messages[0].content.includes("你掌握的技能"));
  check("这一轮带上了工具定义（原生通道的前提）", Array.isArray(captured[0]?.tools) && captured[0].tools.length >= 8, String(captured[0]?.tools?.length));
  check("工具定义是 OpenAI 形状", captured[0]?.tools?.[0]?.type === "function");
  check("带工具时 tool_choice 是 auto（它自己决定动不动手）", captured[0]?.tool_choice === "auto", String(captured[0]?.tool_choice));

  // 最要紧的一条：日程真的进了库
  await gotoAll();
  check("切到「全部」能看见它 —— 不是「它说它建了」", (await page.locator("[data-task-id]", { hasText: TITLE }).count()) >= 1);
  await shot("agent-04-created");
  await gotoAgent();
}

/* ================================================================== */
console.log("\n5. 第二条通道：把动作写成代码块也照样执行");
/* ================================================================== */

{
  captured.length = 0;
  const TITLE = "买牛奶（e2e-fenced）";
  queue.push(
    fencedReply("create_schedules", { items: [{ title: TITLE, my_day: true }] }, "好，我记一下。"),
    textReply("记在「我的一天」里了。"),
  );

  await send("帮我把买牛奶放进我的一天");
  await page.waitForFunction(() => document.querySelectorAll('[data-agent-action="create_schedules"]').length >= 2, null, { timeout: 30000 });
  await waitIdle();

  const cards = page.locator('[data-agent-action="create_schedules"]');
  check("第二次动作也执行了（代码块通道走得通）", (await cards.count()) === 2);
  check("这一张也是成功", (await cards.nth(1).getAttribute("data-agent-action-ok")) === "1");

  const assistantMsgs = await page.locator('[data-agent-msg="assistant"]').allInnerTexts();
  const last = assistantMsgs[assistantMsgs.length - 1];
  check("答复里没有那段 workbench 代码块", !last.includes("workbench") && !last.includes('"tool"'), last.slice(0, 60));

  await gotoAll();
  check("这条也真的进库了", (await page.locator("[data-task-id]", { hasText: TITLE }).count()) >= 1);
  // 防「同一轮执行两遍」：两条通道同时命中时会真的建出双份，这条专门盯它
  check("上一条只有一份（没因两条通道同时命中而建重复）", (await page.locator("[data-task-id]", { hasText: "给客户回电话（e2e）" }).count()) === 1);
  await gotoAgent();
}

/* ================================================================== */
console.log("\n6. 权限：关掉之后必须拒绝，并把「去哪儿开」说清楚");
/* ================================================================== */

{
  await gotoSettings("ai");
  const schedulesSwitch = page.locator('[data-switch="agent-perm-schedules"]');
  check("权限开关在设置里", (await schedulesSwitch.count()) === 1);
  check("默认是开的", (await schedulesSwitch.getAttribute("aria-checked")) === "true");
  await schedulesSwitch.click();
  await page.waitForTimeout(400);
  check("点一下关掉了", (await schedulesSwitch.getAttribute("aria-checked")) === "false");

  captured.length = 0;
  queue.push(toolReply("create_schedules", { items: [{ title: "不该被建出来（e2e）" }] }), textReply("这条没建成。"));
  await gotoAgent();
  check("助手头上挂出了「权限已关」的提示（不然用户会以为它坏了）", (await page.locator("[data-agent-perms-off]").count()) === 1);
  const offText = await page.locator("[data-agent-perms-off]").innerText();
  info("权限提示", offText);

  await send("再帮我建一条测试日程");
  await page.waitForTimeout(1500);
  await waitIdle();

  const lastCard = page.locator('[data-agent-action="create_schedules"]').last();
  check("这一次动作卡是失败的", (await lastCard.getAttribute("data-agent-action-ok")) === "0");
  const failText = await lastCard.innerText();
  info("拒绝理由", failText.replace(/\n+/g, " | ").slice(0, 160));
  check("拒绝理由点名了是哪一项", failText.includes("建日程"), failText.slice(0, 60));
  check("拒绝理由说了去哪儿开", failText.includes("设置 → AI 助手 → 权限"));

  await gotoAll();
  check("那条确实没被建出来", (await page.locator("[data-task-id]", { hasText: "不该被建出来" }).count()) === 0);
  await shot("agent-05-perm-denied");

  // 恢复权限，免得影响后面的断言与别的套件
  await gotoAgent();
  await gotoSettings("ai");
  await page.locator('[data-switch="agent-perm-schedules"]').click();
  await page.waitForTimeout(300);
  check("权限能再打开", (await page.locator('[data-switch="agent-perm-schedules"]').getAttribute("aria-checked")) === "true");
  await gotoAgent();
  check("提示随之消失", (await page.locator("[data-agent-perms-off]").count()) === 0);
}

/* ================================================================== */
console.log("\n7. 技能面板：它会什么必须能被看见");
/* ================================================================== */

{
  await page.locator("[data-agent-skills-open]").click();
  await page.waitForSelector("[data-agent-skills]", { timeout: 20000 });
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll("[data-agent-skill]")].map((el) => el.getAttribute("data-agent-skill")),
  );
  info("技能", ids.join(" "));
  check("五份技能都列出来了", ids.length === 5, String(ids.length));
  check("包含注入组件那份（把工具嵌进待办详情就靠它）", ids.includes("component-inject"));
  check("包含写工具那份", ids.includes("tool-authoring"));
  check("包含绑数据表那份（「绑定数据库」这个能力就靠它）", ids.includes("data-binding"));

  const first = page.locator('[data-agent-skill="tool-authoring"]');
  check("技能上有硬规则清单", (await first.locator("li").count()) >= 3);
  await page.waitForTimeout(200);
  check("全文一开始是收起的", !(await first.innerText()).includes("唯一入口"));
  await first.locator("button").first().click();
  await page.waitForTimeout(300);
  const opened = await first.innerText();
  check("点开能看到全文", opened.includes("唯一入口") && opened.includes("交付物契约"));
  // 这份文档全是 ``` 代码块与 # 标题：按 Markdown 渲染才对，
  // 直接把源码吐出来会让用户看到一屏排版语法（旧版就是这样）
  check("全文按 Markdown 渲染（不露排版语法）", !opened.includes("## 一、") && !opened.includes("```"), opened.slice(0, 80));
  await shot("agent-06-skills");
  await page.locator("[data-agent-skills-close]").click();
  await page.waitForTimeout(200);
  check("能关掉", (await page.locator("[data-agent-skills]").count()) === 0);
}

/* ================================================================== */
console.log("\n8. 落库与刷新：对话不丢，清空是真的清");
/* ================================================================== */

{
  const before = await page.locator("[data-agent-msg]").count();
  info("刷新前消息条数", before);
  check("刷新前有对话", before >= 4);

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(800);
  // 刷新后应用回到「启动视图」（默认是我的一天），助手窗口是关着的 ——
  // 它是浮层不是路由，不该在冷启动时自己弹出来盖住用户要看的东西。
  // 这一步顺带验了入口在冷启动后依然可用。
  check("刷新后助手窗口是关着的（它不该自己弹出来）", (await page.locator("[data-agent]").count()) === 0);
  check("但球还在等在那儿（入口没丢）", (await page.locator("[data-agent-ball]").count()) === 1);
  await gotoAgent();
  const after = await page.locator("[data-agent-msg]").count();
  info("刷新后消息条数", after);
  check("刷新后对话还在（落的是库，不是内存）", after === before, `${before} → ${after}`);
  check("动作卡也跟着回来了（不只是文字）", (await page.locator('[data-agent-action="create_schedules"]').count()) >= 2);

  await gotoSettings("ai");
  const clearBtn = page.locator("[data-agent-clear]");
  check("清空按钮在设置里", (await clearBtn.count()) === 1);
  check("第一下是「清空对话」，不是直接清", (await clearBtn.innerText()).includes("清空对话"));
  await clearBtn.click();
  await page.waitForTimeout(300);
  check("第二下才是确认", (await clearBtn.getAttribute("data-agent-clear-confirm")) === "1");
  await clearBtn.click();
  await page.waitForTimeout(800);
  const flash = await page.locator("[data-flash]").innerText().catch(() => "");
  info("清空结果", flash);
  check("清空报了条数", /清空\s*\d+\s*条/.test(flash), flash);

  await gotoAgent();
  check("对话真的清空了", (await page.locator("[data-agent-msg]").count()) === 0);
  check("回到空态（有开场提示）", (await page.locator("[data-agent-empty]").count()) === 1);

  // 清空对话**不该**碰任何待办 —— 这条最容易在「顺手清一下」里写错
  await gotoAll();
  check("待办没有被连带清掉", (await page.locator("[data-task-id]").count()) >= 2);
  await gotoAgent();
}

/* ================================================================== */
console.log("\n9. 演示模式的诚实拒绝（装工具这条路）");
/* ================================================================== */

{
  await gotoAgent();
  captured.length = 0;

  /*
    2026-09-24 起装工具**必须先过沙箱**：install_tool 只认通行证。
    所以这里先跑一次 sandbox_run（浏览器里有 iframe，它是真跑），
    拿到票再装 —— 顺序与真机一致，也顺带验了"演示模式里沙箱照样能跑"。
  */
  const HTML = "<html><body>hi</body></html>";
  queue.push(toolReply("sandbox_run", { id: "demo-tool", name: "演示工具", html: HTML }), textReply("验过了，接着装。"));
  await send("给我做个演示工具");
  await page.waitForSelector('[data-agent-action="sandbox_run"]', { timeout: 30000 });
  await waitIdle();

  const sbCard = page.locator('[data-agent-action="sandbox_run"]').last();
  check("沙箱动作卡在", (await sbCard.count()) === 1);
  check("它是成功的（这份源码没问题）", (await sbCard.getAttribute("data-agent-action-ok")) === "1");
  const sbText = (await sbCard.locator("pre").first().textContent()) ?? "";
  check("演示模式里沙箱也真跑了", /试跑：\d+ ms/.test(sbText), sbText.slice(0, 120));
  const ticket = /通行证：(v1\.\S+)/.exec(sbText)?.[1] ?? "";
  check("拿到了通行证", /^v1\./.test(ticket), ticket);

  queue.push(
    toolReply("install_tool", { id: "demo-tool", name: "演示工具", html: HTML, ticket }),
    textReply("这个环境装不了，源码给你。"),
  );
  await send("装吧");
  await page.waitForSelector('[data-agent-action="install_tool"]', { timeout: 30000 });
  await waitIdle();

  const card = page.locator('[data-agent-action="install_tool"]');
  check("动作卡在", (await card.count()) === 1);
  check("标的是失败（不能假装装好了）", (await card.getAttribute("data-agent-action-ok")) === "0");
  const t = await card.innerText();
  info("拒绝方式", t.replace(/\n+/g, " | ").slice(0, 150));
  check("说清了是演示模式装不了", t.includes("浏览器演示模式"), t.slice(0, 60));
  check("给了可执行的下一步（去桌面版）", t.includes("桌面版"), t.slice(0, 60));
  check("提供了「复制源码」按钮（东西没白做）", (await card.locator("[data-agent-copy-html]").count()) === 1);
  // 下一步得具体到"点哪个菜单"——只说"去桌面版"等于没说
  await card.locator("details").first().click();
  await page.waitForTimeout(200);
  check("展开后能看到具体怎么装（导入 HTML 单文件）", (await card.innerText()).includes("导入 HTML 单文件"));
  await shot("agent-07-install-refused");

  const toolNavs = await page.evaluate(() =>
    [...document.querySelectorAll("aside [data-nav]")].map((el) => el.getAttribute("data-nav")),
  );
  check("那个工具没有出现在侧边栏（没装成就是没装成）", !toolNavs.includes("tool:demo-tool"), toolNavs.join(" "));
}

/* ================================================================== */
console.log("\n10. 参数里的裸换行：坏 JSON 不许被回灌（2026-09-23 那次 400 的根因）");
/* ================================================================== */

{
  await gotoAgent();
  captured.length = 0;

  // 整份 HTML 塞进参数，字符串里是**真的换行字节**（不是 \n）。
  // 这种参数：① 直接 JSON.parse 会失败；② 原样回灌会让服务端 400 掉整次请求。
  const BROKEN =
    '{"id":"gomoku-e2e","name":"五子棋","html": "<!doctype html>\n<html>\n<body>棋</body>\n</html>"}';
  queue.push(brokenToolReply("install_tool", BROKEN), textReply("这个环境装不了，我直接把源码给你。"));

  await send("做一个 web 版的五子棋，越快越好");
  await page.waitForSelector('[data-agent-action="install_tool"]', { timeout: 30000 });
  await waitIdle();

  const cardsBefore = await page.locator('[data-agent-action="install_tool"]').count();
  check("坏参数被修好后照样执行（不是直接放弃这次调用）", cardsBefore >= 1, String(cardsBefore));
  check("这一轮跑完了两趟（修复 → 执行 → 再答复），没被 400 打断", captured.length === 2, String(captured.length));

  const msgs = captured[1]?.messages ?? [];
  const withCalls = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  check("回灌了带 tool_calls 的 assistant 消息（否则 tool 结果没有配对）", withCalls.length === 1, msgs.map((m) => m.role).join(","));

  const argsList = (withCalls[0]?.tool_calls ?? []).map((c) => c.function?.arguments);
  check(
    "回灌的 arguments 全是合法 JSON —— 这一条就是这次 400 的根因",
    argsList.length > 0 &&
      argsList.every((a) => {
        try {
          JSON.parse(a);
          return true;
        } catch {
          return false;
        }
      }),
    JSON.stringify(argsList).slice(0, 120),
  );
  const echoed = (() => {
    try {
      return JSON.parse(argsList[0]);
    } catch {
      return {};
    }
  })();
  check("回灌的参数里 html 还在（修复没吃掉内容）", String(echoed.html ?? "").includes("<html>") && String(echoed.html).includes("棋"));

  // 顺序问题：tool 结果必须紧跟它的调用，中间插 user 消息会被严格的服务端判错
  const callIdx = msgs.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  check("tool 结果紧跟调用（中间没插 user 消息）", callIdx >= 0 && msgs[callIdx + 1]?.role === "tool", msgs.slice(callIdx, callIdx + 3).map((m) => m.role).join(","));

  check("回灌里提醒了模型「参数是宿主机修过的」（不然它每次都这么写）", JSON.stringify(msgs).includes("不是合法 JSON"));
  await shot("agent-08-repaired-args");

  /* ---- 真修不动的那种：整个调用不回灌，并且不让它假装成功 ---- */

  captured.length = 0;
  queue.push(brokenToolReply("install_tool", '{"id":"x","html": "<html><body>'), textReply("刚才那次调用没成，我重写一版。"));
  await send("再试一次");
  await waitIdle();

  const msgs2 = captured[1]?.messages ?? [];
  const badEcho = msgs2.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  check("截断的参数：整条调用不回灌（回灌了就是 400）", badEcho.length === 0, JSON.stringify(badEcho).slice(0, 100));
  check("坏掉的那次没产生动作卡（没执行就是没执行）", (await page.locator('[data-agent-action="install_tool"]').count()) === cardsBefore, String(cardsBefore));
  check("把「我看不懂」明确告诉模型，让它自己改", JSON.stringify(msgs2).includes("我看不懂"));
  check("请求照常跑完（没卡在错误上停住）", captured.length === 2, String(captured.length));
}

/* ================================================================== */
console.log("\n11. 停下来问你：选项卡、强制确认门、取消真的拦得住");
/* ================================================================== */

{
  await gotoAgent();

  /** 读落盘快照里某张表（内存库每次 execute 都会立刻写回它） */
  const tableRows = (name) =>
    page.evaluate(
      ([KEY, table]) => {
        const snap = JSON.parse(localStorage.getItem(KEY) || '{"tables":[]}');
        return (snap.tables ?? []).find(([n]) => n === table)?.[1] ?? [];
      },
      ["todo-workbench:demo-db", name],
    );

  /* ---- 先让它建一条待办，好拿到一个真实 id（删它要用到） ---- */
  queue.push(
    toolReply("create_schedules", { items: [{ title: "待删除的临时项" }] }),
    textReply("建好了。"),
  );
  await send("建一条待办：待删除的临时项");
  await waitIdle();

  const tasks = await tableRows("core_tasks");
  const target = tasks.find((t) => t.title === "待删除的临时项");
  check("建出了一条待办，拿到了它的 id", !!target?.id, JSON.stringify(tasks.map((t) => t.title)));
  const taskId = target?.id ?? "";

  /* ---- 11a. 模型主动问：选项要真的渲染出来，点了要能接着跑 ---- */
  {
    captured.length = 0;
    queue.push(
      toolReply("ask_user_choice", {
        question: "周报写成哪种？",
        options: [
          { value: "brief", label: "简短版" },
          { value: "full", label: "详细版" },
        ],
      }),
      textReply("好，按简短版写。"),
    );

    await send("帮我写周报");
    await page.waitForSelector("[data-agent-ask]", { timeout: 30000 });

    check("模型问的时候界面上真的出现了问题卡", (await page.locator("[data-agent-ask]").count()) === 1);
    check("卡的 kind 是 choice", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-kind")) === "choice");
    // source=model 与 source=host 的差别对用户是"可以懒得答" vs "这是刹车"
    check("卡标了来源是模型（不是宿主拦下来的）", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-source")) === "model");
    check("问题原文摆在卡上", (await page.locator("[data-agent-ask-question]").innerText()).includes("周报写成哪种？"));
    check("选项被渲染成了按钮（两个）", (await page.locator("[data-agent-ask-option]").count()) === 2, String(await page.locator("[data-agent-ask-option]").count()));
    check("选项的 value 就是模型给的", (await page.getAttribute('[data-agent-ask-option="full"]', "data-agent-ask-option")) === "full");
    check("等用户的时候这一轮还没结束（停止按钮仍在）", (await page.locator("[data-agent-stop]").count()) === 1);
    // 卡片在输入区上方、不随消息流滚走 —— 否则用户往回翻两屏就以为它卡死了
    const askBox = await page.locator("[data-agent-ask]").boundingBox();
    const inputBox = await page.locator("[data-agent-input]").boundingBox();
    check("问题卡在输入框上方（不会被消息流滚走）", askBox.y < inputBox.y, `卡 ${Math.round(askBox.y)} / 输入框 ${Math.round(inputBox.y)}`);
    await shot("agent-09-ask-choice");

    await page.locator('[data-agent-ask-option="full"]').click();
    await waitIdle();

    check("点完之后卡片收掉了", (await page.locator("[data-agent-ask]").count()) === 0);
    const askCard = page.locator('[data-agent-action="ask_user_choice"]').last();
    check("历史里留下了这次询问的动作卡", (await askCard.count()) === 1);
    // 记的是**答案**而不是空白 —— 翻旧对话时才能看出当时选了什么
    check("动作卡上写的是用户选了什么", (await askCard.innerText()).includes("详细版"), (await askCard.innerText()).slice(0, 80));
    check("模型接着把话说完了", (await page.locator("[data-agent-messages]").innerText()).includes("简短版"));
    check(
      "答案回灌给了模型（它能看到用户选了哪个）",
      JSON.stringify(captured[1]?.messages ?? []).includes("详细版"),
      JSON.stringify(captured[1]?.messages ?? []).slice(-200),
    );
    check("这一轮正好跑了两趟（问 → 答 → 收尾）", captured.length === 2, String(captured.length));
  }

  /* ---- 11b. 都不对时自己打字 ---- */
  {
    captured.length = 0;
    queue.push(
      toolReply("ask_user_choice", {
        question: "放进哪个清单？",
        options: [{ value: "work", label: "工作" }],
      }),
      textReply("好，按你说的放。"),
    );
    await send("把这条放进清单");
    await page.waitForSelector("[data-agent-ask]", { timeout: 30000 });

    check("选项之外还能自己打字", (await page.locator("[data-agent-ask-text]").count()) === 1);
    await page.locator("[data-agent-ask-text]").fill("放进「临时」");
    await page.locator("[data-agent-ask-submit]").click();
    await waitIdle();

    const card = page.locator('[data-agent-action="ask_user_choice"]').last();
    check("自己打的字也进了动作卡", (await card.innerText()).includes("临时"), (await card.innerText()).slice(0, 80));
    check(
      "自己打的字回灌给了模型",
      JSON.stringify(captured[1]?.messages ?? []).includes("放进「临时」"),
      JSON.stringify(captured[1]?.messages ?? []).slice(-200),
    );
  }

  /* ---- 11c. 强制确认门：模型直接调删除，宿主必须拦下 ---- */
  {
    captured.length = 0;
    queue.push(
      toolReply("delete_schedules", { ids: [taskId], reason: "用户说不用了" }),
      textReply("好，那我不删了。"),
    );
    await send("把待删除的临时项删掉");
    await page.waitForSelector("[data-agent-ask]", { timeout: 30000 });

    /*
      这一组是本次最重要的一条：**删除不能由模型自己决定**。
      提示词写得再狠也只是概率，而删除不可逆 —— 用户要的是"不管它怎么想，
      删我之前我都得点一下"。模型这里**没有**先调 confirm_action，
      卡是宿主弹的，所以 source 必须是 host。
    */
    check("模型直接调删除也被拦下来了", (await page.locator("[data-agent-ask]").count()) === 1);
    check("这张卡的 kind 是 confirm", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-kind")) === "confirm");
    check("卡的来源是 host（是宿主挡的，不是它主动问的）", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-source")) === "host");
    check("卡标了危险（走醒目色）", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-danger")) === "1");
    check("确认卡上写了要删几条", (await page.locator("[data-agent-ask-question]").innerText()).includes("1"), await page.locator("[data-agent-ask-question]").innerText());
    // 只写"要删 1 条吗"等于让用户盲签 —— id 是 uuid，他没法核对
    check("确认卡列出了要删的那条的**标题**", (await page.locator("[data-agent-ask-detail]").innerText()).includes("待删除的临时项"), await page.locator("[data-agent-ask-detail]").innerText());
    check("确认卡说了没有撤销入口", (await page.locator("[data-agent-ask-detail]").innerText()).includes("没有撤销入口"));
    check("确认卡带上了它说的原因", (await page.locator("[data-agent-ask-detail]").innerText()).includes("用户说不用了"));
    check("确认卡只有两个按钮（确认 / 取消）", (await page.locator("[data-agent-ask-option]").count()) === 2);
    await shot("agent-10-ask-confirm");

    await page.locator('[data-agent-ask-option="no"]').click();
    await waitIdle();

    /*
      待办是**软删**（deleted = 1），所以不能只看"这一行还在不在" ——
      那样无论删没删都成立。要看删除标记。
    */
    const still = (await tableRows("core_tasks")).find((t) => t.id === taskId)?.deleted !== 1;
    check("点了取消，那条待办**还在**（没被偷偷删掉）", still === true, JSON.stringify((await tableRows("core_tasks")).find((t) => t.id === taskId)));

    // 拦下之后必须明说"别重试"，否则模型看到没有回音，最常见的反应是再调一次
    check(
      "取消之后明确告诉模型不要重试",
      JSON.stringify(captured[1]?.messages ?? []).includes("不要重试"),
      JSON.stringify(captured[1]?.messages ?? []).slice(-240),
    );
    check(
      "取消之后没有把「已删除」说给它听",
      !JSON.stringify(captured[1]?.messages ?? []).includes("已删除"),
    );
  }

  /* ---- 11d. 同一个动作点确认，这一次是真的删 ---- */
  {
    captured.length = 0;
    queue.push(toolReply("delete_schedules", { ids: [taskId] }), textReply("删掉了。"));
    await send("还是删掉它吧");
    await page.waitForSelector("[data-agent-ask]", { timeout: 30000 });

    check("再删一次仍然会先问（本轮许可不跨轮）", (await page.locator("[data-agent-ask]").count()) === 1);
    await page.locator('[data-agent-ask-option="yes"]').click();
    await waitIdle();

    const gone = (await tableRows("core_tasks")).find((t) => t.id === taskId)?.deleted === 1;
    check("点了确认，那条待办真的被删了", gone === true, JSON.stringify((await tableRows("core_tasks")).find((t) => t.id === taskId)));
    check("确认之后模型拿到了执行结果", JSON.stringify(captured[1]?.messages ?? []).includes("已删除"), JSON.stringify(captured[1]?.messages ?? []).slice(-200));
  }

  /* ---- 11e. 卡在等回答的时候能停 ---- */
  {
    queue.push(
      toolReply("ask_user_choice", {
        question: "要不要继续？",
        options: [{ value: "go", label: "继续" }],
      }),
    );
    await send("继续做");
    await page.waitForSelector("[data-agent-ask]", { timeout: 30000 });

    check("问题卡上有「停止这一轮」（不能只能干等）", (await page.locator("[data-agent-ask-cancel]").count()) === 1);
    await page.locator("[data-agent-ask-cancel]").click();
    await waitIdle();

    check("停止之后卡片收掉了", (await page.locator("[data-agent-ask]").count()) === 0);
    check("停止之后这一轮结束了（停止按钮消失）", (await page.locator("[data-agent-stop]").count()) === 0);
    // 卡住不解开的后果是 busy 永远 true、输入框永远禁用，只能重启应用
    check("停止之后输入框能用（没被永久锁死）", await page.locator("[data-agent-input]").isEditable());
  }
}

/* ================================================================== */
console.log("\n12. 收尾：控制台干净");
/* ================================================================== */

{
  const real = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
  if (real.length) for (const e of real.slice(0, 6)) console.log("    !", e.slice(0, 160));
  check("没有控制台错误", real.length === 0, `${real.length} 条`);

  // 把这一轮留下的痕迹擦掉，别影响别的套件
  await page.evaluate(() => localStorage.clear());
}

await browser.close();

console.log("\n====================================================");
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log("====================================================");
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
