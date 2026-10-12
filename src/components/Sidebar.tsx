import { useCallback, useEffect, useState } from "react";
import {
  Sun,
  Star,
  Inbox,
  Plus,
  Search,
  X,
  LayoutList,
  PanelLeftClose,
  Package,
  Pencil,
  ClipboardList,
  Timer,
  Images,
  FolderOpen,
  Trash2,
  Settings2,
} from "lucide-react";
import { useStore } from "../store";
import { fetchCounts } from "../lib/repo";
import { ICONS } from "../lib/icons";
import { DEFAULT_PROFILE, SETTINGS, SIDEBAR_WIDTH, parseSidebarWidth } from "../lib/settings";
import { useDragWidth } from "../lib/useDragWidth";
import {
  parseSidebarOrder,
  resolveSidebarOrder,
  sidebarKind,
} from "../lib/sidebarOrder";

import UrgentPanel from "./UrgentPanel";
import ResizeHandle from "./ResizeHandle";
import type { SmartView } from "../types";
import { navItems } from "../lib/extensions/registry";
import type { ExtensionIconName } from "../lib/extensions/types";

/**
 * 注册表里那个字符串 → 真正的图标组件。
 *
 * 只认白名单里的几个名字（见 types.ts 的 ExtensionIconName），
 * 所以外部输入（工具的 manifest）到不了引入任意组件这一步。
 */
const EXT_ICONS: Record<ExtensionIconName, typeof Sun> = {
  sun: Sun,
  star: Star,
  inbox: Inbox,
  "clipboard-list": ClipboardList,
  timer: Timer,
  images: Images,
  sparkles: Star,
  package: Package,
  "folder-open": FolderOpen,
};

export default function Sidebar() {
  const {
    lists,
    // 侧边栏只列**启用中**的工具；被停用的那些在设置 → 工具里还能看到与恢复
    enabledTools,
    view,
    activeListId,
    activeToolId,
    sidebarOpen,
    setView,
    openTool,
    toggleSidebar,
    addList,
    renameList,
    removeList,
    search,
    setSearch,
    settings,
    settingsOpen,
    openSettings,
    saveSettings,
  } = useStore();

  /**
   * 侧栏项由注册表给：哪些视图存在、它们的模块开着没有，
   * 都不再写在这个组件里（见 lib/extensions/registry.ts 的 BUILTIN）。
   * **顺序**则归设置管（behavior.sidebarOrder），见下面 stream 的构造。
   *
   * 关掉一个模块时**入口整个消失，数据留着** —— 例如特殊单号那批记录
   * 仍在「流程任务」列表里，开关一打开就全回来。
   */
  const taskNav = navItems(settings, "tasks");
  const placeNav = navItems(settings, "places");

  // 个人资料来自配置表，不再写死在界面上
  const profileName = settings[SETTINGS.profileName] ?? "";
  const profileEmail = settings[SETTINGS.profileEmail] ?? "";
  const profileColor = settings[SETTINGS.profileColor] ?? DEFAULT_PROFILE.color;
  const initial = profileName.trim()[0] ?? "?";

  const [counts, setCounts] = useState<{
    myday: number;
    all: number;
    /** 未完结流程任务数，给「流程任务」入口当角标 */
    orders: number;
    /** 图床条目总数（不是"未完结"，图床没有完成态） */
    imagebed: number;
    byList: Record<string, number>;
  }>({ myday: 0, all: 0, orders: 0, imagebed: 0, byList: {} });

  const [addingList, setAddingList] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // 角标数字随任务变化刷新
  useEffect(() => {
    void fetchCounts().then(setCounts);
  }, [lists, activeListId, view, activeToolId]);

  // 紧凑模式取消之后，宽度就只剩"拖右边缘"这一条路了。
  // 侧栏贴着窗口左边，所以往右拖 = 变宽。
  const width = useDragWidth({
    storedWidth: parseSidebarWidth(settings[SETTINGS.sidebarWidth]),
    min: SIDEBAR_WIDTH.min,
    max: SIDEBAR_WIDTH.max,
    defaultWidth: SIDEBAR_WIDTH.default,
    edge: "right",
    onCommit: useCallback(
      (w: number) => void saveSettings({ [SETTINGS.sidebarWidth]: String(w) }),
      [saveSettings],
    ),
  });

  /** 角标数字：只有"未完结"那类才标，免得每个入口都挂个数字看着累 */
  const badge = (key: SmartView): number | undefined => {
    if (key === "myday") return counts.myday;
    if (key === "all") return counts.all;
    if (key === "orders") return counts.orders;
    // 图床是个例外：它没有"未完结"的概念，标的是总数 ——
    // 用户想知道的是"里面有多少素材"，而不是"还剩几件没处理"
    if (key === "imagebed") return counts.imagebed;
    return undefined;
  };

  if (!sidebarOpen) return null;

  const submitAdd = async () => {
    if (draftName.trim()) await addList(draftName);
    setDraftName("");
    setAddingList(false);
  };

  /*
   * ---------------------------- 侧栏那一竖列的顺序 ----------------------------
   *
   * 这里把三种来源拍成一条线：智能视图 → 工具 → 清单。
   *
   * live 的给法**就是默认顺序** —— 用户没排过（设置里是空数组）时，
   * resolveSidebarOrder 算出来的结果与"各来源各排"逐行相同，也就是这个功能
   * 上线前的样子。排过之后才按他给的来。
   *
   * ⚠️ **「位置」类入口（图床 / 工作区）不在这条线里**：它们固定在侧栏最底部、
   * 挨着「设置」（见文件末尾那一块，以及 lib/sidebarOrder.ts 顶上的说明）。
   *
   * 补位规则、键前缀、脏数据怎么兜，全在 lib/sidebarOrder.ts。
   */
  const liveKeys = [
    ...taskNav.map((i) => `nav:${i.id}`),
    ...enabledTools.map((t) => `tool:${t.id}`),
    ...lists.map((l) => `list:${l.id}`),
  ];
  const order = resolveSidebarOrder(
    parseSidebarOrder(settings[SETTINGS.sidebarOrder]),
    liveKeys,
  );

  /** 按一个稳定键渲染出那一行；键对应的东西已经不在了（停用/删除）就返回 null */
  const rowFor = (key: string): React.ReactNode => {
    const kind = sidebarKind(key);
    if (!kind) return null;
    const id = key.slice(key.indexOf(":") + 1);

    if (kind === "nav") {
      const item = taskNav.find((n) => n.id === id);
      if (!item) return null;
      const Icon = EXT_ICONS[item.icon ?? "package"];
      return (
        <NavRow
          key={key}
          navKey={item.id}
          icon={<Icon size={16} />}
          label={item.label}
          active={view === item.id && !activeToolId}
          count={badge(item.id as SmartView)}
          accent="var(--color-accent)"
          onClick={() => void setView(item.id as SmartView)}
        />
      );
    }

    if (kind === "tool") {
      const tool = enabledTools.find((t) => t.id === id);
      if (!tool) return null;
      const Icon = ICONS[tool.icon ?? "package"] ?? Package;
      return (
        <NavRow
          key={key}
          navKey={`tool:${tool.id}`}
          icon={<Icon size={16} />}
          label={tool.name}
          active={activeToolId === tool.id}
          accent="var(--color-primary)"
          onClick={() => openTool(tool.id)}
        />
      );
    }

    const list = lists.find((l) => l.id === id);
    if (!list) return null;

    if (editingId === list.id) {
      return (
        <div key={key} className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <span className="size-3.5 shrink-0 rounded-full" style={{ background: list.color }} />
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={() => {
              void renameList(list.id, editName);
              setEditingId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditingId(null);
            }}
            className="min-w-0 flex-1 rounded border border-accent bg-card px-1.5 py-0.5 text-[13px] outline-none"
          />
        </div>
      );
    }

    return (
      <div key={key} className="group/row relative">
        <NavRow
          navKey={`list:${list.id}`}
          icon={
            <span className="block size-3.5 rounded-full" style={{ background: list.color }} />
          }
          label={list.name}
          active={view === "list" && activeListId === list.id && !activeToolId}
          count={counts.byList[list.id]}
          accent={list.color}
          onClick={() => void setView("list", list.id)}
        />
        <div className="absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-0.5 group-hover/row:flex">
          <button
            title="重命名"
            onClick={(e) => {
              e.stopPropagation();
              setEditingId(list.id);
              setEditName(list.name);
            }}
            className="grid size-6 place-items-center rounded bg-panel text-fg-dim hover:bg-hover"
          >
            <Pencil size={11} />
          </button>
          <button
            title="删除列表"
            onClick={(e) => {
              e.stopPropagation();
              void removeList(list.id);
            }}
            className="grid size-6 place-items-center rounded bg-panel text-fg-dim hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    );
  };

  /*
   * 「工具」小标题。它**不是**一行可排序的项 —— 工具被排到哪儿，
   * 它就跟着第一个工具走；一个工具都没有时，它回到视图组后面（原来的位置），
   * 后面补一句可操作的提示，而不是留一片空白让人以为功能坏了。
   */
  const toolsHeaderNode = (
    <div key="__tools_header">
      <div className="my-2 border-t border-line" />
      <div className="mt-1 mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium tracking-wide text-fg-dim">工具</span>
        <span className="rounded bg-chip px-1.5 py-px text-[10px] text-fg-dim">
          {enabledTools.length}
        </span>
      </div>
    </div>
  );

  const toolsEmptyNode = (
    <button
      key="__tools_empty"
      onClick={() => openSettings(true)}
      data-nav="tools-empty"
      className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] leading-relaxed text-fg-dim hover:bg-hover"
    >
      没有启用的工具，去「设置 → 工具」里装或启用
    </button>
  );

  /*
   * 清单段前的那条分隔线。
   *
   * ⚠️ 别省：工具段与清单段之间没有这条线，清单在视觉上就成了工具组的一截 ——
   *   用户看到的第一反应就是"清单怎么合并到工具里了"。段内的先后可以调，
   *   段与段的边界必须是看得见的。
   */
  const listsHeaderNode = (
    <div key="__lists_header">
      <div className="my-2 border-t border-line" />
      <div className="mt-1 mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium tracking-wide text-fg-dim">清单</span>
        <span className="rounded bg-chip px-1.5 py-px text-[10px] text-fg-dim">
          {lists.length}
        </span>
      </div>
    </div>
  );

  /** 「新建列表」是动作不是类目，不参与排序 —— 它跟在清单那一段的尾巴上 */
  const newListNode = addingList ? (
    <div key="__new_list" className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <LayoutList size={16} className="shrink-0 text-fg-dim" />
      <input
        autoFocus
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        placeholder="列表名称"
        onBlur={submitAdd}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraftName("");
            setAddingList(false);
          }
        }}
        className="min-w-0 flex-1 rounded border border-accent bg-card px-1.5 py-0.5 text-[13px] outline-none"
      />
    </div>
  ) : (
    <button
      key="__new_list"
      onClick={() => setAddingList(true)}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-fg-3 hover:bg-hover"
    >
      <Plus size={16} className="shrink-0 text-fg-dim" />
      <span className="text-[13px]">新建列表</span>
    </button>
  );

  // 把上面几种节点按 order 串起来，顺带决定两段标题插在哪、新建列表跟在哪
  const stream: React.ReactNode[] = [];
  const lastListIdx = order.reduce((a, k, i) => (sidebarKind(k) === "list" ? i : a), -1);
  let toolsHeaderDone = false;
  let listsHeaderDone = false;
  let newListDone = false;
  order.forEach((key, i) => {
    const kind = sidebarKind(key);
    // 两段的标题都锚在本段第一行前；段为空时也照样出现（位置见下面兜底）
    if (kind === "tool" && !toolsHeaderDone) {
      toolsHeaderDone = true;
      stream.push(toolsHeaderNode);
    }
    if (kind === "list" && !listsHeaderDone) {
      listsHeaderDone = true;
      stream.push(listsHeaderNode);
    }
    const row = rowFor(key);
    if (row) stream.push(row);
    if (i === lastListIdx) {
      newListDone = true;
      stream.push(newListNode);
    }
  });
  // 段为空时没有行可锚，标题按固定次序补在末尾：工具段在前、清单段在后
  if (!toolsHeaderDone) stream.push(toolsHeaderNode, toolsEmptyNode);
  if (!listsHeaderDone) stream.push(listsHeaderNode);
  if (!newListDone) stream.push(newListNode);

  return (
    <aside
      data-sidebar-width={width.width}
      className="relative flex h-full shrink-0 flex-col border-r border-line bg-panel"
      style={{ width: width.width }}
    >
      <ResizeHandle
        api={width}
        side="right"
        resizerKey="sidebar"
        label="拖动调整侧边栏宽度"
      />
      {/* 账户区 */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => openSettings(true)}
            data-nav="profile"
            title="个人资料与设置"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left"
          >
            <span
              data-profile-avatar=""
              className="grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-medium text-white"
              style={{ background: profileColor }}
            >
              {initial}
            </span>
            <span className="min-w-0 flex-1">
              <span
                data-profile-name=""
                className="block truncate text-[13px] font-medium text-fg"
              >
                {profileName.trim() || "未设置昵称"}
              </span>
              <span className="block truncate text-[11px] text-fg-dim">
                {profileEmail.trim() || "点击设置个人资料"}
              </span>
            </span>
          </button>
          <button
            onClick={toggleSidebar}
            title="收起侧边栏"
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-dim hover:bg-hover"
          >
            <PanelLeftClose size={15} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="mt-3 flex h-8 items-center gap-1.5 rounded-md border border-line bg-card px-2.5 focus-within:border-accent">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-fg-dim"
          />
          {search ? (
            <button
              onClick={() => setSearch("")}
              className="grid size-4 place-items-center rounded text-fg-dim hover:bg-hover"
            >
              <X size={12} />
            </button>
          ) : (
            <Search size={13} className="shrink-0 text-fg-dim" />
          )}
        </div>
      </div>

      {/*
        侧栏那一竖列 —— 视图、工具、清单、位置**混在同一条线里**，
        顺序由 stream 决定（settings.behavior.sidebarOrder，见 lib/sidebarOrder.ts）。
        data-sidebar-order 是给自动化看的口径：它就是这一列现在的真实顺序。
      */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        data-sidebar-order={order.join(",")}
      >
        {stream}
      </div>

      {/* 底部：紧急区 —— 快到点的待办与流程任务自动出现在这里，阈值在设置里调 */}
      <UrgentPanel />

      {/*
        底部：图床这一类"可以去的地方"。
        它和上面的视图组不是一回事 —— 上半栏回答"看哪些任务"，
        这里回答"这个程序里还有什么地方可去"。

        ⚠️ **这一块不参与侧栏排序**（lib/sidebarOrder.ts）：它属于"位置"，
        贴在最底部与「设置」挨着是 2026-09-22 定下的取舍，
        tests/browser.mjs 有一条断言盯着「图床紧挨在设置上面」。

        AI 助手**不在这张单子里**：它是一扇浮层窗口，入口只有右下角那颗
        能拖动的球（见 AgentBall.tsx）。2026-09-23 用户要求把侧栏这一项去掉 ——
        同一件事摆两个入口，用户先要猜哪个才是"真的"，
        而高亮态还得分神去跟窗口开合。留一个就够了。
      */}
      {placeNav.length > 0 && (
        <div className="border-t border-line px-2 pt-2">
          {placeNav.map((item) => {
            const Icon = EXT_ICONS[item.icon ?? "package"];
            return (
              <NavRow
                key={item.id}
                navKey={item.id}
                icon={<Icon size={16} />}
                label={item.label}
                active={view === item.id && !activeToolId}
                count={badge(item.id as SmartView)}
                accent="var(--color-accent)"
                onClick={() => void setView(item.id as SmartView)}
              />
            );
          })}
        </div>
      )}
      <div className="px-2 pt-1 pb-2">
        <button
          onClick={() => openSettings(true)}
          data-nav="settings"
          className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-hover ${
            settingsOpen ? "bg-chip font-medium text-fg" : "text-fg-3"
          }`}
        >
          <Settings2 size={16} className="shrink-0 text-fg-dim" />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

function NavRow({
  icon,
  label,
  count,
  active,
  accent,
  onClick,
  navKey,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  accent: string;
  onClick: () => void;
  /** 自动化验证用的稳定选择器（视图名 / 工具 id / 列表 id） */
  navKey?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-nav={navKey}
      className={`group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? "bg-chip" : "hover:bg-hover"
      }`}
    >
      {/* 选中态左侧色条，还原 To Do 的视觉语言 */}
      {active && (
        <span
          className="absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-r-full"
          style={{ background: accent }}
        />
      )}
      <span
        className="grid size-4 shrink-0 place-items-center"
        style={{ color: active ? accent : "var(--color-fg-3)" }}
      >
        {icon}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[13px] ${
          active ? "font-medium text-fg" : "text-fg-2"
        }`}
      >
        {label}
      </span>
      {count ? (
        <span className="shrink-0 rounded-full bg-chip px-1.5 py-px text-[11px] text-fg-3">
          {count}
        </span>
      ) : null}
    </button>
  );
}
