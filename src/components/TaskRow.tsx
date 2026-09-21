import { useEffect, useRef, useState } from "react";
import {
  Star,
  Sun,
  Trash2,
  CalendarDays,
  Check,
  X,
  Circle,
  Repeat,
  ListChecks,
} from "lucide-react";
import type { Step, Task } from "../types";
import { today, addDays } from "../lib/repo";
import { rowSurfaceClass } from "../lib/rowStyle";

interface Props {
  task: Task;
  accent: string;
  first?: boolean;
  /** 分组里的最后一行，用于兜住容器底部的圆角（见 lib/rowStyle） */
  last?: boolean;
  /** 上一行是被选中的 —— 这行就别再画分隔线了 */
  prevActive?: boolean;
  /** 是否显示计划日期标记 */
  showDate?: boolean;
  /** 该行是否正被右侧详情面板查看 */
  active?: boolean;
  onToggleDone: () => void;
  onToggleImportant: () => void;
  onToggleMyDay: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onSetDueDate: (date: string | null) => void;
  /** 点击行打开右侧详情 */
  onOpen: () => void;
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

export default function TaskRow({
  task,
  accent,
  first,
  last,
  prevActive,
  showDate,
  active,
  onToggleDone,
  onToggleImportant,
  onToggleMyDay,
  onDelete,
  onRename,
  onSetDueDate,
  onOpen,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.title);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 步骤进度：行上只给个 2/5，展开的步骤在详情面板里
  const steps = useTaskSteps(task.id);

  useEffect(() => {
    setText(task.title);
  }, [task.title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const overdue = !!task.dueDate && task.dueDate < today() && !task.done;

  const commit = () => {
    setEditing(false);
    if (text.trim() && text !== task.title) onRename(text);
    else setText(task.title);
  };

  return (
    <div
      data-task-id={task.id}
      // 选中态写进 dataset：它是"浮起来"，光靠底色分辨不出来，
      // 自动化（和以后的视觉回归）需要有个确定的读法
      data-active={active ? "true" : undefined}
      // 行内所有控件都是 button：点到它们时交给控件自己处理，别顺带打开详情
      onClick={(e) => {
        if (editing) return;
        if ((e.target as HTMLElement).closest("button")) return;
        onOpen();
      }}
      // 选中态是"整行抬起"（见 lib/rowStyle），transition 要连着阴影和位移一起
      className={`group relative flex cursor-pointer items-start gap-3 px-3.5 py-2.5 transition-[background-color,box-shadow,transform] duration-150 ${rowSurfaceClass(
        { active, first, last, prevActive },
      )}`}
    >
      {/* 完成勾选圈 */}
      <button
        onClick={onToggleDone}
        title={task.done ? "标记为未完成" : "标记为已完成"}
        className="mt-[1px] grid size-[19px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors"
        style={{
          borderColor: task.done ? "#b4b2a9" : accent,
          background: task.done ? "#b4b2a9" : "transparent",
        }}
      >
        {task.done ? (
          <Check size={12} className="text-white" strokeWidth={3} />
        ) : (
          <Circle
            size={9}
            strokeWidth={0}
            className="opacity-0 transition-opacity group-hover:opacity-40"
            style={{ fill: accent }}
          />
        )}
      </button>

      {/* 标题与备注 */}
      <div className="min-w-0 flex-1 pt-[1px]">
        {editing ? (
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setText(task.title);
                setEditing(false);
              }
            }}
            className="w-full rounded border border-[#d4537e] bg-card px-1 py-0.5 text-[14px] outline-none"
          />
        ) : (
          <div
            onDoubleClick={() => setEditing(true)}
            className={`cursor-default truncate text-[14px] leading-[19px] ${
              task.done ? "text-fg-dim line-through" : "text-fg"
            }`}
          >
            {task.title}
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* 所属列表名，与 To Do 一致 */}
          <ListBadge listId={task.listId} />

          {showDate && task.dueDate && (
            <span
              className={`flex items-center gap-1 text-[11.5px] ${
                overdue ? "text-danger" : "text-fg-dim"
              }`}
            >
              <CalendarDays size={11} />
              {shortDate(task.dueDate)}
              {overdue && " · 已过期"}
            </span>
          )}

          {task.myDay && (
            <span className="flex items-center gap-[3px] text-[11.5px] text-fg-dim">
              <Sun size={11} />
              我的一天
            </span>
          )}

          {task.repeat === "daily" && (
            <span
              data-repeat-badge=""
              className="flex items-center gap-[3px] text-[11.5px] text-fg-dim"
            >
              <Repeat size={11} />
              每日
            </span>
          )}

          {steps.length > 0 && (
            <span
              data-step-badge=""
              className="flex items-center gap-[3px] text-[11.5px] text-fg-dim"
            >
              <ListChecks size={11} />
              {steps.filter((s) => s.done).length}/{steps.length}
            </span>
          )}
        </div>
      </div>

      {/* 悬停操作区 */}
      <div className="flex shrink-0 items-center gap-0.5 pt-[1px]">
        <div
          className={`relative flex items-center gap-0.5 transition-opacity ${
            pickerOpen || task.dueDate ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <button
            title="添加截止日期"
            onClick={() => setPickerOpen((v) => !v)}
            className="grid size-7 place-items-center rounded text-fg-dim hover:bg-hover"
          >
            <CalendarDays size={15} />
          </button>
          {pickerOpen && (
            <DatePicker
              value={task.dueDate}
              onPick={(d) => {
                onSetDueDate(d);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        <button
          title={task.myDay ? "从我的一天移除" : "添加到我的一天"}
          onClick={onToggleMyDay}
          className={`grid size-7 place-items-center rounded hover:bg-hover ${
            task.myDay
              ? "text-[#d4537e]"
              : "text-fg-dim opacity-0 group-hover:opacity-100"
          }`}
        >
          <Sun size={15} />
        </button>

        <button
          title={task.important ? "取消重要" : "标记为重要"}
          onClick={onToggleImportant}
          className={`grid size-7 place-items-center rounded hover:bg-hover ${
            task.important
              ? "text-[#ba7517]"
              : "text-fg-dim opacity-0 group-hover:opacity-100"
          }`}
        >
          <Star size={15} fill={task.important ? "#ba7517" : "none"} />
        </button>

        <button
          title="删除任务"
          onClick={onDelete}
          className="grid size-7 place-items-center rounded text-fg-dim opacity-0 hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

/** 列表归属标签，颜色取自所属列表 */
function ListBadge({ listId }: { listId: string }) {
  const lists = useTaskListLookup();
  const list = lists[listId];
  if (!list) return null;
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-fg-dim">
      <span className="block size-2 rounded-full" style={{ background: list.color }} />
      {list.name}
    </span>
  );
}

/** 简易的列表查找缓存，避免每个任务行都去读 store */
import { useStore } from "../store";
function useTaskListLookup(): Record<string, { name: string; color: string }> {
  const lists = useStore((s) => s.lists);
  const out: Record<string, { name: string; color: string }> = {};
  for (const l of lists) out[l.id] = { name: l.name, color: l.color };
  return out;
}

const NO_STEPS: Step[] = [];

/** 取某条任务的步骤。没有时返回同一个空数组常量，避免每次渲染都造新引用 */
function useTaskSteps(taskId: string): Step[] {
  return useStore((s) => s.stepsByTask[taskId]) ?? NO_STEPS;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** 快速日期选择器：今天 / 明天 / 下周 / 自定义 */
function DatePicker({
  value,
  onPick,
  onClose,
}: {
  value: string | null;
  onPick: (d: string | null) => void;
  onClose: () => void;
}) {
  const t = today();
  const options: Array<{ label: string; date: string }> = [
    { label: "今天", date: t },
    { label: "明天", date: addDays(t, 1) },
    ...Array.from({ length: 5 }, (_, i) => {
      const d = addDays(t, i + 2);
      const dt = new Date(`${d}T00:00:00`);
      return { label: `${dt.getMonth() + 1}/${dt.getDate()} 周${WEEK[dt.getDay()]}`, date: d };
    }),
  ];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute top-8 right-0 z-50 w-[168px] overflow-hidden rounded-lg border border-line bg-card py-1 shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
        <div className="px-3 py-1 text-[11px] text-fg-dim">截止日期</div>
        {options.map((o) => (
          <button
            key={o.date}
            onClick={() => onPick(o.date)}
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] hover:bg-hover ${
              value === o.date ? "text-[#d4537e]" : "text-fg-2"
            }`}
          >
            {o.label}
            {value === o.date && <Check size={12} />}
          </button>
        ))}
        {value && (
          <>
            <div className="my-1 border-t border-line" />
            <button
              onClick={() => onPick(null)}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[13px] text-danger hover:bg-danger-soft"
            >
              <X size={12} />
              移除日期
            </button>
          </>
        )}
      </div>
    </>
  );
}
