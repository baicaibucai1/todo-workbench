/**
 * 助手的**工具注册**验证（浏览器真跑，不连任何模型）。
 *
 * ------------------------------------------------------------------
 * 这个套件补的是 tests/agent.mjs 补不了的那一块
 * ------------------------------------------------------------------
 * "工具注册给助手的动作"这件事横跨三层：manifest 里的声明、宿主算出来的
 * 函数定义、以及**工具真的收到了命令并回了结果**。前两层 Node 侧能验，
 * 第三层只能在真浏览器里验 —— jsdom 不执行 iframe 里的脚本。
 *
 * 所以它用一个夹具工具（`tests/fixtures/tools/counter/`）：
 *   · manifest 里声明了三个动作 + headless + 自带 skill
 *   · 源码在解析阶段就监听 tool:command，每条都回 tool:command:result
 *   · `?fixtureTools=counter` 把它灌进注册表（dev 专用，打包后不成立）
 *
 * ------------------------------------------------------------------
 * 这一段真正要钉住的三件事
 * ------------------------------------------------------------------
 *   1. **动作是"算出来的"**：装上来就有函数，不需要任何登记步骤
 *      —— 请求体里必须出现 `tool_counter_add`
 *   2. **skill 是配套的**：只给函数不给说明书等于让模型靠猜
 *      —— system prompt 里必须出现 `tool-use-counter`
 *   3. **没打开也能驱动，但要工具自己开门**：它没被打开、宿主也没有
 *      偷偷留一个后台 iframe，命令照样执行了（headless 起的一次性实例）
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/agent-tool-actions.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = (ui !== -1 ? argv[ui + 1] : "http://localhost:1420/") + "?fixtureTools=counter";

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

/* ---------- 启动 ---------- */

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

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
await page.waitForTimeout(800);

const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });

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

const names = (body) => (body?.tools ?? []).map((t) => t?.function?.name);

/* ================================================================== */
section("1. 配置一个假服务商（这一套全程不连真接口）");
/* ================================================================== */

{
  await gotoAgent();
  await page.locator("[data-agent-settings]").click();
  await page.waitForSelector("[data-settings]", { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.locator('[data-field="agent-base-url"]').fill("https://mock.local/v1");
  await page.locator('[data-field="agent-key"]').fill("sk-mock-key");
  await page.locator('[data-field="agent-key"]').press("Tab");
  await page.locator('[data-field="agent-model"]').fill("mock-model");
  await page.locator('[data-field="agent-model"]').press("Tab");
  await page.waitForTimeout(400);
  await page.locator('[data-act="close-settings"]').click();
  await page.waitForTimeout(300);
  await gotoAgent();
  check("配置好了（门槛卡消失）", (await page.locator("[data-agent-gate]").count()) === 0);
}

/* ================================================================== */
section("2. 工具注册的动作真的进了模型看到的那份定义");
/* ================================================================== */

{
  captured.length = 0;
  queue.push(textReply("好的，我记住了。"));
  await send("你好");
  await waitIdle();

  const body = captured[0] ?? {};
  const fns = names(body);
  info("发给模型的函数里属于工具的那几个", fns.filter((n) => n.startsWith("tool_")).join(" "));

  check(
    "三个动作都注册成了函数（装上来就有，不需要登记）",
    ["tool_counter_add", "tool_counter_read", "tool_counter_reset"].every((n) => fns.includes(n)),
    fns.filter((n) => n.startsWith("tool_")).join(" "),
  );
  check("内置动作一个都没少", fns.includes("create_schedules") && fns.includes("install_tool"), String(fns.length));

  const add = (body.tools ?? []).find((t) => t?.function?.name === "tool_counter_add");
  info("tool_counter_add", JSON.stringify(add?.function?.parameters));
  check("参数按 manifest 的声明生成（n 是 number）", add?.function?.parameters?.properties?.n?.type === "number");
  check("没声明必填就不写 required", !add?.function?.parameters?.required);
  check(
    "说明里点名了配套的技能（模型知道去哪儿查用法）",
    String(add?.function?.description ?? "").includes("tool-use-counter"),
    String(add?.function?.description ?? "").slice(0, 80),
  );
  const reset = (body.tools ?? []).find((t) => t?.function?.name === "tool_counter_reset");
  check(
    "标了 destructive 的动作在说明里写清会先问",
    String(reset?.function?.description ?? "").includes("先问用户"),
    String(reset?.function?.description ?? "").slice(-40),
  );

  /*
   * 这一条是"工具要配合 skill 传给 AI"的另一半：
   * 只有函数没有说明书，模型知道能调什么、却不知道该怎么用。
   */
  const sys = body.messages?.[0]?.content ?? "";
  check("system prompt 里有这份工具自带的技能", sys.includes("tool-use-counter"));
  check("技能标注了它是工具自带的（不是内置、也不是它自己记的）", sys.includes("（工具自带，随工具装卸）"));
  check("技能带了工具自己写的那条规则", sys.includes("add 不填 n 就按 1 算"), "");
}

/* ================================================================== */
section("3. 没打开也能驱动它：headless 那个一次性实例");
/* ================================================================== */

{
  captured.length = 0;
  queue.push(toolReply("tool_counter_add", { n: 5 }), textReply("已经让计数器加了 5。"));

  // 它**没有**被打开 —— 侧边栏里点都没点过
  check("这个工具此刻没有打开（界面上没有它的 iframe）", (await page.locator('[data-tool-frame="counter"]').count()) === 0);

  await send("让计数器加 5");
  await page.waitForSelector('[data-agent-action="tool_counter_add"]', { timeout: 30000 });
  await waitIdle();

  const card = page.locator('[data-agent-action="tool_counter_add"]').last();
  check("动作卡标了成功", (await card.getAttribute("data-agent-action-ok")) === "1");
  const detail = (await card.locator("pre").first().textContent().catch(() => "")) ?? "";
  info("动作卡细节", detail.replace(/\s+/g, " ").slice(0, 120));
  // 这条是"它回话了"和"我发出去了"的分界：不回结果的话宿主只能等到超时
  check("工具真的回了一个结果（不是发过去了就当成功）", detail.includes("count"), detail.slice(0, 80));
  check("结果是 5（命令真的被执行了，宿主没有自己编一个）", /"count"\s*:\s*5/.test(detail), detail.slice(0, 80));

  /*
   * 隐藏实例是**一次性**的：用完就从 DOM 摘掉。
   * 这条断言"不留后台"—— 否则每驱动一次就多一个看不见的 iframe。
   */
  check("执行完没有留下后台 iframe（一次性实例被回收了）", (await page.locator("[data-tool-headless]").count()) === 0);
  check("也没有被打开成整页工具（用户没要求打开它）", (await page.locator('[data-tool-frame="counter"]').count()) === 0);

  await shot("agent-tool-actions-01-add");
}

/* ================================================================== */
section("4. 标了 destructive 的动作，宿主会替工具问一次");
/* ================================================================== */

{
  queue.push(toolReply("tool_counter_reset", {}), textReply("已经归零了。"));
  await send("把计数器清零");
  await page.waitForSelector("[data-agent-ask]", { timeout: 30000 });

  check("模型直接调了清空的动作，宿主把它拦下来了", (await page.locator("[data-agent-ask]").count()) === 1);
  check("卡的 kind 是 confirm", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-kind")) === "confirm");
  check("来源是 host（是宿主挡的，不是它主动问的）", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-source")) === "host");
  check("卡标了危险", (await page.getAttribute("[data-agent-ask]", "data-agent-ask-danger")) === "1");
  const q = await page.locator("[data-agent-ask-question]").innerText();
  info("确认卡", q.replace(/\n+/g, " | ").slice(0, 120));
  check("问的是中文的工具名与动作名（不是 tool_counter_reset）", q.includes("计数器") && q.includes("reset"), q);
  check(
    "说清了是工具自己标了会改数据",
    (await page.locator("[data-agent-ask-detail]").innerText()).includes("destructive") ||
      (await page.locator("[data-agent-ask-detail]").innerText()).includes("改动或清空数据"),
    (await page.locator("[data-agent-ask-detail]").innerText()).slice(0, 120),
  );
  await shot("agent-tool-actions-02-confirm");

  // 取消 → 不该执行。
  //
  // 判据不是"有没有动作卡"（宿主会留一张写着「你取消了」的卡，那是**应该**有的），
  // 而是那张卡**不是成功** —— 取消之后出现一张绿卡，等于告诉用户已经清零了。
  await page.locator('[data-agent-ask-option="no"]').click();
  await waitIdle();
  const resetCard = page.locator('[data-agent-action="tool_counter_reset"]').last();
  check(
    "取消之后没有成功卡（不会让人以为已经清零）",
    (await resetCard.count()) === 0 || (await resetCard.getAttribute("data-agent-action-ok")) !== "1",
    String(await resetCard.getAttribute("data-agent-action-ok").catch(() => "—")),
  );
  // 拦下之后必须明说"别重试"，否则模型看到没有回音，最常见的反应是再调一次
  check(
    "取消之后明确告诉模型不要重试",
    JSON.stringify(captured.at(-1)?.messages ?? []).includes("不要重试同一个动作"),
    JSON.stringify(captured.at(-1)?.messages ?? []).slice(-200),
  );
}

/* ================================================================== */
section("5. 工具被停用 / 卸掉之后，那几个函数就该消失");
/* ================================================================== */

{
  // 停用它：设置 → 工具 → 关掉「计数器」
  await page.locator("[data-agent-settings]").click();
  await page.waitForSelector("[data-settings]", { timeout: 20000 });
  await page.locator('[data-section="tools"]').click();
  await page.waitForTimeout(400);
  check("设置页里有这个工具（夹具被灌进注册表了）", (await page.locator('[data-tool-row="counter"]').count()) === 1);
  const sw = page.locator('[data-switch="tool-enable-counter"]');
  check("它现在是启用的", (await sw.getAttribute("aria-checked")) === "true");
  await sw.click();
  await page.waitForTimeout(600);
  check("停用开关真的翻过来了", (await sw.getAttribute("aria-checked")) === "false");
  await page.locator('[data-act="close-settings"]').click();
  await page.waitForTimeout(300);

  captured.length = 0;
  queue.push(textReply("嗯。"));
  await gotoAgent();
  await send("再数一次");
  await waitIdle();

  const fns = names(captured[0] ?? {});
  info("停用之后的工具函数", fns.filter((n) => n.startsWith("tool_")).join(" ") || "（一个都没有）");
  check("停用了就不该再出现在能力清单里（助手不能绕过用户的决定）", !fns.includes("tool_counter_add"), fns.filter((n) => n.startsWith("tool_")).join(" "));
  const sys = captured[0]?.messages?.[0]?.content ?? "";
  check("它自带的技能也跟着消失了", !sys.includes("tool-use-counter"));
}

/* ================================================================== */
console.log("\n汇总\n" + "=".repeat(52));
/* ================================================================== */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log("\n没过的：");
  for (const f of failures) console.log("  · " + f);
}
if (errors.length) {
  console.log("\n页面报错：");
  for (const e of errors.slice(0, 8)) console.log("  · " + e);
}

await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
