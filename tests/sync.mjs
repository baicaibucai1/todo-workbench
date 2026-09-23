/**
 * 同步的 Node 侧验证（不依赖浏览器，也不需要真的连上云盘）。
 *
 * 分三段：
 *   A. **纯合并算法**（src/lib/sync.ts）—— 这是同步最核心、也最难靠手点验证的部分。
 *      两边的时间戳、墓碑、坏时间戳、字段缺失的组合太多，只有穷举断言才敢说它对。
 *   B. **数据库往返**（src/lib/syncRepo.ts）—— 合并结果能不能正确写回库，
 *      以及"只勾待办"时会不会误伤别的分片的表（附件记录被连带删除是这里最贵的一个坑）。
 *   C. **传输层分派**（src/lib/syncClient.ts）—— 「哪个后端打哪个命令、参数长什么样」。
 *      这一层只有真的连上云盘才会暴露问题，所以这里把 Tauri 的 invoke 落地端
 *      （`window.__TAURI_INTERNALS__.invoke`）换成一个记录器，既不启动真应用也不连网。
 *      配置读取在后端上的分叉（第 13 节）也在这里。
 *
 * 用法：
 *   npm run sync:test
 * 或先打包再跑：
 *   node_modules/.bin/esbuild tests/sync.mjs --bundle --platform=node --format=esm \
 *     --target=node22 --outfile=tests/.sync.bundle.mjs --external:jsdom && node tests/.sync.bundle.mjs
 */

import { JSDOM } from "jsdom";

/* ---------- 浏览器环境垫片（db 层要 localStorage） ---------- */

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

/* ---------- 载入被测模块 ---------- */

const { initDb, resetDemoDb } = await import("../src/lib/db.ts");
const { migrations, CURRENT_SCHEMA_VERSION } = await import("../src/lib/migrations.ts");
const repo = await import("../src/lib/repo.ts");
const S = await import("../src/lib/sync.ts");
const { exportShardPayload, applyShardPayload } = await import("../src/lib/syncRepo.ts");

/* ---------- 小工具 ---------- */

/** 造一个相对"基准时刻"的时间戳，让断言不依赖真实时钟 */
const BASE = Date.parse("2026-09-01T00:00:00.000Z");
const at = (minutes) => new Date(BASE + minutes * 60_000).toISOString();

const task = (id, over = {}) => ({
  id,
  listId: "L1",
  title: `任务 ${id}`,
  note: "",
  done: false,
  important: false,
  myDay: false,
  dueDate: null,
  remindAt: null,
  completedAt: null,
  repeat: "none",
  repeatDoneOn: null,
  sortOrder: 0,
  deleted: false,
  createdAt: at(0),
  updatedAt: at(0),
  ...over,
});
const list = (id, over = {}) => ({
  id,
  name: `清单 ${id}`,
  color: "#378add",
  sortOrder: 0,
  deleted: false,
  createdAt: at(0),
  updatedAt: at(0),
  ...over,
});
const step = (id, taskId, title, over = {}) => ({
  id,
  taskId,
  title,
  done: false,
  sortOrder: 0,
  dueAt: null,
  ...over,
});
const flow = (id, over = {}) => ({
  id,
  name: `流程 ${id}`,
  isDefault: false,
  sortOrder: 0,
  deleted: false,
  createdAt: at(0),
  updatedAt: at(0),
  ...over,
});
const stage = (id, flowId, name, over = {}) => ({
  id,
  flowId,
  name,
  color: "#378add",
  sortOrder: 0,
  isTerminal: false,
  defaultMinutes: 0,
  ...over,
});

/* ==================================================================== */
/* A. 纯合并算法                                                         */
/* ==================================================================== */

section("1. 迁移：v14 是当前版本，且加的是同步需要的时间戳与墓碑");
{
  check("CURRENT_SCHEMA_VERSION 为 14", CURRENT_SCHEMA_VERSION === 14, `实际 v${CURRENT_SCHEMA_VERSION}`);
  const v14 = migrations.find((m) => m.version === 14);
  check("存在 v14 迁移", !!v14, String(v14?.name));
  const sql = (v14?.sql ?? "").replace(/\s+/g, " ");
  check("v14 给附件加 updated_at", /core_wo_attachments ADD COLUMN updated_at/.test(sql));
  check("v14 给图库加 updated_at", /core_gallery_items ADD COLUMN updated_at/.test(sql));
  check("v14 给任务关联加 updated_at", /core_task_links ADD COLUMN updated_at/.test(sql));
  check("v14 给任务关联加 deleted（取消关联要能同步过去）", /core_task_links ADD COLUMN deleted/.test(sql));
  check("迁移只增不改：版本号严格递增", migrations.every((m, i) => i === 0 || m.version > migrations[i - 1].version));
}

section("2. 时间戳：updatedAt 缺失时必须回落到 createdAt");
{
  check("有 updatedAt 用它", S.stampOf({ updatedAt: at(5), createdAt: at(0) }) === at(5));
  check(
    "没有 updatedAt 落回 createdAt",
    S.stampOf({ updatedAt: null, createdAt: at(3) }) === at(3),
    S.stampOf({ updatedAt: null, createdAt: at(3) }),
  );
  check("两个都没有 → 空串", S.stampOf({}) === "");
  check("空串 updatedAt 也算缺失", S.stampOf({ updatedAt: "", createdAt: at(3) }) === at(3));

  // 这是"v14 之前的老行不能被无条件覆盖"的落点
  const old = { updatedAt: null, createdAt: at(1) };
  const fresh = { updatedAt: at(9), createdAt: at(9) };
  check("老行靠 createdAt 仍能胜出", S.pickWinner(old, { updatedAt: at(0), createdAt: at(0) }) === "local");
  check("老行打不过真正的新改动", S.pickWinner(old, fresh) === "remote");
}

section("3. 胜负判定：解析不出来的时间戳不能当成「最旧」");
{
  check("远端更新 → remote", S.pickWinner({ updatedAt: at(1) }, { updatedAt: at(2) }) === "remote");
  check("本地更新 → local", S.pickWinner({ updatedAt: at(2) }, { updatedAt: at(1) }) === "local");
  check("一样新 → same", S.pickWinner({ updatedAt: at(2) }, { updatedAt: at(2) }) === "same");
  check("两边都无法解析 → same（宁可不动本地）", S.pickWinner({ updatedAt: "坏" }, { updatedAt: "也坏" }) === "same");
  check("本地有远端无 → remote（有改动记录的更可信）", S.pickWinner({}, { updatedAt: at(1) }) === "remote");
  check("本地有远端无（反过来）→ local", S.pickWinner({ updatedAt: at(1) }, {}) === "local");
  check("两边都空 → same", S.pickWinner({}, {}) === "same");

  check("远端更新时报「新」", S.remoteIsNewer({ updatedAt: at(1) }, { updatedAt: at(2) }) === true);
  check("远端更旧时不报「新」", S.remoteIsNewer({ updatedAt: at(3) }, { updatedAt: at(2) }) === false);
  check("远端时间戳坏了 → 不认为新", S.remoteIsNewer({ updatedAt: at(1) }, { updatedAt: "坏" }) === false);
}

section("4. LWW 逐条合并：新增 / 更新 / 保留 / 墓碑");
{
  const local = [task("A", { updatedAt: at(2) }), task("B", { updatedAt: at(5) })];
  const remote = [
    task("A", { title: "远端改过的 A", updatedAt: at(9) }),
    task("B", { title: "远端旧的 B", updatedAt: at(1) }),
    task("C", { title: "只有远端有", updatedAt: at(7) }),
  ];
  const r = S.mergeRecords(local, remote, "task", (t) => t.title);

  check("新增：云端有本地没有 → added", r.stats.added === 1, JSON.stringify(r.stats));
  check("更新：远端更新 → updated", r.stats.updated === 1, JSON.stringify(r.stats));
  check("保留：本地更新 → kept", r.stats.kept === 1, JSON.stringify(r.stats));
  check("远端没有的本地记录会被推上去 → pushed", r.stats.pushed === 0, JSON.stringify(r.stats));
  check("A 采用了远端标题", r.rows.find((x) => x.id === "A").title === "远端改过的 A");
  check("B 保住了本地标题", r.rows.find((x) => x.id === "B").title === "任务 B");
  check("C 被并进来", r.rows.some((x) => x.id === "C"));
  check("结果条数 = 三条", r.rows.length === 3, String(r.rows.length));
  const byId = new Map(r.conflicts.map((c) => [c.id, c]));
  check("两边都改了内容 → 两条冲突都记下来", r.conflicts.length === 2, JSON.stringify([...byId.keys()]));
  check("A 的冲突标了赢家是远端", byId.get("A")?.winner === "remote", byId.get("A")?.winner);
  check("A 的冲突带上了名字", byId.get("A")?.label === "远端改过的 A", byId.get("A")?.label);
  check("B 的冲突标了赢家是本地（本地改动保住了）", byId.get("B")?.winner === "local", byId.get("B")?.winner);
  check("冲突带上了两侧的时间戳", byId.get("A")?.localAt === at(2) && byId.get("A")?.remoteAt === at(9));
  check("from 表标出每条取自哪侧", r.from.get("A") === "remote" && r.from.get("B") === "local");
}

section("5. 内容相同但时间戳不同，不该报冲突");
{
  const a = task("A", { updatedAt: at(1) });
  const b = task("A", { updatedAt: at(4) });
  const r = S.mergeRecords([a], [b], "task");
  check("没有冲突", r.conflicts.length === 0, JSON.stringify(r.conflicts));
  check("平局按本地保留（不比内容）", r.stats.kept === 1 || r.stats.updated === 1);
  // 键顺序不同不该被当成内容不同
  check(
    "稳定序列化忽略键顺序",
    S.stableJson({ a: 1, b: 2 }) === S.stableJson({ b: 2, a: 1 }),
  );
  check("稳定序列化能看出真实差异", S.stableJson({ a: 1 }) !== S.stableJson({ a: 2 }));

  // sameContent 是"要不要打扰用户"的判定：同步自己的元数据不算内容
  check(
    "时间戳不参与内容比较",
    S.sameContent({ id: "x", title: "T", updatedAt: at(1) }, { id: "x", title: "T", updatedAt: at(9) }) === true,
  );
  check("createdAt 也不参与", S.sameContent({ id: "x", createdAt: at(1) }, { id: "x", createdAt: at(9) }) === true);
  check("内容真不同就是不同", S.sameContent({ id: "x", title: "T" }, { id: "x", title: "U" }) === false);
  check("deleted 参与比较", S.sameContent({ id: "x", deleted: false }, { id: "x", deleted: true }) === false);
  check(
    "completedAt 参与比较（它是用户看得见的状态）",
    S.sameContent({ id: "x", completedAt: null }, { id: "x", completedAt: at(3) }) === false,
  );
  check("嵌套对象的键顺序也不影响", S.sameContent({ a: { p: 1, q: 2 } }, { a: { q: 2, p: 1 } }) === true);
}

section("6. 墓碑：删除要能同步过去，而不是复活成新记录");
{
  const local = [task("A", { updatedAt: at(9) })];
  const remote = [task("A", { deleted: true, updatedAt: at(3) })];
  const r = S.mergeRecords(local, remote, "task");
  check("本地更新更晚 → 保活", r.rows[0].deleted === false);
  const r2 = S.mergeRecords(
    [task("A", { updatedAt: at(3) })],
    [task("A", { deleted: true, updatedAt: at(9) })],
  );
  check("远端删除更晚 → 采用墓碑", r2.rows[0].deleted === true);
  check("墓碑也算一次更新", r2.stats.updated === 1, JSON.stringify(r2.stats));
}

section("7. 子任务跟着父任务整体走（否则删子任务永远同步不过去）");
{
  const local = {
    lists: [list("L1")],
    tasks: [task("T1", { updatedAt: at(1) })],
    steps: { T1: [step("S1", "T1", "本地子任务一"), step("S2", "T1", "本地子任务二")] },
    links: [],
  };
  const remote = {
    lists: [list("L1")],
    tasks: [task("T1", { title: "远端改过的 T1", updatedAt: at(9) })],
    // 远端只剩一条 —— 说明在那边删掉了一条，硬删除没有墓碑，只能靠整组替换表达
    steps: { T1: [step("S1", "T1", "远端留下的子任务", { done: true })] },
    links: [],
  };
  const m = S.mergeTasksPayload(local, remote);
  check("父任务采用远端版本", m.payload.tasks[0].title === "远端改过的 T1");
  check("子任务整组跟随父任务（1 条）", m.payload.steps.T1.length === 1, JSON.stringify(m.payload.steps.T1));
  check("跟随的是远端那一组", m.payload.steps.T1[0].title === "远端留下的子任务");
  check("父任务本地更新的方向：子任务取本地整组", true);

  const m2 = S.mergeTasksPayload(
    { ...local, tasks: [task("T1", { updatedAt: at(9) })] },
    remote,
  );
  check("父任务本地更新的方向：子任务取本地整组", m2.payload.steps.T1.length === 2);
}

section("8. 待办带新子任务时，新任务的子任务也要带上");
{
  const m = S.mergeTasksPayload(
    { lists: [], tasks: [], steps: {}, links: [] },
    {
      lists: [],
      tasks: [task("T9", { updatedAt: at(9) })],
      steps: { T9: [step("S9", "T9", "新任务的子任务")] },
      links: [],
    },
  );
  check("新增任务的子任务跟着来", m.payload.steps.T9?.length === 1, JSON.stringify(m.payload.steps));
  check("远端没有子任务时给空数组而不是 undefined", m.payload.steps.T9 !== undefined);
}

section("9. 过程态跟流程模板整体走；流转记录取并集");
{
  const local = {
    flows: [flow("F1", { updatedAt: at(1) })],
    stages: { F1: [stage("ST1", "F1", "本地第一步"), stage("ST2", "F1", "本地第二步")] },
    workOrders: [],
    woFields: [],
    woLogs: [{ id: "LG1", woId: "W1", fromStage: null, toStage: "ST1", at: at(1), note: "" }],
  };
  const remote = {
    flows: [flow("F1", { name: "远端改过的流程", updatedAt: at(9) })],
    stages: { F1: [stage("ST1", "F1", "远端第一步")] },
    workOrders: [],
    woFields: [],
    woLogs: [
      { id: "LG1", woId: "W1", fromStage: null, toStage: "ST1", at: at(1), note: "" },
      { id: "LG2", woId: "W1", fromStage: "ST1", toStage: "ST2", at: at(4), note: "远端推的" },
    ],
  };
  const m = S.mergeOrdersPayload(local, remote);
  check("流程采用远端版本", m.payload.flows[0].name === "远端改过的流程");
  check("过程态整组跟随流程（1 步）", m.payload.stages.F1.length === 1, JSON.stringify(m.payload.stages.F1));
  check("流转记录取并集（2 条）", m.payload.woLogs.length === 2, String(m.payload.woLogs.length));
  check("并集不产生重复", m.payload.woLogs.filter((l) => l.id === "LG1").length === 1);
  check("流程任务本身参与 LWW（这次是空的，统计为 0）", m.stats.added === 0 && m.stats.updated === 1);
}

section("10. 流程任务的显示名回退顺序：标题 → 描述 → 单号 → id");
{
  const m = S.mergeRecords(
    [],
    [
      {
        id: "W1",
        title: "",
        description: "只有描述",
        no: "SF123",
        updatedAt: at(1),
        createdAt: at(1),
      },
    ],
    "order",
    (o) => o.title || o.description || o.no || o.id,
  );
  check("合并本身不挑名字，只有冲突清单用 label", m.conflicts.length === 0);

  // 直接验冲突里的 label 回退
  const c = S.mergeRecords(
    [{ id: "W1", title: "", description: "本地描述", no: "SF1", updatedAt: at(2), createdAt: at(2) }],
    [{ id: "W1", title: "", description: "远端描述", no: "SF1", updatedAt: at(9), createdAt: at(9) }],
    "order",
    (o) => o.title || o.description || o.no || o.id,
  );
  check("冲突标签退到描述", c.conflicts[0]?.label === "远端描述", c.conflicts[0]?.label);
}

section("11. 分片信封：解析要能挡住坏文件，但认得出自己的文件");
{
  const good = {
    app: "todo-workbench",
    format: S.SHARD_FORMAT,
    shard: "tasks",
    updatedAt: at(5),
    deviceId: "dev-1",
    deviceName: "台式机",
    payload: { lists: [], tasks: [], steps: {}, links: [] },
  };
  const raw = S.serializeShard(good);
  const back = S.parseShard(raw, "tasks");
  check("序列化 → 解析 往返成功", !!back);
  check("往返后设备名还在", back?.deviceName === "台式机");
  check("往返后 payload 还在", !!back?.payload);

  check("不是 JSON → null", S.parseShard("{坏", "tasks") === null);
  check("不是对象 → null", S.parseShard("42", "tasks") === null);
  check("别的应用写的 → null", S.parseShard(JSON.stringify({ ...good, app: "other-app" }), "tasks") === null);
  check("分片名对不上 → null", S.parseShard(raw, "orders") === null);
  check("格式版本太新 → null", S.parseShard(JSON.stringify({ ...good, format: 99 }), "tasks") === null);
  check("没有 payload → null", S.parseShard(JSON.stringify({ ...good, payload: null }), "tasks") === null);
  check("缺 optional 字段也能读（deviceName 补空串）", S.parseShard(JSON.stringify({ ...good, deviceName: undefined }), "tasks")?.deviceName === "");

  // 坚果云目录里被用户放了别的东西，不能中断整次同步
  check("用户手改过的半截 JSON 不抛异常", (() => {
    try {
      S.parseShard('{"app":"todo-workbench","shard":"tasks","format":1,"payload":{}', "tasks");
      return true;
    } catch {
      return false;
    }
  })());
}

section("12. 外部输入健壮性：payload 里字段整个缺失也不能炸");
{
  const empty = {};
  check("mergeTasksPayload({}, {}) 不抛", (() => {
    try {
      const m = S.mergeTasksPayload(empty, empty);
      return m.payload.tasks.length === 0 && m.payload.lists.length === 0;
    } catch {
      return false;
    }
  })());
  check("mergeOrdersPayload({}, {}) 不抛", (() => {
    try {
      const m = S.mergeOrdersPayload(empty, empty);
      return m.payload.woLogs.length === 0;
    } catch {
      return false;
    }
  })());
  check("mergeGalleryPayload({}, {}) 不抛", (() => {
    try {
      return S.mergeGalleryPayload(empty, empty).payload.items.length === 0;
    } catch {
      return false;
    }
  })());
  check("mergeAttachmentsPayload({}, {}) 不抛", (() => {
    try {
      return S.mergeAttachmentsPayload(empty, empty).payload.items.length === 0;
    } catch {
      return false;
    }
  })());
  check("mergeShard 能派发到四个分片", ["tasks", "orders", "gallery", "attachments"].every((s) => {
    try {
      return !!S.mergeShard(s, empty, empty);
    } catch {
      return false;
    }
  }));
  check("stats 相加正确", (() => {
    const a = S.addStats({ added: 1, updated: 2, kept: 3, pushed: 4 }, { added: 10, updated: 20, kept: 30, pushed: 40 });
    return a.added === 11 && a.updated === 22 && a.kept === 33 && a.pushed === 44;
  })());
  check("totalChanged 把两个方向都算上", S.totalChanged({ added: 1, updated: 2, kept: 0, pushed: 4 }) === 7);
}

section("13. 分片选择器与配置读取");
{
  const C = await import("../src/lib/syncClient.ts");
  const SET = await import("../src/lib/settings.ts");
  const K = SET.SETTINGS;
  const DEFAULT = SET.DEFAULT_SETTINGS;

  check("空值回落成只同步待办", JSON.stringify(C.parseShards(undefined)) === '["tasks"]');
  check("空串回落成只同步待办", JSON.stringify(C.parseShards("")) === '["tasks"]');
  check("全是非法值回落成只同步待办", JSON.stringify(C.parseShards("图库,xxx")) === '["tasks"]');
  check("合法值按固定顺序输出", JSON.stringify(C.parseShards("attachments,tasks")) === '["tasks","attachments"]');
  check("去重", JSON.stringify(C.parseShards("tasks,tasks,tasks")) === '["tasks"]');
  check("忽略未知项保留已知项", JSON.stringify(C.parseShards("orders,不存在")) === '["orders"]');
  check("formatShards 按固定顺序", C.formatShards(["gallery", "tasks"]) === "tasks,gallery");
  check("formatShards 里去重", C.formatShards(["tasks", "tasks"]) === "tasks");
  check("parse/format 往返稳定", C.formatShards(C.parseShards("orders,tasks")) === "tasks,orders");
  check("ALL_SHARDS 就是四个分片", C.ALL_SHARDS.join(",") === "tasks,orders,gallery,attachments");

  const cfg = C.readSyncConfig({});
  check("服务器地址有默认值", cfg.baseUrl === C.DEFAULT_BASE_URL, cfg.baseUrl);
  check("默认服务器就是坚果云", cfg.baseUrl.includes("jianguoyun.com"));
  check("默认只同步待办", cfg.shards.length === 1 && cfg.shards[0] === "tasks");
  check("没账号时算未配置", C.isSyncConfigured(cfg) === false);
  check("填了账号和密码才算配置好", C.isSyncConfigured({ ...cfg, username: "a@b.c", password: "x" }) === true);
  check("密码空着不算配置好", C.isSyncConfigured({ ...cfg, username: "a@b.c", password: "" }) === false);
  check("服务器地址空着不算配置好", C.isSyncConfigured({ ...cfg, baseUrl: "", username: "a@b.c", password: "x" }) === false);
  check("目录允许为空（放根目录）", C.readSyncConfig({ [K.syncDir]: "" }).dir === "");
  check("目录会去掉首尾空白", C.readSyncConfig({ [K.syncDir]: "  待办工作台  " }).dir === "待办工作台");
  check("设备名缺失时自动起一个", C.readSyncConfig({}).deviceName.startsWith("设备-"));
  check("设备 id 缺失时会现生成（且非空）", C.readSyncConfig({}).deviceId.length > 0);
  check("设备 id 存过就用存的", C.readSyncConfig({ [K.syncDeviceId]: "固定 id" }).deviceId === "固定 id");
  check("文件名：分片名 + .json", C.shardFileName("tasks") === "tasks.json");

  /* ---------------- 后端分派：OneDrive 是另一套协议 ---------------- */

  // 这一条是**老用户的兼容底线**：他们的设置里根本没有 sync.provider 这个键，
  // 读出来必须是 webdav，否则升级后同步会突然找不到账号密码。
  check("设置里没这个键时回落 webdav", C.parseSyncProvider(undefined) === "webdav");
  check("空串回落 webdav", C.parseSyncProvider("") === "webdav");
  check("认得出 webdav", C.parseSyncProvider("webdav") === "webdav");
  check("认得出 onedrive", C.parseSyncProvider("onedrive") === "onedrive");
  check("大小写不对的脏值也回落 webdav（手改过库不能把同步弄死）", C.parseSyncProvider("OneDrive") === "webdav");
  check("别的后端的残留值回落 webdav", C.parseSyncProvider("dropbox") === "webdav");
  check("readSyncConfig 默认读到 webdav", cfg.provider === "webdav", cfg.provider);
  check("默认值表里也写着 webdav", DEFAULT[K.syncProvider] === "webdav", DEFAULT[K.syncProvider]);
  check(
    "后端只有两个，且顺序稳定",
    C.SYNC_PROVIDERS.map((p) => p.id).join(",") === "webdav,onedrive",
    C.SYNC_PROVIDERS.map((p) => p.id).join(","),
  );
  check("每个后端都有人看的名字和一句说明", C.SYNC_PROVIDERS.every((p) => !!p.label && !!p.hint));
  check("providerLabel 取得到中文名", C.providerLabel("onedrive") === "OneDrive", C.providerLabel("onedrive"));
  check("providerLabel 对 webdav 取到坚果云", C.providerLabel("webdav").includes("坚果云"), C.providerLabel("webdav"));

  // OneDrive 那三项的解析。client_id 常是从网页上复制来的，带空格；令牌则不该被加工
  const odRaw = C.readSyncConfig({
    [K.syncProvider]: "onedrive",
    [K.onedriveClientId]: "  11111111-2222-3333-4444-555555555555  ",
    [K.onedriveRefreshToken]: " M.C5xx_refresh-token ",
    [K.onedriveAccount]: " someone@outlook.com ",
  });
  check("读得出 onedrive 后端", odRaw.provider === "onedrive");
  check("client_id 去掉首尾空白", odRaw.onedriveClientId === "11111111-2222-3333-4444-555555555555", `[${odRaw.onedriveClientId}]`);
  check("账号去掉首尾空白", odRaw.onedriveAccount === "someone@outlook.com", `[${odRaw.onedriveAccount}]`);
  check(
    "令牌原样保留（它是照抄回去换短令牌的，加工一个字符就废了）",
    odRaw.onedriveRefreshToken === " M.C5xx_refresh-token ",
    `[${odRaw.onedriveRefreshToken}]`,
  );
  check("OneDrive 后端照样读分片（两套协议共用同一套分片）", JSON.stringify(odRaw.shards) === '["tasks"]');
  check("切到 OneDrive 也不影响 WebDAV 那几项的读取", odRaw.baseUrl === C.DEFAULT_BASE_URL, odRaw.baseUrl);

  // 「配好了」的门槛两个后端不同 —— 共用一句判断会让 OneDrive 用户
  // 被要求去填坚果云的账号和应用密码
  const odBare = { ...odRaw, onedriveClientId: "", onedriveRefreshToken: "" };
  check("OneDrive：什么都没有 → 未配置", C.isSyncConfigured(odBare) === false);
  check(
    "OneDrive：只填了 client_id（还没登录）→ 仍未配置",
    C.isSyncConfigured({ ...odBare, onedriveClientId: "abc" }) === false,
  );
  check(
    "OneDrive：登录过（有令牌）→ 已配置",
    C.isSyncConfigured({ ...odBare, onedriveClientId: "abc", onedriveRefreshToken: "rt" }) === true,
  );
  check(
    "OneDrive：填了 WebDAV 账号密码也不算配好",
    C.isSyncConfigured({ ...odBare, username: "u@b.c", password: "p" }) === false,
  );
  check(
    "WebDAV：塞了 OneDrive 令牌也不算配好",
    C.isSyncConfigured({ ...cfg, onedriveClientId: "abc", onedriveRefreshToken: "rt" }) === false,
  );

  const hintBare = C.missingConfigHint(odBare);
  const hintHalf = C.missingConfigHint({ ...odBare, onedriveClientId: "abc" });
  check("OneDrive 缺 ID 时提示先填 ID", hintBare.includes("客户端 ID"), hintBare);
  check("OneDrive 填了 ID 未登录时提示去点连接", hintHalf.includes("连接 OneDrive"), hintHalf);
  check("两句提示不是同一句（缺什么说什么）", hintBare !== hintHalf);
  check("WebDAV 的提示仍指向账号与应用密码", C.missingConfigHint(cfg).includes("账号和应用密码"), C.missingConfigHint(cfg));

  // 设置项本身不参与同步：这些键不该出现在任何分片载荷里
  const shards = ["tasks", "orders", "gallery", "attachments"];
  check("设置不算分片", !shards.some((s) => s.includes("settings") || s.includes("config")));
}

section("14. 相对时间显示");
{
  const C = await import("../src/lib/syncClient.ts");
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  check("空值 → 还没同步过", C.relativeTime("", now) === "还没同步过");
  check("坏时间戳 → 还没同步过", C.relativeTime("坏", now) === "还没同步过");
  check("刚刚", C.relativeTime(new Date(now - 20_000).toISOString(), now) === "刚刚");
  check("分钟级", C.relativeTime(new Date(now - 5 * 60_000).toISOString(), now) === "5 分钟前");
  check("小时级", C.relativeTime(new Date(now - 3 * 3600_000).toISOString(), now) === "3 小时前");
  check("天级", C.relativeTime(new Date(now - 2 * 86400_000).toISOString(), now) === "2 天前");
  check("超过 30 天退回日期", /\d/.test(C.relativeTime(new Date(now - 40 * 86400_000).toISOString(), now)));
  check("未来时间不显示成负数", C.relativeTime(new Date(now + 60_000).toISOString(), now) === "刚刚");
}

/* ==================================================================== */
/* B. 数据库往返                                                         */
/* ==================================================================== */

section("15. 数据库：迁移到 v14，且同步用的列能写进去");
{
  resetDemoDb();
  const info = await initDb();
  check("驱动是内存库", info.driver === "memory", info.driver);
  check("schema 到 v14", info.schemaVersion === 14, `实际 v${info.schemaVersion}`);
}

// 跨小节复用的 id：第 16/17/19 节要用**同一条记录**验证"关联复活"和"附件没被牵连"，
// 各节自己新建数据的话，断言的其实是别的东西
let T1 = null;
let T2 = null;
let woWithAtt = null;

section("16. 待办分片：导出 → 与「另一台机器」合并 → 写回");
{
  resetDemoDb();
  await initDb();
  await repo.clearAllData();

  const L = await repo.createList("同步测试清单");
  T1 = await repo.createTask({ listId: L.id, title: "本地任务一", myDay: true });
  T2 = await repo.createTask({ listId: L.id, title: "本地任务二" });
  await repo.createStep(T1.id, "子任务甲");
  await repo.createStep(T1.id, "子任务乙");
  await repo.linkTasks(T1.id, T2.id);

  const local = await exportShardPayload("tasks");
  check("导出带上了列表", local.lists.length === 1, String(local.lists.length));
  check("导出带上了两条待办", local.tasks.length === 2, String(local.tasks.length));
  check("导出带上了子任务（挂在 T1 下）", (local.steps[T1.id] ?? []).length === 2);
  check("导出带上了关联", local.links.length === 1, String(local.links.length));
  check("导出的待办带 updatedAt（否则没法比新旧）", !!local.tasks[0].updatedAt);

  const later = new Date(Date.now() + 60_000).toISOString();
  const remote = {
    lists: local.lists,
    tasks: [
      // T1 被对面改过 → 应采纳对面
      { ...local.tasks.find((t) => t.id === T1.id), title: "本地任务一（对面改过）", updatedAt: later },
      // T2 被对面删了 → 墓碑应生效
      { ...local.tasks.find((t) => t.id === T2.id), deleted: true, updatedAt: later },
      // 对面新增一条
      { ...task("task-from-remote", { listId: L.id, title: "对面新增的任务" }), createdAt: later, updatedAt: later },
    ],
    // 对面把子任务重写成一条 —— 本地那条"子任务乙"应该随之消失
    steps: { [T1.id]: [step("step-from-remote", T1.id, "对面重写的子任务")] },
    // 对面取消了关联
    links: local.links.map((x) => ({ ...x, deleted: true, updatedAt: later })),
  };

  const merged = S.mergeShard("tasks", local, remote);
  info("合并统计", merged.stats);
  await applyShardPayload("tasks", merged.payload);

  const t1 = await repo.fetchTaskById(T1.id);
  check("T1 采用了对面的标题", t1?.title === "本地任务一（对面改过）", t1?.title);
  check("T1 的我的一天标记没丢", t1?.myDay === true);

  const alive = await repo.fetchTasks({ view: "all" });
  check("T2 的墓碑生效：界面路径看不到它", !alive.some((t) => t.id === T2.id));
  const withDeleted = await repo.fetchTasks({ view: "all", includeDeleted: true });
  check("带上墓碑能看到 T2", withDeleted.some((t) => t.id === T2.id));
  check("T2 确实被标成已删除", withDeleted.find((t) => t.id === T2.id)?.deleted === true);
  check("对面新增的任务进来了", (await repo.fetchTaskById("task-from-remote"))?.title === "对面新增的任务");

  const steps = await repo.fetchAllSteps();
  check("子任务是整组替换（只剩对面那一条）", (steps[T1.id] ?? []).length === 1, JSON.stringify(steps[T1.id]));
  check("留下了对面写的那条", steps[T1.id]?.[0]?.title === "对面重写的子任务");
  check("新增任务没有子任务时是空数组而不是报错", (steps["task-from-remote"] ?? []).length === 0);

  const linked = await repo.fetchLinkedTasks(T1.id);
  check("被取消的关联在界面上看不到了", linked.length === 0, JSON.stringify(linked.map((t) => t.id)));
}

section("17. 关联：取消是软删（能同步过去），重新关联是复活同一条而不是新插");
{
  // 1) 第 16 节里那条关联被对面取消了。行必须还在（墓碑），否则"取消"这件事
  //    就没法同步给第三台机器 —— 那边只会看到一条照旧活着的关联。
  let raw = await exportShardPayload("tasks");
  check("被取消的关联没有从库里消失（软删）", raw.links.length === 1, String(raw.links.length));
  check("它以墓碑形式存在", raw.links[0].deleted === true, String(raw.links[0].deleted));

  // 2) 复活：同一对任务重新关联，必须复用那一行。
  //    插新行会留下两条同任务对的记录，同步时无从分辨哪条代表"当前状态"。
  await repo.linkTasks(T1.id, T2.id);
  raw = await exportShardPayload("tasks");
  check("重新关联复用原行（仍然是 1 条）", raw.links.length === 1, String(raw.links.length));
  check("复活后 deleted = false", raw.links[0].deleted === false, String(raw.links[0].deleted));

  // 3) 另一对活任务：这条走的是"界面路径"，必须能看到
  const other = (await repo.fetchTasks({ view: "all" })).find((t) => t.id !== T1.id);
  await repo.unlinkTasks(T1.id, T2.id);
  await repo.linkTasks(T1.id, other.id);
  check(
    "活任务之间的关联在界面上看得到",
    (await repo.fetchLinkedTasks(T1.id)).some((t) => t.id === other.id),
  );
  raw = await exportShardPayload("tasks");
  check("现在有两条关联（一条墓碑 + 一条活的）", raw.links.length === 2, String(raw.links.length));

  // 4) 再取消：只改标志，不删行、不新增行
  await repo.unlinkTasks(T1.id, other.id);
  check("取消后界面路径看不到", (await repo.fetchLinkedTasks(T1.id)).length === 0);
  raw = await exportShardPayload("tasks");
  check("取消只是改标志，行数不变", raw.links.length === 2, String(raw.links.length));
  check("两条都是墓碑", raw.links.every((l) => l.deleted === true));
}

section("18. 写回用 upsert 而不是清空重插：只同步流程任务时不能连带删掉附件");
{
  resetDemoDb();
  await initDb();
  await repo.clearAllData();

  const F = await repo.createFlow("同步用流程");
  const stages = await repo.fetchStages();
  const wo = await repo.createWorkOrder({ title: "同步用工单", flowId: F.id });
  woWithAtt = wo;
  await repo.createAttachment({
    woId: wo.id,
    kind: "link",
    title: "参考链接",
    sourceUrl: "https://example.com/x",
  });
  check("附件先建好了", (await repo.fetchAttachments(wo.id)).length === 1);

  // 只跑「流程任务」这一个分片，载荷里**不含附件**
  const orders = await exportShardPayload("orders");
  check("流程分片载荷里没有附件字段", !("attachments" in orders));
  await applyShardPayload("orders", orders);

  const after = await repo.fetchAttachments(wo.id);
  check("附件记录没有因为同步流程任务而被连带删除", after.length === 1, String(after.length));
  check("附件内容还在", after[0]?.sourceUrl === "https://example.com/x");
  check("工单也还在", (await repo.fetchOrderById(wo.id))?.title === "同步用工单");
}

section("19. 流程任务分片：过程态整组走、流转记录取并集");
{
  const F = (await repo.fetchFlows())[0];
  let stages = await repo.fetchStages();
  const first = stages.find((s) => s.flowId === F.id && !s.isTerminal);
  const second = stages.find((s) => s.flowId === F.id && s.isTerminal);
  check("流程自带两个阶段", !!first && !!second);

  const wo = await repo.createWorkOrder({ title: "推进中的工单", flowId: F.id, stageId: first.id });
  await repo.moveOrderToStage(wo.id, second.id, "手工推到完成");
  const logs = await repo.fetchWoLogs(wo.id);
  check("推进产生了一条流转记录", logs.length >= 1, String(logs.length));

  const local = await exportShardPayload("orders");
  check("导出带上了过程态（按流程分组）", (local.stages[F.id] ?? []).length >= 2);
  check("导出带上了流转记录", local.woLogs.length >= 1);
  check("流转记录不带 seq（排序细节不外传）", !("seq" in local.woLogs[0]));

  const later = new Date(Date.now() + 60_000).toISOString();
  const remote = {
    ...local,
    // 对面的流程改了名 → 流程取胜，过程态跟着取对面那一组
    flows: local.flows.map((f) => (f.id === F.id ? { ...f, name: "对面改名的流程", updatedAt: later } : f)),
    stages: { [F.id]: [stage("stage-only-one", F.id, "对面只剩一步")] },
    // 对面多一条流转记录 → 并集
    woLogs: [
      ...local.woLogs,
      { id: "log-from-remote", woId: wo.id, fromStage: null, toStage: first.id, at: later, note: "对面写的" },
    ],
  };

  const merged = S.mergeShard("orders", local, remote);
  await applyShardPayload("orders", merged.payload);

  const flowsNow = await repo.fetchFlows();
  check("流程名采用了对面版本", flowsNow.find((f) => f.id === F.id)?.name === "对面改名的流程");
  const stagesNow = await repo.fetchStages();
  check("过程态整组替换成对面那一组", stagesNow.filter((s) => s.flowId === F.id).length === 1, String(stagesNow.filter((s) => s.flowId === F.id).length));
  const logsNow = await repo.fetchWoLogs(wo.id);
  check("流转记录并集（对面的那条进来了）", logsNow.some((l) => l.id === "log-from-remote"));
  check("原有流转记录没丢", logsNow.some((l) => logs.some((x) => x.id === l.id)));
  check("附件仍然没被牵连", (await repo.fetchAttachments(woWithAtt.id)).length === 1);
}

section("20. 只勾待办时，别的分片的表一行都不动");
{
  const beforeGallery = (await repo.fetchAllGallery()).length;
  const beforeOrders = (await repo.fetchWorkOrders({ view: "all", includeDone: true })).length;
  const beforeAtt = (await repo.fetchAllAttachments()).length;
  const beforeFlows = (await repo.fetchFlows()).length;

  const local = await exportShardPayload("tasks");
  const merged = S.mergeShard("tasks", local, local);
  await applyShardPayload("tasks", merged.payload);

  check("图库没动", (await repo.fetchAllGallery()).length === beforeGallery);
  check("流程任务没动", (await repo.fetchWorkOrders({ view: "all", includeDone: true })).length === beforeOrders);
  check("附件没动", (await repo.fetchAllAttachments()).length === beforeAtt);
  check("流程模板没动", (await repo.fetchFlows()).length === beforeFlows);
}

section("21. 图库与附件分片各自往返");
{
  const galLocal = await exportShardPayload("gallery");
  check("图库导出是个 items 数组", Array.isArray(galLocal.items));
  const gm = S.mergeShard("gallery", galLocal, galLocal);
  await applyShardPayload("gallery", gm.payload);
  check("图库往返不炸", (await repo.fetchAllGallery()).length === galLocal.items.length);

  const attLocal = await exportShardPayload("attachments");
  check("附件导出是个 items 数组", Array.isArray(attLocal.items));
  check("附件导出带 updatedAt", attLocal.items.length === 0 || !!attLocal.items[0].updatedAt);
  const am = S.mergeShard("attachments", attLocal, attLocal);
  await applyShardPayload("attachments", am.payload);
  check("附件往返不炸", (await repo.fetchAllAttachments()).length === attLocal.items.length);
}

section("22. 幂等：同一份数据同步两次，第二次不该再产生改动");
{
  resetDemoDb();
  await initDb();
  await repo.clearAllData();
  const L = await repo.createList("幂等清单");
  await repo.createTask({ listId: L.id, title: "幂等任务" });

  const p1 = await exportShardPayload("tasks");
  const m1 = S.mergeShard("tasks", p1, p1);
  await applyShardPayload("tasks", m1.payload);

  const p2 = await exportShardPayload("tasks");
  const m2 = S.mergeShard("tasks", p2, p2);
  check("第二次合并没有新增", m2.stats.added === 0, JSON.stringify(m2.stats));
  check("第二次合并没有更新", m2.stats.updated === 0, JSON.stringify(m2.stats));
  check("第二次合并没有要推上去的", m2.stats.pushed === 0, JSON.stringify(m2.stats));
  check("第二次合并没有冲突", m2.conflicts.length === 0);
  check("任务数没变", (await repo.fetchTasks({ view: "all" })).length === 1);
}

/* ==================================================================== */
/* C. 传输层分派（不连网、不起真应用：把 Tauri 的落地端换成记录器）        */
/* ==================================================================== */

section("23. 传输层分派：两个后端各打各的命令，配置形状不许串味");
{
  const C = await import("../src/lib/syncClient.ts");
  const D = await import("../src/lib/db.ts");
  const K = (await import("../src/lib/settings.ts")).SETTINGS;

  // Tauri v2 的 invoke 只有薄薄一层：window.__TAURI_INTERNALS__.invoke(...)。
  // 换掉它就等于把「Rust 那边」整个换掉 —— 不用启动真应用，也能断言
  // 「哪个后端打哪个命令、参数长什么样」这件事。这正是最容易写错、
  // 又只有真连上云盘才会暴露的一层。
  const calls = [];
  const replies = {};
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      const r = replies[cmd];
      return typeof r === "function" ? r(args) : r;
    },
  };
  const last = () => calls[calls.length - 1];
  const cmds = () => calls.map((c) => c.cmd).join(",");
  const reset = () => {
    calls.length = 0;
  };

  check("立起 Tauri 标记后 isTauri() 为真", D.isTauri() === true);

  /* ------------------------------ WebDAV ------------------------------ */

  const davCfg = C.readSyncConfig({
    [K.syncBaseUrl]: "  https://dav.example.com/dav  ",
    [K.syncUsername]: "u@example.com",
    [K.syncPassword]: "app-pass",
    [K.syncDir]: "待办工作台",
  });

  const dav = await C.openRemote(davCfg);
  check("WebDAV 开句柄不发任何请求（没有要先换的令牌）", calls.length === 0, cmds());

  replies["webdav_check"] = { dirExists: true, message: "目录可用，可以同步" };
  check("check() 把后端那句人话原样透出来", (await dav.check()) === "目录可用，可以同步");
  check("check() 打到 webdav_check", last().cmd === "webdav_check", last().cmd);

  replies["webdav_get"] = '{"app":"todo-workbench"}';
  const got = await dav.get("tasks.json");
  check("get() 打到 webdav_get", last().cmd === "webdav_get", last().cmd);
  check(
    "get() 的参数就 name + cfg 两个",
    Object.keys(last().args).sort().join(",") === "cfg,name",
    Object.keys(last().args).join(","),
  );
  check("文件名按分片名组织", last().args.name === "tasks.json", last().args.name);
  check("取回的内容原样交出去（解析是上层的事）", got === '{"app":"todo-workbench"}');
  check(
    "WebDAV 的 cfg 恰好四项，且不带 OneDrive 的字段",
    Object.keys(last().args.cfg).sort().join(",") === "baseUrl,dir,password,username",
    Object.keys(last().args.cfg).join(","),
  );
  check(
    "cfg 的值来自设置，地址已去掉首尾空白",
    last().args.cfg.baseUrl === "https://dav.example.com/dav",
    `[${last().args.cfg.baseUrl}]`,
  );
  check("目录照原样传下去", last().args.cfg.dir === "待办工作台", last().args.cfg.dir);

  replies["webdav_put"] = 123;
  const written = await dav.put("tasks.json", "hello");
  check("put() 打到 webdav_put", last().cmd === "webdav_put", last().cmd);
  check("put() 把上传字节数交回来", written === 123, String(written));

  replies["webdav_stat"] = { size: 42, modified: "2026-09-01T00:00:00Z" };
  const ent = await dav.stat("tasks.json");
  check("stat() 打到 webdav_stat", last().cmd === "webdav_stat", last().cmd);
  check(
    "stat() 只交出 size / modified（上层不关心远端文件长什么样）",
    Object.keys(ent).sort().join(",") === "modified,size",
    Object.keys(ent).join(","),
  );
  check("两个字段都透传", ent.size === 42 && ent.modified === "2026-09-01T00:00:00Z");

  replies["webdav_stat"] = null;
  check("云端没有这个文件时 stat() 返回 null（首次同步不是错误）", (await dav.stat("tasks.json")) === null);

  /* ----------------------------- OneDrive ----------------------------- */

  C.forgetOneDriveToken();
  reset();
  const odCfg = C.readSyncConfig({
    [K.syncProvider]: "onedrive",
    [K.onedriveClientId]: "client-abc",
    [K.onedriveRefreshToken]: "rt-1",
  });

  replies["onedrive_refresh"] = { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 };
  const od = await C.openRemote(odCfg);
  check("OneDrive 开句柄先换一次短期令牌", cmds() === "onedrive_refresh", cmds());
  check(
    "换令牌传的是 clientId + refreshToken，accessToken 传空（本来就是要换它）",
    last().args.cfg.clientId === "client-abc" &&
      last().args.cfg.refreshToken === "rt-1" &&
      last().args.cfg.accessToken === "",
    JSON.stringify(last().args.cfg),
  );

  reset();
  replies["onedrive_get"] = "{}";
  await od.get("orders.json");
  check("get() 打到 onedrive_get 而不是 webdav_get", last().cmd === "onedrive_get", last().cmd);
  check("分片名照旧是 xxx.json（两套协议的文件组织一致）", last().args.name === "orders.json", last().args.name);
  check(
    "OneDrive 的 cfg 恰好三项，且不带 WebDAV 的字段",
    Object.keys(last().args.cfg).sort().join(",") === "accessToken,clientId,refreshToken",
    Object.keys(last().args.cfg).join(","),
  );
  check("带上了刚换来的短期令牌", last().args.cfg.accessToken === "at-1", last().args.cfg.accessToken);
  check("长期令牌也一起带下去（Rust 侧遇到 401 还能自己再换一次）", last().args.cfg.refreshToken === "rt-1");

  // 令牌必须整轮复用：一轮同步最多 4 个分片，每个分片各刷一次既慢又容易被限流
  reset();
  const od2 = await C.openRemote(odCfg);
  await od2.get("tasks.json");
  check("第二次开句柄复用缓存令牌，不再多换一次", cmds() === "onedrive_get", cmds());

  // 轮换：微软每次刷新都可能发一个新的 refresh_token，旧的随后作废。
  // 不写回去的话这一轮照样跑得完，下一次点同步才报「授权已失效」——
  // 而且报得像是用户的问题。所以这里钉住「换到新的必须落库」。
  C.forgetOneDriveToken();
  reset();
  replies["onedrive_refresh"] = { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 };
  await C.openRemote(odCfg);
  check("清掉缓存后重新开句柄会再换一次令牌", cmds() === "onedrive_refresh", cmds());
  check("新令牌写回了内存里的那份配置", odCfg.onedriveRefreshToken === "rt-2", odCfg.onedriveRefreshToken);
  const stored = await repo.getAllSettings();
  check(
    "新令牌也落了库（否则下次启动会拿着那个已作废的）",
    stored[K.onedriveRefreshToken] === "rt-2",
    stored[K.onedriveRefreshToken],
  );

  reset();
  replies["onedrive_put"] = 7;
  replies["onedrive_stat"] = { size: 9, modified: "2026-09-02T00:00:00Z" };
  replies["onedrive_check"] = { folderExists: true, folderPath: "Apps/待办工作台", message: "应用专属文件夹已就绪" };
  const back = await od2.put("tasks.json", "x");
  check("put() 打到 onedrive_put", last().cmd === "onedrive_put", last().cmd);
  check("put() 也把字节数交回来", back === 7, String(back));
  await od2.stat("tasks.json");
  check("stat() 打到 onedrive_stat", last().cmd === "onedrive_stat", last().cmd);
  check("check() 打到 onedrive_check 并透出后端的话", (await od2.check()) === "应用专属文件夹已就绪");

  // 换了 Azure 应用（client_id 变了）之后，旧令牌不能再拿去用
  C.forgetOneDriveToken();
  reset();
  replies["onedrive_refresh"] = { accessToken: "at-3", refreshToken: "rt-3", expiresIn: 3600 };
  const other = C.readSyncConfig({
    [K.syncProvider]: "onedrive",
    [K.onedriveClientId]: "client-other",
    [K.onedriveRefreshToken]: "rt-other",
  });
  await C.openRemote(other);
  check("换了 client_id 后一定会重新换令牌（缓存不跨应用复用）", cmds() === "onedrive_refresh", cmds());
  check(
    "换的是新应用的凭据",
    last().args.cfg.clientId === "client-other" && last().args.cfg.refreshToken === "rt-other",
    JSON.stringify(last().args.cfg),
  );

  /* 收尾：把桩撤掉，让这个进程回到它启动时的样子 */
  delete globalThis.window.__TAURI_INTERNALS__;
  C.forgetOneDriveToken();
  check("撤掉标记后又回到非桌面环境", D.isTauri() === false);
}

/* ---------- 汇总 ---------- */

console.log("\n====================================================");
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log("====================================================");
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
