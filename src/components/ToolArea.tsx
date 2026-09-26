import { ArrowLeft, RotateCcw, X } from "lucide-react";
import { useStore } from "../store";
import { pickActiveTool } from "../lib/tools";
import { resolveIcon } from "../lib/icons";
import { isTauri } from "../lib/db";
import ToolFrame from "./ToolHost";
import type { ToolManifest } from "../types";

/**
 * 工具区：一个头部 + 一叠工具帧。
 *
 * ------------------------------------------------------------------
 * 「保持工具状态」在这里落地
 * ------------------------------------------------------------------
 * 打开过的工具不会被卸载，只是被隐藏（见 ToolHost 的 data-tool-layer）。
 * 于是切换工具、甚至切回待办再切回来，用户之前调的样式、载入的数据、
 * 翻到第几页都还在原位 —— 这正是改动之前最让人恼火的地方：
 * 切走一趟回来，工具又是一张白纸。
 *
 * 两个实现上的硬约束，都踩过：
 *
 *   1. **帧的 DOM 顺序必须稳定。** iframe 在 DOM 里挪一下浏览器就重新加载它，
 *      状态照样丢。所以这里按 aliveToolIds（打开顺序）渲染，绝不按"当前是否活跃"
 *      重排 —— 用 CSS 的 hidden / absolute 来切换可见性。
 *   2. **同一时刻只能有一个头部。** 头部画在每个帧里面的话，隐藏的帧也会留一个
 *      `<header>`，自动化里 `locator("header").last()` 就会抓到隐藏的那个。
 *      所以头部统一在这里渲染一次。
 *
 * 想释放资源：标签上的 × 关掉单个，或者关掉设置里的「保持工具状态」。
 */
export default function ToolArea({ visible }: { visible: boolean }) {
  const {
    enabledTools,
    activeToolId,
    aliveToolIds,
    openTool,
    closeTool,
    reloadTool,
  } = useStore();

  const active = pickActiveTool(enabledTools, activeToolId);

  // 按打开顺序取出仍在启用集合里的工具。顺序在这里定死，帧内不再排序。
  const mounted = aliveToolIds
    .map((id) => enabledTools.find((t) => t.id === id))
    .filter((t): t is ToolManifest => !!t);

  if (mounted.length === 0) return null;

  return (
    <div
      data-tools-area=""
      data-tools-visible={visible ? "1" : "0"}
      className={visible ? "flex min-h-0 min-w-0 flex-1 flex-col bg-surface" : "hidden"}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-card px-3">
        <button
          onClick={() => openTool(null)}
          title="回到待办（工具会继续留在后台，除非在设置里关掉了「保持工具状态」）"
          data-act="leave-tools"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-fg-3 hover:bg-hover"
        >
          <ArrowLeft size={15} />
          返回待办
        </button>
        <div className="h-5 shrink-0 w-px bg-chip" />

        {/* 标签条：这就是"多个工具同时活着"的可视化。只有一个工具时它看着像标题，
            但两种情况下语义一致 —— 点一下切过去，状态原地保留。 */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {mounted.map((t) => (
            <ToolTab
              key={t.id}
              tool={t}
              active={t.id === active?.id}
              onOpen={() => openTool(t.id)}
              onClose={() => closeTool(t.id)}
            />
          ))}
        </div>

        <button
          onClick={() => active && reloadTool(active.id)}
          disabled={!active}
          title="重新加载当前工具，清掉它现在这个状态"
          data-act="reload-tool"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-fg-3 hover:bg-hover disabled:opacity-40"
        >
          <RotateCcw size={13} />
          重置
        </button>
        <span className="shrink-0 text-[11.5px] text-fg-dim">
          {isTauri() ? "已加载本地工具" : "浏览器模式 · 工具直载"}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        {mounted.map((t) => (
          <ToolFrame key={t.id} tool={t} active={t.id === active?.id} />
        ))}
      </div>

      {/* 全部隐藏时这几行在语义上仍然有意义：告诉读屏与自动化"这里有几个工具活着" */}
      <span className="sr-only" data-tools-mounted={mounted.length}>
        {mounted.length} 个工具保持运行
      </span>
    </div>
  );
}

/**
 * 一个工具标签。
 *
 * 名字与关闭是**两个并列的按钮**，不是按钮套按钮 —— 后者是无效 HTML，
 * 浏览器会把内层按钮提到外面，点击行为变得不可预测（而这类问题
 * 只在某些浏览器上出现，很难查）。
 */
function ToolTab({
  tool,
  active,
  onOpen,
  onClose,
}: {
  tool: ToolManifest;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const Icon = resolveIcon(tool.icon);
  return (
    <div
      data-tool-tab={tool.id}
      data-tab-active={active ? "1" : "0"}
      title={tool.description}
      className={`flex shrink-0 items-center gap-1 rounded-md border pl-1.5 pr-0.5 py-0.5 transition-colors ${
        active ? "border-primary bg-primary/10" : "border-transparent hover:bg-hover"
      }`}
    >
      <button onClick={onOpen} className="flex min-w-0 items-center gap-1.5 py-1">
        <Icon size={14} className={active ? "shrink-0 text-primary" : "shrink-0 text-fg-dim"} />
        <span className={`max-w-[150px] truncate text-[12.5px] ${active ? "text-fg" : "text-fg-3"}`}>
          {tool.name}
        </span>
        {active && (
          <span className="shrink-0 rounded bg-chip px-1 py-px text-[10.5px] text-fg-dim">
            v{tool.version}
          </span>
        )}
      </button>
      <button
        onClick={onClose}
        data-tool-tab-close={tool.id}
        title={`关闭「${tool.name}」（释放它占用的内存与后台计算）`}
        className="grid size-4 shrink-0 place-items-center rounded text-fg-dim hover:bg-chip hover:text-fg-2"
      >
        <X size={11} />
      </button>
    </div>
  );
}
