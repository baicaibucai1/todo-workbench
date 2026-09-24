import { useEffect } from "react";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import ToolArea from "./components/ToolArea";
import Settings from "./components/Settings";
import GalleryView from "./components/GalleryView";
import AgentBall from "./components/AgentBall";
import AgentWindow from "./components/AgentWindow";
import ReminderToast from "./components/ReminderToast";
import FlowEditor from "./components/FlowEditor";
import { useStore } from "./store";
import { pickActiveTool } from "./lib/tools";
import { applyTheme, SETTINGS, watchSystemTheme } from "./lib/settings";
import { PanelLeftOpen } from "lucide-react";

export default function App() {
  const {
    ready,
    init,
    initError,
    activeToolId,
    enabledTools,
    settingsOpen,
    settings,
    sidebarOpen,
    toggleSidebar,
    view,
  } = useStore();

  useEffect(() => {
    // ⚠️ 必须接住 rejection：初始化失败的锅大多是迁移 / 数据库，
    // 不接的话界面永远停在"正在初始化工作台…"，一行报错都没有
    // （0.2.0 实机白屏事件）。错误进 initError，由下面的渲染分支说出来。
    init().catch((e: unknown) => {
      useStore.setState({
        initError: e instanceof Error ? e.message : String(e),
      });
    });
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

  if (initError) {
    return (
      <div className="grid h-full place-items-center bg-surface px-6 text-center">
        <div className="max-w-[560px]">
          <div className="mb-2 text-[15px] text-fg">初始化失败了</div>
          <div className="break-all text-[13px] text-fg-dim">{initError}</div>
          <div className="mt-3 text-[12px] text-fg-dim">
            数据库迁移或读取出了问题，数据都还在。把上面这段文字发给开发者，
            比截图白屏有用得多。
          </div>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="grid h-full place-items-center bg-surface text-[13px] text-fg-dim">
        正在初始化工作台…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/*
        顶栏整条移除（2026-09-21 用户要求）：窗口用的是系统原生标题栏，
        这条 bar 不承担拖拽，只剩装饰性徽标。侧边栏收起后的恢复入口
        改成左上角悬浮按钮 —— 收起后侧边栏 return null，没有这个按钮
        就再也打不开了。
      */}
      {!sidebarOpen && (
        <button
          onClick={toggleSidebar}
          title="显示侧边栏"
          data-sidebar-reopen=""
          className="fixed left-2 top-2 z-30 grid size-7 place-items-center rounded-md bg-card text-fg-dim shadow-[0_1px_4px_rgba(0,0,0,0.18)] hover:bg-hover hover:text-fg"
        >
          <PanelLeftOpen size={14} />
        </button>
      )}

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

      {/*
        AI 助手：入口是一颗能拖动的悬浮球，窗口盖在主界面上（居中，见
        AgentWindow 的说明）。两者挂在这一层（和提醒弹窗同级）而不是塞进
        某一栏里 —— 侧栏收起、切视图、开设置都不该把它弄丢，
        而且它**不属于任何一栏**：侧栏里已经没有助手这一项了，球是唯一入口。
      */}
      <AgentBall />
      <AgentWindow />

      <ReminderToast />
      {/* 流程编辑器是全局弹层：入口有两个（流程任务详情、底部创建器），
          挂在这里才能保证只有一份实例 */}
      <FlowEditor />
    </div>
  );
}
