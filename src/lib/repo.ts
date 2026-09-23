/**
 * 业务数据仓库。
 *
 * 上层组件只调用本模块的函数，不直接写 SQL。
 * 好处：换数据库、加缓存、做乐观更新时，改动只落在这一层。
 */

import { db, type Param } from "./db";
import { toolTable } from "./tools";
import { CURRENT_SCHEMA_VERSION } from "./migrations";
import type {
  AttachmentKind,
  PlanItem,
  Repeat,
  Step,
  Task,
  TaskList,
  WoAttachment,
  WoField,
  WoLog,
  WorkFlow,
  WorkOrder,
  WorkOrderKind,
  WorkStage,
} from "../types";

/* ---------------------------- 工具函数 ---------------------------- */

const now = () => new Date().toISOString();

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 本地日期 YYYY-MM-DD，不使用 toISOString 以免被 UTC 偏移影响 */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** SQLite 用 0/1 存布尔，这里统一做双向转换 */
type RawTask = Omit<Task, "done" | "important" | "myDay" | "deleted"> & {
  done: number;
  important: number;
  my_day: number;
  deleted: number;
  list_id: string;
  due_date: string | null;
  remind_at: string | null;
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  // v2 才加的列：老库里迁移前就存在的行没有这两个字段
  repeat?: string;
  repeat_done_on?: string | null;
};

type RawList = Omit<TaskList, "deleted" | "sortOrder" | "createdAt" | "updatedAt"> & {
  sort_order: number;
  deleted: number;
  created_at: string;
  updated_at: string;
};

const toTask = (r: RawTask): Task => ({
  id: r.id,
  listId: r.list_id,
  title: r.title,
  note: r.note,
  done: !!r.done,
  important: !!r.important,
  myDay: !!r.my_day,
  dueDate: r.due_date,
  remindAt: r.remind_at,
  completedAt: r.completed_at,
  repeat: (r.repeat as Repeat) ?? "none",
  repeatDoneOn: r.repeat_done_on ?? null,
  sortOrder: r.sort_order,
  deleted: !!r.deleted,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toList = (r: RawList): TaskList => ({
  id: r.id,
  name: r.name,
  color: r.color,
  sortOrder: r.sort_order,
  deleted: !!r.deleted,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/* ------------------------------ 列表 ------------------------------ */

/** To Do 默认主题色板，新建列表时按序取用 */
export const LIST_COLORS = [
  "#d4537e",
  "#378add",
  "#1d9e75",
  "#ba7517",
  "#534ab7",
  "#d85a30",
  "#888780",
];

/**
 * 清单。
 *
 * `includeDeleted` 只给**同步**用：合并要靠 deleted 这个墓碑知道
 * "对面把这一条删了"，而界面上的每处调用都只要活着的那些。
 * 默认 false，所以现有调用点行为不变。
 */
export async function fetchLists(includeDeleted = false): Promise<TaskList[]> {
  const rows = await db().select<RawList>(
    includeDeleted
      ? `SELECT * FROM core_lists ORDER BY sort_order ASC`
      : `SELECT * FROM core_lists WHERE deleted = 0 ORDER BY sort_order ASC`,
  );
  return rows.map(toList);
}

export async function createList(name: string, color?: string): Promise<TaskList> {
  const existing = await fetchLists();
  const list: TaskList = {
    id: uid(),
    name,
    color: color ?? LIST_COLORS[existing.length % LIST_COLORS.length],
    sortOrder: existing.length,
    deleted: false,
    createdAt: now(),
    updatedAt: now(),
  };
  await db().execute(
    `INSERT INTO core_lists (id, name, color, sort_order, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [list.id, list.name, list.color, list.sortOrder, list.createdAt, list.updatedAt],
  );
  return list;
}

export async function renameList(id: string, name: string): Promise<void> {
  await db().execute(`UPDATE core_lists SET name = ?, updated_at = ? WHERE id = ?`, [
    name,
    now(),
    id,
  ]);
}

export async function deleteList(id: string): Promise<void> {
  // 软删除列表，同时软删除其下任务，保留数据可恢复
  await db().transaction([
    { sql: `UPDATE core_lists SET deleted = 1, updated_at = ? WHERE id = ?`, params: [now(), id] },
    { sql: `UPDATE core_tasks SET deleted = 1, updated_at = ? WHERE list_id = ?`, params: [now(), id] },
  ]);
}

/* ------------------------------ 任务 ------------------------------ */

export interface TaskQuery {
  /**
   * myday / important / all / orders / special / list / gallery
   *
   * 其中 `orders` / `special` / `gallery` **都必然返回空数组** ——
   * 它们不是"待办的某种筛选"（前两个是流程任务的视图，gallery 是独立模块）。
   * 之所以还列在这里，是因为 store.refresh() 拿的是通用的 `SmartView | "list"`，
   * 它不分视图地调这个函数。类型上允许、运行时挡掉，比在每个调用点
   * 各判一次要可靠：**switch 落空 = 不加任何条件 = 把整库待办捞回来**。
   */
  view: "myday" | "important" | "all" | "orders" | "special" | "list" | "gallery";
  listId?: string;
  /** 是否包含已完成 */
  includeDone?: boolean;
  /** 关键词搜索 */
  search?: string;
  /** 是否连软删除的一起取。**只给同步用**，界面路径一律不传 */
  includeDeleted?: boolean;
}

export async function fetchTasks(q: TaskQuery): Promise<Task[]> {
  // 同步要带上墓碑，界面不要（见 TaskQuery.includeDeleted）
  const where: string[] = q.includeDeleted ? [] : ["deleted = 0"];
  const params: (string | number | null)[] = [];

  switch (q.view) {
    case "myday":
      // 「我的一天」是三种任务的并集：
      //   手动加进来的、今天到期的、以及每天重复的
      where.push("(my_day = 1 OR due_date = ? OR repeat = 'daily')");
      params.push(today());
      break;
    case "orders":
      // 「流程任务」视图一张待办都不该有。
      // 这里必须显式返回空：switch 没有 default，未知视图会落到"不加条件"，
      // 于是把全部待办捞回来 —— 表现就是「流程任务」页里混进一堆待办。
      return [];
    case "special":
      // 同上：「特殊单号」也是流程任务的视图，待办一张都不该有。
      // 漏了这一句的后果不是"少了几条"，而是**整库的待办都会被捞进来** ——
      // switch 落空 = 不加任何条件。
      return [];
    case "gallery":
      // 图库是独立模块，取数走 lib/gallery.ts。
      // 它出现在这个函数的调用点上只有一个原因：store.refresh() 不分视图地
      // 调了一次 fetchTasks。这里必须显式返回空，否则图库视图会打印出
      // 一整屏待办（同样是"落空 = 不加条件"）。
      return [];
    case "important":
      where.push("important = 1");
      break;
    case "list":
      where.push("list_id = ?");
      params.push(q.listId ?? "");
      break;
    case "all":
      break;
  }

  if (!q.includeDone) where.push("done = 0");

  if (q.search?.trim()) {
    where.push("title LIKE ?");
    params.push(`%${q.search.trim()}%`);
  }

  // where 可能整个是空的：同步路径（includeDeleted）不推 `deleted = 0`，
  // 而 view="all" 本身也不加条件 —— 这时拼出来是 `WHERE  ORDER BY`，语法错误。
  // 真 SQLite 直接抛、MemoryDb 静默返回空，两边都表现为"同步一条数据都取不到"。
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db().select<RawTask>(
    `SELECT * FROM core_tasks ${clause}
     ORDER BY done ASC, sort_order ASC, created_at DESC`,
    params,
  );
  return rows.map(toTask);
}

/**
 * 按 id 取单条任务。
 *
 * 为什么需要它：左侧计划表存的是 (kind, ref_id) 引用，而 store 里的 tasks
 * 只是**当前视图**的数据。计划里放了一条"个人"清单的任务，
 * 在「我的一天」视图下就查不到，计划表会显示成一条空行。
 * 所以计划项要按 id 单独解析，不能靠当前视图的数组去 find。
 */
export async function fetchTaskById(id: string): Promise<Task | null> {
  const rows = await db().select<RawTask>(`SELECT * FROM core_tasks WHERE id = ?`, [id]);
  const r = rows[0];
  return r && !r.deleted ? toTask(r) : null;
}

export interface NewTaskInput {  listId: string;
  title: string;
  note?: string;
  important?: boolean;
  myDay?: boolean;
  dueDate?: string | null;
  repeat?: Repeat;
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const rows = await db().select<{ m: number | null }>(
    `SELECT MIN(sort_order) AS m FROM core_tasks WHERE list_id = ? AND deleted = 0`,
    [input.listId],
  );
  // 新任务排在最前，与 To Do 行为一致
  const sortOrder = (rows[0]?.m ?? 0) - 1;

  const task: Task = {
    id: uid(),
    listId: input.listId,
    title: input.title,
    note: input.note ?? "",
    done: false,
    important: input.important ?? false,
    myDay: input.myDay ?? false,
    dueDate: input.dueDate ?? null,
    remindAt: null,
    completedAt: null,
    repeat: input.repeat ?? "none",
    repeatDoneOn: null,
    sortOrder,
    deleted: false,
    createdAt: now(),
    updatedAt: now(),
  };

  await db().execute(
    `INSERT INTO core_tasks
       (id, list_id, title, note, done, important, my_day, due_date, remind_at,
        completed_at, sort_order, repeat, repeat_done_on, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, ?, NULL, 0, ?, ?)`,
    [
      task.id,
      task.listId,
      task.title,
      task.note,
      task.important ? 1 : 0,
      task.myDay ? 1 : 0,
      task.dueDate,
      task.sortOrder,
      task.repeat,
      task.createdAt,
      task.updatedAt,
    ],
  );
  return task;
}

/** 更新任务的任意字段，只允许白名单内的列，避免拼接外部输入 */
const TASK_COLUMNS: Record<string, string> = {
  title: "title",
  note: "note",
  done: "done",
  important: "important",
  myDay: "my_day",
  dueDate: "due_date",
  remindAt: "remind_at",
  completedAt: "completed_at",
  sortOrder: "sort_order",
  listId: "list_id",
  repeat: "repeat",
  repeatDoneOn: "repeat_done_on",
};

export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const col = TASK_COLUMNS[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
  }
  if (!sets.length) return;

  // 完成任务时自动记录完成时间；取消完成则清空
  if (typeof patch.done === "boolean") {
    sets.push("completed_at = ?");
    params.push(patch.done ? now() : null);
  }

  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);

  await db().execute(`UPDATE core_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function deleteTask(id: string): Promise<void> {
  // 任务本身是软删除；步骤与关联是硬删除 —— 任务都删了，这些碎片留着只会变成孤儿数据
  await db().transaction([
    { sql: `UPDATE core_tasks SET deleted = 1, updated_at = ? WHERE id = ?`, params: [now(), id] },
    { sql: `DELETE FROM core_steps WHERE task_id = ?`, params: [id] },
    { sql: `DELETE FROM core_task_links WHERE task_id = ? OR linked_id = ?`, params: [id, id] },
  ]);
}

/**
 * 每日任务的跨天重置。
 *
 * 每日任务勾上只代表"今天做完了"，第二天它应该自己变回未完成。
 * 没有后台常驻进程，所以做成惰性重置：每次拉数据前先跑一遍，
 * 把「昨天及更早完成」的每日任务清回未完成。同一天重复执行是幂等的。
 *
 * @returns 本次被重置的任务条数，供界面提示
 */
export async function rolloverDailyTasks(todayStr: string = today()): Promise<number> {
  const rows = await db().select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM core_tasks
      WHERE deleted = 0 AND repeat = 'daily' AND done = 1
        AND repeat_done_on IS NOT NULL AND repeat_done_on < ?`,
    [todayStr],
  );
  const n = rows[0]?.c ?? 0;
  if (!n) return 0;

  await db().execute(
    `UPDATE core_tasks SET done = 0, completed_at = NULL, repeat_done_on = NULL, updated_at = ?
      WHERE deleted = 0 AND repeat = 'daily' AND done = 1
        AND repeat_done_on IS NOT NULL AND repeat_done_on < ?`,
    [now(), todayStr],
  );
  return n;
}

/**
 * 统计各视图的未完成数量，用于侧边栏角标。
 *
 * 必须把流程任务算进去：流程任务现在和待办混排在同一个视图里，
 * 角标却只数待办的话，"全部"会显示 5 而列表里明明有 7 条 ——
 * 数字和眼前看到的对不上，比没有角标更让人困惑。
 */
export async function fetchCounts(): Promise<{
  myday: number;
  all: number;
  byList: Record<string, number>;
  /** 未完结流程任务总数 */
  orders: number;
  /** 未完结的特殊单号数（流程任务里带处理时效的那一类） */
  special: number;
  /** 图库条目总数 */
  gallery: number;
}> {
  const [myday, all, byList, orderRows, stageRows, gallery] = await Promise.all([
    db().select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM core_tasks
        WHERE deleted = 0 AND done = 0 AND (my_day = 1 OR due_date = ? OR repeat = 'daily')`,
      [today()],
    ),
    db().select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM core_tasks WHERE deleted = 0 AND done = 0`,
    ),
    db().select<{ list_id: string; c: number }>(
      `SELECT list_id, COUNT(*) AS c FROM core_tasks
       WHERE deleted = 0 AND done = 0 GROUP BY list_id`,
    ),
    // 流程任务的"是否完结"在 JS 里算：SQL 侧需要 join 阶段表 + 子查询，
    // 而 MemoryDb 两样都不支持（会静默算成 0）。
    db().select<{ stage_id: string; kind?: string }>(
      `SELECT stage_id, kind FROM core_work_orders WHERE deleted = 0`,
    ),
    db().select<{ id: string; is_terminal: number }>(
      `SELECT id, is_terminal FROM core_wo_stages`,
    ),
    // 图库角标标的是**总数**（它没有完成态）。这里直接查而不调
    // lib/gallery.ts 的 countGallery：那个文件依赖本文件的 refCountByHash，
    // 反向再 import 回来会形成循环，虽然运行时没事，但依赖关系会变得难读。
    db().select<{ c: number }>(`SELECT COUNT(*) AS c FROM core_gallery_items WHERE deleted = 0`),
  ]);

  const map: Record<string, number> = {};
  for (const r of byList) map[r.list_id] = r.c;

  const terminal = new Set(stageRows.filter((s) => s.is_terminal).map((s) => s.id));
  const openOrders = orderRows.filter((o) => !terminal.has(o.stage_id));
  const openSpecials = openOrders.filter((o) => o.kind === "special").length;

  return {
    // 「我的一天」= 待办数 + 未完结特殊单号数。
    // 特殊单号现在就显示在「我的一天」里（见 fetchWorkOrders 的 myday 分支），
    // 角标必须把同一批单子算进去 —— 点进去对不上是最让人怀疑数据丢了的表现。
    // 普通流程任务仍然不算：它们不在这个视图里。
    myday: (myday[0]?.c ?? 0) + openSpecials,
    all: (all[0]?.c ?? 0) + openOrders.length,
    byList: map,
    orders: openOrders.length,
    // 未完结的特殊单号数。和「流程任务」角标同一把尺子（都是"未完结"），
    // 不按"逾期/临期"再筛一道 —— 那会让角标数字在没有任何操作时自己跳，
    // 用户不知道它为什么变。
    special: openSpecials,
    gallery: gallery[0]?.c ?? 0,
  };
}

/* --------------------------- 首次运行种子数据 --------------------------- */

/**
 * 种子数据写入锁。
 *
 * React StrictMode 下初始化 effect 会跑两次，若两个流程并发进入这里，
 * 会双双查到空库并各插一份种子数据。用模块级 Promise 串行化即可根除。
 */
let seedPromise: Promise<void> | null = null;

export function seedIfEmpty(): Promise<void> {
  if (!seedPromise) {
    seedPromise = seedIfEmptyInner().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

async function seedIfEmptyInner(): Promise<void> {
  const lists = await fetchLists();
  if (lists.length) return;

  const work = await createList("工作", "#d4537e");
  const personal = await createList("个人", "#378add");

  const samples: NewTaskInput[] = [
    { listId: work.id, title: "1027 改码发货", myDay: true, important: true },
    { listId: work.id, title: "整理本周订单记录", myDay: true, dueDate: today() },
    { listId: work.id, title: "确认图片裁剪工具的导出效果", dueDate: addDays(today(), 1) },
    { listId: work.id, title: "梳理工作台插件接口草案" },
    // 每日任务：不靠 my_day 也会出现在「我的一天」，用来自证重复规则生效
    { listId: personal.id, title: "清空收件箱", repeat: "daily" },
    { listId: personal.id, title: "记账", repeat: "daily" },
  ];

  for (const s of samples) await createTask(s);

  // 演示已完成状态，让界面首屏就有「已完成」分组可折叠
  const all = await fetchTasks({ view: "list", listId: work.id, includeDone: true });
  const done = all.find((t) => t.title.includes("插件接口"));
  if (done) await updateTask(done.id, { done: true });
}

/* ---------------------------- 步骤（子任务） ---------------------------- */

type RawStep = {
  id: string;
  task_id: string;
  title: string;
  done: number;
  sort_order: number;
  due_at?: string | null;
};

/**
 * 一次性取出全部分步骤并按任务分组。
 *
 * 任务行要显示 "2/5" 进度，如果每条任务各查一次就会变成 N+1 查询；
 * 本地应用数据量有限，一次拉全更简单也更快。
 */
export async function fetchAllSteps(): Promise<Record<string, Step[]>> {
  const rows = await db().select<RawStep>(
    `SELECT * FROM core_steps ORDER BY sort_order ASC`,
  );
  const out: Record<string, Step[]> = {};
  for (const r of rows) {
    (out[r.task_id] ??= []).push({
      id: r.id,
      taskId: r.task_id,
      title: r.title,
      done: !!r.done,
      sortOrder: r.sort_order,
      // 浏览器内存库跑不了 ALTER（语句被忽略），这一列会是 undefined ——
      // 统一成 null，免得"有的地方是 undefined、有的是 null"两种空混着用
      dueAt: r.due_at ?? null,
    });
  }
  return out;
}

export async function createStep(taskId: string, title: string): Promise<Step> {
  const t = title.trim();
  if (!t) throw new Error("子任务内容不能为空");

  const existing = (await fetchAllSteps())[taskId] ?? [];
  const last = existing[existing.length - 1];
  const step: Step = {
    id: uid(),
    taskId,
    title: t,
    done: false,
    sortOrder: last ? last.sortOrder + 1 : 0,
    dueAt: null,
  };
  await db().execute(
    `INSERT INTO core_steps (id, task_id, title, done, sort_order) VALUES (?, ?, ?, 0, ?)`,
    [step.id, taskId, t, step.sortOrder],
  );
  return step;
}

export async function updateStep(id: string, patch: Partial<Step>): Promise<void> {
  const sets: string[] = [];
  const params: Param[] = [];
  if (typeof patch.done === "boolean") {
    sets.push("done = ?");
    params.push(patch.done ? 1 : 0);
  }
  if (typeof patch.title === "string") {
    sets.push("title = ?");
    params.push(patch.title);
  }
  // 到期时刻允许**显式清空**（传 null）：设了又不用了，得能撤掉，
  // 否则它会在紧急区里一直挂着 —— 一个永远撤不掉的提醒比没有提醒更烦人
  if (patch.dueAt !== undefined) {
    sets.push("due_at = ?");
    params.push(patch.dueAt);
  }
  if (!sets.length) return;
  params.push(id);
  await db().execute(`UPDATE core_steps SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function deleteStep(id: string): Promise<void> {
  await db().execute(`DELETE FROM core_steps WHERE id = ?`, [id]);
}

/* ------------------------------ 任务关联 ------------------------------ */

/**
 * 取与某条任务关联的全部任务。
 *
 * 关联是无向的（A 关联 B 等于 B 关联 A），但库里只存一行，
 * 所以要两个方向都查一遍再去重。
 *
 * 没用 `id IN (SELECT ...)`：内存库不支持子查询，两次查询 + JS 去重
 * 在两种驱动下行为一致，本地数据量下也不在乎这点开销。
 */
export async function fetchLinkedTasks(taskId: string): Promise<Task[]> {
  // `deleted IS NULL` 是给 v14 之前写下的关联行留的：那些行走的是"硬删除"，
  // 当时那列还不存在，MemoryDb 里的老快照也就没有这个键。真 SQLite 上该列
  // NOT NULL DEFAULT 0，这个分支永远不成立，留着不影响任何东西。
  const [forward, backward] = await Promise.all([
    db().select<{ linked_id: string }>(
      `SELECT linked_id FROM core_task_links WHERE task_id = ? AND (deleted = 0 OR deleted IS NULL)`,
      [taskId],
    ),
    db().select<{ task_id: string }>(
      `SELECT task_id FROM core_task_links WHERE linked_id = ? AND (deleted = 0 OR deleted IS NULL)`,
      [taskId],
    ),
  ]);

  const ids = new Set<string>();
  for (const r of forward) if (r.linked_id !== taskId) ids.add(r.linked_id);
  for (const r of backward) if (r.task_id !== taskId) ids.add(r.task_id);
  if (!ids.size) return [];

  const all = await fetchTasks({ view: "all", includeDone: true });
  return all.filter((t) => ids.has(t.id));
}

/** 建立关联。已存在（任一方向）或自己关联自己时静默忽略，保证幂等。 */
export async function linkTasks(taskId: string, linkedId: string): Promise<boolean> {
  if (!taskId || !linkedId || taskId === linkedId) return false;

  // 不过滤 deleted：取消过的关联要能**复活**，而不是插一行新的。
  // 插新行会留下两条同任务对的记录，同步时无法分辨哪条代表"当前状态"。
  const [a, b] = await Promise.all([
    db().select<{ id: string; deleted: number }>(
      `SELECT id, deleted FROM core_task_links WHERE task_id = ? AND linked_id = ?`,
      [taskId, linkedId],
    ),
    db().select<{ id: string; deleted: number }>(
      `SELECT id, deleted FROM core_task_links WHERE task_id = ? AND linked_id = ?`,
      [linkedId, taskId],
    ),
  ]);
  const found = a[0] ?? b[0];
  if (found) {
    // 已经关联着 → 幂等，什么都不做
    if (!found.deleted) return false;
    await db().execute(
      `UPDATE core_task_links SET deleted = 0, updated_at = ? WHERE id = ?`,
      [now(), found.id],
    );
    return true;
  }

  const at = now();
  // deleted 必须显式写 0。真 SQLite 上这一列有 DEFAULT 0，不写也没事；但浏览器
  // 演示用的 MemoryDb 是 schemaless 的 —— INSERT 没带的列就是**没有这个键**，
  // 于是 `WHERE deleted = 0` 永远不成立，新关联在演示模式里一建出来就是隐形的。
  await db().execute(
    `INSERT INTO core_task_links (id, task_id, linked_id, deleted, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
    [uid(), taskId, linkedId, at, at],
  );
  return true;
}

export async function unlinkTasks(taskId: string, linkedId: string): Promise<void> {
  // 软删而不是 DELETE（v14 起）：行没了就无从分辨"这是刚取消的关联"
  // 还是"对面还没同步过来"—— 前者要同步成一次删除，后者不能动，
  // 硬删把这两种情况压成了同一个事实。
  const at = now();
  await db().transaction([
    {
      sql: `UPDATE core_task_links SET deleted = 1, updated_at = ?
            WHERE task_id = ? AND linked_id = ? AND deleted = 0`,
      params: [at, taskId, linkedId],
    },
    {
      sql: `UPDATE core_task_links SET deleted = 1, updated_at = ?
            WHERE task_id = ? AND linked_id = ? AND deleted = 0`,
      params: [at, linkedId, taskId],
    },
  ]);
}

/* ------------------------------- 提醒 ------------------------------- */

/** 所有设了提醒且还没完成的任务，提醒检查循环用它做扫描源 */
export async function fetchRemindableTasks(): Promise<Task[]> {
  const rows = await db().select<RawTask>(
    `SELECT * FROM core_tasks
      WHERE deleted = 0 AND done = 0 AND remind_at IS NOT NULL
      ORDER BY remind_at ASC`,
  );
  return rows.map(toTask);
}

/* ------------------------------ 配置 ------------------------------ */

/**
 * 键值型配置（core_settings）。
 *
 * 统一只存字符串：读出来再按需解析，避免"存进去是 1、读出来到底是 true 还是 '1'"
 * 这种来回猜的问题。
 */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db().select<{ key: string; value: string }>(
    `SELECT key, value FROM core_settings`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  // 先删后插而不是 INSERT OR REPLACE：内存库没实现 REPLACE 语义，
  // 两步写法在两种驱动下行为一致
  await db().transaction([
    { sql: `DELETE FROM core_settings WHERE key = ?`, params: [key] },
    { sql: `INSERT INTO core_settings (key, value) VALUES (?, ?)`, params: [key, value] },
  ]);
}

export async function setSettings(patch: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(patch)) await setSetting(key, value);
}

/* ============================ 流程任务 ============================ */
/*
 * 流程任务与待办的关系：**展示层混排，存储层各自独立**。
 *
 * 为什么不合并成一张表：待办是「一件事」（两种状态，做完就没了），
 * 流程任务是「一个流程」（单号 + 开始时间 + 沿自定义过程态前进 + 每步留痕）。
 * 塞进同一张表意味着有一半的列对一半的行永远为空，而且之后每加一个
 * 流程任务特性，都要在待办代码里判断"这行到底是不是流程任务"。
 */

/* ---------------------------- 流程模板 ---------------------------- */

type RawFlow = {
  id: string;
  name: string;
  is_default: number;
  sort_order: number;
  deleted: number;
  created_at: string;
  updated_at: string;
};

const toFlow = (r: RawFlow): WorkFlow => ({
  id: r.id,
  name: r.name,
  isDefault: !!r.is_default,
  sortOrder: r.sort_order,
  deleted: !!r.deleted,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 阶段配色板，新建阶段时按序取用 */
export const STAGE_COLORS = [
  "#888780",
  "#378add",
  "#ba7517",
  "#534ab7",
  "#1d9e75",
  "#d4537e",
  "#d85a30",
];

/** `includeDeleted` 只给同步用，理由同 fetchLists */
export async function fetchFlows(includeDeleted = false): Promise<WorkFlow[]> {
  const rows = await db().select<RawFlow>(
    includeDeleted
      ? `SELECT * FROM core_wo_flows ORDER BY sort_order ASC, created_at ASC`
      : `SELECT * FROM core_wo_flows WHERE deleted = 0 ORDER BY sort_order ASC, created_at ASC`,
  );
  return rows.map(toFlow);
}

export async function fetchStages(): Promise<WorkStage[]> {
  const rows = await db().select<RawStage>(
    `SELECT * FROM core_wo_stages ORDER BY flow_id ASC, sort_order ASC`,
  );
  return rows.map(toStage);
}

/**
 * 新建流程时自动带上两个阶段。
 *
 * 不给空流程：一个没有阶段的流程，流程任务建出来就没有"当前过程态"，
 * 界面得为这种半成品状态单独兜底。给「待处理 → 已完成」这种最小可用序列，
 * 用户想改再改，比丢一个空壳友好。
 */
export async function createFlow(name: string): Promise<WorkFlow> {
  const existing = await fetchFlows();
  const flow: WorkFlow = {
    id: uid(),
    name: name.trim() || "新流程",
    // 第一套流程自动成为默认
    isDefault: existing.length === 0,
    sortOrder: existing.length,
    deleted: false,
    createdAt: now(),
    updatedAt: now(),
  };
  await db().execute(
    `INSERT INTO core_wo_flows (id, name, is_default, sort_order, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [flow.id, flow.name, flow.isDefault ? 1 : 0, flow.sortOrder, flow.createdAt, flow.updatedAt],
  );
  await createStage(flow.id, "待处理", "#888780");
  await createStage(flow.id, "已完成", "#1d9e75", true);
  return flow;
}

export async function renameFlow(id: string, name: string): Promise<void> {
  const n = name.trim();
  if (!n) return;
  await db().execute(`UPDATE core_wo_flows SET name = ?, updated_at = ? WHERE id = ?`, [
    n,
    now(),
    id,
  ]);
}

/** 把某个流程设为默认。默认是"全局唯一"，所以先清再置，必须在一个事务里 */
export async function setDefaultFlow(id: string): Promise<void> {
  await db().transaction([
    { sql: `UPDATE core_wo_flows SET is_default = 0, updated_at = ?`, params: [now()] },
    { sql: `UPDATE core_wo_flows SET is_default = 1, updated_at = ? WHERE id = ?`, params: [now(), id] },
  ]);
}

/**
 * 删除流程。
 *
 * 两道拦截，都是为了不产生"孤儿流程任务"：
 * 1. 最后一流程不能删 —— 否则新建流程任务没有流程可选
 * 2. 还有流程任务在用的流程不能删 —— 软删除流程会让那些流程任务的 flow_id 指向不存在的行，
 *    界面上表现为过程态凭空消失。要么先迁走流程任务，要么别删。
 */
export async function deleteFlow(id: string): Promise<{ ok: boolean; reason?: string }> {
  const flows = await fetchFlows();
  if (flows.length <= 1) return { ok: false, reason: "至少要保留一套流程" };

  const used = await db().select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM core_work_orders WHERE flow_id = ? AND deleted = 0`,
    [id],
  );
  if ((used[0]?.c ?? 0) > 0) {
    return { ok: false, reason: `还有 ${used[0].c} 张流程任务在用这套流程，先改掉它们` };
  }

  const wasDefault = flows.find((f) => f.id === id)?.isDefault ?? false;
  const statements: Array<{ sql: string; params?: Param[] }> = [
    { sql: `UPDATE core_wo_flows SET deleted = 1, updated_at = ? WHERE id = ?`, params: [now(), id] },
    { sql: `DELETE FROM core_wo_stages WHERE flow_id = ?`, params: [id] },
  ];
  await db().transaction(statements);

  // 删掉的是默认流程时，把默认让给剩下的第一套，避免"没有默认流程"的空档
  if (wasDefault) {
    const rest = await fetchFlows();
    if (rest[0]) await setDefaultFlow(rest[0].id);
  }
  return { ok: true };
}

/* ---------------------------- 过程态 ---------------------------- */

type RawStage = {
  id: string;
  flow_id: string;
  name: string;
  color: string;
  sort_order: number;
  is_terminal: number;
  /** v8 新增，老行没有 → 0（不预设时效） */
  default_minutes?: number;
};

const toStage = (r: RawStage): WorkStage => ({
  id: r.id,
  flowId: r.flow_id,
  name: r.name,
  color: r.color,
  sortOrder: r.sort_order,
  isTerminal: !!r.is_terminal,
  defaultMinutes: Number(r.default_minutes ?? 0),
});

export async function createStage(
  flowId: string,
  name: string,
  color?: string,
  isTerminal = false,
  defaultMinutes = 0,
): Promise<WorkStage> {
  // 刻意不用 `SELECT MAX(x) AS m, COUNT(*) AS c`：MemoryDb（浏览器演示用的
  // 迷你 SQL 引擎）只认单个聚合表达式，两个聚合会走进"普通列投影"分支，
  // 返回 {m: null, c: null} —— 不报错，但每个新阶段的 sort_order 都会是 0。
  // 一次把行取回来在 JS 里算是等价且两边都成立的写法。
  const rows = await db().select<RawStage>(
    `SELECT * FROM core_wo_stages WHERE flow_id = ?`,
    [flowId],
  );
  const maxSort = rows.reduce((acc, r) => Math.max(acc, r.sort_order), -1);

  const stage: WorkStage = {
    id: uid(),
    flowId,
    name: name.trim() || "新阶段",
    color: color ?? STAGE_COLORS[rows.length % STAGE_COLORS.length],
    sortOrder: maxSort + 1,
    isTerminal,
    defaultMinutes: Math.max(0, Math.floor(defaultMinutes)),
  };
  await db().execute(
    `INSERT INTO core_wo_stages (id, flow_id, name, color, sort_order, is_terminal, default_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      stage.id,
      stage.flowId,
      stage.name,
      stage.color,
      stage.sortOrder,
      stage.isTerminal ? 1 : 0,
      stage.defaultMinutes,
    ],
  );
  return stage;
}

const STAGE_COLUMNS: Record<string, string> = {
  name: "name",
  color: "color",
  sortOrder: "sort_order",
  isTerminal: "is_terminal",
  defaultMinutes: "default_minutes",
};

export async function updateStage(id: string, patch: Partial<WorkStage>): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = STAGE_COLUMNS[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
  }
  if (!sets.length) return;
  params.push(id);
  await db().execute(`UPDATE core_wo_stages SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * 删除阶段。
 *
 * 被流程任务占用时**拒绝**而不是"自动把流程任务挪到第一个阶段"：
 * 静默改变别人流程任务的过程态，比报个错让用户自己决定要糟得多。
 */
export async function deleteStage(id: string): Promise<{ ok: boolean; reason?: string }> {
  const rows = await db().select<{ flow_id: string }>(
    `SELECT flow_id FROM core_wo_stages WHERE id = ?`,
    [id],
  );
  const flowId = rows[0]?.flow_id;
  if (!flowId) return { ok: false, reason: "阶段不存在" };

  const siblings = await db().select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM core_wo_stages WHERE flow_id = ?`,
    [flowId],
  );
  if ((siblings[0]?.c ?? 0) <= 1) return { ok: false, reason: "流程至少要有一步" };

  const used = await db().select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM core_work_orders WHERE stage_id = ? AND deleted = 0`,
    [id],
  );
  if ((used[0]?.c ?? 0) > 0) {
    return { ok: false, reason: `有 ${used[0].c} 张流程任务停在这一步，先把它们挪走` };
  }

  await db().execute(`DELETE FROM core_wo_stages WHERE id = ?`, [id]);
  return { ok: true };
}

/** 阶段上移/下移。和相邻项交换 sort_order，一次事务写完 */
export async function moveStage(id: string, dir: -1 | 1): Promise<void> {
  const rows = await db().select<RawStage>(`SELECT * FROM core_wo_stages WHERE id = ?`, [id]);
  const cur = rows[0];
  if (!cur) return;

  const neighbor = await db().select<RawStage>(
    dir < 0
      ? `SELECT * FROM core_wo_stages WHERE flow_id = ? AND sort_order < ?
         ORDER BY sort_order DESC LIMIT 1`
      : `SELECT * FROM core_wo_stages WHERE flow_id = ? AND sort_order > ?
         ORDER BY sort_order ASC LIMIT 1`,
    [cur.flow_id, cur.sort_order],
  );
  if (!neighbor[0]) return;
  const nb = neighbor[0];

  await db().transaction([
    { sql: `UPDATE core_wo_stages SET sort_order = ? WHERE id = ?`, params: [nb.sort_order, cur.id] },
    { sql: `UPDATE core_wo_stages SET sort_order = ? WHERE id = ?`, params: [cur.sort_order, nb.id] },
  ]);
}

/* ---------------------------- 流程任务本体 ---------------------------- */

type RawOrder = {
  id: string;
  /** v8 之前的老行没有这一列（内存库是 schemaless），按 normal 兜底 */
  kind?: string;
  no: string;
  /** v13 之前的老行没有这一列（内存库是 schemaless），按空串兜底 */
  description?: string;
  /** v11 之前的老行没有这一列，按"没指定（自动识别）"兜底 */
  courier?: string;
  title: string;
  flow_id: string;
  stage_id: string;
  note: string;
  important: number;
  my_day: number;
  start_date: string | null;
  due_date: string | null;
  stage_due_at?: string | null;
  stage_due_notified_at?: string;
  completed_at: string | null;
  sort_order: number;
  deleted: number;
  created_at: string;
  updated_at: string;
};

const toOrder = (r: RawOrder): WorkOrder => ({
  id: r.id,
  // 老行没有 kind（内存库的旧快照 / v8 之前的数据），一律当普通流程任务，
  // 而不是让它变成 undefined 一路漏到界面上
  kind: r.kind === "special" ? "special" : "normal",
  no: r.no,
  courier: r.courier ?? "",
  title: r.title,
  description: r.description ?? "",
  flowId: r.flow_id,
  stageId: r.stage_id,
  note: r.note,
  important: !!r.important,
  myDay: !!r.my_day,
  startDate: r.start_date,
  dueDate: r.due_date,
  stageDueAt: r.stage_due_at ?? null,
  stageDueNotifiedAt: r.stage_due_notified_at ?? "",
  completedAt: r.completed_at,
  sortOrder: r.sort_order,
  deleted: !!r.deleted,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  // closed 需要阶段表才知道，这里先给 false，
  // 由 fetchWorkOrders 统一用阶段表标定（见那里的说明）
  closed: false,
});

export interface OrderQuery {
  /**
   * 与待办视图一一对应；list 视图下流程任务不属于任何清单，返回空。
   *
   * `today` 是给「今日计划」候选池用的：今天开始或今天要交的流程任务。
   * 它不叫 myday 是因为**流程任务不允许进「我的一天」** —— 流程任务有自己的专属视图，
   * 再让它按日期混进我的一天，等于绕开了这条规则（新建流程任务默认开始日期就是
   * 今天，那样每张新单都会自动出现在那儿）。
   */
  view: "myday" | "today" | "important" | "all" | "orders" | "special" | "list" | "gallery";
  /** 是否包含已完结的流程任务 */
  includeDone?: boolean;
  search?: string;
  /** 是否连软删除的一起取。**只给同步用**，界面路径一律不传 */
  includeDeleted?: boolean;
}

/**
 * 按视图取流程任务。
 *
 * 时间语义（这是「流程任务也会根据时间出现在待办中」的落点）：
 * - myday   : 流程任务不参与，永远返回空（流程任务有专属视图，不能混进我的一天）
 * - today   : 今天开始或今天要交的（今日计划候选池用）
 * - orders  : 全部流程任务（含特殊单号 —— 它也是流程任务）
 * - special : 只看特殊单号（kind = 'special'）
 * - list    : 流程任务不属于清单，永远返回空 —— 在某个清单里塞进流程任务会让人以为它能被归类
 *
 * ⚠️ 这里**不能用 JOIN**：MemoryDb 的 SELECT 解析只认「FROM 单个裸表名」，
 * 带 JOIN 的语句匹配不上，会静默返回空数组 —— 表现为浏览器里流程任务列表永远是空的，
 * 而桌面端（真 SQLite）一切正常，是最难查的一类不一致。
 * 所以 closed 分两步算：先查流程任务，再用阶段表在 JS 里标出来。
 */
export async function fetchWorkOrders(q: OrderQuery): Promise<WorkOrder[]> {
  if (q.view === "list") return [];

  // 同步要带上墓碑，界面不要（见 OrderQuery.includeDeleted）
  const where: string[] = q.includeDeleted ? [] : ["deleted = 0"];
  const params: (string | number | null)[] = [];
  const t = today();

  switch (q.view) {
    case "myday":
      // 「我的一天」是待办的领地，**普通流程任务**不进（它们有自己的专属入口）。
      // 唯一的例外是特殊单号：它就是"今天在跟的、等不起的单"，
      // 用户打开应用的第一眼（默认视图）必须看得到它 ——
      // 只靠右上角的提醒卡片，等于把最重要的信息藏在角落里。
      // 必须显式写条件而不是删掉这个分支：switch 没有 default，
      // 落空就等于"不加条件"，会把全部流程任务捞回来。
      where.push("kind = 'special'");
      break;
    case "today":
      where.push("(start_date = ? OR due_date = ?)");
      params.push(t, t);
      break;
    case "important":
      where.push("important = 1");
      break;
    case "orders":
      // 专属入口就看全部流程任务（进行中 / 已完结由 groupRows 再分两组）。
      // 写出来是为了别靠 switch 的"落空"凑巧生效 —— 那样以后加视图会顺手改坏这里。
      //
      // 这里**不加 kind 条件**：特殊单号也是流程任务，用户进「流程任务」就是想看全部单子。
      // 它另有专属入口，但那是个"只看等不起的那些"的过滤器，不是一道围墙。
      break;
    case "special":
      // 特殊单号：带处理时效的那一类（kind = 'special'）。
      where.push("kind = 'special'");
      break;
    case "gallery":
      // 图库与流程任务毫无关系，但 store.refresh() 会不分视图地调到这里。
      // 同 myday：必须显式挡掉，落空 = 不加条件 = 把全部流程任务捞回来。
      return [];
    case "all":
      break;
  }

  if (q.search?.trim()) {
    const like = `%${q.search.trim()}%`;
    // 单号与描述也要能搜到：手上拿到的往往是一个号或一句"报修空调"，
    // 而标题为了能扫视是写得很短的（长句都在描述里）。
    const byText = "(title LIKE ? OR no LIKE ? OR description LIKE ?)";
    // 绑定的相关信息也要能搜到 —— "这个快递单号是哪张单"问的就是这个，
    // 而那个号码常常是绑上去的第二个单号，不是流程任务的单号。
    // 子查询 / JOIN / IN 在 MemoryDb 里都不成立（不报错，静默返回空），
    // 所以先单表查 core_wo_fields 拿到命中的 wo_id，再用一串 id = ? 拼回来。
    const hitIds = await searchWoFieldValueIds(like);
    if (hitIds.length) {
      where.push(`(${byText} OR ${hitIds.map(() => "id = ?").join(" OR ")})`);
      params.push(like, like, like, ...hitIds);
    } else {
      where.push(byText);
      params.push(like, like, like);
    }
  }

  // 同 fetchTasks：includeDeleted + view="all" 会让 where 整个为空
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db().select<RawOrder>(
    `SELECT * FROM core_work_orders ${clause}
     ORDER BY sort_order ASC, created_at DESC`,
    params,
  );

  const terminal = new Set(
    (await fetchStages()).filter((s) => s.isTerminal).map((s) => s.id),
  );
  const orders = rows.map((r) => ({ ...toOrder(r), closed: terminal.has(r.stage_id) }));

  // includeDone 在内存里筛。用 SQL 做需要子查询（见上面的 JOIN 说明），
  // 而流程任务数量是"一个人手上的活儿"，全量拉回来再筛完全无压力。
  return q.includeDone ? orders : orders.filter((o) => !o.closed);
}

/**
 * 搜「绑定的相关信息」命中了哪些流程任务。
 *
 * 单独一个函数是为了让 fetchWorkOrders 里那句"为什么不能用子查询"的说明
 * 旁边就是替代写法本身（两次单表查询 + JS 合并，两个驱动都成立）。
 *
 * 上限 200：搜索框是给人用的，命中几百张单时再往 SQL 里拼条件只会又长又慢，
 * 而"我搜这个号"的正常结果是 0~3 张单。
 */
const FIELD_SEARCH_LIMIT = 200;

async function searchWoFieldValueIds(like: string): Promise<string[]> {
  const rows = await db().select<RawField>(
    `SELECT * FROM core_wo_fields WHERE value LIKE ? AND deleted = 0`,
    [like],
  );
  return [...new Set(rows.map((r) => r.wo_id))].slice(0, FIELD_SEARCH_LIMIT);
}

/** 按 id 取单张流程任务。理由同 fetchTaskById。 */
export async function fetchOrderById(id: string): Promise<WorkOrder | null> {
  const rows = await db().select<RawOrder>(`SELECT * FROM core_work_orders WHERE id = ?`, [id]);
  const r = rows[0];
  if (!r || r.deleted) return null;
  const stages = await fetchStages();
  const terminal = new Set(stages.filter((s) => s.isTerminal).map((s) => s.id));
  return { ...toOrder(r), closed: terminal.has(r.stage_id) };
}

export interface NewWorkOrderInput {
  title: string;
  /**
   * 描述 —— "这件事要办什么"。普通流程任务的主要文字信息，
   * 标题之外的展开说明（见 types.ts 里 description 的说明）。
   */
  description?: string;
  /**
   * 单号。**只有特殊单号该传**（它填的是快递单号）；
   * 普通流程任务从 v13 起不再编号，传了也只会被丢掉。
   */
  no?: string;
  flowId: string;
  /** 不传则落在流程的第一步 */
  stageId?: string;
  note?: string;
  important?: boolean;
  myDay?: boolean;
  startDate?: string | null;
  dueDate?: string | null;
  /** 流程任务种类，默认普通流程任务。special = 特殊单号（带处理时效） */
  kind?: WorkOrderKind;
  /**
   * 快递商代号（见 lib/couriers.ts）。留空 = 以后按单号自动识别。
   * 只在登记时**用户手动指定**过才传值，自动识别的结果不落库。
   */
  courier?: string;
  /**
   * 起始这一步的处理时效截止时刻（ISO）。
   *
   * 传绝对时刻而不是"给多久"：换算（从 2 小时 / 明天 10 点算成时刻）是界面的
   * 输入方式，取当前时间这件事必须发生在**落库那一刻**，否则用户在弹窗里
   * 停留十分钟，时效就凭空少了十分钟。
   */
  stageDueAt?: string | null;
  /** 建单时一起绑上的相关信息（特殊单号用） */
  fields?: Array<{ label: string; value: string }>;
}

/* 这里原本有 nextOrderNo()：普通流程任务自动编号 WO-YYYYMMDD-NNN。
   从 v13 起取消了 —— 那个号用户手上没有对应的单据，对不上账，
   他要写的是 description。特殊单号的"号"是他自己填的快递单号，不靠生成。
   老数据里的 WO- 号仍留在库里（不删），只是界面不再显示。 */

/**
 * 按过程态的**默认时效**算出截止时刻。没有默认时效（0）就返回 null。
 *
 * 抽成函数是因为有三处要用同一套算法（建单、推进、以及界面上的"预览一下续到几点"），
 * 各写一遍迟早会漂移成"推进时给的和详情里显示的不一样"。
 */
export function dueAtFromStageDefault(stage: WorkStage | undefined, fromMs = Date.now()): string | null {
  const minutes = stage?.defaultMinutes ?? 0;
  if (minutes <= 0) return null;
  return new Date(fromMs + minutes * 60_000).toISOString();
}

export async function createWorkOrder(input: NewWorkOrderInput): Promise<WorkOrder> {
  const stages = await fetchStages();
  const flowStages = stages
    .filter((s) => s.flowId === input.flowId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // 没有阶段就没法开流程任务。宁可报错，也不要造一张 stage_id 指向空气的流程任务
  if (!flowStages.length) throw new Error("这套流程还没有任何过程态，先去编辑流程");

  const stageId = input.stageId ?? flowStages[0].id;

  const rows = await db().select<{ m: number | null }>(
    `SELECT MIN(sort_order) AS m FROM core_work_orders WHERE deleted = 0`,
  );

  const createdAt = now();
  const kind: WorkOrderKind = input.kind === "special" ? "special" : "normal";
  // 没显式给时效就退回这一步的默认时效 —— 界面上"忘了填"时至少还有流程兜着，
  // 而不是悄悄落一张没有时效的特殊单（那样"等不起的单"就混进普通单里了）
  const stageDueAt =
    input.stageDueAt !== undefined
      ? input.stageDueAt
      : dueAtFromStageDefault(flowStages.find((s) => s.id === stageId));

  const order: WorkOrder = {
    id: uid(),
    kind,
    // 单号只为特殊单号保留：那里它是**快递单号**，是这类单子的起点。
    // 普通流程任务不再自动编号，传进来的号也丢掉 —— 界面已经没有这个入口了，
    // 留着这条通路只会让"某张普通单上怎么会有单号"变成没法解释的事。
    no: kind === "special" ? (input.no ?? "").trim() : "",
    // 登记时可以显式指定快递商（识别错了就改一次），不指定就留空 ——
    // 空串是"以后按单号自动识别"，不把当时的猜测结果冻进库里
    courier: (input.courier ?? "").trim(),
    title: input.title,
    description: (input.description ?? "").trim(),
    flowId: input.flowId,
    stageId,
    note: input.note ?? "",
    important: input.important ?? false,
    // my_day 恒为 0：流程任务不允许加入「我的一天」。
    // 列还在（旧数据可能有 1），但写入路径已经封死。
    myDay: false,
    startDate: input.startDate ?? today(),
    dueDate: input.dueDate ?? null,
    stageDueAt,
    stageDueNotifiedAt: "",
    completedAt: null,
    sortOrder: (rows[0]?.m ?? 0) - 1,
    deleted: false,
    createdAt,
    updatedAt: createdAt,
    closed: flowStages.find((s) => s.id === stageId)?.isTerminal ?? false,
  };

  await db().execute(
    `INSERT INTO core_work_orders
       (id, kind, no, courier, title, description, flow_id, stage_id, note, important, my_day, start_date, due_date,
        stage_due_at, stage_due_notified_at, completed_at, sort_order, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, 0, ?, ?)`,
    [
      order.id,
      order.kind,
      order.no,
      order.courier,
      order.title,
      order.description,
      order.flowId,
      order.stageId,
      order.note,
      order.important ? 1 : 0,
      order.myDay ? 1 : 0,
      order.startDate,
      order.dueDate,
      order.stageDueAt,
      order.sortOrder,
      order.createdAt,
      order.updatedAt,
    ],
  );

  // 记一条"开工"留痕。流程任务的「完整开始」就是这里 ——
  // 少了它，流转记录的第一条会变成"从无到有"的某个中间态，看起来像丢了一步
  await db().execute(
    `INSERT INTO core_wo_logs (id, wo_id, from_stage, to_stage, at, note, seq)
     VALUES (?, ?, NULL, ?, ?, ?, 1)`,
    [uid(), order.id, stageId, order.createdAt, "创建流程任务"],
  );

  // 建单时一起绑上的相关信息。空 label 与空 value 的行直接丢掉 ——
  // 它们只会在详情里显示成一个空行，删还得手动删
  const seedFields = (input.fields ?? []).filter(
    (f) => f.label.trim() || f.value.trim(),
  );
  for (let i = 0; i < seedFields.length; i++) {
    await db().execute(
      `INSERT INTO core_wo_fields (id, wo_id, label, value, sort_order, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        uid(),
        order.id,
        seedFields[i].label.trim(),
        seedFields[i].value.trim(),
        i,
        createdAt,
        createdAt,
      ],
    );
  }

  return order;
}

const ORDER_COLUMNS: Record<string, string> = {
  no: "no",
  // 快递商允许改：它就是给人"认错了就改一次"用的，
  // 而单号改了之后原来指定的那家也未必还对（改单号见 NoEditor）。
  courier: "courier",
  title: "title",
  description: "description",
  flowId: "flow_id",
  stageId: "stage_id",
  note: "note",
  important: "important",
  startDate: "start_date",
  dueDate: "due_date",
  // 时效可以随时改（"这个客户又拖了，再给两小时"），所以它在白名单里。
  // kind 不在：普通单和特殊单的区别在建单那一刻就定了，
  // 允许它中途变来变去会让"这张单为什么有时效"变得没法解释。
  stageDueAt: "stage_due_at",
  completedAt: "completed_at",
  sortOrder: "sort_order",
};

/**
 * 改流程任务字段。
 *
 * 注意这里**不负责**过程态流转 —— 直接 patch stageId 会绕过留痕，
 * 让 core_wo_logs 与流程任务实际状态对不上。要动过程态请用 moveOrderToStage。
 */
export async function updateWorkOrder(id: string, patch: Partial<WorkOrder>): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = ORDER_COLUMNS[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
  }
  if (!sets.length) return;
  // 改了时效就把"已提醒到哪一档"重置 —— 新的截止时刻还没提醒过。
  // 不重置的话，延长过的时效永远不会再提醒（旧标记压着它）。
  // 放在这里而不是让调用方自己记得清：改时效的地方有好几处，
  // 漏一处就会出现"改完再也不提醒"这种只在特定路径下复现的问题。
  if ("stageDueAt" in patch) {
    sets.push("stage_due_notified_at = ?");
    params.push("");
  }
  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);
  await db().execute(`UPDATE core_work_orders SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * 批量改「标记类」字段（目前是「重要」）。
 *
 * 为什么不在上层把 updateWorkOrder 循环一遍：上层那个动作（store.patchOrder）
 * 每改一张就整体刷新一次取数，勾 20 张就是 20 轮全表重取，界面会明显卡一下。
 * 这里只写库、**不刷新**，由调用方改完统一刷新一次。
 *
 * 不用 `UPDATE ... WHERE id IN (...)`：浏览器端的内存库（MemoryDb）只认
 * 简单的 `列 = ?` 条件，`IN` 会静默匹配不到任何行（见 db.ts 的说明），
 * 那样在 demo 里点"批量标记重要"会毫无反应、且不报错。
 *
 * 只收"标记类"字段是有意的：时效、过程态这些**带语义**的字段各有各的
 * 连带动作（清提醒档位、写流转日志），混进批量通道里迟早会漏一处。
 */
export async function bulkPatchWorkOrders(
  ids: string[],
  patch: { important?: boolean },
): Promise<void> {
  for (const id of ids) await updateWorkOrder(id, patch);
}

/**
 * 过程态流转。这是流程任务与待办最本质的区别：**每一次推进都留痕**。
 *
 * 终态会顺手记 completed_at，退回非终态则清掉它 ——
 * 否则会出现"流程任务已经退回到处理中，却还带着完成时间"这种自相矛盾的数据。
 *
 * 特殊单号的**时效在这里重设**：时效的语义是"到下一步之前还剩多久"，
 * 所以它是"当前这一步"的属性 —— 推进到新的一步，就按新步骤的默认时效重新起算。
 * 走到终态则清空（没有"下一步"了）。
 * 同时把已提醒标记清掉：新的一步还没提醒过。不清的话，第二步的时效
 * 会一直被第一步留下的标记压着，永远不提醒。
 */
export async function moveOrderToStage(
  woId: string,
  toStageId: string,
  note = "",
): Promise<void> {
  // 同样避开 JOIN：分两次查同一张表的行，在 JS 里拼（见 fetchWorkOrders 的说明）
  const rows = await db().select<RawOrder>(`SELECT * FROM core_work_orders WHERE id = ?`, [
    woId,
  ]);
  const cur = rows[0];
  if (!cur || cur.stage_id === toStageId) return;

  const target = await db().select<RawStage>(
    `SELECT * FROM core_wo_stages WHERE id = ?`,
    [toStageId],
  );
  const terminal = !!target[0]?.is_terminal;
  const at = now();
  const seq = await nextLogSeq(woId);

  const minutes = Number(target[0]?.default_minutes ?? 0);
  const nextDue = terminal || minutes <= 0 ? null : new Date(Date.now() + minutes * 60_000).toISOString();

  await db().transaction([
    {
      sql: `UPDATE core_work_orders
               SET stage_id = ?, stage_due_at = ?, stage_due_notified_at = '',
                   completed_at = ?, updated_at = ?
             WHERE id = ?`,
      params: [toStageId, nextDue, terminal ? at : null, at, woId],
    },
    {
      sql: `INSERT INTO core_wo_logs (id, wo_id, from_stage, to_stage, at, note, seq)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [uid(), woId, cur.stage_id, toStageId, at, note, seq],
    },
  ]);
}

/**
 * 流转日志的下一个序号（每张流程任务内部自增）。
 *
 * 为什么不用时间戳排序：两条日志可能落在同一毫秒（我们自己建单后立刻推状态
 * 就会这样），此时 SQL 的排序是不确定的，时间线会乱。序号是唯一可靠的依据。
 */
async function nextLogSeq(woId: string): Promise<number> {
  const rows = await db().select<RawWoLog>(
    `SELECT * FROM core_wo_logs WHERE wo_id = ?`,
    [woId],
  );
  return rows.reduce((acc, r) => Math.max(acc, r.seq ?? 0), 0) + 1;
}

type RawWoLog = {
  id: string;
  wo_id: string;
  from_stage: string | null;
  to_stage: string;
  at: string;
  note: string;
  seq: number;
};

const toLog = (r: RawWoLog): WoLog => ({
  id: r.id,
  woId: r.wo_id,
  fromStage: r.from_stage,
  toStage: r.to_stage,
  at: r.at,
  note: r.note,
});

/**
 * 取一张流程任务的流转记录，**最新的在最前**。
 *
 * 按 seq 倒序而不是 at 倒序，理由见 nextLogSeq。
 * 界面直接把数组顺序渲染成时间线即可，不需要自己再排一遍。
 */
export async function fetchWoLogs(woId: string): Promise<WoLog[]> {
  const rows = await db().select<RawWoLog>(
    `SELECT * FROM core_wo_logs WHERE wo_id = ? ORDER BY seq DESC`,
    [woId],
  );
  return rows.map(toLog);
}

export async function deleteWorkOrder(id: string): Promise<void> {
  // 与任务一致：流程任务软删除，流转日志与绑定的相关信息硬删除（留着的只会是孤儿）。
  // 绑定信息里有手机号、用户名这类东西，单子删了就该跟着走，
  // 而不是在库里留一堆没人认领的副本。
  await db().transaction([
    {
      sql: `UPDATE core_work_orders SET deleted = 1, updated_at = ? WHERE id = ?`,
      params: [now(), id],
    },
    { sql: `DELETE FROM core_wo_logs WHERE wo_id = ?`, params: [id] },
    { sql: `DELETE FROM core_wo_fields WHERE wo_id = ?`, params: [id] },
  ]);
}

/* ---------------------- 绑定的相关信息（特殊单号） ---------------------- */

type RawField = {
  id: string;
  wo_id: string;
  label: string;
  value: string;
  sort_order: number;
  deleted: number;
  created_at: string;
  updated_at: string;
};

const toField = (r: RawField): WoField => ({
  id: r.id,
  woId: r.wo_id,
  label: r.label,
  value: r.value,
  sortOrder: r.sort_order,
  deleted: !!r.deleted,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 一张流程任务绑定的全部信息，按用户排的顺序。 */
export async function fetchWoFields(woId: string): Promise<WoField[]> {
  const rows = await db().select<RawField>(
    `SELECT * FROM core_wo_fields WHERE wo_id = ? AND deleted = 0 ORDER BY sort_order ASC`,
    [woId],
  );
  return rows.map(toField);
}

export async function createWoField(
  woId: string,
  label: string,
  value: string,
): Promise<WoField> {
  // 同 createStage：不用 MAX(...) 与 COUNT(*) 两个聚合，MemoryDb 只认一个
  const rows = await db().select<RawField>(
    `SELECT * FROM core_wo_fields WHERE wo_id = ?`,
    [woId],
  );
  const maxSort = rows.reduce((acc, r) => Math.max(acc, r.sort_order), -1);
  const at = now();

  const field: WoField = {
    id: uid(),
    woId,
    label: label.trim(),
    value: value.trim(),
    sortOrder: maxSort + 1,
    deleted: false,
    createdAt: at,
    updatedAt: at,
  };

  await db().execute(
    `INSERT INTO core_wo_fields (id, wo_id, label, value, sort_order, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [field.id, field.woId, field.label, field.value, field.sortOrder, at, at],
  );
  return field;
}

const FIELD_COLUMNS: Record<string, string> = {
  label: "label",
  value: "value",
  sortOrder: "sort_order",
};

export async function updateWoField(id: string, patch: Partial<WoField>): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = FIELD_COLUMNS[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push(value as string | number | null);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  params.push(now(), id);
  await db().execute(`UPDATE core_wo_fields SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function deleteWoField(id: string): Promise<void> {
  await db().execute(`UPDATE core_wo_fields SET deleted = 1, updated_at = ? WHERE id = ?`, [
    now(),
    id,
  ]);
}

/** 全部绑定的相关信息（备份用，含各流程任务） */
/** `includeDeleted` 只给同步用，理由同 fetchLists */
export async function fetchAllWoFields(includeDeleted = false): Promise<WoField[]> {
  const rows = await db().select<RawField>(
    includeDeleted
      ? `SELECT * FROM core_wo_fields`
      : `SELECT * FROM core_wo_fields WHERE deleted = 0`,
  );
  return rows.map(toField);
}

/* ------------------------- 时效提醒（特殊单号） ------------------------- */

/** 提前多久算"临期"。定为 30 分钟：够反应过来，又不至于整天在提醒。 */
export const DUE_SOON_MINUTES = 30;

/**
 * 扫出"该提醒时效"的未完结流程任务。
 *
 * 与待办的提醒（core_tasks.remind_at）分开扫：那套是"这件事几点提醒我"，
 * 一套是一次性的；这套是"这一步还剩多久"，随流转不断重设。
 * 硬塞进同一列会让两套语义互相污染（比如流程任务推进时要记得清掉任务的提醒）。
 *
 * 只挑未完结、且**当前档位还没提醒过**的：
 * 提醒队列是内存态、重启即空，靠队列去重会让每次启动都重弹一遍。
 */
export async function fetchOrdersForDueReminder(): Promise<WorkOrder[]> {
  const rows = await db().select<RawOrder>(
    `SELECT * FROM core_work_orders WHERE deleted = 0 AND stage_due_at IS NOT NULL`,
  );
  const terminal = new Set(
    (await fetchStages()).filter((s) => s.isTerminal).map((s) => s.id),
  );
  return rows
    .map((r) => ({ ...toOrder(r), closed: terminal.has(r.stage_id) }))
    .filter((o) => !o.closed);
}

/**
 * 记下"这个时效已经提醒到哪一档"。
 *
 * level 用字符串而不是布尔量：临期提醒过之后，逾期还要再提醒一次 ——
 * 只知道"提醒过了"，逾期的第二条就永远发不出来。
 */
export async function markOrderDueNotified(id: string, level: "soon" | "overdue"): Promise<void> {
  await db().execute(
    `UPDATE core_work_orders SET stage_due_notified_at = ? WHERE id = ?`,
    [level, id],
  );
}

/** 默认流程。没有默认（理论上不该发生）就退回第一套，保证新建流程任务总有流程可用。 */
export async function getDefaultFlow(): Promise<WorkFlow | null> {
  const flows = await fetchFlows();
  return flows.find((f) => f.isDefault) ?? flows[0] ?? null;
}

/**
 * 首次运行写入默认流程。
 *
 * 单独一个函数而不是塞进 seedIfEmpty：老用户的库里已经有清单了，
 * seedIfEmpty 会直接 return，新加的流程就永远种不进去 ——
 * 升级后打开发现"流程任务功能是空的"，是最容易漏掉的一类问题。
 */
let flowSeedPromise: Promise<void> | null = null;

export function seedWorkOrderFlowsIfEmpty(): Promise<void> {
  if (!flowSeedPromise) {
    flowSeedPromise = seedFlowsInner().catch((err) => {
      flowSeedPromise = null;
      throw err;
    });
  }
  return flowSeedPromise;
}

async function seedFlowsInner(): Promise<void> {
  if ((await fetchFlows()).length) return;

  // 两套流程，用来体现「流程可自定义、且可以有多套」。
  //
  // 做法：createFlow 只给「待处理 / 已完成」两步占位，这里把占位的终态删掉，
  // 再按顺序把整条链路建出来。比"先建完再用 moveStage 逐步交换位置"直白得多，
  // 也不会因为交换次数算错而把顺序摆歪。
  const std = await createFlow("标准流程");
  const initial = (await fetchStages())
    .filter((s) => s.flowId === std.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const placeholderDone = initial.find((s) => s.isTerminal);
  const first = initial.find((s) => !s.isTerminal);
  if (placeholderDone) await deleteStage(placeholderDone.id);
  if (first) await updateStage(first.id, { name: "待接单", color: "#888780" });

  await createStage(std.id, "已受理", "#378add");
  await createStage(std.id, "处理中", "#ba7517");
  await createStage(std.id, "待验收", "#534ab7");
  await createStage(std.id, "已完成", "#1d9e75", true);

  const after = await createFlow("售后流程");
  const af = (await fetchStages())
    .filter((s) => s.flowId === after.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const p2 = af.find((s) => !s.isTerminal);
  const d2 = af.find((s) => s.isTerminal);
  if (p2) await updateStage(p2.id, { name: "受理中", color: "#d4537e" });
  if (p2) await createStage(after.id, "联系客户", "#378add");
  // 加在最后，仍然是收尾那一步
  if (d2) await updateStage(d2.id, { name: "已结案", color: "#1d9e75", isTerminal: true });

  // 第三套：给「特殊单号」用。和其它两套的唯一区别是**每一步带了默认时效** ——
  // 时效是"到下一步之前还剩多久"，只有用户知道每一步该给多久，
  // 所以它必须能写在流程里，而不是散在代码里。
  // 没有预设时效的那一步（终态）推过去就是"未设时效"，不会硬塞一个假的。
  //
  // 沿用标准流程那套写法：**先删掉占位的终态，再按顺序把整条链路建出来，
  // 最后补终态**。直接把终态留着再往后 append，终态就会卡在链路中间，
  // 后面的步骤永远走不到（售后流程那套就是这么摆的，见上面的注释）。
  const sp = await createFlow("特殊单号处理");
  const spInitial = (await fetchStages())
    .filter((s) => s.flowId === sp.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const spFirst = spInitial.find((s) => !s.isTerminal);
  const spDonePlaceholder = spInitial.find((s) => s.isTerminal);
  if (spDonePlaceholder) await deleteStage(spDonePlaceholder.id);
  if (spFirst) {
    await updateStage(spFirst.id, { name: "待处理", color: "#d4537e", defaultMinutes: 30 });
  }
  await createStage(sp.id, "处理中", "#ba7517", false, 240);
  await createStage(sp.id, "待确认", "#534ab7", false, 1440);
  await createStage(sp.id, "已完成", "#1d9e75", true);
}

/**
 * 首次运行放两张示例流程任务。
 *
 * 为什么要种子数据：空白的流程任务功能看不出「流程 / 过程态」到底长什么样，
 * 而这两件东西正是它区别于待办的地方。有数据摆在那儿，用户一眼就懂。
 * 只在**一张流程任务都没有**时执行，用户删光后不会又被塞回来。
 */
let demoOrderSeedPromise: Promise<void> | null = null;

export function seedDemoWorkOrdersIfEmpty(): Promise<void> {
  if (!demoOrderSeedPromise) {
    demoOrderSeedPromise = seedDemoOrdersInner().catch((err) => {
      demoOrderSeedPromise = null;
      throw err;
    });
  }
  return demoOrderSeedPromise;
}

async function seedDemoOrdersInner(): Promise<void> {
  // 数全部（含软删除）：用户删过示例之后，不应该再被种一遍
  const rows = await db().select<{ c: number }>(`SELECT COUNT(*) AS c FROM core_work_orders`);
  if ((rows[0]?.c ?? 0) > 0) return;

  const flow = await getDefaultFlow();
  if (!flow) return;

  const stages = (await fetchStages())
    .filter((s) => s.flowId === flow.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (!stages.length) return;

  const t = today();
  const a = await createWorkOrder({
    title: "1027 批次改码返工",
    description: "这批标签把 M 码印成了 L 码，返工重贴后要重新对一次库存数。",
    flowId: flow.id,
    startDate: addDays(t, -1),
    dueDate: addDays(t, 2),
    important: true,
  });
  // 推到第二步，好让过程态进度条不是"还停在第一步"的样子
  if (stages[1]) await moveOrderToStage(a.id, stages[1].id, "已确认返工数量");

  const b = await createWorkOrder({
    title: "客户 A 换货处理",
    description: "客户收到的是 M 码，要换 L 码；替换件已寄出，等对方签收。",
    flowId: flow.id,
    startDate: t,
    dueDate: addDays(t, 1),
  });
  if (stages[2]) await moveOrderToStage(b.id, stages[2].id, "已寄出替换件");

  // 一张特殊单号：让「时效」第一次打开就有样子看 ——
  // 它是特殊单号相对普通流程任务的核心差异（相关信息两者都有）。
  // 时效给 90 分钟：看得出"还剩多久"，又不会一进应用就是逾期的样子。
  const spFlow = (await fetchFlows()).find((f) => f.name === "特殊单号处理");
  if (spFlow) {
    const spStages = (await fetchStages())
      .filter((s) => s.flowId === spFlow.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    await createWorkOrder({
      kind: "special",
      title: "快递破损 · 待联系客户",
      no: "SF7712345678901",
      flowId: spFlow.id,
      stageId: spStages[0]?.id,
      note: "客户要求补发，已拍照留证",
      stageDueAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      // 起点那个快递单号已经是流程任务的单号（no）了，这里绑的是**另外**的信息，
      // 免得同一个号码在库里存两份、改一处另一处还是旧的
      fields: [
        { label: "补发单号", value: "SF7788001122334" },
        { label: "客户", value: "王女士" },
        { label: "手机尾号", value: "6621" },
      ],
    });
  }
}

/* --------------------------- 备份与恢复 --------------------------- */
/* ------------------------------------------------------------------ */
/* 流程任务附件                                                            */
/* ------------------------------------------------------------------ */

interface RawAttachment {
  id: string;
  wo_id: string;
  kind: string;
  title: string;
  rel_path: string | null;
  source_url: string | null;
  mime: string;
  size_bytes: number | null;
  hash: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  note: string;
  sort_order: number;
  deleted: number;
  created_at: string;
  /** v14 起才有。老行为 NULL —— 读的时候用 created_at 兜底，见 toAttachment */
  updated_at: string | null;
}

function toAttachment(r: RawAttachment): WoAttachment {
  // kind 是开放字段：老数据或手改过的库里可能是别的值。
  // 认不出的一律当 link —— 那是"不碰本地文件"的那一支，最安全。
  const kind: AttachmentKind =
    r.kind === "image" || r.kind === "video" ? r.kind : "link";
  return {
    id: r.id,
    woId: r.wo_id,
    kind,
    title: r.title ?? "",
    relPath: r.rel_path,
    sourceUrl: r.source_url,
    mime: r.mime ?? "",
    size: r.size_bytes,
    hash: r.hash,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    note: r.note ?? "",
    sortOrder: r.sort_order ?? 0,
    deleted: !!r.deleted,
    createdAt: r.created_at,
    // v14 之前的行没有 updated_at。用 created_at 兜底而不是留空：
    // 空串在合并时会被判成"最小时间戳"，那些老附件就永远赢不了新改动。
    updatedAt: r.updated_at ?? r.created_at,
  };
}

/** 一张流程任务的全部附件，按用户排的顺序 */
export async function fetchAttachments(woId: string): Promise<WoAttachment[]> {
  const rows = await db().select<RawAttachment>(
    `SELECT * FROM core_wo_attachments WHERE wo_id = ? AND deleted = 0
     ORDER BY sort_order ASC, created_at ASC`,
    [woId],
  );
  return rows.map(toAttachment);
}

export interface NewAttachmentInput {
  woId: string;
  kind: AttachmentKind;
  title: string;
  /** 仓库内相对路径。kind 为 link 时不传 */
  relPath?: string | null;
  /** 媒体是下载来源，链接是目标网址 */
  sourceUrl?: string | null;
  mime?: string;
  size?: number | null;
  hash?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

export async function createAttachment(input: NewAttachmentInput): Promise<WoAttachment> {
  // 排在最后。刻意不写 `SELECT MAX(sort_order)`：内存库一次 SELECT 只支持
  // **一个**聚合函数，而且附件条数是个位数，全量拉回来算更省事也更保险。
  const existing = await db().select<{ sort_order: number }>(
    `SELECT sort_order FROM core_wo_attachments WHERE wo_id = ? AND deleted = 0`,
    [input.woId],
  );
  const next = existing.reduce((m, r) => Math.max(m, r.sort_order ?? 0), -1) + 1;

  const id = uid();
  const at = now();
  await db().execute(
    `INSERT INTO core_wo_attachments
       (id, wo_id, kind, title, rel_path, source_url, mime, size_bytes, hash,
        width, height, duration_ms, note, sort_order, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.woId,
      input.kind,
      input.title,
      input.relPath ?? null,
      input.sourceUrl ?? null,
      input.mime ?? "",
      input.size ?? null,
      input.hash ?? null,
      input.width ?? null,
      input.height ?? null,
      input.durationMs ?? null,
      "",
      next,
      0,
      at,
      at,
    ],
  );
  return {
    id,
    woId: input.woId,
    kind: input.kind,
    title: input.title,
    relPath: input.relPath ?? null,
    sourceUrl: input.sourceUrl ?? null,
    mime: input.mime ?? "",
    size: input.size ?? null,
    hash: input.hash ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    note: "",
    sortOrder: next,
    deleted: false,
    createdAt: at,
    updatedAt: at,
  };
}

export async function updateAttachment(
  id: string,
  patch: Partial<Pick<WoAttachment, "title" | "note" | "width" | "height" | "durationMs" | "relPath" | "hash" | "size" | "mime" | "sourceUrl" | "sortOrder">>,
): Promise<void> {
  const map: Record<string, string> = {
    title: "title",
    note: "note",
    width: "width",
    height: "height",
    durationMs: "duration_ms",
    relPath: "rel_path",
    hash: "hash",
    size: "size_bytes",
    mime: "mime",
    sourceUrl: "source_url",
    sortOrder: "sort_order",
  };
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, col] of Object.entries(map)) {
    if (!(key in patch)) continue;
    sets.push(`${col} = ?`);
    const v = (patch as Record<string, unknown>)[key];
    params.push(v == null ? null : (v as string | number));
  }
  if (!sets.length) return;
  // 顺手记一次"改过"。同步要靠它判断同一条记录的两份谁更新 ——
  // 不记的话，"改了个标题"这件事在数据里完全看不见（v14 之前就是这样）。
  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);
  await db().execute(`UPDATE core_wo_attachments SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * 还有几张活着的记录引用这个内容。文件能不能删，看它。
 *
 * ⚠️ 必须**跨两张表**数，不能只看附件表。
 * 图库（v9）与流程任务附件共用同一个内容寻址仓库，同一份字节可以同时被
 * 「某张流程任务的附件」和「图库里的一张图」引用。只数附件表的话，
 * 删掉图库那条时会以为"没人用了"，把流程任务附件正指着的文件删掉 ——
 * 表现是另一处突然变成"文件缺失"，而且找不到是谁干的。
 *
 * 两次独立单表查询再相加，不写 UNION/JOIN：内存库的 mini-SQL 不支持它们，
 * 而且会**静默返回空**（不是报错），那比不支持更危险。
 */
export async function refCountByHash(hash: string): Promise<number> {
  const att = await db().select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM core_wo_attachments WHERE hash = ? AND deleted = 0`,
    [hash],
  );
  const gal = await db().select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM core_gallery_items WHERE hash = ? AND deleted = 0`,
    [hash],
  );
  return (att[0]?.c ?? 0) + (gal[0]?.c ?? 0);
}

/**
 * 删除一条附件记录，返回"可以顺手删掉的仓库文件"（没有则 null）。
 *
 * **文件按内容寻址，不能想删就删**：同一张图可能被两张流程任务引用，
 * 直接删文件会把另一张流程任务的附件一起弄没。
 * 所以这里只负责判断引用计数，真正的删除交给调用方（它才有文件仓库的句柄）。
 * 数据库层不碰文件系统，文件层不碰数据库 —— 这条边界要守住。
 */
export async function deleteAttachment(id: string): Promise<string | null> {
  const rows = await db().select<RawAttachment>(
    `SELECT * FROM core_wo_attachments WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  await db().execute(
    `UPDATE core_wo_attachments SET deleted = 1, updated_at = ? WHERE id = ?`,
    [now(), id],
  );

  if (!row.hash || !row.rel_path) return null;
  const live = await refCountByHash(row.hash);
  return live > 0 ? null : row.rel_path;
}

/** 在同一张流程任务内上下移动一位 */
export async function moveAttachment(id: string, dir: -1 | 1): Promise<void> {
  const rows = await db().select<RawAttachment>(
    `SELECT * FROM core_wo_attachments WHERE id = ?`,
    [id],
  );
  const me = rows[0];
  if (!me) return;
  const at = now();

  const siblings = await db().select<RawAttachment>(
    `SELECT * FROM core_wo_attachments WHERE wo_id = ? AND deleted = 0
     ORDER BY sort_order ASC, created_at ASC`,
    [me.wo_id],
  );
  const idx = siblings.findIndex((s) => s.id === id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return;

  const other = siblings[swapIdx];
  // 两条记录的 sort_order 可能相同（历史数据），所以不能只交换 sort_order 的值，
  // 否则"交换"完顺序纹丝不动。这里直接重排整段，落成 0..n-1 的连续序号。
  const reordered = [...siblings];
  reordered[idx] = other;
  reordered[swapIdx] = me;
  await db().transaction(
    reordered.map((r, i) => ({
      // 换顺序也算改过：否则 A 机器调了顺序、B 机器没动，同步时
      // 会因"两边时间戳一样"而随机取一边
      sql: `UPDATE core_wo_attachments SET sort_order = ?, updated_at = ? WHERE id = ?`,
      params: [i, at, r.id] as (string | number)[],
    })),
  );
}

/** 全部附件（备份用，含各流程任务） */
export async function fetchAllAttachments(): Promise<WoAttachment[]> {
  const rows = await db().select<RawAttachment>(
    `SELECT * FROM core_wo_attachments ORDER BY wo_id ASC, sort_order ASC`,
  );
  return rows.map(toAttachment);
}

/**
 * 图库条目的**备份形状**。
 *
 * 为什么不直接复用 lib/gallery.ts 的 GalleryItem：那个文件要从本文件取
 * refCountByHash（删文件前跨表数引用），反向再 import 回来就成环了 ——
 * 运行时不一定炸，但依赖关系会变得难以阅读（fetchCounts 那里已经
 * 为同一件事留下过注释）。所以这里用**原始的**行形状，映射也就几行。
 */
export interface GalleryBackupItem {
  id: string;
  title: string;
  kind: string;
  relPath: string;
  sourceUrl: string | null;
  mime: string;
  size: number | null;
  hash: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  origin: string;
  prompt: string;
  note: string;
  deleted: boolean;
  createdAt: string;
  /** v14 起新增。老备份里没有 —— 导入时用 createdAt 兜底 */
  updatedAt: string;
}

/** 全部图库条目（备份用）。和附件一样**含已软删除的**，把 deleted 一起带出去。 */
export async function fetchAllGallery(): Promise<GalleryBackupItem[]> {
  const rows = await db().select<{
    id: string;
    title: string;
    kind: string;
    rel_path: string;
    source_url: string | null;
    mime: string;
    size_bytes: number | null;
    hash: string | null;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    origin: string;
    prompt: string;
    note: string;
    deleted: number;
    created_at: string;
    updated_at: string | null;
  }>(`SELECT * FROM core_gallery_items ORDER BY created_at ASC, id ASC`);

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "",
    kind: r.kind === "video" ? "video" : "image",
    relPath: r.rel_path,
    sourceUrl: r.source_url,
    mime: r.mime ?? "",
    size: r.size_bytes,
    hash: r.hash,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    origin: r.origin || "manual",
    prompt: r.prompt ?? "",
    note: r.note ?? "",
    deleted: !!r.deleted,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
  }));
}

/** 某张流程任务的附件统计，流程任务列表上显示"带 3 个附件"用 */
export async function attachmentCounts(): Promise<Record<string, number>> {
  const rows = await db().select<{ wo_id: string; c: number }>(
    `SELECT wo_id, COUNT(*) AS c FROM core_wo_attachments WHERE deleted = 0 GROUP BY wo_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.wo_id] = r.c;
  return out;
}

export interface BackupPayload {
  app: "todo-workbench";
  schemaVersion: number;
  exportedAt: string;
  lists: TaskList[];
  tasks: Task[];
  /** 步骤按任务分组，key 是任务 id */
  steps: Record<string, Step[]>;
  /**
   * 任务关联。id / deleted / 时间戳是 v14 起新增的 —— 同步要按它们逐条合并，
   * 所以**都设为可选**：v14 之前导出的备份里只有 taskId 与 linkedId，
   * 强制要求新字段会让老备份整份作废。
   */
  links: Array<{
    taskId: string;
    linkedId: string;
    id?: string;
    deleted?: boolean;
    createdAt?: string;
    updatedAt?: string;
  }>;
  settings: Record<string, string>;
  // 以下为 v6 起新增。都是可选的：v6 之前导出的备份里没有这些字段，
  // 导入时必须当作"没有"而不是报错，否则老备份会整份作废。
  flows?: WorkFlow[];
  stages?: WorkStage[];
  workOrders?: WorkOrder[];
  woLogs?: WoLog[];
  /**
   * @deprecated 计划表已下线（v10 起不再写入）。
   *
   * 字段**保留在类型里**是为了让老备份还能被解析 —— 类型上直接删掉的话，
   * 一份 v9 导出的备份会变成"未知字段"，导入时被整份拒掉。
   * 导入时不再写回任何表（见 importBackup）。
   */
  planItems?: PlanItem[];
  /**
   * v7 起新增：附件**元数据**。
   *
   * 刻意不把文件本体塞进备份 —— 图片视频动辄几百 MB，塞进去会让
   * 备份文件从几百 KB 变成几百 MB，导出导入都要等半天，
   * 而备份的主诉求是"换台机器还能接着用"。
   * 代价要说清楚：**导入到新机器后，附件会显示"文件缺失"**，
   * 界面上给的是"重新下载"按钮（sourceUrl 还在，能补回来）；
   * 链接类附件则完全是好的。仓库目录是 %APPDATA%\待办工作台\attachments，
   * 想连文件一起搬，手动拷这个目录即可。
   */
  attachments?: WoAttachment[];
  /** v8 起新增：流程任务绑定的相关信息（特殊单号的另一个快递单号、用户名…） */
  woFields?: WoField[];
  /**
   * v9 起新增：图库条目的**元数据**。
   *
   * 和附件同一条原则：不塞文件本体。仓库目录是
   * %APPDATA%\待办工作台\attachments，图库和附件**共用同一个仓库**
   * （内容寻址，同一份字节只存一份），所以想连文件一起搬，
   * 手动拷那一个目录就够了。
   */
  gallery?: GalleryBackupItem[];
}

/** 导出全部核心数据，用于备份或迁移到另一台机器 */
export async function exportBackup(): Promise<BackupPayload> {
  const [lists, tasks, steps, settings, flows, stages, woLogs] = await Promise.all([
    fetchLists(),
    fetchTasks({ view: "all", includeDone: true }),
    fetchAllSteps(),
    getAllSettings(),
    fetchFlows(),
    fetchStages(),
    db().select<{
      id: string;
      wo_id: string;
      from_stage: string | null;
      to_stage: string;
      at: string;
      note: string;
    }>(`SELECT * FROM core_wo_logs ORDER BY wo_id ASC, seq ASC`),
  ]);

  const workOrders = await fetchWorkOrders({ view: "all", includeDone: true });
  const linkRows = await db().select<{
    id: string;
    task_id: string;
    linked_id: string;
    deleted: number;
    created_at: string;
    updated_at: string | null;
  }>(`SELECT id, task_id, linked_id, deleted, created_at, updated_at FROM core_task_links`);
  return {
    app: "todo-workbench",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: now(),
    lists,
    tasks,
    steps,
    // 带上 id / deleted / 时间戳：同步要按它们逐条合并。
    // 老备份里这些字段没有，所以类型上是可选的（见 BackupPayload.links）。
    links: linkRows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      linkedId: r.linked_id,
      deleted: !!r.deleted,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? r.created_at,
    })),
    settings,
    flows,
    stages,
    workOrders,
    woLogs: woLogs.map((r) => ({
      id: r.id,
      woId: r.wo_id,
      fromStage: r.from_stage,
      toStage: r.to_stage,
      at: r.at,
      note: r.note,
    })),
    attachments: await fetchAllAttachments(),
    woFields: await fetchAllWoFields(),
    gallery: await fetchAllGallery(),
  };
}

/**
 * 覆盖式导入：先清空核心表，再写入备份内容。
 *
 * 刻意做成"覆盖"而不是"合并"——合并需要定义冲突规则（同 id 谁赢、重名怎么办），
 * 在没有多端同步的本机应用里，这些规则只会带来误解。
 */
export async function importBackup(payload: BackupPayload): Promise<{
  lists: number;
  tasks: number;
  steps: number;
}> {
  if (!payload || payload.app !== "todo-workbench" || !Array.isArray(payload.lists)) {
    throw new Error("这不是待办工作台的备份文件");
  }

  const statements: Array<{ sql: string; params?: Param[] }> = [
    { sql: `DELETE FROM core_task_links` },
    { sql: `DELETE FROM core_steps` },
    { sql: `DELETE FROM core_tasks` },
    { sql: `DELETE FROM core_lists` },
    { sql: `DELETE FROM core_settings` },
    // v6 的表也要清 —— 漏掉它们会导致「导入后旧流程任务还挂着」，且看起来像是导入失败
    { sql: `DELETE FROM core_wo_logs` },
    { sql: `DELETE FROM core_work_orders` },
    { sql: `DELETE FROM core_wo_stages` },
    { sql: `DELETE FROM core_wo_flows` },
    // 计划表已下线，但表还在（迁移只追加）。清一下是为了别留下一堆
    // 再也读不到的旧行 —— 它没有任何别的副作用。
    { sql: `DELETE FROM core_plan_items` },
    // 附件记录也要清。文件本体不在这里删 —— 数据层不碰文件系统，
    // 由调用方拿着 rel_path 去仓库删（见 clearAllData 的说明）。
    { sql: `DELETE FROM core_wo_attachments` },
    { sql: `DELETE FROM core_wo_fields` },
    // v9 的图库。同样只删记录：文件本体由调用方按 rel_path 去仓库处理
    { sql: `DELETE FROM core_gallery_items` },
  ];

  for (const l of payload.lists) {
    statements.push({
      sql: `INSERT INTO core_lists (id, name, color, sort_order, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        l.id,
        l.name,
        l.color,
        l.sortOrder ?? 0,
        l.deleted ? 1 : 0,
        l.createdAt ?? now(),
        l.updatedAt ?? now(),
      ],
    });
  }

  for (const t of payload.tasks ?? []) {
    statements.push({
      sql: `INSERT INTO core_tasks
              (id, list_id, title, note, done, important, my_day, due_date, remind_at,
               completed_at, sort_order, repeat, repeat_done_on, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        t.id,
        t.listId,
        t.title ?? "",
        t.note ?? "",
        t.done ? 1 : 0,
        t.important ? 1 : 0,
        t.myDay ? 1 : 0,
        t.dueDate ?? null,
        t.remindAt ?? null,
        t.completedAt ?? null,
        t.sortOrder ?? 0,
        t.repeat ?? "none",
        t.repeatDoneOn ?? null,
        t.deleted ? 1 : 0,
        t.createdAt ?? now(),
        t.updatedAt ?? now(),
      ],
    });
  }

  let stepCount = 0;
  for (const [taskId, list] of Object.entries(payload.steps ?? {})) {
    for (const s of list ?? []) {
      stepCount++;
      statements.push({
        // 到期时刻也要跟着备份走：它是"这条子任务什么时候到期"的唯一记载，
        // 少了它，恢复出来的子任务会集体失去紧急提醒
        sql: `INSERT INTO core_steps (id, task_id, title, done, sort_order, due_at) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          s.id,
          taskId,
          s.title ?? "",
          s.done ? 1 : 0,
          s.sortOrder ?? 0,
          s.dueAt ?? null,
        ],
      });
    }
  }

  for (const l of payload.links ?? []) {
    if (!l?.taskId || !l?.linkedId) continue;
    statements.push({
      sql: `INSERT INTO core_task_links (id, task_id, linked_id, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        l.id ?? uid(),
        l.taskId,
        l.linkedId,
        l.deleted ? 1 : 0,
        l.createdAt ?? now(),
        l.updatedAt ?? l.createdAt ?? now(),
      ],
    });
  }

  for (const [key, value] of Object.entries(payload.settings ?? {})) {
    statements.push({
      sql: `INSERT INTO core_settings (key, value) VALUES (?, ?)`,
      params: [key, String(value)],
    });
  }

  // v6 的五张表。插入顺序必须是 流程 → 过程态 → 流程任务 → 流转日志，
  // 后者的外键指向前者；反过来会在有外键约束的库上报错，而浏览器内存库不报，
  // 于是"浏览器能导入、桌面导入失败"。
  for (const f of payload.flows ?? []) {
    statements.push({
      sql: `INSERT INTO core_wo_flows (id, name, is_default, sort_order, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        f.id,
        f.name ?? "流程",
        f.isDefault ? 1 : 0,
        f.sortOrder ?? 0,
        f.deleted ? 1 : 0,
        f.createdAt ?? now(),
        f.updatedAt ?? now(),
      ],
    });
  }

  for (const s of payload.stages ?? []) {
    statements.push({
      sql: `INSERT INTO core_wo_stages
              (id, flow_id, name, color, sort_order, is_terminal, default_minutes)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        s.id,
        s.flowId,
        s.name ?? "阶段",
        s.color ?? "#378add",
        s.sortOrder ?? 0,
        s.isTerminal ? 1 : 0,
        // v8 之前的过程态没有默认时效，缺失按 0（不预设）
        Number(s.defaultMinutes ?? 0),
      ],
    });
  }

  for (const w of payload.workOrders ?? []) {
    statements.push({
      sql: `INSERT INTO core_work_orders
              (id, kind, no, courier, title, flow_id, stage_id, note, important, my_day, start_date,
               due_date, stage_due_at, stage_due_notified_at, completed_at, sort_order, deleted,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        w.id,
        // v8 之前的备份里没有 kind / 时效，缺失就是普通流程任务、没有时效。
        // 当"特殊单"补出来是错的 —— 那会凭空给老单子加上处理时限。
        w.kind === "special" ? "special" : "normal",
        w.no ?? "",
        // v11 之前的备份没有快递商，缺失就是"没指定"（按单号自动识别）
        w.courier ?? "",
        w.title ?? "",
        w.flowId,
        w.stageId,
        w.note ?? "",
        w.important ? 1 : 0,
        w.myDay ? 1 : 0,
        w.startDate ?? null,
        w.dueDate ?? null,
        w.stageDueAt ?? null,
        w.stageDueNotifiedAt ?? "",
        w.completedAt ?? null,
        w.sortOrder ?? 0,
        w.deleted ? 1 : 0,
        w.createdAt ?? now(),
        w.updatedAt ?? now(),
      ],
    });
  }

  // seq 不是业务字段、也不在 WoLog 类型里，导入时按数组顺序重新编号 ——
  // 导出时已经按 (wo_id, seq) 排好序，所以数组顺序就是原来的先后顺序。
  const logSeq = new Map<string, number>();
  for (const l of payload.woLogs ?? []) {
    const n = (logSeq.get(l.woId) ?? 0) + 1;
    logSeq.set(l.woId, n);
    statements.push({
      sql: `INSERT INTO core_wo_logs (id, wo_id, from_stage, to_stage, at, note, seq)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [l.id, l.woId, l.fromStage ?? null, l.toStage, l.at ?? now(), l.note ?? "", n],
    });
  }

  // 计划表（core_plan_items）**不再写回**：它已经下线，紧急区是算出来的、
  // 不需要任何持久化。老备份里带的那批数据在这里被安静地丢弃 ——
  // 写回去只会留下一堆永远不会被读到的行。

  // v7 的附件。放在最后：外键指向 core_work_orders，必须等流程任务都插完。
  // sort_order 按数组下标重排，理由同 woLogs 的 seq —— 备份里的顺序
  // 就是用户排好的顺序，重排能顺带修掉历史数据里 sort_order 相同的情况。
  const attSeq = new Map<string, number>();
  for (const a of payload.attachments ?? []) {
    if (!a?.id || !a.woId) continue;
    const n = attSeq.get(a.woId) ?? 0;
    attSeq.set(a.woId, n + 1);
    statements.push({
      sql: `INSERT INTO core_wo_attachments
              (id, wo_id, kind, title, rel_path, source_url, mime, size_bytes, hash,
               width, height, duration_ms, note, sort_order, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        a.id,
        a.woId,
        a.kind ?? "link",
        a.title ?? "",
        a.relPath ?? null,
        a.sourceUrl ?? null,
        a.mime ?? "",
        a.size ?? null,
        a.hash ?? null,
        a.width ?? null,
        a.height ?? null,
        a.durationMs ?? null,
        a.note ?? "",
        n,
        a.deleted ? 1 : 0,
        a.createdAt ?? now(),
        a.updatedAt ?? a.createdAt ?? now(),
      ],
    });
  }

  // v8 的绑定信息。同样放在最后：外键指向 core_work_orders。
  // sort_order 按下标重排，理由同附件 —— 备份里的顺序就是用户排好的顺序。
  const fieldSeq = new Map<string, number>();
  for (const f of payload.woFields ?? []) {
    if (!f?.id || !f.woId) continue;
    const n = fieldSeq.get(f.woId) ?? 0;
    fieldSeq.set(f.woId, n + 1);
    statements.push({
      sql: `INSERT INTO core_wo_fields
              (id, wo_id, label, value, sort_order, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        f.id,
        f.woId,
        f.label ?? "",
        f.value ?? "",
        n,
        f.deleted ? 1 : 0,
        f.createdAt ?? now(),
        f.updatedAt ?? now(),
      ],
    });
  }

  // v9 的图库条目。它不指向别的表，所以放最后插就行。
  // created_at 原样带回来：图库没有 sort_order，排序完全靠它，
  // 重排（像附件那样按下标）反而会打乱用户看到的时间线。
  for (const it of payload.gallery ?? []) {
    if (!it?.id || !it.relPath) continue;
    statements.push({
      sql: `INSERT INTO core_gallery_items
              (id, title, kind, rel_path, source_url, mime, size_bytes, hash,
               width, height, duration_ms, origin, prompt, note, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        it.id,
        it.title ?? "",
        it.kind === "video" ? "video" : "image",
        it.relPath,
        it.sourceUrl ?? null,
        it.mime ?? "",
        it.size ?? null,
        it.hash ?? null,
        it.width ?? null,
        it.height ?? null,
        it.durationMs ?? null,
        it.origin || "manual",
        it.prompt ?? "",
        it.note ?? "",
        it.deleted ? 1 : 0,
        it.createdAt ?? now(),
        it.updatedAt ?? it.createdAt ?? now(),
      ],
    });
  }

  await db().transaction(statements);
  return {
    lists: payload.lists.length,
    tasks: (payload.tasks ?? []).length,
    steps: stepCount,
  };
}

/** 清空全部核心数据（列表、任务、配置）。不可撤销，调用方需二次确认。 */
export async function clearAllData(): Promise<void> {
  await db().transaction([
    { sql: `DELETE FROM core_task_links` },
    { sql: `DELETE FROM core_steps` },
    { sql: `DELETE FROM core_tasks` },
    { sql: `DELETE FROM core_lists` },
    { sql: `DELETE FROM core_settings` },
    { sql: `DELETE FROM core_wo_logs` },
    { sql: `DELETE FROM core_work_orders` },
    { sql: `DELETE FROM core_wo_stages` },
    { sql: `DELETE FROM core_wo_flows` },
    { sql: `DELETE FROM core_plan_items` },
    // 附件记录一并清。**仓库里的文件不在这里删**：数据层不碰文件系统，
    // 由调用方先收集 rel_path、清完库再去仓库删（见 store.ts 的 clearAll）。
    // 顺序不能反 —— 库先清掉就没地方查 rel_path 了，文件会永远留在磁盘上。
    { sql: `DELETE FROM core_wo_attachments` },
    { sql: `DELETE FROM core_wo_fields` },
    // 图库同理：**只清记录，不删文件**。图库和附件共用同一个内容寻址仓库，
    // 所以"哪些文件真的没人用了"只能在清库**之前**算出来，
    // 由 store.ts 的 clearAll 统一处理（它才拿得到文件仓库的句柄）。
    { sql: `DELETE FROM core_gallery_items` },
  ]);
}

/* --------------------------- 工具数据隔离演示 --------------------------- */

/**
 * 工具私有表的建表示例。
 * 工具自己声明 schema，宿主只负责执行 —— 工具的 dbVersion 变了才重跑。
 * 这里用订单记录做样例，证明工具表与核心表共库但互不干扰。
 */
export async function ensureToolTable(toolId: string): Promise<string> {
  const table = toolTable(toolId, "orders");
  await db().execute(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         TEXT PRIMARY KEY,
      order_no   TEXT NOT NULL,
      amount     REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  return table;
}
