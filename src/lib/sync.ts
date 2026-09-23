/**
 * 坚果云同步的核心：**纯函数合并**。
 *
 * 这一层不碰网络、不碰数据库 —— 输入两份数据，输出一份合并结果。
 * 这样切分有两个理由：
 *
 * 1. **它才是同步里最容易错的地方，而它必须能被测到。**
 *    传输层在 Rust 里（PROPFIND / MKCOL 前端根本发不出去），
 *    而这套 e2e 跑的是浏览器演示模式、碰不到 Rust。
 *    把合并规则留成纯函数，同步逻辑就仍然能被测试完整覆盖。
 * 2. **合并是业务规则，和"怎么传"无关。** 以后换掉坚果云
 *    （换对象存储、换自建服务端），这个文件一个字都不用改。
 *
 * ## 合并规则
 *
 * 所有会变的表都有 `id` + `updatedAt` + 软删除 `deleted` 三件套，所以
 * 主线是**逐条 last-write-wins**：同一个 id 两边都有，谁的时间戳新听谁的。
 * 删除不用单独处理 —— `deleted` 就是一个普通字段，跟着 LWW 一起走。
 *
 * 三处例外，都是**没有自己时间戳的从属数据**：
 *
 * | 数据 | 处理 | 为什么 |
 * |---|---|---|
 * | 子任务 | 跟随父任务**整体**走 | 没有时间戳，无法独立比较；它本来就依附于父任务，脱离父任务的子任务没有意义 |
 * | 过程态 | 跟随流程模板**整体**走 | 同上 |
 * | 流转记录 | 按 id 取**并集** | 追加型数据，写了就不会改，两条不同 id 的记录永远可以共存 |
 *
 * ⚠️ 这带来的已知取舍：**两台机器同时改同一条待办的两个不同子任务时，
 * 一方的改动会被整组覆盖掉。** 不做子任务粒度的合并是刻意的 ——
 * 那需要给 core_steps 加上自己的一套同步元数据，而收益只在这种很窄的
 * 并发场景下才体现得出来。界面上出现冲突提示时，用户能知道发生了什么。
 */

import type {
  Step,
  Task,
  TaskList,
  WoAttachment,
  WoField,
  WoLog,
  WorkFlow,
  WorkOrder,
  WorkStage,
} from "../types";
/**
 * 图库的**备份模型**（含 deleted / updatedAt）。
 *
 * 不用界面模型 GalleryItem：那个模型里根本没有 deleted / updatedAt ——
 * 界面上永远只看得到活着的那批，而这两样恰好是合并必须的。
 * `import type` 只在编译期存在，不会让这一层产生对数据层的运行时依赖。
 */
import type { GalleryBackupItem } from "./repo";

/** 分片标识。一个分片 = 一类数据的**完整快照**（不是增量） */
export type SyncShardId = "tasks" | "orders" | "gallery" | "attachments";

/** 分片格式版本。载荷结构变了就 +1，旧版客户端据此拒收而不是读出乱码 */
export const SHARD_FORMAT = 1;

export const SHARD_LABELS: Record<SyncShardId, string> = {
  tasks: "待办",
  orders: "流程任务",
  gallery: "图库",
  attachments: "流程任务附件",
};

/**
 * 分片信封。
 *
 * `deviceId` / `deviceName` 不是为了做设备管理，而是为了**在界面上说人话**：
 * "上次同步是另一台机器（DESKTOP-XXX）在 10 分钟前写的"比
 * "远端时间戳 2026-09-23T07:31:02Z"有用得多。
 */
export interface SyncShard<P = unknown> {
  app: "todo-workbench";
  format: number;
  shard: SyncShardId;
  /** 这份分片的数据时间，两侧取较新者 */
  updatedAt: string;
  deviceId: string;
  deviceName: string;
  payload: P;
}

/* ------------------------------------------------------------------ */
/* 载荷                                                                */
/* ------------------------------------------------------------------ */

/** 任务关联。v14 起有了自己的时间戳与软删除，可以独立参与 LWW */
export interface SyncLink {
  id: string;
  taskId: string;
  linkedId: string;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 待办分片。
 *
 * 清单和子任务**不单独成片**：清单是待办的容器（没有清单的待办无处安放），
 * 子任务依附于待办（见文件头的合并规则）。拆开只会让"同步到一半"变成
 * 一种真实可能 —— 待办过来了、它的清单和子任务还在路上。
 */
export interface TasksPayload {
  lists: TaskList[];
  tasks: Task[];
  /** 子任务按 taskId 分组。key 是父任务 id */
  steps: Record<string, Step[]>;
  links: SyncLink[];
}

/** 流程任务分片。过程态按 flowId 分组，理由同子任务 */
export interface OrdersPayload {
  flows: WorkFlow[];
  stages: Record<string, WorkStage[]>;
  workOrders: WorkOrder[];
  woFields: WoField[];
  woLogs: WoLog[];
}

export interface GalleryPayload {
  /** 含已软删除的 —— 墓碑必须跟着走，否则"删除"这个动作同步不过去 */
  items: GalleryBackupItem[];
}

export interface AttachmentsPayload {
  /** 同上，含软删除 */
  items: WoAttachment[];
}

export type ShardPayload =
  | TasksPayload
  | OrdersPayload
  | GalleryPayload
  | AttachmentsPayload;

/* ------------------------------------------------------------------ */
/* 时间戳                                                              */
/* ------------------------------------------------------------------ */

/** 任何带同步元数据的记录 */
export interface Stamped {
  updatedAt?: string | null;
  createdAt?: string | null;
}

/**
 * 取一条记录的"改动时刻"。
 *
 * **必须用 createdAt 兜底**：v14 之前写下的行没有 updated_at，
 * 不兜底就等于给它们判了"永远最旧"，一同步就会被对面覆盖掉。
 */
export function stampOf(x: Stamped): string {
  return x.updatedAt || x.createdAt || "";
}

/**
 * 解析成毫秒。解析不出来返回 null，**而不是 0**。
 *
 * 两者的差别是实质性的：0 意味着"最旧"，一个坏时间戳就会让这条记录
 * 在合并里稳定地输给对面；null 表示"无从判断"，交给调用方保留本地。
 * 手改过数据库、或者从别处导入过数据的库里，坏时间戳是真会出现的。
 */
function millis(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

export type Winner = "local" | "remote" | "same";

/** 同一条记录两边都有时，采用谁 */
export function pickWinner(local: Stamped, remote: Stamped): Winner {
  const a = millis(stampOf(local));
  const b = millis(stampOf(remote));
  // 两边都无从判断 → 不动本地。宁可少合并一次，也不要凭空覆盖用户的数据
  if (a === null && b === null) return "same";
  // 一边有时间戳一边没有 → 有改动记录的更可信
  if (a === null) return "remote";
  if (b === null) return "local";
  if (b > a) return "remote";
  if (a > b) return "local";
  return "same";
}

/**
 * 稳定序列化：对象键排序后再转字符串。
 *
 * 用途只有一个 —— 判断"两边的内容是否真的不一样"。直接 JSON.stringify
 * 会因为键顺序不同而把同一份内容判成不同（两端的数据来源不同，
 * 键顺序本来就不保证一致），于是产生一堆假的冲突提示。
 */
export function stableJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  const obj = x as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/**
 * 判断两条记录是不是**同一份内容**。
 *
 * 比之前要把同步自己的元数据（updatedAt / createdAt）剔掉：同一处改动
 * 被两端各记了一次时，内容一模一样而时间戳必然不同，把它们算进比较
 * 就等于"每次同步都报一堆冲突" —— 而冲突提示一旦变成噪音，
 * 真正被覆盖掉的那一条就再也提醒不到人了。
 *
 * 只剔这两个键：completedAt / dueAt 这类是**用户可见的状态**，得留着比。
 */
export function sameContent(a: unknown, b: unknown): boolean {
  return stableJson(stripStamps(a)) === stableJson(stripStamps(b));
}

function stripStamps(x: unknown): unknown {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(stripStamps);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (k === "updatedAt" || k === "createdAt") continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 结果                                                                */
/* ------------------------------------------------------------------ */

export interface SyncStats {
  /** 云端有、本地没有 → 从云端取回来的 */
  added: number;
  /** 两边都有、采用了云端版本的 */
  updated: number;
  /** 两边都有、保留了本地版本的（含内容相同的情况） */
  kept: number;
  /**
   * 只有本地有 → 会被推到云端。
   *
   * 单独计数而不是并进 kept：只报"取回了几条"会让"我这边的改动到底
   * 传上去了没有"变成一个需要猜的问题，而这恰恰是同步最该回答的事。
   */
  pushed: number;
}

export function emptyStats(): SyncStats {
  return { added: 0, updated: 0, kept: 0, pushed: 0 };
}

export function addStats(a: SyncStats, b: SyncStats): SyncStats {
  return {
    added: a.added + b.added,
    updated: a.updated + b.updated,
    kept: a.kept + b.kept,
    pushed: a.pushed + b.pushed,
  };
}

/** 这次同步到底动了多少条（两个方向都算） */
export function totalChanged(s: SyncStats): number {
  return s.added + s.updated + s.pushed;
}

/**
 * 一条冲突。
 *
 * 冲突**不是错误**，合并已经完成了 —— 它要回答的是"我这边有什么改动
 * 被对方的覆盖掉了"。没有这层提示的话，用户只能看到"同步成功"，
 * 然后过两天发现某条待办的备注变回了旧内容，却完全不知道为什么。
 */
export interface SyncConflict {
  kind:
    | "list"
    | "task"
    | "link"
    | "flow"
    | "order"
    | "field"
    | "log"
    | "gallery"
    | "attachment";
  id: string;
  /** 给人看的名字。冲突清单里必须能认出是哪一条 */
  label: string;
  localAt: string;
  remoteAt: string;
  winner: Winner;
}

/* ------------------------------------------------------------------ */
/* 通用合并                                                            */
/* ------------------------------------------------------------------ */

export interface MergeResult<T> {
  rows: T[];
  stats: SyncStats;
  conflicts: SyncConflict[];
  /**
   * 每一行最终取自哪一侧。子任务 / 过程态要跟着父记录整体走，
   * 就得知道父记录是从哪边来的。
   */
  from: Map<string, "local" | "remote">;
}

/**
 * 按 id 逐条合并：两边都有比时间戳，只有一边有就直接采用。
 *
 * @param kind      冲突清单里标的类型
 * @param labelOf   取"给人看的名字"，取不到就用 id
 */
export function mergeRecords<T extends { id: string } & Stamped>(
  local: T[],
  remote: T[],
  kind: SyncConflict["kind"],
  labelOf: (x: T) => string = (x) => x.id,
): MergeResult<T> {
  const localMap = new Map(local.map((x) => [x.id, x]));
  const remoteMap = new Map(remote.map((x) => [x.id, x]));

  const rows: T[] = [];
  const from = new Map<string, "local" | "remote">();
  const conflicts: SyncConflict[] = [];
  const stats = emptyStats();

  for (const [id, r] of remoteMap) {
    const l = localMap.get(id);

    if (!l) {
      rows.push(r);
      from.set(id, "remote");
      stats.added++;
      continue;
    }

    const winner = pickWinner(l, r);
    if (winner === "remote") {
      rows.push(r);
      from.set(id, "remote");
      stats.updated++;
    } else {
      rows.push(l);
      from.set(id, "local");
      stats.kept++;
    }

    // 只在"两边确实不一样"且"有一方胜出"时才算冲突。
    // 内容相同却时间戳不同（同一处改动被两端各记了一次）不该打扰用户。
    if (winner !== "same" && !sameContent(l, r)) {
      conflicts.push({
        kind,
        id,
        label: safeLabel(() => labelOf(winner === "remote" ? r : l), id),
        localAt: stampOf(l),
        remoteAt: stampOf(r),
        winner,
      });
    }
  }

  // 只在本地有的：本地新增，保留，之后会被推到云端
  for (const [id, l] of localMap) {
    if (remoteMap.has(id)) continue;
    rows.push(l);
    from.set(id, "local");
    stats.pushed++;
  }

  return { rows, stats, conflicts, from };
}

/** 追加型数据：按 id 取并集。写了就不会改，所以不需要比时间戳 */
export function unionRecords<T extends { id: string }>(local: T[], remote: T[]): T[] {
  const seen = new Set(local.map((x) => x.id));
  const out = [...local];
  for (const r of remote) if (!seen.has(r.id)) out.push(r);
  return out;
}

/** labelOf 抛错不该让整次同步挂掉 —— 取名字只是给人看的 */
function safeLabel(fn: () => string, fallback: string): string {
  try {
    return fn() || fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* 分片合并                                                            */
/* ------------------------------------------------------------------ */

/** 待办的显示名：标题优先，退到描述，再退到 id */
function taskLabel(t: Task): string {
  return t.title || t.note || t.id;
}

export function mergeTasksPayload(
  local: TasksPayload,
  remote: TasksPayload,
): { payload: TasksPayload; stats: SyncStats; conflicts: SyncConflict[] } {
  const lists = mergeRecords(local.lists ?? [], remote.lists ?? [], "list", (l) => l.name);
  const links = mergeRecords(local.links ?? [], remote.links ?? [], "link", (l) =>
    `${l.taskId} ↔ ${l.linkedId}`,
  );

  // 待办本身走 LWW，但**子任务跟着父任务整体走**：
  // 上面 from 记录了每条待办最终取自哪一侧，子任务就取那一侧的整组。
  // 不这么做的话只能按 id 并集，而子任务被删除（硬删，没有墓碑）时
  // 那个删除就永远同步不过去。
  const tasks = mergeRecords(local.tasks ?? [], remote.tasks ?? [], "task", taskLabel);
  const steps: Record<string, Step[]> = {};
  for (const t of tasks.rows) {
    const side = tasks.from.get(t.id);
    const src = side === "remote" ? remote.steps : local.steps;
    steps[t.id] = src?.[t.id] ?? local.steps?.[t.id] ?? [];
  }

  return {
    payload: { lists: lists.rows, tasks: tasks.rows, steps, links: links.rows },
    stats: addStats(addStats(lists.stats, tasks.stats), links.stats),
    conflicts: [...lists.conflicts, ...tasks.conflicts, ...links.conflicts],
  };
}

export function mergeOrdersPayload(
  local: OrdersPayload,
  remote: OrdersPayload,
): { payload: OrdersPayload; stats: SyncStats; conflicts: SyncConflict[] } {
  const flows = mergeRecords(local.flows ?? [], remote.flows ?? [], "flow", (f) => f.name);
  const orders = mergeRecords(local.workOrders ?? [], remote.workOrders ?? [], "order", (o) =>
    o.title || o.description || o.no || o.id,
  );
  const fields = mergeRecords(local.woFields ?? [], remote.woFields ?? [], "field", (f) =>
    `${f.label}=${f.value}`,
  );

  // 过程态跟流程模板整体走，理由同子任务
  const stages: Record<string, WorkStage[]> = {};
  for (const f of flows.rows) {
    const side = flows.from.get(f.id);
    const src = side === "remote" ? remote.stages : local.stages;
    stages[f.id] = src?.[f.id] ?? local.stages?.[f.id] ?? [];
  }

  // 流转记录是追加型的：按 id 取并集，不参与 LWW
  const logs = unionRecords(local.woLogs ?? [], remote.woLogs ?? []);

  return {
    payload: {
      flows: flows.rows,
      stages,
      workOrders: orders.rows,
      woFields: fields.rows,
      woLogs: logs,
    },
    stats: addStats(addStats(flows.stats, orders.stats), fields.stats),
    conflicts: [...flows.conflicts, ...orders.conflicts, ...fields.conflicts],
  };
}

export function mergeGalleryPayload(
  local: GalleryPayload,
  remote: GalleryPayload,
): { payload: GalleryPayload; stats: SyncStats; conflicts: SyncConflict[] } {
  const items = mergeRecords(local.items ?? [], remote.items ?? [], "gallery", (g) =>
    g.title || g.id,
  );
  return { payload: { items: items.rows }, stats: items.stats, conflicts: items.conflicts };
}

export function mergeAttachmentsPayload(
  local: AttachmentsPayload,
  remote: AttachmentsPayload,
): { payload: AttachmentsPayload; stats: SyncStats; conflicts: SyncConflict[] } {
  const items = mergeRecords(local.items ?? [], remote.items ?? [], "attachment", (a) =>
    a.title || a.id,
  );
  return { payload: { items: items.rows }, stats: items.stats, conflicts: items.conflicts };
}

/** 按分片派发。让编排层不必写 switch */
export function mergeShard(
  shard: SyncShardId,
  local: ShardPayload,
  remote: ShardPayload,
): { payload: ShardPayload; stats: SyncStats; conflicts: SyncConflict[] } {
  switch (shard) {
    case "tasks":
      return mergeTasksPayload(local as TasksPayload, remote as TasksPayload);
    case "orders":
      return mergeOrdersPayload(local as OrdersPayload, remote as OrdersPayload);
    case "gallery":
      return mergeGalleryPayload(local as GalleryPayload, remote as GalleryPayload);
    case "attachments":
      return mergeAttachmentsPayload(
        local as AttachmentsPayload,
        remote as AttachmentsPayload,
      );
  }
}

/* ------------------------------------------------------------------ */
/* 分片信封                                                            */
/* ------------------------------------------------------------------ */

/** 远端比本地新才认为"云端动过"。两侧都解析不出来时返回 false（不动本地） */
export function remoteIsNewer(local: SyncShard, remote: SyncShard): boolean {
  const a = millis(local.updatedAt);
  const b = millis(remote.updatedAt);
  if (b === null) return false;
  if (a === null) return true;
  return b > a;
}

/**
 * 解析从云端取回来的分片。
 *
 * 云端的文件**是外部输入**：可能是别的版本写的、可能被用户手改过、
 * 也可能根本不是我们的文件（坚果云里同目录放过别的东西）。
 * 一律按不可信数据处理，认不出来就返回 null 让调用方跳过这个分片 ——
 * 绝不能让一个坏文件把整次同步打断，更不能让它把库写坏。
 */
export function parseShard(
  raw: string,
  expect: SyncShardId,
): SyncShard<ShardPayload> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const s = parsed as Partial<SyncShard>;
  if (s.app !== "todo-workbench") return null;
  if (s.shard !== expect) return null;
  if (typeof s.format !== "number" || s.format > SHARD_FORMAT) return null;
  if (!s.payload || typeof s.payload !== "object") return null;

  return {
    app: "todo-workbench",
    format: s.format,
    shard: s.shard,
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
    deviceId: typeof s.deviceId === "string" ? s.deviceId : "",
    deviceName: typeof s.deviceName === "string" ? s.deviceName : "",
    // 只到这一层为止：payload 内部结构没有校验，由各 merge 函数用 ?? [] 兜底
    payload: s.payload as ShardPayload,
  };
}

/** 序列化分片。缩进过会明显变大而同步不需要人读，所以紧凑输出 */
export function serializeShard(shard: SyncShard): string {
  return JSON.stringify(shard);
}
