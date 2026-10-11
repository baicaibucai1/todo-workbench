import { useMemo, useRef, useState } from "react";
import {
  Star,
  Sun,
  Trash2,
  CalendarDays,
  ArrowDownUp,
  Lightbulb,
  Circle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Repeat,
  ClipboardList,
} from "lucide-react";
import { useStore } from "../store";
import TaskRow from "./TaskRow";
import OrderRow from "./OrderRow";
import OrderCreateDialog from "./OrderCreateDialog";
import {
  groupRows,
  resolveSortByDate,
  type Row as RowsRow,
  type Section,
} from "../lib/rows";
import { SETTINGS } from "../lib/settings";
import {
  SCRIM,
  formatBackground,
  isScrimLevel,
  parseBackground,
} from "../lib/wallpapers";
import { useWallpaperUrl } from "../lib/useWallpaperUrl";

const VIEW_META: Record<
  string,
  { icon: typeof Sun; accent: string; bg: string }
> = {
  myday: {
    icon: Sun,
    accent: "#d4537e",
    bg: "linear-gradient(135deg, #c2436b 0%, #e0748f 48%, #e8a07a 100%)",
  },
  important: {
    icon: Star,
    accent: "var(--color-warn)",
    bg: "linear-gradient(135deg, #a8681a 0%, #d99b3f 50%, #e8b56a 100%)",
  },
  all: {
    icon: Circle,
    accent: "#534ab7",
    bg: "linear-gradient(135deg, #443c9a 0%, #7a72cc 50%, #a79fe0 100%)",
  },
  /*
   * 流程任务这一格**故意写死蓝色**：它跟上面几个视图一样是"视图身份色"，
   * 不是主题色。改主题色时按钮、选中态跟着换，但侧边栏里流程任务这一项还是蓝的
   * —— 否则换一套配色，各视图的标志色就全糊在一起了。
   */
  orders: {
    icon: ClipboardList,
    accent: "#378add",
    bg: "linear-gradient(135deg, #1f4e8c 0%, #378add 50%, #7fb3e3 100%)",
  },
  list: {
    icon: Circle,
    accent: "#d4537e",
    bg: "linear-gradient(135deg, #b8436a 0%, #d97a95 50%, #e3a882 100%)",
  },
};

/**
 * 列表里的统一行 —— 类型与分组排序逻辑都在 lib/rows.ts。
 *
 * 抽出去的原因不是"代码整洁"，是**右侧详情要按同一把尺子选第一条**：
 * 分组逻辑留在这里、选中逻辑在 store 里各写一遍，两边一定会漂移。
 */
type Row = RowsRow;

/** 头部副标题的日期格式，与 To Do 一致：9月17日,星期四 */
function formatHeaderDate(): string {
  const d = new Date();
  const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return `${d.getMonth() + 1}月${d.getDate()}日,${week[d.getDay()]}`;
}

export default function TaskList() {
  const {
    view,
    activeListId,
    lists,
    tasks,
    orders,
    search,
    activeTaskId,
    activeOrderId,
    openTask,
    openOrder,
    addTask,
    toggleDone,
    toggleImportant,
    toggleMyDay,
    removeTask,
    renameTask,
    setDueDate,
    reorderTasks,
    sortByDate: sortByDateOverride,
    setSortByDate,
    advanceOrder,
    toggleOrderImportant,
    removeOrder,
    openFlowEditor,
    flows,
    settings,
  } = useStore();

  const [draft, setDraft] = useState("");
  const [draftDaily, setDraftDaily] = useState(false);
  /** 底部创建器当前在造什么：待办还是流程任务 */
  const [compose, setCompose] = useState<"task" | "order">("task");
  /**
   * 新建流程任务弹窗。null = 不弹；字符串 = 弹出来并把标题预填成它。
   *
   * 用"预填标题"而不是只存一个布尔量：用户在底部输入框里打的字不该白打，
   * 回车只是把那句话带进表单，而不是丢掉重新填。
   */
  const [orderFormTitle, setOrderFormTitle] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  /**
   * 排序方式：true = 按日期，false = 自定义顺序（**这时行可以拖**）。
   *
   * 放在 store 里（`sortByDate`，null = 视图默认）而不是组件里：
   * 「自动选中第一行」必须和列表用同一份排序规则，各存一份就会错位
   * （见 lib/rows.ts 里 resolveSortByDate 的说明）。
   *
   * ⚠️ 这个开关以前只换按钮的 tooltip，没接到任何排序上（按钮是死的）；
   * 现在它真的决定分组怎么排、哪些行能拖。
   */
  const sortByDate = resolveSortByDate(view, sortByDateOverride);
  const toggleSort = () => setSortByDate(!sortByDate);
  /**
   * 加载失败的那张壁纸。
   *
   * 存文件名而不是一个布尔量：用户换一张壁纸就该再试一次，
   * 用布尔量的话第一张失败之后就永远回不来了（还得记得重置它）。
   */
  const [failedWallpaper, setFailedWallpaper] = useState<string | null>(null);

  /** 「流程任务」视图只装流程任务 */
  const ordersOnly = view === "orders";
  /**
   * 这个视图只装流程任务，创建栏在这里只能造流程任务。
   *
   * 在「流程任务」视图里造一条待办是不会出现在当前列表里的，那个
   * "输完回车却什么都没发生"的表现比不给入口糟糕得多（踩过一次）。
   */
  const orderView = ordersOnly;
  /**
   * 创建栏实际在造什么。流程任务视图下锁死成"造流程任务" ——
   * 在这里造一条待办是不会出现在当前列表里的（流程任务视图不取待办），
   * 那个"输完回车却什么都没发生"的表现比不给入口糟糕得多。
   */
  const composeKind: "task" | "order" = orderView ? "order" : compose;

  const meta = VIEW_META[view] ?? VIEW_META.list;
  const HeaderIcon = meta.icon;

  /*
   * 背景：默认跟随视图渐变，选了壁纸就铺图 + 遮罩。
   *
   * 壁纸有两种来源（内置必应图 / 用户自己传的），地址解析走 useWallpaperUrl：
   * 自定义那张要异步向仓库要，这里只关心"最后有没有拿到一个地址"。
   * failedWallpaper 记的是**整条背景值**（image:xx 或 custom:xx），
   * 因为两种都可能加载不出来。
   */
  const bg = parseBackground(settings[SETTINGS.background]);
  const bgKey = formatBackground(bg);
  const wallpaperSrc = useWallpaperUrl(settings[SETTINGS.background]);
  const bgWallpaper = bg.kind !== "auto" && wallpaperSrc !== null && bgKey !== failedWallpaper ? bg : null;
  const scrimRaw = settings[SETTINGS.bgScrim];
  const scrim = SCRIM[isScrimLevel(scrimRaw) ? scrimRaw : "medium"];

  const title = useMemo(() => {
    if (view === "list") {
      return lists.find((l) => l.id === activeListId)?.name ?? "任务";
    }
    // 用 Record 而不是字面量对象 + 类型断言：以后再加视图忘了补标题，
    // 这里会退回「任务」而不是渲染出一个空 h1 —— 空标题非常难排查。
    return (
      {
        myday: "我的一天",
        important: "重要",
        all: "全部",
        orders: "流程任务",
      } as Record<string, string>
    )[view] ?? "任务";
  }, [view, activeListId, lists]);

  const accent =
    view === "list"
      // 列表色是**用户数据**（存在 core_lists.color 里、还会跟着同步走
      // 跳到别的机器），这里的兜底值必须是同一个形状的真 hex，不能写成 CSS 变量。
      ? (lists.find((l) => l.id === activeListId)?.color ?? "#d4537e")
      : meta.accent;

  // 分组排序全部交给 lib/rows.ts —— store 选第一条时用的是同一份，
  // 保证「高亮的行」和「右侧展开的详情」永远指同一条记录
  const grouped = useMemo(
    () => groupRows(tasks, orders, view, sortByDate),
    [tasks, orders, view, sortByDate],
  );

  /* ------------------------------------------------------------------ *
   * 拖拽排序
   * ------------------------------------------------------------------ */

  /**
   * 一次拖拽的全部现场。用 ref 而不是 state：拖动过程中 pointermove
   * 每帧都在算落点，走 state 会让整个列表跟着重渲染几十次。
   */
  const dragRef = useRef<{
    section: string;
    ids: string[];
    rects: { top: number; height: number }[];
    from: number;
    to: number;
  } | null>(null);
  /** 只有"拖的是谁、落在第几位"进 state —— 渲染预览用 */
  const [dragView, setDragView] = useState<{ section: string; id: string; to: number } | null>(
    null,
  );

  /**
   * 按下把手。用 pointer 事件 + window 监听，而不是 HTML5 的 draggable：
   * 后者在 Playwright 里不好驱动（要合成 dragstart/drop 一串事件），
   * 而 pointer 事件就是普通鼠标事件，e2e 用 mouse.down/move/up 就能真拖一遍。
   */
  const beginDrag = (e: React.PointerEvent, section: Section, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();

    // 行矩形在**按下这一刻**量一次就够：拖动过程中不改布局（落点是实时重排
    // 的，但那是渲染层的事，量新的反而会被自己的预览带着抖）
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-drag-row="${section.key}"]`),
    );
    const ids = nodes.map((n) => n.dataset.taskId ?? "").filter(Boolean);
    const rects = nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    const from = ids.indexOf(id);
    if (from < 0 || ids.length < 2) return;

    dragRef.current = { section: section.key, ids, rects, from, to: from };
    setDragView({ section: section.key, id, to: from });

    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // 落点 = "指针越过了几条行的中线"
      let ins = d.rects.length;
      for (let k = 0; k < d.rects.length; k++) {
        if (ev.clientY < d.rects[k].top + d.rects[k].height / 2) {
          ins = k;
          break;
        }
      }
      const to = ins > d.from ? ins - 1 : ins;
      if (to !== d.to) {
        d.to = to;
        setDragView({ section: d.section, id: d.ids[d.from], to });
      }
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      const d = dragRef.current;
      dragRef.current = null;
      setDragView(null);
      if (!commit || !d || d.to === d.from) return;
      const next = [...d.ids];
      const [moved] = next.splice(d.from, 1);
      next.splice(d.to, 0, moved);
      void reorderTasks(next);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  /**
   * 拖动中的**预览顺序**：把被拖的那条挪到落点上，其余原地不动。
   *
   * 直接改渲染顺序而不是画一条"会落在哪儿"的指示线：后者在"拖到最后一位"
   * 时只能画在最后一行上方，说的和实际落点不一致。
   * 流程任务行不参与（它们按日期排），所以只在待办占的那几个槽位里换。
   */
  const previewItems = (section: Section): RowsRow[] => {
    const d = dragView;
    if (!d || d.section !== section.key) return section.items;
    const slots: number[] = [];
    section.items.forEach((r, i) => {
      if (r.kind === "task") slots.push(i);
    });
    const taskRows = slots.map((i) => section.items[i]);
    const from = taskRows.findIndex((r) => r.kind === "task" && r.task.id === d.id);
    if (from < 0) return section.items;
    const [moved] = taskRows.splice(from, 1);
    taskRows.splice(d.to, 0, moved);
    const next = [...section.items];
    slots.forEach((pos, k) => {
      next[pos] = taskRows[k];
    });
    return next;
  };

  const submit = async () => {
    if (!draft.trim()) return;
    if (composeKind === "task") {
      await addTask(draft, { repeat: draftDaily ? "daily" : "none" });
      setDraft("");
      setDraftDaily(false);
      return;
    }
    // 流程任务不在这里直接建：只填标题的话，建出来的是一张只有标题的半成品，
    // 还得回详情补流程/日期/备注。改成把标题带进完整表单一次填完。
    setOrderFormTitle(draft);
  };

  const isMyDay = view === "myday";
  const searching = search.trim().length > 0;
  const isEmpty = grouped.sections.every((s) => s.items.length === 0) && !grouped.done.length;

  // 搜索是跨列表的，此时标题跟随结果而非当前视图，避免用户误解
  const headerTitle = searching ? `搜索：${search.trim()}` : title;

  /**
   * 选中判定写在这里：**高亮的行**和**右侧详情**必须指同一条记录。
   * 顺带用于算 prevActive —— 选中行浮起来之后，它下面那根分隔线要收掉。
   */
  const rowIsActive = (row: Row) =>
    row.kind === "task"
      ? activeTaskId === row.task.id
      : activeOrderId === row.order.id;

  const renderRow = (
    row: Row,
    i: number,
    items: Row[],
    showDate: boolean,
    section?: Section,
  ) =>
    row.kind === "task" ? (
      <TaskRow
        key={row.task.id}
        task={row.task}
        accent={accent}
        first={i === 0}
        last={i === items.length - 1}
        prevActive={i > 0 && rowIsActive(items[i - 1])}
        showDate={showDate}
        active={activeTaskId === row.task.id}
        onToggleDone={() => void toggleDone(row.task)}
        onToggleImportant={() => void toggleImportant(row.task)}
        onToggleMyDay={() => void toggleMyDay(row.task)}
        onDelete={() => void removeTask(row.task.id)}
        onRename={(t) => void renameTask(row.task.id, t)}
        onSetDueDate={(d) => void setDueDate(row.task.id, d)}
        onOpen={() => openTask(row.task.id)}
        /* 只有"自定义顺序"的分组给把手：按日期排的分组里拖一下没有意义，
           松手它就会被日期排回去 —— 不给把手才不会让人以为坏了 */
        drag={
          section?.manual
            ? {
                section: section.key,
                onStart: (e) => beginDrag(e, section, row.task.id),
                dragging: dragView?.id === row.task.id,
              }
            : undefined
        }
      />
    ) : (
      <OrderRow
        key={row.order.id}
        order={row.order}
        first={i === 0}
        last={i === items.length - 1}
        prevActive={i > 0 && rowIsActive(items[i - 1])}
        showDate={showDate}
        active={activeOrderId === row.order.id}
        onOpen={() => openOrder(row.order.id)}
        onAdvance={(stageId) => void advanceOrder(row.order.id, stageId)}
        onToggleImportant={() => void toggleOrderImportant(row.order)}
        onDelete={() => void removeOrder(row.order.id)}
      />
    );

  return (
    <div
      className="relative isolate flex h-full min-w-0 flex-1 flex-col"
      style={{ background: meta.bg }}
      // 背景状态写进 dataset：截图看不出"壁纸其实没加载成功"，
      // 自动化得有个确定的读法
      data-bg-mode={bgWallpaper ? bgWallpaper.kind : "auto"}
      data-bg-file={bgWallpaper?.kind === "image" ? bgWallpaper.file : (bgWallpaper?.path ?? "")}
    >
      {/* 壁纸层。放 -z-10 而不是做成普通子元素：
          绝对定位的元素会盖在普通流的兄弟节点之上（绘制顺序上"定位元素"晚于"块级元素"），
          列表行会被整块壁纸糊住；负 z-index + isolate 才是"垫在内容后面"的写法。 */}
      {bgWallpaper && (
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
          <img
            src={wallpaperSrc ?? ""}
            alt=""
            data-bg-image={bgWallpaper.kind === "image" ? bgWallpaper.file : bgWallpaper.path}
            className="size-full object-cover"
            // 图片缺失（换了机器没同步 public/wallpapers、或者自己传的那张
            // 被手动删了）时退回视图渐变，而不是留一块加载失败的空白
            onError={() => setFailedWallpaper(bgKey)}
          />
          <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${scrim.base})` }} />
          <div
            className="absolute inset-x-0 top-0 h-44"
            style={{ background: `linear-gradient(to bottom, rgba(0,0,0,${scrim.top}), rgba(0,0,0,0))` }}
          />
        </div>
      )}
      {/* 头部 */}
      <div className="flex items-start justify-between px-6 pt-5 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <HeaderIcon size={22} className="shrink-0 text-white/95" strokeWidth={1.8} />
            <h1 className="truncate text-[26px] leading-tight font-medium text-white">
              {headerTitle}
            </h1>
          </div>
          <p className="mt-0.5 ml-[32px] text-[13px] text-white/80">
            {formatHeaderDate()}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          {isMyDay && (
            <button
              className="grid size-8 place-items-center rounded-md bg-white/20 text-white hover:bg-white/30"
              title="建议"
            >
              <Lightbulb size={16} />
            </button>
          )}
          <button
            onClick={toggleSort}
            className="grid size-8 place-items-center rounded-md bg-white/20 text-white hover:bg-white/30"
            title={sortByDate ? "改为自定义顺序（可拖动）" : "按日期排序"}
            // 排序方式写进 dataset：光看图标分不出当前是哪一种，自动化要有确定读法
            data-sort-by-date={sortByDate ? "1" : "0"}
          >
            <ArrowDownUp size={16} />
          </button>
        </div>
      </div>

      {/* 任务区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {search.trim() && (
          <div className="mb-2 text-[12px] text-white/80">
            共 {tasks.length + orders.length} 条结果 · 已跨全部列表检索
          </div>
        )}

        {grouped.sections.map((section) =>
          section.items.length ? (
            <div key={section.key} className="mb-3">
              {section.label && (
                <div className="mb-1.5 flex items-center gap-2 px-1">
                  {/* 逾期分组标题压在视图身份色渐变上，这一句是「渐变上的高亮」，
                      跟主题无关；#ffe0e0 是白里挑一点粉，比纯白更像报警 */}
                  <span
                    className={`text-[12px] font-medium ${section.overdue ? "text-[#ffe0e0]" : "text-white/85"}`}
                  >
                    {section.label}
                  </span>
                  <span className="text-[12px] text-white/55">
                    {section.items.length}
                  </span>
                </div>
              )}
              {/* 分组容器。**刻意不写 overflow-hidden**：选中行要"浮起来"，
                  它的投影必须能溢出到容器外面 —— 裁掉就成了半张卡。
                  代价是圆角改由行自己兜住（lib/rowStyle 的 first / last）。 */}
              <div className="rounded-lg bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.12)]">
                {previewItems(section).map((row, i) =>
                  renderRow(
                    row,
                    i,
                    section.items,
                    view === "all" || view === "list" || view === "orders",
                    section,
                  ),
                )}
              </div>
            </div>
          ) : null,
        )}

        {isEmpty && !search && (
          <div className="mt-10 flex flex-col items-center gap-2 text-center">
            <div className="grid size-14 place-items-center rounded-full bg-white/20">
              <meta.icon size={24} className="text-white/80" />
            </div>
            <p className="text-[14px] text-white/90">
              {ordersOnly
                ? "还没有流程任务"
                : isMyDay
                  ? "今天还没有安排"
                  : "这个列表还没有任务"}
            </p>
            <p className="max-w-[300px] text-[12px] leading-relaxed text-white/70">
              {ordersOnly
                ? "在下方输入框建第一张流程任务；它会按所选流程一步步走，每走一步都留痕"
                : isMyDay
                  ? "在下方输入框添加待办，或切到「流程任务」建一张要走流程的单子"
                  : "在下方输入框添加第一条任务；其他列表里的任务不会显示在这里"}
            </p>
          </div>
        )}

        {/* 已完成折叠区：待办已完成 + 流程任务已完结混在一起 */}
        {grouped.done.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowDone((v) => !v)}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-white/85 hover:bg-white/10"
            >
              {showDone ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <CheckCircle2 size={13} />
              <span>已完成</span>
              <span className="text-white/60">{grouped.done.length}</span>
            </button>
            {/* 已完成区同样不放 overflow-hidden，理由见上面那个分组容器 */}
            {showDone && (
              <div className="mt-1.5 rounded-lg bg-surface">
                {grouped.done.map((row, i) => renderRow(row, i, grouped.done, true))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部创建栏：待办与流程任务共用一块，靠左侧开关切换在造什么 */}
      <div className="shrink-0 px-6 pb-5">
        <div className="rounded-lg bg-card px-4 py-3 shadow-[0_2px_8px_rgba(0,0,0,0.15)]">
          <div className="flex items-center gap-3">
            {/* 待办 / 流程任务 切换。流程任务视图下不给切换 —— 这里只可能造流程任务，
                摆一个"待办"按钮在这里是假入口（造完不会出现在当前列表） */}
            {orderView ? (
              <span
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                <ClipboardList size={12} />
                流程任务
              </span>
            ) : (
              <div className="flex shrink-0 items-center rounded-md bg-chip p-0.5">
                <ComposeTab
                  active={composeKind === "task"}
                  onClick={() => setCompose("task")}
                  icon={<Circle size={12} />}
                  label="待办"
                  tabKey="task"
                  accent={accent}
                />
                <ComposeTab
                  active={composeKind === "order"}
                  onClick={() => setCompose("order")}
                  icon={<ClipboardList size={12} />}
                  label="流程任务"
                  tabKey="order"
                  accent="var(--color-primary)"
                />
              </div>
            )}

            {composeKind === "task" ? <PlusCircle accent={accent} /> : <OrderMark />}

            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              data-compose-input=""
              placeholder={
                composeKind === "order"
                  ? "流程任务标题，回车填写描述与相关信息"
                  : draftDaily
                    ? "添加每日任务"
                    : "添加任务"
              }
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-dim"
            />

            {/* 只在「我的一天」提供：这里的新建默认就是给今天的，顺手决定它是不是每天都要做 */}
            {composeKind === "task" && isMyDay && (
              <button
                onClick={() => setDraftDaily((v) => !v)}
                data-daily-toggle=""
                title={draftDaily ? "改回普通任务" : "设为每日任务（每天自动出现）"}
                className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
                  draftDaily ? "text-white" : "text-fg-dim hover:bg-hover"
                }`}
                style={draftDaily ? { background: accent } : undefined}
              >
                <Repeat size={13} />
                每日
              </button>
            )}

            {draft.trim() && (
              <button
                onClick={() => void submit()}
                data-compose-submit=""
                className="shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium text-white"
                style={{
                  background: composeKind === "order" ? "var(--color-primary)" : accent,
                }}
              >
                {composeKind === "order" ? "创建流程任务" : "添加"}
              </button>
            )}
          </div>

          {/* 流程任务的流程 / 过程态 / 日期 / 备注都在弹窗里一次填完。
              这里不再摆第二份同样的选项 —— 两处都能改同一批参数，
              只会让人不确定到底以哪边为准。 */}
          {composeKind === "order" && (
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
              {/* 「我的一天」里要额外说一句：流程任务建出来**不会**出现在当前列表，
                  不说的话用户会以为没建成（和"在流程任务视图里造待办"是同一类坑） */}
              <span data-compose-hint="" className="min-w-0 flex-1 text-[11.5px] text-fg-dim">
                {isMyDay
                  ? "流程任务不进「我的一天」，建好后在侧边栏「流程任务」里看"
                  : "回车或点「创建流程任务」，弹窗里一次填完描述、流程、过程态与日期"}
              </span>
              <button
                // 这里必须给一个**真实的 flowId**：openFlowEditor 的开关语义是
                // `flowEditorOpen: !!flowId`，传 null 等于"关掉"，按钮就会点了没反应。
                // 不指定具体流程时退回默认流程（没有默认就第一套）。
                onClick={() =>
                  openFlowEditor(flows.find((f) => f.isDefault)?.id ?? flows[0]?.id ?? null)
                }
                data-edit-flows=""
                title="编辑流程与过程态"
                className="shrink-0 rounded px-1.5 py-1 text-[12px] text-fg-3 hover:bg-hover"
              >
                编辑流程
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 新建流程任务弹窗。挂在最外层而不是创建栏里：它是整屏居中的浮层，
          塞进底部那一行的布局里会被父级的 overflow 裁掉 */}
      {orderFormTitle !== null && (
        <OrderCreateDialog
          initialTitle={orderFormTitle}
          onClose={() => setOrderFormTitle(null)}
          onCreated={() => {
            // 建成了才清掉输入框里那句话 —— 取消的话它还该留着，
            // 否则用户改个错别字就得从头再打一遍
            setDraft("");
          }}
        />
      )}
    </div>
  );
}

/** 创建器左上角的「待办 / 流程任务」切换按钮 */
function ComposeTab({
  active,
  onClick,
  icon,
  label,
  tabKey,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  /**
   * 自动化验证用的稳定标识。
   *
   * 不拿 label 顶：界面文案是会被改的（「工单」刚改成了「流程任务」），
   * 用文案当选择器，等于每改一个字就顺手弄红一批用例。
   */
  tabKey: "task" | "order";
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      data-compose-tab={tabKey}
      className={`flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium transition-colors ${
        active ? "text-white" : "text-fg-dim hover:text-fg-2"
      }`}
      style={active ? { background: accent } : undefined}
    >
      {icon}
      {label}
    </button>
  );
}

function PlusCircle({ accent }: { accent: string }) {
  return (
    <span
      className="grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px]"
      style={{ borderColor: accent }}
    >
      <span
        className="size-[8px] rounded-full border-[1.5px]"
        style={{ borderColor: accent }}
      />
    </span>
  );
}

/** 流程任务版的输入框前缀标记：圆角方块，和待办的圆形成对照 */
function OrderMark() {
  return (
    <span className="grid size-[22px] shrink-0 place-items-center rounded-[6px] border-[1.5px] border-primary">
      <span className="block size-[8px] rounded-[2px] bg-primary" />
    </span>
  );
}

export { CalendarDays, Trash2 };
