import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  RefreshCw,
  Info,
  ShieldCheck,
  Database,
} from "lucide-react";
import { useStore } from "../store";
import { resolveToolUrl, toolTable, lastToolCandidates } from "../lib/tools";
import { dbInfo } from "../lib/db";
import { fetchToolDemoData } from "../lib/toolDemo";
import { createToolBridge, type ToolBridge } from "../lib/toolBridge";
import type { ToolManifest } from "../types";

/**
 * 单个工具的承载层。
 *
 * 桌面端：把工具的 index.html 通过 iframe 嵌进来。
 * 用 iframe 而不是直接 import，是为了让工具与宿主强隔离 ——
 * 工具崩了不会拖垮主界面，工具也不能直接碰宿主的 React 树和数据库连接。
 * 需要数据时通过 postMessage 向宿主请求，宿主代查（通道见 lib/toolBridge.ts，
 * 那里强制工具只能访问自己命名空间下的表）。
 *
 * 浏览器 demo：工具目录由 dev server 直接静态服务，同样能真实嵌入；
 * 只有入口解析失败时才退化成契约说明页。
 *
 * ------------------------------------------------------------------
 * 为什么是"帧"而不是"容器"
 * ------------------------------------------------------------------
 * 一个工具一个组件实例，头部与标签条在 ToolArea 里统一渲染 ——
 * 因为「保持工具状态」意味着同时有多个工具活着，而每个 iframe 都必须
 * **一直待在 DOM 的同一个位置上**：iframe 在 DOM 里挪一下（哪怕只是换了个
 * 兄弟顺序）浏览器就会重新加载它，状态照样丢。所以这里只负责"把自己这一层
 * 画好、显示或隐藏"，顺序由 ToolArea 用稳定的 key 列表保证。
 */
export default function ToolFrame({ tool, active }: { tool: ToolManifest; active: boolean }) {
  /** 「重置」按钮点一次 +1；当 iframe 的 key 用，变一次就重挂载一次 */
  const reload = useStore((s) => s.toolReloads[tool.id] ?? 0);

  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 解析失败时用：这次到底找过哪些位置（桌面端才有值） */
  const [tried, setTried] = useState<string[]>([]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let alive = true;
    // 刻意**不**在这里 setLoading(true)。
    //
    // loading 只代表"第一次还没解析出入口"。如果重新解析时又把它置回 true，
    // 渲染就会从 iframe 分支切到"正在加载"分支 —— 那一瞬间 iframe 被卸载、
    // 紧接着重新挂载，工具的状态又没了。而重新解析是会发生的事：
    // reloadTools()（装了/卸了任意一个工具）会重建 manifest 对象，
    // 这个 effect 因此重跑。结果是"装了个新工具，手上正开着的那个被重置了"，
    // 而且看起来毫无理由。
    void resolveToolUrl(tool).then((u) => {
      if (alive) {
        setUrl(u);
        // lastToolCandidates() 是模块级共享状态，多个工具同时解析时有极小概率串台；
        // 它只在"解析失败"的兜底视图里显示，不参与任何判断，不值得为它加一套配对机制。
        setTried(u ? [] : lastToolCandidates());
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [tool, reload]);

  /**
   * 工具 ↔ 宿主 的数据通道。
   *
   * 工具拿不到宿主的 db 实例（iframe 隔离的意义就在这），需要数据时
   * 通过 postMessage 请求，宿主代查后回给它。通道本身在 lib/toolBridge.ts，
   * 那里强制工具只能访问自己命名空间下的表。
   */
  const bridgeRef = useRef<ToolBridge | null>(null);

  useEffect(() => {
    if (!url) return;
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
  }, [tool.id, url, reload]);

  return (
    <div
      data-tool-layer={tool.id}
      data-tool-active={active ? "1" : "0"}
      // 非当前工具**只隐藏、不卸载** —— 这就是「保持工具状态」的全部实现。
      // display:none 的 iframe 文档仍然活着，里面的变量、DOM、滚动位置都还在。
      className={active ? "absolute inset-0" : "hidden"}
    >
      {/* 分支顺序是有意的：**只要解析出过入口，就永远渲染 iframe**。
          先判 loading 的话，重新解析会让 iframe 被"正在加载"顶掉再挂回来，
          工具状态白丢一次（原因见上面 effect 里的注释）。 */}
      {url ? (
        <iframe
          // key 换掉 = iframe 重建 = 工具回到初始状态。头部的「重置」按钮就是干这个的。
          // （「保持工具状态」关掉时不需要它：那个模式下切走即卸载，本来就是重建的）
          key={`${url}#${reload}`}
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
      ) : loading ? (
        <div className="grid h-full place-items-center text-[13px] text-fg-dim">
          正在加载工具…
        </div>
      ) : (
        <ToolContractDemo toolName={tool.name} toolId={tool.id} candidates={tried} />
      )}
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
            在<b>设置 → 工具</b>里可以重新安装这个工具。
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
          单文件工具可以直接在<b>设置 → 工具 → 导入 HTML 单文件</b>里装进来。
        </p>

        <pre className="mt-3 overflow-x-auto rounded-lg bg-[#2c2c2a] px-4 py-3 font-mono text-[12px] leading-[1.7] text-[#e8e6e0]">
{`tools/${toolId}/
  manifest.json    清单：id / 名称 / 图标 / 入口 / dbVersion
  index.html       工具界面，完全自治的单页应用
  <其他附属资源>   脚本 / 图片 / 模型，随目录一起走`}
        </pre>

        {/* 这一条是踩过的坑，写在这里是因为它是**下一个写工具的人唯一会看到的地方**。
            桌面端走 asset 协议，Tauri 把整条路径编码成一个路径段，
            相对引用会被解析到站点根 —— 只在装出来的应用里复现，dev 下完全正常。 */}
        <div className="mt-3 rounded-lg border border-[#f0d9a8] bg-[#fdf6e7] px-4 py-3 text-[13px] leading-relaxed text-[#7a5406]">
          ⚠️ 工具引用自己的附属资源时，<b>必须拼成绝对 URL</b>。
          桌面端工具经 asset 协议加载，而 Tauri 会把整条路径编码成
          <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[11.5px]">
            http://asset.localhost/C%3A%5C…%5Cindex.html
          </code>
          —— 整条 URL 里只有开头一个 <code>/</code>，所以
          <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[11.5px]">
            src="ai/ort.js"
          </code>
          这类相对路径会被解析到<b>站点根</b>，而不是工具目录。
          这个坑只在装出来的应用里出现，dev server 下永远正常。
          写法参考 <code>tools/{toolId}/index.html</code> 里从
          <code className="mx-1 rounded bg-chip px-1.5 py-px font-mono text-[11.5px]">
            location.href
          </code>
          推出目录的那段。单文件导入的工具请把 CSS/JS 内联，
          相对引用不会被一起带进来。
        </div>

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
