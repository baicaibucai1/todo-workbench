import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  createToolBridge,
  type ToolBridge,
  type ToolLinkMeta,
} from "../lib/toolBridge";
import {
  ensureToolSchema,
  validateToolSchema,
  type ValidatedTable,
} from "../lib/toolSchema";
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
  /** iframe 是否已加载完 —— 意图必须等它好了再投，否则消息没人收（也不报错） */
  const [ready, setReady] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  /**
   * 这个工具的数据表在宿主侧的 stems（校验 + 建表之后的结果）。
   *
   * 放 ref 而不是 state：它是给桥读的，界面上不显示，
   * 变成 state 只会让下面那个 effect 多跑几次、桥跟着重建。
   */
  const tablesRef = useRef<ValidatedTable[]>([]);

  /** 工具声明的数据表没能建立起来的原因。空表示一切正常或它本来就没声明表 */
  const [schemaError, setSchemaError] = useState("");

  /**
   * 设置页里把这个工具的表清掉时 +1。
   *
   * 没有它，清完数据以后正在运行的工具会一直撞"表不存在"，
   * 直到用户把它关掉再打开 —— 那是个没人能看懂的现象。
   */
  const schemaStamp = useStore((s) => s.toolSchemaStamps[tool.id] ?? 0);

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
    void Promise.all([resolveToolUrl(tool), ensureTables(tool)]).then(([u, res]) => {
      if (!alive) return;
      setUrl(u);
      // lastToolCandidates() 是模块级共享状态，多个工具同时解析时有极小概率串台；
      // 它只在"解析失败"的兜底视图里显示，不参与任何判断，不值得为它加一套配对机制。
      setTried(u ? [] : lastToolCandidates());
      setLoading(false);
      // 建表失败**不阻止工具显示**：多数工具没有表也照跑，
      // 但必须让用户看见原因，否则作者会以为自己的桥调用写错了。
      setSchemaError(res.error);
    });
    return () => {
      alive = false;
    };
    // schemaStamp 变化时**不** setLoading(true)：那会让 iframe 被"正在加载"
    // 顶掉再挂回来，工具的状态白丢一次（原因见上面那段注释）。
  }, [tool, reload, schemaStamp]);

  async function ensureTables(t: ToolManifest): Promise<{ error: string }> {
    tablesRef.current = [];
    const schema = validateToolSchema(t.id, t.schema);
    if (!schema) return { error: "" };
    try {
      const built = await ensureToolSchema(t.id, t.dbVersion, schema);
      tablesRef.current = built.tables;
      return { error: "" };
    } catch (err) {
      // 退回"没有表"，而不是留下半截 tablesRef —— 半截会让 row.* 对一部分表
      // 生效、另一部分报"No such table"，那种现象完全没法从工具侧断定原因
      tablesRef.current = [];
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 工具 ↔ 宿主 的数据通道。
   *
   * 工具拿不到宿主的 db 实例（iframe 隔离的意义就在这），需要数据时
   * 通过 postMessage 请求，宿主代查后回给它。通道本身在 lib/toolBridge.ts，
   * 那里强制工具只能访问自己命名空间下的表。
   */
  const bridgeRef = useRef<ToolBridge | null>(null);

  // 这两个回调给桥用。用 useRef + 空依赖包一层，是为了让它们的**引用稳定** ——
  // 直接写成内联箭头函数的话，每次渲染都是新对象，下面那个建桥的 effect
  // 就会每次渲染都重跑一遍（桥重建 = iframe 与宿主的通道重新连一次）。
  const peersRef = useRef<() => ToolLinkMeta[]>(() => []);
  peersRef.current = () => {
    const s = useStore.getState();
    return s.enabledTools
      .filter((t) => t.id !== tool.id)
      .map((t) => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        version: t.version,
        description: t.description,
        running: s.aliveToolIds.includes(t.id),
        active: s.activeToolId === t.id,
      }));
  };
  const opts = useMemo(
    () => ({
      getTables: () => tablesRef.current,
      openTool: async (id: string, data: unknown) => {
        await useStore.getState().openToolWithIntent(id, data, tool.id);
      },
      peers: () => peersRef.current(),
    }),
    [tool.id],
  );

  useEffect(() => {
    if (!url) return;
    const bridge = createToolBridge(tool.id, () => frameRef.current, opts);
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
  }, [tool.id, url, reload, opts]);

  /**
   * 投递别的工具交过来的数据。
   *
   * 必须等 iframe load 完（ready） —— 早一步 postMessage 出去，
   * 消息会被扔进虚空：**不报错，也没人收到**，是那种最难查的失效。
   * 队列在 store 里等着，所以工具一边加载一边被调起也不会丢。
   */
  const intents = useStore((s) => s.toolIntents[tool.id]);
  useEffect(() => {
    if (!ready || !bridgeRef.current || !intents?.length) return;
    const intent = useStore.getState().takeToolIntent(tool.id);
    // takeToolIntent 改动 state 会让 intents 变短，effect 因此重跑并继续投递下一条；
    // 拿不到说明已被别的实例消费（并发安全由 state 更新本身保证）
    if (intent) bridgeRef.current.postIntent(intent.data, intent.from);
  }, [ready, intents, tool.id]);

  // 重新挂载（换 url / 点重置）时 readiness 要归零，
  // 否则新 iframe 还没加载完就投递，又回到上面的"消息没人收"。
  useEffect(() => {
    setReady(false);
  }, [url, reload]);

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
        <>
          {schemaError && (
            <div
              data-tool-schema-error={tool.id}
              className="flex items-start gap-2 border-b border-[#f0d9a8] bg-[#fdf6e7] px-4 py-2 text-[12.5px] leading-relaxed text-[#7a5406]"
            >
              <Info size={14} className="mt-px shrink-0" />
              <span>
                这个工具声明的数据表没能建起来，它的记录功能会不可用：{schemaError}
                <span className="ml-1 text-fg-dim">
                  （检查 manifest 里的 schema：列名只能用小写字母/数字/下划线，且必须有一个主键列）
                </span>
              </span>
            </div>
          )}
          <iframe
            // key 换掉 = iframe 重建 = 工具回到初始状态。头部的「重置」按钮就是干这个的。
            // （「保持工具状态」关掉时不需要它：那个模式下切走即卸载，本来就是重建的）
            key={`${url}#${reload}`}
            ref={frameRef}
            src={url}
            title={tool.name}
            data-tool-frame={tool.id}
            className="size-full border-0"
            // 加载完成时做两件事：下发一次运行上下文、开放"可以把数据交给它了"这个信号。
            // 只靠主题变化触发是不够的：第一次进来时工具根本收不到任何上下文。
            onLoad={() => {
              setReady(true);
              bridgeRef.current?.pushContext();
            }}
            sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-forms allow-popups"
          />
        </>
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
          <Database size={15} className="text-[#ba7517]" />
          数据表（可选）
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-3">
          工具要存自己的记录时，在 manifest 里<b>声明</b>表结构，宿主替你建和执行。
          你在 js 里调的是结构化接口，拿不到 SQL 通道，也就碰不到宿主的表：
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[#2c2c2a] px-4 py-3 font-mono text-[11.5px] leading-[1.75] text-[#e8e6e0]">
{`// manifest.json
"dbVersion": 1,
"schema": { "tables": [{
  "name": "records",
  "columns": [
    { "name": "id",   "type": "text", "pk": true },
    { "name": "title","type": "text" },
    { "name": "amount","type": "real", "default": 0 }
  ],
  "indexes": [{ "columns": ["title"] }]
}]}

// index.html
await call("row.insert",  { table: "records",
  row: { id: "r1", title: "首单", amount: 12.5 } });
await call("row.select",  { table: "records",
  where: { title: "首单" }, orderBy: "amount", limit: 20 });
// 还有 row.count / row.update / row.delete / schema.info`}
        </pre>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-fg-dim">
          <li>
            表名与列名只能用小写字母、数字、下划线（首字母必须是字母），
            每张表<b>必须有一个主键列</b> —— update / delete 靠它定位一行。
          </li>
          <li>
            值按声明的类型强校验：给 integer 列传字符串会被拒绝。
            这不是刁难，是为了让两个驱动行为一致（SQLite 会强转类型，内存库不会）。
          </li>
          <li>
            <code className="rounded bg-chip px-1 py-px font-mono text-[11.5px]">dbVersion</code>
            改了才会重跑建表；已经存在的列不会被自动迁移。
          </li>
          <li>
            卸载工具<b>不会删这些数据</b>，重装回来还在。
            要抹掉得在<b>设置 → 数据库</b>里手动清理。
          </li>
        </ul>

        <h3 className="mt-5 flex items-center gap-2 text-[14px] font-medium">
          <ShieldCheck size={15} className="text-[#1d9e75]" />
          与其它工具联动（可选）
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-3">
          各工具在自己的 iframe 里，要协作就得经过宿主中转：
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[#2c2c2a] px-4 py-3 font-mono text-[11.5px] leading-[1.75] text-[#e8e6e0]">
{`await call("tools.list");                  // 这台机器上还有哪些工具
await call("tools.open", { tool: "image-crop",
  data: { url: "..." } });                 // 拉起它并把数据交给它
await call("tools.send", { tool: "size-chart",
  event: "rows", data: [...] });           // 只发给已经在运行的工具

// 自己被拉起时：
window.addEventListener("message", (e) => {
  if (e.data?.source !== "workbench-host") return;
  if (e.data.type === "tool:intent") use(e.data.data);   // 交过来的数据
  if (e.data.type === "tool:event")  on(e.data.event, e.data.data);
});`}
        </pre>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">
          数据只在本机的 postMessage 通道里流动，不落库、不经过第三方，
          收发双方也仍然碰不到彼此的数据表。
        </p>

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
