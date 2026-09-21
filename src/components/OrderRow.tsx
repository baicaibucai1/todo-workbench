import { useState } from "react";
import {
  Star,
  Trash2,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardList,
  Paperclip,
  Play,
  Timer,
} from "lucide-react";
import type { WorkOrder } from "../types";
import { today, addDays } from "../lib/repo";
import { dueState, dueText, humanDuration, dueAtText } from "../lib/due";
import { useStore } from "../store";

interface Props {
  order: WorkOrder;
  first?: boolean;
  /** 该行是否正被右侧详情面板查看 */
  active?: boolean;
  /** 是否显示计划日期标记 */
  showDate?: boolean;
  onOpen: () => void;
  onAdvance: (stageId: string) => void;
  onToggleImportant: () => void;
  onDelete: () => void;
}

/** 短日期展示：今天 / 明天 / 昨天 / M月D日 */
function shortDate(dateStr: string): string {
  const t = today();
  if (dateStr === t) return "今天";
  if (dateStr === addDays(t, 1)) return "明天";
  if (dateStr === addDays(t, -1)) return "昨天";
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

/**
 * 工单行。
 *
 * 和待办行并排混在同一条列表里，所以**必须一眼能区分**：
 * 待办的圈是圆的，工单是圆角方块；待办没有色块，工单左边压着一条当前过程态的颜色。
 * 这两点比加一个「工单」文字标签有效得多 —— 扫一眼就能分开，不用读字。
 */
export default function OrderRow({
  order,
  first,
  active,
  showDate,
  onOpen,
  onAdvance,
  onToggleImportant,
  onDelete,
}: Props) {
  const [advancing, setAdvancing] = useState(false);

  const { stages, flows, woAttachmentCounts } = useStore();
  const flow = flows.find((f) => f.id === order.flowId);
  const stage = stages.find((s) => s.id === order.stageId);
  const attachCount = woAttachmentCounts[order.id] ?? 0;

  const flowStages = stages
    .filter((s) => s.flowId === order.flowId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = flowStages.findIndex((s) => s.id === order.stageId);
  // 只允许"往前走一步"：工单的过程态是有向的，随手跳到任意一步会让留痕失去意义。
  // 要退回请到详情面板里选，那是个显式动作。
  const next = idx >= 0 ? flowStages[idx + 1] : undefined;

  const color = stage?.color ?? "#888780";
  const dueLabel = order.dueDate ? shortDate(order.dueDate) : null;
  const overdue = !!order.dueDate && order.dueDate < today() && !order.closed;

  /** 特殊单号：带处理时效的那类。它和普通工单的区别全在下面那个时效胶囊上 */
  const isSpecial = order.kind === "special";
  const dueSt = dueState(order);
  // ⚠️ 临期（soon）也是红的，不只是逾期 —— 用户对"红"的预期就是
  // "这一单开始要命了"，还剩 20 分钟和已经超了 10 分钟在动作上没有区别：
  // 都是"放下手头的事先处理它"。琥珀色的"预警"在真正的紧急面前是噪音。
  // overdue 在同色的基础上加粗：一眼分轻重，文字内容（已超/还剩）再确认一遍。
  // 走语义令牌而不是裸 hex：深浅两套主题各取各的值（见 styles.css）。
  const dueStyle: Record<typeof dueSt, { color: string; background: string; fontWeight?: number }> = {
    overdue: { color: "var(--color-danger)", background: "var(--color-danger-soft)", fontWeight: 700 },
    soon: { color: "var(--color-danger)", background: "var(--color-danger-soft)" },
    ok: { color: "#5a5955", background: "rgba(0,0,0,.055)" },
    none: { color: "#8a8985", background: "rgba(0,0,0,.055)" },
  };

  return (
    <div
      data-order-id={order.id}
      data-order-kind={order.kind}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onOpen();
      }}
      className={`group relative flex cursor-pointer items-start gap-3 px-3.5 py-2.5 transition-colors ${
        active ? "bg-chip" : "hover:bg-hover"
      } ${first ? "" : "border-t border-line"}`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />}

      {/* 过程态标记：圆角方块 + 当前阶段色，和待办的圆形勾选圈形成对照 */}
      <button
        onClick={() => next && onAdvance(next.id)}
        disabled={!next}
        title={
          next
            ? `推进到「${next.name}」（流程：${flow?.name ?? "未知"}）`
            : order.closed
              ? "已是最后一步"
              : "没有下一步了"
        }
        data-order-stage-toggle=""
        className={`mt-[1px] grid size-[19px] shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors ${
          next ? "hover:brightness-95" : "cursor-default"
        }`}
        style={{
          borderColor: color,
          background: order.closed ? color : "transparent",
        }}
      >
        {order.closed ? (
          <Check size={12} className="text-white" strokeWidth={3} />
        ) : (
          <span className="block size-[7px] rounded-[2px]" style={{ background: color }} />
        )}
      </button>

      <div className="min-w-0 flex-1 pt-[1px]">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* 单号用等宽字体，和标题拉开层次；它是"对账用的标识"不是内容 */}
          {order.no && (
            <span
              data-order-no={order.no}
              className="shrink-0 rounded bg-chip px-1.5 py-px font-mono text-[10.5px] text-fg-3"
            >
              {order.no}
            </span>
          )}
          <span
            data-order-title=""
            className={`truncate text-[14px] leading-[19px] ${
              order.closed ? "text-fg-dim line-through" : "text-fg"
            }`}
          >
            {order.title}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* 当前过程态：这是工单行最该被看到的信息 */}
          <span
            data-order-stage={stage?.name ?? ""}
            className="flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium"
            style={{ color, background: `${color}1f` }}
          >
            <span className="block size-1.5 rounded-full" style={{ background: color }} />
            {stage?.name ?? "未知阶段"}
          </span>

          <span className="flex items-center gap-1 text-[11.5px] text-fg-dim">
            <ClipboardList size={11} />
            {flow?.name ?? "未知流程"}
          </span>

          {/* 处理时效：特殊单号的**核心信息**，紧跟在过程态后面。
              没设时效时也显示（灰的"未设时效"）—— 直接不显示的话，
              这张单看起来就和普通工单一模一样，用户不会知道漏填了。

              普通工单也显示，只要它真的挂着时效：生效的是**流程那一步的默认时长**，
              不是单据类型。既然它会计时、会提醒，列表上就必须看得见 ——
              否则会出现"提醒弹出来，可列表里找不到它凭什么提醒"。 */}
          {(isSpecial || !!order.stageDueAt) && (
            <span
              data-order-due={dueSt}
              data-order-due-at={order.stageDueAt ?? ""}
              title={
                order.stageDueAt
                  ? `这一步的时效到 ${dueAtText(order.stageDueAt)}`
                  : "这一步还没设时效"
              }
              className="flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium"
              style={dueStyle[dueSt]}
            >
              <Timer size={11} />
              {dueSt === "none" ? "未设时效" : dueText(order)}
            </span>
          )}

          {/* 有附件才显示：空的时候挂一个「0」只会是噪音 */}
          {attachCount > 0 && (
            <span
              data-order-attach-count={attachCount}
              className="flex items-center gap-1 text-[11.5px] text-fg-dim"
            >
              <Paperclip size={11} />
              {attachCount}
            </span>
          )}

          {order.startDate && (
            <span className="flex items-center gap-1 text-[11.5px] text-fg-dim">
              <Play size={11} />
              {shortDate(order.startDate)}
            </span>
          )}

          {showDate && dueLabel && (
            <span
              className={`flex items-center gap-1 text-[11.5px] ${
                overdue ? "text-danger" : "text-fg-dim"
              }`}
            >
              <CalendarDays size={11} />
              交付 {dueLabel}
              {overdue && " · 已逾期"}
            </span>
          )}

        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 pt-[1px]">
        {/* 推进到下一步：工单最常用的动作，直接放在行上 */}
        {next && (
          <button
            // 推进会把这一步的时效按新步骤的默认值重设，所以直接写清楚
            // "推过去之后还剩多久" —— 否则用户点完才发现时效变了
            title={
              next.defaultMinutes > 0
                ? `推进到「${next.name}」（时效续 ${humanDuration(next.defaultMinutes * 60_000)}）`
                : `推进到「${next.name}」`
            }
            onClick={() => {
              setAdvancing(true);
              onAdvance(next.id);
            }}
            data-order-advance=""
            className={`flex items-center gap-0.5 rounded px-1.5 py-1 text-[11.5px] transition-opacity hover:bg-hover ${
              advancing ? "opacity-40" : "opacity-0 group-hover:opacity-100"
            }`}
            style={{ color }}
          >
            <ChevronRight size={13} />
            {next.name}
          </button>
        )}

        <button
          title={order.important ? "取消重要" : "标记为重要"}
          onClick={onToggleImportant}
          className={`grid size-7 place-items-center rounded hover:bg-hover ${
            order.important ? "text-[#ba7517]" : "text-fg-dim opacity-0 group-hover:opacity-100"
          }`}
        >
          <Star size={15} fill={order.important ? "#ba7517" : "none"} />
        </button>

        <button
          title="删除工单"
          onClick={onDelete}
          className="grid size-7 place-items-center rounded text-fg-dim opacity-0 hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
