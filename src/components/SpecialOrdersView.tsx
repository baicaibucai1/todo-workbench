import { useEffect, useMemo, useRef, useState } from "react";
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
  Settings2,
  ArrowRight,
  Download,
  SlidersHorizontal,
  Truck,
  ExternalLink,
} from "lucide-react";
import { useStore } from "../store";
import { today } from "../lib/repo";
import { SETTINGS } from "../lib/settings";
import {
  TRACK_CHANNELS,
  channelLabel,
  courier,
  courierCodeOf,
  courierName,
  openTrackUrl,
  parseTrackChannel,
  resolveTrack,
  type TrackChannel,
} from "../lib/couriers";
import { dueState, dueText, dueAtText, humanDuration, type DueState } from "../lib/due";
import {
  COPY_TEMPLATES,
  MAX_SPECIAL_COLUMNS,
  buildSpecialCsv,
  downloadTextFile,
  formatField,
  formatOrdersFields,
  formatSpecialColumns,
  parseCopyTemplate,
  parseSpecialColumns,
  parseSpecialDensity,
  type CopyTemplate,
} from "../lib/special";
import OrderCreateDialog from "./OrderCreateDialog";
import type { WorkOrder } from "../types";
import type { SpecialExportRow } from "../lib/special";

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
 *   推进按钮 data-order-advance，续时 data-order-extend
 *   工具栏 data-sp-search / data-sp-status / data-sp-flow / data-sp-due /
 *         data-sp-sort / data-sp-register / data-sp-clear / data-edit-flows
 *   多选 data-sp-select / data-sp-select-all / data-sp-batch（批量条）
 *   视图设置 data-sp-view-settings / data-sp-view-panel / data-sp-col
 */

type StatusFilter = "all" | "open" | "closed";
type DueFilter = "all" | "overdue" | "soon" | "ok" | "none";
type RangeFilter = "all" | "today" | "7d" | "30d";
type SortKey = "due" | "recent" | "no";

/** 续时的兜底时长：这一步没配默认时效时给的（分钟） */
const EXTEND_FALLBACK_MINUTES = 30;

/**
 * 表格栅格。
 *
 * 列顺序：勾选 / 记录 / 流程·步骤 / 相关信息 / 自定义列… / 处理时效。
 *
 * 不设独立的「操作」列：详情面板打开后主区通常只剩 580px 上下，
 * 多硬塞一列会把**处理时效**这种核心信息挤出可视区（首版实测如此）。
 * 操作改为行尾悬浮层，悬停出现 —— 和列表行的交互习惯一致。
 *
 * 挂了自定义列之后「相关信息」这一格退化成一个 34px 的复制按钮：
 * 它的内容已经被拆成独立列了，留着整段文字是重复占位。
 */
function gridClass(extra: number, compact: boolean): string {
  const cols = [
    "26px",
    "minmax(176px,1.5fr)",
    "minmax(104px,0.95fr)",
    extra > 0 ? "34px" : "minmax(78px,0.7fr)",
    ...Array.from({ length: extra }, () => "minmax(92px,0.8fr)"),
    "minmax(96px,0.85fr)",
  ];
  return `grid grid-cols-[${cols.join("_")}] items-center gap-2 px-2 ${
    compact ? "py-1" : "py-2"
  }`;
}

/** 登记时间：记录界面里"什么时候进来的"是核对信息，给到分钟 */
function fmtCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return date === today() ? `今天 ${time}` : `${p(d.getMonth() + 1)}月${d.getDate()}日 ${time}`;
}

/**
 * ISO 时间串对应的**本地**日期（YYYY-MM-DD）。
 *
 * 不直接切 `createdAt.slice(0, 10)`：那是 UTC 的日期，而「今天」是本地概念 ——
 * 晚上十点之后建的单会被算到前一天去，"今天登记"里就空了。
 */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 「2026-09-21 14:30」，导出与复制里的时间统一这个样子 */
function fmtStamp(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
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
    settings,
    openOrder,
    advanceOrder,
    removeOrder,
    patchOrder,
    toggleOrderImportant,
    bulkPatchOrders,
    openFlowEditor,
    saveSettings,
  } = useStore();

  // 视图偏好读的是**设置**，不是组件内部 state：
  // "我要看哪几列、复制出来什么格式"是长期习惯，每次进视图重调一遍等于没做。
  const columns = useMemo(
    () => parseSpecialColumns(settings[SETTINGS.specialColumns]),
    [settings],
  );
  const copyTpl = useMemo(
    () => parseCopyTemplate(settings[SETTINGS.specialCopyTemplate]),
    [settings],
  );
  const compact = useMemo(
    () => parseSpecialDensity(settings[SETTINGS.specialDensity]) === "compact",
    [settings],
  );
  /** 查件走哪个渠道（快递100 / 菜鸟 / 官网）。全局偏好，不是每张单的属性 */
  const channel = useMemo<TrackChannel>(
    () => parseTrackChannel(settings[SETTINGS.specialTrackChannel]),
    [settings],
  );

  // 本视图的搜索是**记录检索**，范围就是这批特殊单号（含相关信息字段值）。
  // 不复用全局 search：那个会把视图切到跨列表的"找到它"模式，语义不同。
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [flowId, setFlowId] = useState("");
  const [due, setDue] = useState<DueFilter>("all");
  const [range, setRange] = useState<RangeFilter>("all");
  const [onlyImportant, setOnlyImportant] = useState(false);
  /** 按快递商筛选：'' = 全部 */
  const [courierFilter, setCourierFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("due");
  /** 刚点过「复制」的那一行：图标短暂变成勾，给"真的复制上了"的反馈 */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 同上，但是复制的是快递单号（两个动作各自反馈，互不打断） */
  const [copiedNoId, setCopiedNoId] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  /** 勾选中的记录 id */
  const [selected, setSelected] = useState<string[]>([]);
  /** 批量删除要二次确认：一次勾十条点错就十条都没了 */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const say = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  };

  // 点面板外就收起。用 mousedown 而不是 click：面板里的下拉一展开，
  // click 会先被捕获判断成"点在外面"，面板当场关掉。
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      setPanelOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [panelOpen]);

  // 第二道闸：数据层（fetchWorkOrders 的 special 分支）已经只放行 kind='special'，
  // 这里再显式过滤一次 —— 全局搜索态、或未来哪个调用方传错，都不该让
  // 普通工单混进这张记录表（和 rows.ts 里 myday 的纪律同源）。
  const specials = useMemo(() => orders.filter((o) => o.kind === "special"), [orders]);

  /** 按单分组的字段（含 label/value，搜索、自定义列、导出都要用） */
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
    const t = today();
    let open = 0;
    let closed = 0;
    let overdue = 0;
    let soon = 0;
    let todayNew = 0;
    for (const o of specials) {
      if (localDay(o.createdAt) === t) todayNew++;
      if (o.closed) {
        closed++;
        continue;
      }
      open++;
      const ds = dueState(o);
      if (ds === "overdue") overdue++;
      else if (ds === "soon") soon++;
    }
    return { total: specials.length, open, closed, overdue, soon, todayNew };
  }, [specials]);

  // 有特殊单号的流程才有资格出现在分类下拉里：没有单的流程挂上去是噪音
  const flowOptions = useMemo(() => {
    const used = new Set(specials.map((o) => o.flowId));
    return flows.filter((f) => used.has(f.id));
  }, [flows, specials]);

  /**
   * 快递商下拉里的选项：只列**这批单上真出现过的**那些。
   *
   * 十四家全列出来，下拉里绝大多数点开是空的 ——
   * "按快递商分类"是拿它切一小批出来看，候选应该跟着手上的单子长。
   */
  const courierOptions = useMemo(() => {
    const count = new Map<string, number>();
    for (const o of specials) {
      const code = courierCodeOf(o.no, o.courier);
      count.set(code, (count.get(code) ?? 0) + 1);
    }
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] || "～").localeCompare(b[0] || "～"))
      .map(([code, n]) => ({ code, n }));
  }, [specials]);

  /**
   * 自定义列的候选字段名：这批单上真实用过多少次，按次数降序。
   *
   * 从**实际数据**里长出来，而不是让用户先去某处维护一份"字段字典"：
   * 他登记时随手起的那些名字就是字典，再维护一份是白多一处会漂移的地方。
   */
  const columnCandidates = useMemo(() => {
    const count = new Map<string, number>();
    for (const o of specials) {
      for (const f of fieldsByOrder.get(o.id) ?? []) {
        const label = f.label.trim();
        if (label) count.set(label, (count.get(label) ?? 0) + 1);
      }
    }
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, n]) => ({ label, n }));
  }, [specials, fieldsByOrder]);

  /** 勾选项里可能留着"这一批数据里已经没人用"的字段名，也要能取消掉 */
  const columnOptions = useMemo(() => {
    const names = columnCandidates.map((c) => c.label);
    for (const c of columns) if (!names.includes(c)) names.push(c);
    return names;
  }, [columnCandidates, columns]);

  const rows = useMemo(() => {
    // 多个关键词按空格切开、全部命中才算：翻记录时人记得的往往是
    // "张三 补发"这种两个片段，只能填一个词就得来回搜两遍
    const kws = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = (o: WorkOrder) => {
      if (!kws.length) return "";
      const stage = stages.find((s) => s.id === o.stageId)?.name ?? "";
      const flow = flows.find((f) => f.id === o.flowId)?.name ?? "";
      const fields = fieldsByOrder.get(o.id) ?? [];
      return [
        o.no,
        o.title,
        o.note,
        flow,
        stage,
        ...fields.map((f) => `${f.label} ${f.value}`),
      ]
        .join(" ")
        .toLowerCase();
    };

    let list = specials;
    if (kws.length) {
      list = list.filter((o) => {
        const hay = haystack(o);
        return kws.every((kw) => hay.includes(kw));
      });
    }
    if (status !== "all") list = list.filter((o) => (status === "open" ? !o.closed : o.closed));
    if (flowId) list = list.filter((o) => o.flowId === flowId);
    if (due !== "all") list = list.filter((o) => (o.closed ? false : dueState(o) === due));
    if (onlyImportant) list = list.filter((o) => o.important);
    if (courierFilter) {
      list = list.filter((o) => courierCodeOf(o.no, o.courier) === courierFilter);
    }
    if (range === "today") {
      // "今天"是**本地的这一整天**，不是"最近 0 毫秒" —— 后者会一条都筛不出来
      const t = today();
      list = list.filter((o) => localDay(o.createdAt) === t);
    } else if (range !== "all") {
      const days = range === "7d" ? 7 : 30;
      const since = Date.now() - days * 86_400_000;
      list = list.filter((o) => new Date(o.createdAt).getTime() >= since);
    }

    const sorted = [...list];
    if (sort === "no") {
      sorted.sort((a, b) => (a.no || "～").localeCompare(b.no || "～"));
    } else if (sort === "recent") {
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
  }, [
    specials,
    q,
    status,
    flowId,
    due,
    onlyImportant,
    courierFilter,
    range,
    sort,
    stages,
    flows,
    fieldsByOrder,
  ]);

  // 勾选里的 id 可能因为筛选变化、或被删掉而失效，每次渲染夹回当前可见范围内
  const visibleIds = useMemo(() => rows.map((o) => o.id), [rows]);
  const selectedRows = useMemo(
    () => rows.filter((o) => selected.includes(o.id)),
    [rows, selected],
  );
  useEffect(() => {
    setSelected((prev) => {
      const next = prev.filter((id) => visibleIds.includes(id));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleIds]);

  const filtersActive =
    q.trim() !== "" ||
    status !== "all" ||
    flowId !== "" ||
    due !== "all" ||
    range !== "all" ||
    onlyImportant ||
    courierFilter !== "";

  const clearFilters = () => {
    setQ("");
    setStatus("all");
    setFlowId("");
    setDue("all");
    setRange("all");
    setOnlyImportant(false);
    setCourierFilter("");
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const flashCopied = (id: string) => {
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600);
  };

  /**
   * 单独复制快递单号。
   *
   * 这是这类记录上最高频的一个动作（拿去官网查件、贴给快递公司），
   * 而"相关信息"那一组里并没有它 —— 单号是这条记录的**标识**，
   * 不是它绑的信息。所以给它一个自己的按钮，不用打开详情去框选。
   */
  const copyNo = async (o: WorkOrder) => {
    if (!o.no.trim()) return;
    if (!(await copyText(o.no))) return;
    setCopiedNoId(o.id);
    window.setTimeout(() => setCopiedNoId((c) => (c === o.id ? null : c)), 1600);
  };

  const copyOne = async (o: WorkOrder) => {
    const fields = fieldsByOrder.get(o.id) ?? [];
    if (!fields.length) return;
    if (await copyText(formatOrdersFields([{ no: o.no, fields }], copyTpl))) flashCopied(o.id);
  };

  const copySelected = async () => {
    const groups = selectedRows.map((o) => ({ no: o.no, fields: fieldsByOrder.get(o.id) ?? [] }));
    const text = formatOrdersFields(groups, copyTpl);
    if (!text) {
      say("选中的记录上没有可复制的相关信息");
      return;
    }
    say(await copyText(text) ? `已复制 ${selectedRows.length} 条记录的相关信息` : "复制失败");
  };

  /** 这条记录上**生效**的快递商：库里指定了就用指定的，否则按单号识别 */
  const codeOf = (o: WorkOrder) => courierCodeOf(o.no, o.courier);
  const trackOf = (o: WorkOrder) => resolveTrack(o.no, codeOf(o), channel);

  /**
   * 打开这一单的查询页。
   *
   * 在系统浏览器里开，而不是塞进应用内 —— 查件要登录、要打单、要看完整轨迹，
   * 那些事情在应用里那个没有地址栏的窗口里做不了。
   */
  const openTrack = (o: WorkOrder) => {
    const link = trackOf(o);
    if (!link) {
      say("这条记录还没有单号，没法查");
      return;
    }
    if (!openTrackUrl(link.url)) {
      say("浏览器拦下了新窗口，请改用「复制查询链接」");
      return;
    }
    if (link.fellBack) {
      say(`${courierName(codeOf(o))} 没有可直接带单号的官网查询页，已用${channelLabel(link.channel)}`);
    }
  };

  /** 批量把查询链接复制走：发给同事时"他点开就是这一单"，比发一串单号有用 */
  const copyTrackLinks = async () => {
    const lines: string[] = [];
    for (const o of selectedRows) {
      const link = trackOf(o);
      if (link) lines.push(`${o.no}\t${link.url}`);
    }
    if (!lines.length) {
      say("选中的记录里没有可查的单号");
      return;
    }
    say(await copyText(lines.join("\n")) ? `已复制 ${lines.length} 条查询链接` : "复制失败");
  };

  /** 下一步：只能往前走一步，退回是详情面板里的显式动作 */
  const nextStageOf = (o: WorkOrder) => {
    const flowStages = stages
      .filter((s) => s.flowId === o.flowId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = flowStages.findIndex((s) => s.id === o.stageId);
    return idx >= 0 ? flowStages[idx + 1] : undefined;
  };

  const advanceSelected = async () => {
    const targets = selectedRows
      .filter((o) => !o.closed)
      .map((o) => ({ id: o.id, next: nextStageOf(o) }))
      .filter((t): t is { id: string; next: NonNullable<ReturnType<typeof nextStageOf>> } =>
        Boolean(t.next),
      );
    if (!targets.length) {
      say("选中的记录里没有可以推进的（已完结，或已在最后一步）");
      return;
    }
    // 推进完**不清空选择**：记录还在、还要继续处理（再推一步、或推完删掉），
    // 让人重新勾一遍是白做一步。只有删除才会清空 —— 那时候行已经没了。
    for (const t of targets) await advanceOrder(t.id, t.next.id);
    say(`已推进 ${targets.length} 条记录`);
  };

  const markSelected = async (important: boolean) => {
    if (!selected.length) return;
    await bulkPatchOrders(selected, { important });
    say(`已${important ? "标记" : "取消"} ${selected.length} 条记录的重要`);
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    for (const id of ids) await removeOrder(id);
    setSelected([]);
    setConfirmDelete(false);
    say(`已删除 ${ids.length} 条记录`);
  };

  const exportCsv = () => {
    // 勾了就导勾中的，没勾就导当前筛选出来的全部 —— 后者才是"把这张表带走"的日常用法
    const list = selectedRows.length ? selectedRows : rows;
    if (!list.length) return;
    const payload: SpecialExportRow[] = list.map((o) => {
      const stage = stages.find((s) => s.id === o.stageId);
      const flow = flows.find((f) => f.id === o.flowId);
      const link = resolveTrack(o.no, codeOf(o), channel);
      return {
        no: o.no,
        courier: courierName(codeOf(o)),
        trackUrl: link?.url ?? "",
        title: o.title,
        flowName: flow?.name ?? "",
        stageName: stage?.name ?? "",
        status: o.closed ? "已完结" : "处理中",
        important: o.important,
        createdAt: fmtStamp(o.createdAt),
        dueAt: o.closed ? null : fmtStamp(o.stageDueAt),
        dueState: dueState(o),
        note: o.note,
        fields: fieldsByOrder.get(o.id) ?? [],
      };
    });
    downloadTextFile(
      `特殊单号-${today()}.csv`,
      buildSpecialCsv(payload, columns),
      "text/csv",
    );
    say(`已导出 ${payload.length} 条记录为 CSV`);
  };

  const extendOrder = (o: WorkOrder) => {
    const stage = stages.find((s) => s.id === o.stageId);
    const min =
      stage && stage.defaultMinutes > 0 ? stage.defaultMinutes : EXTEND_FALLBACK_MINUTES;
    void patchOrder(o.id, { stageDueAt: new Date(Date.now() + min * 60_000).toISOString() });
  };

  const grid = gridClass(columns.length, compact);
  const allChecked = rows.length > 0 && selected.length === rows.length;

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
        <div className="relative">
          <div
            data-sp-toolbar=""
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card p-2"
          >
            <div className="relative min-w-[200px] flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim"
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  // Esc 清空搜索：翻记录时"回到全量"是最常做的动作，
                  // 让人去点那个不一定还在的「清除筛选」太绕
                  if (e.key === "Escape" && q) {
                    e.stopPropagation();
                    setQ("");
                  }
                }}
                data-sp-search=""
                placeholder="搜索快递单号、说明或相关信息（可空格分隔多个词）"
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

            {/* 快递商：按"这批单是谁家的"切一刀。
                只列手上真出现过的那几家（见 courierOptions 的说明） */}
            {courierOptions.length > 1 && (
              <select
                value={courierFilter}
                onChange={(e) => setCourierFilter(e.target.value)}
                data-sp-courier=""
                title="按快递商分类"
                className="shrink-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-2 outline-none"
              >
                <option value="">全部快递商</option>
                {courierOptions.map(({ code, n }) => (
                  <option key={code || "_none"} value={code}>
                    {code ? courierName(code) : "未识别"} {n}
                  </option>
                ))}
              </select>
            )}

            {/* 登记时间：翻历史单时"只看最近一周"是最常用的一刀 */}
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as RangeFilter)}
              data-sp-range=""
              title="按登记时间筛选"
              className="shrink-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-2 outline-none"
            >
              <option value="all">全部时间</option>
              <option value="today">今天登记</option>
              <option value="7d">近 7 天</option>
              <option value="30d">近 30 天</option>
            </select>

            {/* 只看重要的 */}
            <button
              onClick={() => setOnlyImportant((v) => !v)}
              data-sp-important=""
              title="只看标记为重要的记录"
              className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1.5 text-[12px] transition-colors ${
                onlyImportant
                  ? "border-[#ba7517] bg-[#ba7517]/10 text-[#ba7517]"
                  : "border-line bg-surface text-fg-3 hover:bg-hover"
              }`}
            >
              <Star size={12} fill={onlyImportant ? "#ba7517" : "none"} />
              重要
            </button>

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

            <button
              onClick={exportCsv}
              disabled={rows.length === 0}
              data-sp-export-all=""
              title={
                rows.length
                  ? "导出当前这些记录为 CSV（勾了就只导勾中的）"
                  : "当前没有可导出的记录"
              }
              className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-3 transition-colors hover:bg-hover disabled:opacity-45 disabled:hover:bg-surface"
            >
              <Download size={12} />
              导出
            </button>

            <button
              onClick={() => setPanelOpen((v) => !v)}
              data-sp-view-settings=""
              title="自定义列、复制格式与行高密度"
              className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-3 transition-colors hover:bg-hover"
            >
              <SlidersHorizontal size={12} />
              视图设置
            </button>

            {filtersActive && (
              <button
                onClick={clearFilters}
                data-sp-clear=""
                className="shrink-0 rounded-md px-2 py-1.5 text-[12px] text-fg-dim transition-colors hover:bg-hover hover:text-fg-2"
              >
                清除筛选
              </button>
            )}
          </div>

          {/* 视图设置面板 */}
          {panelOpen && (
            <div
              ref={panelRef}
              data-sp-view-panel=""
              className="absolute right-0 top-full z-30 mt-1 w-[300px] rounded-lg border border-line bg-panel p-3 shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
                <Settings2 size={13} />
                自定义列
              </div>
              <p className="mb-1.5 text-[11px] leading-relaxed text-fg-dim">
                把常要核对的相关信息挂到表上（最多 {MAX_SPECIAL_COLUMNS} 列）
              </p>
              {columnOptions.length === 0 ? (
                <p className="rounded-md bg-chip px-2 py-1.5 text-[11.5px] text-fg-dim">
                  还没有绑定过相关信息 —— 登记时填的那些字段名会出现在这里
                </p>
              ) : (
                <div className="max-h-[190px] overflow-y-auto" data-sp-col-list="">
                  {columnOptions.map((label) => {
                    const on = columns.includes(label);
                    const full = !on && columns.length >= MAX_SPECIAL_COLUMNS;
                    return (
                      <label
                        key={label}
                        data-sp-col={label}
                        data-sp-col-on={on ? "1" : "0"}
                        className={`flex items-center gap-2 rounded px-1 py-1 text-[12px] ${
                          full ? "opacity-45" : "hover:bg-hover"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={full}
                          onChange={() =>
                            void saveSettings({
                              [SETTINGS.specialColumns]: formatSpecialColumns(
                                on ? columns.filter((c) => c !== label) : [...columns, label],
                              ),
                            })
                          }
                          className="size-3.5 accent-[#d85a30]"
                        />
                        <span className="min-w-0 flex-1 truncate text-fg-2">{label}</span>
                        <span className="shrink-0 text-[10.5px] text-fg-dim">
                          {columnCandidates.find((c) => c.label === label)?.n ?? 0} 条
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 mb-1.5 text-[12px] font-medium text-fg-2">复制格式</div>
              <select
                value={copyTpl}
                onChange={(e) =>
                  void saveSettings({
                    [SETTINGS.specialCopyTemplate]: e.target.value as CopyTemplate,
                  })
                }
                data-sp-copy-template=""
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-2 outline-none"
              >
                {COPY_TEMPLATES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <pre
                data-sp-copy-preview=""
                className="mt-1 whitespace-pre-wrap rounded-md bg-chip px-2 py-1.5 text-[11px] leading-relaxed text-fg-dim"
              >
                {COPY_TEMPLATES.find((t) => t.value === copyTpl)?.hint ?? ""}
              </pre>

              <div className="mt-3 mb-1.5 text-[12px] font-medium text-fg-2">查件渠道</div>
              <select
                value={channel}
                onChange={(e) =>
                  void saveSettings({
                    [SETTINGS.specialTrackChannel]: e.target.value as TrackChannel,
                  })
                }
                data-sp-track-channel=""
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg-2 outline-none"
              >
                {TRACK_CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <p
                data-sp-track-hint=""
                className="mt-1 whitespace-pre-wrap rounded-md bg-chip px-2 py-1.5 text-[11px] leading-relaxed text-fg-dim"
              >
                {TRACK_CHANNELS.find((c) => c.value === channel)?.hint ?? ""}
              </p>

              <div className="mt-3 flex items-center gap-2">
                <span className="flex-1 text-[12px] font-medium text-fg-2">紧凑行高</span>
                <button
                  onClick={() =>
                    void saveSettings({
                      [SETTINGS.specialDensity]: compact ? "comfortable" : "compact",
                    })
                  }
                  data-sp-density=""
                  data-sp-density-on={compact ? "1" : "0"}
                  className={`rounded-md border px-2 py-1 text-[11.5px] transition-colors ${
                    compact
                      ? "border-[#d85a30] bg-[#d85a30]/10 text-[#d85a30]"
                      : "border-line text-fg-3 hover:bg-hover"
                  }`}
                >
                  {compact ? "已开启" : "已关闭"}
                </button>
              </div>
            </div>
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
          {stats.todayNew > 0 && <span>今日新增 {stats.todayNew}</span>}
          {(q.trim() || filtersActive) && (
            <span className="text-fg-3">命中 {rows.length} 条 · 命中范围含相关信息字段</span>
          )}
          {toast && (
            <span data-sp-toast="" className="font-medium text-[#1d9e75]">
              {toast}
            </span>
          )}
        </div>

        {/* 批量操作条：勾了才出现。放在统计条下面，位置固定，不会顶掉筛选 */}
        {selected.length > 0 && (
          <div
            data-sp-batch=""
            data-sp-batch-count={selected.length}
            className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-[#d85a30]/40 bg-[#d85a30]/[0.07] px-2 py-1.5"
          >
            <span className="px-1 text-[12px] font-medium text-fg-2">
              已选 {selected.length} 条
            </span>
            <button
              onClick={() => void advanceSelected()}
              data-sp-batch-advance=""
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-2 transition-colors hover:bg-hover"
            >
              <ArrowRight size={12} />
              推进下一步
            </button>
            <button
              onClick={() => void markSelected(true)}
              data-sp-batch-important=""
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-2 transition-colors hover:bg-hover"
            >
              <Star size={12} />
              标记重要
            </button>
            <button
              onClick={() => void markSelected(false)}
              data-sp-batch-unimportant=""
              className="rounded-md px-2 py-1 text-[12px] text-fg-3 transition-colors hover:bg-hover"
            >
              取消重要
            </button>
            <button
              onClick={() => void copySelected()}
              data-sp-batch-copy=""
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-2 transition-colors hover:bg-hover"
            >
              <Copy size={12} />
              复制信息
            </button>
            <button
              onClick={() => void copyTrackLinks()}
              data-sp-batch-track=""
              title="把选中每条的查询链接复制走（单号 + 网址）"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-2 transition-colors hover:bg-hover"
            >
              <ExternalLink size={12} />
              复制查询链接
            </button>
            <button
              onClick={exportCsv}
              data-sp-export=""
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-2 transition-colors hover:bg-hover"
            >
              <Download size={12} />
              导出 CSV
            </button>
            <div className="flex-1" />
            {confirmDelete ? (
              <>
                <span className="text-[12px] text-danger">删掉这 {selected.length} 条？</span>
                <button
                  onClick={() => void deleteSelected()}
                  data-sp-batch-confirm=""
                  className="rounded-md bg-danger px-2 py-1 text-[12px] font-medium text-white"
                >
                  确认删除
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md px-2 py-1 text-[12px] text-fg-3 hover:bg-hover"
                >
                  算了
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                data-sp-batch-delete=""
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-3 transition-colors hover:bg-danger-soft hover:text-danger"
              >
                <Trash2 size={12} />
                删除
              </button>
            )}
            <button
              onClick={() => {
                setSelected([]);
                setConfirmDelete(false);
              }}
              data-sp-batch-clear=""
              className="rounded-md px-2 py-1 text-[12px] text-fg-dim hover:bg-hover"
            >
              取消选择
            </button>
          </div>
        )}
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
              onClick={clearFilters}
              data-sp-clear=""
              className="mt-1.5 rounded-md border border-line px-3 py-1.5 text-[12.5px] text-fg-2 transition-colors hover:bg-hover"
            >
              清除筛选条件
            </button>
          </div>
        ) : (
          <div className="min-w-[600px] overflow-hidden rounded-lg border border-line bg-card">
            {/* 表头 */}
            <div className={`${grid} border-b border-line bg-surface text-[11px] font-medium text-fg-dim`}>
              <input
                type="checkbox"
                checked={allChecked}
                onChange={() => setSelected(allChecked ? [] : visibleIds)}
                data-sp-select-all=""
                title="全选（当前筛选出来的）"
                className="size-3.5 accent-[#d85a30]"
              />
              <span>记录（单号 / 说明）</span>
              <span>流程 · 当前步骤</span>
              <span>{columns.length ? "" : "相关信息"}</span>
              {columns.map((c) => (
                <span key={c} className="truncate" title={c}>
                  {c}
                </span>
              ))}
              <span>处理时效</span>
            </div>

            {rows.map((o) => (
              <RecordRow
                key={o.id}
                order={o}
                fields={fieldsByOrder.get(o.id) ?? []}
                columns={columns}
                grid={grid}
                active={activeOrderId === o.id}
                copied={copiedId === o.id}
                copiedNo={copiedNoId === o.id}
                checked={selected.includes(o.id)}
                attachCount={woAttachmentCounts[o.id] ?? 0}
                onOpen={() => openOrder(o.id)}
                onToggleCheck={() => toggleSelect(o.id)}
                onCopyNo={() => void copyNo(o)}
                courierCode={codeOf(o)}
                onTrack={() => openTrack(o)}
                onAdvance={(stageId) => void advanceOrder(o.id, stageId)}
                onExtend={() => extendOrder(o)}
                onToggleImportant={() => void toggleOrderImportant(o)}
                onDelete={() => void removeOrder(o.id)}
                onCopyFields={() => void copyOne(o)}
                copyTpl={copyTpl}
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
  columns,
  grid,
  active,
  copied,
  copiedNo,
  checked,
  attachCount,
  courierCode,
  onOpen,
  onToggleCheck,
  onCopyNo,
  onTrack,
  onAdvance,
  onExtend,
  onToggleImportant,
  onDelete,
  onCopyFields,
  copyTpl,
}: {
  order: WorkOrder;
  fields: { label: string; value: string }[];
  columns: string[];
  grid: string;
  active: boolean;
  copied: boolean;
  copiedNo: boolean;
  checked: boolean;
  attachCount: number;
  /** 生效的快递商代号（已把"库里指定 / 自动识别"合并过） */
  courierCode: string;
  onOpen: () => void;
  onToggleCheck: () => void;
  onCopyNo: () => void;
  onTrack: () => void;
  onAdvance: (stageId: string) => void;
  onExtend: () => void;
  onToggleImportant: () => void;
  onDelete: () => void;
  onCopyFields: () => void;
  copyTpl: CopyTemplate;
}) {
  const { stages, flows, settings } = useStore();
  const channel = parseTrackChannel(settings[SETTINGS.specialTrackChannel]);
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
  const dueStyle: Record<DueState, { color: string; background: string; fontWeight?: number }> = {
    overdue: { color: "var(--color-danger)", background: "var(--color-danger-soft)", fontWeight: 700 },
    soon: { color: "var(--color-danger)", background: "var(--color-danger-soft)" },
    ok: { color: "#5a5955", background: "rgba(0,0,0,.055)" },
    none: { color: "#8a8985", background: "rgba(0,0,0,.055)" },
  };

  const extendMinutes =
    stage && stage.defaultMinutes > 0 ? stage.defaultMinutes : EXTEND_FALLBACK_MINUTES;

  return (
    <div
      data-order-id={order.id}
      data-order-kind={order.kind}
      data-order-important={order.important ? "1" : "0"}
      data-sp-checked={checked ? "1" : "0"}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button,input")) return;
        onOpen();
      }}
      className={`group relative cursor-pointer transition-colors ${
        checked ? "bg-[#d85a30]/[0.06]" : active ? "bg-chip" : "hover:bg-hover"
      } border-b border-line last:border-b-0`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />}

      <div className={grid}>
        {/* 勾选：批量推进/删除/导出的人口 */}
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggleCheck}
          data-sp-select={order.id}
          title="选中这条记录"
          className="size-3.5 accent-[#d85a30]"
        />

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
            {order.no && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCopyNo();
                }}
                data-order-copy-no={order.no}
                title="复制这个快递单号"
                className="shrink-0 rounded p-0.5 text-fg-dim opacity-0 transition-opacity hover:text-fg-2 group-hover:opacity-100"
              >
                {copiedNo ? (
                  <Check size={11} className="text-[#1d9e75]" />
                ) : (
                  <Copy size={11} />
                )}
              </button>
            )}
            {/* 快递商 + 查件入口。
                认不出也照样给按钮：聚合查询自己还会再认一次单号，
                "认不出"不该变成"查不了" */}
            {order.no && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTrack();
                }}
                data-order-courier={courierCode}
                data-order-track=""
                title={
                  courierCode
                    ? `去${channelLabel(channel)}查 ${order.no}（${courierName(courierCode)}）`
                    : `没认出快递商，仍可去${channelLabel(channel)}查 ${order.no}`
                }
                className="flex shrink-0 items-center gap-0.5 rounded bg-chip px-1 py-px text-[10.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              >
                {courierCode ? (
                  <>
                    <Truck size={10} />
                    {courier(courierCode)?.short ?? ""}
                  </>
                ) : (
                  <>
                    <ExternalLink size={10} />
                    查询
                  </>
                )}
              </button>
            )}
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

        {/* 相关信息：行内即可整组复制 —— "快速复制"是这个功能的立身之本。
            挂了自定义列之后它只留一个复制按钮（内容已经拆成列了） */}
        <div className="min-w-0">
          {fields.length > 0 ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCopyFields();
              }}
              data-sp-field-copy=""
              title={fields.map((f) => formatField(f, copyTpl)).join("\n")}
              className="flex max-w-full items-center gap-1 rounded px-1 py-1 text-[11.5px] text-fg-2 transition-colors hover:bg-hover"
            >
              {copied ? (
                <Check size={12} className="shrink-0 text-[#1d9e75]" />
              ) : (
                <Copy size={12} className="shrink-0 text-fg-dim" />
              )}
              {columns.length === 0 && (
                <span className="truncate">
                  {fields.length} 项 · {fields[0].label}
                </span>
              )}
            </button>
          ) : (
            <span className="text-[11.5px] text-fg-dim">—</span>
          )}
        </div>

        {/* 自定义列：取这条单上同名的值 */}
        {columns.map((c) => {
          const v = fields.find((f) => f.label.trim() === c)?.value ?? "";
          return (
            <div key={c} className="min-w-0" data-sp-cell={c}>
              {v ? (
                <span className="block truncate font-mono text-[11.5px] text-fg-2" title={v}>
                  {v}
                </span>
              ) : (
                <span className="text-[11.5px] text-fg-dim">—</span>
              )}
            </div>
          );
        })}

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

      {/* 操作悬浮层：推进（最常用）+ 续时 + 重要 + 删除。
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
        {!order.closed && (
          <button
            title={`续时 ${humanDuration(extendMinutes * 60_000)}（从现在重新起算）`}
            onClick={(e) => {
              e.stopPropagation();
              onExtend();
            }}
            data-order-extend=""
            data-order-extend-minutes={extendMinutes}
            className="flex items-center gap-0.5 rounded px-1.5 py-1 text-[11.5px] text-fg-3 transition-colors hover:bg-hover"
          >
            <Timer size={12} />
            +{extendMinutes >= 60 ? `${extendMinutes / 60}小时` : `${extendMinutes}分`}
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
