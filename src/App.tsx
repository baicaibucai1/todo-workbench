import { useEffect } from "react";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import ToolHost from "./components/ToolHost";
import Settings from "./components/Settings";
import GalleryView from "./components/GalleryView";
import ReminderToast from "./components/ReminderToast";
import FlowEditor from "./components/FlowEditor";
import { useStore } from "./store";
import { applyTheme, SETTINGS, watchSystemTheme } from "./lib/settings";
import { Database, Package } from "lucide-react";

export default function App() {
  const {
    ready,
    init,
    activeToolId,
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
        {settingsOpen ? (
          <Settings />
        ) : activeToolId ? (
          <ToolHost />
        ) : view === "gallery" ? (
          <GalleryView />
        ) : (
          <TaskList />
        )}
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
