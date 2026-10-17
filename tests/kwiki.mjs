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
  check(
    "manifest 与 BUILTIN_TOOLS 都到了 0.9.1",
    JSON.parse(read("tools/abnormal-ticket/manifest.json")).version === "0.9.1" &&
      /id: "abnormal-ticket",\s*\n\s*name: "异常单号登记",\s*\n\s*version: "0.9.1"/.test(
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

  msg = "";
  try {
    await K.linkInfo("https://www.kdocs.cn/l/abcdef");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("解析共享链接在网页端被拦下并说清楚", msg.includes("只在桌面版"), msg);

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

  // 共享链接：空链接要在本地拦下；读内容前必须已登录
  msg = "";
  try {
    await K.linkInfo("   ");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("空链接先说「先粘贴一个…」", msg.includes("先粘贴"), msg);

  msg = "";
  try {
    await K.linkRead("", "0s_1", "https://www.kdocs.cn/l/abcdef");
  } catch (err) {
    msg = (err instanceof Error ? err.message : String(err));
  }
  check("读共享文件没登录时先说「还没登录 WPS」", msg.includes("还没登录"), msg);

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

/* ================= 7. 云端表格直连（AirScript） ================= */

section("7. 云端表格直连（不登录、不复制、直接读写原表）");
{
  const C = await import("../src/lib/wpsCloud.ts");
  const W = await import("../src/lib/wpsLink.ts");

  // 1) 纯配置：三件套齐不齐
  check("没配时 cloudReady = false", C.cloudReady(C.readCloudConfig({})) === false);
  check("有 webhook + 令牌就算配好（链接只用来认表）",
    C.cloudReady({ link: "", webhook: "https://x", token: "t", sheet: "" }) === true);
  check("只填 webhook 不算配好",
    C.cloudReady({ link: "", webhook: "https://x", token: "", sheet: "" }) === false);

  // 2) 脚本原文：协议里的四个 op 一个都不能少（少了就是"点了没反应"）
  const snippet = C.AIRSCRIPT_SNIPPET;
  const ops = ['op === "ping"', 'op === "read"', 'op === "write"', 'op === "writeGrid"'];
  check("脚本里四个操作都在", ops.every((k) => snippet.includes(k)),
    JSON.stringify(ops.filter((k) => !snippet.includes(k))));
  // 19 位订单号按 Value2 读会被 double 吃掉末尾几位 —— 脚本必须走 Cells().Text
  check("脚本按 Cells(r,c).Text 取显示文本（别让 19 位订单号掉精度）",
    snippet.includes("sh.Cells(r, c).Text"),
    snippet.includes("sh.Cells(r, c).Text"));

  // 3) 调用形状：每个命令带什么参数
  const calls = [];
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "wps_link_info") return { name: "测试表格.xlsx", kind: "sheet" };
      if (cmd === "wps_link_info_doc") return { name: "说明", kind: "doc" };
      if (cmd === "wps_cloud_probe")
        return { sheet: "台账", sheets: 1, rows: 3, cols: 14, header: ["订单号", "快递单号"] };
      if (cmd === "wps_cloud_pull")
        return { file_kuid: "cloud", header: ["订单号"], rows: [{ order_sn: "A-1" }] };
      if (cmd === "wps_cloud_push") return { count: 1, columns: 14, appended: 0, file_kuid: "cloud" };
      if (cmd === "wps_cloud_sheet_read")
        return { sheet: "台账", header: ["订单号"], rows: [["A-1"]] };
      if (cmd === "wps_cloud_sheet_write") return 1;
      throw new Error(`没有预料到的命令 ${cmd}`);
    },
  };

  const probe = await C.cloudProbe("https://www.kdocs.cn/api/v3/ide/file/f/script/s/sync_task", "tok");
  check("测试连接走 wps_cloud_probe", calls[0].cmd === "wps_cloud_probe", calls[0].cmd);
  check("探测带回工作表 / 表头", probe.sheet === "台账" && probe.header.length === 2,
    JSON.stringify(probe));

  calls.length = 0;
  const pulled = await C.cloudPull("https://w", "tok", "台账");
  check("拉取走 wps_cloud_pull 且带 sheet", calls[0].cmd === "wps_cloud_pull" && calls[0].args.sheet === "台账",
    JSON.stringify(calls[0]));
  check("拉回来的行仍是 SQLite 列名", pulled.rows[0].order_sn === "A-1");

  calls.length = 0;
  const pushed = await C.cloudPush("https://w", "tok", "台账", [{ order_sn: "A-2" }]);
  check("推送走 wps_cloud_push 且只传行", calls[0].cmd === "wps_cloud_push" && calls[0].args.rows.length === 1,
    JSON.stringify(calls[0]));
  check("推送结果是台账那几列（不碰别的列）", pushed.columns === 14);

  calls.length = 0;
  const sheet = await C.cloudSheetRead("https://w", "tok", "台账");
  check("整表读走 wps_cloud_sheet_read", calls[0].cmd === "wps_cloud_sheet_read" && sheet.header[0] === "订单号",
    JSON.stringify(calls[0]));

  calls.length = 0;
  const n = await C.cloudSheetWrite("https://w", "tok", "台账", ["订单号"], [["A-3"]]);
  check("整表写把表头一起发过去（写回原表要完整网格）",
    calls[0].cmd === "wps_cloud_sheet_write" && calls[0].args.header[0] === "订单号" && n === 1,
    JSON.stringify(calls[0]));

  // 4) 直连绑定：先认链接，再探脚本；不是表格就不让绑
  calls.length = 0;
  const b = await W.bindCloudLink("https://www.kdocs.cn/l/abcd1234", "https://w", "tok");
  check("绑定先解析链接（认出是哪张表）", calls[0].cmd === "wps_link_info", calls[0].cmd);
  check("再探脚本（拿到 sheet / 表头）", calls[1].cmd === "wps_cloud_probe" && b.sheet === "台账");
  check("绑定对象带 cloud 标记（工具靠它走直连分支）", b.kind === "cloud" && b.name === "测试表格.xlsx");

  // 5) 读 / 写走直连，不去碰知识库
  calls.length = 0;
  const doc = await W.readCloudBound(b);
  check("直连读原样给二维表", calls[0].cmd === "wps_cloud_sheet_read" && doc.rows[0][0] === "A-1");
  calls.length = 0;
  const wr = await W.writeCloudBound(b, { header: ["订单号"], rows: [["A-9"]], text: "" });
  check("直连写走 wps_cloud_sheet_write", calls[0].cmd === "wps_cloud_sheet_write", calls[0].cmd);
  check("写回说明点明「原表 / 没有副本」", /原表/.test(wr.note) && /没有副本/.test(wr.note), wr.note);

  delete dom.window.__TAURI_INTERNALS__;
}

/* ================= 8. 那段脚本真跑一遍 ================= */

section("8. 脚本在「假的 WPS 对象模型」上真跑（语法 + 落格位置）");
{
  const { AIRSCRIPT_SNIPPET } = await import("../src/lib/wpsCloud.ts");

  /** 造一张假表：cells[r-1][c-1] 存的是「显示文本」 */
  function makeSheet(name, init) {
    const cells = [];
    const put = (r, c, v) => {
      while (cells.length < r) cells.push([]);
      const line = cells[r - 1];
      while (line.length < c) line.push("");
      line[c - 1] = v === null || v === undefined ? "" : String(v);
    };
    for (let r = 0; r < init.length; r++)
      for (let c = 0; c < init[r].length; c++) put(r + 1, c + 1, init[r][c]);

    // UsedRange 的边界：最后一个非空行 / 非空列（至少 1）
    const dim = () => {
      let lr = 1;
      let lc = 1;
      for (let r = 0; r < cells.length; r++) {
        const line = cells[r];
        for (let c = 0; c < line.length; c++) {
          if (line[c] !== "") {
            lr = Math.max(lr, r + 1);
            lc = Math.max(lc, c + 1);
          }
        }
      }
      return { lr, lc };
    };

    const cellAt = (r, c) => {
      const s = cells[r - 1]?.[c - 1] ?? "";
      return {
        __r: r,
        __c: c,
        // 真机上 .Text 是"眼睛看到的"，.Value2 是原始值 —— 长数字会被 double 吃掉位数
        get Text() {
          return s;
        },
        get Value2() {
          return /^\d{15,}$/.test(s) ? Number(s) : s;
        },
        set Value2(v) {
          put(r, c, v);
        },
      };
    };

    const sheet = {
      Name: name,
      Cells: cellAt,
      Range(a, b) {
        return {
          set Value2(mat) {
            if (!Array.isArray(mat)) throw new Error("Value2 赋的不是数组");
            for (let i = 0; i < mat.length; i++)
              for (let j = 0; j < mat[i].length; j++) put(a.__r + i, a.__c + j, mat[i][j]);
          },
          ClearContents() {
            for (let r = a.__r; r <= b.__r; r++)
              for (let c = a.__c; c <= b.__c; c++) put(r, c, "");
          },
        };
      },
      get UsedRange() {
        const d = dim();
        return { Row: 1, Column: 1, Rows: { Count: d.lr }, Columns: { Count: d.lc } };
      },
    };
    return { sheet, at: (r, c) => cells[r - 1]?.[c - 1] ?? "" };
  }

  const appFor = (sheet) => ({
    get ActiveSheet() {
      return sheet;
    },
    Sheets: Object.assign(
      (k) => {
        if (typeof k === "number") {
          if (k === 1) return sheet;
          throw new Error("没有这张表");
        }
        if (k === sheet.Name) return sheet;
        throw new Error(`没有这张表：${k}`);
      },
      { Count: 1 },
    ),
  });

  // 脚本顶层有 return —— 放进函数体里执行，正好等价于 AirScript 跑它的方式
  // （makeSheet 返回的是 {sheet, at} 包装层，这里取里面的真表）
  const run = (w, argv) =>
    new Function("Context", "Application", AIRSCRIPT_SNIPPET)({ argv }, appFor(w.sheet));

  let compiled = true;
  try {
    new Function("Context", "Application", AIRSCRIPT_SNIPPET);
  } catch (e) {
    compiled = false;
    info("语法错误", e.message);
  }
  check("脚本本身能编译（粘进去不会语法报错）", compiled);

  /* 后面每条断言都在这一块的假表上跑 */

  // 1) ping：只读表头 + 尺寸，不整表扫
  {
    const s = makeSheet("台账", [["订单号", "快递单号"], ["A-1", "SF1"], ["A-2", "SF2"]]);
    const r = run(s, { op: "ping" });
    check("ping 回工作表名", r.sheet === "台账", r.sheet);
    check("ping 回行数（含表头 3 行）", r.rows === 3, r.rows);
    check("ping 回列数", r.cols === 2, r.cols);
    check(
      "ping 回表头原文",
      JSON.stringify(r.header) === '["订单号","快递单号"]',
      JSON.stringify(r.header),
    );
    check("平表也不炸（空表回 ok）", run(makeSheet("空", []), { op: "ping" }).ok === true);
  }

  // 2) 19 位订单号：Value2 会掉位数，必须靠 .Text 原样带回来
  {
    const order = "2026101712345678901";
    const s = makeSheet("台账", [["订单号"], [order]]);
    const r = run(s, { op: "read" });
    check("读回来的 19 位订单号一位不差", r.rows[1][0] === order, r.rows[1][0]);
  }

  // 3) write：按 Rust 算出来的 col/values 落到对应格子，用户的列不动
  {
    // 用户表：第 1 列是自己的「备注」，第 2 列才是订单号
    const s = makeSheet("台账", [["备注", "订单号"], ["自留", "A-1"]]);
    const r = run(s, {
      op: "write",
      cols: [
        { col: 2, values: ["订单号", "A-101", "A-102"] },
        { col: 3, values: ["快递单号", "SF101", "SF102"] },
      ],
      clear: [],
    });
    check("write 回 ok + 写了几列", r.ok === true && r.cols === 2, JSON.stringify(r));
    check(
      "订单号写进第 2 列（按表头认出来的位置）",
      s.at(2, 2) === "A-101" && s.at(3, 2) === "A-102",
      `${s.at(2, 2)} / ${s.at(3, 2)}`,
    );
    check("补的列落在末尾（第 3 列）", s.at(1, 3) === "快递单号" && s.at(2, 3) === "SF101", s.at(2, 3));
    check(
      "用户自己的「备注」列一格都没动",
      s.at(1, 1) === "备注" && s.at(2, 1) === "自留",
      `${s.at(1, 1)} / ${s.at(2, 1)}`,
    );
  }

  // 4) write + clear：旧行多出来时只清台账那几列，别的列留着
  {
    const s = makeSheet("台账", [
      ["订单号", "备注"],
      ["A-1", "留着1"],
      ["A-2", "留着2"],
      ["A-3", "留着3"],
      ["A-4", "留着4"],
    ]);
    run(s, {
      op: "write",
      cols: [{ col: 1, values: ["订单号", "A-9"] }],
      clear: [{ col: 1, from: 3, to: 5 }],
    });
    check("新数据写到位", s.at(2, 1) === "A-9", s.at(2, 1));
    check("多出来的旧行被清掉", s.at(3, 1) === "" && s.at(5, 1) === "", `${s.at(3, 1)}|${s.at(5, 1)}`);
    check(
      "清行只清台账列 —— 备注列那三行原样还在",
      s.at(3, 2) === "留着2" && s.at(4, 2) === "留着3" && s.at(5, 2) === "留着4",
      [s.at(3, 2), s.at(4, 2), s.at(5, 2)].join("|"),
    );
  }

  // 5) writeGrid：整表覆盖（绑定文件那条路），多出来的行要清
  {
    const s = makeSheet("台账", [["旧1", "旧2"], ["x", "y"], ["z", "w"]]);
    const r = run(s, { op: "writeGrid", rows: [["新表头", "B"], ["1", "2"]] });
    check("writeGrid 回 ok + 行数", r.ok === true && r.rows === 2, JSON.stringify(r));
    check(
      "writeGrid 从 A1 开始覆盖",
      s.at(1, 1) === "新表头" && s.at(2, 2) === "2",
      `${s.at(1, 1)} / ${s.at(2, 2)}`,
    );
    check(
      "writeGrid 清掉多出来的第 3 行",
      s.at(3, 1) === "" && s.at(3, 2) === "",
      `${s.at(3, 1)}|${s.at(3, 2)}`,
    );
  }

  // 6) 边界：sheet 名对不上时退回当前活动表（不能让整条链路直接炸）
  {
    const s = makeSheet("台账", [["订单号"], ["A-1"]]);
    const r = run(s, { op: "read", sheet: "不存在的表名" });
    check("sheet 名认不出时退回活动表", r.ok === true && r.rows[1][0] === "A-1", JSON.stringify(r));
  }

  check(
    "未知 op 会明确说不知道（不是静默成功）",
    run(makeSheet("台账", []), { op: "乱写的" }).ok === false,
  );
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
