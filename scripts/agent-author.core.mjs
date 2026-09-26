/**
 * agent-author —— 让**内置 AI 助手**在命令行真写一个工具、真装进工具目录。
 *
 * ------------------------------------------------------------------
 * 为什么要有它
 * ------------------------------------------------------------------
 * 「AI 写工具」这条链的最后一环是 install_tool → 写文件系统。而这一环在
 * Node 与浏览器里都验不了（`canInstallTools()` 就是 `isTauri()`），桌面版的
 * 窗口又自动化点不进去（WebView2 的调试端口窗口太窄，09-19 已查死）。
 * 于是「装完能不能打开」在这之前只能靠人手点一遍 —— 这正是 tests/agent-unit.mjs
 * 顶部那段"这一段覆盖不到什么"写的事。
 *
 * 这个脚本把那段空白补上，做法是**只换 fs，不换逻辑**：
 *   · 助手内核用的是 src 里那套真实代码（protocol.ts / actions.ts / skills.ts /
 *     client.ts / runtime.ts），system prompt、技能全文、权限门、动作分发、
 *     参数修复、回灌，全都是真的；
 *   · 只把两个 Tauri 模块（api/path、plugin-fs）换成 Node 实现（见
 *     scripts/lib/tauri-node/），于是 toolStore.ts 的 installFromHtml 原样执行，
 *     写出来的是**真实的 index.html + manifest.json**；
 *   · 装完再用 tools.ts 自己的 loadTools()/resolveToolUrl() 回扫一遍，
 *     证明"桌面版启动时会看见它、会从哪儿加载它"。
 *
 * 与桌面版的唯一差别：文件落点由 `--tools-root` 决定（默认就是桌面版真正的
 * `%APPDATA%/<identifier>`，所以默认装完桌面版里就能看到）。
 *
 * ------------------------------------------------------------------
 * 用法
 * ------------------------------------------------------------------
 *   # 真跑（需要一个能用的 Key，四家里任选）
 *   node scripts/agent-author.mjs --provider deepseek --api-key sk-xxx \
 *     --prompt "写一个五子棋工具装进工作台"
 *
 *   # 自检：不起真模型，用本地假 SSE 验证"装进磁盘"这条链
 *   node scripts/agent-author.mjs --selftest
 *
 * 参数：
 *   --provider / --api-key / --base-url / --model   助手配置（也可用环境变量
 *       TW_AGENT_PROVIDER / TW_AGENT_KEY / TW_AGENT_BASE_URL / TW_AGENT_MODEL）
 *   --prompt <文字>      这一轮要说的话（默认让它写一个五子棋装进工作台）
 *   --tools-root <目录>  appDataDir 的替身，工具装到 <目录>/tools/<id>/
 *                        （默认 %APPDATA%/com.sogapopo.todo-workbench）
 *   --resource <目录>    resourceDir 的替身（指向安装目录可让内置工具也被扫到）
 *   --selftest           不起真模型，用本地假响应自检
 *   --keep               结束后不删临时自检服务（排查用）
 *
 * 退出码：0 = 这一轮真的装出了工具且能被注册表扫到；1 = 没装出来（原因打在日志里）
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { JSDOM } from "jsdom";

/* ================================================================== */
/* 0. 浏览器环境垫片（db 层要 localStorage / crypto）                   */
/* ================================================================== */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", { value: dom.window.crypto, configurable: true });
}

/* ================================================================== */
/* 1. 参数                                                            */
/* ================================================================== */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const APP_DATA_ROOT =
  opt("tools-root") ||
  process.env.TW_APPDATA ||
  // 默认就是桌面版真正的 appDataDir：装完桌面版里就能看到，这才是"置入工具中"
  path.join(process.env.APPDATA || "", "com.sogapopo.todo-workbench");
const RESOURCE_ROOT = opt("resource") || process.env.TW_RESOURCE || "";
const SELFTEST = flag("selftest");
const PROMPT =
  opt("prompt") || "写一个五子棋小游戏，做成工具装进工作台，我要能跟你下两把。";

// 替身模块在打包时就固定了这个环境变量，所以要在 import 之前设好
process.env.TW_APPDATA = APP_DATA_ROOT;
process.env.TW_RESOURCE = RESOURCE_ROOT;

const say = (...a) => console.log(...a);
const line = (c = "-") => say(c.repeat(64));

/* ================================================================== */
/* 2. 载入被测模块（都是 src 里的真代码）                                */
/* ================================================================== */

const db = await import("../src/lib/db.ts");
const repo = await import("../src/lib/repo.ts");
const settings = await import("../src/lib/settings.ts");
const toolsMod = await import("../src/lib/tools.ts");
const toolStore = await import("../src/lib/toolStore.ts");
const providers = await import("../src/lib/agent/providers.ts");
const runtime = await import("../src/lib/agent/runtime.ts");

/* ================================================================== */
/* 3. 助手配置：写进 core_settings（与界面上"设置 → AI 助手"同一处）      */
/* ================================================================== */

const providerId0 = opt("provider") || process.env.TW_AGENT_PROVIDER || "agnes";
const apiKey0 = opt("api-key") || process.env.TW_AGENT_KEY || "";
const baseUrl0 = opt("base-url") || process.env.TW_AGENT_BASE_URL || "";
const model0 = opt("model") || process.env.TW_AGENT_MODEL || "";

/**
 * `--from-app-db`：直接读**桌面版自己的库**里的助手配置
 * （`%APPDATA%/<identifier>/todo-workbench.db` 的 core_settings）。
 *
 * 为什么要这条：用户已经在「设置 → AI 助手」里填过一次 Key 了，没有理由
 * 再让人把 Key 贴进命令行或者聊天里 —— 那既多余，又多一份泄漏面。
 * 这里只读、只取 `agent.*` 四个键，读不到就退回命令行/环境变量。
 */
let fromDb = {};
if (flag("from-app-db")) {
  // ⚠️ 库的位置**不能跟着 --tools-root 走**：那两者是两件事
  // （工具落在哪 / 配置存在哪），自检时 tools-root 指向临时目录，
  // 配置却仍该从桌面版真正的库里读。
  const APP_DB =
    opt("app-db") ||
    path.join(process.env.APPDATA || "", "com.sogapopo.todo-workbench", "todo-workbench.db");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    if (!fs.existsSync(APP_DB)) throw new Error(`没有这个文件：${APP_DB}`);
    const sq = new DatabaseSync(APP_DB, { readOnly: true });
    const rows = sq.prepare("SELECT key, value FROM core_settings WHERE key LIKE 'agent.%'").all();
    sq.close();
    for (const r of rows) fromDb[r.key] = r.value ?? "";
    const filled = Object.entries(fromDb).filter(([, v]) => v);
    say(`  从桌面版库里读到 agent.* 键 ${rows.length} 个，其中非空 ${filled.length} 个（${APP_DB}）`);
  } catch (e) {
    say(`  ⚠️ --from-app-db 没读成：${e.message}（改用命令行/环境变量）`);
  }
}
const pick = (cliVal, envVal, dbKey, fallback = "") =>
  cliVal || envVal || fromDb[dbKey] || fallback;

const providerId = pick(providerId0, "", settings.SETTINGS.agentProvider, "agnes");
const apiKey = pick(apiKey0, "", settings.SETTINGS.agentApiKey);
const baseUrl = pick(baseUrl0, "", settings.SETTINGS.agentBaseUrl);
let model = pick(model0, "", settings.SETTINGS.agentModel);
if (!model) {
  model = providers.agentProvider(providerId).defaultModel;
}

line("=");
say("agent-author —— 让内置助手真写工具、真装进工具目录");
line("=");
say(`  服务商    ${providers.agentProvider(providerId).name}（${providerId}）`);
say(`  模型      ${model}`);
say(`  地址      ${baseUrl || providers.agentProvider(providerId).defaultBase}`);
say(`  Key       ${apiKey ? `已提供（${apiKey.length} 字符，末 4 位 …${apiKey.slice(-4)}）` : "（空）"}`);
say(`  工具落点  ${path.join(APP_DATA_ROOT, "tools")}`);
say(`  资源目录  ${RESOURCE_ROOT || "（未指定，当作没有内置资源）"}`);
say(`  要它做的  ${PROMPT}`);
line();

/* ================================================================== */
/* 4. 初始化数据层（MemoryDb，与浏览器演示模式同一套）                   */
/* ================================================================== */

db.resetDemoDb();
await db.initDb();
await repo.setSettings({
  [settings.SETTINGS.agentProvider]: providerId,
  [settings.SETTINGS.agentBaseUrl]: baseUrl,
  [settings.SETTINGS.agentApiKey]: apiKey,
  [settings.SETTINGS.agentModel]: model,
});

/**
 * ⚠️ 顺序要紧：initDb() 必须在**打开 isTauri 开关之前**跑完。
 *
 * isTauri() 看的就是 window.__TAURI_INTERNALS__；先打开的话 initDb 会去连
 * Tauri 的 SQLite 插件（这里没有），整个进程起不来。initDb 有单例，之后再
 * 打开开关就不会再去连数据库了 —— 而 install_tool 需要的 canInstallTools()
 * 恰好也是读这个开关。
 */
Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
  value: {},
  configurable: true,
  enumerable: false,
});

say(`  isTauri()            = ${db.isTauri()}`);
say(`  canInstallTools()    = ${toolStore.canInstallTools()}`);
line();

/* ================================================================== */
/* 5. 自检模式：起一个假的 OpenAI 兼容端点（不发真请求、不花额度）        */
/* ================================================================== */

let mockServer = null;
if (SELFTEST) {
  const SELFTEST_HTML = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    "<title>自检小工具</title>",
    "<style>body{font:14px/1.6 system-ui;margin:24px}</style>",
    "</head><body>",
    '<h1 data-role="title">自检小工具</h1>',
    '<button type="button" data-act="ping" id="ping">点一下</button>',
    '<div data-role="out" id="out"></div>',
    "<script>",
    "document.getElementById('ping').addEventListener('click',function(){",
    "  document.getElementById('out').textContent = 'pong ' + new Date().toISOString();",
    "});",
    "</script>",
    "</body></html>",
  ].join("\n");

  /*
   * 2026-09-24 起装工具必须先过沙箱，所以自检也改成**真机那样的两回合**：
   *
   *   回合 1  sandbox_run（把整份源码交给沙箱验）
   *   回合 2  从沙箱回给模型的那句话里取出 ticket，再发 install_tool
   *
   * 这样自检验的是"助手真的会走完这条流水线"，而不是"我手动塞一张票绕过它"。
   * 顺带说明一件事：Node 里没有 iframe，沙箱跑不起来 —— 那时它只过静态体检，
   * 票上如实记着"没试跑过"，装仍然可以进行（见 verifier.ts 的说明）。
   */
  const SCHEMA = {
    tables: [
      {
        name: "clicks",
        columns: [
          { name: "id", type: "text", pk: true },
          { name: "created_at", type: "text" },
        ],
      },
    ],
  };

  const toolCall = {
    index: 0,
    id: "call_selftest_1",
    name: "sandbox_run",
    // 故意把 arguments 切成几片发出去：这顺带验了"tool_calls 按 index 增量拼接"
    args: JSON.stringify({
      id: "selftest-tool",
      name: "自检小工具",
      html: SELFTEST_HTML,
      schema: SCHEMA,
    }),
  };

  const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const wrap = (delta, finish = null) => ({
    id: "chatcmpl-selftest",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  let turn = 0;

  mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      turn++;
      const hasToolResult = /"role"\s*:\s*"tool"/.test(body);
      res.writeHead(200, { "content-type": "text/event-stream" });

      const emit = (name, args) => {
        const a = JSON.stringify(args);
        // 故意切成几片发：顺带验"tool_calls 按 index 增量拼接"
        const parts = [a.slice(0, 40), a.slice(40, 120), a.slice(120)];
        res.write(
          chunk(
            wrap({
              tool_calls: [
                { index: 0, id: toolCall.id, type: "function", function: { name, arguments: "" } },
              ],
            }),
          ),
        );
        for (const p of parts) res.write(chunk(wrap({ tool_calls: [{ index: 0, function: { arguments: p } }] })));
        res.write(chunk(wrap({}, "tool_calls")));
        res.write("data: [DONE]\n\n");
        res.end();
      };

      if (!hasToolResult) {
        // 第一回合：先验（沙箱），源码连着 schema 一起交过去
        res.write(chunk(wrap({ role: "assistant", content: "这就写一个，先放进沙箱跑一遍。" })));
        emit("sandbox_run", {
          id: "selftest-tool",
          name: "自检小工具",
          html: SELFTEST_HTML,
          schema: SCHEMA,
        });
        return;
      }

      // 第二回合：沙箱的结果已经在请求体里了 —— 从里面取出通行证再装
      const ticket = /ticket: (v1\.[^\s\\"]+)/.exec(body)?.[1] ?? "";
      // 只装一次：后面几轮的请求体里**仍然**带着那张票（回灌的 arguments 里有它），
      // 不按回合数卡住的话会一遍遍重装，撞上"目录已存在"
      if (turn === 2 && ticket) {
        res.write(chunk(wrap({ role: "assistant", content: "验过了，装进去。" })));
        emit("install_tool", {
          id: "selftest-tool",
          name: "自检小工具",
          description: "agent-author --selftest 装的验证用工具",
          icon: "star",
          html: SELFTEST_HTML,
          schema: SCHEMA,
          ticket,
        });
        return;
      }

      // 第三回合：装完了，说一句收尾
      res.write(chunk(wrap({ role: "assistant", content: "" })));
      for (const t of ["装好了，", "侧边栏里点「自检小工具」就能用。"]) {
        res.write(chunk(wrap({ content: t })));
      }
      res.write(chunk(wrap({}, "stop")));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  const port = mockServer.address().port;
  await repo.setSettings({
    [settings.SETTINGS.agentProvider]: "custom",
    [settings.SETTINGS.agentBaseUrl]: `http://127.0.0.1:${port}/v1`,
    // Key 不能省：agentConfigProblems 会把"Key 为空"当成没配好，
    // 助手停在门口、一个请求都不发（第一次自检就是这么空转的）。
    [settings.SETTINGS.agentApiKey]: "selftest-local-key",
  });
  say(`  自检端点   http://127.0.0.1:${port}/v1 （假 SSE，不连真模型）`);
  line();
} else if (!apiKey) {
  say("✗ 没有给 Key 就没法真的让模型写东西。");
  say("  真跑：node scripts/agent-author.mjs --provider deepseek --api-key sk-xxx");
  say("  自检：node scripts/agent-author.mjs --selftest");
  process.exit(2);
}

/* ================================================================== */
/* 6. 宿主：桌面上这三个方法分别接 store / 重扫注册表 / 打开工具          */
/* ================================================================== */

const opened = [];
const host = {
  refresh: async () => {},
  reloadTools: async () => {
    // 桌面上这一步是"重扫工具目录，让侧边栏立刻出现新工具"
    const list = await toolsMod.loadTools();
    say(`  ↻ 重扫工具注册表：现在有 ${list.length} 个工具`);
  },
  openTool: (id) => {
    opened.push(id);
    const known = toolsMod.listTools().some((t) => t.id === id);
    return known ? null : `没有 id 为「${id}」的工具`;
  },
};

/**
 * 基线必须在跑之前就取，而且要**先 loadTools() 一次**：
 * 注册表是懒加载的，没扫过的话 listTools() 是空的 —— 那样装完会把
 * 原本就有的工具全算成"新装的"，验收就变成了自欺。
 */
await toolsMod.loadTools();
const before = new Set(toolsMod.listTools().map((t) => t.id));
const beforeList = toolsMod.listTools();
say(`  装之前注册表 ${before.size} 个：${beforeList.map((t) => `${t.id}(${t.source})`).join(", ") || "(空)"}`);
line();

/* ================================================================== */
/* 7. 跑这一轮                                                         */
/* ================================================================== */

line("=");
say("开始跑：模型 → 读技能 → 写 HTML → install_tool → 落盘");
line("=");

let lastPhase = "";
let streamLen = 0;
runtime.subscribe(() => {
  const s = runtime.getState();
  if (s.phase && s.phase !== lastPhase) {
    lastPhase = s.phase;
    say(`\n[${s.phase}]`);
  }
  // 流式文本直接跟着打，让"它在写"这件事看得见
  if (s.streaming && s.streaming.length > streamLen) {
    process.stdout.write(s.streaming.slice(streamLen));
    streamLen = s.streaming.length;
  }
});

const t0 = Date.now();
await runtime.send(PROMPT, host);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const st = runtime.getState();
say("\n");
line();
say(`这一轮结束，用时 ${secs}s，busy=${st.busy}`);
// 助手"停在门口"（配置不全 / 被权限挡）时不会留下消息，只把错误挂在状态上
if (st.error) say(`⚠️ 状态错误：${st.error}`);

/* ---- 动作卡 ---- */
const actions = st.messages.flatMap((m) => m.actions ?? []);
say(`\n动作 ${actions.length} 个：`);
for (const a of actions) {
  say(`  ${a.ok ? "✓" : "✗"} ${a.tool} —— ${a.summary}`);
  if (a.error) say(`      错误：${a.error}`);
  if (a.detail) say(`      ${String(a.detail).split("\n").join("\n      ")}`);
}

/* ---- 助手最后说的话 ---- */
const lastAssistant = [...st.messages].reverse().find((m) => m.role === "assistant" && m.content);
if (lastAssistant) {
  say(`\n助手答复：${lastAssistant.content.slice(0, 800)}`);
}
for (const m of st.messages) {
  if (m.error) say(`\n⚠️ 报错：${m.error}`);
}

/* ================================================================== */
/* 8. 验收：文件在不在、注册表扫不扫得到、桌面版会从哪儿加载              */
/* ================================================================== */

line("=");
say("验收");
line("=");

await toolsMod.loadTools();
const after = toolsMod.listTools();
const added = after.filter((t) => !before.has(t.id));
say(`新装出来的工具：${added.length} 个${added.length ? ` —— ${added.map((t) => `${t.id}(${t.name})`).join(", ")}` : ""}`);

let ok = added.length > 0;

for (const t of added) {
  const dir = await toolStore.toolDir(t.id);
  const entry = path.join(dir, t.entry || "index.html");
  const manifestFile = path.join(dir, "manifest.json");
  const hasEntry = fs.existsSync(entry);
  const hasManifest = fs.existsSync(manifestFile);
  const size = hasEntry ? fs.statSync(entry).size : 0;
  say(`\n  ▸ ${t.id} —— ${t.name}`);
  say(`      目录      ${dir}`);
  say(`      入口      ${hasEntry ? `${path.basename(entry)}（${(size / 1024).toFixed(1)} KB）` : "✗ 不存在"}`);
  say(`      manifest  ${hasManifest ? "√" : "✗ 不存在"}`);
  say(`      来源      ${t.source}    图标 ${t.icon}    版本 ${t.version}`);
  // 表名**必须**走 tools.ts 的 toolTable()：它把 id 里的连字符换成下划线
  // （`selftest-tool` → `tool_selftest_tool_clicks`）。手拼一遍就是"同一条规则
  // 写两处"，迟早漂移 —— 这个项目吃过太多次这种亏。
  const tables = (t.schema?.tables ?? []).map((x) => toolsMod.toolTable(t.id, x.name));
  say(`      数据表    ${tables.join(", ") || "（没有）"}`);

  // 自包含检查：单文件工具不能引用外部资源（打包/桌面端都会挂）
  if (hasEntry) {
    const html = fs.readFileSync(entry, "utf8");
    const ext = [
      ...html.matchAll(/<(?:script|link|img)[^>]*(?:src|href)\s*=\s*["'](?!#|data:)([^"']+)["']/gi),
    ].map((m) => m[1]);
    const remote = ext.filter((u) => /^https?:|^\/\//.test(u));
    say(`      自包含    ${remote.length ? `✗ 有外部引用：${remote.join(", ")}` : "√ 无外部引用"}`);
    if (remote.length) ok = false;
    const acts = new Set([...html.matchAll(/data-act\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
    say(`      data-act  ${acts.size ? [...acts].join(", ") : "（无）"}`);
  }

  const url = await toolsMod.resolveToolUrl(t);
  say(`      加载地址  ${url ?? "✗ 解析不出来（桌面端打开会是空白）"}`);
  if (!hasEntry || !hasManifest || !url) ok = false;
}

if (opened.length) say(`\n宿主被要求打开的：${opened.join(", ")}`);

line();
if (SELFTEST && mockServer && !flag("keep")) mockServer.close();
say(ok ? "✓ 通过：助手真的把工具写进了工具目录，且注册表能扫到它。" : "✗ 没通过：见上面的 ✗ 行。");
process.exit(ok ? 0 : 1);
