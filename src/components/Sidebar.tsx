import { useCallback, useEffect, useState } from "react";
import {
  Sun,
  Star,
  CalendarDays,
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
  Trash2,
  Settings2,
} from "lucide-react";
import { useStore } from "../store";
import { fetchCounts } from "../lib/repo";
import { ICONS } from "../lib/icons";
import {
  DEFAULT_PROFILE,
  SETTINGS,
  SIDEBAR_WIDTH,
  parseSidebarWidth,
} from "../lib/settings";
import { useDragWidth } from "../lib/useDragWidth";

import UrgentPanel from "./UrgentPanel";
import ResizeHandle from "./ResizeHandle";
import type { SmartView } from "../types";

const SMART_ITEMS: Array<{
  key: SmartView;
  label: string;
  icon: typeof Sun;
  /** To Do 里该条目的强调色 */
  color?: string;
}> = [
  { key: "myday", label: "我的一天", icon: Sun },
  { key: "important", label: "重要", icon: Star },
  { key: "planned", label: "计划内", icon: CalendarDays },
  { key: "all", label: "全部", icon: Inbox },
  // 工单的专属入口。工单平时也混在「全部」里，但想"只看手上的单子"就有地方去了
  { key: "orders", label: "工单", icon: ClipboardList },
  // 特殊单号：工单里**带处理时效**的那一类（以快递单号为起点）。
  // 它不是另一种记录，是工单的真子集 —— 所以这些单子同时照旧出现在「工单」里。
  // 单独给个入口，是因为它们的价值就在"等不起"：在几十张工单里
  // 翻哪一张快超时，是件很难受的事。
  { key: "special", label: "特殊单号", icon: Timer },
  // 图库：与上面几项**不同类** —— 前几项都是"待办的某种筛选"，
  // 它是独立素材库。放在这一组里而不是工具区，理由见 types.SmartView。
  { key: "gallery", label: "图库", icon: Images },
];

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

  // 个人资料来自配置表，不再写死在界面上
  const profileName = settings[SETTINGS.profileName] ?? "";
  const profileEmail = settings[SETTINGS.profileEmail] ?? "";
  const profileColor = settings[SETTINGS.profileColor] ?? DEFAULT_PROFILE.color;
  const initial = profileName.trim()[0] ?? "?";

  const [counts, setCounts] = useState<{
    myday: number;
    all: number;
    /** 未完结工单数，给「工单」入口当角标 */
    orders: number;
    /** 未完结的特殊单号数，给「特殊单号」入口当角标 */
    special: number;
    /** 图库条目总数（不是"未完结"，图库没有完成态） */
    gallery: number;
    byList: Record<string, number>;
  }>({ myday: 0, all: 0, orders: 0, special: 0, gallery: 0, byList: {} });

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
    if (key === "special") return counts.special;
    // 图库是个例外：它没有"未完结"的概念，标的是总数 ——
    // 用户想知道的是"里面有多少素材"，而不是"还剩几件没处理"
    if (key === "gallery") return counts.gallery;
    return undefined;
  };

  if (!sidebarOpen) return null;

  const submitAdd = async () => {
    if (draftName.trim()) await addList(draftName);
    setDraftName("");
    setAddingList(false);
  };

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
        <div className="mt-3 flex h-8 items-center gap-1.5 rounded-md border border-line bg-card px-2.5 focus-within:border-[#d4537e]">
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

      {/* 智能视图 + 清单 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {SMART_ITEMS.map((item) => (
          <NavRow
            key={item.key}
            navKey={item.key}
            icon={<item.icon size={16} />}
            label={item.label}
            active={view === item.key && !activeToolId}
            count={badge(item.key)}
            accent="#d4537e"
            onClick={() => void setView(item.key)}
          />
        ))}

        <div className="my-2 border-t border-line" />

        {/* 工具区 —— 工作台的可扩展部分 */}
        <div className="mt-1 mb-1 flex items-center justify-between px-2">
          <span className="text-[11px] font-medium tracking-wide text-fg-dim">
            工具
          </span>
          <span className="rounded bg-chip px-1.5 py-px text-[10px] text-fg-dim">
            {enabledTools.length}
          </span>
        </div>

        {enabledTools.map((tool) => {
          const Icon = ICONS[tool.icon ?? "package"] ?? Package;
          return (
            <NavRow
              key={tool.id}
              navKey={`tool:${tool.id}`}
              icon={<Icon size={16} />}
              label={tool.name}
              active={activeToolId === tool.id}
              accent="#378add"
              onClick={() => openTool(tool.id)}
            />
          );
        })}

        {/* 工具全被停用/卸载时给一句可操作的话，而不是留一片空白 ——
            空白会让人以为工具功能坏了，而它其实在设置里等着被启用 */}
        {enabledTools.length === 0 && (
          <button
            onClick={() => openSettings(true)}
            data-nav="tools-empty"
            className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] leading-relaxed text-fg-dim hover:bg-hover"
          >
            没有启用的工具，去「设置 → 工具」里装或启用
          </button>
        )}

        <>
          <div className="my-2 border-t border-line" />

          {lists.map((list) => (
              <div key={list.id} className="group/row relative">
                {editingId === list.id ? (
                  <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
                    <span
                      className="size-3.5 shrink-0 rounded-full"
                      style={{ background: list.color }}
                    />
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
                      className="min-w-0 flex-1 rounded border border-[#d4537e] bg-card px-1.5 py-0.5 text-[13px] outline-none"
                    />
                  </div>
                ) : (
                  <>
                    <NavRow
                      navKey={`list:${list.id}`}
                      icon={
                        <span
                          className="block size-3.5 rounded-full"
                          style={{ background: list.color }}
                        />
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
                  </>
                )}
              </div>
            ))}

            {addingList ? (
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
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
                  className="min-w-0 flex-1 rounded border border-[#d4537e] bg-card px-1.5 py-0.5 text-[13px] outline-none"
                />
              </div>
            ) : (
              <button
                onClick={() => setAddingList(true)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-fg-3 hover:bg-hover"
              >
                <Plus size={16} className="shrink-0 text-fg-dim" />
                <span className="text-[13px]">新建列表</span>
              </button>
            )}
        </>
      </div>

      {/* 底部：紧急区 —— 快到点的待办与工单自动出现在这里，阈值在设置里调 */}
      <UrgentPanel />

      {/* 底部：设置入口 */}
      <div className="border-t border-line px-2 py-2">
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
        style={{ color: active ? accent : "#5a5955" }}
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
