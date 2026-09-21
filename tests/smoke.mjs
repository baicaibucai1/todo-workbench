/**
 * 运行时冒烟测试。
 *
 * 目的：不依赖浏览器和 Rust 环境，直接在 Node 里验证
 * 「数据库层 + 业务仓库 + 工具隔离」三条链路的真实行为。
 *
 * 用法：
 *   node --experimental-vm-modules tests/smoke.mjs
 * 或通过 npm run smoke
 */

import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ---------- 准备浏览器环境（提供 localStorage 与 crypto） ---------- */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
// Node 22 的 globalThis.crypto 是只读 getter，不能直接赋值。
// 它本身已提供 randomUUID，无需替换，仅在缺失时才补。
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: dom.window.crypto,
    configurable: true,
  });
}

/* ---------- 测试框架（极简） ---------- */

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

/* ---------- 载入业务模块 ---------- */

const { initDb, dbInfo, db, resetDemoDb } = await import("../src/lib/db.ts");
const { CURRENT_SCHEMA_VERSION } = await import("../src/lib/migrations.ts");
const repo = await import("../src/lib/repo.ts");
const { loadTools, listTools, toolTable, validateManifest } = await import(
  "../src/lib/tools.ts"
);
const { fetchToolDemoData } = await import("../src/lib/toolDemo.ts");
const { groupRows, firstVisibleRow } = await import("../src/lib/rows.ts");
const { collectUrgent, taskDeadline, orderDeadline } = await import("../src/lib/urgent.ts");
const { parseUrgentMinutes } = await import("../src/lib/settings.ts");
const wp = await import("../src/lib/wallpapers.ts");

/* ---------- 1. 数据库初始化与迁移 ---------- */

section("1. 数据库初始化与迁移");

resetDemoDb();
const info = await initDb();
check("驱动自动选择成功", info.driver === "memory", `实际: ${info.driver}`);
check("迁移执行到最新版本", info.schemaVersion === CURRENT_SCHEMA_VERSION, `实际: v${info.schemaVersion}`);

const tables = await db().select(
  "SELECT name FROM sqlite_master WHERE type = 'table'",
).catch(() => []);
check("内存库不抛异常即可（无 sqlite_master 概念）", Array.isArray(tables));

// 迁移 v8 把「特殊单号」做成了工单的子集：新增 core_wo_fields（自定义相关信息），
// 并在 core_work_orders / core_wo_stages 上加了 kind / stage_due_at / default_minutes。
// COUNT 得出来就说明表真的存在 —— 比查 sqlite_master 更通用，两种驱动都适用。
const woFieldRows = await db()
  .select("SELECT COUNT(*) AS n FROM core_wo_fields")
  .catch(() => null);
check(
  "迁移 v8 建好了 core_wo_fields",
  woFieldRows !== null && Number(woFieldRows[0]?.n) === 0,
  woFieldRows === null ? "表不存在" : `行数=${woFieldRows[0]?.n}`,
);

// v4 建的那张工具私有表（tool_special_orders_records）由 v8 负责 DROP。
// 注意这里**故意不断言它没了**：MemoryDb 的 run() 只认 INSERT/UPDATE/DELETE，
// DROP TABLE 是个静默的空操作，浏览器 demo 里那张空表会一直留着 —— 无害，
// 但拿它当断言就会变成一个只在 SQLite 下成立的假绿灯。
// 真正要守住的是「特殊单号不再走工具私有表」，见第 23 节。

// 迁移 v5 的工具 KV 表 —— AI 生成的配置就存在这里，所以它必须真的能读写。
const kvRows = await db()
  .select("SELECT COUNT(*) AS n FROM core_tool_kv")
  .catch(() => null);
check(
  "迁移 v5 建好了 core_tool_kv",
  kvRows !== null && Number(kvRows[0]?.n) === 0,
  kvRows === null ? "表不存在" : `行数=${kvRows[0]?.n}`,
);

// 手动走一遍「先查后写」的两步 upsert：这正是 toolBridge 用的写法，
// 两个驱动共用同一段 SQL，所以这里必须两种都过。
await db().execute(
  "INSERT INTO core_tool_kv (tool_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
  ["ai-gen", "config", '{"a":1}', "2026-01-01T00:00:00.000Z"],
);
await db().execute(
  "UPDATE core_tool_kv SET value = ?, updated_at = ? WHERE tool_id = ? AND key = ?",
  ['{"a":2}', "2026-01-02T00:00:00.000Z", "ai-gen", "config"],
);
const kvOne = await db().select(
  "SELECT value FROM core_tool_kv WHERE tool_id = ? AND key = ?",
  ["ai-gen", "config"],
);
check("KV 先查后写可更新", kvOne[0]?.value === '{"a":2}', `实际: ${kvOne[0]?.value}`);

// 隔离：另一个工具的同一个键读取时不应看到上面的值
const kvOther = await db().select(
  "SELECT value FROM core_tool_kv WHERE tool_id = ? AND key = ?",
  ["image-crop", "config"],
);
check("KV 按 tool_id 隔离", kvOther.length === 0, `实际命中 ${kvOther.length} 行`);

await db().execute("DELETE FROM core_tool_kv WHERE tool_id = ? AND key = ?", ["ai-gen", "config"]);

// 迁移幂等性：重复初始化不应重复执行
const info2 = await initDb();
check("重复初始化幂等", info2.schemaVersion === CURRENT_SCHEMA_VERSION);

/* ---------- 2. 种子数据 ---------- */

section("2. 首次运行种子数据");

await repo.seedIfEmpty();
const lists = await repo.fetchLists();
check("自动创建了列表", lists.length >= 2, `实际: ${lists.length} 个`);
check("列表名称正确", lists.some((l) => l.name === "工作"), lists.map((l) => l.name).join(","));

const allTasks = await repo.fetchTasks({ view: "all", includeDone: true });
check("种子任务已写入", allTasks.length >= 4, `实际: ${allTasks.length} 条`);
check("存在已完成任务", allTasks.some((t) => t.done));
check("存在「我的一天」任务", allTasks.some((t) => t.myDay));
check("存在重要任务", allTasks.some((t) => t.important));
check("存在每日任务", allTasks.some((t) => t.repeat === "daily"));

// 再次调用不应重复插入
await repo.seedIfEmpty();
const after = await repo.fetchTasks({ view: "all", includeDone: true });
check("种子数据不重复插入", after.length === allTasks.length, `${allTasks.length} -> ${after.length}`);

/* ---------- 3. 任务 CRUD ---------- */

section("3. 任务增删改查");

const workList = lists.find((l) => l.name === "工作");
const created = await repo.createTask({
  listId: workList.id,
  title: "冒烟测试任务",
  note: "由测试创建",
});
check("创建任务返回实体", created.id.length > 0 && created.title === "冒烟测试任务");
check("新任务默认未完成", created.done === false);
check("新任务排在最前", created.sortOrder < 0, `sortOrder=${created.sortOrder}`);

await repo.updateTask(created.id, { done: true });
let fetched = (await repo.fetchTasks({ view: "all", includeDone: true })).find(
  (t) => t.id === created.id,
);
check("标记完成后 done 为真", fetched?.done === true);
check("完成后自动记录时间", !!fetched?.completedAt, `completedAt=${fetched?.completedAt}`);

await repo.updateTask(created.id, { done: false });
fetched = (await repo.fetchTasks({ view: "all", includeDone: true })).find(
  (t) => t.id === created.id,
);
check("取消完成后时间被清空", fetched?.completedAt === null);

await repo.updateTask(created.id, { title: "改名后的任务", important: true });
fetched = (await repo.fetchTasks({ view: "important", includeDone: true })).find(
  (t) => t.id === created.id,
);
check("重命名生效", fetched?.title === "改名后的任务");
check("重要视图能筛选到该任务", !!fetched);

// 非法字段应被白名单拦掉
await repo.updateTask(created.id, { hackField: "注入" });
fetched = (await repo.fetchTasks({ view: "all", includeDone: true })).find(
  (t) => t.id === created.id,
);
check("非白名单字段被忽略且不报错", fetched?.title === "改名后的任务");

await repo.deleteTask(created.id);
const afterDelete = await repo.fetchTasks({ view: "all", includeDone: true });
check("软删除后查询不到", !afterDelete.some((t) => t.id === created.id));

/* ---------- 4. 视图筛选 ---------- */

section("4. 智能视图筛选");

const myDayTasks = await repo.fetchTasks({ view: "myday" });
// 「我的一天」= 手动加入 + 今天到期 + 每日任务，三者并集（见第 11 节的专项验证）
check("我的一天包含手动加入的任务",
  myDayTasks.every((t) => t.myDay || t.dueDate === repo.today() || t.repeat === "daily") &&
    myDayTasks.some((t) => t.myDay));

const importantTasks = await repo.fetchTasks({ view: "important" });
check("重要视图只返回标记任务", importantTasks.every((t) => t.important));

const plannedTasks = await repo.fetchTasks({ view: "planned" });
check("计划内只返回有日期的任务", plannedTasks.every((t) => t.dueDate !== null));

const listTasks = await repo.fetchTasks({ view: "list", listId: workList.id, includeDone: true });
check("列表视图按 listId 过滤", listTasks.every((t) => t.listId === workList.id));

const searched = await repo.fetchTasks({ view: "all", search: "订单", includeDone: true });
check("搜索能命中", searched.length > 0, `命中 ${searched.length} 条`);
check("搜索结果为关键词匹配", searched.every((t) => t.title.includes("订单")));

/* ---------- 5. 计数 ---------- */

section("5. 角标计数");

const counts = await repo.fetchCounts();
const actualMyDay = (await repo.fetchTasks({ view: "myday" })).length;
check("我的一天计数一致", counts.myday === actualMyDay, `${counts.myday} vs ${actualMyDay}`);
check("列表分组计数存在", Object.keys(counts.byList).length > 0);

/* ---------- 6. 列表管理 ---------- */

section("6. 列表管理");

const newList = await repo.createList("测试列表");
check("创建列表成功", newList.name === "测试列表" && newList.color.startsWith("#"));

await repo.renameList(newList.id, "改名列表");
const renamed = (await repo.fetchLists()).find((l) => l.id === newList.id);
check("重命名列表生效", renamed?.name === "改名列表");

const taskInNewList = await repo.createTask({ listId: newList.id, title: "待级联删除" });
await repo.deleteList(newList.id);
check("列表软删除后不可见", !(await repo.fetchLists()).some((l) => l.id === newList.id));
check(
  "列表下任务被一并软删除",
  !(await repo.fetchTasks({ view: "all", includeDone: true })).some(
    (t) => t.id === taskInNewList.id,
  ),
);

/* ---------- 7. 工具系统 ---------- */

section("7. 工具装载与契约校验");

const tools = await loadTools();
check("内置工具已注册", tools.length >= 1, `实际: ${tools.length} 个`);
check("图片裁剪工具在列", tools.some((t) => t.id === "image-crop"));
check("尺码表生成器工具在列", tools.some((t) => t.id === "size-chart"));
check("AI 生成工具在列", tools.some((t) => t.id === "ai-gen"));
// 「特殊单号记录」曾经是个 iframe 占位工具（tools/special-orders）。
// 它现在改成了原生专属视图：时效要跟流转记录、计划表绑在一起，
// 而工具在物理上碰不到 core_* 表（见第 8/9 节的隔离），塞不进去。
check(
  "占位工具 special-orders 已下线（改走原生视图）",
  !tools.some((t) => t.id === "special-orders"),
  tools.map((t) => t.id).join(","),
);
// 任何工具都必须能把入口显示出来，否则侧边栏点了是空白
check(
  "每个工具都有入口与图标",
  tools.every((t) => !!t.entry && !!t.icon),
  tools.map((t) => `${t.id}:${t.icon}`).join(" "),
);
check("工具清单查询一致", listTools().length === tools.length);

// 磁盘上的每个工具目录都要自成一体：manifest 能过校验、id 与目录名一致、entry 真实存在。
// 工具是运行时可插拔的，坏掉的 manifest 不该等到装完才发现。
const toolsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");
const toolDirs = fs.existsSync(toolsRoot)
  ? fs.readdirSync(toolsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
  : [];
check("磁盘上存在工具目录", toolDirs.length >= 1, `实际: ${toolDirs.length} 个`);
for (const d of toolDirs) {
  const dir = path.join(toolsRoot, d.name);
  let parsed = null;
  try {
    parsed = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
  } catch {
    /* parsed 保持 null，下面统一报失败 */
  }
  check(`tools/${d.name}/manifest.json 通过校验`, parsed !== null);
  if (!parsed) continue;
  // 扫描是按目录名读的，id 对不上就会出现"清单里有、装不上"的错位
  check(`tools/${d.name} 的 id 与目录名一致`, parsed.id === d.name, `manifest id=${parsed.id}`);
  check(`tools/${d.name} 的 entry 真实存在`, fs.existsSync(path.join(dir, parsed.entry)), parsed.entry);
}

// manifest 校验：这里是安全边界，必须挡得住异常输入
check("拒绝 null", validateManifest(null) === null);
check("拒绝空对象", validateManifest({}) === null);
check("拒绝非法 id（大写）", validateManifest({ id: "BadID", name: "x", entry: "i.html" }) === null);
check("拒绝非法 id（含下划线）", validateManifest({ id: "bad_id", name: "x", entry: "i.html" }) === null);
check(
  "拒绝路径穿越 entry",
  validateManifest({ id: "ok-tool", name: "x", entry: "../../evil.html" }) === null,
);
check(
  "拒绝绝对路径 entry",
  validateManifest({ id: "ok-tool", name: "x", entry: "/etc/passwd" }) === null,
);
check(
  "拒绝协议型 entry",
  validateManifest({ id: "ok-tool", name: "x", entry: "http://evil.com/x.html" }) === null,
);
const good = validateManifest({
  id: "order-record",
  name: "订单记录",
  entry: "index.html",
  dbVersion: 2,
});
check("接受合法 manifest", good !== null && good.dbVersion === 2);
check("缺失 dbVersion 时默认 1", validateManifest({ id: "t1", name: "n", entry: "a.html" }).dbVersion === 1);

/* ---------- 8. 表名隔离（SQL 注入防护） ---------- */

section("8. 表名隔离");

check("正常表名加前缀", toolTable("order-record", "orders") === "tool_order_record_orders");
check("连字符转下划线", toolTable("image-crop", "jobs").includes("image_crop"));
let threw = false;
try {
  toolTable("bad; DROP TABLE core_tasks", "orders");
} catch {
  threw = true;
}
check("非法工具 id 抛异常", threw);

threw = false;
try {
  toolTable("ok", "orders; DROP TABLE core_tasks");
} catch {
  threw = true;
}
check("非法表名抛异常", threw);

/* ---------- 9. 工具与核心共库隔离 ---------- */

section("9. 工具数据与核心数据隔离");

const coreBefore = await repo.fetchTasks({ view: "all", includeDone: true });
const demo = await fetchToolDemoData("order-record");
check("工具私有表已创建", demo.table === "tool_order_record_orders", demo.table);
check("工具示例数据写入成功", demo.rows.length === 3, `实际: ${demo.rows.length} 行`);

const coreAfter = await repo.fetchTasks({ view: "all", includeDone: true });
check(
  "工具建表未影响核心数据",
  coreAfter.length === coreBefore.length,
  `${coreBefore.length} -> ${coreAfter.length}`,
);

// 重复调用应复用已有数据而非重复插入
const demo2 = await fetchToolDemoData("order-record");
check("工具数据幂等", demo2.rows.length === demo.rows.length);

/* ---------- 10. 日期工具 ---------- */

section("10. 日期工具");

const todayStr = repo.today();
check("today 格式为 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(todayStr), todayStr);
const tomorrow = repo.addDays(todayStr, 1);
check("addDays 跨月正确", /^\d{4}-\d{2}-\d{2}$/.test(tomorrow) && tomorrow > todayStr);
check("本月日期与系统一致", todayStr.endsWith(`${new Date().getDate()}`.padStart(2, "0")));
check("addDays 负数可用", repo.addDays(todayStr, -1) < todayStr);
check("addDays 跨年正确", repo.addDays("2026-12-31", 1) === "2027-01-01");

/* ---------- 11. 每日任务 ---------- */

section("11. 每日任务与跨天重置");

const daily = await repo.createTask({
  listId: workList.id,
  title: "每日冒烟任务",
  repeat: "daily",
});
check("创建每日任务 repeat=daily", daily.repeat === "daily");
check("每日任务出现在我的一天",
  (await repo.fetchTasks({ view: "myday", includeDone: true })).some((t) => t.id === daily.id));

// 「我的一天」= 手动加入 + 今天到期 + 每日任务
const dueToday = await repo.createTask({
  listId: workList.id,
  title: "今天到期任务",
  dueDate: repo.today(),
});
check("今天到期的任务出现在我的一天",
  (await repo.fetchTasks({ view: "myday", includeDone: true })).some((t) => t.id === dueToday.id));

const dueTomorrow = await repo.createTask({
  listId: workList.id,
  title: "明天到期任务",
  dueDate: repo.addDays(repo.today(), 1),
});
check("明天到期的任务不出现在我的一天",
  !(await repo.fetchTasks({ view: "myday", includeDone: true })).some((t) => t.id === dueTomorrow.id));

// 跨天重置：把完成日期伪造成昨天，跑一遍重置应当把它清回未完成
await repo.updateTask(daily.id, { done: true, repeatDoneOn: repo.addDays(repo.today(), -1) });
const rolled = await repo.rolloverDailyTasks(repo.today());
check("跨天重置命中昨日完成的每日任务", rolled >= 1, `reset=${rolled}`);
const afterRoll = (await repo.fetchTasks({ view: "all", includeDone: true })).find(
  (t) => t.id === daily.id,
);
check("重置后回到未完成", afterRoll?.done === false && afterRoll?.repeatDoneOn === null);
check("重置幂等", (await repo.rolloverDailyTasks(repo.today())) === 0);

// 今天完成的不会被重置
await repo.updateTask(daily.id, { done: true, repeatDoneOn: repo.today() });
check("今天完成的每日任务不会被重置", (await repo.rolloverDailyTasks(repo.today())) === 0);

await repo.deleteTask(daily.id);
await repo.deleteTask(dueToday.id);
await repo.deleteTask(dueTomorrow.id);

/* ---------- 12. 步骤、关联与提醒 ---------- */

section("12. 步骤、任务关联与提醒");

const hostTask = await repo.createTask({ listId: workList.id, title: "带步骤的任务" });
const step1 = await repo.createStep(hostTask.id, "第一步");
const step2 = await repo.createStep(hostTask.id, "第二步");
check("创建步骤", step1.title === "第一步" && step2.sortOrder > step1.sortOrder);
check("步骤按任务分组返回", ((await repo.fetchAllSteps())[hostTask.id] ?? []).length === 2);

await repo.updateStep(step1.id, { done: true });
check("勾选步骤生效",
  ((await repo.fetchAllSteps())[hostTask.id] ?? []).find((s) => s.id === step1.id)?.done === true);

await repo.updateStep(step1.id, { title: "改过的步骤" });
check("步骤改名生效",
  ((await repo.fetchAllSteps())[hostTask.id] ?? []).some((s) => s.title === "改过的步骤"));

await repo.deleteStep(step2.id);
check("删除步骤生效", ((await repo.fetchAllSteps())[hostTask.id] ?? []).length === 1);

const otherTask = await repo.createTask({ listId: workList.id, title: "被关联的任务" });
check("建立关联", (await repo.linkTasks(hostTask.id, otherTask.id)) === true);
check("同向重复关联被忽略", (await repo.linkTasks(hostTask.id, otherTask.id)) === false);
check("反向重复关联也被忽略", (await repo.linkTasks(otherTask.id, hostTask.id)) === false);
check("不能关联自己", (await repo.linkTasks(hostTask.id, hostTask.id)) === false);
check("主方向能查到关联",
  (await repo.fetchLinkedTasks(hostTask.id)).some((t) => t.id === otherTask.id));
check("反向也能查到关联（关联是无向的）",
  (await repo.fetchLinkedTasks(otherTask.id)).some((t) => t.id === hostTask.id));

await repo.unlinkTasks(otherTask.id, hostTask.id);
check("从另一侧解除关联同样生效", (await repo.fetchLinkedTasks(hostTask.id)).length === 0);

// 删任务要把步骤和关联一起带走，否则会留下孤儿数据
await repo.linkTasks(hostTask.id, otherTask.id);
await repo.deleteTask(hostTask.id);
check("删除任务后步骤被清空", ((await repo.fetchAllSteps())[hostTask.id] ?? []).length === 0);
check("删除任务后关联被清空", (await repo.fetchLinkedTasks(otherTask.id)).length === 0);

const remindTask = await repo.createTask({ listId: workList.id, title: "有提醒的任务" });
await repo.updateTask(remindTask.id, { remindAt: new Date(Date.now() - 60_000).toISOString() });
check("到点提醒能被扫到",
  (await repo.fetchRemindableTasks()).some((t) => t.id === remindTask.id));
await repo.updateTask(remindTask.id, { done: true });
check("已完成的任务不再提醒",
  !(await repo.fetchRemindableTasks()).some((t) => t.id === remindTask.id));
await repo.deleteTask(remindTask.id);
await repo.deleteTask(otherTask.id);

/* ---------- 13. 配置与备份 ---------- */

section("13. 配置与备份");

await repo.setSettings({ "profile.name": "苏打", "appearance.theme": "dark" });
const cfg = await repo.getAllSettings();
check("写入配置可读回", cfg["profile.name"] === "苏打" && cfg["appearance.theme"] === "dark");

await repo.setSettings({ "profile.name": "新名字" });
check("同键覆盖不产生重复行",
  Object.values(await repo.getAllSettings()).filter((v) => v === "新名字").length === 1);

const backup = await repo.exportBackup();
check("导出包含列表与任务", backup.lists.length > 0 && backup.tasks.length > 0);
check("导出包含配置", backup.settings["profile.name"] === "新名字");

// 导入一份"另一个世界"的备份，应当整体覆盖现有数据
const other = structuredClone(backup);
const t0 = "2026-01-01T00:00:00.000Z";
other.lists = [
  { id: "bak-list-1", name: "备份列表", color: "#123456", sortOrder: 0, deleted: false, createdAt: t0, updatedAt: t0 },
];
other.tasks = [
  {
    id: "bak-task-1", listId: "bak-list-1", title: "备份任务", note: "", done: false,
    important: false, myDay: false, dueDate: null, remindAt: null, completedAt: null,
    repeat: "daily", repeatDoneOn: null, sortOrder: 0, deleted: false, createdAt: t0, updatedAt: t0,
  },
];
other.settings = { "profile.name": "备份里的名字" };
other.steps = {
  "bak-task-1": [
    { id: "bak-step-1", taskId: "bak-task-1", title: "备份步骤", done: false, sortOrder: 0 },
  ],
};
const imp = await repo.importBackup(other);
check("导入完成", imp.lists === 1 && imp.tasks === 1, `lists=${imp.lists} tasks=${imp.tasks}`);
check("导入的步骤写回成功",
  ((await repo.fetchAllSteps())["bak-task-1"] ?? []).some((s) => s.title === "备份步骤"));

const afterImp = await repo.fetchTasks({ view: "all", includeDone: true });
check("导入后旧数据被清空", afterImp.length === 1 && afterImp[0].id === "bak-task-1",
  `实际 ${afterImp.length} 条`);
check("导入的每日任务保留 repeat", afterImp[0]?.repeat === "daily");
check("导入的配置生效", (await repo.getAllSettings())["profile.name"] === "备份里的名字");

await repo.clearAllData();
check("清空后任务为 0", (await repo.fetchTasks({ view: "all", includeDone: true })).length === 0);
check("清空后配置为空", Object.keys(await repo.getAllSettings()).length === 0);

/* ---------- 14~18. 工单 ---------- */
/*
 * 这一段整体放在一个块作用域里。
 *
 * 不是为了「封装」，纯粹是图省事且不易错：文件已经很长，前面 13 段用掉了
 * 一大堆短变量名（t0 / renamed / plan …），新写的段落很容易撞名，
 * 而 esbuild 一次只报一个。块作用域一次性把所有这类问题挡掉。
 */
{
/* ---------- 14. 工单：流程模板、过程态流转、时间语义 ---------- */

section("14. 工单流程与过程态");

// 这一段存在的意义不只是"功能对不对"：MemoryDb 是手写的迷你 SQL 引擎，
// 它不支持 JOIN、子查询，也只认单个聚合函数（都会**静默返回空/0**）。
// 工单查询最初就用了 JOIN，浏览器里表现为"工单列表永远空白"，而桌面端正常。
// 所以这里必须在 memory 驱动上真跑一遍。
await repo.clearAllData();
await repo.seedWorkOrderFlowsIfEmpty();

const flows0 = await repo.fetchFlows();
check("种下三套流程", flows0.length === 3, `实际 ${flows0.length}`);
check("有且只有一个默认流程", flows0.filter((f) => f.isDefault).length === 1);
check("默认流程是「标准工单」", flows0.find((f) => f.isDefault)?.name === "标准工单");
// 「特殊单号」那套是给带处理时效的单子用的：它的每一步都带着默认时长
const spFlow0 = flows0.find((f) => f.name.includes("特殊单号"));
check("种下了「特殊单号处理」流程", !!spFlow0);
const spStages0 = (await repo.fetchStages())
  .filter((s) => s.flowId === spFlow0?.id)
  .sort((a, b) => a.sortOrder - b.sortOrder);
check("特殊单号流程的步骤顺序正确",
  spStages0.map((s) => s.name).join(">") === "待处理>处理中>待确认>已完成",
  spStages0.map((s) => s.name).join(">"));
check("特殊单号流程只有最后一步是终态", spStages0.filter((s) => s.isTerminal).length === 1);
check("非终态的步骤都配了默认时效",
  spStages0.filter((s) => !s.isTerminal).every((s) => s.defaultMinutes > 0),
  spStages0.map((s) => `${s.name}:${s.defaultMinutes}`).join(" "));
check("终态不配默认时效（走到就结束了，没有「下一步之前」）",
  spStages0.filter((s) => s.isTerminal).every((s) => s.defaultMinutes === 0));

const stdFlow = flows0.find((f) => f.isDefault);
const stdStages = (await repo.fetchStages())
  .filter((s) => s.flowId === stdFlow.id)
  .sort((a, b) => a.sortOrder - b.sortOrder);
check("标准流程有五步", stdStages.length === 5, `实际 ${stdStages.length}`);
check(
  "步骤顺序正确",
  stdStages.map((s) => s.name).join(">") === "待接单>已受理>处理中>待验收>已完成",
  stdStages.map((s) => s.name).join(">"),
);
check("只有最后一步是终态", stdStages.filter((s) => s.isTerminal).length === 1);
check(
  "各阶段 sort_order 递增且不从 0 重复",
  stdStages.every((s, i) => s.sortOrder === i),
  stdStages.map((s) => s.sortOrder).join(","),
);
check(
  "阶段颜色各不相同",
  new Set(stdStages.map((s) => s.color)).size === stdStages.length,
);

section("15. 工单的创建与过程态流转");

const wo = await repo.createWorkOrder({
  title: "冒烟测试工单",
  flowId: stdFlow.id,
  important: true,
});
check("创建成功", !!wo.id);
check("自动生成单号", /^WO-\d{8}-\d{3}$/.test(wo.no), wo.no);
check("落在第一步", wo.stageId === stdStages[0].id);
check("默认开始日期是今天", wo.startDate === repo.today());
check("未完结标记正确", wo.closed === false);

const logs0 = await repo.fetchWoLogs(wo.id);
check("创建时写入「开工」留痕", logs0.length === 1 && logs0[0].fromStage === null);

await repo.moveOrderToStage(wo.id, stdStages[2].id, "开始处理");
const mid = (await repo.fetchWorkOrders({ view: "all", includeDone: true })).find(
  (o) => o.id === wo.id,
);
check("过程态推进到位", mid?.stageId === stdStages[2].id);
check("推进后仍未完结", mid?.closed === false);
const logs1 = await repo.fetchWoLogs(wo.id);
check("流转留下两条记录", logs1.length === 2, `实际 ${logs1.length}`);
check("记录了从哪一步到哪一步", logs1[0].fromStage === stdStages[0].id);
check("流转备注被保留", logs1[0].note === "开始处理");

// 进终态：必须自动记完成时间
await repo.moveOrderToStage(wo.id, stdStages[4].id, "验收通过");
const closed = (await repo.fetchWorkOrders({ view: "all", includeDone: true })).find(
  (o) => o.id === wo.id,
);
check("进入终态后标记为已完结", closed?.closed === true);
check("进入终态自动记完成时间", !!closed?.completedAt);

// 退回非终态：完成时间必须清掉，否则数据自相矛盾
await repo.moveOrderToStage(wo.id, stdStages[1].id, "客户说要改");
const reopened = (await repo.fetchWorkOrders({ view: "all", includeDone: true })).find(
  (o) => o.id === wo.id,
);
check("退回后不再算完结", reopened?.closed === false);
check("退回后清掉完成时间", reopened?.completedAt === null);

// includeDone 的筛选：走的是 JS 侧过滤，两个驱动都要对
const allOrders = await repo.fetchWorkOrders({ view: "all", includeDone: true });
const openOrders = await repo.fetchWorkOrders({ view: "all" });
check("includeDone=true 能拿到", allOrders.some((o) => o.id === wo.id));
check("includeDone=false 会排除已完结的", openOrders.some((o) => o.id === wo.id));

section("16. 工单与「我的一天」的边界");

const woDay = repo.today();
const todayOrder = await repo.createWorkOrder({
  title: "今天要做的",
  flowId: stdFlow.id,
  startDate: woDay,
  // 就算显式传了 myDay 也该被忽略 —— 写入路径已经封死，
  // 留着这个入参只是为了证明"传了也不生效"
  myDay: true,
});
const futureOrder = await repo.createWorkOrder({
  title: "下周才开始的",
  flowId: stdFlow.id,
  startDate: repo.addDays(woDay, 7),
});

check("新建工单的 myDay 恒为 false", todayOrder.myDay === false);

const myday = await repo.fetchWorkOrders({ view: "myday", includeDone: true });
// 现在的边界是：**普通**工单不进「我的一天」，特殊单号进（它们是"今天在跟的、
// 等不起的单"，必须出现在默认视图里）。本节此刻还没建特殊单号，所以是 0；
// special 的放行在 23 节系统覆盖。
check("普通工单一条都不进「我的一天」", myday.length === 0, `实际 ${myday.length} 条`);

// 今日计划候选池用的是 today：今天开始/今天要交的
const todayPool = await repo.fetchWorkOrders({ view: "today", includeDone: true });
check("今天开始的进入 today 视图", todayPool.some((o) => o.id === todayOrder.id));
check("未来开始的不进 today 视图", !todayPool.some((o) => o.id === futureOrder.id));

const planned = await repo.fetchWorkOrders({ view: "planned", includeDone: true });
check("有计划日期的进入计划内", planned.some((o) => o.id === futureOrder.id));

const inList = await repo.fetchWorkOrders({ view: "list", includeDone: true });
check("清单视图不返回工单（工单不属于清单）", inList.length === 0);

section("17. 流程模板的可自定义性");

const newFlow = await repo.createFlow("临时流程");
const ns = await repo.fetchStages();
const newStages = ns.filter((s) => s.flowId === newFlow.id).sort((a, b) => a.sortOrder - b.sortOrder);
check("新流程自带两个可用阶段", newStages.length === 2);
check("新流程的第二个阶段是终态", newStages[1].isTerminal === true);

await repo.createStage(newFlow.id, "第三步", "#d4537e");
const afterAdd = (await repo.fetchStages())
  .filter((s) => s.flowId === newFlow.id)
  .sort((a, b) => a.sortOrder - b.sortOrder);
check("新增阶段排在最末", afterAdd[2]?.name === "第三步");
check("新增阶段拿到了不重复的 sort_order", afterAdd[2]?.sortOrder === 2);

await repo.moveStage(afterAdd[2].id, -1);
const moved = (await repo.fetchStages())
  .filter((s) => s.flowId === newFlow.id)
  .sort((a, b) => a.sortOrder - b.sortOrder);
check("上移后位置交换成功", moved[1]?.name === "第三步", moved.map((s) => s.name).join(">"));

await repo.updateStage(newFlow.id ? afterAdd[1].id : "", { name: "改过名的终态" });
const stageRenamed = (await repo.fetchStages()).find((s) => s.id === afterAdd[1].id);
check("阶段可改名", stageRenamed?.name === "改过名的终态");

// 被工单占用的阶段不能删 —— 静默把工单挪走比报错更糟
const blocked = await repo.deleteStage(stdStages[1].id);
check("被工单占用的阶段删不掉", blocked.ok === false && !!blocked.reason, blocked.reason);

const freeStage = afterAdd[2].id;
const freed = await repo.deleteStage(freeStage);
check("没被占用的阶段可以删", freed.ok === true);

// 有工单在用的流程不能删
const stdDel = await repo.deleteFlow(stdFlow.id);
check("有工单在用的流程删不掉", stdDel.ok === false && !!stdDel.reason, stdDel.reason);

await repo.setDefaultFlow(newFlow.id);
const defs = await repo.fetchFlows();
check("切换默认流程后仍只有一个默认", defs.filter((f) => f.isDefault).length === 1);
check("默认流程已切换", defs.find((f) => f.isDefault)?.id === newFlow.id);

section("18. 紧急判定：什么时候算「快到点了」");

{
  const MIN = 60_000;
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const T = (id, extra = {}) => ({
    id,
    title: id,
    done: false,
    deleted: false,
    dueDate: null,
    remindAt: null,
    ...extra,
  });
  const O = (id, extra = {}) => ({
    id,
    title: id,
    no: "",
    closed: false,
    deleted: false,
    dueDate: null,
    stageDueAt: null,
    ...extra,
  });
  const run = (tasks, orders, minutes = 120, nowMs = now) =>
    collectUrgent(tasks, orders, { thresholdMinutes: minutes, nowMs });

  // 阈值内外的分界
  const inWindow = run(
    [T("T-半小时后", { remindAt: at(30 * MIN) }), T("T-十小时后", { remindAt: at(600 * MIN) })],
    [],
  );
  check("阈值内的一条入选", inWindow.length === 1 && inWindow[0].id === "T-半小时后",
    inWindow.map((e) => e.id).join(","));

  // 只有日期没有钟点：按当天最后一刻算 —— "今天到期"不等于"现在就急"
  const dayEnd = new Date(`${repo.today()}T23:59:59`).getTime();
  const todayTask = T("T-今天到期", { dueDate: repo.today() });
  check("今天到期但离天黑还早，不算紧急",
    run([todayTask], [], 120, dayEnd - 5 * 60 * MIN).length === 0);
  check("临到当天末尾才算紧急",
    run([todayTask], [], 120, dayEnd - 30 * MIN).length === 1);

  // 截止时间取更早的那个：提醒时间是明确的钟点，但到期日可能比它还早
  check("提醒时间更早时按提醒时间算",
    taskDeadline(T("t", { remindAt: at(60 * MIN), dueDate: repo.addDays(repo.today(), 3) })).source === "remind");
  check("到期日更早时按到期日算",
    taskDeadline(T("t", { remindAt: at(3 * 24 * 60 * MIN), dueDate: repo.today() })).source === "due");
  check("工单的步骤时效优先于交付日",
    orderDeadline(
      O("o", { stageDueAt: at(20 * MIN), dueDate: repo.addDays(repo.today(), 5) }),
    ).source === "stage");

  // 混排后的顺序：逾期最久的排最前，其余按截止时刻升序
  const mix = run(
    [T("T-晚", { remindAt: at(90 * MIN) }), T("T-早", { remindAt: at(10 * MIN) })],
    [O("O-逾期", { stageDueAt: at(-40 * MIN) })],
  );
  check("逾期的排在最前", mix[0]?.id === "O-逾期", mix.map((e) => e.id).join(","));
  check("其余按截止时刻升序", mix[1]?.id === "T-早" && mix[2]?.id === "T-晚");
  check("逾期标记与文案正确",
    mix[0].overdue === true && mix[0].remainText.startsWith("已超") && mix[0].remainText.includes("40 分"),
    mix[0].remainText);
  check("未逾期的文案是「还剩」", mix[1].remainText === "还剩 10 分钟", mix[1].remainText);

  // 不进紧急区的四种情况
  check("已完成的待办不进紧急区", run([T("done", { remindAt: at(5 * MIN), done: true })], []).length === 0);
  check("已完结的工单不进紧急区",
    run([], [O("closed", { stageDueAt: at(5 * MIN), closed: true })]).length === 0);
  check("软删除的不进紧急区",
    run([T("del", { remindAt: at(5 * MIN), deleted: true })], []).length === 0);
  check("没有任何时间信息的永远不进紧急区", run([T("无")], [O("无")]).length === 0);

  // 阈值就是窗口本身：调到 0 时只剩已经过了点的
  check("阈值调到 0 时只剩逾期项", run(mix.length ? [T("T-早", { remindAt: at(10 * MIN) }), T("T-过", { remindAt: at(-MIN) })] : [], [], 0).length === 1);

  // 条数上限：超出的是"摆不下"，不是"不紧急"
  const many = Array.from({ length: 5 }, (_, i) => T(`T${i}`, { remindAt: at((i + 1) * MIN) }));
  check("超出上限时只留前 N 条",
    collectUrgent(many, [], { thresholdMinutes: 120, nowMs: now, limit: 2 }).length === 2);

  // 阈值解析：脏值一律夹回安全区间（算成 NaN 会让紧急区永远空着，且不报错）
  check("缺省值用默认阈值", parseUrgentMinutes(undefined) === 480);
  check("脏值落到默认阈值", parseUrgentMinutes("abc") === 480);
  check("过小的值夹到下限", parseUrgentMinutes("1") === 5);
  check("过大的值夹到上限", parseUrgentMinutes("999999") === 20160);

  // 候选池：store 拿去算紧急区的那两批数据，必须已经把"不欠的"排除掉
  let lists = await repo.fetchLists();
  if (!lists.length) {
    await repo.createList("紧急测试", "#d4537e");
    lists = await repo.fetchLists();
  }
  const doneTask = await repo.createTask({ listId: lists[0].id, title: "已完成的候选" });
  await repo.updateTask(doneTask.id, { done: true });
  const openTasks = await repo.fetchTasks({ view: "all", includeDone: false });
  check("候选池里没有已完成的待办", !openTasks.some((x) => x.id === doneTask.id));
  const openOrders = await repo.fetchWorkOrders({ view: "all", includeDone: false });
  check("候选池里没有已完结的工单", openOrders.every((o) => !o.closed));

  await repo.clearAllData();
  check("清空数据后工单为 0", (await repo.fetchWorkOrders({ view: "all", includeDone: true })).length === 0);
  check("清空数据后流程为 0", (await repo.fetchFlows()).length === 0);
  check("清空数据后紧急候选池为空",
    (await repo.fetchTasks({ view: "all", includeDone: false })).length === 0);
}

// 14~18 共用的那个块作用域在这里收口（见 536 行的说明）
}

/* ---------- 19. 列表排版与「默认展开第一条」同源 ---------- */

section("19. 列表排版与「默认展开第一条」同源");

{
  // 这一节守的是一条真实踩过的坑：列表按日期排、而"自动选中"按库里的顺序取，
  // 两边各写一遍 → 高亮在第 3 行、详情却是第 1 行 → 备注写到了别的任务上。
  // 所以 groupRows 与 firstVisibleRow 必须是同一份实现的两种用法。
  const D = (n) => repo.addDays(repo.today(), n);
  const task = (id, dueDate, extra = {}) => ({
    id,
    title: id,
    done: false,
    dueDate,
    repeat: "none",
    ...extra,
  });
  const order = (id, startDate, extra = {}) => ({
    id,
    title: id,
    closed: false,
    startDate,
    dueDate: null,
    ...extra,
  });

  // 「全部」按日期排：工单看开始日、待办看截止日，混在一起比
  const tasks = [task("T-远", D(5)), task("T-近", D(1)), task("T-无", null)];
  const orders = [order("O-中", D(-1)), order("O-远", D(9))];
  let groups = groupRows(tasks, orders, "all");
  check("「全部」把待办与工单混在一组", groups.sections.length === 1);
  check("「全部」组内共 5 行", groups.sections[0].items.length === 5);

  const first = firstVisibleRow(tasks, orders, "all");
  check("选中的是日期最早的那条（而不是数组里第一条）",
    first?.kind === "order" && first.order.id === "O-中",
    `${first?.kind}:${first?.kind === "order" ? first.order.id : first?.task?.id}`);

  // 与渲染顺序完全一致：firstVisibleRow 必须是 section 里的第 0 个
  const rendered = groups.sections[0].items[0];
  check("选中项 === 渲染出来的第一行",
    rendered.kind === first.kind &&
      (rendered.kind === "order" ? rendered.order.id : rendered.task.id) ===
        (first.kind === "order" ? first.order.id : first.task.id));

  // 已完成的待办与已完结的工单不进候选（它们在默认收起的「已完成」区里）
  const allDone = firstVisibleRow(
    [task("T-完", D(1), { done: true })],
    [order("O-完", D(1), { closed: true })],
    "all",
  );
  check("只剩已完成条目时没有候选（列表默认收起已完成区）", allDone === null);

  // 「我的一天」：特殊单号单独成组、按时效排、放在最上面（它们是提醒的前线）；
  // 今日组按日期排，且只排非每日任务；普通工单被挡在外面（rows 层第二道闸）
  const mdTasks = [task("T-每日", D(0), { repeat: "daily" }), task("T-今日", D(0))];
  const mdOrders = [
    order("O-特", D(-2), {
      kind: "special",
      stageDueAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    order("O-普", D(-2)),
  ];
  const myday = firstVisibleRow(mdTasks, mdOrders, "myday");
  check("「我的一天」里特殊单号排在待办前面（提醒优先）",
    myday?.kind === "order" && myday.order.id === "O-特",
    `${myday?.kind}:${myday?.kind === "order" ? myday.order.id : myday?.task?.id}`);

  const mdGroups = groupRows(mdTasks, mdOrders, "myday");
  check("「我的一天」第一组就是特殊单号", mdGroups.sections[0]?.key === "special");
  check("普通工单被挡在「我的一天」外（rows 层第二道闸）",
    mdGroups.sections
      .flatMap((s) => s.items)
      .every((r) => !(r.kind === "order" && r.order.kind !== "special")),
    mdGroups.sections.map((s) => s.key).join(","));

  const onlyDaily = firstVisibleRow([task("T-每日", null, { repeat: "daily" })], [], "myday");
  check("「我的一天」只剩每日任务时也能选到它",
    onlyDaily?.kind === "task" && onlyDaily.task.id === "T-每日");

  // 「计划内」按日期分桶，最早的一桶排在前面
  const planned = groupRows([task("T-后天", D(2))], [order("O-明天", D(1))], "planned");
  check("「计划内」按日期分桶", planned.sections.length === 2);
  check("「计划内」最早的一桶在前", planned.sections[0].key === D(1));
  check("「计划内」也能自动选中第一条",
    firstVisibleRow([task("T-后天", D(2))], [order("O-明天", D(1))], "planned")?.kind === "order");

  check("空列表时没有候选", firstVisibleRow([], [], "all") === null);
}

/* ---------- 20. 背景（壁纸）设置 ---------- */

section("20. 背景（壁纸）设置");

{
  // 背景是"存进配置的字符串"到"界面怎么画"之间的解析层。
  // 坏配置不能把界面变成空白，所以无法识别的值一律要落回 auto。
  check("没配过时是跟随视图", wp.parseBackground(undefined).kind === "auto");
  check("空字符串也是跟随视图", wp.parseBackground("").kind === "auto");
  check("显式 auto 解析正确", wp.parseBackground("auto").kind === "auto");
  check("识别 image:<文件>", wp.parseBackground("image:20260918.jpg").kind === "image");

  const img = wp.parseBackground("image:20260918.jpg");
  check("解析出的文件名正确", img.kind === "image" && img.file === "20260918.jpg");
  check("文件名带空格会被去掉",
    wp.parseBackground("image:  20260918.jpg  ").file === "20260918.jpg");

  // 「image:」后面是空的，等于选了一张不存在的图 —— 必须退回 auto 而不是渲染坏图
  check("只有 image: 前缀时退回 auto", wp.parseBackground("image:").kind === "auto");
  check("image: 后面只有空格也退回 auto", wp.parseBackground("image:   ").kind === "auto");
  check("认不出的值退回 auto", wp.parseBackground("乱写的值").kind === "auto");
  check("不是以 image: 开头就不当壁纸",
    wp.parseBackground("wallpaper:20260918.jpg").kind === "auto");

  check("序列化可以往返",
    wp.formatBackground(wp.parseBackground("image:20260918.jpg")) === "image:20260918.jpg");
  check("auto 往返不变", wp.formatBackground({ kind: "auto" }) === "auto");

  check("三档遮罩都被认", ["soft", "medium", "strong"].every(wp.isScrimLevel));
  check("非法遮罩档位不被认", !wp.isScrimLevel("strongest"));
  check("undefined 遮罩档位不被认", !wp.isScrimLevel(undefined));

  // 遮罩越强必须越暗：反了的话"强"档反而更看不清，是纯视觉 bug，断言不出来就没人发现
  check("遮罩档位递增（弱 < 中 < 强）",
    wp.SCRIM.soft.base < wp.SCRIM.medium.base &&
      wp.SCRIM.medium.base < wp.SCRIM.strong.base,
    JSON.stringify(wp.SCRIM));
  check("顶部压暗都比整体压暗更重（白标题在上面）",
    wp.SCRIM.soft.top > wp.SCRIM.soft.base &&
      wp.SCRIM.medium.top > wp.SCRIM.medium.base &&
      wp.SCRIM.strong.top > wp.SCRIM.strong.base);
  check("遮罩值都在合法区间", wp.SCRIM_LEVELS.every((lv) => {
    const s = wp.SCRIM[lv];
    return s.base >= 0 && s.base < 1 && s.top >= 0 && s.top < 1;
  }));

  check("壁纸路径落在 wallpapers 目录下",
    wp.wallpaperUrl("x.jpg").endsWith("wallpapers/x.jpg"), wp.wallpaperUrl("x.jpg"));

  // 清单读不到（没抓过图 / 离线）时必须安静地返回空数组，由界面给出补救提示
  const list = await wp.loadWallpapers();
  check("清单读不到时返回空数组而不是抛异常", Array.isArray(list) && list.length === 0,
    JSON.stringify(list));
  check("失败结果也被缓存（不会每次进设置都重发请求）",
    (await wp.loadWallpapers()) === list);
  wp.resetWallpaperCache();
  check("缓存可以清掉", (await wp.loadWallpapers()) !== null);
}

/* ---------- 21. 工单附件（本地仓库 + 链接） ---------- */

section("21. 工单附件");

{
  const att = await import("../src/lib/attachments.ts");

  // 前面几节测过删流程，把默认流程删掉了也不奇怪 —— 这里自建一套，
  // 让本节的断言不依赖别的节的副作用。
  const attFlow = await repo.createFlow("附件测试流程");
  const attFlowStages = (await repo.fetchStages()).filter((s) => s.flowId === attFlow.id);
  check("新建的流程自带可用过程态", attFlowStages.length >= 1, String(attFlowStages.length));

  /* --- 纯函数：类型判定 --- */
  check("本地月份分桶形如 YYYY-MM", /^\d{4}-\d{2}$/.test(att.monthBucket(new Date(2026, 8, 5))));
  check("月份补零", att.monthBucket(new Date(2026, 0, 5)) === "2026-01",
    att.monthBucket(new Date(2026, 0, 5)));
  check("月份用本地时间（不是 UTC）",
    att.monthBucket(new Date(2026, 0, 1, 0, 30)) === "2026-01",
    att.monthBucket(new Date(2026, 0, 1, 0, 30)));

  check("image/* 判为图片", att.kindFromMime("image/png") === "image");
  check("video/* 判为视频", att.kindFromMime("video/mp4") === "video");
  check("带参数的 mime 也能判", att.kindFromMime("image/jpeg; charset=binary") === "image");
  check("大小写不敏感", att.kindFromMime("IMAGE/PNG") === "image");
  check("PDF 归为链接", att.kindFromMime("application/pdf") === "link");
  check("空 mime 归为链接", att.kindFromMime("") === "link");

  check("按后缀猜得到图片", att.guessKindFromUrl("https://a.com/x.JPG") === "image");
  check("按后缀猜得到视频", att.guessKindFromUrl("https://a.com/x.webm") === "video");
  check("无后缀猜不出来就当链接", att.guessKindFromUrl("https://a.com/image") === "link");
  check("查询串不干扰后缀判断",
    att.guessKindFromUrl("https://a.com/x.png?w=100&h=100") === "image");

  /* --- 纯函数：命名 --- */
  check("从网址取文件名", att.fileNameFromUrl("https://a.com/p/photo.jpg") === "photo.jpg");
  check("网址百分号编码会被解开",
    att.fileNameFromUrl("https://a.com/%E4%BA%A7%E5%93%81%E5%9B%BE.png") === "产品图.png");
  check("路径结尾没有文件名时退回主机名", att.fileNameFromUrl("https://a.com/") === "a.com");
  check("非法网址不抛异常", typeof att.fileNameFromUrl("不是网址") === "string");

  check("站点名去掉 www", att.hostOf("https://www.bing.com/x") === "bing.com");
  check("端口保留在站点名里", att.hostOf("http://127.0.0.1:8080/x") === "127.0.0.1:8080");

  check("文件名保留中文", att.safeName("产品图.jpg") === "产品图.jpg");
  check("路径分隔符被剥掉", att.safeName("a/b/c.png") === "c.png");
  check("Windows 非法字符被替换", att.safeName("a:b?c*.png") === "a_b_c_.png");
  check("结尾的点被去掉", att.safeName("trailing...") === "trailing");
  check("全是空白时给个兜底名", att.safeName("   ") === "file");
  const attLong = att.safeName("中".repeat(200) + ".jpg");
  check("超长文件名被截断但保住扩展名",
    attLong.length <= 80 && attLong.endsWith(".jpg"), String(attLong.length));

  /* --- 纯函数：展示格式 --- */
  check("体积格式化到 B/KB",
    att.formatBytes(512) === "512 B" && att.formatBytes(2048) === "2 KB",
    `${att.formatBytes(512)} / ${att.formatBytes(2048)}`);
  check("体积格式化到 MB", att.formatBytes(3 * 1024 * 1024) === "3.0 MB",
    att.formatBytes(3 * 1024 * 1024));
  check("空体积不显示", att.formatBytes(null) === "");
  check("时长 mm:ss", att.formatDuration(83000) === "1:23", att.formatDuration(83000));
  check("时长超过一小时带小时", att.formatDuration(3723000) === "1:02:03",
    att.formatDuration(3723000));
  check("没有时长就不显示", att.formatDuration(null) === "");

  /* --- 错误信息提取 --- */
  check("错误信息：Error 用 message", att.errorText(new Error("说得清楚")) === "说得清楚");
  check("错误信息：字符串原样返回", att.errorText("Rust 侧的中文说明") === "Rust 侧的中文说明");
  check("错误信息：其它值也有兜底", att.errorText(undefined) === "未知错误");

  /* --- 上限与白名单 --- */
  check("图片上限小于视频上限", att.SIZE_LIMIT.image < att.SIZE_LIMIT.video,
    `${att.SIZE_LIMIT.image} / ${att.SIZE_LIMIT.video}`);
  check("上限是正整数", Object.values(att.SIZE_LIMIT).every((n) => n > 0 && Number.isInteger(n)));
  check("本地选择器只放图片和视频的后缀",
    att.MEDIA_EXTENSIONS.includes("jpg") && att.MEDIA_EXTENSIONS.includes("mp4") &&
      !att.MEDIA_EXTENSIONS.includes("pdf") && !att.MEDIA_EXTENSIONS.includes("exe"));

  /* --- 内容指纹 --- */
  const enc = new TextEncoder();
  const hashA = await att.contentHash(enc.encode("hello"));
  const hashB = await att.contentHash(enc.encode("hello"));
  const hashC = await att.contentHash(enc.encode("hello!"));
  check("指纹稳定（同内容同值）", hashA === hashB, hashA);
  check("指纹随内容变化", hashA !== hashC);
  check("指纹是 64 位十六进制（SHA-256）", /^[0-9a-f]{64}$/.test(hashA), hashA);
  // 已知值，钉住算法：换成别的哈希（比如自实现的 FNV）这条会立刻报警。
  // 必须与 Rust 侧 ring 算的是同一个算法，否则跨环境（桌面/浏览器）去重就对不上。
  check("指纹与标准 SHA-256 一致",
    hashA === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", hashA);

  /* --- 数据层 --- */
  const attOrder = await repo.createWorkOrder({ title: "带附件的工单", flowId: attFlow.id });
  const otherOrder = await repo.createWorkOrder({ title: "另一张工单", flowId: attFlow.id });

  const imgA = await repo.createAttachment({
    woId: attOrder.id, kind: "image", title: "产品图.png",
    relPath: "2026-09/abcd1234-产品图.png", sourceUrl: "https://a.com/1.png",
    mime: "image/png", size: 1234, hash: "hash-1",
  });
  check("附件创建成功", !!imgA.id);
  check("第一条的顺序号是 0", imgA.sortOrder === 0, String(imgA.sortOrder));

  const linkA = await repo.createAttachment({
    woId: attOrder.id, kind: "link", title: "规格说明书",
    sourceUrl: "https://a.com/spec.pdf", mime: "application/pdf",
  });
  check("第二条排在后面", linkA.sortOrder === 1, String(linkA.sortOrder));
  check("链接类没有本地路径", linkA.relPath === null, String(linkA.relPath));

  let attList = await repo.fetchAttachments(attOrder.id);
  check("按顺序取回", attList.map((x) => x.title).join(",") === "产品图.png,规格说明书",
    attList.map((x) => x.title).join(","));

  const attCounts = await repo.attachmentCounts();
  check("按工单统计附件数", attCounts[attOrder.id] === 2, JSON.stringify(attCounts));
  check("没附件的工单不出现在统计里", attCounts[otherOrder.id] === undefined);

  /* --- 去重：同一份内容被两张工单引用 --- */
  const imgB = await repo.createAttachment({
    woId: otherOrder.id, kind: "image", title: "同一张图",
    relPath: "2026-09/abcd1234-产品图.png", mime: "image/png", size: 1234, hash: "hash-1",
  });
  check("同一份内容被两张工单引用时引用计数为 2",
    (await repo.refCountByHash("hash-1")) === 2, String(await repo.refCountByHash("hash-1")));

  /* --- 删除时的文件回收判断（最容易写错、也最容易丢数据的一处） --- */
  const orphanHalf = await repo.deleteAttachment(imgB.id);
  check("删掉一半引用后仍有活引用", (await repo.refCountByHash("hash-1")) === 1);
  check("还有引用时不返回待删文件（不能删掉别人在用的）",
    orphanHalf === null, String(orphanHalf));

  const orphanLast = await repo.deleteAttachment(imgA.id);
  check("最后一个引用被删掉时才返回可删的仓库文件",
    orphanLast === "2026-09/abcd1234-产品图.png", String(orphanLast));
  check("引用归零后文件才可以被回收", (await repo.refCountByHash("hash-1")) === 0);
  check("已删除的不再出现在列表里",
    (await repo.fetchAttachments(attOrder.id)).every((x) => x.id !== imgA.id));
  check("删链接类不返回文件（它本来就没有本地文件）",
    (await repo.deleteAttachment(linkA.id)) === null);

  /* --- 排序 --- */
  const sortA = await repo.createAttachment({
    woId: attOrder.id, kind: "link", title: "A", sourceUrl: "https://a.com/a",
  });
  const sortB = await repo.createAttachment({
    woId: attOrder.id, kind: "link", title: "B", sourceUrl: "https://a.com/b",
  });
  const titlesOf = async () =>
    (await repo.fetchAttachments(attOrder.id)).map((x) => x.title).join(",");

  await repo.moveAttachment(sortB.id, -1);
  check("上移生效", (await titlesOf()) === "B,A", await titlesOf());
  await repo.moveAttachment(sortB.id, -1);
  check("已在首位时上移是空操作（不越界）", (await titlesOf()) === "B,A", await titlesOf());
  await repo.moveAttachment(sortB.id, 1);
  check("下移回去", (await titlesOf()) === "A,B", await titlesOf());
  await repo.moveAttachment(sortA.id, -1);
  check("已在首位时上移是空操作（不越界）", (await titlesOf()) === "A,B", await titlesOf());
  await repo.moveAttachment(sortB.id, 1);
  check("已在末位时下移是空操作（不越界）", (await titlesOf()) === "A,B", await titlesOf());

  // 历史数据里 sort_order 可能相同。只交换"值"会让顺序纹丝不动，
  // 所以实现是重排整段。这条钉的就是这个行为。
  await repo.updateAttachment(sortA.id, { sortOrder: 0 });
  await repo.updateAttachment(sortB.id, { sortOrder: 0 });
  const beforeDup = await titlesOf();
  await repo.moveAttachment(sortA.id, 1);
  const afterDup = await titlesOf();
  check("sort_order 相同时移动依然真的换位",
    beforeDup !== afterDup && afterDup === "B,A", `${beforeDup} → ${afterDup}`);

  /* --- 认不出的 kind 必须安全降级 --- */
  const weirdOrder = await repo.createWorkOrder({ title: "脏数据工单", flowId: attFlow.id });
  await db().execute(
    `INSERT INTO core_wo_attachments
       (id, wo_id, kind, title, rel_path, source_url, mime, size_bytes, hash,
        width, height, duration_ms, note, sort_order, deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["weird-kind-1", weirdOrder.id, "mystery", "怪类型", null, "https://a.com/x",
      "", null, null, null, null, null, "", 0, 0, new Date().toISOString()],
  );
  const weird = (await repo.fetchAttachments(weirdOrder.id)).find((x) => x.id === "weird-kind-1");
  check("认不出的 kind 落回 link（那是不碰本地文件的一支，最安全）",
    weird?.kind === "link", String(weird?.kind));

  /* --- 备份往返 --- */
  const attBackup = await repo.exportBackup();
  check("备份里带上了附件记录",
    Array.isArray(attBackup.attachments) && attBackup.attachments.length >= 3,
    String(attBackup.attachments?.length));
  check("备份保留了 kind 与标题",
    attBackup.attachments.some((x) => x.kind === "link" && (x.title === "A" || x.title === "B")));

  const beforeImport = await titlesOf();
  await repo.importBackup(attBackup);
  const afterImport = await titlesOf();
  check("导入后附件顺序与导出前一致", afterImport === beforeImport,
    `${beforeImport} → ${afterImport}`);
  check("导入后附件仍挂在原工单上",
    (await repo.fetchAttachments(attOrder.id)).length === 2,
    String((await repo.fetchAttachments(attOrder.id)).length));
}

/* ---------- 22. 工单专属视图 ---------- */

section("22. 工单专属视图（侧边栏「工单」入口）");

{
  // 自建流程，不依赖前面各节留下的状态（备份往返之后尤其不能信）
  const ovFlow = await repo.createFlow("工单视图流程");
  const ovStages = (await repo.fetchStages())
    .filter((s) => s.flowId === ovFlow.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const ovList = await repo.createList("工单视图列表");
  await repo.createTask({ listId: ovList.id, title: "不该出现在工单视图的待办" });

  // 一开一关：关的那张要落到「已完成」组
  const openOv = await repo.createWorkOrder({
    title: "还在进行的单子",
    flowId: ovFlow.id,
    startDate: repo.today(),
  });
  const closedOv = await repo.createWorkOrder({
    title: "已经完结的单子",
    flowId: ovFlow.id,
    startDate: repo.addDays(repo.today(), -3),
  });
  await repo.moveOrderToStage(closedOv.id, ovStages[1].id, "做完了");

  // 取数层：orders 视图一张待办都不给，工单则全给（含已完结）
  check("orders 视图下取不到任何待办",
    (await repo.fetchTasks({ view: "orders", includeDone: true })).length === 0);
  const ovOrders = await repo.fetchWorkOrders({ view: "orders", includeDone: true });
  check("orders 视图取到全部工单（含已完结）",
    ovOrders.some((o) => o.id === openOv.id) && ovOrders.some((o) => o.id === closedOv.id));

  // 分组：进行中 / 已完成 两组；done 折叠区必须为空，
  // 否则已完结的单会在「已完成」组和折叠区里各出现一次
  const ov = groupRows([], ovOrders, "orders");
  check("分成「进行中 / 已完成」两组", ov.sections.length === 2,
    ov.sections.map((s) => s.key).join(","));
  check("第一组是进行中", ov.sections[0].key === "open");
  check("进行中组里没有已完结的单", ov.sections[0].items.every((r) => !r.order.closed));
  check("已完成组里全是已完结的单", ov.sections[1].items.every((r) => r.order.closed));
  check("done 折叠区为空（避免和「已完成」组重复）", ov.done.length === 0);
  check("待办不进工单视图",
    ov.sections.every((s) => s.items.every((r) => r.kind === "order")));

  // 与「默认展开第一条」同源：firstVisibleRow 指向进行中的第一张，
  // 而不是已完成组里的某张 —— 详情面板展开错对象就是从这里漏的
  const ovFirst = firstVisibleRow([], ovOrders, "orders");
  check("默认展开的是进行中的第一张工单",
    ovFirst?.kind === "order" && !ovFirst.order.closed,
    ovFirst ? String(ovFirst.kind) : "null");

  // 「全部」不受影响：工单继续混排（用户明确要求保留这个行为）
  const ovTasks = await repo.fetchTasks({ view: "all", includeDone: true });
  const ovAll = groupRows(ovTasks, ovOrders, "all");
  const ovAllRows = ovAll.sections.flatMap((s) => s.items);
  check("「全部」里待办仍在混排", ovAllRows.some((r) => r.kind === "task"));
  check("「全部」里工单仍在混排", ovAllRows.some((r) => r.kind === "order"));
}

/* ---------- 23. 特殊单号（带处理时效的一类工单） ---------- */

section("23. 特殊单号：时效、相关信息与专属视图");

{
  const dueMod = await import("../src/lib/due.ts");

  // 自建一套三步流程：待处理(默认 30 分) → 处理中(默认 240 分) → 已完成(终态)
  const spFlow = await repo.createFlow("特殊单号测试流程");
  await repo.createStage(spFlow.id, "处理中", "#378add", false, 240);
  let spStages = (await repo.fetchStages())
    .filter((s) => s.flowId === spFlow.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  // createStage 是追加到末尾的，把「处理中」挪到「已完成」前面
  await repo.moveStage(spStages[2].id, -1);
  spStages = (await repo.fetchStages())
    .filter((s) => s.flowId === spFlow.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [spTodo, spDoing, spDone] = spStages;
  await repo.updateStage(spTodo.id, { defaultMinutes: 30 });

  check("过程态能配默认时效", (await repo.fetchStages()).find((s) => s.id === spDoing.id)?.defaultMinutes === 240, `实际 ${String((await repo.fetchStages()).find((s) => s.id === spDoing.id)?.defaultMinutes)}`);

  // 建单时只给流程、不给时效 → 套该步的默认时效（30 分）
  const autoOrder0 = await repo.createWorkOrder({
    title: "只给流程，时效走默认",
    kind: "special",
    flowId: spFlow.id,
    stageId: spTodo.id,
    startDate: repo.today(),
  });
  const autoId = autoOrder0.id;
  const autoOrder = (await repo.fetchWorkOrders({ view: "all" })).find((o) => o.id === autoId);
  const autoRemainMin = (new Date(autoOrder.stageDueAt).getTime() - Date.now()) / 60_000;
  check("没填时效时套用该步的默认时效", autoRemainMin > 28 && autoRemainMin <= 30, `${autoRemainMin.toFixed(1)} 分钟`);

  // 显式给了时效就用给的（不弹窗里算过时刻，落库那一刻才算 —— 见 repo 的说明）
  const explicitAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const spId = (
    await repo.createWorkOrder({
      title: "",
      no: "SF7712345678901",
      kind: "special",
      flowId: spFlow.id,
      stageId: spTodo.id,
      startDate: repo.today(),
      stageDueAt: explicitAt,
      fields: [
        { label: "", value: "" }, // 建单弹窗预置的空行，必须被丢掉
        { label: "补发单号", value: "YT9988776655" },
        { label: "客户", value: "张三" },
      ],
    })
  ).id;
  const spOrder = (await repo.fetchWorkOrders({ view: "all" })).find((o) => o.id === spId);
  check("特殊单号的类型标记落库", spOrder.kind === "special", `实际 ${spOrder.kind}`);
  check("单号就是那个快递单号", spOrder.no === "SF7712345678901", spOrder.no);
  check("显式时效不被默认值覆盖", spOrder.stageDueAt === explicitAt);

  const spFields = await repo.fetchWoFields(spId);
  check("建单时一起绑上的相关信息都在", spFields.length === 2, `实际 ${spFields.length} 条`);
  check("空行不会被写进库", spFields.every((f) => f.label || f.value));
  check("相关信息按绑定顺序排", spFields[0].label === "补发单号" && spFields[1].label === "客户");

  // 单表改 / 删
  await repo.updateWoField(spFields[0].id, { value: "YT0000000001" });
  check("改一条相关信息的值", (await repo.fetchWoFields(spId))[0].value === "YT0000000001");
  await repo.deleteWoField(spFields[1].id);
  check("删掉的信息不再出现", (await repo.fetchWoFields(spId)).length === 1);

  // 搜索要能命中"绑上去的那个号"——用户手上拿到的往往是它，不是工单单号
  const byField = await repo.fetchWorkOrders({ view: "all", search: "YT0000000001" });
  check("按相关信息的值能搜到这张单", byField.some((o) => o.id === spId), `命中 ${byField.length} 张`);
  const byNo = await repo.fetchWorkOrders({ view: "all", search: "SF7712345678901" });
  check("按快递单号也能搜到", byNo.some((o) => o.id === spId));

  // 视图：special 只给特殊单号，别的视图不受影响
  const specials = await repo.fetchWorkOrders({ view: "special", includeDone: true });
  check("special 视图里全是特殊单号", specials.length > 0 && specials.every((o) => o.kind === "special"), `实际 ${specials.length} 张`);
  // 「工单」视图不过滤 kind：特殊单号也是工单，用户进「工单」就是想看全部单子
  const orderView = await repo.fetchWorkOrders({ view: "orders", includeDone: true });
  check("「工单」视图里普通工单和特殊单号都在",
    orderView.some((o) => o.kind === "normal") && orderView.some((o) => o.kind === "special"));
  // 这是最容易漏的一处：fetchTasks 落到 switch 的 default 就等于"不加条件"，
  // 会把整个待办表倒进特殊单号视图
  check("special 视图取不到任何待办",
    (await repo.fetchTasks({ view: "special", includeDone: true })).length === 0);
  check("「全部」里普通工单与特殊单号都在",
    (await repo.fetchWorkOrders({ view: "all", includeDone: true })).filter((o) => o.kind === "special").length >= 1);

  // 角标：未完结的特殊单号数
  const cnt = await repo.fetchCounts();
  const openSpecial = (await repo.fetchWorkOrders({ view: "special" })).length;
  check("侧边栏角标 = 未完结的特殊单号数", cnt.special === openSpecial, `${cnt.special} vs ${openSpecial}`);
  check("special 角标不混进普通工单", cnt.special < cnt.orders);

  // 时效档位：同一条代码路径给列表、详情、提醒三个地方用
  check("没设时效时是 none", dueMod.dueState({ ...spOrder, stageDueAt: null }) === "none");
  check("还有 5 分钟是临期", dueMod.dueState(spOrder, new Date(explicitAt).getTime() - 5 * 60_000) === "soon");
  check("过了点是逾期", dueMod.dueState(spOrder, new Date(explicitAt).getTime() + 60_000) === "overdue");
  check("还早就正常", dueMod.dueState({ ...spOrder, stageDueAt: new Date(Date.now() + 600 * 60_000).toISOString() }) === "ok");
  check("已完结的单不再标红（否则已完成分组整片红）", dueMod.dueState({ ...spOrder, closed: true }, new Date(explicitAt).getTime() + 60_000) === "ok");
  check("时长说人话", dueMod.humanDuration(135 * 60_000) === "2 小时 15 分", dueMod.humanDuration(135 * 60_000));

  // 提醒队列：只挑未完结、有时效的
  // 时效的生效依据是**流程那一步的默认时长**，不是单据类型 —— 普通工单落在
  // 配了默认时长的步骤上，一样会计时、一样会提醒（列表上也就必须看得见它）
  const plainFlow = await repo.createFlow("没有默认时效的流程");
  const plainId = (
    await repo.createWorkOrder({
      title: "落在这条流程上就没有时效",
      flowId: plainFlow.id,
      startDate: repo.today(),
    })
  ).id;
  const crossId = (
    await repo.createWorkOrder({
      title: "普通工单落在配了默认时长的步骤上",
      flowId: spFlow.id,
      stageId: spTodo.id,
      startDate: repo.today(),
    })
  ).id;

  const dueQueue = await repo.fetchOrdersForDueReminder();
  const plainOrder = (await repo.fetchWorkOrders({ view: "all", includeDone: true })).find((o) => o.id === plainId);
  check("步骤没配默认时长就没有时效", plainOrder.stageDueAt === null);
  check("没有时效的单不进提醒队列", !dueQueue.some((o) => o.id === plainId));
  check("未完结且有时效的单进提醒队列", dueQueue.some((o) => o.id === spId));
  check("时效由步骤默认值决定，不看单据类型",
    dueQueue.some((o) => o.id === crossId) &&
      (await repo.fetchWorkOrders({ view: "all" })).find((o) => o.id === crossId).kind === "normal");

  // 同一档只提醒一次：标记落库，重启也不会重弹
  await repo.markOrderDueNotified(spId, "soon");
  check("提醒过哪一档会被记下来",
    (await repo.fetchWorkOrders({ view: "all" })).find((o) => o.id === spId).stageDueNotifiedAt === "soon");
  // 临期提醒过之后逾期还要再提醒一次 —— 所以标记是"档位"不是布尔量
  await repo.markOrderDueNotified(spId, "overdue");
  check("逾期是另一档，能再提醒一次",
    (await repo.fetchWorkOrders({ view: "all" })).find((o) => o.id === spId).stageDueNotifiedAt === "overdue");

  // 推进：时效按**目标步**的默认时长重设，提醒档位清零
  const beforeAdvance = Date.now();
  await repo.moveOrderToStage(spId, spDoing.id, "已揽收");
  const advanced = (await repo.fetchWorkOrders({ view: "all" })).find((o) => o.id === spId);
  const advRemainMin = (new Date(advanced.stageDueAt).getTime() - beforeAdvance) / 60_000;
  check("推进后时效按目标步默认值重设", advRemainMin > 239 && advRemainMin <= 240, `${advRemainMin.toFixed(1)} 分钟`);
  check("推进后提醒档位清零（下一步该提醒还会提醒）", advanced.stageDueNotifiedAt === "");

  // 推进到终态：不再计时，也不该再进提醒队列
  await repo.moveOrderToStage(spId, spDone.id, "已完成");
  const closedSp = (await repo.fetchWorkOrders({ view: "all", includeDone: true })).find((o) => o.id === spId);
  check("走到终态后时效清空", closedSp.closed === true && closedSp.stageDueAt === null);
  check("已完结的单不再进提醒队列", !(await repo.fetchOrdersForDueReminder()).some((o) => o.id === spId));

  // 分组：进行中按时效先后排（逾期在最前），已完结单拎出来
  const spOpen = (
    await repo.createWorkOrder({
      title: "晚一点到期",
      kind: "special",
      flowId: spFlow.id,
      stageId: spTodo.id,
      startDate: repo.today(),
      stageDueAt: new Date(Date.now() + 200 * 60_000).toISOString(),
    })
  ).id;
  const spUrgent = (
    await repo.createWorkOrder({
      title: "已经超时了",
      kind: "special",
      flowId: spFlow.id,
      stageId: spTodo.id,
      startDate: repo.today(),
      stageDueAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    })
  ).id;
  const spRows = await repo.fetchWorkOrders({ view: "special", includeDone: true });
  const grouped = groupRows([], spRows, "special");
  check("特殊单号也分成「进行中 / 已完成」两组", grouped.sections.length === 2,
    grouped.sections.map((s) => s.key).join(","));
  check("done 折叠区为空（避免与「已完成」组重复）", grouped.done.length === 0);
  const openItems = grouped.sections[0].items.map((r) => r.order.id);
  check("越急的排越前（逾期在最上）", openItems[0] === spUrgent, openItems.slice(0, 2).join(","));
  check("按到期时间升序", openItems.indexOf(spUrgent) < openItems.indexOf(spOpen));
  check("分组里全是特殊单号", grouped.sections.flatMap((s) => s.items).every((r) => r.order.kind === "special"));

  // 默认展开的第一条 = 肉眼看到的第一行（列表排版与详情选中同源）
  const spFirst = firstVisibleRow([], spRows, "special");
  check("默认展开最急的那张特殊单号", spFirst?.kind === "order" && spFirst.order.id === spUrgent,
    spFirst ? String(spFirst.order.id) : "null");

  /* --- 我的一天：特殊单号是唯一放行进来的工单 --- */
  const mydayOrders = await repo.fetchWorkOrders({ view: "myday" });
  check("特殊单号出现在「我的一天」（数据层放行）",
    mydayOrders.some((o) => o.id === spUrgent) && mydayOrders.some((o) => o.id === spOpen));
  check("普通工单仍然不进「我的一天」",
    !mydayOrders.some((o) => o.id === plainId) && !mydayOrders.some((o) => o.id === crossId));
  check("已完结的特殊单号不进「我的一天」的进行组",
    !mydayOrders.some((o) => o.id === spId), `实际 ${mydayOrders.length} 张里含 spId？`);

  const mdGroups = groupRows([], spRows, "myday");
  check("「我的一天」里特殊单号单独成组",
    mdGroups.sections[0]?.key === "special", mdGroups.sections.map((s) => s.key).join(","));
  check("组内越急的排越前（逾期在最上）",
    mdGroups.sections[0]?.items[0]?.order.id === spUrgent);
  const mdFirst = firstVisibleRow([], spRows, "myday");
  check("「我的一天」默认展开最急的那张", mdFirst?.kind === "order" && mdFirst.order.id === spUrgent,
    mdFirst ? String(mdFirst.order.id) : "null");

  // 角标：我的一天 = 待办数 + 未完结特殊单号数 —— 点进去必须对得上，
  // 角标比列表多是最让人怀疑"数据丢了"的表现
  const mydayTaskCount = (await repo.fetchTasks({ view: "myday" })).length;
  const cntMyday = await repo.fetchCounts();
  check("「我的一天」角标把特殊单号算进去",
    cntMyday.myday === mydayTaskCount + mydayOrders.length,
    `${cntMyday.myday} vs ${mydayTaskCount}+${mydayOrders.length}`);

  /* --- 紧急区：快到点的单子是算出来的，不需要谁手动排 --- */
  const urgentPool = await repo.fetchWorkOrders({ view: "all", includeDone: false });
  const urgentRows = collectUrgent([], urgentPool, { thresholdMinutes: 480 });
  const urgentIds = urgentRows.map((e) => e.id);
  check("时效落在窗口内的单子进了紧急区",
    urgentIds.includes(spUrgent) && urgentIds.includes(spOpen), urgentIds.join(","));
  check("已经超时的那张排在最前", urgentIds[0] === spUrgent, urgentIds.join(","));
  check("已完结的单不在紧急区里", !urgentIds.includes(spId));
  check("没有时效也没有交付日的单子不进紧急区", !urgentIds.includes(plainId));

  // 备份要带上相关信息与时效，否则换台机器就丢了绑定的号码
  const backup = await repo.exportBackup();
  check("备份含相关信息", Array.isArray(backup.woFields) && backup.woFields.some((f) => f.woId === spId));
  check("备份含特殊单号的时效",
    backup.workOrders.some((o) => o.id === spUrgent && o.stageDueAt && o.kind === "special"));
  check("备份含过程态的默认时效", backup.stages.some((s) => s.id === spDoing.id && s.defaultMinutes === 240));
}

/* ---------- 24. 图库（数据层 + 跨表引用计数） ---------- */

section("24. 图库");

{
  const g = await import("../src/lib/gallery.ts");
  const att = await import("../src/lib/attachments.ts");

  /* --- 展示辅助（纯函数） --- */
  check("来源标签说人话", g.originLabel("ai-gen") === "AI 生成", g.originLabel("ai-gen"));
  check("认不出的来源原样返回", g.originLabel("mystery") === "mystery");
  check("每个来源都有色值", ["manual", "ai-gen", "image-crop", "size-chart"]
    .every((o) => /^#[0-9a-f]{6}$/i.test(g.ORIGIN_COLOR[o])));
  check("摘要优先给尺寸 + 体积",
    g.summarize({ width: 800, height: 600, size: 2048, mime: "image/png" }) === "800×600 · 2 KB",
    g.summarize({ width: 800, height: 600, size: 2048, mime: "image/png" }));
  check("没有尺寸时才退回类型",
    g.summarize({ width: null, height: null, size: null, mime: "video/mp4" }) === "video/mp4");

  /* --- 测试替身仓库 ---
     真实仓库在单测环境里不可用（要 IndexedDB 或 Tauri 命令），
     而"先落文件再写元数据""跨表数引用"这些规则恰好都发生在交界处。 */
  const files = new Map();       // relPath → { size, mime, hash }
  const calls = [];              // 记录调用顺序，用来钉住"先落文件后写库"
  const sha = (s) => {
    // 只需要"同内容同值"，不必真 SHA-256（那是 attachments.ts 的职责，另有用例钉住）
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  // 真实仓库按**内容**判类型（magic bytes），替身只能按后缀装一下。
  // 这一步不能省：图库的 kind 是拿落盘后的 mime **再判一次**的，
  // 替身永远报 image/png 的话，视频类目就永远测不到。
  const mimeFor = (name = "") =>
    /\.mp4$/i.test(name) ? "video/mp4" : (/\.webm$/i.test(name) ? "video/webm" : "image/png");
  const fakeStore = {
    driver: "browser",
    root: async () => "/fake",
    url: async (rel) => `blob:fake/${rel}`,
    exists: async (rel) => files.has(rel),
    remove: async (rel) => files.delete(rel),
    usage: async () => ({ files: files.size, bytes: 0 }),
    async putDataUrl(dataUrl, opts) {
      calls.push("put");
      const body = dataUrl.split(",")[1] ?? "";
      const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? mimeFor(opts.name);
      const hash = sha(body);
      const rel = `2026-09/${hash}-${opts.name || "x"}`;
      files.set(rel, { size: body.length, mime, hash });
      return { relPath: rel, absPath: rel, size: body.length, hash, mime };
    },
    async download(url, opts) {
      calls.push("download");
      const hash = sha(url);
      const mime = mimeFor(opts.name || url);
      const rel = `2026-09/${hash}-${opts.name || "x"}`;
      files.set(rel, { size: 10, mime, hash });
      return { relPath: rel, absPath: rel, size: 10, hash, mime };
    },
    async importLocal(file, opts) {
      calls.push("local");
      const hash = sha(String(file));
      const mime = mimeFor(String(file));
      const rel = `2026-09/${hash}-local`;
      files.set(rel, { size: 10, mime, hash });
      return { relPath: rel, absPath: rel, size: 10, hash, mime };
    },
  };
  att.__setAttachmentStore(fakeStore);

  /* --- 写入：先落文件、再写元数据 --- */
  const inGallery = await repo.fetchTasks({ view: "gallery" });
  check("图库视图不会把待办捞进来（switch 的默认分支会返回全部）",
    Array.isArray(inGallery) && inGallery.length === 0, String(inGallery.length));

  const galleryCount = async () => (await repo.fetchCounts()).gallery;
  const beforeWrite = await galleryCount();
  const gImg = await g.addToGallery({
    dataUrl: "data:image/png;base64,AAAA",
    title: "产品主图.png",
    origin: "image-crop",
    note: "800×600",
    width: 800, height: 600,
  });
  check("落文件发生在写库之前（顺序反了会留下指向空气的记录）",
    calls[calls.length - 1] === "put" && files.has(gImg.relPath), calls.join(","));
  check("条目拿到了仓库相对路径", String(gImg.relPath).startsWith("2026-09/"), gImg.relPath);
  check("体积/指纹来自仓库而不是调用方", gImg.size > 0 && !!gImg.hash, `${gImg.size} / ${gImg.hash}`);
  check("空标题时用文件名兜底", gImg.title === "产品主图.png", gImg.title);
  check("图库计数加一", (await galleryCount()) === beforeWrite + 1);

  const gVid = await g.addToGallery({
    url: "https://a.com/clip.mp4", title: "商品视频", origin: "manual", prompt: "秋冬外套",
  });
  const gAi = await g.addToGallery({
    dataUrl: "data:image/png;base64,BBBB", title: "AI 出图 1", origin: "ai-gen", prompt: "白色背景 商品",
  });
  const gChart = await g.addToGallery({
    dataUrl: "data:image/png;base64,CCCC", title: "尺码表-淘宝-1080", origin: "size-chart",
  });

  /* --- 读取与筛选 --- */
  const all = await g.fetchGallery();
  check("默认按最新在前", all[0].id === gChart.id, all.map((x) => x.title).join(","));
  check("全部默认不含已删除", all.every((x) => x.id !== "nope"));

  check("按类型筛：只要图片",
    (await g.fetchGallery({ kind: "image" })).every((x) => x.kind === "image"));
  check("按类型筛：只要视频",
    (await g.fetchGallery({ kind: "video" })).map((x) => x.id).join(",") === gVid.id);
  check("按来源筛",
    (await g.fetchGallery({ origin: "ai-gen" })).map((x) => x.id).join(",") === gAi.id);

  // 搜索走 JS 过滤（MemoryDb 不支持 LIKE 之外的写法），
  // 且**有搜索词时不能加 LIMIT** —— 否则变成"只在最近 N 条里搜"
  check("搜标题命中", (await g.fetchGallery({ search: "尺码表" })).map((x) => x.id).join(",") === gChart.id);
  check("搜提示词命中", (await g.fetchGallery({ search: "白色背景" })).map((x) => x.id).join(",") === gAi.id);
  check("搜备注命中", (await g.fetchGallery({ search: "800×600" })).map((x) => x.id).join(",") === gImg.id);
  check("搜索大小写不敏感", (await g.fetchGallery({ search: "ai 出图" })).length === 1);
  check("搜不到就是空", (await g.fetchGallery({ search: "没有这个词" })).length === 0);
  // 这条钉的是「搜索 + limit」：4 条都在库里，limit=1 也必须在**全库**里搜
  check("带搜索词时 limit 只截结果、不截搜索范围",
    (await g.fetchGallery({ search: "AI 出图", limit: 1 })).length === 1);
  check("limit 生效", (await g.fetchGallery({ limit: 2 })).length === 2);

  check("单条能取回", (await g.getGalleryItem(gAi.id))?.title === "AI 出图 1");
  check("取不存在的返回 null", (await g.getGalleryItem("nope")) === null);

  const byOrigin = await g.galleryCountsByOrigin();
  check("按来源统计正确", byOrigin["ai-gen"] === 1 && byOrigin["size-chart"] === 1, JSON.stringify(byOrigin));

  /* --- 改：只允许改展示字段 --- */
  await g.updateGalleryItem(gAi.id, { title: "AI 出图 1（改过）", note: "1024×1024" });
  const edited = await g.getGalleryItem(gAi.id);
  check("标题改得动", edited?.title === "AI 出图 1（改过）", edited?.title);
  check("备注改得动", edited?.note === "1024×1024", edited?.note);
  check("文件和来源不可改", edited?.relPath === gAi.relPath && edited?.origin === "ai-gen");
  await g.updateGalleryItem(gAi.id, {});   // 空 patch 是空操作，不该抛
  check("空 patch 不炸", (await g.getGalleryItem(gAi.id))?.title === "AI 出图 1（改过）");

  /* --- 删：跨表引用计数 --- */
  const loneRel = (await g.deleteGalleryItem(gChart.id));
  check("没人引用时返回可回收的仓库文件", loneRel === gChart.relPath, String(loneRel));
  check("已删除的不再出现在列表里",
    (await g.fetchGallery()).every((x) => x.id !== gChart.id));
  check("删除后计数减一",
    (await galleryCount()) === beforeWrite + 3, String(await galleryCount()));
  check("重复删除返回 null（记录已不在了）", (await g.deleteGalleryItem(gChart.id)) === null);

  // 最关键的一条：同一份字节同时被工单附件和图库引用时，删图库**不能删文件**
  //
  // 注意路径的构成是 `<hash 前 8 位>-<名字>`，所以"同名 + 同内容"才指向同一个
  // 文件（这正是「同一张图被加进两张工单，磁盘上只有一份」成立的条件）。
  // 而**引用计数是按 hash 算的、且跨两张表** —— 下面刻意用相同的名字，
  // 好让路径也真的相同，把"按路径删就会误删"这条风险摆到台面上。
  const dupStore = await att.attachmentStore().putDataUrl("data:image/png;base64,SHARED", { name: "shared.png", maxBytes: 1e7 });
  const dupFlow = await repo.createFlow("图库引用计数测试流程");
  const dupOrder = await repo.createWorkOrder({ title: "和图库共用同一份文件", flowId: dupFlow.id });
  await repo.createAttachment({
    woId: dupOrder.id, kind: "image", title: "共用图",
    relPath: dupStore.relPath, mime: dupStore.mime, size: dupStore.size, hash: dupStore.hash,
  });
  const dupItem = await g.addToGallery({
    dataUrl: "data:image/png;base64,SHARED", title: "shared.png", origin: "manual",
  });
  check("同名同内容 → 仓库里是同一个文件（内容寻址）",
    dupItem.relPath === dupStore.relPath, `${dupItem.relPath} vs ${dupStore.relPath}`);
  check("同名同内容 → 指纹一致", dupItem.hash === dupStore.hash);
  const dupRel = await g.deleteGalleryItem(dupItem.id);
  check("还有别的引用时不返回待删文件（不能把工单的图删掉）", dupRel === null, String(dupRel));
  check("仓库文件确实还在", await att.attachmentStore().exists(dupStore.relPath));

  /* --- 备份 --- */
  const gBackup = await repo.exportBackup();
  check("备份带上图库条目", Array.isArray(gBackup.gallery) && gBackup.gallery.length >= 3,
    String(gBackup.gallery?.length));

  /* --- 备份往返：图库不能"看起来备了、其实没备" ---
     这是最后一段，所以可以放心清库重来（上面的断言都不再依赖旧数据）。 */
  const liveBefore = await galleryCount();
  await repo.clearAllData();
  check("清空后图库为空", (await galleryCount()) === 0, String(await galleryCount()));
  const restored = await repo.importBackup(gBackup);
  check("导入返回条数（不含图库，保持既有契约）", typeof restored.lists === "number");
  check("导入后图库条目数还原", (await galleryCount()) === liveBefore,
    `${await galleryCount()} vs ${liveBefore}`);
  const restoredAi = (await g.fetchGallery({ origin: "ai-gen" }))[0];
  check("导入后关键字段没丢（来源 / 标题 / 仓库路径）",
    restoredAi?.origin === "ai-gen" && !!restoredAi?.relPath && !!restoredAi?.title,
    JSON.stringify(restoredAi && { o: restoredAi.origin, t: restoredAi.title, p: restoredAi.relPath }));
  check("导入后提示词也带回来了", restoredAi?.prompt === "白色背景 商品", restoredAi?.prompt);
  // 软删除状态也要带回来，否则"删过的图"会在新机器上复活
  check("导入后软删除状态保留",
    (await g.fetchGallery()).every((x) => x.origin !== "size-chart"),
    (await g.fetchGallery()).map((x) => x.origin).join(","));

  att.__setAttachmentStore(null);
}

/* ---------- 25. 工具的启用/停用、状态保持与单文件导入 ---------- */

section("25. 工具的启用、状态保持与单文件导入");

{
  const st = await import("../src/lib/settings.ts");
  const tstore = await import("../src/lib/toolStore.ts");

  /* --- 停用清单是一条字符串，必须挡得住脏输入 ---
     它躺在 core_settings 里，用户能手改；而 id 会参与表名拼接，
     所以非法值要在入口处丢掉，而不是带着往下走。 */
  check("默认不停用任何工具", st.DEFAULT_SETTINGS[st.SETTINGS.toolsDisabled] === "");
  check(
    "解析逗号分隔的停用清单",
    [...st.parseDisabledTools("size-chart,ai-gen")].join(",") === "size-chart,ai-gen",
  );
  check(
    "空白与重复项被吃掉",
    [...st.parseDisabledTools(" size-chart , , size-chart ")].join(",") === "size-chart",
  );
  check(
    "非法 id 被丢掉（大写 / 下划线 / 路径穿越）",
    st.parseDisabledTools("Bad,has_underscore,../etc,ok-tool").size === 1,
    [...st.parseDisabledTools("Bad,has_underscore,../etc,ok-tool")].join(","),
  );
  check(
    "序列化排序去重，同一集合永远同一串",
    st.formatDisabledTools(["b-tool", "a-tool", "b-tool"]) === "a-tool,b-tool",
    st.formatDisabledTools(["b-tool", "a-tool", "b-tool"]),
  );
  check(
    "停用再启用能回到空串",
    st.toggleDisabledTool(st.toggleDisabledTool("", "image-crop", true), "image-crop", false) === "",
  );

  /* --- 保持工具状态：默认开；只有显式 "0" 才算关 ---
     方向不能反：把"读不懂"当成"关"，用户切一趟回来就丢一次状态。 */
  check("保持状态默认开", st.DEFAULT_SETTINGS[st.SETTINGS.toolKeepState] === "1");
  check("缺键按保持处理", st.parseToolKeepState(undefined) === true);
  check("读不懂的值也按保持处理", st.parseToolKeepState("yes") === true);
  check("显式 0 才是关", st.parseToolKeepState("0") === false);

  /* --- 过滤与选中：App 与工具区共用同一个判断 --- */
  const fake = [
    { id: "image-crop", name: "图片裁剪", version: "2.0.0", entry: "index.html", dbVersion: 1, source: "bundled" },
    { id: "my-tool", name: "我的工具", version: "1.0.0", entry: "index.html", dbVersion: 1, source: "user" },
  ];
  const tl = await import("../src/lib/tools.ts");
  check(
    "停用的工具不进侧边栏",
    tl.filterEnabled(fake, new Set(["image-crop"])).map((t) => t.id).join(",") === "my-tool",
  );
  check(
    "但停用的工具仍然查得到（设置页要列出它才能启用回来）",
    tl.pickActiveTool(fake, "image-crop")?.id === "image-crop",
  );
  check(
    "已卸载的工具选不出来（activeToolId 指向它也只当没有）",
    tl.pickActiveTool(fake, "ghost-tool") === null,
  );
  check("null 就是没有工具", tl.pickActiveTool(fake, null) === null);

  /* --- id 建议：中文名推不出 ASCII，也要给出合法值 --- */
  check(
    "带空格大写也转得对",
    tstore.suggestToolId("Size Chart.html") === "size-chart",
    tstore.suggestToolId("Size Chart.html"),
  );
  check(
    "中文文件名退回占位 id（合法、不重复）",
    /^tool-[0-9a-z]+$/.test(tstore.suggestToolId("尺码助手.html")),
    tstore.suggestToolId("尺码助手.html"),
  );
  check(
    "以数字开头的名字补字母前缀",
    /^t/.test(tstore.suggestToolId("3d-viewer.html")),
    tstore.suggestToolId("3d-viewer.html"),
  );
  check(
    "撞名时自动加序号",
    tstore.suggestToolId("size chart.html", ["size-chart"]) === "size-chart-2",
    tstore.suggestToolId("size chart.html", ["size-chart"]),
  );
  // 建议值必须**真的能过宿主校验** —— 否则用户一路点下去，最后卡在安装那一步
  check(
    "建议出来的 id 都能通过 manifest 校验",
    ["Size Chart.html", "尺码助手.html", "3d.html", "a.html", "x.y.z.html"].every(
      (f) => tl.validateManifest(tstore.buildManifest({ id: tstore.suggestToolId(f), name: "x" })) !== null,
    ),
    ["Size Chart.html", "尺码助手.html", "3d.html", "a.html", "x.y.z.html"]
      .map((f) => `${f}→${tstore.suggestToolId(f)}`)
      .join(" "),
  );

  /* --- id 校验的报错要能指导人改 --- */
  check("合法 id 通过", tstore.checkToolId("my-tool", []) === null);
  check("空 id 报错", typeof tstore.checkToolId("", []) === "string");
  check("大写被拒", typeof tstore.checkToolId("MyTool", []) === "string");
  check(
    "撞名被拒，且说清是占用",
    (tstore.checkToolId("ai-gen", ["ai-gen"]) ?? "").includes("占用"),
    tstore.checkToolId("ai-gen", ["ai-gen"]),
  );

  /* --- 导入产出的 manifest 必须能过宿主校验（否则装了也扫不出来） --- */
  const made = tstore.buildManifest({
    id: "my-tool",
    name: " 我的工具 ",
    description: "   ",
    icon: "list",
  });
  check("名称与 id 去空白", made.name === "我的工具" && made.id === "my-tool");
  check("只填了空白的描述当作没有描述", made.description === undefined);
  check("导入的工具来源标记为 user（决定卸载按钮的后果文案）", made.source === "user");
  check("默认入口是 index.html", made.entry === "index.html");
  check("生成出来的 manifest 通过宿主校验", tl.validateManifest(made) !== null);

  /* --- 浏览器模式不写假按钮：安装功能明确不可用 --- */
  check("浏览器模式不能安装工具", tstore.canInstallTools() === false);
  let installErr = "";
  try {
    await tstore.installFromHtml({ html: "<html></html>", id: "x-tool", name: "x" });
  } catch (e) {
    installErr = e instanceof Error ? e.message : String(e);
  }
  check("浏览器模式调安装会明确报错，而不是静默失败", installErr.includes("桌面版"), installErr);
}



console.log(`\n${"=".repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(52));

process.exit(failed ? 1 : 0);
