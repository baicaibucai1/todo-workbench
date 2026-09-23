/**
 * 到点提醒卡片。
 *
 * 系统通知有可能被拒（浏览器策略、系统专注模式），所以应用内永远有一份兜底：
 * 右下角浮出卡片，能直接完成、推迟或跳到任务详情。
 *
 * 这里挂着两种提醒，共用同一个"别打扰我"开关，但**动作不同**：
 * - 待办提醒：可以完成、可以推迟 N 分钟（remindAt 是可改的）
 * - 流程任务时效：只能"知道了"或去处理。时效没有"推迟 10 分钟"这回事 ——
 *   它由过程态决定，要改就改期或推进（见 OrderDetail）。所以两边的按钮长得不一样，
 *   这也是它们没有合并成一个队列的原因。
 */

import { Bell, Check, Clock3, Timer, X } from "lucide-react";
import { useStore } from "../store";
import { SETTINGS } from "../lib/settings";
import { humanDuration } from "../lib/due";

export default function ReminderToast() {
  const {
    reminders,
    orderDues,
    settings,
    dismissReminder,
    snoozeReminder,
    dismissOrderDue,
    toggleDone,
    openTask,
    openOrder,
    setView,
  } = useStore();

  if (!reminders.length && !orderDues.length) return null;
  const snoozeMinutes = Number(settings[SETTINGS.reminderSnooze] ?? 10) || 10;
  const now = Date.now();

  /** 从提醒卡跳到那张流程任务：先切到看得见它的视图，再选中它 */
  const gotoOrder = async (orderId: string, kind: "normal" | "special") => {
    await setView(kind === "special" ? "special" : "orders");
    openOrder(orderId);
    void dismissOrderDue(orderId);
  };

  return (
    <div
      data-reminder-stack=""
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[320px] flex-col gap-2"
    >
      {/* 时效类摆在上面：它是"等不起"的那一类，压在待办提醒下面是本末倒置 */}
      {orderDues.map((a) => {
        const rem = new Date(a.dueAt).getTime() - now;
        const remText = Number.isNaN(rem)
          ? ""
          : rem <= 0
            ? `已超 ${humanDuration(-rem)}`
            : `还剩 ${humanDuration(rem)}`;
        const overdue = a.level === "overdue";
        // 临期和逾期同一套红（语义令牌，深浅主题各取各的值）：
        // 卡片浮出来的那一刻就说明"要命了"，琥珀色的"预警"在这里是噪音。
        // overdue 只加粗标题 —— 时间的轻重让文字（已超/还剩）说。
        const accent = "var(--color-danger)";
        const accentSoft = "var(--color-danger-soft)";
        return (
          <div
            key={`${a.orderId}:${a.level}`}
            data-order-due-card={a.orderId}
            data-order-due-level={a.level}
            className="pointer-events-auto animate-toast-in rounded-lg border border-line bg-card p-3 shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
          >
            <div className="flex items-start gap-2">
              <span
                className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full"
                style={{ background: accentSoft }}
              >
                <Timer size={13} style={{ color: accent }} />
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className="flex items-center gap-1 text-[11px]"
                  style={{ color: accent, fontWeight: overdue ? 700 : 500 }}
                >
                  <Clock3 size={10} />
                  {overdue ? "已超时" : "即将超时"}
                  {remText && <span className="text-fg-dim">· {remText}</span>}
                </div>
                <div className="truncate text-[13.5px] font-medium text-fg">
                  {a.title || a.no || "特殊单号"}
                </div>
                {a.no && a.title !== a.no && (
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-dim">{a.no}</div>
                )}
              </div>
              <button
                onClick={() => void dismissOrderDue(a.orderId)}
                title="知道了"
                data-act="order-due-dismiss"
                className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover"
              >
                <X size={13} />
              </button>
            </div>

            <div className="mt-2.5 flex gap-1.5">
              <button
                onClick={() => void gotoOrder(a.orderId, a.kind)}
                data-act="order-due-open"
                className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[12.5px] text-white hover:opacity-90"
                style={{ background: accent }}
              >
                <Check size={13} />
                去处理
              </button>
              <button
                onClick={() => void dismissOrderDue(a.orderId)}
                data-act="order-due-later"
                className="flex-1 rounded-md border border-line px-2 py-1.5 text-[12.5px] text-fg-3 hover:bg-hover"
              >
                稍后再说
              </button>
            </div>
          </div>
        );
      })}

      {reminders.map((task) => (
        <div
          key={task.id}
          data-reminder={task.id}
          className="pointer-events-auto animate-toast-in rounded-lg border border-line bg-card p-3 shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[#d4537e]/12">
              <Bell size={13} className="text-[#d4537e]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-[11px] text-fg-dim">
                <Clock3 size={10} />
                该做这件事了
              </div>
              <div className="truncate text-[13.5px] font-medium text-fg">{task.title}</div>
              {task.dueDate && (
                <div className="mt-0.5 text-[11.5px] text-fg-dim">截止 {task.dueDate}</div>
              )}
            </div>
            <button
              onClick={() => void dismissReminder(task.id)}
              title="知道了"
              className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover"
            >
              <X size={13} />
            </button>
          </div>

          <div className="mt-2.5 flex gap-1.5">
            <button
              onClick={() => {
                void toggleDone(task);
                void dismissReminder(task.id);
              }}
              data-act="reminder-done"
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-[#378add] px-2 py-1.5 text-[12.5px] text-white hover:opacity-90"
            >
              <Check size={13} />
              完成
            </button>
            <button
              onClick={() => void snoozeReminder(task.id, snoozeMinutes)}
              data-act="reminder-snooze"
              className="flex-1 rounded-md border border-line px-2 py-1.5 text-[12.5px] text-fg-3 hover:bg-hover"
            >
              {snoozeMinutes} 分钟后再提醒
            </button>
            <button
              onClick={() => {
                openTask(task.id);
                void dismissReminder(task.id);
              }}
              data-act="reminder-open"
              className="rounded-md border border-line px-2 py-1.5 text-[12.5px] text-fg-3 hover:bg-hover"
            >
              查看
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
