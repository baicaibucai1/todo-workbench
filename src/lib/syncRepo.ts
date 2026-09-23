/**
 * 同步与本地数据库之间的搬运层。
 *
 * 两个方向：
 *   - `exportShardPayload`：把某一类数据取成一份**完整快照**（含软删除的墓碑）
 *   - `applyShardPayload`：把合并结果写回库
 *
 * ## 为什么写回不用"清空全表 + 重插"
 *
 * 合并结果的语义是"两边的并集"，看起来清空重插是等价的、也更简单。但
 * `core_work_orders` 有一个**不属于本分片**的子表：`core_wo_attachments`
 * （外键 ON DELETE CASCADE）。只勾选了「流程任务」而没勾「附件」时，
 * 清空流程任务表会把用户的附件记录连带删光 —— 而且是静默的，
 * 界面上只表现为"附件不见了"。
 *
 * 所以除了两张**硬删除、没有墓碑**的从属表（core_steps / core_wo_stages，
 * 它们的删除只能靠"整组替换"表达），写回一律走 upsert：
 * 存在则 UPDATE、不存在则 INSERT。多出来的行不会被删，
 * 但那种行本来就不该存在 —— 导出时取的是全量，合并结果是并集。
 */

import { db, type Param } from "./db";
import {
  fetchAllAttachments,
  fetchAllWoFields,
  fetchAllSteps,
  fetchFlows,
  fetchLists,
  fetchStages,
  fetchTasks,
  fetchWorkOrders,
} from "./repo";
import { fetchAllGallery } from "./repo";
import type {
  AttachmentsPayload,
  GalleryPayload,
  OrdersPayload,
  ShardPayload,
  SyncShardId,
  SyncLink,
  TasksPayload,
} from "./sync";
import type { Step, WoLog, WorkStage } from "../types";

/* ------------------------------------------------------------------ */
/* 行 → 模型                                                            */
/* ------------------------------------------------------------------ */

interface RawLink {
  id: string;
  task_id: string;
  linked_id: string;
  deleted: number;
  created_at: string;
  updated_at: string | null;
}

interface RawLog {
  id: string;
  wo_id: string;
  from_stage: string | null;
  to_stage: string;
  at: string;
  note: string;
}

/**
 * 全部任务关联，**含已取消的**。
 *
 * repo 里没有这个查询：界面只需要活着的关联（fetchLinkedTasks 带 deleted = 0），
 * 而同步必须带上取消记录 —— 否则"A 机器取消了关联"同步到 B 机器后，
 * B 那条关联会原样留着，用户会以为同步没生效。
 */
async function fetchAllLinks(): Promise<SyncLink[]> {
  const rows = await db().select<RawLink>(
    `SELECT id, task_id, linked_id, deleted, created_at, updated_at FROM core_task_links`,
  );
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    linkedId: r.linked_id,
    deleted: !!r.deleted,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
  }));
}

/**
 * 全部流转记录。
 *
 * 不带 seq：seq 是"同一张单里的第几条"，由插入顺序决定，
 * 属于库内部的排序细节，不该跨机器传递（两边各排各的，结果一致）。
 */
async function fetchAllLogs(): Promise<WoLog[]> {
  const rows = await db().select<RawLog>(
    `SELECT id, wo_id, from_stage, to_stage, at, note FROM core_wo_logs ORDER BY wo_id ASC, seq ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    woId: r.wo_id,
    fromStage: r.from_stage,
    toStage: r.to_stage,
    at: r.at,
    note: r.note,
  }));
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

export async function exportTasksPayload(): Promise<TasksPayload> {
  const [lists, tasks, steps, links] = await Promise.all([
    fetchLists(true),
    // includeDone + includeDeleted：同步要的是**全量快照**，
    // 已完成和已删除的都必须带上（后者是墓碑）
    fetchTasks({ view: "all", includeDone: true, includeDeleted: true }),
    fetchAllSteps(),
    fetchAllLinks(),
  ]);
  return { lists, tasks, steps, links };
}

export async function exportOrdersPayload(): Promise<OrdersPayload> {
  const [flows, allStages, workOrders, woFields, woLogs] = await Promise.all([
    fetchFlows(true),
    fetchStages(),
    fetchWorkOrders({ view: "all", includeDone: true, includeDeleted: true }),
    fetchAllWoFields(true),
    fetchAllLogs(),
  ]);

  // 过程态按流程分组：它跟着流程模板整体走（理由见 sync.ts 的合并规则表），
  // 所以载荷里就得先分好组，合并时才谈得上"取赢家那一侧的整组"
  const stages: Record<string, WorkStage[]> = {};
  for (const s of allStages) (stages[s.flowId] ??= []).push(s);

  return { flows, stages, workOrders, woFields, woLogs };
}

export async function exportGalleryPayload(): Promise<GalleryPayload> {
  // fetchAllGallery 已经含软删（备份也要墓碑），直接复用
  return { items: await fetchAllGallery() };
}

export async function exportAttachmentsPayload(): Promise<AttachmentsPayload> {
  return { items: await fetchAllAttachments() };
}

/** 按分片导出载荷 */
export async function exportShardPayload(shard: SyncShardId): Promise<ShardPayload> {
  switch (shard) {
    case "tasks":
      return exportTasksPayload();
    case "orders":
      return exportOrdersPayload();
    case "gallery":
      return exportGalleryPayload();
    case "attachments":
      return exportAttachmentsPayload();
  }
}

/* ------------------------------------------------------------------ */
/* 写回                                                                */
/* ------------------------------------------------------------------ */

const bit = (v: boolean | undefined): number => (v ? 1 : 0);
const str = (v: string | null | undefined, fallback = ""): string => v ?? fallback;

interface TableWrite {
  /** 表名。**只来自本文件里的常量**，不接受任何外部输入，所以拼进 SQL 是安全的 */
  table: string;
  /** 数据库列名。INSERT 与 UPDATE 共用同一份，避免两处清单漂移 */
  columns: string[];
  /** 把模型转成与 columns 一一对应的参数 */
  paramsOf: (row: never) => Param[];
}

/**
 * 逐条 upsert：库里已有这个 id 就 UPDATE，没有就 INSERT。
 *
 * 先一次性把该表的 id 全查出来，而不是每条记录查一次 ——
 * 数据量虽小，但"每条一次查询"会让写回退化成 N+1 次往返，
 * 而这个循环本来可以只跑一次。
 */
async function upsertAll<T extends { id: string }>(
  w: TableWrite,
  rows: T[],
): Promise<void> {
  if (!rows.length) return;

  const existing = new Set(
    (await db().select<{ id: string }>(`SELECT id FROM ${w.table}`)).map((r) => r.id),
  );

  const nonId = w.columns.filter((c) => c !== "id");
  const statements = rows.map((row) => {
    const values = (w.paramsOf as (r: T) => Param[])(row);
    if (existing.has(row.id)) {
      return {
        sql: `UPDATE ${w.table} SET ${nonId.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        // values 与 columns 同序，所以要从"除 id 外"的位置切片；
        // 这里直接用整份值再补一次 id 更不容易错：id 在 SET 里被排除，
        // 而 WHERE 的 ? 用最后一个参数
        params: [...values.filter((_, i) => w.columns[i] !== "id"), row.id] as Param[],
      };
    }
    return {
      sql: `INSERT INTO ${w.table} (${w.columns.join(", ")})
            VALUES (${w.columns.map(() => "?").join(", ")})`,
      params: values,
    };
  });

  await db().transaction(statements);
}

/** 整组替换：先删光这张表再写。只用于**没有墓碑**的从属表（见文件头） */
async function replaceAll<T extends { id: string }>(
  table: string,
  w: TableWrite,
  rows: T[],
): Promise<void> {
  const statements: Array<{ sql: string; params?: Param[] }> = [
    { sql: `DELETE FROM ${table}` },
  ];
  for (const row of rows) {
    statements.push({
      sql: `INSERT INTO ${table} (${w.columns.join(", ")})
            VALUES (${w.columns.map(() => "?").join(", ")})`,
      params: (w.paramsOf as (r: T) => Param[])(row),
    });
  }
  await db().transaction(statements);
}

/* ------------------------------ 各表的列定义 ------------------------------ */

const W_LISTS: TableWrite = {
  table: "core_lists",
  columns: ["id", "name", "color", "sort_order", "deleted", "created_at", "updated_at"],
  paramsOf: (r: never) => {
    const x = r as TasksPayload["lists"][number];
    return [x.id, str(x.name), str(x.color), x.sortOrder ?? 0, bit(x.deleted), str(x.createdAt), str(x.updatedAt)];
  },
};

const W_TASKS: TableWrite = {
  table: "core_tasks",
  columns: [
    "id", "list_id", "title", "note", "done", "important", "my_day", "due_date",
    "remind_at", "completed_at", "sort_order", "repeat", "repeat_done_on",
    "deleted", "created_at", "updated_at",
  ],
  paramsOf: (r: never) => {
    const x = r as TasksPayload["tasks"][number];
    return [
      x.id, str(x.listId), str(x.title), str(x.note), bit(x.done), bit(x.important),
      bit(x.myDay), x.dueDate ?? null, x.remindAt ?? null, x.completedAt ?? null,
      x.sortOrder ?? 0, x.repeat === "daily" ? "daily" : "none", x.repeatDoneOn ?? null,
      bit(x.deleted), str(x.createdAt), str(x.updatedAt),
    ];
  },
};

const W_STEPS: TableWrite = {
  table: "core_steps",
  columns: ["id", "task_id", "title", "done", "sort_order", "due_at"],
  paramsOf: (r: never) => {
    const x = r as Step;
    return [x.id, str(x.taskId), str(x.title), bit(x.done), x.sortOrder ?? 0, x.dueAt ?? null];
  },
};

const W_LINKS: TableWrite = {
  table: "core_task_links",
  columns: ["id", "task_id", "linked_id", "deleted", "created_at", "updated_at"],
  paramsOf: (r: never) => {
    const x = r as SyncLink;
    return [x.id, str(x.taskId), str(x.linkedId), bit(x.deleted), str(x.createdAt), str(x.updatedAt)];
  },
};

const W_FLOWS: TableWrite = {
  table: "core_wo_flows",
  columns: ["id", "name", "is_default", "sort_order", "deleted", "created_at", "updated_at"],
  paramsOf: (r: never) => {
    const x = r as OrdersPayload["flows"][number];
    return [x.id, str(x.name), bit(x.isDefault), x.sortOrder ?? 0, bit(x.deleted), str(x.createdAt), str(x.updatedAt)];
  },
};

const W_STAGES: TableWrite = {
  table: "core_wo_stages",
  columns: ["id", "flow_id", "name", "color", "sort_order", "is_terminal", "default_minutes"],
  paramsOf: (r: never) => {
    const x = r as WorkStage;
    return [
      x.id, str(x.flowId), str(x.name), str(x.color, "#378add"),
      x.sortOrder ?? 0, bit(x.isTerminal), x.defaultMinutes ?? 0,
    ];
  },
};

const W_ORDERS: TableWrite = {
  table: "core_work_orders",
  // 列顺序跟着迁移走：v6 建表 → v8 追加 kind/stage_due_at/stage_due_notified_at
  // → v11 追加 courier → v13 追加 description。
  // 顺序本身不影响正确性（列名是显式写出来的），但按迁移顺序排便于日后对照。
  columns: [
    "id", "no", "title", "flow_id", "stage_id", "note", "important", "my_day",
    "start_date", "due_date", "completed_at", "sort_order", "deleted",
    "created_at", "updated_at",
    "kind", "stage_due_at", "stage_due_notified_at", "courier", "description",
  ],
  paramsOf: (r: never) => {
    const x = r as OrdersPayload["workOrders"][number];
    return [
      x.id, str(x.no), str(x.title), str(x.flowId), str(x.stageId), str(x.note),
      bit(x.important), bit(x.myDay), x.startDate ?? null, x.dueDate ?? null,
      x.completedAt ?? null, x.sortOrder ?? 0, bit(x.deleted), str(x.createdAt),
      str(x.updatedAt),
      x.kind === "special" ? "special" : "normal",
      x.stageDueAt ?? null, str(x.stageDueNotifiedAt),
      str(x.courier), str(x.description),
    ];
  },
};

const W_FIELDS: TableWrite = {
  table: "core_wo_fields",
  columns: ["id", "wo_id", "label", "value", "sort_order", "deleted", "created_at", "updated_at"],
  paramsOf: (r: never) => {
    const x = r as OrdersPayload["woFields"][number];
    return [
      x.id, str(x.woId), str(x.label), str(x.value), x.sortOrder ?? 0,
      bit(x.deleted), str(x.createdAt), str(x.updatedAt),
    ];
  },
};

const W_GALLERY: TableWrite = {
  table: "core_gallery_items",
  columns: [
    "id", "title", "kind", "rel_path", "source_url", "mime", "size_bytes", "hash",
    "width", "height", "duration_ms", "origin", "prompt", "note", "deleted",
    "created_at", "updated_at",
  ],
  paramsOf: (r: never) => {
    const x = r as GalleryPayload["items"][number];
    return [
      x.id, str(x.title), x.kind === "video" ? "video" : "image", x.relPath,
      x.sourceUrl ?? null, str(x.mime), x.size ?? null, x.hash ?? null,
      x.width ?? null, x.height ?? null, x.durationMs ?? null,
      str(x.origin, "manual"), str(x.prompt), str(x.note), bit(x.deleted),
      str(x.createdAt), str(x.updatedAt),
    ];
  },
};

const W_ATTACH: TableWrite = {
  table: "core_wo_attachments",
  columns: [
    "id", "wo_id", "kind", "title", "rel_path", "source_url", "mime", "size_bytes",
    "hash", "width", "height", "duration_ms", "note", "sort_order", "deleted",
    "created_at", "updated_at",
  ],
  paramsOf: (r: never) => {
    const x = r as AttachmentsPayload["items"][number];
    return [
      x.id, str(x.woId), str(x.kind, "link"), str(x.title), x.relPath ?? null,
      x.sourceUrl ?? null, str(x.mime), x.size ?? null, x.hash ?? null,
      x.width ?? null, x.height ?? null, x.durationMs ?? null, str(x.note),
      x.sortOrder ?? 0, bit(x.deleted), str(x.createdAt), str(x.updatedAt),
    ];
  },
};

/* ------------------------------ 分片写回 ------------------------------ */

export async function applyTasksPayload(p: TasksPayload): Promise<void> {
  await upsertAll(W_LISTS, p.lists ?? []);
  await upsertAll(W_TASKS, p.tasks ?? []);
  await upsertAll(W_LINKS, p.links ?? []);

  // 子任务要**整组替换**：它是硬删除、没有墓碑，所以"某条子任务被删掉了"
  // 这件事在数据里没有别的表达方式 —— 只能靠"父任务的子任务清单就是全部"。
  // core_steps 没有子表，删光重建是安全的。
  const steps: Array<Step & { taskId: string }> = [];
  for (const [taskId, list] of Object.entries(p.steps ?? {})) {
    for (const s of list ?? []) steps.push({ ...s, taskId: s.taskId || taskId });
  }
  await replaceAll("core_steps", W_STEPS, steps);
}

export async function applyOrdersPayload(p: OrdersPayload): Promise<void> {
  await upsertAll(W_FLOWS, p.flows ?? []);
  await upsertAll(W_ORDERS, p.workOrders ?? []);
  await upsertAll(W_FIELDS, p.woFields ?? []);

  // 过程态同理整组替换（硬删除、无墓碑）
  const stages: WorkStage[] = [];
  for (const [flowId, list] of Object.entries(p.stages ?? {})) {
    for (const s of list ?? []) stages.push({ ...s, flowId: s.flowId || flowId });
  }
  await replaceAll("core_wo_stages", W_STAGES, stages);

  // 流转记录是追加型的：按 wo_id 顺序重排 seq（同 importBackup 的约定）
  const logs = p.woLogs ?? [];
  const seq = new Map<string, number>();
  const statements: Array<{ sql: string; params?: Param[] }> = [];
  const existing = new Set(
    (await db().select<{ id: string }>(`SELECT id FROM core_wo_logs`)).map((r) => r.id),
  );
  for (const l of logs) {
    const n = seq.get(l.woId) ?? 0;
    seq.set(l.woId, n + 1);
    const values: Param[] = [
      l.id, str(l.woId), l.fromStage ?? null, str(l.toStage), str(l.at), str(l.note), n,
    ];
    statements.push(
      existing.has(l.id)
        ? {
            sql: `UPDATE core_wo_logs SET wo_id = ?, from_stage = ?, to_stage = ?, at = ?, note = ?, seq = ?
                  WHERE id = ?`,
            params: [...values.filter((_, i) => i !== 0), l.id] as Param[],
          }
        : {
            sql: `INSERT INTO core_wo_logs (id, wo_id, from_stage, to_stage, at, note, seq)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            params: values,
          },
    );
  }
  if (statements.length) await db().transaction(statements);
}

export async function applyGalleryPayload(p: GalleryPayload): Promise<void> {
  await upsertAll(W_GALLERY, p.items ?? []);
}

export async function applyAttachmentsPayload(p: AttachmentsPayload): Promise<void> {
  await upsertAll(W_ATTACH, p.items ?? []);
}

/** 按分片写回。**只碰这个分片自己的表** —— 所以只勾「待办」时，
 *  流程任务、图库、附件在本地一行都不会被动到。 */
export async function applyShardPayload(
  shard: SyncShardId,
  payload: ShardPayload,
): Promise<void> {
  switch (shard) {
    case "tasks":
      return applyTasksPayload(payload as TasksPayload);
    case "orders":
      return applyOrdersPayload(payload as OrdersPayload);
    case "gallery":
      return applyGalleryPayload(payload as GalleryPayload);
    case "attachments":
      return applyAttachmentsPayload(payload as AttachmentsPayload);
  }
}
