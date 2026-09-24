/**
 * 助手入口（悬浮球）与窗口的浏览器验证。
 *
 * ------------------------------------------------------------------
 * 为什么单独一个套件
 * ------------------------------------------------------------------
 * agent.mjs 验的是"助手能不能干活"（动作协议、权限门、落库、坏参数）。
 * 这个套件验的是**入口与容器**这层新加的东西：
 *
 *   1. 球在哪儿、能不能拖、拖完重启还在不在原地
 *   2. 窗口是"正中浮层"还是"铺满整屏的模态"（这是设计约束，不是外观偏好），
 *      以及侧栏里确实**没有**第二个入口
 *   3. 历史对话：新建是**新开**而不是**清空**、两段之间切得干净、
 *      关掉窗口再打开回到原处
 *
 * 第 3 条是这次改造的核心。它的回归代价很高 —— 一段对话被误删，
 * 用户交代过的背景（客户名、单号规则）就找不回来了，而界面上不会报任何错。
 *
 * ------------------------------------------------------------------
 * 两处刻意的写法
 * ------------------------------------------------------------------
 * · **位置用几何断言**（boundingBox 算出来的坐标），不用"某个元素存在" ——
 *   铺满整屏的模态同样能让所有元素都"存在"，只有量尺寸才能区分。
 * · **数据读落盘快照**（localStorage 里的 demo-db），不 import db 模块：
 *   dev server 给模块加时间戳 query，import 拿到的是另一个实例，
 *   只读一次快照就不再刷新（同一个 realm 里第二次读会拿到陈旧内存）。
 *
 * 用法：node tests/agent-ball.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

// playwright 装在本机另一个项目目录里（不是这个包的依赖），
// 所以用 createRequire 指过去 —— 和 agent.mjs / gomoku.mjs 同一个写法。
// ESM 的 import 不走 NODE_PATH，直接 import "playwright" 会 MODULE_NOT_FOUND。
const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

const SHOT_DIR = process.env.WB_SHOT_DIR || "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });

/** 内存库的落盘快照（见 db.ts 的 STORAGE_KEY） */
const SNAPSHOT_KEY = "todo-workbench:demo-db";

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

/* ---------- 假模型：不连真接口，也不花钱 ---------- */

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const textReply = (t) => () => [{ choices: [{ delta: { content: t } }] }];

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/agent-ball-${n}.png` });

/* ---------- 起一个干净库，并把模型指向假地址 ---------- */

const queue = [];
await page.route("**/chat/completions", async (route) => {
  const step = queue.shift();
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: sse((step ?? textReply("（队列空了，兜底回复）"))()),
  });
});

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(600);

/** 直接在快照里写设置 —— 比绕界面填表快，且和 e2e 关心的东西无关 */
await page.evaluate((KEY) => {
  const snap = JSON.parse(localStorage.getItem(KEY) || '{"version":0,"tables":[]}');
  let t = snap.tables.find(([n]) => n === "core_settings");
  if (!t) {
    t = ["core_settings", []];
    snap.tables.push(t);
  }
  const set = (k, v) => {
    const row = t[1].find((r) => r.key === k);
    if (row) row.value = v;
    else t[1].push({ key: k, value: v });
  };
  set("agent.provider", "agnes");
  set("agent.baseUrl", "https://mock.local/v1");
  set("agent.apiKey", "sk-mock-key");
  set("agent.model", "mock-model");
  localStorage.setItem(KEY, JSON.stringify(snap));
}, SNAPSHOT_KEY);

await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(600);

/* ---------- 小工具 ---------- */

const ball = page.locator("[data-agent-ball]");
const win = page.locator("[data-agent-window]");

const ballBox = () => ball.boundingBox();

const openByBall = async () => {
  await ball.click();
  await page.waitForSelector("[data-agent-window]", { timeout: 10000 });
  await page.waitForTimeout(250);
};

const isOpen = async () => (await win.count()) === 1;

const send = async (text) => {
  await page.locator("[data-agent-input]").fill(text);
  await page.locator("[data-agent-send]").click();
  await page.waitForFunction(() => !document.querySelector("[data-agent-stop]"), null, { timeout: 30000 });
  await page.waitForTimeout(250);
};

/** 读落盘快照里某张表（内存库每次 execute 都会立刻写回它） */
const tableRows = async (name) =>
  page.evaluate(
    ([KEY, table]) => {
      const snap = JSON.parse(localStorage.getItem(KEY) || '{"tables":[]}');
      return (snap.tables ?? []).find(([n]) => n === table)?.[1] ?? [];
    },
    [SNAPSHOT_KEY, name],
  );

const chatIds = async () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-agent-chat]")].map((el) => el.getAttribute("data-agent-chat")),
  );

/* ================================================================== */
console.log("\n1. 悬浮球：默认落点、点击开关窗口");
/* ================================================================== */

{
  check("球在", (await ball.count()) === 1);
  const vp = page.viewportSize();
  const b = await ballBox();
  info("球", { x: Math.round(b.x), y: Math.round(b.y), w: b.width, h: b.height });
  check("尺寸是 48（一眼看得见，又不太占地方）", Math.round(b.width) === 48 && Math.round(b.height) === 48);
  check(
    "默认落在右下角（左上角有「显示侧边栏」那个钮，要避开）",
    Math.abs(vp.width - (b.x + b.width) - 20) <= 2 && Math.abs(vp.height - (b.y + b.height) - 20) <= 2,
    `右下间隙 ${Math.round(vp.width - b.x - b.width)} / ${Math.round(vp.height - b.y - b.height)}`,
  );
  check("一开始窗口是关着的", !(await isOpen()));
  check("球标了「打开」状态（供自动化与读屏）", (await ball.getAttribute("data-agent-ball-open")) === "0");

  await openByBall();
  check("点一下球，窗口开了", await isOpen());
  check("球变成了「已打开」状态", (await ball.getAttribute("data-agent-ball-open")) === "1");
  check("窗口里有对话主体", (await page.locator("[data-agent]").count()) === 1);
  await shot("01-open");
}

/* ================================================================== */
console.log("\n2. 窗口形态：记住上次位置、首次落左下、不遮满主界面（设计约束，不是外观偏好）");
/* ================================================================== */

{
  const vp = page.viewportSize();
  const w = await win.boundingBox();
  info("窗口", {
    x: Math.round(w.x),
    y: Math.round(w.y),
    w: Math.round(w.width),
    h: Math.round(w.height),
    vp: `${vp.width}x${vp.height}`,
  });

  // 高度用 `<= 视口 - 20` 而不是百分比：窗口高 = min(视口-24, 820)，
  // 百分比阈值在矮屏上会误判（见 AgentWindow 的 h / max-h 两个类）。
  check(
    "没铺满整屏（四边都还露着主界面）",
    w.width < vp.width * 0.85 && w.height <= vp.height - 20,
    `${Math.round(w.width)}x${Math.round(w.height)} / ${vp.width}x${vp.height}`,
  );
  check(
    "首次打开落在左下方（2026-09-24 用户要求）",
    Math.abs(w.x - 12) <= 2 && Math.abs(vp.height - w.y - w.height - 12) <= 2,
    `左 ${Math.round(w.x)} / 下 ${Math.round(vp.height - w.y - w.height)}`,
  );
  check("没有全屏遮罩（加它之前得先想清楚用户干等时能做什么）", (await page.locator("[data-agent-mask]").count()) === 0);
  check("主界面还在（待办列表没被卸载）", (await page.locator("[data-compose-input]").count()) === 1);

  /* 关闭的三条路都要通 —— 只留一个 × 的话，用户会一直找不到怎么收起来 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check("Esc 能收起窗口", !(await isOpen()));

  await openByBall();
  await page.locator("[data-agent-window-close]").click();
  await page.waitForTimeout(250);
  check("头部 × 能收起窗口", !(await isOpen()));

  await openByBall();
  await ball.click();
  await page.waitForTimeout(250);
  check("再点一次球也能收起（球是开关）", !(await isOpen()));

  // 入口只有球这一处：侧栏里那个「AI 助手」在 2026-09-23 被用户要求去掉了。
  // 这条同样**故意断言"不存在"** —— 想加回去，先得说清两个入口怎么分工。
  const nav = await page.evaluate(() =>
    [...document.querySelectorAll("aside [data-nav]")].map((el) => el.getAttribute("data-nav")),
  );
  check("侧栏里没有助手入口（入口只剩那颗球）", !nav.includes("agent"), nav.join(" "));

  // 第 3 段接着验历史对话栏，前提是窗口开着 —— 这一段结尾刚把它关掉
  await openByBall();
  await page.waitForTimeout(300);
}

/* ================================================================== */
console.log("\n3. 历史对话：新建是「新开一段」，不是「清空」");
/* ================================================================== */

{
  check("右侧有历史对话栏", (await page.locator("[data-agent-chats]").count()) === 1);
  check("开窗时已经有一段（不用先点新建才能说话）", (await chatIds()).length === 1, String((await chatIds()).length));

  // 严格模式下开窗的 effect 会跑两次 → 两次 ensureLoaded 并发。
  // 那次并发真的各建了一段（界面上只显示一段，库里躺着两个空对话）。
  // 所以这条要读**库**，不能读界面列表。
  const seeded = await tableRows("core_agent_chats");
  check("首次开窗只建了一段（载入要能并发复用，不能各建一段）", seeded.length === 1, String(seeded.length));

  // 第一段：说一句话，标题应当自动长出来
  queue.push(textReply("好，记下了。"));
  await send("第一段：把发货时效提醒改成两次");
  await page.waitForTimeout(400);

  const rowsA = await chatIds();
  const titleA = await page.locator(`[data-agent-chat="${rowsA[0]}"]`).innerText();
  info("第一段", titleA.replace(/\n+/g, " | "));
  check("会话自动有了标题（取第一句话）", titleA.includes("第一段"), titleA.slice(0, 40));
  check("标题说出了条数", /2\s*条/.test(titleA), titleA.replace(/\n+/g, " | "));
  check("活跃态标在列表上", (await page.locator('[data-agent-chat-active="1"]').count()) === 1);

  // 新建一段 —— 旧的必须还在
  await page.locator("[data-agent-chat-new]").click();
  await page.waitForTimeout(400);
  check("新建后有两段", (await chatIds()).length === 2, String((await chatIds()).length));
  check("新段是空的（界面上没有消息）", (await page.locator("[data-agent-msg]").count()) === 0);
  check("旧段的标题还在列表里（没被清掉）", (await page.locator("[data-agent-chats]").innerText()).includes("第一段"));

  queue.push(textReply("明白，第二条。"));
  await send("第二段：给五子棋加个悔棋按钮");
  await page.waitForTimeout(400);

  const ids = await chatIds();
  const textAll = await page.locator("[data-agent-chats]").innerText();
  info("两段", textAll.replace(/\n+/g, " | "));
  check("两段都在列表里", ids.length === 2 && textAll.includes("第一段") && textAll.includes("第二段"));
  check("第二段现在只有它自己的 2 条", (await page.locator("[data-agent-msg]").count()) === 2);

  // 切回第一段：内容必须是第一段的，不能串台
  const oldId = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-agent-chats] [data-agent-chat]")]
        .map((el) => ({ id: el.getAttribute("data-agent-chat"), text: el.innerText }))
        .find((x) => x.text.includes("第一段"))?.id ?? "",
  );
  await page.locator(`[data-agent-chat="${oldId}"] [data-agent-chat-open]`).click();
  await page.waitForTimeout(400);
  const shown = await page.locator("[data-agent-messages]").innerText();
  check("切回第一段后显示的是它的内容", shown.includes("第一段"), shown.slice(0, 60));
  check("第二段的内容没有串进来", !shown.includes("第二段"), shown.slice(0, 60));
  check("切过去之后活跃标跟着走", (await page.locator(`[data-agent-chat="${oldId}"]`).getAttribute("data-agent-chat-active")) === "1");
  await shot("02-history");
}

/* ================================================================== */
console.log("\n4. 落库：会话与「消息属于哪一段」都要真进库");
/* ================================================================== */

{
  const chats = await tableRows("core_agent_chats");
  const msgs = await tableRows("core_agent_messages");
  info("库里", `${chats.length} 段 / ${msgs.length} 条消息`);
  check("core_agent_chats 里真有两段", chats.length === 2, String(chats.length));
  check("每条消息都带 chat_id（不然按会话读就查不到）", msgs.every((m) => !!m.chat_id), JSON.stringify(msgs.map((m) => m.chat_id)));
  check("消息分布正确（2 + 2）", msgs.filter((m) => m.chat_id === chats[0].id).length === 2 && msgs.filter((m) => m.chat_id === chats[1].id).length === 2);
  check("会话标题也落库了", chats.some((c) => String(c.title).includes("第一段")), JSON.stringify(chats.map((c) => c.title)));

  // 刷新：窗口该关着（浮层不是路由），球该还在；再打开时要回到刚才那一段
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(800);
  check("刷新后窗口是关着的（它不该自己弹出来盖住界面）", (await page.locator("[data-agent]").count()) === 0);
  check("球还在（冷启动后入口依然可用）", (await ball.count()) === 1);

  await openByBall();
  await page.waitForTimeout(400);
  check("重新打开还停在刚才那一段（不是回到第一段）", (await page.locator("[data-agent-messages]").innerText()).includes("第一段"));
  check("两段都还在列表里", (await chatIds()).length === 2);

  // 删除：破坏性操作，必须两段式
  const ids = await chatIds();
  const del = page.locator(`[data-agent-chat-delete="${ids[1]}"]`);
  await del.click();
  await page.waitForTimeout(200);
  check("第一下只是进入确认态（没直接删）", (await page.locator(`[data-agent-chat-delete="${ids[1]}"]`).getAttribute("data-agent-chat-confirm")) === "1");
  check("确认态下两段都还在", (await chatIds()).length === 2);

  await del.click();
  await page.waitForTimeout(400);
  check("第二下才真删，剩一段", (await chatIds()).length === 1, String((await chatIds()).length));
  const left = await tableRows("core_agent_chats");
  check("库里也只剩一段", left.length === 1, String(left.length));
  const leftMsgs = await tableRows("core_agent_messages");
  check("被删那段的消息一起走了（不留孤儿消息）", leftMsgs.every((m) => m.chat_id === left[0].id), JSON.stringify(leftMsgs.map((m) => m.chat_id)));
}

/* ================================================================== */
console.log("\n5. 球：拖动、落库、重启后还在原地、屏幕变小也不丢");
/* ================================================================== */

{
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  const before = await ballBox();
  const vp = page.viewportSize();
  // 拖到左上区域。用真鼠标事件 —— 拖动是"按下→移动→抬起"，
  // 只调 click() 是测不出它的
  const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  const to = { x: 140, y: 120 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await ballBox();
  info("拖动后", { x: Math.round(after.x), y: Math.round(after.y) });
  /*
    松手**吸附到最近的边**（2026-09-24 用户要求"小球必须贴边"）。
    落点是 (140,120)，离上边最近 → y 吸到 20；x 不动（只吸一个轴，
    否则"拖到偏左"会被拽去左上角，用户会觉得没拖准）。
  */
  check("横向跟着游标走到 116", Math.abs(after.x - 116) <= 2, `x=${Math.round(after.x)}`);
  check("纵向吸附到最近的边（上边，留 20px）", Math.abs(after.y - 20) <= 2, `y=${Math.round(after.y)}`);
  check(
    "球贴在视口某条边上（四边距这里必有一个是 20）",
    [after.x, vp.width - after.x - after.width, after.y, vp.height - after.y - after.height].some(
      (d) => Math.abs(d - 20) <= 2,
    ),
    `四边距 ${[after.x, vp.width - after.x - after.width, after.y, vp.height - after.y - after.height].map(Math.round).join("/")}`,
  );
  check("拖动**不会**顺手把窗口开了（它是一次拖动）", !(await isOpen()));

  const saved = await page.evaluate(
    ([KEY]) => {
      const snap = JSON.parse(localStorage.getItem(KEY) || '{"tables":[]}');
      const rows = (snap.tables ?? []).find(([n]) => n === "core_settings")?.[1] ?? [];
      return rows.find((r) => r.key === "agent.ballPos")?.value ?? "";
    },
    [SNAPSHOT_KEY],
  );
  info("落库的落点", saved);
  check("松手才落库，存的是**吸附后**的位置", saved === "116,20", saved);

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(800);
  const afterReload = await ballBox();
  check(
    "重启后球还在拖到的位置（存的是设置，不是内存）",
    Math.abs(afterReload.x - 116) <= 2 && Math.abs(afterReload.y - 20) <= 2,
    `${Math.round(afterReload.x)},${Math.round(afterReload.y)}`,
  );

  /* 换个方向再拖一次：这次最近的边是**右边**，验证横向也吸得住 */
  {
    const b = await ballBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(1400, 470, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const right = await ballBox();
    info("拖到右侧后", { x: Math.round(right.x), y: Math.round(right.y) });
    check(
      "横向也吸到最近的边（右边留 20）",
      Math.abs(vp.width - right.x - right.width - 20) <= 2,
      `右 ${Math.round(vp.width - right.x - right.width)}`,
    );
    check("纵向没被顺手改掉（一次只吸一个轴）", Math.abs(right.y - 446) <= 2, `y=${Math.round(right.y)}`);
  }

  // 换小屏：不夹回去的话球会停在视口外，用户看到的是"助手不见了"
  await page.setViewportSize({ width: 900, height: 560 });
  await page.waitForTimeout(500);
  const small = await ballBox();
  const svp = page.viewportSize();
  info("小屏下", { x: Math.round(small.x), y: Math.round(small.y), vp: `${svp.width}x${svp.height}` });
  check("屏幕变小后球仍在可见区内", small.x >= 0 && small.y >= 0 && small.x + small.width <= svp.width && small.y + small.height <= svp.height);
  await shot("03-small-viewport");
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.waitForTimeout(400);
}

/* ================================================================== */
console.log("\n6. 窗口位置：能拖动、记住落点、重启后回到原处");
/* ================================================================== */

{
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await openByBall();

  const handle = page.locator("[data-agent-window-drag]").first();
  check("头部标了拖动把手（标题栏可以抓着走）", (await handle.count()) >= 1);

  const before = await win.boundingBox();
  info("拖动前", { x: Math.round(before.x), y: Math.round(before.y) });

  /*
    抓**标题栏靠左的那块**：那一排右上角还有"新对话 / ×"等按钮，
    按上去是被 AgentWindow 豁免掉的（不然拖窗口会把按钮吃掉）。
  */
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + 40, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 40 + 220, hb.y + hb.height / 2 - 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const moved = await win.boundingBox();
  info("拖动后", { x: Math.round(moved.x), y: Math.round(moved.y) });
  check(
    "抓住头部能把窗口挪走",
    Math.abs(moved.x - (before.x + 220)) <= 2 && Math.abs(moved.y - (before.y - 40)) <= 2,
    `${Math.round(moved.x)},${Math.round(moved.y)}`,
  );

  const savedWin = await page.evaluate(
    ([KEY]) => {
      const snap = JSON.parse(localStorage.getItem(KEY) || '{"tables":[]}');
      const rows = (snap.tables ?? []).find(([n]) => n === "core_settings")?.[1] ?? [];
      return rows.find((r) => r.key === "agent.windowPos")?.value ?? "";
    },
    [SNAPSHOT_KEY],
  );
  info("窗口落点", savedWin);
  check(
    "窗口落点落进了设置",
    savedWin === `${Math.round(before.x + 220)},${Math.round(before.y - 40)}`,
    savedWin,
  );

  // 关掉再打开：位置要跟着回来（这条最容易被写成"每次都回默认位置"）
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await openByBall();
  const reopened = await win.boundingBox();
  check(
    "关掉再打开，回到刚才那一处（不是又弹回左下角）",
    Math.abs(reopened.x - moved.x) <= 2 && Math.abs(reopened.y - moved.y) <= 2,
    `${Math.round(reopened.x)},${Math.round(reopened.y)}`,
  );

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(800);
  await openByBall();
  const restored = await win.boundingBox();
  check(
    "重启之后还在那一处（位置是习惯，只有「第一次」才给默认值）",
    Math.abs(restored.x - moved.x) <= 2 && Math.abs(restored.y - moved.y) <= 2,
    `${Math.round(restored.x)},${Math.round(restored.y)}`,
  );

  // 拖出视口也不该丢：头部被夹在视口内，用户才拽得回来
  const hb2 = await page.locator("[data-agent-window-drag]").first().boundingBox();
  await page.mouse.move(hb2.x + 40, hb2.y + hb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(-600, -600, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const pulledOut = await win.boundingBox();
  check(
    "往屏幕外拖也拽不丢（头部永远留在视口里，否则再也抓不回来）",
    pulledOut.x >= 8 && pulledOut.y >= 8,
    `${Math.round(pulledOut.x)},${Math.round(pulledOut.y)}`,
  );
  await shot("04-window-moved");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

/* ================================================================== */
console.log("\n7. 收尾：控制台干净");
/* ================================================================== */

{
  const real = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
  if (real.length) for (const e of real.slice(0, 6)) console.log("    !", e.slice(0, 160));
  check("没有控制台错误", real.length === 0, `${real.length} 条`);

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
