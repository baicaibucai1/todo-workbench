/**
 * WPS 知识库（kwiki）联动的 Node 侧验证（不连网、不启动真应用）。
 *
 * 覆盖四层：
 *   1. **纯函数**：状态派生、比对锚点 —— 与工具里的 statusOf 必须同一套口径；
 *   2. **跨文件一致性**：`src/lib/kwiki.ts` 的 COLUMNS 与 `src-tauri/src/wps.rs`
 *      的 COLUMNS 是同一份约定的两个拷贝，这里逐条比对（改一处忘另一处，
 *      症状是"推上去的表头和拉回来的映射对不上"，极难手查）；
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
  // 从 wps.rs 里把 COLUMNS 那段抠出来。这段必须比对：两侧是手抄的两份，
  // 漂移了不会有任何报错，只会让表头和映射对不上
  const rs = read("src-tauri/src/wps.rs");
  const block = /const COLUMNS[^\[]*\[([\s\S]*?)\];/.exec(rs);
  check("wps.rs 里找得到 COLUMNS", !!block);
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
  check(
    "manifest 与 BUILTIN_TOOLS 都到了 0.8.3",
    JSON.parse(read("tools/abnormal-ticket/manifest.json")).version === "0.8.3" &&
      /id: "abnormal-ticket",\s*\n\s*name: "异常单号登记",\s*\n\s*version: "0\.8\.3"/.test(
        read("src/lib/tools.ts"),
      ),
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
