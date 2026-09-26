/**
 * 注入组件 —— 工具把自己的一部分**嵌进宿主界面**。
 *
 * ============================ 它和整页工具有什么不同 ============================
 *
 * 整页工具占工具区那一大片，和"当前在看哪条待办"没关系。
 * 注入组件相反：它挂在**某一条待办**上（详情面板底部 / 详情头部按钮 / 行内按钮），
 * 宿主把"你正在替谁干活"通过 tool:context 投给它，它据此渲染。
 *
 * 同一个组件挂在两条待办上是**两个 iframe 实例**、两份上下文，
 * 互不干扰 —— 这也是为什么它必须是 iframe 而不是 React 组件：
 * 工具是运行时装进来的 HTML，宿主的构建产物里没有它。
 *
 * ============================ 边界 ============================
 *
 * 注入组件**只读**：它能调 `task.get` 读挂着的那一条，没有写接口 ——
 * 改待办只能走宿主的界面或助手的日程动作。这条边界落在 toolBridge，
 * 这里只负责把它挂到正确的位置上、并把 taskId 交给桥。
 *
 * 停用工具 = 不该再出现：这一层的工具表取自 store 的 enabledTools
 * （已经过滤过停用），所以停用一个工具，它在每条待办上的入口一起收起。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Puzzle } from "lucide-react";
import { createToolBridge, type ToolBridge } from "../lib/toolBridge";
import { resolveToolUrl } from "../lib/tools";
import { injectsFor } from "../lib/extensions/registry";
import { ensureToolSchema, validateToolSchema, type ValidatedTable } from "../lib/toolSchema";
import { useStore } from "../store";
import type { ToolInjectSpec } from "../lib/extensions/types";
import type { ToolManifest } from "../types";

/* ------------------------------------------------------------------ */
/* 一个挂载好的组件                                                     */
/* ------------------------------------------------------------------ */

function InjectedFrame({
  tool,
  spec,
  taskId,
  height,
}: {
  tool: ToolManifest;
  spec: ToolInjectSpec;
  taskId: string;
  height: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<ToolBridge | null>(null);
  const tablesRef = useRef<ValidatedTable[]>([]);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(null);
    void resolveToolUrl(tool).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      // 入口找不到就明说，而不是留一个白屏 iframe —— 白屏是最没有信息量的反馈
      else setFailed("找不到这个工具的入口文件");
    });
    return () => {
      alive = false;
    };
  }, [tool]);

  // 组件也可能有自己的私有表（比如"这条待办的配图记录"），挂载时建好，
  // 与整页工具同一套规则：dbVersion 变了才重跑 DDL
  useEffect(() => {
    const schema = validateToolSchema(tool.id, tool.schema);
    if (!schema) {
      tablesRef.current = [];
      return;
    }
    let alive = true;
    void ensureToolSchema(tool.id, tool.dbVersion, schema)
      .then((built) => {
        if (alive) tablesRef.current = built.tables;
      })
      .catch(() => {
        if (alive) tablesRef.current = [];
      });
    return () => {
      alive = false;
    };
  }, [tool.id, tool.dbVersion, tool.schema]);

  useEffect(() => {
    if (!url) return;
    const bridge = createToolBridge(tool.id, () => frameRef.current, {
      getTables: () => tablesRef.current,
      getSettings: () => useStore.getState().settings,
      // 这就是"替谁干活"：桥据此回答 task.get，也据此拒绝越界的读取
      getInject: () => ({ kind: spec.kind, taskId }),
    });
    bridgeRef.current = bridge;
    bridge.attach();

    // 主题变了要让组件知道，否则宿主切深色、组件还是一块白
    const observer = new MutationObserver(() => bridge.pushContext());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      observer.disconnect();
      bridge.detach();
      bridgeRef.current = null;
    };
  }, [url, tool.id, spec.kind, taskId]);

  /*
   * 上下文**必须在桥建好之后**再推一次。
   *
   * 光靠 iframe 的 onLoad 是不够的：本地文件/asset 协议加载极快，
   * load 事件常常早于建桥那个 effect —— 那时 bridgeRef 还是 null，
   * 这一次 postMessage 就投进了虚空（**不报错，也没人收到**），
   * 表现是组件永远停在"等上下文"。
   */
  useEffect(() => {
    if (loaded) bridgeRef.current?.pushContext();
  }, [loaded, url, tool.id, spec.kind, taskId]);

  if (failed) {
    return (
      <div data-inject-error={tool.id} className="px-1 py-1 text-[12px] text-fg-dim">
        {failed}
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      src={url ?? undefined}
      title={spec.label || tool.name}
      data-inject-frame={tool.id}
      data-inject-kind={spec.kind}
      data-inject-task={taskId}
      className="w-full border-0"
      style={{ height }}
      onLoad={() => {
        setLoaded(true);
        bridgeRef.current?.pushContext();
      }}
      // 与整页工具同一套约束：能跑脚本、能下载，但不给它同源权限
      sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-forms allow-popups"
    />
  );
}

/* ------------------------------------------------------------------ */
/* 详情面板底部的分区                                                   */
/* ------------------------------------------------------------------ */

export function InjectedDetailSections({ taskId }: { taskId: string }) {
  const tools = useStore((s) => s.enabledTools);
  const entries = injectsFor(tools, "detailSection");
  if (!entries.length) return null;

  return (
    <>
      {entries.map((e) => (
        <div key={e.toolId} data-inject-section={e.toolId} className="mt-4 px-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-dim">
            <Puzzle size={12} />
            {e.spec.label || e.name}
          </div>
          <div className="overflow-hidden rounded-lg border border-line">
            <InjectedFrame
              tool={tools.find((t) => t.id === e.toolId)!}
              spec={e.spec}
              taskId={taskId}
              height={e.spec.height ?? 180}
            />
          </div>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 按钮型（详情头部 / 行内）                                            */
/* ------------------------------------------------------------------ */

/**
 * 按钮 + 点开的面板。
 *
 * 面板高度写死 320：注入组件是**配角**，它不该把详情面板或列表行顶满；
 * 需要更高就用 detailSection 那种常驻分区。
 */
const PANEL_HEIGHT = 320;

function ActionButtons({
  taskId,
  kind,
  compact,
}: {
  taskId: string;
  kind: "detailAction" | "rowAction";
  compact?: boolean;
}) {
  const tools = useStore((s) => s.enabledTools);
  const entries = injectsFor(tools, kind);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!entries.length) return null;

  const open = openId ? entries.find((e) => e.toolId === openId) : null;

  return (
    <div className={compact ? "relative flex items-center gap-0.5" : "relative"}>
      {entries.map((e) => (
        <button
          key={e.toolId}
          data-inject-action={e.toolId}
          data-inject-kind={kind}
          title={e.name}
          onClick={() => setOpenId((v) => (v === e.toolId ? null : e.toolId))}
          className={`flex items-center gap-1 rounded text-fg-dim hover:bg-hover ${
            compact ? "grid size-7 place-items-center" : "px-2 py-1 text-[12.5px]"
          } ${openId === e.toolId ? "bg-hover text-fg-2" : ""}`}
        >
          <Puzzle size={compact ? 15 : 13} />
          {compact ? null : (e.spec.label || e.name)}
          {compact ? null : <ChevronDown size={12} />}
        </button>
      ))}

      {open && (
        <div
          data-inject-panel={open.toolId}
          className="absolute right-0 top-full z-20 mt-1 w-[min(420px,80vw)] overflow-hidden rounded-lg border border-line bg-card shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 text-[12px] text-fg-2">
            <span>{open.spec.label || open.name}</span>
            <button
              data-inject-close={open.toolId}
              onClick={() => setOpenId(null)}
              className="text-fg-dim hover:text-fg-2"
            >
              收起
            </button>
          </div>
          <InjectedFrame
            tool={tools.find((t) => t.id === open.toolId)!}
            spec={open.spec}
            taskId={taskId}
            height={PANEL_HEIGHT}
          />
        </div>
      )}
    </div>
  );
}

export function InjectedDetailActions({ taskId }: { taskId: string }) {
  return <ActionButtons taskId={taskId} kind="detailAction" />;
}

export function InjectedRowActions({ taskId }: { taskId: string }) {
  return <ActionButtons taskId={taskId} kind="rowAction" compact />;
}
