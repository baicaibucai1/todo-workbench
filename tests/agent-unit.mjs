/**
 * 内置 AI 助手的 Node 侧验证（不依赖浏览器，也不真的连任何模型）。
 *
 * 分八段：
 *   1. **数据层**（迁移 v15 + core_agent_messages 往返 + agent 视图必须取到空）
 *   2. **技能包**（skills.ts）—— 常驻注入的必须是"硬规则"，全文只能按需取；
 *      并且规则里与代码强耦合的数字/正则必须与代码**同源**，不能各写一份。
 *   3. **服务商注册表**（providers.ts）—— 地址拼接、缺项清单、请求体形状、
 *      各家响应解析、错误状态码翻译成人话。
 *   4. **动作协议**（protocol.ts）—— 两条通道的解析。这一段最要紧的两条是：
 *      "**模型解释自己做了什么时随手写的 JSON 示例不能被当成真动作执行**"
 *      （判错的后果是真的建出双份数据），以及"**参数里的裸换行要能修好，
 *      回灌的 arguments 必须永远是合法 JSON**"（2026-09-23 那条 400 的根因）。
 *   5. **流式读回**（client.ts）—— 把 fetch 换成一个会分片的假响应，
 *      验 SSE 分片不按行切、tool_calls 增量按 index 拼接、以及两条兜底路径。
 *   6. **权限门与动作执行**（actions.ts）—— 用 MemoryDb + 假宿主真跑一遍：
 *      权限关掉必须拒绝且把"去哪儿开"说清楚；建日程必须真的落库。
 *   7. **system prompt**（runtime.ts）—— 权限状态、当前时间、技能摘要、
 *      动作协议是否都进了上下文，以及**全文有没有被误塞进去**。
 *   8. **配置读取、权限解析与启动视图**（settings.ts）
 *
 * ------------------------------------------------------------------
 * 这一段覆盖不到什么（别把绿灯当"整条链都验过了"）
 * ------------------------------------------------------------------
 * **真的把工具写进磁盘**这条路在本机验不了：install_tool 需要 Tauri 的 fs，
 * 而 Node 与浏览器 e2e 里 isTauri() 都是 false，它只会走"诚实的拒绝"分支。
 * 所以本文件验到的是**它拒绝得对不对、参数校验严不严、manifest 组装对不对**；
 * 真正的落盘 + 装完能打开，只能在**打包后的桌面版**里手验
 * （tests/desktop-app.mjs 的注释里记过：WebView2 的调试端口窗口太窄，
 *  自动化点不进去，那条路已经查死）。
 *
 * 用法：
 *   npm run agent:test
 * 或先打包再跑：
 *   node_modules/.bin/esbuild tests/agent-unit.mjs --bundle --platform=node --format=esm \
 *     --target=node22 --outfile=tests/.agent-unit.bundle.mjs --external:jsdom && node tests/.agent-unit.bundle.mjs
 */

import { JSDOM } from "jsdom";

/* ---------- 浏览器环境垫片（db 层要 localStorage / crypto） ---------- */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: dom.window.crypto,
    configurable: true,
  });
}

/* ---------- 极简测试框架（与 smoke.mjs / sync.mjs 一致） ---------- */

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
function section(title) {
  console.log(`\n${title}`);
}

/* ---------- 载入被测模块 ---------- */

const { initDb, resetDemoDb, isTauri } = await import("../src/lib/db.ts");
const { migrations, CURRENT_SCHEMA_VERSION } = await import("../src/lib/migrations.ts");
const repo = await import("../src/lib/repo.ts");
const { CORE_TABLE_LABELS } = await import("../src/lib/dbInspect.ts");
const skills = await import("../src/lib/agent/skills.ts");
const P = await import("../src/lib/agent/providers.ts");
const proto = await import("../src/lib/agent/protocol.ts");
const runtime = await import("../src/lib/agent/runtime.ts");
const { runAction, describeConfirm } = await import("../src/lib/agent/actions.ts");
const { chat, isAbortError, AgentHttpError } = await import("../src/lib/agent/client.ts");
const settings = await import("../src/lib/settings.ts");
const { checkToolId, HTML_MAX_BYTES, buildManifest } = await import("../src/lib/toolStore.ts");
const { toolPrefix, loadTools } = await import("../src/lib/tools.ts");

const { SKILLS } = skills;
const { AGENT_TOOLS } = proto;

/* ---------- 小工具 ---------- */

const ALL_PERMS = { writeTools: true, schedules: true, database: true };
const NO_PERMS = { writeTools: false, schedules: false, database: false };

/** 假宿主：把"界面该做什么"记下来，而不是真去动 store */
function makeHost(over = {}) {
  const calls = { refresh: 0, reloadTools: 0, opened: [] };
  const host = {
    refresh: async () => {
      calls.refresh++;
    },
    reloadTools: async () => {
      calls.reloadTools++;
    },
    openTool: (id) => {
      calls.opened.push(id);
      return id === "ghost" ? "没有 id 为「ghost」的工具" : null;
    },
    ...over,
  };
  return { host, calls };
}

/** 跑一个动作并返回 {action, content}，顺带把异常也变成可断言的结果 */
async function act(name, args, { perms = ALL_PERMS, host = makeHost().host } = {}) {
  return runAction(name, args, { permissions: perms, host });
}

const fresh = async () => {
  resetDemoDb();
  await initDb();
};

/* ================================================================== */
section("1. 数据层：迁移 v16（多会话）、会话与消息往返、agent 视图取到空");
/* ================================================================== */

{
  // 同 sync.mjs 第 1 节：这里守的是"多会话那条迁移已经落地"，用 >= 而不是 ===，
  // 免得下一次升 schema 时，一个跟多会话毫不相干的数字变动把这一整排连带变红
  check(
    "CURRENT_SCHEMA_VERSION 达到 v16（多会话已落地，且只增不减）",
    CURRENT_SCHEMA_VERSION >= 16,
    `实际 v${CURRENT_SCHEMA_VERSION}`,
  );
  const v15 = migrations.find((m) => m.version === 15);
  const v16 = migrations.find((m) => m.version === 16);
  check("v15 / v16 都在", !!v15 && !!v16, `${v15?.name} / ${v16?.name}`);

  const sql15 = (v15?.sql ?? "").replace(/\s+/g, " ");
  check("v15 建了 core_agent_messages", /CREATE TABLE IF NOT EXISTS core_agent_messages/.test(sql15));
  check("v15 给 core_agent_messages 建了 seq 索引", /idx_core_agent_seq/.test(sql15));

  const sql = (v16?.sql ?? "").replace(/\s+/g, " ");
  check("v16 建了 core_agent_chats", /CREATE TABLE IF NOT EXISTS core_agent_chats/.test(sql));
  check("v16 给会话的 updated_at 建了索引", /idx_core_agent_chats_updated/.test(sql));
  check(
    "v16 用 ALTER 给消息加 chat_id（不重建表，老数据不用搬）",
    /ALTER TABLE core_agent_messages ADD COLUMN chat_id/.test(sql),
  );
  check("v16 给 chat_id 建了索引", /idx_core_agent_msg_chat/.test(sql));
  check(
    "v16 把升级前的老消息归到一条「之前的对话」",
    /'chat-legacy'/.test(sql) && /UPDATE core_agent_messages SET chat_id/.test(sql),
  );
  check("v16 的 sql 里没有 DROP / DELETE（迁移只追加）", !/\bDROP\b|\bDELETE\b/i.test(sql));
  check(
    "两张表都有中文名（设置 → 数据库里看得懂）",
    CORE_TABLE_LABELS.core_agent_messages === "AI 助手对话" &&
      CORE_TABLE_LABELS.core_agent_chats === "AI 助手会话",
    `${CORE_TABLE_LABELS.core_agent_messages} / ${CORE_TABLE_LABELS.core_agent_chats}`,
  );

  await fresh();
  const rawDb = (await import("../src/lib/db.ts")).db();

  /* ---- 内存库的 ALTER 必须真给老行补列 ---- */
  // v16 是第一条真的依赖 ALTER 的迁移。内存库不认 ALTER 的话，老快照里的
  // 消息永远拿不到 chat_id → 按会话读时被静默过滤掉（"对话凭空消失"），
  // 而真 SQLite 那边是好的 —— 同一个 bug 只在浏览器 demo 里出现。
  await rawDb.execute(`CREATE TABLE IF NOT EXISTS probe_alter (a TEXT)`);
  await rawDb.execute(`INSERT INTO probe_alter (a) VALUES (?)`, ["老行"]);
  await rawDb.execute(`ALTER TABLE probe_alter ADD COLUMN b TEXT NOT NULL DEFAULT 'def'`);
  const probed = await rawDb.select(`SELECT * FROM probe_alter`);
  check(
    "内存库的 ALTER TABLE 会给已有行补上默认值（不是静默忽略）",
    probed[0]?.b === "def",
    JSON.stringify(probed[0]),
  );

  /* ---- 会话 CRUD ---- */
  const mkChat = (id, title, at) => ({ id, title, createdAt: at, updatedAt: at });
  await repo.createAgentChat(mkChat("c1", "调工具", "2026-09-23T10:00:00.000Z"));
  await repo.createAgentChat(mkChat("c2", "排日程", "2026-09-23T11:00:00.000Z"));

  let chats = await repo.fetchAgentChats();
  check("建了两段对话", chats.length === 2, String(chats.length));
  check(
    "列表按 updated_at 倒序（最近动过的在最前）",
    chats[0].id === "c2" && chats[1].id === "c1",
    chats.map((c) => c.id).join(","),
  );
  check("空会话的条数是 0（不是 undefined）", chats[0].messageCount === 0, String(chats[0].messageCount));

  const row = (over = {}) => ({
    id: over.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    chatId: over.chatId ?? "c1",
    role: over.role ?? "user",
    content: over.content ?? "你好",
    actions: over.actions ?? [],
    error: over.error ?? "",
    seq: over.seq ?? 1,
    createdAt: over.createdAt ?? "2026-09-23T10:00:00.000Z",
  });

  await repo.appendAgentMessage(
    row({ id: "m1", role: "user", content: "帮我建一条日程", seq: 10 }),
  );
  await repo.appendAgentMessage(
    row({
      id: "m2",
      role: "assistant",
      content: "建好了",
      seq: 11,
      actions: [
        { tool: "create_schedules", args: { items: [{ title: "开会" }] }, ok: true, summary: "已建 1 条日程" },
      ],
    }),
  );
  // 另一段里也放一条：用来验证"按会话隔离"（串台是这种改造最容易犯的错）
  await repo.appendAgentMessage(
    row({ id: "x1", chatId: "c2", role: "user", content: "明天下午三点提醒我", seq: 20 }),
  );

  const back = await repo.fetchAgentMessages("c1");
  check(
    "只读到这一段的消息（另一段不会串进来）",
    back.length === 2,
    `${back.length} 条：${back.map((m) => m.id).join(",")}`,
  );
  check("按 seq 正序返回", back[0].id === "m1" && back[1].id === "m2");
  check("role 正确", back[0].role === "user" && back[1].role === "assistant");
  check("content 正确", back[1].content === "建好了");
  check(
    "actions 往返（JSON 列能解回对象）",
    back[1].actions.length === 1 && back[1].actions[0].tool === "create_schedules",
    JSON.stringify(back[1].actions),
  );
  check("actions 里的 args 也保住了", back[1].actions[0].args.items[0].title === "开会");
  check("error 空串往返", back[0].error === "");
  check("seq 保住了（不是行号，是调用方给的）", back[0].seq === 10 && back[1].seq === 11);
  check("chatId 往返", back[0].chatId === "c1" && back[1].chatId === "c1");

  // 反面：手改过库留下的畸形 actions 不能让整个对话读崩
  await repo.appendAgentMessage(row({ id: "m3", role: "assistant", content: "坏的", seq: 12 }));
  await rawDb.execute(`UPDATE core_agent_messages SET actions = ? WHERE id = ?`, ["{不是 JSON", "m3"]);
  const afterBad = await repo.fetchAgentMessages("c1");
  check("坏 actions 当空数组，不抛异常", afterBad.length === 3 && afterBad[2].actions.length === 0);

  // seq 是**跨会话**单调的：切到很久以前那段时，只按当前消息取 max 会让
  // 下一条新消息插进老消息中间
  check("maxAgentSeq 取整张表的最大值（跨会话）", (await repo.maxAgentSeq()) === 20, String(await repo.maxAgentSeq()));

  /* ---- 列表上的两个"现算"字段 ---- */
  chats = await repo.fetchAgentChats();
  const c1 = chats.find((c) => c.id === "c1");
  const c2 = chats.find((c) => c.id === "c2");
  check("条数是现算的（表里没这一列）", c1.messageCount === 3 && c2.messageCount === 1, `${c1.messageCount} / ${c2.messageCount}`);
  check("摘要是这个会话的最后一条（用户消息带「你：」）", c2.preview === "你：明天下午三点提醒我", c2.preview);
  check("助手消息的摘要是「助手：…」", c1.preview.startsWith("助手："), c1.preview);

  /* ---- 改名 / 顶置 / 删除 / 清空 ---- */
  await repo.renameAgentChat("c2", "改过的标题");
  check("改标题落库", (await repo.fetchAgentChats()).find((c) => c.id === "c2").title === "改过的标题");

  await repo.touchAgentChat("c1", "2026-09-24T09:00:00.000Z");
  chats = await repo.fetchAgentChats();
  check("touch 之后它回到列表最前面", chats[0].id === "c1", chats.map((c) => c.id).join(","));

  const removed = await repo.deleteAgentChat("c1");
  check("删会话返回连带删掉的消息条数", removed === 3, String(removed));
  check("会话没了", !(await repo.fetchAgentChats()).some((c) => c.id === "c1"));
  check("它的消息也没了（不留孤儿消息）", (await repo.fetchAgentMessages("c1")).length === 0);
  check("另一段不受影响", (await repo.fetchAgentMessages("c2")).length === 1);

  const cleared = await repo.clearAgentMessages();
  check("清空返回消息条数（所有会话一起）", cleared === 1, String(cleared));
  check("清空连会话一起删（不留空条目）", (await repo.fetchAgentChats()).length === 0);
}

{
  // agent 是"视图"不是"待办的筛选"：取数层必须显式返回空。
  // 漏了这条不会报错，只会让助手界面旁边冒出一整屏待办。
  await fresh();
  const list = await repo.createList("测试清单");
  await repo.createTask({ listId: list.id, title: "不该出现在助手视图里" });

  check("fetchTasks(view:agent) 返回空", (await repo.fetchTasks({ view: "agent" })).length === 0);
  check("fetchTasks(view:agent, includeDone) 也返回空", (await repo.fetchTasks({ view: "agent", includeDone: true })).length === 0);
  check("对照：view:all 能取到那条", (await repo.fetchTasks({ view: "all" })).length === 1);
  check("fetchWorkOrders(view:agent) 返回空", (await repo.fetchWorkOrders({ view: "agent" })).length === 0);
}

/* ================================================================== */
section("2. 技能包：硬规则常驻、全文按需、数字与代码同源");
/* ================================================================== */

{
  check("有 4 份技能", SKILLS.length === 4, String(SKILLS.length));
  const ids = SKILLS.map((s) => s.id);
  check("技能 id 互不重复", new Set(ids).size === ids.length, ids.join(","));
  check("四份分别是写作 / 绑表 / 日程 / 联动", ids.join(",") === "tool-authoring,data-binding,schedule,tool-integration", ids.join(","));

  for (const s of SKILLS) {
    check(`《${s.title}》有 summary`, !!s.summary.trim());
    check(`《${s.title}》至少有 3 条硬规则`, s.rules.length >= 3, String(s.rules.length));
    check(`《${s.title}》有全文`, s.body.length > 400, String(s.body.length));
    // 规则必须是"能被违反"的话，而不是口号 —— 至少得具体到某个数字/格式/路径
    // 规则不许是占位符或半句话（漏写、抄一半会被这一条抓出来）
    check(`《${s.title}》的规则都不空不短`, s.rules.every((r) => r.trim().length >= 12), JSON.stringify(s.rules.map((r) => r.length)));
    // 过半的规则要**点到具体的东西**（字段名 / 格式 / 取值）：
    // 通篇"要仔细一点"的规则集等于没有规则，而那种东西没法被测试证伪。
    // 这里刻意不逐条判语义 —— 判断"这句话够不够具体"是模型自己该做的事，
    // 用正则去判只会写出一条比规则本身更含糊的判据。
    const concrete = s.rules.filter((r) => /[A-Za-z_]{3,}|\d|`|「/.test(r));
    check(`《${s.title}》过半规则点到了具体字段或格式`, concrete.length * 2 >= s.rules.length, `${concrete.length}/${s.rules.length}`);
  }

  check("skillById 命中", skills.skillById("schedule")?.title?.includes("日程") === true);
  check("skillById 未命中返回 undefined", skills.skillById("nope") === undefined);

  // 同源校验：技能里引用的常量必须来自代码，不能手写第二份
  const mb = String(Math.round(HTML_MAX_BYTES / 1024 / 1024));
  const ta = skills.skillById("tool-authoring");
  check(`tool-authoring 的体积上限与 HTML_MAX_BYTES 同源（${mb} MB）`, ta.rules.some((r) => r.includes(`${mb} MB`)), ta.rules[0]);
  check("tool-authoring 写了 id 正则", ta.body.includes("^[a-z][a-z0-9-]{1,31}$"));
  check("前缀示例来自 toolPrefix（不是手抄）", skills.prefixExample("overtime-log") === toolPrefix("overtime-log"), skills.prefixExample("overtime-log"));
  check("前缀示例长这样 tool_overtime_log_", skills.prefixExample("overtime-log") === "tool_overtime_log_");
  check("技能里说的图标清单与 install_tool 的白名单一致（抽查 bot）", ta.body.includes("`bot`"));

  // 常驻注入的那一段
  const block = skills.skillPromptBlock();
  for (const s of SKILLS) {
    check(`注入块含 ${s.id} 的标题`, block.includes(`### ${s.id} · ${s.title}`));
    for (const r of s.rules) check(`注入块含《${s.title}》的这条硬规则`, block.includes(r), r.slice(0, 30));
    // 全文不许常驻：几千字塞进去既贵又会让模型忽略重点
    const marker = s.body.split("\n").find((l) => l.startsWith("## 三、" ) || l.startsWith("## 3") || l.startsWith("## 五、"));
    if (marker) check(`《${s.title}》的全文没有被常驻注入`, !block.includes(marker), marker);
  }
  check("注入块明确了全文要按需取", block.includes("read_skill"));

  const digest = skills.skillsDigest();
  check("skillsDigest 与 SKILLS 同源（界面读的就是它）", digest.length === SKILLS.length && digest[0].rules === SKILLS[0].rules.length);
}

/* ================================================================== */
section("3. 服务商注册表：地址、缺项、请求体、错误翻译");
/* ================================================================== */

{
  check("注册了 4 家", P.AGENT_PROVIDERS.length === 4, String(P.AGENT_PROVIDERS.length));
  check("第一家是 agnes（与 ai-gen 里的同名同源）", P.AGENT_PROVIDERS[0].id === "agnes");
  check("agnes 默认地址带 /v1", P.AGENT_PROVIDERS[0].defaultBase.endsWith("/v1"));
  check("有 aliyun（百炼兼容端点）", P.AGENT_PROVIDERS.some((p) => p.id === "aliyun"));
  check("有 deepseek（官方直连）", P.AGENT_PROVIDERS.some((p) => p.id === "deepseek"));
  check("有 custom（自建网关出口）", P.AGENT_PROVIDERS.some((p) => p.id === "custom"));
  for (const p of P.AGENT_PROVIDERS) {
    check(`${p.id} 有 name/desc/docs/chatPath`, !!p.name && !!p.desc && !!p.docs && p.chatPath.startsWith("/"));
    check(`${p.id} 的 auth 会带上 Key`, Object.values(p.auth("k")).some((v) => String(v).includes("k")));
  }

  // 未知 id 必须落到 custom，**不能**落到第一家：落错方向 = 把 Key 发给一个他没配过的主机
  check("未知 id 回落到 custom", P.agentProvider("who-knows").id === "custom");
  check("空 id 也回落 custom", P.agentProvider("").id === "custom");
  check("已知 id 正常命中", P.agentProvider("deepseek").id === "deepseek");

  check(
    "chatEndpoint 会拼上 /chat/completions",
    P.chatEndpoint({ provider: "agnes", baseUrl: "" }) === "https://apihub.agnes-ai.com/v1/chat/completions",
    P.chatEndpoint({ provider: "agnes", baseUrl: "" }),
  );
  check(
    "结尾多一个斜杠不会拼出双斜杠",
    P.chatEndpoint({ provider: "agnes", baseUrl: "https://x.com/v1/" }) === "https://x.com/v1/chat/completions",
  );
  check(
    "用户把完整端点整条粘进来时不重复拼",
    P.chatEndpoint({ provider: "custom", baseUrl: "https://api.openai.com/v1/chat/completions" }) ===
      "https://api.openai.com/v1/chat/completions",
  );
  check("custom 且没填地址时算不出来（该拦住的拦住了）", P.chatEndpoint({ provider: "custom", baseUrl: "" }) === "");

  const full = { provider: "agnes", baseUrl: "", apiKey: "sk-1", model: "agnes-3.0-flash" };
  check("配全了就没问题", P.agentConfigProblems(full).length === 0);
  check("agentConfigured 同步为真", P.agentConfigured(full) === true);
  const probs = P.agentConfigProblems({ provider: "custom", baseUrl: "", apiKey: "", model: "" });
  check("缺项是一次说全（三项都列出来）", probs.length === 3, probs.join(" / "));
  check("缺 Key 的文案点名是哪一家", P.agentConfigProblems({ ...full, apiKey: "" })[0].includes("Agnes"), P.agentConfigProblems({ ...full, apiKey: "" })[0]);
  check("缺模型的文案说清是「还没有选模型」", P.agentConfigProblems({ ...full, model: "" })[0].includes("模型"));

  const h = P.chatHeaders(full);
  check("请求头带 Bearer", h.Authorization === "Bearer sk-1", String(h.Authorization));
  check("内容类型是 JSON", h["Content-Type"] === "application/json");
  check("没填 Key 时不带 Authorization", !("Authorization" in P.chatHeaders({ provider: "agnes", apiKey: "" })));

  const noTools = P.buildChatBody({ provider: "agnes", model: "m" }, { messages: [], stream: true, tools: null });
  check("不带工具时不带 tools", !("tools" in noTools));
  check("不带工具时不带 tool_choice（否则连「你好」都要走一遍工具）", !("tool_choice" in noTools));
  check("stream 原样传下去", noTools.stream === true);

  const withTools = P.buildChatBody(
    { provider: "agnes", model: "m" },
    { messages: [], stream: true, tools: [{ type: "function" }] },
  );
  check("带工具时带上 tools", Array.isArray(withTools.tools) && withTools.tools.length === 1);
  check("tool_choice 是 auto（它自己决定动不动手）", withTools.tool_choice === "auto");

  // 响应解析（OpenAI 形状）
  const nonStream = P.parseChatResponse({
    choices: [{ message: { content: "好的", tool_calls: [{ id: "c1", function: { name: "list_tools", arguments: "{}" } }] } }],
  });
  check("非流式解析出文本", nonStream.text === "好的");
  check("非流式解析出 tool_calls", nonStream.toolCalls.length === 1 && nonStream.toolCalls[0].name === "list_tools");
  check("缺 id 时补一个（accumulate 逻辑依赖它）", P.parseChatResponse({ choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "{}" } }] } }] }).toolCalls[0].id === "call_0");
  check("流式增量文本解析", P.parseDeltaText({ choices: [{ delta: { content: "你" } }] }) === "你");
  check("空响应不炸", P.parseChatResponse({}).text === "" && P.parseChatResponse({}).toolCalls.length === 0);

  const deltas = P.parseDeltaToolCalls({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "install_tool", arguments: '{"a"' } }] } }],
  });
  check("流式 tool_calls 解析出 index/id/name/args", deltas.length === 1 && deltas[0].index === 0 && deltas[0].id === "c9" && deltas[0].name === "install_tool");
  check("没有 index 时按数组下标兜底", P.parseDeltaToolCalls({ choices: [{ delta: { tool_calls: [{ function: { name: "x" } }] } }] })[0].index === 0);

  check("401 说的是 Key 不对", P.describeHttpError(401, "").includes("API Key"));
  check("403 同上", P.describeHttpError(403, "").includes("API Key"));
  check("404 说的是地址不对", P.describeHttpError(404, "").includes("地址"));
  check("429 说的是限流/余额", P.describeHttpError(429, "").includes("限流"));
  check("5xx 说明是对方的问题", P.describeHttpError(503, "").includes("服务端"));
  check(
    "会从错误体里抠出对方的原话",
    P.describeHttpError(400, JSON.stringify({ error: { message: "model not found" } })).includes("model not found"),
  );
  check("错误体不是 JSON 也不崩", P.describeHttpError(500, "<html>oops</html>").includes("oops"));
}

/* ================================================================== */
section("4. 动作协议：两条通道，以及「不许误执行」");
/* ================================================================== */

{
  check("动作表非空", AGENT_TOOLS.length >= 8, String(AGENT_TOOLS.length));
  const names = AGENT_TOOLS.map((t) => t.name);
  check("动作名互不重复", new Set(names).size === names.length, names.join(","));
  check("八个动作都在", ["read_skill", "list_tools", "read_tool", "install_tool", "open_tool", "bind_database", "list_lists", "list_schedules", "create_schedules"].every((n) => names.includes(n)), names.join(","));

  for (const t of AGENT_TOOLS) {
    check(`${t.name} 有中文短名（用户不该看到 install_tool 这种词）`, !!t.label && !/[a-z_]{4,}/.test(t.label), t.label);
    check(`${t.name} 有给模型看的说明`, t.description.length > 10);
    check(`${t.name} 有参数 schema`, t.parameters && t.parameters.type === "object");
  }
  check("install_tool 需要 writeTools 权限", proto.toolSpec("install_tool").permission === "writeTools");
  check("bind_database 需要 database 权限", proto.toolSpec("bind_database").permission === "database");
  check("create_schedules 需要 schedules 权限", proto.toolSpec("create_schedules").permission === "schedules");
  check("list_tools 不需要权限（只读）", proto.toolSpec("list_tools").permission === undefined);
  check("list_schedules 不需要权限（只读）", proto.toolSpec("list_schedules").permission === undefined);

  const models = proto.toolsForModel();
  check("toolsForModel 默认全给", models.length === AGENT_TOOLS.length);
  check("toolsForModel 是 OpenAI function 形状", models[0].type === "function" && !!models[0].function.name);
  const filtered = proto.toolsForModel((t) => !t.permission);
  /*
    只读的那 6 个 + 「问用户」那 2 个 = 8。
    询问动作**没有权限门**（见第 9 节）：它们不动数据，只说话 ——
    把它们跟着权限一起关掉的话，用户关掉「建日程」之后助手连问一句都不行。
  */
  check("toolsForModel 会按权限过滤（只读 6 个 + 询问 2 个永远给）", filtered.length === 8 && filtered.every((f) => !proto.toolSpec(f.function.name).permission), String(filtered.length));
  check("read_skill 的 id 参数有 enum（避免模型编 id）", Array.isArray(proto.toolSpec("read_skill").parameters.properties.id.enum));

  /* ---- 通道二：文本里的动作块 ---- */

  const one = proto.extractActions(
    '先看一眼现有工具。\n\n```workbench\n{ "tool": "list_tools", "args": {} }\n```\n',
  );
  check("认得正牌 workbench 块", one.actions.length === 1 && one.actions[0].name === "list_tools", JSON.stringify(one.actions));
  check("动作块从正文里被摘掉了（用户不该看到那段 JSON）", !one.cleanText.includes("workbench") && one.cleanText.includes("先看一眼现有工具"), one.cleanText);
  check("正文里没有残留的 JSON", !one.cleanText.includes('"tool"'), one.cleanText);

  const asJson = proto.extractActions('```json\n{"tool":"list_lists","args":{}}\n```');
  check("```json 也认", asJson.actions.length === 1 && asJson.actions[0].name === "list_lists");
  const bare = proto.extractActions('```\n{"tool":"list_lists","args":{}}\n```');
  check("无语言标记也认", bare.actions.length === 1);
  const arr = proto.extractActions('```workbench\n[{"tool":"list_lists","args":{}},{"tool":"list_tools","args":{}}]\n```');
  check("一次多个动作写成数组", arr.actions.length === 2, JSON.stringify(arr.actions));
  const alt = proto.extractActions('```workbench\n{"name":"list_tools","arguments":{}}\n```');
  check("name/arguments 的写法也收（中转会改写形状）", alt.actions.length === 1 && alt.actions[0].name === "list_tools");

  // 最要紧的一条：模型在**解释**自己做了什么时随手写的示例，不能被当成真动作
  const example = proto.extractActions(
    '我调用了这样一个动作：\n\n```js\nconst payload = { tool: "create_schedules", args: { items: [] } };\n```\n\n所以已经建好了。',
  );
  check("```js 里的示例**不会**被执行（判错的后果是双份数据）", example.actions.length === 0, JSON.stringify(example.actions));
  check("该示例仍留在正文里", example.cleanText.includes("create_schedules"));
  const inline = proto.extractActions('它的格式是 {"tool": "list_tools"} 这种。');
  check("正文里的行内 JSON 示例不会被执行", inline.actions.length === 0);

  const unknown = proto.extractActions('```workbench\n{"tool":"launch_missiles","args":{}}\n```');
  check("不认识的动作不产出动作", unknown.actions.length === 0);
  check("不认识的动作会报错（好让模型改）", unknown.errors.length === 1 && unknown.errors[0].includes("launch_missiles"), JSON.stringify(unknown.errors));
  check("报错里列出了可用动作", unknown.errors[0].includes("install_tool"));

  const brokenJson = proto.extractActions('```workbench\n{"tool":"list_tools", "args": {"a": \n}}\n```');
  check("坏 JSON 不产出动作", brokenJson.actions.length === 0);
  check("坏 JSON 会报错并说清怎么改", brokenJson.errors.length === 1 && brokenJson.errors[0].includes("JSON"), JSON.stringify(brokenJson.errors));

  // 同一个模型写的 JSON，在代码块这条通道上一样会带裸换行 ——
  // 两条通道宽容度必须一致，否则"换条通道就又不认了"
  const nlBlock = proto.extractActions(
    '给你。\n\n```workbench\n{"tool":"install_tool","args":{"id":"gomoku","html":"<html>\n<body>棋</body>\n</html>"}}\n```\n',
  );
  check("代码块里的裸换行也修", nlBlock.actions.length === 1, JSON.stringify(nlBlock.errors));
  check("修好的块动作带 repaired 标记", nlBlock.actions[0]?.repaired === true);
  check("修好后内容没丢", String(nlBlock.actions[0]?.args?.html ?? "").includes("棋"));
  check("修成功就不报错", nlBlock.errors.length === 0, JSON.stringify(nlBlock.errors));

  const arrTrailing = proto.extractActions('```workbench\n[{"tool":"list_tools","args":{}},]\n```');
  check("数组带尾逗号也能修（先整串修、再抠花括号，顺序不能反）", arrTrailing.actions.length === 1 && arrTrailing.actions[0].name === "list_tools", JSON.stringify(arrTrailing.actions));

  const notAction = proto.extractActions('```json\n{"total": 3, "items": []}\n```');
  check("普通 JSON 块不报错也不执行", notAction.actions.length === 0 && notAction.errors.length === 0, JSON.stringify(notAction.errors));
  check("普通 JSON 块原样留在正文里", notAction.cleanText.includes('"total"'));

  const brokenFence = proto.extractActions('```workbench\n{"tool":"list_tools"\n');
  check("没闭合的围栏不会吞掉正文", brokenFence.actions.length === 0 && brokenFence.cleanText.includes('"tool"'));

  /* ---- HTML 写在旁边的兜底 ---- */

  const withBlock = proto.extractActions(
    '```workbench\n{"tool":"install_tool","args":{"id":"overtime-log","name":"加班记录"}}\n```\n```html\n<html><body>hi</body></html>\n```',
  );
  check("动作块 + 旁边的 html 块都能被抠出来", withBlock.actions.length === 1 && withBlock.actions[0].args.html === undefined);
  check("htmlFromBlocks 能取到源码", proto.htmlFromBlocks('```html\n<html><body>hi</body></html>\n```') === "<html><body>hi</body></html>");
  check("htmlFromBlocks 不会把没有 html/body 的块当成源码", proto.htmlFromBlocks('```html\n<p>hi</p>\n```') === "");
  const filled = proto.withHtmlFallback("install_tool", { id: "x" }, '```html\n<html><body>hi</body></html>\n```');
  check("html 空着时用旁边的块补上", filled.html === "<html><body>hi</body></html>");
  const kept = proto.withHtmlFallback("install_tool", { id: "x", html: "<html><body>显式</body></html>" }, '```html\n<html><body>旁边</body></html>\n```');
  check("显式给了就以显式为准", kept.html.includes("显式"));
  check("别的动作不做这个兜底", proto.withHtmlFallback("list_tools", {}, '```html\n<html></html>\n```').html === undefined);

  /* ---- 通道一：原生 tool_calls ---- */

  const calls = proto.actionsFromToolCalls([
    { id: "c1", name: "list_tools", args: "{}" },
    { id: "c2", name: "create_schedules", args: '{"items":[{"title":"开会"}]}' },
  ]);
  check("原生 tool_calls 转成动作", calls.actions.length === 2, JSON.stringify(calls.actions));
  check("id 带过来了（回灌 tool 消息要用）", calls.actions[0].id === "c1");
  check("args 是字符串时被解析成对象", calls.actions[1].args.items[0].title === "开会");

  /* ---- 参数里的裸换行：这正是「给我做个五子棋」卡住的那条路 ---- */

  // 模型写 `"html": "<html>\n<body>"` 时给的是**真的换行字节**，不是 \n 两个字符。
  // JSON 不允许字符串里有裸换行，但它自己看不出来 —— 一整份 HTML 里这种地方几十处。
  const bareNl = proto.actionsFromToolCalls([
    { id: "c1", name: "install_tool", args: '{"id":"gomoku","html": "<html>\n<body>\n棋</body>\n</html>"}' },
  ]);
  check("参数里的裸换行会被修复（不修的话整轮对话直接断在 400 上）", bareNl.actions.length === 1, JSON.stringify(bareNl.errors));
  check("修复后内容没缺（换行还原成换行）", !!bareNl.actions[0]?.args?.html?.includes("棋"), String(bareNl.actions[0]?.args?.html));
  check("修复过的调用带 repaired 标记（好提醒模型换写法）", bareNl.actions[0]?.repaired === true);
  check("修复成功就**不该**再报错（报错会让它白改一遍）", bareNl.errors.length === 0, JSON.stringify(bareNl.errors));

  check("尾逗号也修", proto.parseToolArgs('{"id":"x","name":"y",}').ok === true);
  check("参数外面套了代码围栏也修", (() => {
    const r = proto.parseToolArgs('```json\n{"id":"x"}\n```');
    return r.ok && r.args.id === "x";
  })());
  check("本来就合法的不带 repaired 标记", proto.parseToolArgs('{"id":"x"}').repaired === false);

  const notObjArgs = proto.parseToolArgs("[1,2]");
  check("解析得动但不是对象 → not-object（与坏 JSON 分开报）", notObjArgs.ok === false && notObjArgs.reason === "not-object", JSON.stringify(notObjArgs));
  const truncated = proto.parseToolArgs('{"html": "<html><body>');
  check("真坏（截断）的**不硬猜**：报 bad-json（猜错会装上一个坏文件）", truncated.ok === false && truncated.reason === "bad-json", JSON.stringify(truncated));

  const unrepairable = proto.actionsFromToolCalls([{ id: "c1", name: "install_tool", args: '{"html": "<html><body>' }]);
  check("修不动时才跳过这次调用", unrepairable.actions.length === 0 && unrepairable.errors.length === 1, JSON.stringify(unrepairable.errors));
  check("报错里给了具体改法（不是丢一句「不合法」）", unrepairable.errors[0].includes("```html"), unrepairable.errors[0]);

  /* ---- 回灌用的 tool_calls：这里必须永远是合法 JSON ---- */

  const echoCalls = [
    { id: "c1", name: "install_tool", args: '{"id":"a","html": "<html>\n<body></body>\n</html>"}' },
    { id: "c2", name: "list_tools", args: '{"html": "<html><body>' },
  ];
  const echoParsed = proto.actionsFromToolCalls(echoCalls);
  const echo = proto.toolCallsForEcho(echoCalls, echoParsed.actions);
  check(
    "解析不出来的调用不回灌（回灌了服务端会 400 掉整次请求）",
    echo.length === 1 && echo[0].id === "c1",
    JSON.stringify(echo.map((c) => c.id)),
  );
  check(
    "回灌的 arguments 一律是合法 JSON（这次 400 的根因就在这条）",
    echo.every((c) => {
      try {
        JSON.parse(c.function.arguments);
        return true;
      } catch {
        return false;
      }
    }),
    JSON.stringify(echo),
  );
  check("回灌的内容与执行用的参数一致", JSON.parse(echo[0].function.arguments).id === "a");
  check("回灌形状是 OpenAI 的（type=function + name）", echo[0].type === "function" && echo[0].function.name === "install_tool");
  const notObj = proto.actionsFromToolCalls([{ id: "c1", name: "list_tools", args: "[1,2]" }]);
  check("参数不是对象时按空参数处理并说明", notObj.actions.length === 1 && notObj.errors.length === 1);
  const noName = proto.actionsFromToolCalls([{ id: "c1", name: "", args: "{}" }]);
  check("没有函数名的调用被忽略并说明", noName.actions.length === 0 && noName.errors[0].includes("函数名"));
  const unknownCall = proto.actionsFromToolCalls([{ id: "c1", name: "nope", args: "{}" }]);
  check("未知动作的原生调用被拒", unknownCall.actions.length === 0 && unknownCall.errors[0].includes("nope"));
  check("空 args 当空对象（不是报错）", proto.actionsFromToolCalls([{ id: "c1", name: "list_tools", args: "" }]).actions[0].args && Object.keys(proto.actionsFromToolCalls([{ id: "c1", name: "list_tools", args: "" }]).actions[0].args).length === 0);

  const block = proto.actionProtocolBlock();
  for (const t of AGENT_TOOLS) check(`协议说明含 ${t.name}`, block.includes(`\`${t.name}\``));
  check("协议说明教了代码块写法", block.includes("```workbench"));
  check("协议说明强调了别在正文里解释 JSON", block.includes("不要"));
}

/* ================================================================== */
section("5. 流式读回：分片不按行切、tool_calls 按 index 拼接、两条兜底");
/* ================================================================== */

{
  const enc = new TextEncoder();
  const realFetch = globalThis.fetch;
  const streamResp = (chunks, ctype = "text/event-stream") =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(enc.encode(ch));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": ctype } },
    );

  const cfg = { provider: "agnes", baseUrl: "", apiKey: "sk-1", model: "m" };

  /* -- 文本增量 + 分片切在 JSON 中间 -- */
  {
    const seen = [];
    globalThis.fetch = async () =>
      streamResp([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"con',
        'tent":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    const r = await chat(cfg, { messages: [], tools: [], onDelta: (t) => seen.push(t) });
    check("跨分片的 SSE 事件能拼回（buffer 留了半截）", r.text === "你好", JSON.stringify(r.text));
    check("onDelta 逐段回调（打字机效果）", seen.join("") === "你好", JSON.stringify(seen));
    check("DONE 被丢掉，不产生内容", !r.text.includes("DONE"));
  }

  /* -- tool_calls 增量：第一个分片给 id/名字，后面只给 args 片段 -- */
  {
    globalThis.fetch = async () =>
      streamResp([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"create_schedules","arguments":"{\\"items\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[{\\"title\\":\\"开会\\"}]}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    const r = await chat(cfg, { messages: [], tools: [] });
    check("tool_calls 只有一个（按 index 归并，不是两个）", r.toolCalls.length === 1, JSON.stringify(r.toolCalls));
    check("name 拼对了", r.toolCalls[0].name === "create_schedules", r.toolCalls[0].name);
    check("id 保留首个分片给的那个", r.toolCalls[0].id === "c1");
    check("args 片段拼成了合法 JSON", (() => {
      try {
        return JSON.parse(r.toolCalls[0].args).items[0].title === "开会";
      } catch {
        return false;
      }
    })(), r.toolCalls[0].args);
  }

  /* -- 两个并行调用交错到来 -- */
  {
    globalThis.fetch = async () =>
      streamResp([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"list_tools","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"list_lists","arguments":"{}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    const r = await chat(cfg, { messages: [], tools: [] });
    check("同一回合的多个调用都收下并按 index 排序", r.toolCalls.map((c) => c.name).join(",") === "list_tools,list_lists", JSON.stringify(r.toolCalls));
  }

  /* -- 每片都给完整函数名的网关 -- */
  {
    globalThis.fetch = async () =>
      streamResp([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list_tools","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list_tools","arguments":""}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    const r = await chat(cfg, { messages: [], tools: [] });
    check("重复给完整名字不会拼成 list_toolslist_tools", r.toolCalls[0].name === "list_tools", r.toolCalls[0].name);
  }

  /* -- 兜底一：收了 stream:true 却回一整个 JSON -- */
  {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "整段 JSON" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const r = await chat(cfg, { messages: [], tools: [] });
    check("content-type 是 JSON 时走非流式解析（否则表现是「永远不出字」）", r.text === "整段 JSON", r.text);
  }

  /* -- 兜底二：content-type 不像 SSE，但内容是 JSON -- */
  {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "没标 content-type" } }] }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const r = await chat(cfg, { messages: [], tools: [] });
    check("看不到 SSE 事件时把整段当 JSON 再试一次", r.text === "没标 content-type", r.text);
  }

  /* -- 兜底三：既不是 SSE 也不是 JSON，要明确报出来 -- */
  {
    globalThis.fetch = async () => new Response("<!doctype html><html>nope</html>", { status: 200, headers: { "content-type": "text/plain" } });
    let msg = "";
    try {
      await chat(cfg, { messages: [], tools: [] });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check("认不出来的响应有明确报错（不是静默空转）", msg.includes("SSE") || msg.includes("chat/completions"), msg);
  }

  /* -- HTTP 错误：翻译成人话，且带上对方原话 -- */
  {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401, headers: { "content-type": "application/json" } });
    let err = null;
    try {
      await chat(cfg, { messages: [], tools: [] });
    } catch (e) {
      err = e;
    }
    check("401 抛的是 AgentHttpError", err instanceof AgentHttpError, String(err?.name));
    check("状态码带在错误对象上", err?.status === 401);
    check("文案里有「API Key」和对方原话", err.message.includes("API Key") && err.message.includes("Invalid API key"), err?.message);
  }

  /* -- 连不上：要有上下文，不能是一句裸的 Failed to fetch -- */
  {
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    let msg = "";
    try {
      await chat(cfg, { messages: [], tools: [] });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check("连不上时说明了三种可能（含 CORS）", msg.includes("CORS") && msg.includes("地址"), msg);
    check("把原始错误也带上了（好查）", msg.includes("Failed to fetch"));
  }

  /* -- 中止：必须原样抛出去，不能被包装成"连不上" -- */
  {
    globalThis.fetch = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    let err = null;
    try {
      await chat(cfg, { messages: [], tools: [] });
    } catch (e) {
      err = e;
    }
    check("中止被识别为 isAbortError", isAbortError(err) === true);
    check("中止没被当成网络错误", !(err instanceof AgentHttpError));
  }

  /* -- 没配地址时连请求都不发 -- */
  {
    let called = 0;
    globalThis.fetch = async () => {
      called++;
      return streamResp([]);
    };
    let msg = "";
    try {
      await chat({ provider: "custom", baseUrl: "", apiKey: "k", model: "m" }, { messages: [], tools: [] });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check("没地址时不发请求", called === 0);
    check("没地址时告诉去哪儿填", msg.includes("设置"), msg);
  }

  globalThis.fetch = realFetch;
}

/* ================================================================== */
section("6. 权限门与动作执行（MemoryDb + 假宿主，真跑一遍）");
/* ================================================================== */

{
  await fresh();

  /* ---- 权限关掉必须拒绝，且说清去哪儿开 ---- */
  for (const [name, args, label] of [
    ["install_tool", { id: "x-tool", name: "X", html: "<html><body>x</body></html>" }, "写工具"],
    ["bind_database", { tool_id: "x", schema: { tables: [] } }, "绑数据表"],
    ["create_schedules", { items: [{ title: "开会" }] }, "建日程"],
  ]) {
    const r = await act(name, args, { perms: NO_PERMS });
    check(`${name} 在权限关掉时被拒`, r.action.ok === false, r.action.summary);
    check(`${name} 的拒绝理由点名了是哪一项权限`, r.action.error.includes(label), r.action.error);
    check(`${name} 的拒绝理由说了去哪儿开`, r.action.error.includes("设置 → AI 助手 → 权限"), r.action.error);
    check(`${name} 回给模型的话里也带了原因（它只能转述这些）`, r.content.includes(label));
  }

  /* ---- 只读动作不受权限影响 ---- */
  {
    const { host } = makeHost();
    for (const name of ["list_tools", "list_lists", "list_schedules", "read_skill"]) {
      const args = name === "read_skill" ? { id: "schedule" } : name === "list_schedules" ? { range: "all" } : {};
      const r = await act(name, args, { perms: NO_PERMS, host });
      check(`${name} 权限全关时仍然可用（只读）`, r.action.ok === true, r.action.summary);
    }
  }

  /* ---- read_skill ---- */
  {
    const good = await act("read_skill", { id: "tool-authoring" });
    check("read_skill 成功", good.action.ok === true);
    check("read_skill 的 detail 就是全文", good.action.detail === skills.skillById("tool-authoring").body);
    check("read_skill 回给模型的也是全文（这就是按需取的全部实现）", good.content === skills.skillById("tool-authoring").body);
    const bad = await act("read_skill", { id: "nope" });
    check("read_skill 未知 id 时失败并列出可用的", bad.action.ok === false && bad.content.includes("tool-authoring"), bad.content);
    const missing = await act("read_skill", {});
    check("read_skill 缺参数时给出参数名", missing.action.ok === false && missing.action.error.includes("id"), missing.action.error);
  }

  /* ---- list_lists / list_schedules / create_schedules ---- */
  {
    const { host, calls } = makeHost();
    const list = await repo.createList("工作");
    await repo.createTask({ listId: list.id, title: "已存在的事" });

    const ll = await act("list_lists", {}, { host });
    check("list_lists 成功", ll.action.ok === true);
    check("list_lists 统计了未完成条数", JSON.parse(ll.content).lists[0].open === 1, ll.content);
    check("list_lists 的摘要说了几个清单", ll.action.summary.includes("1"), ll.action.summary);

    const ls = await act("list_schedules", { range: "all" }, { host });
    check("list_schedules 成功", ls.action.ok === true);
    check("list_schedules 带回了今天（模型算日期全靠它）", JSON.parse(ls.content).today === repo.today(), ls.content.slice(0, 120));
    check("list_schedules 带回了时区说明", ls.content.includes("timezone_note"));
    check("list_schedules 列出了那条待办", ls.content.includes("已存在的事"));

    const badRange = await act("list_schedules", { range: "yesterday" }, { host });
    check("list_schedules 非法 range 被拒（不是静默当成 all）", badRange.action.ok === false && badRange.action.error.includes("today"), badRange.action.error);

    // 真建日程
    const created = await act(
      "create_schedules",
      {
        items: [
          {
            title: "给客户回电话",
            list: "工作",
            due_date: "2026-10-01",
            due_time: "15:00",
            important: true,
            steps: [{ title: "找出合同", due_at: "2026-10-01T14:00" }],
          },
          { title: "买牛奶", my_day: true },
        ],
      },
      { host },
    );
    check("create_schedules 成功", created.action.ok === true, created.action.error ?? created.action.summary);
    check("create_schedules 摘要报了条数", created.action.summary.includes("2"), created.action.summary);

    const tasks = await repo.fetchTasks({ view: "all" });
    const t1 = tasks.find((t) => t.title === "给客户回电话");
    const t2 = tasks.find((t) => t.title === "买牛奶");
    check("日程真的落库了（不是「它说它建了」）", !!t1 && !!t2, tasks.map((t) => t.title).join(","));
    check("放进指定清单", t1.listId === list.id);
    check("due_date 落库", t1.dueDate === "2026-10-01");
    check("important 落库", t1.important === true);
    check("my_day 落库", t2.myDay === true);
    check("due_time 换算成了 remindAt 时刻", !!t1.remindAt && !Number.isNaN(Date.parse(t1.remindAt)), String(t1.remindAt));
    check("remindAt 与本地 15:00 对得上", new Date(t1.remindAt).getHours() === 15 && new Date(t1.remindAt).getMinutes() === 0, String(t1.remindAt));

    const steps = await repo.fetchAllSteps();
    check("子任务真的建了", (steps[t1.id] ?? []).length === 1, JSON.stringify(steps[t1.id]));
    check("子任务的 due_at 落库了（不设时刻它进不了紧急区）", !!steps[t1.id][0].dueAt && new Date(steps[t1.id][0].dueAt).getHours() === 14);
    check("建完刷新了界面（宿主被调用）", calls.refresh === 1, String(calls.refresh));

    // 单条对象也接受（模型常忘包一层数组）
    const single = await act("create_schedules", { items: { title: "单条写法" } }, { host });
    check("items 是单个对象时也收下", single.action.ok === true && (await repo.fetchTasks({ view: "all" })).some((t) => t.title === "单条写法"));

    check("items 为空时报错", (await act("create_schedules", { items: [] }, { host })).action.ok === false);
    check("缺 title 时报错并点名参数", (await act("create_schedules", { items: [{}] }, { host })).action.error.includes("title"));
    check(
      "due_time 没有 due_date 时报错（别猜是哪天）",
      (await act("create_schedules", { items: [{ title: "x", due_time: "15:00" }] }, { host })).action.error.includes("due_date"),
    );
    check(
      "不存在的日期被挡住（2026-02-30）",
      (await act("create_schedules", { items: [{ title: "x", due_date: "2026-02-30" }] }, { host })).action.ok === false,
    );
    check(
      "日期格式不对时给出正确格式",
      (await act("create_schedules", { items: [{ title: "x", due_date: "10/1" }] }, { host })).action.error.includes("YYYY-MM-DD"),
    );
    check(
      "清单不存在时自动建一个（而不是报错让用户去建）",
      (await act("create_schedules", { items: [{ title: "新清单的事", list: "临时" }] }, { host })).action.ok === true,
    );
    check("自动建的清单真的在", (await repo.fetchLists()).some((l) => l.name === "临时"));

    // 重复一遍不该再建一个同名清单
    const listsBefore = (await repo.fetchLists()).length;
    await act("create_schedules", { items: [{ title: "又一条", list: "临时" }] }, { host });
    check("清单按名字复用（不会每次建一个）", (await repo.fetchLists()).length === listsBefore);
  }

  /* ---- open_tool 走宿主，宿主的错误要能传回来 ---- */
  {
    const { host, calls } = makeHost();
    const ok = await act("open_tool", { id: "image-crop" }, { host });
    check("open_tool 调了宿主", calls.opened.join(",") === "image-crop", calls.opened.join(","));
    check("open_tool 成功", ok.action.ok === true);
    const bad = await act("open_tool", { id: "ghost" }, { host });
    check("宿主打不开时动作是失败的（不能谎报打开了）", bad.action.ok === false);
    check("宿主的原话被带回来", bad.action.error.includes("没有 id 为「ghost」"), bad.action.error);
  }

  /* ---- install_tool：本机（非桌面）必须诚实拒绝 ---- */
  {
    check("本机 isTauri() 为假（Node 里没有 Tauri 运行时）", isTauri() === false);
    const { host, calls } = makeHost();
    const r = await act("install_tool", { id: "overtime-log", name: "加班记录", html: "<html><body>ok</body></html>" }, { host });
    check("浏览器/Node 环境不假装成功", r.action.ok === false, r.action.summary);
    check("摘要说清是「浏览器演示模式」", r.action.summary.includes("浏览器演示模式"), r.action.summary);
    check("回给模型的话指示它去告诉用户怎么装", r.content.includes("导入 HTML 单文件"), r.content);
    check("没写任何文件，也没重扫注册表", calls.reloadTools === 0);
    check("源码留在动作卡上（用户能复制走）", r.action.args.html === "<html><body>ok</body></html>");
  }

  /* ---- install_tool：参数校验在写盘之前 ---- */
  {
    const badId = await act("install_tool", { id: "1bad", name: "X", html: "<html><body>x</body></html>" });
    check("非法 id 被拒（校验在写盘前）", badId.action.ok === false, badId.action.summary);
    const badSchema = await act("install_tool", {
      id: "ok-tool",
      name: "X",
      html: "<html><body>x</body></html>",
      schema: { tables: [{ name: "1bad", columns: [{ name: "id", type: "text", pk: true }] }] },
    });
    check("非法 schema 被拒（不能静默丢表）", badSchema.action.ok === false, badSchema.action.summary);
    check("并指引去读 data-binding 全文", badSchema.action.error.includes("data-binding"), badSchema.action.error);
    const noHtml = await act("install_tool", { id: "ok-tool", name: "X" });
    check("缺 html 时报错并点名", noHtml.action.error.includes("html"), noHtml.action.error);
    const iconNote = await act("install_tool", { id: "ok-tool", name: "X", html: "<html><body>x</body></html>", icon: "不存在的图标" });
    // 本机装不了，所以到不了"已用默认图标"那句摘要 —— 但**必须走到写盘那一步**才算
    // 证明"图标不在白名单"没有让整件事提前失败（图标是装饰，为它失败不值得）
    check("不在白名单的图标不会让整件事失败", iconNote.action.error.includes("浏览器演示模式"), iconNote.action.error);
  }

  /* ---- bind_database：内置工具必须拒绝 ---- */
  {
    const r = await act("bind_database", {
      tool_id: "image-crop",
      schema: { tables: [{ name: "recs", columns: [{ name: "id", type: "text", pk: true }] }] },
    });
    // 本机没有真装工具，listTools() 里可能是空的 —— 两种结果都算"没让它绑成"
    check("给不存在的/内置的工具绑表都不会成功", r.action.ok === false, r.action.summary);
    const badSchema = await act("bind_database", { tool_id: "x", schema: { tables: "nope" } });
    check("bind_database 非法 schema 也是失败", badSchema.action.ok === false);
  }

  /* ---- 未知动作 ---- */
  {
    const r = await act("no_such_action", {});
    check("未知动作返回失败的动作卡（不抛异常）", r.action.ok === false && r.action.error.includes("不认识"), r.action.error);
    check("未知动作的中文名回落到原名（不会崩在 label 查找上）", r.action.tool === "no_such_action");
  }

  /* ---- 参数类型检查 ---- */
  {
    const r = await act("read_skill", { id: 123 });
    check("参数类型不对时说清收到的是什么类型", r.action.ok === false && r.action.error.includes("字符串"), r.action.error);
  }

  /* ---- install_tool 的图标白名单与 skills 里写的清单一致 ---- */
  {
    const ta = skills.skillById("tool-authoring");
    const notIcon = await act("install_tool", { id: "ok-tool", name: "X", html: "<html><body>x</body></html>", icon: "bot" });
    check("白名单里的图标（bot）同样走到写盘那一步", notIcon.action.error.includes("浏览器演示模式"), notIcon.action.error);
    check("skills 里也写了 bot 这个图标", ta.body.includes("`bot`"));
  }
}

/* ================================================================== */
section("7. system prompt：权限、时间、技能摘要、动作协议都在，全文不在");
/* ================================================================== */

{
  const ctx = {
    now: new Date("2026-09-23T21:40:00"),
    permissions: ALL_PERMS,
    tools: [
      { id: "image-crop", name: "图片裁剪", hasSchema: false },
      { id: "overtime-log", name: "加班记录", hasSchema: true },
    ],
    lists: ["工作", "个人"],
    desktop: true,
  };
  const p = runtime.buildSystemPrompt(ctx);

  check("说了现在几点（本地时间两种写法）", p.includes("当前本地时间：2026-09-23 21:40") && p.includes("机器可读：`2026-09-23T21:40`"));
  check("说了今天是周几", p.includes("周三"), p.slice(0, 300));
  check("给了明天 / 昨天的日期（免得它自己算错）", p.includes("今天 = 2026-09-23") && p.includes("明天 = 2026-09-24") && p.includes("昨天 = 2026-09-22"));
  check("说明了是本地墙上时间不是 UTC", p.includes("不是 UTC"));
  check("桌面端说明是「能读写本机文件」", p.includes("桌面版（能读写本机文件）"));
  check("工具清单带 id、名字与有无数据表", p.includes("image-crop（图片裁剪）") && p.includes("overtime-log（加班记录，有数据表）"));
  check("清单列表进来了", p.includes("工作、个人"));
  check("三项权限都标了 ✅", (p.match(/✅/g) ?? []).length === 3, String((p.match(/✅/g) ?? []).length));
  check("权限全开时没有 ⛔", !p.includes("⛔"));

  const p2 = runtime.buildSystemPrompt({ ...ctx, permissions: NO_PERMS });
  check("权限全关时三项都标了 ⛔", (p2.match(/⛔/g) ?? []).length === 3, String((p2.match(/⛔/g) ?? []).length));
  check("关掉时没有 ✅", !p2.includes("✅"));
  check("关掉时指明了去哪儿开", p2.includes("设置 → AI 助手 → 权限"));
  check("关掉时明确要求「不要试图绕过去」并如实告知", p2.includes("绕过去") && p2.includes("如实"));

  const p3 = runtime.buildSystemPrompt({ ...ctx, permissions: { writeTools: false, schedules: true, database: true } });
  check("只关一项时只标一项 ⛔", (p3.match(/⛔/g) ?? []).length === 1);
  check("只关一项时另外两项仍是 ✅", (p3.match(/✅/g) ?? []).length === 2);

  const p4 = runtime.buildSystemPrompt({ ...ctx, desktop: false });
  check("浏览器模式如实说明「装工具做不到」", p4.includes("浏览器演示模式") && p4.includes("做不到"));

  const p5 = runtime.buildSystemPrompt({ ...ctx, tools: [], lists: [] });
  check("没有工具时给一句说明，而不是留空", p5.includes("还没有装任何工具"));
  check("没有清单时也说明会自动建", p5.includes("还没有清单"));

  // 技能：规则在，全文不在
  check("注入了技能段", p.includes("你掌握的技能"));
  for (const s of SKILLS) {
    check(`注入了 ${s.id} 的标题`, p.includes(`### ${s.id} · ${s.title}`));
  }
  check("注入了 tool-authoring 的第一条硬规则", p.includes(SKILLS[0].rules[0].slice(0, 24)), SKILLS[0].rules[0].slice(0, 24));
  const bodyOnly = SKILLS.find((s) => s.body.includes("## 三、和宿主通信（唯一的通道）"));
  check("全文标记确实在 body 里（对照项）", !!bodyOnly);
  check("但**没有**被塞进 system prompt（全文按需取）", !p.includes("## 三、和宿主通信（唯一的通道）"));
  check(
    "prompt 的长度是「摘要级」的（全文会有几万字）",
    p.length < 16000,
    `${p.length} 字符`,
  );

  // 动作协议
  for (const t of AGENT_TOOLS) check(`注入了动作 ${t.name} 的说明`, p.includes(`\`${t.name}\``));
  check("注入了代码块兜底的写法", p.includes("```workbench"));
  check("强调了不许假装（「不许假装」这条在）", p.includes("不许假装"));
  check("说明了流程任务不能创建", p.includes("流程任务") && p.includes("不能创建"));
}

/* ================================================================== */
section("8. 配置读取、权限解析与启动视图");
/* ================================================================== */

{
  const cfg = settings.readAgentConfig({});
  check("空配置默认 agnes", cfg.provider === "agnes", cfg.provider);
  check("空配置模型为空（该报缺项就报）", cfg.model === "");
  const trimmed = settings.readAgentConfig({
    [settings.SETTINGS.agentProvider]: " deepseek ",
    [settings.SETTINGS.agentBaseUrl]: " https://api.deepseek.com ",
    [settings.SETTINGS.agentApiKey]: " sk-x ",
    [settings.SETTINGS.agentModel]: " deepseek-v4-flash ",
  });
  check("provider 去空白", trimmed.provider === "deepseek", `「${trimmed.provider}」`);
  check("地址去空白", trimmed.baseUrl === "https://api.deepseek.com", `「${trimmed.baseUrl}」`);
  check("Key 去空白（带空格的 Key 会得到一个看不出原因的 401）", trimmed.apiKey === "sk-x", `「${trimmed.apiKey}」`);
  check("模型名去空白", trimmed.model === "deepseek-v4-flash", `「${trimmed.model}」`);

  check("默认权限全开（内置助手不能干活就只是更贵的输入框）", Object.values(settings.parseAgentPermissions({})).every(Boolean));
  check("显式 0 才关", settings.parseAgentPermissions({ [settings.SETTINGS.agentPermWriteTools]: "0" }).writeTools === false);
  check("关一项不影响另两项", settings.parseAgentPermissions({ [settings.SETTINGS.agentPermWriteTools]: "0" }).schedules === true);
  check("脏值按开处理（一次意外脏值不该静默阉掉它）", settings.parseAgentPermissions({ [settings.SETTINGS.agentPermSchedules]: "false" }).schedules === true);
  check("空串按开处理", settings.parseAgentPermissions({ [settings.SETTINGS.agentPermSchedules]: "" }).schedules === true);

  check("agent 在启动视图清单里", settings.STARTUP_VIEWS.some((v) => v.value === "agent"));
  check("isStartupView 认 agent", settings.isStartupView("agent") === true);
  check("isStartupView 不认没见过的值", settings.isStartupView("nope") === false);

  check("设置里有三个权限键", [settings.SETTINGS.agentPermWriteTools, settings.SETTINGS.agentPermSchedules, settings.SETTINGS.agentPermDatabase].every((k) => k.startsWith("agent.")));
  check("DEFAULT_SETTINGS 里 agent 相关键都写了默认值", (() => {
    const d = settings.withDefaults({});
    return d[settings.SETTINGS.agentProvider] === "agnes" && d[settings.SETTINGS.agentPermWriteTools] === "1" && d[settings.SETTINGS.agentPermDatabase] === "1";
  })());

  /* ---- manifest 组装（写工具那条路里唯一能在本机验的一段） ---- */
  const m = buildManifest({ id: "overtime-log", name: "加班记录", description: "记加班", icon: "receipt" });
  check("buildManifest 产出合法 id", checkToolId(m.id) === null, String(checkToolId(m.id)));
  check("默认入口是 index.html", m.entry === "index.html");
  check("默认 dbVersion 是 1", m.dbVersion === 1);
  check("没有 schema 时不带 schema 字段", m.schema === undefined);
  const ms = buildManifest({
    id: "overtime-log",
    name: "加班记录",
    schema: { tables: [{ name: "records", columns: [{ name: "id", type: "text", pk: true }, { name: "hours", type: "real" }] }] },
  });
  check("合法 schema 会被带上", !!ms.schema && ms.schema.tables[0].name === "records");
  check("私有表名带上了工具前缀（安全边界）", toolPrefix("overtime-log") + ms.schema.tables[0].name === "tool_overtime_log_records", toolPrefix("overtime-log") + ms.schema.tables[0].name);
  const bad = buildManifest({ id: "ok-tool", name: "X", schema: { tables: [{ name: "1bad", columns: [{ name: "id", type: "text", pk: true }] }] } });
  check("非法 schema 被整份丢掉（宁可没表，也不要半截可用的 schema）", bad.schema === undefined);
}

/* ================================================================== */
section("9. 停下来问用户：协议、三个新动作、强制确认门、挂起与回答");
/* ================================================================== */

{
  /* ---- 协议层：动作定义 ---- */
  {
    const names = AGENT_TOOLS.map((t) => t.name);
    for (const n of ["ask_user_choice", "confirm_action", "update_schedules", "delete_schedules", "update_steps"]) {
      check(`动作表里有了 ${n}`, names.includes(n), names.join(" "));
    }

    // 问用户的两个动作**不需要权限门**：它们不动数据，只说话。
    // 挂权限门的后果是"用户关掉建日程之后，助手连问一句都不行" —— 那不合理。
    check("ask_user_choice 不挂权限门", proto.toolSpec("ask_user_choice").permission === undefined);
    check("confirm_action 不挂权限门", proto.toolSpec("confirm_action").permission === undefined);
    for (const n of ["update_schedules", "delete_schedules", "update_steps"]) {
      check(`${n} 挂了 schedules 权限门`, proto.toolSpec(n).permission === "schedules");
    }

    check("ASK_TOOLS 正好是那两个", proto.ASK_TOOLS.join(",") === "ask_user_choice,confirm_action");
    check("isAskTool 认 ask_user_choice", proto.isAskTool("ask_user_choice"));
    check("isAskTool 认 confirm_action", proto.isAskTool("confirm_action"));
    check("isAskTool 不认 delete_schedules", !proto.isAskTool("delete_schedules"));

    const choice = proto.toolSpec("ask_user_choice").description;
    check("ask_user_choice 的说明里写了「什么时候该用」", choice.includes("什么时候该用"), choice.slice(0, 60));
    check("ask_user_choice 的说明里写了别滥用（能从上下文推断就自己定）", choice.includes("别滥用") && choice.includes("自己定"), choice.slice(0, 200));
    check("ask_user_choice 的说明里限制了次数（一轮最多问一两次）", choice.includes("最多问一两次"), choice.slice(0, 200));
    check("ask_user_choice 的说明点明「要不要动手」归 confirm_action", choice.includes("confirm_action"), choice.slice(0, 200));

    const del = proto.toolSpec("delete_schedules").description;
    // 这条是**防止重复确认**的关键：模型如果先 confirm_action 再 delete_schedules，
    // 用户会被问两遍。说明里必须明说"你直接调，宿主会拦"。
    check("delete_schedules 的说明说清了「不用先 confirm_action」", del.includes("不需要先 confirm_action"), del.slice(0, 120));
    check("delete_schedules 的说明点明了不可逆", del.includes("不可逆"), del.slice(0, 120));

    const steps = proto.toolSpec("update_steps").description;
    check("update_steps 的说明说清了 step_id 从哪儿来", steps.includes("list_schedules"), steps.slice(0, 120));
  }

  /* ---- system prompt 里那一节 ---- */
  {
    const p = runtime.buildSystemPrompt({
      now: new Date("2026-09-23T21:40:00"),
      permissions: ALL_PERMS,
      tools: [],
      lists: [],
      desktop: true,
    });
    check("prompt 里有「什么时候停下来问用户」这一节", p.includes("## 什么时候停下来问用户"));
    check("这一节点名了两个询问动作", p.includes("`ask_user_choice`") && p.includes("`confirm_action`"));
    check("这一节写了不该问的（别把对话变成问卷）", p.includes("不该问的"));
    check("这一节告诉它删除会被宿主自动拦，别换写法重试", p.includes("自动拦") && p.includes("换个写法重试"));
    check("这一节要求问过一次就按回答做", p.includes("问过一次就按他的回答做"));
  }

  /* ---- 三个新动作：真跑一遍库 ---- */
  {
    await fresh();
    const { host, calls } = makeHost();
    const list = await repo.createList("工作");
    const t1 = await repo.createTask({ listId: list.id, title: "给客户回电话", dueDate: "2026-09-25" });
    const t2 = await repo.createTask({ listId: list.id, title: "写周报" });
    const stepA = await repo.createStep(t1.id, "查号码");

    /* -- update_schedules -- */
    const up = await act(
      "update_schedules",
      { items: [{ id: t1.id, title: "给客户回电话（确认过）", due_date: "2026-09-26", important: true }] },
      { host },
    );
    check("update_schedules 成功", up.action.ok === true, up.action.error ?? up.action.summary);
    const after = await repo.fetchTaskById(t1.id);
    check("标题真的改了", after.title === "给客户回电话（确认过）", after.title);
    check("日期真的改了", after.dueDate === "2026-09-26", String(after.dueDate));
    check("重要标记真的改了", after.important === true);
    check("没给的字段保持原样（备注没被清空）", (after.note ?? "") === (t1.note ?? ""));
    check("改完刷了界面（否则用户看不到）", calls.refresh > 0);
    check("摘要报了条数", up.action.summary.includes("1"), up.action.summary);
    check("detail 里点名改了哪些字段", up.action.detail.includes("标题") && up.action.detail.includes("日期"), up.action.detail);

    // 空串 = 去掉日期（这是唯一能"清空"的写法，协议里专门写了）
    const cleared = await act("update_schedules", { items: [{ id: t1.id, due_date: "" }] }, { host });
    check("due_date 给空串能把日期去掉", cleared.action.ok === true && (await repo.fetchTaskById(t1.id)).dueDate === null);

    const noField = await act("update_schedules", { items: [{ id: t2.id }] }, { host });
    check("一个字段都没给时报错并点名是哪条", noField.action.ok === false && noField.action.error.includes("写周报"), noField.action.error);

    const ghost = await act("update_schedules", { items: [{ id: "nope", title: "x" }] }, { host });
    check(
      "id 不存在时报错，并教它重新取 id（而不是让它猜）",
      ghost.action.ok === false && ghost.action.error.includes("list_schedules"),
      ghost.action.error,
    );

    const emptyTitle = await act("update_schedules", { items: [{ id: t2.id, title: "" }] }, { host });
    check("把标题改成空串被拒（空白行不是清空，是坏数据）", emptyTitle.action.ok === false, emptyTitle.action.error);

    /* -- update_steps -- */
    const add = await act("update_steps", { items: [{ op: "add", task_id: t1.id, title: "拨号" }] }, { host });
    check("update_steps add 成功", add.action.ok === true, add.action.error ?? add.action.summary);
    const steps1 = (await repo.fetchAllSteps())[t1.id] ?? [];
    check("子任务真的加进去了（原来 1 条，现在 2 条）", steps1.length === 2, String(steps1.length));

    const target = steps1.find((s) => s.title === "拨号");
    const done = await act("update_steps", { items: [{ op: "done", step_id: target.id, done: true }] }, { host });
    check("update_steps done 成功", done.action.ok === true, done.action.error);
    check("那条真的勾上了", ((await repo.fetchAllSteps())[t1.id] ?? []).find((s) => s.id === target.id).done === true);

    const upd = await act("update_steps", { items: [{ op: "update", step_id: stepA.id, title: "查号码（已核实）" }] }, { host });
    check("update_steps update 成功", upd.action.ok === true, upd.action.error);
    check("子任务标题真的改了", (await repo.fetchAllSteps())[t1.id].find((s) => s.id === stepA.id).title === "查号码（已核实）");

    const delStep = await act("update_steps", { items: [{ op: "delete", step_id: stepA.id }] }, { host });
    check("update_steps delete 成功", delStep.action.ok === true, delStep.action.error);
    check("子任务真的没了", !(await repo.fetchAllSteps())[t1.id].some((s) => s.id === stepA.id));

    const badStep = await act("update_steps", { items: [{ op: "delete", step_id: "ghost" }] }, { host });
    check("step_id 不存在时报错并教它去 list_schedules 取", badStep.action.ok === false && badStep.action.error.includes("list_schedules"), badStep.action.error);

    const badOp = await act("update_steps", { items: [{ op: "rename", step_id: target.id, title: "x" }] }, { host });
    check("不认识的 op 被拒（不是静默跳过）", badOp.action.ok === false, badOp.action.error);

    /* -- delete_schedules -- */
    const del = await act("delete_schedules", { ids: [t2.id], reason: "用户说不用写了" }, { host });
    check("delete_schedules 成功", del.action.ok === true, del.action.error ?? del.action.summary);
    const after2 = await repo.fetchTaskById(t2.id);
    check("那条真的删了（软删后按 id 取不到未完成项）", !after2 || after2.done === true || after2.deletedAt, JSON.stringify(after2));
    check("删除摘要里带了条数", del.action.summary.includes("1"), del.action.summary);
    check("删除回给模型的话里说清没有撤销入口", del.content.includes("没有撤销入口"), del.content);

    const noIds = await act("delete_schedules", { ids: [] }, { host });
    check("ids 为空时报错", noIds.action.ok === false && noIds.action.error.includes("ids"), noIds.action.error);

    const allGone = await act("delete_schedules", { ids: ["ghost-1", "ghost-2"] }, { host });
    check("一个 id 都没找到时报错", allGone.action.ok === false, allGone.action.error);

    /* -- 权限门 -- */
    await fresh();
    const l2 = await repo.createList("工作");
    const t3 = await repo.createTask({ listId: l2.id, title: "x" });
    for (const [name, args] of [
      ["update_schedules", { items: [{ id: t3.id, title: "y" }] }],
      ["delete_schedules", { ids: [t3.id] }],
      ["update_steps", { items: [{ op: "add", task_id: t3.id, title: "s" }] }],
    ]) {
      const r = await act(name, args, { perms: NO_PERMS });
      check(`${name} 在权限关掉时被拒`, r.action.ok === false, r.action.summary);
      check(`${name} 的拒绝理由点名了「建日程」`, r.action.error.includes("建日程"), r.action.error);
      check(`${name} 的拒绝理由说了去哪儿开`, r.action.error.includes("设置 → AI 助手 → 权限"));
    }
  }

  /* ---- 强制确认门 describeConfirm ---- */
  {
    await fresh();
    const list = await repo.createList("工作");
    const a = await repo.createTask({ listId: list.id, title: "交房租" });
    const b = await repo.createTask({ listId: list.id, title: "体检" });
    const st = await repo.createStep(a.id, "取现金");

    const cd = await describeConfirm("delete_schedules", { ids: [a.id, b.id], reason: "用户说这些不用了" });
    check("删除待办要确认", !!cd);
    check("确认卡标了危险", cd.danger === true);
    check("确认卡的问题里带了条数", cd.question.includes("2"), cd.question);
    // 只写"要删 2 条吗"等于让用户盲签 —— id 是 uuid，他没法核对
    check("确认卡列出了要删的**标题**", cd.detail.includes("交房租") && cd.detail.includes("体检"), cd.detail);
    check("确认卡说了没有撤销入口", cd.detail.includes("没有撤销入口"), cd.detail);
    check("确认卡带上了助手说的原因", cd.detail.includes("用户说这些不用了"), cd.detail);
    check("确认后本轮不再重复问（affects）", cd.affects.includes("delete_schedules"));

    check("ids 为空时不弹确认卡（执行时会报错，不必先打扰）", (await describeConfirm("delete_schedules", { ids: [] })) === null);

    const sd = await describeConfirm("update_steps", { items: [{ op: "delete", step_id: st.id }] });
    check("删子任务要确认", !!sd);
    check("删子任务的确认卡列出了子任务标题", sd.detail.includes("取现金"), sd.detail);
    check("删子任务的 affects 是 update_steps", sd.affects.includes("update_steps"));

    check(
      "改子任务（只加不改删）不打扰",
      (await describeConfirm("update_steps", { items: [{ op: "add", task_id: a.id, title: "x" }] })) === null,
    );
    check("改待办不打扰（改不是删，可回退）", (await describeConfirm("update_schedules", { items: [{ id: a.id, title: "y" }] })) === null);
    check("只读动作不打扰", (await describeConfirm("list_schedules", { range: "all" })) === null);

    /*
      批量改动要问 —— 用户点名的"重要变动"里，除了删除还有**批量修改**。
      改 1 条改错了他一眼能看出来；一次改 12 条，改错了他要一条条找回来，
      而那些改动分散在不同清单、不同日期里，事后拼不回原样。
      阈值是 4：3 条以内他心里有数，4 条以上就只能靠信任了。
    */
    const batch3 = await describeConfirm("update_schedules", {
      items: [{ id: a.id }, { id: b.id }, { id: a.id }].map((x) => ({ ...x, title: "改名" })),
    });
    check("改 3 条不打扰（还在「心里有数」的范围内）", batch3 === null);

    const batch4 = await describeConfirm("update_schedules", {
      items: [a.id, b.id, a.id, b.id].map((id) => ({ id, title: "改名" })),
    });
    check("改 4 条要确认（这就是「批量修改」）", !!batch4);
    check("批量确认卡的问题里带了条数", batch4.question.includes("4"), batch4.question);
    check("批量确认卡列出了被改的标题", batch4.detail.includes("交房租"), batch4.detail);
    check("批量确认卡说明了为什么问（改错要一条条找回来）", batch4.detail.includes("一条条找回来"), batch4.detail);
    check("批量确认卡的 affects 是 update_schedules", batch4.affects.includes("update_schedules"));

    const batchSteps = await describeConfirm("update_steps", {
      items: [1, 2, 3, 4].map((i) => ({ op: "add", task_id: a.id, title: `第${i}步` })),
    });
    check("批量改子任务也要确认", !!batchSteps);
    check("批量改子任务的确认卡也是 4 条起", batchSteps.question.includes("4"), batchSteps.question);

    // 注册表是懒加载的（应用启动时才扫），单测里得自己拉一次，
    // 否则 listTools() 是空的，"覆盖已有工具"这个分支根本进不去
    await loadTools();
    const ow = await describeConfirm("install_tool", { id: "image-crop", overwrite: true });
    check("覆盖已装的工具要确认", !!ow);
    check("覆盖确认卡写清了现在装的是哪个版本", ow.detail.includes("图片裁剪"), ow.detail);
    check(
      "覆盖确认卡警告了手工改动会一起消失",
      ow.detail.includes("一起消失"),
      ow.detail,
    );
    check("没开 overwrite 时不打扰", (await describeConfirm("install_tool", { id: "image-crop", overwrite: false })) === null);
    check("覆盖一个还不存在的工具时不打扰（那等于新装）", (await describeConfirm("install_tool", { id: "brand-new-tool", overwrite: true })) === null);
  }

  /* ---- 询问动作不能被直接执行（得在对话流程里） ---- */
  {
    const r = await act("ask_user_choice", { question: "哪个？", options: [{ label: "A" }] });
    check("runAction 直接调 ask_user_choice 被拒", r.action.ok === false, r.action.summary);
    check("拒绝理由说清了它得在对话流程里用", r.content.includes("对话流程"), r.content);
  }

  /* ---- 挂起：模型问 → 界面答 → 那一轮接着跑完 ---- */
  {
    await fresh();
    const enc = new TextEncoder();
    const sse = (chunks) =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(enc.encode(ch));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    /*
      SSE 事件**必须用对象拼**，不要手写字面量。
      手拼括号多一个少一个，handleEvent 里的 JSON.parse 会被 try/catch
      静默吞掉 —— 症状是"模型好像什么都没说"，而真正的错误在测试代码里，
      查起来非常贵（这次就栽在这儿）。
    */
    const askEvent =
      "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  function: {
                    name: "ask_user_choice",
                    arguments: JSON.stringify({
                      question: "周报写成哪种？",
                      options: [
                        { value: "brief", label: "简短版" },
                        { value: "full", label: "详细版" },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      }) +
      "\n\n";
    const textEvent =
      "data: " + JSON.stringify({ choices: [{ delta: { content: "好，按简短版写。" } }] }) + "\n\n";

    let turn = 0;
    globalThis.fetch = async () => {
      turn++;
      if (turn === 1) return sse([askEvent, "data: [DONE]\n\n"]);
      return sse([textEvent, "data: [DONE]\n\n"]);
    };

    await repo.setSetting(settings.SETTINGS.agentProvider, "agnes");
    await repo.setSetting(settings.SETTINGS.agentBaseUrl, "https://example.invalid/v1");
    await repo.setSetting(settings.SETTINGS.agentApiKey, "sk-test");
    await repo.setSetting(settings.SETTINGS.agentModel, "m1");

    runtime.__resetRuntime();
    await runtime.ensureLoaded();
    check("起跑时没有挂起的问题", runtime.hasPendingAsk() === false);
    check("没有挂起问题时 answerAsk 返回 false（连点两下不会误答）", runtime.answerAsk("brief", "简短版") === false);

    const { host } = makeHost();
    const done = runtime.send("写周报", host);

    // 等它问出来
    for (let i = 0; i < 60 && !runtime.hasPendingAsk(); i++) await new Promise((r) => setTimeout(r, 20));
    const s1 = runtime.getState();
    check("助手真的卡在等用户（hasPendingAsk）", runtime.hasPendingAsk() === true);
    check("界面上出现了问题卡", !!s1.ask, JSON.stringify(s1.ask));
    check("问题卡的 kind 是 choice", s1.ask?.kind === "choice");
    check("问题卡标了来源是模型（不是宿主拦的）", s1.ask?.source === "model");
    check("问题卡原样带了提问", s1.ask?.question === "周报写成哪种？", String(s1.ask?.question));
    check("问题卡原样带了选项", s1.ask?.options.map((o) => o.value).join(",") === "brief,full");
    check("等用户时 busy 仍是 true（输入框不该解锁）", s1.busy === true);
    check("阶段提示说的是在等你", (s1.phase ?? "").includes("等"), String(s1.phase));

    // 用户点「详细版」
    check("回答成功（有等待中的问题）", runtime.answerAsk("full", "详细版") === true);
    await done;

    const s2 = runtime.getState();
    check("答完之后不再挂起", runtime.hasPendingAsk() === false);
    check("答完之后界面上的卡片收掉了", s2.ask === null);
    check("那一轮跑完了（busy 落回 false）", s2.busy === false);
    const last = s2.messages[s2.messages.length - 1];
    check("最后一轮是助手的回复", last?.role === "assistant");
    check("历史里留下了这次询问的动作卡", last?.actions.some((a) => a.tool === "ask_user_choice"), JSON.stringify(last?.actions.map((a) => a.tool)));
    const askAction = last?.actions.find((a) => a.tool === "ask_user_choice");
    check("动作卡上记的是**用户的答案**不是空白", (askAction?.summary ?? "").includes("详细版"), String(askAction?.summary));
    check("问过之后模型接着把话说完了", (last?.content ?? "").includes("简短版"), String(last?.content));

    // 中止：正在等的时候停止那一轮，不能永远卡住
    runtime.__resetRuntime();
    await runtime.ensureLoaded();
    turn = 0;
    globalThis.fetch = async () => sse([askEvent, "data: [DONE]\n\n"]);
    const done2 = runtime.send("再问一次", host);
    for (let i = 0; i < 60 && !runtime.hasPendingAsk(); i++) await new Promise((r) => setTimeout(r, 20));
    check("第二轮也问出来了", runtime.hasPendingAsk() === true);
    runtime.abort();
    await done2;
    const s3 = runtime.getState();
    check("停止之后不再挂起（否则 busy 永远 true，用户只能重启）", runtime.hasPendingAsk() === false);
    check("停止之后 busy 落回 false", s3.busy === false);
    check("停止之后卡片收掉了", s3.ask === null);

    runtime.__resetRuntime();
  }
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
process.exit(failed ? 1 : 0);

