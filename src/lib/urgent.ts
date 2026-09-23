/**
 * 「紧急」的判定与排序。
 *
 * 侧边栏底部的紧急区要回答一个问题：**接下来哪几件事快到点了**。
 * 这件事必须由代码算出来，而不是像计划表那样让用户自己排 ——
 * 计划表解决的是"先做哪个"（顺序只能人定），紧急区解决的是"还剩多久"
 * （时间在数据里，人记不住）。
 *
 * 为什么单独一个文件：紧急条目的两个来源（待办、流程任务）**截止时间的字段不一样**
 * （待办是提醒时刻/计划日，流程任务是步骤时效/交付日），而且两处都要给出一致答案 ——
 * 侧边栏底部要列、将来主列表要在行上标。各写一遍必然漂移。
 */

import { humanDuration } from "./due";
import type { Step, Task, WorkOrder } from "../types";

/** 截止时间取自哪个字段，界面上要能说清"凭什么算它紧急" */
export type UrgentSource = "remind" | "due" | "stage" | "subtask";

export interface UrgentEntry {
  kind: "task" | "order" | "subtask";
  id: string;
  title: string;
  /** 截止时刻（毫秒时间戳） */
  atMs: number;
  /** 距截止还剩多少毫秒，负数表示已经过了点 */
  remainMs: number;
  /** 已经过了点 */
  overdue: boolean;
  /** 「还剩 2 小时」/「已超 40 分钟」 */
  remainText: string;
  /** 截止时间是靠哪个字段算出来的 */
  source: UrgentSource;
  /**
   * 流程任务单号（待办为 undefined）。
   *
   * 只有特殊单号有值 —— 那里它放的是快递单号。普通流程任务从 schema v13
   * 起不再编号（见 types.ts 的 WorkOrder.no），所以这里绝大多数时候是空的。
   */
  no?: string;
  /**
   * 子任务所属的待办。
   *
   * 光有子任务标题没法行动 —— "把图发出去"是谁的图？
   * 而且点它要跳到**父任务**的详情（子任务没有自己的详情页）。
   */
  parent?: { id: string; title: string };
}

/**
 * 某个本地日期的**最后一刻**（当天 23:59:59.999）。
 *
 * 只有日期没有钟点的时候用这个当截止：说"今天到期"的人，
 * 意思是今天下班前做完，不是今天零点就过期。
 * 也正因为如此，今天到期的一件事在早上不会出现在紧急区里 ——
 * 那是对的，它还不急。
 */
function dayEndMs(date: string | null): number | null {
  if (!date) return null;
  // 不带时区后缀的 "YYYY-MM-DDTHH:mm:ss" 由本地时区解析，
  // 与 dueDate（本地日期）同一套语义，不会差上半天
  const ms = new Date(`${date}T23:59:59`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

interface Deadline {
  atMs: number;
  source: UrgentSource;
}

/**
 * 待办的截止时间。
 *
 * 提醒时刻（remind_at）优先于计划日期（due_date）—— 提醒是用户**明确指定**的钟点，
 * 比"这一天的末尾"精确。但两者都取最小值：提醒设在交付日之后也没道理让它更晚。
 *
 * 都没有截止时间返回 null：没有时间信息的待办永远不该出现在紧急区里，
 * 否则"紧急"就变成了"重要"，那是另一个入口的事。
 */
export function taskDeadline(t: Task): Deadline | null {
  const remind = isoMs(t.remindAt);
  const due = dayEndMs(t.dueDate);
  if (remind === null && due === null) return null;
  if (remind === null) return { atMs: due as number, source: "due" };
  if (due === null) return { atMs: remind, source: "remind" };
  return remind <= due
    ? { atMs: remind, source: "remind" }
    : { atMs: due, source: "due" };
}

/**
 * 流程任务的截止时间。
 *
 * 步骤时效（stage_due_at）是**当前这一步**的到期时刻，比交付日更近、
 * 也更要紧 —— 一张单子交付日在下个月，但当前这步 20 分钟后就超时，
 * 它现在就是最紧急的那件。所以同理取两者更早的。
 */
export function orderDeadline(o: WorkOrder): Deadline | null {
  const stage = isoMs(o.stageDueAt);
  const due = dayEndMs(o.dueDate);
  if (stage === null && due === null) return null;
  if (stage === null) return { atMs: due as number, source: "due" };
  if (due === null) return { atMs: stage, source: "stage" };
  return stage <= due
    ? { atMs: stage, source: "stage" }
    : { atMs: due, source: "due" };
}

export interface UrgentQuery {
  /** 剩余时间小于这个值才算紧急（分钟） */
  thresholdMinutes: number;
  nowMs?: number;
  /** 最多返回几条。区里空间有限，多出来的不是"不紧急"，只是摆不下 */
  limit?: number;
}

/**
 * 收集紧急条目：待办、子任务与流程任务混在一起，按截止时刻升序。
 *
 * 逾期（remainMs < 0）天然排在最前 —— 它比任何"还剩一点"的都急，
 * 而且按截止时刻升序时，逾最久的排第一，正好是"欠得最多的先处理"。
 *
 * 完成的待办/子任务与已完结的流程任务一律排除：勾掉的东西还标红，
 * 会让人以为有一堆事没处理。
 *
 * stepsByTask 传进来的**父任务必须在 tasks 里**：子任务不单独存在，
 * 父任务已经完成或删除时，它的子任务再急也没意义（找都找不到）。
 */
export function collectUrgent(
  tasks: Task[],
  orders: WorkOrder[],
  q: UrgentQuery,
  stepsByTask: Record<string, Step[]> = {},
): UrgentEntry[] {
  const nowMs = q.nowMs ?? Date.now();
  const window = Math.max(0, q.thresholdMinutes) * 60_000;
  const out: UrgentEntry[] = [];

  for (const t of tasks) {
    if (t.deleted || t.done) continue;
    const d = taskDeadline(t);
    if (!d) continue;
    const remainMs = d.atMs - nowMs;
    if (remainMs > window) continue;
    out.push({
      kind: "task",
      id: t.id,
      title: t.title,
      atMs: d.atMs,
      remainMs,
      overdue: remainMs < 0,
      remainText: remainMs < 0 ? `已超 ${humanDuration(-remainMs)}` : `还剩 ${humanDuration(remainMs)}`,
      source: d.source,
    });
  }

  // 子任务：它自己的到期时刻（due_at）说了算。
  //
  // 为什么不继承父任务的截止时间：那会让"待办 9 点到期"连带把 7 条子任务
  // 全部塞进紧急区，区里立刻被同一件事占满。子任务只有**自己**设了时间才算
  // —— 设时间这个动作本身就是"这一步要紧"的表达。
  const parentById = new Map(tasks.map((t) => [t.id, t]));
  for (const [taskId, list] of Object.entries(stepsByTask)) {
    const parent = parentById.get(taskId);
    if (!parent || parent.deleted || parent.done) continue;
    for (const s of list ?? []) {
      if (s.done || !s.dueAt) continue;
      const atMs = isoMs(s.dueAt);
      if (atMs === null) continue;
      const remainMs = atMs - nowMs;
      if (remainMs > window) continue;
      out.push({
        kind: "subtask",
        id: s.id,
        title: s.title,
        atMs,
        remainMs,
        overdue: remainMs < 0,
        remainText: remainTextOf(remainMs),
        source: "subtask",
        parent: { id: parent.id, title: parent.title },
      });
    }
  }

  for (const o of orders) {
    if (o.deleted || o.closed) continue;
    const d = orderDeadline(o);
    if (!d) continue;
    const remainMs = d.atMs - nowMs;
    if (remainMs > window) continue;
    out.push({
      kind: "order",
      id: o.id,
      title: o.title,
      atMs: d.atMs,
      remainMs,
      overdue: remainMs < 0,
      remainText: remainMs < 0 ? `已超 ${humanDuration(-remainMs)}` : `还剩 ${humanDuration(remainMs)}`,
      source: d.source,
      no: o.no || undefined,
    });
  }

  out.sort((a, b) => a.atMs - b.atMs);
  return q.limit && q.limit > 0 ? out.slice(0, q.limit) : out;
}

/** 截止时间的人话，用于标题（hover）与行尾小字：「9月21日 14:30」 */
export function deadlineText(atMs: number): string {
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 剩余时间的人话（不带「还剩/已超」前缀），给只需要时长的调用点用 */
export function remainTextOf(remainMs: number): string {
  return remainMs < 0 ? `已超 ${humanDuration(-remainMs)}` : `还剩 ${humanDuration(remainMs)}`;
}
