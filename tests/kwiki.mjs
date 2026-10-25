/**
 * WPS 知识库（kwiki）联动的 Node 侧验证（不连网、不启动真应用）。
 *
 * 覆盖四层：
 *   1. **纯函数**：状态派生、比对锚点 —— 与工具里的 statusOf 必须同一套口径；
 *   2. **跨文件一致性**：`src/lib/kwiki.ts` 的 COLUMNS 与
 *      `src-tauri/src/wps_cloud_plan.rs` 的 COLUMNS 是同一份约定的两个拷贝，
 *      这里逐条比对（改一处忘另一处，症状是"推上去的表头和拉回来的映射对不上"，
 *      极难手查）；
 *   3. **写库往返**：拉取计划怎么变成数据库里的行（内存库，走应用自己的事务）；
 *   4. **门禁**：网页端必须明确报错，不能静默失败。
 *
 * 用法：
 *   npm run kwiki:test
 */

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ---------- 浏览器环境垫片（db 层要 localStorage） ---------- */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

/* ---------- 极简测试框架（与 smoke.mjs 一致） ---------- */

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
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/* ---------- 载入被测模块 ---------- */

const { initDb, resetDemoDb, db } = await import("../src/lib/db.ts");
const K = await import("../src/lib/kwiki.ts");
const { loadTools } = await import("../src/lib/tools.ts");

/* ---------- 小工具 ---------- */

/** 一行台账。只填有意义的字段，其余留空串（与工具里 add() 的形态一致） */
const row = (over = {}) => ({
  order_sn: "",
  tracking_no: "",
  courier: "",
  shipped_at: "",
  store: "",
  category: "",
  title: "",
  handling: "",
  result: "",
  settled: "",
  note: "",
  created_at: "",
  updated_at: "",
  ...over,
});

/* ================= 1. 纯函数 ================= */

section("1. 状态派生与比对锚点");
{
  check(
    "没流程、没处理 → 待处理",
    K.statusOf(row()) === "待处理",
    K.statusOf(row()),
  );
  check(
    "补了处理方式 → 处理中",
    K.statusOf(row({ handling: "已联系快递" })) === "处理中",
  );
  check(
    "补了结果 → 已关闭",
    K.statusOf(row({ result: "已退款" })) === "已关闭",
  );
  check(
    "有流程 → 看最后一步（优先于派生）",
    K.statusOf(row({ result: "已退款", flow: JSON.stringify([{ n: "平台申诉中", t: "2026-10-01T00:00:00Z" }]) })) ===
      "平台申诉中",
  );
  check(
    "流程是坏 JSON 时按没记过算",
    K.statusOf(row({ flow: "{不是JSON", handling: "补发中" })) === "处理中",
  );
  check(
    "流程里没有有效步骤时按没记过算",
    K.statusOf(row({ flow: JSON.stringify([{ n: "  ", t: "" }]) })) === "待处理",
  );
  check(
    "收尾步名原样当状态（不做整名匹配以外的解释）",
    K.statusOf(row({ flow: JSON.stringify([{ n: "完结", t: "x" }]) })) === "完结",
  );

  check("订单号优先当锚点", K.keyOf(row({ order_sn: "A1", tracking_no: "T1" })) === "A1");
  check("没有订单号才用快递单号", K.keyOf(row({ tracking_no: " T1 " })) === "T1");
  check("两个都没有 → 空（不当数据）", K.keyOf(row()) === "");
}

/* ================= 2. 跨文件一致性 ================= */

section("2. COLUMNS 与 Rust 侧逐条一致");
{
  // 从 Rust 侧把 COLUMNS 那段抠出来。这段必须比对：两侧是手抄的两份，
  // 漂移了不会有任何报错，只会让表头和映射对不上。
  // 定义在 wps_cloud_plan.rs（纯逻辑 + 离线断言那个文件），wps.rs 只是 import —— 
  // 所以定点检查要认准前者，别再回 wps.rs 里找。
  const rs = read("src-tauri/src/wps_cloud_plan.rs");
  const block = /const COLUMNS[^\[]*\[([\s\S]*?)\];/.exec(rs);
  check("wps_cloud_plan.rs 里找得到 COLUMNS", !!block);
  check("wps.rs 从那里 import（不是自己又抄了一份）", /wps_cloud_plan::\{[^}]*COLUMNS/.test(read("src-tauri/src/wps.rs")));
  const rust = block
    ? [...block[1].matchAll(/\(\s*"([a-z_]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((m) => [m[1], m[2]])
    : [];
  const ts = K.COLUMNS.map(([c, h]) => [c, h]);
  check(
    `列数一致（${ts.length}）`,
    rust.length === ts.length,
    `rust=${rust.length} ts=${ts.length}`,
  );
  const drift = ts.filter(([c, h], i) => rust[i]?.[0] !== c || rust[i]?.[1] !== h);
  check("逐列（列名 + 表头）没有漂移", drift.length === 0, JSON.stringify(drift));
  check(
    "_status 是派生列，且排在结账之后",
    ts[10]?.[0] === "_status",
    JSON.stringify(ts[10]),
  );

  // 工具侧：拉取写库后必须刷新界面，否则数据库变了、界面还是旧的
  const html = read("tools/abnormal-ticket/index.html");
  check(
    "工具监听了 kwiki:pulled 事件",
    html.includes('m.event === "kwiki:pulled"'),
  );
  check(
    "监听后调了 load()（不是只弹个提示）",
    /m\.event === "kwiki:pulled"[\s\S]{0,200}load\(\)/.test(html),
  );
  // 不写死版本号（改一次版本就得改一次测试，没意义）—— 只看两边**一致**
  {
    const ver = JSON.parse(read("tools/abnormal-ticket/manifest.json")).version;
    const hit = /id: "abnormal-ticket",\s*\n\s*name: "异常单号登记",\s*\n\s*version: "([^"]+)"/.exec(
      read("src/lib/tools.ts"),
    );
    check(
      "manifest 与 BUILTIN_TOOLS 的版本一致",
      !!hit && hit[1] === ver,
      "manifest=" + ver + " / BUILTIN_TOOLS=" + (hit ? hit[1] : "没找到"),
    );
  }

  /* ---- 工具自带 WPS 接入（2026-10-19 起） ----
   * 认表只靠分享链接，推 / 拉都走宿主那套 14 列对账。
   * 这几条是防"又有人把对账逻辑抄进工具页"的回潮检查。 */
  const mf = JSON.parse(read("tools/abnormal-ticket/manifest.json"));
  check("工具声明了 wps 能力", (mf.capabilities || []).includes("wps"));
  check(
    "工具设置页有「在线表格」那张卡，且标了 data-host-only",
    /id="wpsLink"/.test(html) && /<div class="card[^"]*"[^>]*data-host-only[^>]*>\s*\n\s*<h2>在线表格/.test(html),
  );
  check(
    "工具只喊推 / 拉 / 确认，自己不做比对",
    html.includes('"wps.mcpPush"') &&
      html.includes('"wps.mcpPull"') &&
      html.includes('"wps.mcpApply"') &&
      html.includes('"wps.mcpLink"') &&
      // 工具页里不许再出现一份"认列/写列"的实现
      !/planPull|COLUMNS\s*=\s*\[/.test(html),
  );
  const bridge = read("src/lib/toolBridge.ts");
  check(
    "桥接开了这四个 op，且都在 wps 能力门里",
    ["wps.mcpLink", "wps.mcpPush", "wps.mcpPull", "wps.mcpApply"].every((op) =>
      bridge.includes(`"${op}"`),
    ),
  );
  check(
    "对账仍走 Rust 那份 plan_cloud_write（不是工具侧另算）",
    bridge.includes("mcpSheetPush") && bridge.includes("readLedger") && bridge.includes("planPull"),
  );
}

/* ================= 3. 拉取比对 ================= */

section("3. planPull：新增 / 改动 / 空值不覆盖");
{
  const local = [
    row({ id: "t1", order_sn: "A1", store: "甲店", category: "破损", created_at: "2026-10-01T00:00:00Z" }),
    row({ id: "t2", tracking_no: "T2", store: "乙店", handling: "已联系快递" }),
  ];
  const remote = [
    // 新增：本地没有这个单号
    row({ order_sn: "A9", store: "丙店", category: "少件" }),
    // 改动：情况换了、店铺没变
    row({ order_sn: "A1", store: "甲店", category: "丢件" }),
    // 空值不当改动：对面这列是空的，不能把本地"已联系快递"抹掉
    row({ tracking_no: "T2", store: "", handling: "" }),
    // 两个键都没有 → 直接丢
    row({ store: "丁店" }),
  ];
  const plan = K.planPull(remote, local);
  check("新增 1 条", plan.adds.length === 1, JSON.stringify(plan.adds.map((r) => r.order_sn)));
  check("更新 1 条", plan.updates.length === 1, String(plan.updates.length));
  check(
    "差异列只有情况（店铺没变、空值不算改动）",
    plan.updates[0] && Object.keys(plan.updates[0].patch).join(",") === "category",
    JSON.stringify(plan.updates[0]?.patch),
  );
  check(
    "更新挂在本地那一行上（带本机 id）",
    plan.updates[0]?.row.id === "t1",
    String(plan.updates[0]?.row.id),
  );

  // _status 是对面推上来给人看的，拉回来绝不写库
  const withStatus = K.planPull(
    [row({ order_sn: "A1", store: "甲店", category: "丢件", _status: "已关闭" })],
    local,
  );
  check(
    "_status 不进 patch",
    withStatus.updates[0] && !("_status" in withStatus.updates[0].patch),
    JSON.stringify(withStatus.updates[0]?.patch),
  );
}

/* ============ 3b. 表上的时间列是「显示文本」，不能当改动 ============ */

section("3b. sameCell：时间列的显示格式不算改动（2026-10-25 实踩）");
{
  /* 在线表格把 "2026-10-25 17:33" 当日期值存，读回来是显示文本：
     斜杠分隔，列格式只有日期时连时刻都没有。纯文本比较的结果是
     每次启动对账都报「发货时间不一样」、每次推送都重写这几格。 */
  check("斜杠与横杠是同一天", K.sameCell("2026/10/25 17:10", "2026-10-25 17:10"));
  check("只有日期 == 同一天的带时刻", K.sameCell("2026/10/25", "2026-10-25 17:33"));
  check("ISO 的 T 也认", K.sameCell("2026-10-25T17:33", "2026-10-25 17:33"));
  check("日期真变了不算同一个", !K.sameCell("2026/10/25", "2026-10-26 17:33"));
  check("同一天换了时刻不算同一个", !K.sameCell("2026-10-25 17:10", "2026-10-25 18:10"));
  check("普通文本仍然严格比", !K.sameCell("申通", "中通"));

  const local = [
    row({
      id: "t1",
      order_sn: "261023-225527806352802",
      shipped_at: "2026-10-25 17:33",
      created_at: "2026-10-25 17:33",
      updated_at: "2026-10-25 19:08",
    }),
  ];
  const remote = [
    row({
      order_sn: "261023-225527806352802",
      shipped_at: "2026/10/25",
      created_at: "2026/10/25 17:33",
      updated_at: "2026/10/25 19:08",
    }),
  ];
  const plan = K.planPull(remote, local);
  check("一样的时刻：不产生改动（否则每次启动都报假差异）",
    plan.updates.length === 0, JSON.stringify(plan.updates));

  const changed = K.planPull([row({ order_sn: "261023-225527806352802", shipped_at: "2026/10/26" })], local);
  check("日期真变了：还是要改，且落库时换成横杠写法",
    changed.updates.length === 1 && changed.updates[0].patch.shipped_at === "2026-10-26",
    JSON.stringify(changed.updates[0]?.patch));
}

/* ================= 4. 写库往返 ================= */

section("4. applyPull：写进数据库，再读回来");
{
  resetDemoDb();
  await initDb();
  await loadTools(); // 注册表里要有 abnormal-ticket，ensureLedgerTable 才拿得到 manifest

  const before = await K.readLedger();
  check("空库读出来是空的", before.length === 0, String(before.length));

  const plan = K.planPull(
    [
      row({ order_sn: "A1", store: "甲店", category: "破损", created_at: "2026-10-01T00:00:00Z" }),
      row({ order_sn: "A2", tracking_no: "T2", store: "乙店", handling: "补发中" }),
    ],
    [],
  );
  const r1 = await K.applyPull(plan);
  check("写库报告 新增 2", r1.added === 2 && r1.updated === 0, JSON.stringify(r1));

  const after = await K.readLedger();
  check("读回来 2 行", after.length === 2, String(after.length));
  const a1 = after.find((r) => r.order_sn === "A1");
  check("值原样落库（店铺/情况）", a1?.store === "甲店" && a1?.category === "破损", JSON.stringify(a1));
  check("id 是工具那个 t- 前缀", /^t-[0-9a-z]+-[0-9a-z]+$/.test(a1?.id ?? ""), a1?.id);
  check("登记时间取对面的", a1?.created_at === "2026-10-01T00:00:00Z", a1?.created_at);
  check("更新时间落到本次同步（非空）", !!a1?.updated_at, a1?.updated_at);
  check(
    "_status 是算出来的（补了处理方式 → 处理中）",
    after.find((r) => r.order_sn === "A2")?._status === "处理中",
    after.find((r) => r.order_sn === "A2")?._status,
  );
  check(
    "新行的流程/提醒是空的（不造幽灵数据）",
    after.every((r) => r.flow === "" && r.remind_at === "" && r.remind_task === ""),
  );

  // 表名必须是工具私有表那个前缀
  const names = await db().tableNames();
  check(
    "落在 tool_abnormal_ticket_tickets 里",
    names.includes("tool_abnormal_ticket_tickets"),
    names.join(","),
  );

  // 第二次：改一行
  const plan2 = K.planPull([row({ order_sn: "A1", store: "甲店", category: "丢件", result: "已退款" })], after);
  const r2 = await K.applyPull(plan2);
  check("第二次写库报告 更新 1", r2.added === 0 && r2.updated === 1, JSON.stringify(r2));
  const again = await K.readLedger();
  const a1b = again.find((r) => r.order_sn === "A1");
  check("情况被改成丢件", a1b?.category === "丢件", a1b?.category);
  check("结果补上了", a1b?.result === "已退款", a1b?.result);
  check("id 没变（还是同一条单子）", a1b?.id === a1?.id, `${a1?.id} → ${a1b?.id}`);
  check("补了结果 → 状态翻成已关闭", a1b?._status === "已关闭", a1b?._status);
  check("总数还是 2（更新不是新增）", again.length === 2, String(again.length));
}

/* ================= 5. 门禁 ================= */

section("5. 网页端明确报错（不静默失败）");
{
  let msg = "";
  try {
    await K.pushLedger("tok", "0s_1", "1", "异常台账");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("推送在网页端被拦下并说清楚", msg.includes("只在桌面版"), msg);

  msg = "";
  try {
    await K.pullLedger("tok", "0s_1", "异常台账");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("拉取在网页端被拦下并说清楚", msg.includes("只在桌面版"), msg);

  msg = "";
  try {
    await K.loginStart();
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("登录在网页端被拦下并说清楚", msg.includes("只在桌面版"), msg);

  msg = "";
  try {
    const M0 = await import("../src/lib/wpsMcp.ts");
    await M0.mcpBegin();
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("MCP 授权在网页端被拦下并说清楚", msg.includes("只在桌面版"), msg);

  // 探测与列文件同样要在网页端被拦下（不能静默返回空）
  const M0b = await import("../src/lib/wpsMcp.ts");
  msg = "";
  try {
    await M0b.mcpProbe("tok", "cid");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("MCP 探测在网页端被拦下", msg.includes("只在桌面版"), msg);

  msg = "";
  try {
    await M0b.mcpListFiles("tok", "cid");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("MCP 列文件在网页端被拦下", msg.includes("只在桌面版"), msg);

  // 参数不齐时也要说人话，不能带着空串去打接口。
  // 上面几条是"网页端"；这里把 Tauri 标记补上模拟桌面端，才能走到参数校验那一步
  dom.window.__TAURI_INTERNALS__ = {};
  msg = "";
  try {
    await K.pushLedger("", "0s_1", "1", "异常台账", []);
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("没登录时先说「还没登录 WPS」", msg.includes("还没登录"), msg);

  msg = "";
  try {
    await K.pullLedger("tok", "", "异常台账");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("没选知识库时先说「还没选知识库」", msg.includes("还没选知识库"), msg);

  delete dom.window.__TAURI_INTERNALS__;
}

/* ================= 6. 绑定文件的宿主侧编排 ================= */

section("6. 绑定文件编排（工具只传内容，令牌不出宿主）");
{
  const W = await import("../src/lib/wpsLink.ts");
  const calls = [];
  let filesReply = [
    { kuid: "0ls", title: "异常台账", doc_type: "s", size: 1200 },
    { kuid: "0lo", title: "接入说明", doc_type: "o", size: 800 },
    { kuid: "0lz", title: "压缩包", doc_type: "zip", size: 10 },
  ];
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "wps_files") return filesReply;
      if (cmd === "wps_link_import")
        return { kuid: "0lc", title: "测试表格", doc_type: "ksheet", kind: "sheet", note: "已复制" };
      if (cmd === "wps_file_read")
        return { kuid: "0ls", title: "异常台账", kind: "sheet", doc_type: "s", header: ["订单号"], rows: [["A-1"]], text: "" };
      if (cmd === "wps_file_write")
        return { kuid: "0lNEW", title: "异常台账", note: "智能文档要等同步" };
      throw new Error(`没有预料到的命令 ${cmd}`);
    },
  };

  const cfg = { "kwiki.token": "tok-1", "kwiki.spaceKuid": "0s_9", "kwiki.driveId": "77" };

  // 1) doc_type → sheet / doc，与 Rust 侧同一套判定
  check("doc_type s → sheet", W.kindOfDocType("s") === "sheet");
  check("doc_type o → doc", W.kindOfDocType("o") === "doc");
  check("认不出的类型不硬猜", W.kindOfDocType("zip", "压缩包") === "other");

  // 2) 清单只列能编辑的（表格 / 文档），认不出的类型过滤掉
  const list = await W.listBindable(cfg);
  check("只列表格与文档（认不出的被过滤）",
    list.length === 2 && list.map((f) => f.kind).join(",") === "sheet,doc",
    JSON.stringify(list.map((f) => [f.title, f.kind])));
  check("列清单带上了登录令牌与知识库", calls[0].args.token === "tok-1" && calls[0].args.kuid === "0s_9",
    JSON.stringify(calls[0].args));

  // 3) 配置不齐要说清去哪补
  const miss = (patch) => { try { W.wpsConfig(patch); return ""; } catch (e) { return e.message; } };
  check("没登录时指向设置页", miss({}).includes("登录 WPS"), miss({}));
  check("没选知识库时指向设置页", miss({ "kwiki.token": "t" }).includes("知识库"), miss({ "kwiki.token": "t" }));
  check("缺 drive_id 时不静默", miss({ "kwiki.token": "t", "kwiki.spaceKuid": "0s_9" }).includes("drive_id"),
    miss({ "kwiki.token": "t", "kwiki.spaceKuid": "0s_9" }));

  // 4) 绑链接：只把链接交给宿主，令牌由宿主补
  calls.length = 0;
  const b = await W.bindByLink("  https://www.kdocs.cn/l/crkFlwR2In6z  ", cfg);
  check("绑链接走 wps_link_import", calls[0].cmd === "wps_link_import", calls[0].cmd);
  check("链接两端空格被去掉", calls[0].args.link === "https://www.kdocs.cn/l/crkFlwR2In6z", calls[0].args.link);
  check("绑定结果带回可编辑节点", b.kuid === "0lc" && b.kind === "sheet" && b.note.includes("已复制"));

  // 5) 读：kuid / 标题 / doc_type 一起传（Rust 侧据此决定表格还是文档）
  calls.length = 0;
  const doc = await W.readBoundFile({ kuid: "0ls", title: "异常台账", doc_type: "s", kind: "sheet" }, cfg);
  check("读走 wps_file_read", calls[0].cmd === "wps_file_read", calls[0].cmd);
  check("读传了 kuid / 标题 / docType",
    calls[0].args.kuid === "0ls" && calls[0].args.title === "异常台账" && calls[0].args.docType === "s",
    JSON.stringify(calls[0].args));
  check("表格内容原样带回", doc.header[0] === "订单号" && doc.rows[0][0] === "A-1");

  // 6) 写：token / space / drive 都由宿主补，工具只给内容
  calls.length = 0;
  const res = await W.writeBoundFile(
    { kuid: "0ls", title: "异常台账", doc_type: "s", kind: "sheet" },
    { header: ["订单号"], rows: [["A-2"]], text: "" },
    cfg,
  );
  check("写走 wps_file_write", calls[0].cmd === "wps_file_write", calls[0].cmd);
  check("写带齐 token / 知识库 / drive",
    calls[0].args.token === "tok-1" && calls[0].args.spaceKuid === "0s_9" && calls[0].args.driveId === "77",
    JSON.stringify([calls[0].args.token, calls[0].args.spaceKuid, calls[0].args.driveId]));
  check("写的内容是编辑后的那行", calls[0].args.rows[0][0] === "A-2", JSON.stringify(calls[0].args.rows));
  check("保存后返回新 kuid（界面必须更新绑定）", res.kuid === "0lNEW" && res.kuid !== "0ls");

  delete dom.window.__TAURI_INTERNALS__;
}

/* ================= 7. 在线表格直连（MCP） ================= */

section("7. 在线表格直连（一次授权、挑一份表、直接读写原表）");
{
  const M = await import("../src/lib/wpsMcp.ts");
  const S = await import("../src/lib/settings.ts");

  // 1) 配置读取：三格里少一个都不能算连上
  check(
    "空设置读出来是未连接",
    M.readMcpConfig({}).enabled === false && M.readMcpConfig({}).token === "",
  );
  const cfg = M.readMcpConfig({
    [S.SETTINGS.wpsMcpToken]: "tok",
    [S.SETTINGS.wpsMcpClientId]: "cid",
    [S.SETTINGS.wpsMcpEnabled]: "1",
    [S.SETTINGS.wpsMcpExpiry]: "1700000000000",
  });
  check(
    "令牌 / clientId / 启用 / 到期 四格都认",
    cfg.token === "tok" &&
      cfg.clientId === "cid" &&
      cfg.enabled === true &&
      cfg.expiry === 1700000000000,
    JSON.stringify(cfg),
  );
  check(
    "enabled 只认字面量 \"1\"（写成 true 不算）",
    M.readMcpConfig({ [S.SETTINGS.wpsMcpEnabled]: "true" }).enabled === false,
  );

  // 2) 调用形状：桥接走 wps_mcp_bridge，推拉走各自那条命令
  const calls = [];
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "wps_mcp_bridge") {
        const a = args.args || {};
        if (args.tool === "list_my_files") {
          // 第一页带 next_page_token：验证会翻页，且不会把 200 塞进 page_size
          return JSON.stringify(
            a.page_token
              ? { items: [{ id: "f2", name: "第二份.ksheet", type: "file", mtime: 1 }] }
              : {
                  items: [
                    { id: "f1", name: "台账.ksheet", type: "file", mtime: 2 },
                    { id: "d1", name: "子文件夹", type: "folder" },
                    { name: "没 id 的" },
                    { id: "f3" },
                  ],
                  next_page_token: "p2",
                },
          );
        }
        return JSON.stringify({});
      }
      if (cmd === "wps_mcp_sheet_pull")
        return { file_kuid: "f1", header: ["订单号"], rows: [{ order_sn: "A-1" }] };
      if (cmd === "wps_mcp_sheet_push")
        return { count: 1, columns: 14, appended: 0, file_kuid: "f1" };
      throw new Error(`没有预料到的命令 ${cmd}`);
    },
  };

  const files = await M.mcpListFiles("tok", "cid");
  check("列文件走 wps_mcp_bridge 的 list_my_files", calls[0].cmd === "wps_mcp_bridge" && calls[0].args.tool === "list_my_files", JSON.stringify(calls[0]));
  check("page_size 是 50（服务端上限，写 200 会 400）", calls[0].args.args.page_size === 50, JSON.stringify(calls[0].args.args));
  check("有 next_page_token 会翻页", calls.length === 2 && calls[1].args.args.page_token === "p2", String(calls.length));
  check("没 id / 没名字的条目被丢掉", files.length === 3, JSON.stringify(files));
  check("文件夹也列出来（界面要标出来进不去）", files[1].ftype === "folder", JSON.stringify(files[1]));

  calls.length = 0;
  const pulled = await M.mcpSheetPull("f1", "", "tok", "cid");
  check("拉取走 wps_mcp_sheet_pull", calls[0].cmd === "wps_mcp_sheet_pull", calls[0].cmd);
  check("没选工作表时传 null（Rust 侧落到第一张）", calls[0].args.sheet === null, JSON.stringify(calls[0].args));
  check("拉回来的行仍是 SQLite 列名", pulled.rows[0].order_sn === "A-1");

  calls.length = 0;
  await M.mcpSheetPull("f1", "台账", "tok", "cid");
  check("选了工作表就传表名", calls[0].args.sheet === "台账", JSON.stringify(calls[0].args));

  calls.length = 0;
  const pushed = await M.mcpSheetPush("f1", "台账", [{ order_sn: "A-2" }], "tok", "cid");
  check("推送走 wps_mcp_sheet_push 且只传行", calls[0].cmd === "wps_mcp_sheet_push" && calls[0].args.rows.length === 1, JSON.stringify(calls[0]));
  check("推送结果是台账那几列（不碰别的列）", pushed.columns === 14);

  delete dom.window.__TAURI_INTERNALS__;
}

/* ================= 8. 迁移后的静态一致性 ================= */

section("8. AirScript 那套已经不在了（静态检查，防回潮）");
{
  const bridge = read("src/lib/toolBridge.ts");
  check("桥接里没有 wps.cloud* 了", !/wps\.cloud/.test(bridge));
  check("桥接里没有 webhook / 脚本令牌字段", !/webhook/.test(bridge) && !/cloudScript/.test(bridge));

  const plan = read("src-tauri/src/wps_cloud_plan.rs");
  check("对账逻辑还在（只写台账 14 列那条）", /pub fn plan_cloud_write/.test(plan));
  check("对账逻辑不再提 AirScript", !/AirScript/.test(plan));

  const mcp = read("src-tauri/src/wps_mcp.rs");
  check("MCP 侧有硬白名单", /BRIDGE_TOOLS/.test(mcp));
  check("白名单里有读表和写表", /sheet\.get_range_data/.test(mcp) && /sheet\.update_range_data/.test(mcp));
  /* 写格时的文本化规则（2026-10-20 实测过一次真表）：
   * 19 位订单号会被 double 吃掉末尾；**13 位纯数字运单号也会被显示成
   * 4.37249E+12** —— 所以单号列不看长度，只要是纯数字就前置单引号。 */
  check(
    "单号列一律前置单引号（不看长度）",
    /fn formula_for\(/.test(plan) && /format!\("'\{v\}"\)/.test(plan),
    /fn formula_for[\s\S]{0,300}/.exec(plan)?.[0] || "没找到 formula_for",
  );
  check(
    "写格时按列的 key 走这条规则",
    /formula_for\(/.test(mcp),
    /formula_for\([^)]*\)/.exec(mcp)?.[0] || "没找到调用点",
  );
  /* 推送必须是**增量**的（2026-10-20 改）：表大了还整本重写既慢又危险。
   * 这两条防"又退回全量覆盖"的回潮。 */
  check("推送走增量对账（plan_cloud_sync）", /plan_cloud_sync\(/.test(mcp));
  check(
    "只写新增行与变动的格，不再整本重写",
    /plan\.appends/.test(mcp) && /plan\.updates/.test(mcp) && !/plan_cloud_write\(/.test(mcp),
  );
  check(
    "计划里带上了列名 key（写格靠它认单号列）",
    /"key": \*key/.test(plan),
  );

  const wps = read("src-tauri/src/wps.rs");
  check("wps.rs 里没有 AirScript 调用点了", !/airscript/i.test(wps));
  check("共享链接只读预览已删（UI 没入口了）", !/wps_link_read/.test(wps));
  check("但分享链接导入还在（绑定知识库那条路要用）", /wps_link_import/.test(wps));
}


/* ---------- 收尾 ---------- */

console.log(`\n${"=".repeat(56)}`);
info("通过", passed);
info("失败", failed);
if (failed) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(56));
process.exit(failed ? 1 : 0);
