import { useMemo, useState } from "react";
import {
  Star,
  Sun,
  Trash2,
  CalendarDays,
  MoreHorizontal,
  Lightbulb,
  Circle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Repeat,
  ClipboardList,
  Timer,
} from "lucide-react";
import { useStore } from "../store";
import TaskRow from "./TaskRow";
import OrderRow from "./OrderRow";
import OrderCreateDialog from "./OrderCreateDialog";
import SpecialOrdersView from "./SpecialOrdersView";
import { groupRows, type Row as RowsRow } from "../lib/rows";
import type { WorkOrderKind } from "../types";
import { SETTINGS } from "../lib/settings";
import {
  SCRIM,
  isScrimLevel,
  parseBackground,
  wallpaperUrl,
} from "../lib/wallpapers";

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
    accent: "#ba7517",
    bg: "linear-gradient(135deg, #a8681a 0%, #d99b3f 50%, #e8b56a 100%)",
  },
  all: {
    icon: Circle,
    accent: "#534ab7",
    bg: "linear-gradient(135deg, #443c9a 0%, #7a72cc 50%, #a79fe0 100%)",
  },
  // 工单沿用界面里一贯的蓝色（创建栏、行内标记都是 #378add）
  orders: {
    icon: ClipboardList,
    accent: "#378add",
    bg: "linear-gradient(135deg, #1f4e8c 0%, #378add 50%, #7fb3e3 100%)",
  },
  // 特殊单号：橙色。它是"等不起的单子"，在色板上要和工单的蓝、
  // 重要的琥珀都拉开距离 —— 侧边栏里这几个入口是并排的，撞色就等于没颜色
  special: {
    icon: Timer,
    accent: "#d85a30",
    bg: "linear-gradient(135deg, #96361c 0%, #d85a30 50%, #eaa587 100%)",
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
    advanceOrder,
    toggleOrderImportant,
    removeOrder,
    openFlowEditor,
    flows,
    settings,
  } = useStore();

  const [draft, setDraft] = useState("");
  const [draftDaily, setDraftDaily] = useState(false);
  /** 底部创建器当前在造什么：待办还是工单 */
  const [compose, setCompose] = useState<"task" | "order">("task");
  /**
   * 新建工单弹窗。null = 不弹；字符串 = 弹出来并把标题预填成它。
   *
   * 用"预填标题"而不是只存一个布尔量：用户在底部输入框里打的字不该白打，
   * 回车只是把那句话带进表单，而不是丢掉重新填。
   */
  const [orderFormTitle, setOrderFormTitle] = useState<string | null>(null);
  /**
   * 弹窗按哪种单来开。
   *
   * 跟着**当前视图**走而不是让用户在弹窗里再选一次：在「特殊单号」里点创建，
   * 想造的显然是特殊单号；让他在表单里再选一遍，就是在问一个他刚刚已经答过的问题。
   * 弹窗里仍然保留切换（建错了不用关掉重来）。
   */
  const [orderFormKind, setOrderFormKind] = useState<WorkOrderKind>("normal");
  const [showDone, setShowDone] = useState(false);
  const [sortByDate, setSortByDate] = useState(false);
  /**
   * 加载失败的那张壁纸。
   *
   * 存文件名而不是一个布尔量：用户换一张壁纸就该再试一次，
   * 用布尔量的话第一张失败之后就永远回不来了（还得记得重置它）。
   */
  const [failedWallpaper, setFailedWallpaper] = useState<string | null>(null);

  /** 「工单」视图只装工单 */
  const ordersOnly = view === "orders";
  /** 「特殊单号」视图只装特殊单号（工单里带处理时效的那一类） */
  const specialOnly = view === "special";
  /**
   * 这两个视图都是"只装工单"的，创建栏在这里只能造工单。
   *
   * 在「工单」视图里造一条待办是不会出现在当前列表里的，那个
   * "输完回车却什么都没发生"的表现比不给入口糟糕得多（踩过一次）。
   */
  const orderView = ordersOnly || specialOnly;
  /**
   * 创建栏实际在造什么。工单视图下锁死成"造工单" ——
   * 在这里造一条待办是不会出现在当前列表里的（工单视图不取待办），
   * 那个"输完回车却什么都没发生"的表现比不给入口糟糕得多。
   */
  const composeKind: "task" | "order" = orderView ? "order" : compose;

  const meta = VIEW_META[view] ?? VIEW_META.list;
  const HeaderIcon = meta.icon;

  // 背景：默认跟随视图渐变，选了壁纸就铺图 + 遮罩
  const bg = parseBackground(settings[SETTINGS.background]);
  const bgWallpaper = bg.kind === "image" && bg.file !== failedWallpaper ? bg : null;
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
        orders: "工单",
        special: "特殊单号",
      } as Record<string, string>
    )[view] ?? "任务";
  }, [view, activeListId, lists]);

  const accent =
    view === "list"
      ? (lists.find((l) => l.id === activeListId)?.color ?? "#d4537e")
      : meta.accent;

  // 分组排序全部交给 lib/rows.ts —— store 选第一条时用的是同一份，
  // 保证「高亮的行」和「右侧展开的详情」永远指同一条记录
  const grouped = useMemo(
    () => groupRows(tasks, orders, view),
    [tasks, orders, view],
  );

  const submit = async () => {
    if (!draft.trim()) return;
    if (composeKind === "task") {
      await addTask(draft, { repeat: draftDaily ? "daily" : "none" });
      setDraft("");
      setDraftDaily(false);
      return;
    }
    // 工单不在这里直接建：只填标题的话，建出来的是一张只有标题的半成品，
    // 还得回详情补流程/日期/备注。改成把标题带进完整表单一次填完。
    setOrderFormKind(specialOnly ? "special" : "normal");
    setOrderFormTitle(draft);
  };

  const isMyDay = view === "myday";
  const searching = search.trim().length > 0;
  const isEmpty = grouped.sections.every((s) => s.items.length === 0) && !grouped.done.length;

  // 特殊单号：正规的记录管理界面（搜索/分类/表格），不套用待办的轻松样式。
  // 它本质是"这批数据的管理台"，不是"今天做点什么"的清单 ——
  // 数据层完全共用（kind='special' 的工单），只是呈现不同。
  //
  // 全局搜索时仍走下面的通用结果列表：搜索是跨视图的"找到它"，
  // 记录视图自带的检索框才是"在这批单里翻账"，两回事。
  if (specialOnly && !searching) {
    return <SpecialOrdersView />;
  }

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

  const renderRow = (row: Row, i: number, items: Row[], showDate: boolean) =>
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
      data-bg-mode={bgWallpaper ? "image" : "auto"}
      data-bg-file={bgWallpaper?.file ?? ""}
    >
      {/* 壁纸层。放 -z-10 而不是做成普通子元素：
          绝对定位的元素会盖在普通流的兄弟节点之上（绘制顺序上"定位元素"晚于"块级元素"），
          列表行会被整块壁纸糊住；负 z-index + isolate 才是"垫在内容后面"的写法。 */}
      {bgWallpaper && (
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
          <img
            src={wallpaperUrl(bgWallpaper.file)}
            alt=""
            data-bg-image={bgWallpaper.file}
            className="size-full object-cover"
            // 图片缺失（比如换了机器没同步 public/wallpapers）时退回视图渐变，
            // 而不是留一块加载失败的空白
            onError={() => setFailedWallpaper(bgWallpaper.file)}
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
            onClick={() => setSortByDate((v) => !v)}
            className="grid size-8 place-items-center rounded-md bg-white/20 text-white hover:bg-white/30"
            title={sortByDate ? "按自定义顺序" : "按日期排序"}
          >
            <MoreHorizontal size={16} />
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
                {section.items.map((row, i) =>
                  renderRow(
                    row,
                    i,
                    section.items,
                    view === "all" ||
                      view === "list" ||
                      view === "orders" ||
                      view === "special",
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
              {specialOnly
                ? "还没有特殊单号"
                : ordersOnly
                  ? "还没有工单"
                  : isMyDay
                    ? "今天还没有安排"
                    : "这个列表还没有任务"}
            </p>
            <p className="max-w-[300px] text-[12px] leading-relaxed text-white/70">
              {specialOnly
                ? "在下方输入框建第一张：以快递单号为起点，每一步都带处理时效，超时会提醒"
                : ordersOnly
                  ? "在下方输入框建第一张工单；它会按所选流程一步步走，每走一步都留痕"
                  : isMyDay
                    ? "在下方输入框添加待办，或切到「工单」建一张要走流程的单子"
                    : "在下方输入框添加第一条任务；其他列表里的任务不会显示在这里"}
            </p>
          </div>
        )}

        {/* 已完成折叠区：待办已完成 + 工单已完结混在一起 */}
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

      {/* 底部创建栏：待办与工单共用一块，靠左侧开关切换在造什么 */}
      <div className="shrink-0 px-6 pb-5">
        <div className="rounded-lg bg-card px-4 py-3 shadow-[0_2px_8px_rgba(0,0,0,0.15)]">
          <div className="flex items-center gap-3">
            {/* 待办 / 工单 切换。工单视图下不给切换 —— 这里只可能造工单，
                摆一个"待办"按钮在这里是假入口（造完不会出现在当前列表） */}
            {orderView ? (
              <span
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-white"
                style={{ background: specialOnly ? "#d85a30" : "#378add" }}
              >
                {specialOnly ? <Timer size={12} /> : <ClipboardList size={12} />}
                {specialOnly ? "特殊单号" : "工单"}
              </span>
            ) : (
              <div className="flex shrink-0 items-center rounded-md bg-chip p-0.5">
                <ComposeTab
                  active={composeKind === "task"}
                  onClick={() => setCompose("task")}
                  icon={<Circle size={12} />}
                  label="待办"
                  accent={accent}
                />
                <ComposeTab
                  active={composeKind === "order"}
                  onClick={() => setCompose("order")}
                  icon={<ClipboardList size={12} />}
                  label="工单"
                  accent="#378add"
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
                  ? specialOnly
                    ? "快递单号，回车填写时效与相关信息"
                    : "工单标题，回车填写完整信息"
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
                  background: composeKind === "order" ? (specialOnly ? "#d85a30" : "#378add") : accent,
                }}
              >
                {composeKind === "order" ? (specialOnly ? "登记单号" : "创建工单") : "添加"}
              </button>
            )}
          </div>

          {/* 工单的流程 / 过程态 / 日期 / 备注都在弹窗里一次填完。
              这里不再摆第二份同样的选项 —— 两处都能改同一批参数，
              只会让人不确定到底以哪边为准。 */}
          {composeKind === "order" && (
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
              {/* 「我的一天」里要额外说一句：工单建出来**不会**出现在当前列表，
                  不说的话用户会以为没建成（和"在工单视图里造待办"是同一类坑） */}
              <span data-compose-hint="" className="min-w-0 flex-1 text-[11.5px] text-fg-dim">
                {isMyDay
                  ? "工单不进「我的一天」，建好后在侧边栏「工单」里看"
                  : specialOnly
                    ? "回车或点「登记单号」，弹窗里填时效与相关信息；时效是到下一步之前的时间"
                    : "回车或点「创建工单」，弹窗里一次填完流程、过程态、日期与备注"}
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

      {/* 新建工单弹窗。挂在最外层而不是创建栏里：它是整屏居中的浮层，
          塞进底部那一行的布局里会被父级的 overflow 裁掉 */}
      {orderFormTitle !== null && (
        <OrderCreateDialog
          // 同一个底部输入框，在「特殊单号」视图里装的是快递单号（那是起点），
          // 在别处装的是标题。灌错地方就等于让人白打一遍
          initialTitle={orderFormKind === "special" ? "" : orderFormTitle}
          initialNo={orderFormKind === "special" ? orderFormTitle : ""}
          initialKind={orderFormKind}
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

/** 创建器左上角的「待办 / 工单」切换按钮 */
function ComposeTab({
  active,
  onClick,
  icon,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      data-compose-tab={label}
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

/** 工单版的输入框前缀标记：圆角方块，和待办的圆形成对照 */
function OrderMark() {
  return (
    <span className="grid size-[22px] shrink-0 place-items-center rounded-[6px] border-[1.5px] border-[#378add]">
      <span className="block size-[8px] rounded-[2px] bg-[#378add]" />
    </span>
  );
}

export { CalendarDays, Trash2 };
