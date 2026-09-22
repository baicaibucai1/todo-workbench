import { useEffect, useMemo, useState } from "react";
import { Flame, Settings2, Timer, Circle, ListChecks } from "lucide-react";
import { useStore } from "../store";
import { collectUrgent, deadlineText, type UrgentEntry } from "../lib/urgent";
import { SETTINGS, parseUrgentMinutes } from "../lib/settings";
import { humanDuration } from "../lib/due";

/**
 * 左侧底部的紧急区。
 *
 * 它取代了原来的计划表：计划表是"用户自己排今天的顺序"，
 * 而用户在真正赶时间的时候需要的是另一件事 —— **哪几件快到点了**。
 * 顺序只能人定，但"还剩多久"是数据里就有的，不该让人再排一遍。
 *
 * 判定与排序全在 lib/urgent.ts，这里只负责显示与刷新节奏：
 * 每 30 秒重算一次（见 TICK_MS），因为"还剩多久"每一分钟都在变 ——
 * 少了这个 tick，一件刚刚跨过阈值的事要等到下次数据刷新才会出现，
 * 而那可能是一个小时以后的事。
 */

/** 重算间隔。30 秒而不是 1 分钟：跨过阈值的瞬间最多晚半分钟露面 */
const TICK_MS = 30_000;

/** 区里最多摆几条。再多是摆不下，不是不紧急 —— 所以末尾给「还有 N 条」 */
const MAX_ROWS = 8;

export default function UrgentPanel() {
  const {
    urgentTasks,
    urgentOrders,
    stepsByTask,
    stages,
    settings,
    openUrgent,
    activeTaskId,
    activeOrderId,
    openSettings,
  } = useStore();

  const minutes = parseUrgentMinutes(settings[SETTINGS.urgentMinutes]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // 子任务也参与紧急判定：一条待办挂着 5 个子任务，其中"三点前把图发出去"
  // 才是真正卡点的事 —— 只按待办自己的到期日算，这一步没人提醒。
  const all = useMemo(
    () =>
      collectUrgent(
        urgentTasks,
        urgentOrders,
        { thresholdMinutes: minutes, nowMs },
        stepsByTask,
      ),
    [urgentTasks, urgentOrders, stepsByTask, minutes, nowMs],
  );

  const rows = all.slice(0, MAX_ROWS);
  const hidden = all.length - rows.length;
  const overdueCount = all.filter((e) => e.overdue).length;

  return (
    <div className="shrink-0 border-t border-line" data-urgent-panel="" data-urgent-threshold={minutes}>
      <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-1.5">
        <Flame size={13} className={`shrink-0 ${overdueCount ? "text-danger" : "text-fg-dim"}`} />
        <span className="text-[11px] font-medium tracking-wide text-fg-dim">紧急</span>
        {all.length > 0 && (
          <span
            data-urgent-count=""
            className={`rounded px-1.5 py-px text-[10px] ${
              overdueCount ? "bg-danger-soft text-danger" : "bg-chip text-fg-dim"
            }`}
          >
            {all.length}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-fg-dim">{humanDuration(minutes * 60_000)}内</span>
        <button
          onClick={() => openSettings(true)}
          data-urgent-settings=""
          title="在设置里调整紧急阈值"
          className="grid size-5 place-items-center rounded text-fg-dim hover:bg-hover"
        >
          <Settings2 size={12} />
        </button>
      </div>

      <div className="max-h-[186px] overflow-y-auto px-2 pb-2">
        {all.length === 0 ? (
          <div data-urgent-empty="" className="px-2 py-3 text-[11.5px] leading-relaxed text-fg-dim">
            接下来 <span className="text-fg-3">{humanDuration(minutes * 60_000)}</span>{" "}
            内没有要到期的待办、子任务或工单。想更早收到提醒，到设置里把这个时间调长。
          </div>
        ) : (
          <>
            {rows.map((e) => {
              // 子任务点的是**它所属的待办**：它没有自己的详情页，
              // 而"打开父任务"正是看到全部子任务的唯一入口
              const openId = e.kind === "subtask" ? (e.parent?.id ?? "") : e.id;
              const openKind = e.kind === "order" ? "order" : "task";
              return (
                <UrgentRow
                  key={`${e.kind}:${e.id}`}
                  entry={e}
                  stageName={stageNameOf(e, urgentOrders, stages)}
                  stageColor={stageColorOf(e, urgentOrders, stages)}
                  parentTitle={e.parent?.title}
                  active={
                    e.kind === "task"
                      ? activeTaskId === e.id
                      : e.kind === "order"
                        ? activeOrderId === e.id
                        : activeTaskId === e.parent?.id
                  }
                  // 走 openUrgent 而不是 openTask/openOrder：紧急区扫的是全库，
                  // 这条可能根本不在当前视图里（见 store.openUrgent）
                  onOpen={() => void openUrgent(openKind, openId)}
                />
              );
            })}
            {hidden > 0 && (
              <div data-urgent-more="" className="px-2 pt-1 pb-0.5 text-[10.5px] text-fg-dim">
                还有 {hidden} 条同样临近
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 工单当前过程态的名字；待办返回 undefined */
function stageNameOf(
  e: UrgentEntry,
  orders: Array<{ id: string; stageId: string }>,
  stages: Array<{ id: string; name: string }>,
): string | undefined {
  if (e.kind !== "order") return undefined;
  const o = orders.find((x) => x.id === e.id);
  if (!o) return undefined;
  return stages.find((s) => s.id === o.stageId)?.name;
}

function stageColorOf(
  e: UrgentEntry,
  orders: Array<{ id: string; stageId: string }>,
  stages: Array<{ id: string; color: string }>,
): string | undefined {
  if (e.kind !== "order") return undefined;
  const o = orders.find((x) => x.id === e.id);
  if (!o) return undefined;
  return stages.find((s) => s.id === o.stageId)?.color;
}

/**
 * 一行紧急条目。
 *
 * 信息来源写在 title 里（截止时刻 + 是提醒时间还是交付日）：
 * 同一条待办"为什么算紧急"可能有两解，看的人第一次总会对不上自己的预期，
 * 悬停一句话说清楚，比让他去猜代价小得多。
 */
function UrgentRow({
  entry,
  stageName,
  stageColor,
  parentTitle,
  active,
  onOpen,
}: {
  entry: UrgentEntry;
  stageName?: string;
  stageColor?: string;
  /** 子任务所属待办的标题 */
  parentTitle?: string;
  active: boolean;
  onOpen: () => void;
}) {
  const sourceText =
    entry.source === "remind"
      ? "提醒时间"
      : entry.source === "stage"
        ? "当前步骤时效"
        : entry.source === "subtask"
          ? "子任务到期时间"
          : "到期日";

  return (
    <div
      data-urgent-item={`${entry.kind}:${entry.id}`}
      data-urgent-state={entry.overdue ? "overdue" : "soon"}
      data-urgent-remain={entry.remainText}
      onClick={onOpen}
      title={`${sourceText} ${deadlineText(entry.atMs)}`}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 ${
        active ? "bg-chip" : "hover:bg-hover"
      }`}
    >
      {/* 类型标记：待办是圆、工单是方（带过程态颜色）、子任务是清单图标，
          与主列表同一套视觉语言 —— 不用读字就能分开 */}
      {entry.kind === "order" ? (
        <span
          className="block size-3 shrink-0 rounded-[3px] border-[1.5px]"
          style={{ borderColor: stageColor ?? "#888780" }}
        />
      ) : entry.kind === "subtask" ? (
        <span
          data-urgent-kind="subtask"
          className="grid size-3 shrink-0 place-items-center"
        >
          <ListChecks size={12} className="text-fg-dim" />
        </span>
      ) : (
        <span
          data-urgent-kind="task"
          className="grid size-3 shrink-0 place-items-center"
        >
          <Circle size={11} className="text-fg-dim" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-fg-2">
          {entry.no ? (
            <span className="mr-1 font-mono text-[11px] text-fg-dim">{entry.no}</span>
          ) : null}
          {entry.title || "（无标题）"}
        </div>
        {stageName && (
          <div className="truncate text-[10.5px]" style={{ color: stageColor }}>
            {stageName}
          </div>
        )}
        {/* 子任务必须带上它属于哪条待办，否则"把图发出去"是谁的图无从判断 */}
        {parentTitle && (
          <div data-urgent-parent="" className="truncate text-[10.5px] text-fg-dim">
            属于：{parentTitle}
          </div>
        )}
      </div>

      <span
        className={`flex shrink-0 items-center gap-0.5 text-[10.5px] ${
          entry.overdue ? "font-medium text-danger" : "text-accent"
        }`}
      >
        {entry.overdue ? <Flame size={9} /> : <Timer size={9} />}
        {entry.remainText}
      </span>
    </div>
  );
}
