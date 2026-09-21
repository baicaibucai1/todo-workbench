import { useEffect } from "react";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import ToolArea from "./components/ToolArea";
import Settings from "./components/Settings";
import GalleryView from "./components/GalleryView";
import ReminderToast from "./components/ReminderToast";
import FlowEditor from "./components/FlowEditor";
import { useStore } from "./store";
import { pickActiveTool } from "./lib/tools";
import { applyTheme, SETTINGS, watchSystemTheme } from "./lib/settings";
import { Database, Package } from "lucide-react";

export default function App() {
  const {
    ready,
    init,
    activeToolId,
    enabledTools,
    settingsOpen,
    settings,
    sidebarOpen,
    toggleSidebar,
    dbInfo,
    view,
  } = useStore();

  useEffect(() => {
    void init();
  }, [init]);

  // 「跟随系统」要能跟着 Windows 的深浅色设置实时变，不能只在启动时算一次
  const theme = settings[SETTINGS.theme];
  useEffect(() => {
    if (theme !== "system") return;
    applyTheme("system");
    return watchSystemTheme(() => applyTheme("system"));
  }, [theme]);

  // 提醒扫描：定时跑 + 窗口重新可见时立刻跑一次
  // （休眠唤醒后间隔回调可能滞后，回到前台时补一次更符合直觉）
  const checkReminders = useStore((s) => s.checkReminders);
  useEffect(() => {
    if (!ready) return;
    void checkReminders();
    const timer = window.setInterval(() => void checkReminders(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkReminders();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, checkReminders]);

  /**
   * 当前是否真的显示着工具。
   *
   * 用的是 pickActiveTool：activeToolId 可能指向一个已经被停用/卸载的工具，
   * 那时"有 id"不等于"有工具可显示"。工具区内部用同一个函数判断，
   * 两边不会漂移（各写一遍 find 迟早变成一边显示空白、一边显示待办）。
   */
  const toolVisible = !!pickActiveTool(enabledTools, activeToolId) && !settingsOpen;

  if (!ready) {
    return (
      <div className="grid h-full place-items-center bg-surface text-[13px] text-fg-dim">
        正在初始化工作台…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 标题栏，模仿应用窗口顶栏 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        {!sidebarOpen && (
          <button
            onClick={toggleSidebar}
            className="rounded px-1.5 py-0.5 text-[12px] text-fg-3 hover:bg-hover"
          >
            显示侧边栏
          </button>
        )}
        <span className="text-[12px] text-fg-dim">待办工作台</span>
        <div className="flex-1" />
        <StatusPill
          icon={<Database size={11} />}
          label={dbInfo?.driver === "sqlite" ? "SQLite" : "内存库"}
          tone={dbInfo?.driver === "sqlite" ? "good" : "warn"}
        />
        <StatusPill
          icon={<Package size={11} />}
          label={`schema v${dbInfo?.schemaVersion ?? "-"}`}
          tone="plain"
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/*
          工具区与主内容区是**并存**的两层，不是二选一。
          工具区常驻挂载（切走只隐藏），所以它必须能独立于待办/图库/设置存在。
          可见性只有一处判断，两边的表达式必须互补 —— 否则会出现
          "工具区和待办同时显示"或"两个都不显示"这种一眼可见的空白。
        */}
        <ToolArea visible={toolVisible} />
        <div className={toolVisible ? "hidden" : "flex min-h-0 min-w-0 flex-1"}>
          {settingsOpen ? (
            <Settings />
          ) : view === "gallery" ? (
            <GalleryView />
          ) : (
            <TaskList />
          )}
        </div>
        {/* 详情面板常驻渲染，靠宽度收放做滑入/滑出；开不展开由它自己判断 */}
        <TaskDetail />
      </div>

      <ReminderToast />
      {/* 流程编辑器是全局弹层：入口有两个（工单详情、底部创建器），
          挂在这里才能保证只有一份实例 */}
      <FlowEditor />
    </div>
  );
}

function StatusPill({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "good" | "warn" | "plain";
}) {
  const styles = {
    good: "text-[#0f6e56] bg-[#e1f5ee]",
    warn: "text-[#854f0b] bg-[#faeeda]",
    plain: "text-fg-3 bg-chip",
  }[tone];

  return (
    <span
      className={`flex items-center gap-1 rounded px-1.5 py-px text-[11px] ${styles}`}
      title={
        tone === "warn"
          ? "浏览器演示模式：数据存在 localStorage，打包后自动切换到 SQLite 文件"
          : undefined
      }
    >
      {icon}
      {label}
    </span>
  );
}
