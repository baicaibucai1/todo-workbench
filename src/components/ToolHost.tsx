import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Package,
  FolderOpen,
  RefreshCw,
  Info,
  ShieldCheck,
  Database,
} from "lucide-react";
import { useStore } from "../store";
import { resolveToolUrl, toolTable, lastToolCandidates } from "../lib/tools";
import { dbInfo, isTauri } from "../lib/db";
import { fetchToolDemoData } from "../lib/toolDemo";
import { createToolBridge, type ToolBridge } from "../lib/toolBridge";

/**
 * 工具容器。
 *
 * 桌面端：把工具的 index.html 通过 iframe 嵌进来。
 * 用 iframe 而不是直接 import，是为了让工具与宿主强隔离 ——
 * 工具崩了不会拖垮主界面，工具也不能直接碰宿主的 React 树和数据库连接。
 * 需要数据时通过 postMessage 向宿主请求，宿主代查（通道见 lib/toolBridge.ts，
 * 那里强制工具只能访问自己命名空间下的表）。
 *
 * 浏览器 demo：工具目录由 dev server 直接静态服务，同样能真实嵌入；
 * 只有入口解析失败时才退化成契约说明页。
 */
export default function ToolHost() {
  const { activeToolId, tools, openTool } = useStore();
  const tool = tools.find((t) => t.id === activeToolId);

  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 解析失败时用：这次到底找过哪些位置（桌面端才有值） */
  const [tried, setTried] = useState<string[]>([]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let alive = true;
    if (!tool) return;
    setLoading(true);
    void resolveToolUrl(tool).then((u) => {
      if (alive) {
        setUrl(u);
        setTried(u ? [] : lastToolCandidates());
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [tool]);

  /**
   * 工具 ↔ 宿主 的数据通道。
   *
   * 工具拿不到宿主的 db 实例（iframe 隔离的意义就在这），需要数据时
   * 通过 postMessage 请求，宿主代查后回给它。通道本身在 lib/toolBridge.ts，
   * 那里强制工具只能访问自己命名空间下的表。
   */
  const bridgeRef = useRef<ToolBridge | null>(null);

  useEffect(() => {
    if (!tool || !url) return;
    const bridge = createToolBridge(tool.id, () => frameRef.current);
    bridgeRef.current = bridge;
    bridge.attach();

    // 主题变化要同步给工具，否则宿主切深色后 iframe 内部还是浅色，很割裂
    const observer = new MutationObserver(() => bridge.pushContext());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      bridge.detach();
      observer.disconnect();
      bridgeRef.current = null;
    };
  }, [tool, url]);

  if (!tool) return null;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      {/* 工具头部工具栏 */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-card px-4">
        <button
          onClick={() => openTool(null)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-fg-3 hover:bg-hover"
        >
          <ArrowLeft size={15} />
          返回待办
        </button>
        <div className="h-5 w-px bg-chip" />
        <div className="flex min-w-0 items-center gap-2">
          <Package size={15} className="shrink-0 text-[#378add]" />
          <span className="truncate text-[14px] font-medium">{tool.name}</span>
          <span className="shrink-0 rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim">
            v{tool.version}
          </span>
        </div>
        <div className="flex-1" />
        <span className="text-[11.5px] text-fg-dim">
          {isTauri() ? "已加载本地工具" : "浏览器模式 · 工具直载"}
        </span>
      </header>

      {/* 工具内容 */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="grid h-full place-items-center text-[13px] text-fg-dim">
            正在加载工具…
          </div>
        ) : url ? (
          <iframe
            ref={frameRef}
            src={url}
            title={tool.name}
            data-tool-frame={tool.id}
            className="size-full border-0"
            // 工具加载完成时主动下发一次运行上下文（工具 id / 驱动 / schema 版本 / 主题）。
            // 只靠主题变化触发是不够的：第一次进来时工具根本收不到任何上下文。
            onLoad={() => bridgeRef.current?.pushContext()}
            sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-forms allow-popups"
          />
        ) : (
          <ToolContractDemo toolName={tool.name} toolId={tool.id} candidates={tried} />
        )}
      </div>
    </div>
  );
}

/**
 * 工具入口解析失败时的兜底视图。
 *
 * 正常情况下不该看到它 —— 它不只是"没加载出来"的提示，
 * 同时把工具契约画出来，让人一眼看懂新增一个工具到底需要什么。
 */
function ToolContractDemo({
  toolName,
  toolId,
  candidates = [],
}: {
  toolName: string;
  toolId: string;
  candidates?: string[];
}) {
  const info = dbInfo();
  const [rows, setRows] = useState<Array<{ order_no: string; amount: number }>>([]);
  const [tableName, setTableName] = useState("");
  const [busy, setBusy] = useState(false);

  const runDemo = async () => {
    setBusy(true);
    try {
      const { table, rows: data } = await fetchToolDemoData(toolId);
      setTableName(table);
      setRows(data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[680px]">
        <div className="flex items-start gap-3 rounded-lg border border-[#f0d9a8] bg-[#fdf6e7] px-4 py-3">
          <Info size={16} className="mt-px shrink-0 text-[#a5720f]" />
          <div className="text-[13px] leading-relaxed text-[#7a5406]">
            没能解析出「{toolName}」的入口文件，暂时显示契约说明。
            请确认工具目录下存在
            <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[12px]">
              tools/{toolId}/
            </code>
            且 manifest 里的 entry 指向真实文件。
            {/* 桌面端把「找过哪些位置」直接摆出来。
                上一版这里只显示这句通用提示，而真正的故障是「代码去 %APPDATA% 找，
                工具却装在安装目录」，界面上完全看不出，只能靠翻源码猜。 */}
            {candidates.length > 0 && (
              <div className="mt-2 border-t border-[#f0d9a8] pt-2">
                已查找以下位置，均不存在：
                <ul className="mt-1 space-y-0.5">
                  {candidates.map((c) => (
                    <li key={c} className="break-all font-mono text-[11.5px]">
                      · {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <h2 className="mt-6 text-[15px] font-medium">工具接入契约</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-3">
          新增一个工具只需要往工具目录丢一个文件夹，不需要改宿主代码，也不需要重新发版。
        </p>

        <pre className="mt-3 overflow-x-auto rounded-lg bg-[#2c2c2a] px-4 py-3 font-mono text-[12px] leading-[1.7] text-[#e8e6e0]">
{`tools/${toolId}/
  manifest.json    清单：id / 名称 / 图标 / 入口 / dbVersion
  index.html       工具界面，完全自治的单页应用`}
        </pre>

        <h3 className="mt-5 text-[14px] font-medium">manifest.json</h3>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[#2c2c2a] px-4 py-3 font-mono text-[12px] leading-[1.7] text-[#e8e6e0]">
{`{
  "id": "${toolId}",
  "name": "${toolName}",
  "version": "1.0.0",
  "icon": "receipt",
  "entry": "index.html",
  "dbVersion": 1
}`}
        </pre>

        <h3 className="mt-5 flex items-center gap-2 text-[14px] font-medium">
          <ShieldCheck size={15} className="text-[#1d9e75]" />
          数据隔离
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-3">
          工具表和核心表共用一个数据库文件，但命名空间严格分开：
          <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[12px]">
            core_*
          </code>
          归宿主，
          <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[12px]">
            tool_{toolId.replace(/-/g, "_")}_*
          </code>
          归工具。删除或回滚某个工具，不会碰到待办数据。
        </p>

        <h3 className="mt-5 flex items-center gap-2 text-[14px] font-medium">
          <Database size={15} className="text-[#ba7517]" />
          数据库连通性验证
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-3">
          当前驱动：
          <span className="font-medium">
            {info.driver === "sqlite" ? "SQLite 文件数据库" : "内存库（localStorage 持久化）"}
          </span>
          ，schema 版本 v{info.schemaVersion}。下面按下按钮会真实建一张工具表并写入数据，
          用来证明工具与核心共库但互不干扰。
        </p>

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void runDemo()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-[#378add] px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
          >
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            {busy ? "执行中…" : "建表并写入示例订单"}
          </button>
          <span className="flex items-center gap-1.5 text-[12px] text-fg-dim">
            <FolderOpen size={13} />
            工具目录：{useStore.getState().toolsPath}
          </span>
        </div>

        {tableName && (
          <div className="mt-3 overflow-hidden rounded-lg border border-line bg-card">
            <div className="border-b border-line bg-chip px-4 py-2 font-mono text-[12px] text-fg-3">
              {tableName}
            </div>
            <table className="w-full text-[13px]" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-fg-dim">
                  <th className="px-4 py-2 font-normal">order_no</th>
                  <th className="px-4 py-2 text-right font-normal">amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.order_no} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-mono text-[12px]">{r.order_no}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      ¥{r.amount.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 text-[12px] leading-relaxed text-fg-dim">
          验证方式：
          <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[11.5px]">
            {toolTable(toolId, "orders")}
          </code>
          已随建表语句创建，待办数据仍在
          <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[11.5px]">
            core_tasks
          </code>
          中，两者互不影响。
        </div>
      </div>
    </div>
  );
}
