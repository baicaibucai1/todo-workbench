/**
 * 处理时效的计算与格式化。
 *
 * 为什么单独一个文件：同一件事有三个地方要给出**一致**的答案 ——
 * 列表行上的胶囊、详情面板里的时效区、提醒扫描的档位判断。
 * 各写一遍的下场是"列表说还剩 5 分钟、提醒说还没到时候"，
 * 而这种不一致没有任何自动检查能拦住。
 *
 * 时效的语义是"到下一步之前还剩多久"，所以它挂在**当前过程态**上，
 * 随着推进被重设（见 repo.moveOrderToStage）。
 */

import { DUE_SOON_MINUTES } from "./repo";
import type { WorkOrder } from "../types";

/**
 * 时效状态。
 *
 * - none    这一步没设时效（普通工单，或推到了没默认时效的步骤）
 * - ok      还早
 * - soon    进入临期窗口（还剩 DUE_SOON_MINUTES 以内）
 * - overdue 已经过点
 */
export type DueState = "none" | "ok" | "soon" | "overdue";

export function dueState(order: WorkOrder, nowMs = Date.now()): DueState {
  if (!order.stageDueAt) return "none";
  const at = new Date(order.stageDueAt).getTime();
  if (Number.isNaN(at)) return "none";
  // 已完结的单子不再"等不起"，哪怕时间已经过了 ——
  // 否则「已完成」分组里会整片标红，看着像出了一堆事故
  if (order.closed) return "ok";
  if (at <= nowMs) return "overdue";
  return at - nowMs <= DUE_SOON_MINUTES * 60_000 ? "soon" : "ok";
}

/** 距截止还剩多少毫秒（负数表示已超）。没设时效返回 null。 */
export function remainingMs(order: WorkOrder, nowMs = Date.now()): number | null {
  if (!order.stageDueAt) return null;
  const at = new Date(order.stageDueAt).getTime();
  if (Number.isNaN(at)) return null;
  return at - nowMs;
}

/** 时长的人话：「2 小时 15 分」「40 分钟」「1 天 3 小时」 */
export function humanDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
}

/** 「还剩 2 小时」/「已超 40 分钟」。没设时效返回 null。 */
export function dueText(order: WorkOrder, nowMs = Date.now()): string | null {
  const rem = remainingMs(order, nowMs);
  if (rem === null) return null;
  return rem <= 0 ? `已超 ${humanDuration(-rem)}` : `还剩 ${humanDuration(rem)}`;
}

/** 「9月21日 14:30」，用于把时效说成一个确切的时刻 */
export function dueAtText(iso: string | null): string {
  if (!iso) return "未设时效";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未设时效";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** 某个基准日偏移几天后的某个钟点（本地时区）。过了点就顺延一天。 */
function atClock(baseMs: number, dayOffset: number, hour: number, minute: number): string {
  const d = new Date(baseMs);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  // "今天 18:00" 在 19:00 点下去，得到的会是一个已经过期的时刻 ——
  // 那等于一建单就逾期。顺延到明天才是用户点这个按钮的意思。
  if (d.getTime() <= baseMs) d.setDate(d.getDate() + 1);
  return iso(d.getTime());
}

/**
 * 建单 / 改期时的快捷时效。
 *
 * 存的永远是**绝对时刻**，"给多久"只是这里的输入方式：
 * 存时长的话还得再记一个起点，跨重启、"还剩多久"就算不清了。
 */
export interface DuePreset {
  label: string;
  at: (nowMs: number) => string;
}

export const DUE_PRESETS: DuePreset[] = [
  { label: "30 分钟", at: (t) => iso(t + 30 * 60_000) },
  { label: "1 小时", at: (t) => iso(t + 60 * 60_000) },
  { label: "2 小时", at: (t) => iso(t + 120 * 60_000) },
  { label: "4 小时", at: (t) => iso(t + 240 * 60_000) },
  { label: "今天 18:00", at: (t) => atClock(t, 0, 18, 0) },
  { label: "明天 10:00", at: (t) => atClock(t, 1, 10, 0) },
];

/** ISO → `<input type="datetime-local">` 需要的本地 "YYYY-MM-DDTHH:mm" */
export function toLocalInputValue(isoStr: string | null): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `<input type="datetime-local">` 的值 → ISO。空值返回 null。 */
export function fromLocalInputValue(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
