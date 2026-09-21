import { useMemo, useState } from "react";
import {
  Search,
  Timer,
  Star,
  Trash2,
  ChevronRight,
  Copy,
  Check,
  ClipboardList,
  PackageOpen,
} from "lucide-react";
import { useStore } from "../store";
import { today } from "../lib/repo";
import { dueState, dueText, dueAtText, humanDuration } from "../lib/due";
import OrderCreateDialog from "./OrderCreateDialog";
import type { WorkOrder } from "../types";

/**
 * 「特殊单号」专属的记录管理界面。
 *
 * 它**不套用**待办那套轻松样式（渐变背景、卡片列表、底部随手输入栏）：
 * 这批数据的价值在"查得到、分得开、对得上账"——用户来这里是为了
 * 翻历史单、核对某个绑定的号码、按流程或时效切出一小批来看，
 * 是一个面向**记录**的界面，不是面向"今天做点什么"的界面。
 *
 * 数据层完全不另起炉灶：特殊单号就是 kind='special' 的工单
 * （见 types.ts 的说明），这个视图只是工单数据的一个正规化呈现。
 * "推送到工单中"的语义由共用的数据层天然保证。
 *
 * e2e 锚点约定（tests/special-orders.mjs 依赖）：
 *   行 data-order-id / data-order-kind / data-order-stage
 *   时效胶囊 data-order-due / data-order-due-at
 *   推进按钮 data-order-advance
 *   工具栏 data-sp-search / data-sp-status / data-sp-flow / data-sp-due /
 *         data-sp-sort / data-sp-register / data-sp-clear / data-edit-flows
 */

/**
 * 表格四列的栅格模板：记录（单号/说明） / 流程·步骤 / 相关信息 / 时效。
 *
 * 不设第五列「操作」：详情面板打开后主区通常只剩 580px 上下，
 * 六列硬塞会把**处理时效**这种核心信息挤出可视区（首版实测如此）。
 * 操作改为行尾悬浮层，悬停出现 —— 和列表行的交互习惯一致。
 */
const GRID =
  "grid grid-cols-[minmax(196px,1.55fr)_minmax(116px,1fr)_minmax(92px,0.8fr)_minmax(102px,0.9fr)] items-center gap-3 px-3 py-2";

type StatusFilter = "all" | "open" | "closed";
type DueFilter = "all" | "overdue" | "soon" | "ok" | "none";
type SortKey = "due" | "recent" | "no";

/** 登记时间：记录界面里"什么时候进来的"是核对信息，给到分钟 */
function fmtCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return date === today() ? `今天 ${time}` : `${p(d.getMonth() + 1)}月${d.getDate()}日 ${time}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（比如旧版 webview）没有 clipboard API：退回选区复制
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default function SpecialOrdersView() {
  const {
    orders,
    flows,
    stages,
    allWoFields,
    activeOrderId,
    woAttachmentCounts,
    openOrder,
    advanceOrder,
    removeOrder,
    toggleOrderImportant,
    openFlowEditor,
  } = useStore();

  // 本视图的搜索是**记录检索**，范围就是这批特殊单号（含相关信息字段值）。
  // 不复用全局 search：那个会把视图切到跨列表的"找到它"模式，语义不同。
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [flowId, setFlowId] = useState("");
  const [due, setDue] = useState<DueFilter>("all");
  const [sort, setSort] = useState<SortKey>("due");
  /** 刚点过「复制」的那一行：图标短暂变成勾，给"真的复制上了"的反馈 */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);

  // 第二道闸：数据层（fetchWorkOrders 的 special 分支）已经只放行 kind='special'，
  // 这里再显式过滤一次 —— 全局搜索态、或未来哪个调用方传错，都不该让
  // 普通工单混进这张记录表（和 rows.ts 里 myday 的纪律同源）。
  const specials = useMemo(
    () => orders.filter((o) => o.kind === "special"),
    [orders],
  );

  /** 按单分组的字段（含 label/value，搜索与行内提示都要用） */
  const fieldsByOrder = useMemo(() => {
    const map = new Map<string, { label: string; value: string }[]>();
    for (const f of allWoFields) {
      const list = map.get(f.woId) ?? [];
      list.push({ label: f.label, value: f.value });
      map.set(f.woId, list);
    }
    return map;
  }, [allWoFields]);

  // 统计基于**未筛选**的全量（筛掉之后数字跟着变，反而看不出"库里到底有多少"）
  const stats = useMemo(() => {
    let open = 0;
    let closed = 0;
    let overdue = 0;
    let soon = 0;
    for (const o of specials) {
      if (o.closed) {
        closed++;
        continue;
      }
      open++;
      const ds = dueState(o);
      if (ds === "overdue") overdue++;
      else if (ds === "soon") soon++;
    }
    return { total: specials.length, open, closed, overdue, soon };
  }, [specials]);

  // 有特殊单号的流程才有资格出现在分类下拉里：没有单的流程挂上去是噪音
  const flowOptions = useMemo(() => {
    const used = new Set(specials.map((o) => o.flowId));
    return flows.filter((f) => used.has(f.id));
  }, [flows, specials]);

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    let list = specials;
    if (kw) {
      list = list.filter((o) => {
        const stage = stages.find((s) => s.id === o.stageId)?.name ?? "";
        const flow = flows.find((f) => f.id === o.flowId)?.name ?? "";
        const fields = fieldsByOrder.get(o.id) ?? [];
        return (
          o.no.toLowerCase().includes(kw) ||
          o.title.toLowerCase().includes(kw) ||
          o.note.toLowerCase().includes(kw) ||
          flow.toLowerCase().includes(kw) ||
          stage.toLowerCase().includes(kw) ||
          fields.some(
            (f) => f.label.toLowerCase().includes(kw) || f.value.toLowerCase().includes(kw),
          )
        );
      });
    }
    if (status !== "all") list = list.filter((o) => (status === "open" ? !o.closed : o.closed));
    if (flowId) list = list.filter((o) => o.flowId === flowId);
    if (due !== "all") list = list.filter((o) => (o.closed ? false : dueState(o) === due));

    const sorted = [...list];
    if (sort === "no") {
      sorted.sort((a, b) => (a.no || "～").localeCompare(b.no || "～"));
    } else if (sort === "recent") {
      sorted.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    } else {
      // 默认按时效：处理中的在前（越早到期越靠前，逾期最前），已完结沉底
      const dueKey = (o: WorkOrder) => {
        if (!o.stageDueAt) return Number.MAX_SAFE_INTEGER;
        const t = new Date(o.stageDueAt).getTime();
        return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
      };
      sorted.sort((a, b) => {
        if (a.closed !== b.closed) return a.closed ? 1 : -1;
        return dueKey(a) - dueKey(b);
      });
    }
    return sorted;
  }, [specials, q, status, flowId, due, sort, stages, flows, fieldsByOrder]);

  const filtersActive = q.trim() !== "" || status !== "all" || flowId !== "" || due !== "all";

  const copyAllFields = async (o: WorkOrder) => {
    const fields = fieldsByOrder.get(o.id) ?? [];
    if (!fields.length) return;
    const ok = await copyText(fields.map((f) => `${f.label}：${f.value}`).join("\n"));
    if (ok) {
      setCopiedId(o.id);
      setTimeout(() => setCopiedId((cur) => (cur === o.id ? null : cur)), 1600);
    }
  };

  return (
    <div
      className="relative isolate flex h-full min-w-0 flex-1 flex-col bg-panel"
      data-bg-mode="auto"
      data-bg-file=""
    >
      {/* 标题：正式的记录界面用主题前景色，不用待办那套白字压渐变 */}
      <div className="flex shrink-0 items-end justify-between px-6 pt-5 pb-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-tight text-fg">特殊单号</h1>
          <p className="mt-0.5 text-[12px] text-fg-dim">
            以快递单号为起点的时效记录 · 推进、留痕与提醒走工单体系
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() =>
              openFlowEditor(
                flowOptions.find((f) => f.isDefault)?.id ?? flowOptions[0]?.id ?? null,
              )
            }
            data-edit-flows=""
            data-sp-edit-flows=""
            title="编辑流程与过程态"
            className="rounded-md px-2.5 py-1.5 text-[12.5px] text-fg-3 transition-colors hover:bg-hover"
          >
            编辑流程
          </button>
          <button
            onClick={() => setRegOpen(true)}
            data-sp-register=""
            className="flex items-center gap-1.5 rounded-md bg-[#d85a30] px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:brightness-95"
          >
            <Timer size={14} />
            登记单号
          </button>
        </div>
      </div>

      {/* 工具栏：搜索 + 分类筛选。这是"数据库能力"的操作台 */}
      <div className="shrink-0 px-6">
        <div
          data-sp-toolbar=""
          className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card p-2"
        >
          <div className="relative min-w-[220px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim"
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-sp-search=""
              placeholder="搜索快递单号、说明或相关信息（客户、补发单号…）"
              className="w-full rounded-md border border-line bg-surface py-1.5 pl-8 pr-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-dim focus:border-fg-dim"
            />
          </div>

          {/* 状态分类 */}
          <div className="flex shrink-0 items-center rounded-md bg-chip p-0.5" data-sp-status-group="">
            {(
              [
                ["all", `全部 ${stats.total}`],
                ["open", `处理中 ${stats.open}`],
                ["closed", `已完结 ${stats.closed}`],
              ] as [StatusFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setStatus(key)}
                data-sp-status={key}
                className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  status === key ? "bg-card text-fg shadow-sm" : "text-fg-dim hover:text-fg-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 流程分类 */}
          <select
            value={flowId}
            onChange={(e) => setFlowId(e.target.value)}
            data-sp-flow=""
            title="按流程分类"
            className="shrink-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-2 outline-none"
          >
            <option value="">全部流程</option>
            {flowOptions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>

          {/* 时效分类 */}
          <select
            value={due}
            onChange={(e) => setDue(e.target.value as DueFilter)}
            data-sp-due=""
            title="按时效状态分类"
            className="shrink-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-2 outline-none"
          >
            <option value="all">全部时效</option>
            <option value="overdue">已超时</option>
            <option value="soon">临期</option>
            <option value="ok">正常</option>
            <option value="none">未设时效</option>
          </select>

          {/* 排序 */}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            data-sp-sort=""
            title="排序方式"
            className="shrink-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-2 outline-none"
          >
            <option value="due">按时效排序</option>
            <option value="recent">按登记时间</option>
            <option value="no">按单号</option>
          </select>

          {filtersActive && (
            <button
              onClick={() => {
                setQ("");
                setStatus("all");
                setFlowId("");
                setDue("all");
              }}
              data-sp-clear=""
              className="shrink-0 rounded-md px-2 py-1.5 text-[12px] text-fg-dim transition-colors hover:bg-hover hover:text-fg-2"
            >
              清除筛选
            </button>
          )}
        </div>

        {/* 统计条：逾期/临期大于 0 才标红，和列表胶囊同一套语义 */}
        <div
          data-sp-stats=""
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2 text-[12px] text-fg-dim"
        >
          <span>
            共 <b className="font-medium text-fg-2">{stats.total}</b> 条记录
          </span>
          <span>处理中 {stats.open}</span>
          <span className={stats.overdue > 0 ? "font-medium text-danger" : undefined}>
            已超时 {stats.overdue}
          </span>
          <span className={stats.soon > 0 ? "font-medium text-danger" : undefined}>
            临期 {stats.soon}
          </span>
          <span>已完结 {stats.closed}</span>
          {q.trim() && (
            <span className="text-fg-3">
              命中 {rows.length} 条 · 命中范围含相关信息字段
            </span>
          )}
        </div>
      </div>

      {/* 记录表 */}
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {stats.total === 0 ? (
          <div className="mt-14 flex flex-col items-center gap-2 text-center">
            <div className="grid size-14 place-items-center rounded-full bg-chip text-fg-dim">
              <PackageOpen size={24} />
            </div>
            <p className="text-[14px] text-fg-2">还没有登记过特殊单号</p>
            <p className="max-w-[340px] text-[12px] leading-relaxed text-fg-dim">
              以快递单号为起点登记第一张：每一步带处理时效，超时会提醒；
              单子上可以绑定任意相关信息（补发单号、客户、手机尾号…）供随时复制。
            </p>
            <button
              onClick={() => setRegOpen(true)}
              className="mt-1.5 flex items-center gap-1.5 rounded-md bg-[#d85a30] px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:brightness-95"
            >
              <Timer size={14} />
              登记第一张单号
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-14 flex flex-col items-center gap-2 text-center">
            <p className="text-[14px] text-fg-2">没有匹配的记录</p>
            <p className="text-[12px] text-fg-dim">换个关键词，或放宽筛选条件</p>
            <button
              onClick={() => {
                setQ("");
                setStatus("all");
                setFlowId("");
                setDue("all");
              }}
              data-sp-clear=""
              className="mt-1.5 rounded-md border border-line px-3 py-1.5 text-[12.5px] text-fg-2 transition-colors hover:bg-hover"
            >
              清除筛选条件
            </button>
          </div>
        ) : (
          <div className="min-w-[560px] overflow-hidden rounded-lg border border-line bg-card">
            {/* 表头 */}
            <div
              className={`${GRID} border-b border-line bg-surface text-[11px] font-medium text-fg-dim`}
            >
              <span>记录（单号 / 说明）</span>
              <span>流程 · 当前步骤</span>
              <span>相关信息</span>
              <span>处理时效</span>
            </div>

            {rows.map((o) => (
              <RecordRow
                key={o.id}
                order={o}
                fields={fieldsByOrder.get(o.id) ?? []}
                active={activeOrderId === o.id}
                copied={copiedId === o.id}
                attachCount={woAttachmentCounts[o.id] ?? 0}
                onOpen={() => openOrder(o.id)}
                onAdvance={(stageId) => void advanceOrder(o.id, stageId)}
                onToggleImportant={() => void toggleOrderImportant(o)}
                onDelete={() => void removeOrder(o.id)}
                onCopyFields={() => void copyAllFields(o)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 登记弹窗：挂在最外层，避免被表格区的 overflow 裁剪 */}
      {regOpen && (
        <OrderCreateDialog
          initialKind="special"
          initialNo=""
          initialTitle=""
          onClose={() => setRegOpen(false)}
        />
      )}
    </div>
  );
}

/** 单条记录行。表格化布局：一眼对齐、可比对，这是它和"轻松列表"的本质区别 */
function RecordRow({
  order,
  fields,
  active,
  copied,
  attachCount,
  onOpen,
  onAdvance,
  onToggleImportant,
  onDelete,
  onCopyFields,
}: {
  order: WorkOrder;
  fields: { label: string; value: string }[];
  active: boolean;
  copied: boolean;
  attachCount: number;
  onOpen: () => void;
  onAdvance: (stageId: string) => void;
  onToggleImportant: () => void;
  onDelete: () => void;
  onCopyFields: () => void;
}) {
  const { stages, flows } = useStore();
  const stage = stages.find((s) => s.id === order.stageId);
  const flow = flows.find((f) => f.id === order.flowId);
  const flowStages = stages
    .filter((s) => s.flowId === order.flowId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = flowStages.findIndex((s) => s.id === order.stageId);
  // 与列表行同一条纪律：只能往前走一步，退回是详情面板里的显式动作
  const next = idx >= 0 ? flowStages[idx + 1] : undefined;

  const color = stage?.color ?? "#888780";
  const ds = dueState(order);
  // 与 OrderRow 的胶囊同一套语义：临期和逾期都是 danger 红，逾期加粗
  const dueStyle: Record<typeof ds, { color: string; background: string; fontWeight?: number }> = {
    overdue: { color: "var(--color-danger)", background: "var(--color-danger-soft)", fontWeight: 700 },
    soon: { color: "var(--color-danger)", background: "var(--color-danger-soft)" },
    ok: { color: "#5a5955", background: "rgba(0,0,0,.055)" },
    none: { color: "#8a8985", background: "rgba(0,0,0,.055)" },
  };

  return (
    <div
      data-order-id={order.id}
      data-order-kind={order.kind}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onOpen();
      }}
      className={`group relative cursor-pointer transition-colors ${
        active ? "bg-chip" : "hover:bg-hover"
      } border-b border-line last:border-b-0`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />}

      <div className={GRID}>
        {/* 记录：单号是"对账用的标识"（等宽、突出），说明跟在后面；第二行是登记时间与备注 */}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {order.important && <Star size={11} className="shrink-0 text-[#ba7517]" fill="#ba7517" />}
            <span
              data-order-no={order.no}
              className={`shrink-0 font-mono text-[12.5px] font-medium ${
                order.closed ? "text-fg-dim line-through" : "text-fg"
              }`}
            >
              {order.no || "（未填单号）"}
            </span>
            <span
              className={`min-w-0 truncate text-[12.5px] ${
                order.closed ? "text-fg-dim line-through" : "text-fg-2"
              }`}
            >
              {order.title || ""}
            </span>
          </div>
          <div className="mt-px flex min-w-0 items-center gap-1 text-[10.5px] text-fg-dim">
            <span className="shrink-0">{fmtCreated(order.createdAt)}</span>
            {order.note && <span className="truncate">· {order.note}</span>}
            {attachCount > 0 && <span className="shrink-0">· 附件 {attachCount}</span>}
          </div>
        </div>

        {/* 流程与当前步骤 + 步数进度 */}
        <div className="min-w-0">
          <span
            data-order-stage={stage?.name ?? ""}
            className="inline-flex max-w-full items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium"
            style={{ color, background: `${color}1f` }}
          >
            <span className="block size-1.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="truncate">{stage?.name ?? "未知阶段"}</span>
          </span>
          <div className="mt-px flex items-center gap-1 text-[10.5px] text-fg-dim">
            <ClipboardList size={10} className="shrink-0" />
            <span className="truncate">{flow?.name ?? "未知流程"}</span>
            {flowStages.length > 0 && (
              <span className="shrink-0 font-mono">
                {Math.max(idx + 1, 1)}/{flowStages.length}
              </span>
            )}
          </div>
        </div>

        {/* 相关信息：行内即可整组复制 —— "快速复制"是这个功能的立身之本 */}
        <div className="min-w-0">
          {fields.length > 0 ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCopyFields();
              }}
              data-sp-field-copy=""
              title={fields.map((f) => `${f.label}：${f.value}`).join("\n")}
              className="flex max-w-full items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-fg-2 transition-colors hover:bg-hover"
            >
              {copied ? <Check size={12} className="shrink-0 text-[#1d9e75]" /> : <Copy size={12} className="shrink-0 text-fg-dim" />}
              <span className="truncate">
                {fields.length} 项 · {fields[0].label}
              </span>
            </button>
          ) : (
            <span className="text-[11.5px] text-fg-dim">—</span>
          )}
        </div>

        {/* 处理时效：与列表/详情/提醒同一套判定与配色 */}
        <div className="min-w-0">
          {order.closed ? (
            <span className="rounded bg-chip px-1.5 py-px text-[11px] text-fg-dim">已完结</span>
          ) : (
            <span
              data-order-due={ds}
              data-order-due-at={order.stageDueAt ?? ""}
              title={order.stageDueAt ? `这一步的时效到 ${dueAtText(order.stageDueAt)}` : "这一步还没设时效"}
              className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium"
              style={dueStyle[ds]}
            >
              <Timer size={11} />
              {ds === "none" ? "未设时效" : dueText(order)}
            </span>
          )}
        </div>
      </div>

      {/* 操作悬浮层：推进（最常用）+ 重要 + 删除。
          悬停才出现，避免常驻一列把核心信息挤出窄主区 */}
      <div
        className={`absolute inset-y-0 right-2 z-10 flex items-center gap-0.5 rounded-md bg-card py-1 pl-1.5 pr-1 opacity-0 shadow-[0_0_0_1px_var(--color-line),0_2px_6px_rgba(0,0,0,0.08)] transition-opacity group-hover:opacity-100`}
      >
        {next && (
          <button
            title={
              next.defaultMinutes > 0
                ? `推进到「${next.name}」（时效续 ${humanDuration(next.defaultMinutes * 60_000)}）`
                : `推进到「${next.name}」`
            }
            onClick={(e) => {
              e.stopPropagation();
              onAdvance(next.id);
            }}
            data-order-advance=""
            className="flex items-center gap-0.5 rounded px-1.5 py-1 text-[11.5px] transition-colors hover:bg-hover"
            style={{ color }}
          >
            <ChevronRight size={13} />
            {next.name}
          </button>
        )}
        <button
          title={order.important ? "取消重要" : "标记为重要"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleImportant();
          }}
          className={`grid size-7 place-items-center rounded transition-colors hover:bg-hover ${
            order.important ? "text-[#ba7517]" : "text-fg-dim"
          }`}
        >
          <Star size={14} fill={order.important ? "#ba7517" : "none"} />
        </button>
        <button
          title="删除这条记录"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="grid size-7 place-items-center rounded text-fg-dim transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
