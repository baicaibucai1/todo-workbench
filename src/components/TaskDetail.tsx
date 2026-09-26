import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Sun,
  Star,
  CalendarDays,
  Trash2,
  Clock,
  Check,
  Circle,
  StickyNote,
  Repeat as RepeatIcon,
  ListChecks,
  Link2,
  Plus,
  MousePointerClick,
} from "lucide-react";
import { useStore } from "../store";
import { addDays, today } from "../lib/repo";
import { formatDateTime, isoToLocalInput } from "../lib/datetime";
import { DETAIL_WIDTH, SETTINGS, parseDetailWidth } from "../lib/settings";
import { parseDetailSections, type DetailSectionId } from "../lib/detailSections";
import { useDragWidth } from "../lib/useDragWidth";
import type { Repeat, Step, Task, WorkOrder } from "../types";
import { InjectedDetailActions, InjectedDetailSections } from "./InjectedTools";
import OrderDetail from "./OrderDetail";
import ResizeHandle from "./ResizeHandle";
import DateTimePicker from "./DateTimePicker";

const REPEAT_OPTIONS: Array<{ value: Repeat; label: string }> = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
];

/**
 * 右侧详情面板。
 *
 * 三种形态，共用一个容器：
 *   1. 待办详情（任务）
 *   2. 流程任务详情（流程任务）—— 内容在 OrderDetail.tsx
 *   3. 空态 —— 用户手动关掉之后、或列表本来就是空的时候
 *
 * **面板在待办界面里始终展开**（默认 360px，左缘可拖，宽度记在设置里）。只有在工具或设置占满右半区时
 * 才收起来 —— 那两种是"另一个界面"，不是叠在待办上的浮层。
 *
 * 收起仍用宽度动画而不是卸载：卸载式渲染没有退出动画，会看到面板"啪"地消失。
 * 所以收起时宽度归零但保留内容，才有滑出的过程。
 */
export default function TaskDetail() {
  const {
    activeTaskId,
    activeOrderId,
    activeToolId,
    settingsOpen,
    view,
    tasks,
    orders,
    lists,
    openTask,
    patchTask,
    toggleDone,
    toggleImportant,
    toggleMyDay,
    setDueDate,
    setRepeat,
    removeTask,
    stepsByTask,
    addStep,
    toggleStep,
    renameStep,
    removeStep,
    setStepDue,
    linkedTasks,
    loadLinks,
    linkTask,
    unlinkTask,
    settings,
    saveSettings,
  } = useStore();

  /* ---------------- 宽度：可拖 + 持久化 ---------------- */

  // 面板贴着窗口右边，把手在左缘：往左拖 = 变宽
  const width = useDragWidth({
    storedWidth: parseDetailWidth(settings[SETTINGS.detailWidth]),
    min: DETAIL_WIDTH.min,
    max: DETAIL_WIDTH.max,
    defaultWidth: DETAIL_WIDTH.default,
    edge: "left",
    onCommit: useCallback(
      (w: number) => void saveSettings({ [SETTINGS.detailWidth]: String(w) }),
      [saveSettings],
    ),
  });

  const task = tasks.find((t) => t.id === activeTaskId) ?? null;
  const order = orders.find((o) => o.id === activeOrderId) ?? null;

  // 工具与设置占满右半区，此时面板整体让位。
  //
  // 图库同理，但理由不同：图库是**一片缩略图墙**，本来就该占满可用宽度，
  // 而且它有自己的全屏预览。留一个 360px 的空详情面板在那儿，
  // 既挤掉一格图（网格按 auto-fill 排，少 360px 就少一整列），
  // 又让用户以为"这些图也能扔进详情里"。
  //
  // AI 助手也挡掉，理由最直接：它旁边一条待办都没有（取数层对 agent 返回空），
  // 面板里只可能显示"上一次看过的那条"（shownTask 是兜底值）——
  // 一个和当前界面毫无关系的任务详情挂在对话旁边，纯属误导。
  const visible =
    !activeToolId && !settingsOpen && view !== "gallery" && view !== "agent";

  // 收起（让位）时选中的对象已经不该再显示，但动画还没播完，留一份内容给它滑
  const lastTask = useRef<Task | null>(null);
  if (task) lastTask.current = task;
  const shownTask = task ?? lastTask.current;

  const lastOrder = useRef<WorkOrder | null>(null);
  if (order) lastOrder.current = order;
  const shownOrder = order ?? lastOrder.current;

  // 有流程任务就看流程任务，否则看任务。两个同时非空不会发生（openTask/openOrder 维持互斥），
  // 这里给个确定的优先级，万一将来被破坏也不会渲染出两个详情。
  const mode: "order" | "task" | "empty" = order ? "order" : task ? "task" : "empty";

  // 分区顺序来自设置，用户在「行为偏好」里自己排
  const sectionOrder = useMemo(
    () => parseDetailSections(settings[SETTINGS.detailSectionOrder]),
    [settings],
  );

  // 备注用本地状态承接输入，防抖落库。
  // 直接把 value 绑到 task.note 的话，每次刷新都会把光标打到末尾。
  const [note, setNote] = useState("");
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!task) return;
    // 只在切换到另一条任务时重置，同一条任务的刷新不该冲掉正在输入的内容
    if (taskIdRef.current !== task.id) {
      taskIdRef.current = task.id;
      setNote(task.note);
    }
  }, [task]);

  const activeId = task?.id ?? null;
  useEffect(() => {
    if (activeId) void loadLinks(activeId);
  }, [activeId, loadLinks]);

  // 面板关闭或任务被删后清掉待写的防抖，避免把旧内容写到别的任务上
  useEffect(() => {
    return () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, []);

  const steps = useMemo(
    () => (shownTask ? (stepsByTask[shownTask.id] ?? []) : []),
    [stepsByTask, shownTask],
  );

  return (
    <aside
      data-task-detail={visible ? "open" : ""}
      data-detail-mode={mode}
      data-detail-width={width.width}
      aria-hidden={!visible}
      className={`relative flex shrink-0 overflow-hidden border-l border-line bg-surface ${
        // 收起时连左边框一起去掉，否则会留下 1px 的细线（宽度也归不了零）。
        // 拖拽期间必须关掉过渡：带着 200ms 缓动跟手会明显"发飘"，
        // 手感像卡住了而不是在拖。
        visible && !width.dragging ? "transition-[width] duration-200 ease-out" : ""
      }`}
      style={{ width: visible ? width.width : 0, borderLeftWidth: visible ? undefined : 0 }}
    >
      {/* 调宽把手：贴左边缘。放在折叠/展开动画之外，
          面板收起时它也不该能被拖（那时宽度为 0）。 */}
      {visible && (
        <ResizeHandle
          api={width}
          side="left"
          resizerKey="detail"
          label="拖动调整详情面板宽度"
        />
      )}

      <div
        className={`h-full transition-[opacity,transform] duration-200 ease-out ${
          visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
        }`}
        style={{ width: width.width }}
      >
        {mode === "order" && shownOrder ? (
          // key 变化会重播入场动画：切换对象时整块淡入，而不是硬切
          <div key={shownOrder.id} className="flex h-full animate-panel-in flex-col">
            <OrderDetail order={shownOrder} />
          </div>
        ) : mode === "task" && shownTask ? (
          <div key={shownTask.id} className="flex h-full animate-panel-in flex-col">
            <DetailBody
              task={shownTask}
              steps={steps}
              sectionOrder={sectionOrder}
              note={note}
              setNote={setNote}
              noteTimer={noteTimer}
              lists={lists}
              linkedTasks={linkedTasks}
              onOpenTask={openTask}
              onToggleDone={() => void toggleDone(shownTask)}
              onToggleImportant={() => void toggleImportant(shownTask)}
              onToggleMyDay={() => void toggleMyDay(shownTask)}
              onSetDueDate={(d) => void setDueDate(shownTask.id, d)}
              onSetRepeat={(r) => void setRepeat(shownTask.id, r)}
              onPatch={(p) => void patchTask(shownTask.id, p)}
              onRemove={() => void removeTask(shownTask.id)}
              onAddStep={(t) => void addStep(shownTask.id, t)}
              onToggleStep={(s) => void toggleStep(s)}
              onRenameStep={(id, t) => void renameStep(id, t)}
              onRemoveStep={(id) => void removeStep(id)}
              onSetStepDue={(id, at) => void setStepDue(id, at)}
              onLink={(id) => void linkTask(shownTask.id, id)}
              onUnlink={(id) => void unlinkTask(shownTask.id, id)}
            />
          </div>
        ) : (
          <EmptyDetail />
        )}
      </div>
    </aside>
  );
}

/**
 * 空态。
 *
 * 面板始终展开，所以"没选中任何东西"是个必然会被看到的正常状态，
 * 得给它一个像样的样子 —— 而不是一块空白，让人怀疑是不是坏了。
 */
function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-chip">
        <MousePointerClick size={20} className="text-fg-dim" />
      </div>
      <div className="text-[13px] text-fg-2">还没有选中任何条目</div>
      <div className="text-[12px] leading-relaxed text-fg-dim">
        点左边列表里的待办或流程任务，它的详情会显示在这里。
      </div>
    </div>
  );
}

/** 拆分出内容组件：钩子已经不少，和外层面板的开合逻辑混在一起不好读 */
function DetailBody({
  task,
  steps,
  sectionOrder,
  note,
  setNote,
  noteTimer,
  lists,
  linkedTasks,
  onOpenTask,
  onToggleDone,
  onToggleImportant,
  onToggleMyDay,
  onSetDueDate,
  onSetRepeat,
  onPatch,
  onRemove,
  onAddStep,
  onToggleStep,
  onRenameStep,
  onRemoveStep,
  onSetStepDue,
  onLink,
  onUnlink,
}: {
  task: Task;
  steps: Step[];
  /** 各分区从上到下的显示顺序，用户在「行为偏好」里排 */
  sectionOrder: DetailSectionId[];
  note: string;
  setNote: (v: string) => void;
  noteTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  lists: Array<{ id: string; name: string; color: string }>;
  linkedTasks: Task[];
  onOpenTask: (id: string | null) => void;
  onToggleDone: () => void;
  onToggleImportant: () => void;
  onToggleMyDay: () => void;
  onSetDueDate: (d: string | null) => void;
  onSetRepeat: (r: Repeat) => void;
  onPatch: (p: Partial<Task>) => void;
  onRemove: () => void;
  onAddStep: (title: string) => void;
  onToggleStep: (s: Step) => void;
  onRenameStep: (id: string, title: string) => void;
  onRemoveStep: (id: string) => void;
  /** 给子任务设到期时刻；null 表示撤掉 */
  onSetStepDue: (id: string, at: string | null) => void;
  onLink: (id: string) => void;
  onUnlink: (id: string) => void;
}) {
  const list = lists.find((l) => l.id === task.listId);
  const accent = list?.color ?? "var(--color-primary)";

  const commitNote = (v: string) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => onPatch({ note: v }), 400);
  };

  const dueLabel = (() => {
    if (!task.dueDate) return "添加截止日期";
    const t = today();
    if (task.dueDate === t) return "今天";
    if (task.dueDate === addDays(t, 1)) return "明天";
    if (task.dueDate === addDays(t, -1)) return "昨天";
    const [, m, d] = task.dueDate.split("-");
    return `${Number(m)}月${Number(d)}日`;
  })();

  const overdue = !!task.dueDate && task.dueDate < today() && !task.done;
  const stepDone = steps.filter((s) => s.done).length;

  // 各分区的内容先备好，顺序由设置决定（见 lib/detailSections.ts）。
  // 每块的 key 用分区 id —— 换顺序时 React 才不会把上一块的状态
  // （比如备注正在输入的内容）张冠李戴到下一块上。
  const blocks: Record<DetailSectionId, React.ReactNode> = {
    subtasks: (
      <>
        <SectionLabel icon={<ListChecks size={13} />} text="子任务" />
        <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card">
          {steps.map((s) => (
            <StepRow
              key={s.id}
              step={s}
              accent={accent}
              onToggle={() => onToggleStep(s)}
              onRename={(v) => onRenameStep(s.id, v)}
              onSetDue={(v) => onSetStepDue(s.id, v)}
              onRemove={() => onRemoveStep(s.id)}
            />
          ))}
          <div className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
            <Plus size={14} className="shrink-0 text-fg-dim" />
            <StepComposer onAdd={onAddStep} />
          </div>
        </div>
        {steps.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-chip">
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-out"
                style={{
                  width: `${(stepDone / steps.length) * 100}%`,
                  background: accent,
                }}
              />
            </div>
            <span data-step-progress="" className="shrink-0 text-[11.5px] text-fg-dim">
              {stepDone}/{steps.length}
            </span>
          </div>
        )}
      </>
    ),

    // 日期与提醒合成**一张**卡片：这两件事是同一个deadline的两个刻度 ——
    // "什么时候到期"和"什么时候喊我"总是一起改的。分开放的时候，
    // 改一次日期要在相隔几屏的两个分区之间来回跳。
    schedule: (
      <>
        <SectionLabel icon={<CalendarDays size={13} />} text="日期与提醒" />
        <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card">
          <div data-detail-part="due" className="p-1.5">
            <div className="px-1 pb-1 text-[11.5px] text-fg-dim">截止日期</div>
            <div className="flex items-center gap-1">
              {[
                { label: "今天", date: today() },
                { label: "明天", date: addDays(today(), 1) },
              ].map((o) => (
                <button
                  key={o.label}
                  onClick={() => onSetDueDate(o.date)}
                  className={`flex-1 rounded px-2 py-1.5 text-[12.5px] transition-colors ${
                    task.dueDate === o.date
                      ? "bg-primary text-white"
                      : "text-fg-3 hover:bg-hover"
                  }`}
                >
                  {o.label}
                </button>
              ))}
              <div className="w-[132px] shrink-0">
                <DateTimePicker
                  mode="date"
                  value={task.dueDate}
                  onChange={onSetDueDate}
                  align="right"
                  inputAttrs={{ "data-due-date-input": "" }}
                />
              </div>
              {task.dueDate && (
                <button
                  onClick={() => onSetDueDate(null)}
                  title="移除日期"
                  className="grid w-7 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="mt-1 px-1 text-[11.5px] text-fg-dim">
              {task.dueDate ? (
                <span className={overdue ? "text-danger" : ""}>
                  当前：{dueLabel}
                  {overdue && " · 已过期"}
                </span>
              ) : (
                "未设置截止日期"
              )}
            </div>
          </div>

          <div data-detail-part="reminder" className="border-t border-line p-1.5">
            <div className="px-1 pb-1 text-[11.5px] text-fg-dim">提醒</div>
            <div className="flex flex-wrap gap-1">
              {REMINDER_PRESETS.map((p) => (
                <button
                  key={p.label}
                  data-reminder-preset={p.label}
                  onClick={() => onPatch({ remindAt: p.at() })}
                  className={`rounded px-2 py-1 text-[12px] transition-colors ${
                    sameRemind(task.remindAt, p.at())
                      ? "bg-primary text-white"
                      : "text-fg-3 hover:bg-hover"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-1.5">
              <DateTimePicker
                mode="datetime"
                value={task.remindAt}
                onChange={(v) => onPatch({ remindAt: v })}
                align="right"
                inputAttrs={{ "data-reminder-input": "" }}
                inputClassName="min-w-0 flex-1 rounded px-2 py-1 text-[12.5px] text-fg-3 outline-none hover:bg-hover focus:bg-hover"
              />
            </div>
            <div className="mt-1 px-1 text-[11.5px] text-fg-dim">
              {task.remindAt ? (
                <span data-reminder-hint="">
                  将在 {formatDateTime(task.remindAt)} 提醒
                  {new Date(task.remindAt).getTime() < Date.now() && " · 已到点"}
                </span>
              ) : (
                "未设置提醒"
              )}
            </div>
          </div>
        </div>
      </>
    ),

    repeat: (
      <>
        <SectionLabel icon={<RepeatIcon size={13} />} text="重复" />
        <div className="mt-1.5 flex gap-1 overflow-hidden rounded-lg border border-line bg-card p-1.5">
          {REPEAT_OPTIONS.map((o) => (
            <button
              key={o.value}
              data-repeat={o.value}
              onClick={() => onSetRepeat(o.value)}
              className={`flex-1 rounded px-2 py-1.5 text-[12.5px] transition-colors ${
                task.repeat === o.value ? "bg-primary text-white" : "text-fg-3 hover:bg-hover"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="mt-1 px-0.5 text-[11.5px] text-fg-dim">
          {task.repeat === "daily"
            ? task.done
              ? "今天已完成，明天自动恢复为未完成"
              : "每天出现，今天勾掉明天自动恢复未完成"
            : "只做一次"}
        </div>
      </>
    ),

    list: (
      <>
        <SectionLabel text="所属列表" />
        <select
          value={task.listId}
          onChange={(e) => onPatch({ listId: e.target.value })}
          className="mt-1.5 w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
        >
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </>
    ),

    links: (
      <>
        <SectionLabel icon={<Link2 size={13} />} text="关联任务" />
        <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card">
          {linkedTasks.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] leading-relaxed text-fg-dim">
              还没有关联任务。适合放"做完这个才能做那个"或"同一件事的两半"。
            </div>
          ) : (
            linkedTasks.map((t) => (
              <div
                key={t.id}
                data-linked={t.id}
                className="flex animate-fade-up items-center gap-2 px-2.5 py-1.5"
              >
                <Link2 size={12} className="shrink-0 text-fg-dim" />
                <button
                  onClick={() => onOpenTask(t.id)}
                  title="打开这条任务"
                  className={`min-w-0 flex-1 truncate text-left text-[13px] text-fg-2 hover:underline ${
                    t.done ? "text-fg-dim line-through" : ""
                  }`}
                >
                  {t.title}
                </button>
                <button
                  onClick={() => onUnlink(t.id)}
                  title="解除关联"
                  className="grid size-5 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft"
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
          <div className="border-t border-line p-1.5">
            <LinkPicker
              taskId={task.id}
              exclude={[task.id, ...linkedTasks.map((t) => t.id)]}
              onPick={onLink}
            />
          </div>
        </div>
      </>
    ),

    note: (
      <>
        <SectionLabel icon={<StickyNote size={13} />} text="备注" />
        <textarea
          data-note-input=""
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            commitNote(e.target.value);
          }}
          placeholder="添加备注"
          className="mt-1.5 min-h-[110px] w-full resize-none rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] leading-relaxed text-fg-2 outline-none placeholder:text-fg-dim focus:border-primary"
        />
      </>
    ),
  };

  return (
    <>
      {/* 头部：完成圈 + 标题 */}
      <div className="flex shrink-0 items-start gap-2.5 px-4 pt-4 pb-3">
        <button
          onClick={onToggleDone}
          title={task.done ? "标记为未完成" : "标记为已完成"}
          className="mt-[3px] grid size-[20px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors"
          style={{
            borderColor: task.done ? "#b4b2a9" : accent,
            background: task.done ? "#b4b2a9" : "transparent",
          }}
        >
          {task.done ? (
            <Check size={12} className="animate-check-pop text-white" strokeWidth={3} />
          ) : (
            <Circle size={8} strokeWidth={0} style={{ fill: accent }} />
          )}
        </button>

        <TitleEditor
          key={task.id}
          value={task.title}
          onCommit={(v) => onPatch({ title: v })}
        />

        {/* 工具注入的操作（见 components/InjectedTools.tsx）：按钮后带一个可展开的面板 */}
        <div className="mt-[3px] shrink-0">
          <InjectedDetailActions taskId={task.id} />
        </div>

        <button
          onClick={() => onOpenTask(null)}
          title="关闭详情"
          className="mt-[3px] grid size-7 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover"
        >
          <X size={16} />
        </button>
      </div>

      {/* 分区变多之后，固定高度会把备注挤没，所以中间整块可滚动 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {/* 快捷开关：与 To Do 一致，做成整行的胶囊 */}
        <div className="flex flex-col gap-1.5 px-4">
          <QuickToggle
            icon={<Sun size={15} />}
            label={task.myDay ? "已添加到我的一天" : "添加到我的一天"}
            active={task.myDay}
            activeColor="#d4537e"
            onClick={onToggleMyDay}
          />
          <QuickToggle
            icon={<Star size={15} />}
            label={task.important ? "已标记为重要" : "标记为重要"}
            active={task.important}
            activeColor="#ba7517"
            onClick={onToggleImportant}
          />
        </div>

        {/* 分区顺序由设置决定 —— 见 lib/detailSections.ts */}
        {sectionOrder.map((id) => (
          <div key={id} data-detail-section={id} className="mt-4 px-4">
            {blocks[id]}
          </div>
        ))}

        {/* 工具注入的分区（见 components/InjectedTools.tsx）：排在内置分区之后，
            因为它属于"用户自己加的东西"，不该把备注、子任务这些挤到后面 */}
        <InjectedDetailSections taskId={task.id} />
      </div>

      {/* 底部：时间信息与删除 */}
      <div className="shrink-0 border-t border-line px-4 py-3">
        <div className="flex items-center gap-1.5 text-[11.5px] text-fg-dim">
          <Clock size={12} />
          创建于 {formatWhen(task.createdAt)}
          {task.completedAt && ` · 完成于 ${formatWhen(task.completedAt)}`}
        </div>
        <button
          onClick={onRemove}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-card py-2 text-[13px] text-danger hover:bg-danger-soft"
        >
          <Trash2 size={14} />
          删除此任务
        </button>
      </div>
    </>
  );
}

/* -------------------------------- 步骤 -------------------------------- */

function StepRow({
  step,
  accent,
  onToggle,
  onRename,
  onSetDue,
  onRemove,
}: {
  step: Step;
  accent: string;
  onToggle: () => void;
  onRename: (v: string) => void;
  /** 设到期时刻；传 null 是撤掉 */
  onSetDue: (v: string | null) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(step.title);
  useEffect(() => setText(step.title), [step.title]);

  return (
    <div className="group flex animate-fade-up items-center gap-2 px-2.5 py-1.5">
      <button
        onClick={onToggle}
        title={step.done ? "标记未完成" : "标记完成"}
        data-step-toggle=""
        className="grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors"
        style={{
          borderColor: step.done ? "#b4b2a9" : accent,
          background: step.done ? "#b4b2a9" : "transparent",
        }}
      >
        {step.done && (
          <Check size={11} className="animate-check-pop text-white" strokeWidth={3} />
        )}
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim();
          if (t && t !== step.title) onRename(t);
          else setText(step.title);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(step.title);
            e.currentTarget.blur();
          }
        }}
        className={`min-w-0 flex-1 border-0 bg-transparent px-1 py-0.5 text-[13px] outline-none focus:bg-hover ${
          step.done ? "text-fg-dim line-through" : "text-fg-2"
        }`}
      />
      <StepDuePicker value={step.dueAt} onChange={onSetDue} />
      <button
        onClick={onRemove}
        title="删除子任务"
        className="grid size-5 shrink-0 place-items-center rounded text-fg-dim opacity-0 transition-opacity group-hover:opacity-100 hover:bg-danger-soft"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/* ---------------------------- 子任务的到期时刻 ---------------------------- */

/**
 * 快捷档位同样是"相对现在"的，渲染那一刻才算 —— 存常量的话
 * 面板开着放十分钟，点下去设的是十分钟前的那个点。
 */
const STEP_DUE_PRESETS: Array<{ label: string; at: () => string }> = [
  { label: "1 小时后", at: () => new Date(Date.now() + 60 * 60_000).toISOString() },
  {
    label: "今天 18:00",
    at: () => {
      const d = new Date();
      d.setHours(18, 0, 0, 0);
      // 已经过了 18 点还叫"今天 18:00"就是骗人 —— 顺延到明天，
      // 但标签不改：标签说的是意图，具体落在哪天看胶囊上的日期。
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    },
  },
  {
    label: "明天 09:00",
    at: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.toISOString();
    },
  },
];

/**
 * 子任务的到期时刻。
 *
 * 设了就显示成一颗胶囊（「今天 14:30」），没设时只在悬停时露出时钟图标 ——
 * 子任务行本来就窄，每行常年挂一排图标会把一页清单挤成一排色块。
 *
 * 之所以让它自带时刻（而不是只勾"做完没做完"）：真正卡人的往往不是整件任务，
 * 是其中「三点前要把图发出去」那一步。没有时刻，那一步在时间上是隐形的。
 */
function StepDuePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点别处就收起来。不能省：详情里可以同时给好几条子任务设时间，
  // 没有这条就得再点一次小按钮才能收，用户只会觉得"点了没反应"。
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={boxRef} className="relative shrink-0">
      {value ? (
        <button
          data-step-due-button=""
          onClick={() => setOpen(!open)}
          title="修改到期时间"
          className="flex items-center gap-0.5 rounded-full bg-chip px-1.5 py-0.5 text-[10.5px] text-fg-dim hover:bg-hover"
        >
          <Clock size={9} />
          {formatDateTime(value)}
        </button>
      ) : (
        <button
          data-step-due-button=""
          onClick={() => setOpen(!open)}
          title="设置到期时间"
          className="grid size-5 place-items-center rounded text-fg-dim opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover"
        >
          <Clock size={12} />
        </button>
      )}

      {open && (
        <div
          data-step-due-pop=""
          className="absolute right-0 top-full z-20 mt-1 w-[190px] rounded-lg border border-line bg-card p-1.5 shadow-[0_4px_14px_rgba(0,0,0,0.16)]"
        >
          <div className="flex flex-col gap-0.5">
            {STEP_DUE_PRESETS.map((p) => (
              <button
                key={p.label}
                data-step-due-preset={p.label}
                onClick={() => {
                  onChange(p.at());
                  setOpen(false);
                }}
                className="rounded px-2 py-1 text-left text-[12px] text-fg-3 hover:bg-hover"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-1">
            <DateTimePicker
              mode="datetime"
              value={value}
              onChange={(v) => {
                onChange(v);
              }}
              align="right"
              inputAttrs={{ "data-step-due-input": "" }}
              inputClassName="min-w-0 flex-1 rounded px-1.5 py-1 text-[12px] text-fg-3 outline-none hover:bg-hover focus:bg-hover"
            />
          </div>
          {/* 能撤掉比能设置更关键：设错一个时间点会在紧急区里挂到天荒地老，
              比压根没设过更烦人 */}
          {value && (
            <button
              data-step-due-clear=""
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="mt-1 w-full rounded px-2 py-1 text-[12px] text-danger hover:bg-danger-soft"
            >
              取消到期时间
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StepComposer({ onAdd }: { onAdd: (title: string) => void }) {
  const [v, setV] = useState("");
  return (
    <input
      value={v}
      data-step-input=""
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) {
          onAdd(v);
          setV("");
        }
      }}
      placeholder="添加子任务"
      className="min-w-0 flex-1 border-0 bg-transparent px-1 py-0.5 text-[13px] outline-none placeholder:text-fg-dim"
    />
  );
}

/* ------------------------------ 关联选择 ------------------------------ */

function LinkPicker({
  taskId,
  exclude,
  onPick,
}: {
  taskId: string;
  exclude: string[];
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  /** null = 还没取回来。用它区分"暂无候选"和"正在取"，免得刚挂载就闪一句"没有匹配的任务" */
  const [pool, setPool] = useState<Task[] | null>(null);

  // 候选池要跨视图：store 里的 tasks 只是当前视图的数据，可选范围太窄。
  //
  // 每次**聚焦搜索框**都重取一次，不能只在挂载时取一次：
  // 右侧面板是常驻的，中途新建的任务不会让面板重建（选中的那条还活着，
  // selectFirst 不会切走），只取一次的话新任务就永远不在池子里 ——
  // 表现是"刚建好却搜不到"，比不能搜索还费解。
  const loadPool = useCallback(async () => {
    const repo = await import("../lib/repo");
    const all = await repo.fetchTasks({ view: "all", includeDone: true });
    setPool(all);
  }, []);

  // 换一条宿主任务时重置，避免上一条的候选闪一下
  useEffect(() => {
    setQ("");
    setPool(null);
    void loadPool();
  }, [taskId, loadPool]);

  const keyword = q.trim();
  const hits = (pool ?? [])
    .filter((t) => !exclude.includes(t.id))
    .filter((t) => !keyword || t.title.includes(keyword))
    .slice(0, 6);

  return (
    <div data-link-pool={pool === null ? "loading" : pool.length}>
      <input
        value={q}
        data-link-search=""
        onFocus={() => void loadPool()}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索要关联的任务"
        className="w-full border-0 bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-fg-dim"
      />
      {keyword && (
        <div className="mt-1 animate-slide-down overflow-hidden rounded-md border border-line bg-card">
          {hits.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-fg-dim">没有匹配的任务</div>
          ) : (
            hits.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onPick(t.id);
                  setQ("");
                }}
                data-link-option={t.id}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[13px] text-fg-2 hover:bg-hover"
              >
                <Plus size={12} className="shrink-0 text-fg-dim" />
                <span className="truncate">{t.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- 零件 -------------------------------- */

/** 标题编辑：点进去就地编辑，失焦或回车提交，Esc 撤销 */
function TitleEditor({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={text}
      rows={1}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim();
        if (t && t !== value) onCommit(t);
        else setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setText(value);
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-[15px] leading-[22px] text-fg outline-none hover:border-line focus:border-primary focus:bg-card"
    />
  );
}

function QuickToggle({
  icon,
  label,
  active,
  activeColor,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  activeColor: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] transition-colors ${
        active ? "bg-card font-medium" : "text-fg-3 hover:bg-card"
      }`}
      style={active ? { color: activeColor } : undefined}
    >
      {icon}
      {label}
    </button>
  );
}

function SectionLabel({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-fg-dim">
      {icon}
      {text}
    </div>
  );
}

/* ------------------------------ 提醒时间 ------------------------------ */

/** 快捷提醒都是相对"现在"的，所以存成函数，在渲染那一刻才算 */
const REMINDER_PRESETS: Array<{ label: string; at: () => string | null }> = [
  { label: "无提醒", at: () => null },
  { label: "30 分钟后", at: () => new Date(Date.now() + 30 * 60_000).toISOString() },
  {
    label: "今晚 18:00",
    at: () => {
      const d = new Date();
      d.setHours(18, 0, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    },
  },
  {
    label: "明天 09:00",
    at: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.toISOString();
    },
  },
];

function sameRemind(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  // 快捷项每次算出的值都不同，只能比到"分钟"这一层
  return isoToLocalInput(a) === isoToLocalInput(b);
}

// isoToLocalInput / localInputToIso / formatDateTime 三件套搬去了 lib/datetime.ts ——
// 提醒、子任务到期、列表展开里的胶囊说的是同一种人话，各写一份改文案要翻三个文件。

/** 时间展示：今天只给时刻，更早补上日期 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return isoToLocalInput(iso).slice(0, 10) === today()
    ? `今天 ${hm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
