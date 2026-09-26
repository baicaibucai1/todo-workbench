/**
 * 扩展注册表 —— 宿主只问它「现在该显示什么」。
 *
 * ============================ 它替代了什么 ============================
 *
 * 以前「一个功能在不在」这件事散在五六个文件里各判一次：
 * 侧栏在 SMART_ITEMS 后面跟一个 `specialOn &&`、setView 里拦一道、
 * 提醒循环提前 return、紧急区过滤掉、rows.ts 再传一次开关。
 * 每加一个模块都要把这五处各补一遍，漏一处不报错，只是界面有一半不对。
 *
 * 现在这些都归一处：`isEnabled()` 问注册表，注册表只认 settings 里那一个键。
 * 加一个模块的代价从「改五个文件」变成「在这里登记一条」。
 *
 * ============================ 这里为什么不能有组件 ============================
 *
 * 注册表**不 import 任何 React 组件**。它不是洁癖：
 * 组件会 import store，而 store 要问注册表「这个视图的模块开着吗」
 * （setView 得拦住往已关闭模块的跳转）。一旦注册表反过来 import 组件，
 * 就成 store → registry → TaskList → store 的环 —— ESM 循环依赖不报错，
 * 但模块初始化顺序一变，某个东西在某一刻就是 undefined，
 * 症状是"有时首屏空白"。
 *
 * 所以渲染体单独放在 views.tsx（它单向依赖组件），这里只放数据。
 *
 * ============================ 开关存在哪 ============================
 *
 * `ext.<id>.enabled`，和别的一样是 core_settings 里的一行。
 * 没有单独的表、没有单独的配置文件 —— 设置就是设置，
 * 一个模块的开关和"要不要开提醒"在物理上没有区别。
 */

import { CORE_EXTENSION_ID, normalizeInjectHeight } from "./types";
import type {
  Capability,
  ExtensionIconName,
  ExtensionManifest,
  InjectPoint,
  ResolvedExtension,
  ToolInjectKind,
  ToolInjectSpec,
} from "./types";
import type { ToolManifest } from "../../types";

/**
 * 宿主认得的能力名。
 *
 * manifest 是外部输入，工具想写什么能力都写得上去 —— 所以在这里过一道白名单，
 * 认不出来的名字当场丢掉。宿主因此永远不会去判断一个自己不认识的"能力"。
 */
export const CAPABILITY_NAMES: Capability[] = ["gallery", "attachments", "row", "kv", "task"];

/**
 * AI 助手的模块 id。
 *
 * 它登记在注册表里（见下面 BUILTIN），但**入口只有悬浮球**，所以它没有 nav /
 * view 注入点；登记的目的是让"它是这个程序里的一个模块"有地方写，
 * 也让它的开关沿用统一的 `ext.<id>.enabled`，不必另造一套键。
 */
export const AGENT_EXT_ID = "agent";

/* ------------------------------------------------------------------ */
/* 内置扩展                                                            */
/* ------------------------------------------------------------------ */

const BUILTIN: ExtensionManifest[] = [
  {
    // 内核 = 待办本体。**永远启用、不可卸载、不出现在选装列表里** ——
    // 没有待办的工作台没有存在的意义，给用户一个「关掉内核」的开关
    // 只会得到一个空的侧边栏和一个不知道发生了什么的人。
    id: CORE_EXTENSION_ID,
    name: "待办",
    description: "任务 / 清单 / 子任务、我的一天 · 重要 · 全部、详情面板与提醒",
    version: "1.0.0",
    core: true,
    enabledByDefault: true,
    injects: [
      { kind: "nav", id: "myday", group: "tasks", icon: "sun" },
      { kind: "nav", id: "important", group: "tasks", icon: "star" },
      { kind: "nav", id: "all", group: "tasks", icon: "inbox" },
      { kind: "view", id: "myday" },
      { kind: "view", id: "important" },
      { kind: "view", id: "all" },
      { kind: "view", id: "list" },
    ],
    capabilities: ["attachments"],
  },
  {
    id: "orders",
    name: "流程任务",
    description: "可定制流程的过程态流转，每步留痕；这批单子也混在「全部」里",
    version: "1.0.0",
    enabledByDefault: true,
    injects: [
      { kind: "nav", id: "orders", group: "tasks", icon: "clipboard-list" },
      { kind: "view", id: "orders" },
    ],
    capabilities: [],
  },
  {
    // 选装（v17）：默认不带。它有完整的关闭语义 —— 入口、专属视图、
    // 创建弹窗类型、我的一天那组、时效提醒与紧急区一起收起，
    // 已经建好的单子仍留在「流程任务」里。
    id: "special",
    name: "特殊单号",
    description: "以快递单号起算、每步带处理时效的流程任务；临期与逾期各提醒一次",
    version: "1.0.0",
    enabledByDefault: false,
    injects: [
      { kind: "nav", id: "special", group: "tasks", icon: "timer" },
      { kind: "view", id: "special" },
    ],
    capabilities: [],
  },
  {
    // 选装（v18）：图库是所有工具产物的**共同落点**（在以前它是写进 App.tsx
    // 的一个分支）。它同时提供 `gallery` 能力 —— 工具在 manifest 里申请，
    // 宿主按这个模块有没有启用决定放不放行。
    //
    // 注意 group：它不属于"看哪些任务"，属于"这个程序里还有什么地方可去"，
    // 所以和「设置」挨在一起（2026-09-22 的取舍）。
    id: "gallery",
    name: "图库",
    description: "所有图片 / 视频的共同落点：工具的产物存进来，工具要用的素材从这里取",
    version: "1.0.0",
    enabledByDefault: false,
    injects: [
      { kind: "nav", id: "gallery", group: "places", icon: "images" },
      { kind: "view", id: "gallery" },
    ],
    capabilities: ["gallery"],
  },
  {
    /*
     * 工作区：助手写文件的地方，也是**它产出物的陈列架**。
     *
     * 选装（默认关）：多数时候用户没让它写报告，侧栏里挂一个"工作区"
     * 只是多一个空目录给人找。什么时候它真的派上用场？
     *   · 助手写完文件，动作卡上给一个直达按钮；
     *   · 或者你在设置里主动打开它。
     * 默认收起不代表看不见 —— 助手每写一次文件都会在对话里把路径报出来。
     */
    id: "workspace",
    name: "工作区",
    description: "助手写文件的地方：报告、方案、markdown 都落在这里，可以打开、预览、删",
    version: "1.0.0",
    enabledByDefault: false,
    injects: [
      { kind: "nav", id: "workspace", group: "places", icon: "folder-open" },
      { kind: "view", id: "workspace" },
    ],
    capabilities: [],
  },
  {
    // AI 助手：**刻意不注入任何界面**（它只有悬浮球一个入口，侧栏那一项
    // 2026-09-23 按用户要求去掉了，两个 e2e 套件盯着这件事）。
    // 登记在这儿是为了让"它也是一个模块"这件事有地方写：它的开关不在
    // 统一的 ext.* 键上（有没有配 Key 才决定它在不在），所以 `selectable`
    // 会跳过它 —— 不是内核，也不是选装。
    id: AGENT_EXT_ID,
    name: "AI 助手",
    description: "能动手的助手：入口只有悬浮球，能力写在 lib/agent/protocol.ts 的动作表里",
    version: "1.0.0",
    enabledByDefault: true,
    injects: [],
    capabilities: [],
  },
];

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

/** id → 已解析项。工具扫描完由 hydrateTools 灌进来 */
let table = new Map<string, ResolvedExtension>(
  BUILTIN.map((b) => [b.id, { ...b, source: "builtin" as const }]),
);

/**
 * 把扫出来的工具灌进注册表。
 *
 * 工具和工具的 manifest 形状不同，所以在门口就转成同一种 —— 上层只认一种形状。
 * 注意 source 在这里盖戳：工具的 manifest 里就算写了 `source` 也不算数。
 */
export function hydrateTools(tools: ToolManifest[]): void {
  const next = new Map(table);
  // 先把旧的工具项清掉，否则卸载一个工具之后它还留在注册表里
  for (const [id, ext] of next) if (ext.source === "tool") next.delete(id);
  for (const t of tools) next.set(t.id, fromToolManifest(t));
  table = next;
}

/** ToolManifest → ResolvedExtension */
export function fromToolManifest(t: ToolManifest): ResolvedExtension {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    version: t.version,
    // 工具占一个整页（iframe）和侧栏一项；声明了 injects 的还会嵌进宿主界面
    // （待办详情面板 / 行内 / 详情头部）—— 那三条由 injectPointsOf 单独查，
    // 不混进 navItems，避免侧栏多出三个来路不明的入口。
    injects: [
      { kind: "tool", id: t.id },
      { kind: "nav", id: `tool:${t.id}`, group: "tools" },
      ...(t.injects ?? []).map((s) => ({
        kind: s.kind,
        id: `${s.kind}:${t.id}`,
        label: s.label ?? t.name,
        height: s.height,
      })),
    ],
    // 能力由工具的 manifest 声明（可选字段，见 types.ts 的 ToolManifest.capabilities）。
    // **按白名单过滤**：manifest 是外部输入，写什么都敢往上写，
    // 这里过滤掉认不出来的名字，宿主就永远不会去判断一个不存在的"能力"。
    capabilities: (Array.isArray(t.capabilities) ? t.capabilities : []).filter((c): c is Capability =>
      (CAPABILITY_NAMES as string[]).includes(c),
    ),
    enabledByDefault: true,
    source: "tool",
    toolId: t.id,
  };
}

export function all(): ResolvedExtension[] {
  return [...table.values()];
}

export function get(id: string): ResolvedExtension | undefined {
  return table.get(id);
}

/* ------------------------------------------------------------------ */
/* 开关                                                                */
/* ------------------------------------------------------------------ */

/** 一个模块的开关键。规则统一：`ext.<id>.enabled` */
export function settingsKey(id: string): string {
  return `ext.${id}.enabled`;
}

/**
 * 这个模块现在开着吗。
 *
 * 判据顺序是有意的：
 *   1. 内核永远开；
 *   2. **只有在设置里显式写了 0 才算关** —— 缺键、空串、手改坏的脏值一律
 *      按 DEFAULT_DEFAULTS 里的 enabledByDefault 走。
 *      这个方向与 migration 的回填是一套组合拳：默认值管新建库、
 *      迁移管老库、这里给"两者都没跑到"留最后一道兜底（宁可多显示一次，
 *      不可让人以为数据丢了）。
 */
export function isEnabled(settings: Record<string, string>, id: string): boolean {
  const ext = table.get(id);
  if (ext?.core) return true;
  const raw = settings[settingsKey(id)];
  if (raw === undefined || raw === "") return ext?.enabledByDefault ?? true;
  return raw !== "0";
}

/** 生成一次切换的写入补丁 */
export function togglePatch(settings: Record<string, string>, id: string): Record<string, string> {
  return { [settingsKey(id)]: isEnabled(settings, id) ? "0" : "1" };
}

/**
 * AI 助手开没开。
 *
 * 用的是与其它模块同一个键规则（`ext.agent.enabled`），少一套写法就少一处漂移。
 * 开关**摆在设置 → AI 助手页**（而不是「选装模块」那个自动生成的列表）里 ——
 * 那一页还放着 Key / 模型 / 三项权限，把开关丢到别处反而找不着。
 *
 * 关掉之后：悬浮球不再出现，助手不加载、不联网。已经聊过的记录不动，
 * 再把开关打开就回来了。
 */
export function agentEnabled(settings: Record<string, string>): boolean {
  return isEnabled(settings, AGENT_EXT_ID);
}

/**
 * 设置页要列出的「可以开关的模块」。
 *
 * 筛掉两类：内核（关不得）与自带专页的模块（AI 助手的开关在它自己那一页，
 * 见 agentEnabled）。于是这个列表由注册表长出来 —— 以后加一个选装模块
 * 不需要再改设置页。
 */
export function selectable(): ResolvedExtension[] {
  return [...table.values()].filter((e) => !e.core && e.id !== AGENT_EXT_ID);
}

/* ------------------------------------------------------------------ */
/* 注入点查询                                                          */
/* ------------------------------------------------------------------ */

export interface NavItem {
  id: string;
  label: string;
  icon?: ExtensionIconName;
}

/** 侧栏项。按 group 分开给，因为它们的语义不同（见 BUILTIN 里 gallery 的注释） */
export function navItems(
  settings: Record<string, string>,
  group: "tasks" | "tools" | "places",
): NavItem[] {
  const out: NavItem[] = [];
  for (const ext of table.values()) {
    if (ext.injects.length && !isEnabled(settings, ext.id)) continue;
    for (const p of ext.injects) {
      if (p.kind !== "nav" && p.kind !== "tool") continue;
      if ((p.group ?? "tasks") !== group) continue;
      // kind === "nav" 才是真正的导航项；"tool" 只是工具的注入声明，
      // 侧栏那一行由 kind === "nav"、id 为 `tool:<id>` 的那条提供。
      if (p.kind === "tool") continue;
      out.push({ id: p.id, label: navLabel(ext, p), icon: p.icon });
    }
  }
  return out;
}

function navLabel(ext: ResolvedExtension, p: InjectPoint): string {
  // 一个扩展可以注入多个导航项，项名不等于模块名 —— 例如内核一项带来
  // 「我的一天 / 重要 / 全部」三项。所以标签按 id 单独查表。
  if (ext.core) {
    const map: Record<string, string> = {
      myday: "我的一天",
      important: "重要",
      all: "全部",
    };
    return map[p.id] ?? ext.name;
  }
  return ext.name;
}

/* ------------------------------------------------------------------ */
/* 注入组件                                                            */
/* ------------------------------------------------------------------ */

export interface ToolInjectEntry {
  toolId: string;
  /** 工具名（按钮/分区标题省略时用它） */
  name: string;
  spec: ToolInjectSpec;
}

/**
 * 某个注入位置上此刻该挂哪些组件。
 *
 * 入参是**已经过滤过启用状态**的工具表：停用是"先别烦我"，
 * 一个被停用的工具不该继续出现在每条待办的详情里。
 *
 * 放在注册表而不是散在三个宿主组件里，是为了让"哪些工具声明了注入"
 * 只有一处答案 —— 那三处挂载点都来问它。
 */
export function injectsFor(tools: ToolManifest[], kind: ToolInjectKind): ToolInjectEntry[] {
  const out: ToolInjectEntry[] = [];
  for (const t of tools) {
    for (const s of t.injects ?? []) {
      if (s.kind !== kind) continue;
      out.push({
        toolId: t.id,
        name: t.name,
        spec: {
          kind,
          label: s.label?.trim() || t.name,
          ...(kind === "detailSection" ? { height: normalizeInjectHeight(s.height) } : {}),
        },
      });
    }
  }
  return out;
}

/** 这个视图归哪个扩展管 —— App 分发与 setView 的越界拦截都问它 */
export function extensionOwningView(view: string): ResolvedExtension | undefined {
  return [...table.values()].find((e) => e.injects.some((p) => p.kind === "view" && p.id === view));
}

/** 这个视图现在是合法的吗（管它的那个模块开着） */
export function isViewAvailable(settings: Record<string, string>, view: string): boolean {
  const owner = extensionOwningView(view);
  // 没有归属的视图属于内核的地盘（例如回到某个清单），永远可用
  if (!owner) return true;
  return isEnabled(settings, owner.id);
}

/**
 * 视图不可用时该落到哪儿。
 *
 * 特殊单号 → 流程任务而不是「我的一天」：它是流程任务的**真子集**，
 * 那批单子本来就同时躺在「流程任务」里，落那儿用户一眼能接着看，
 * 落到「我的一天」则是去了另一个地方。
 * 其余回到内核的「我的一天」—— 那是默认视图，也是最能让人知道自己在哪的一屏。
 */
export function fallbackView(view: string): string {
  return view === "special" ? "orders" : "myday";
}

/* ------------------------------------------------------------------ */
/* 能力                                                                */
/* ------------------------------------------------------------------ */

/**
 * 能力由谁提供。
 *
 * `row` / `kv` 不在表里：它们属于**工具子系统的地基**（每个工具天然有
 * 自己的私有表和 KV），不需要某个模块启用才存在。
 */
const CAPABILITY_OWNER: Partial<Record<Capability, string>> = {
  gallery: "gallery",
  attachments: CORE_EXTENSION_ID,
  // task 由内核提供（读的是待办，而待办永远是内核的地盘）。
  // 它额外还有一道"必须挂在某条待办上"的门，那道门在桥接里 ——
  // 没有 inject 上下文时 task.get 一律拒绝，因为那时它不知道该读哪一条。
  task: CORE_EXTENSION_ID,
};

export type CapabilityState =
  /** 可用 */
  | "on"
  /** 这个扩展没申请这项能力 —— 宿主不给（防止一个工具顺手读写它没说要的东西） */
  | "not-granted"
  /** 申请了，但提供这项能力的模块没启用 */
  | "unavailable";

/** 某个扩展能不能用这项能力 */
export function capabilityState(
  settings: Record<string, string>,
  extId: string,
  cap: Capability,
): CapabilityState {
  const ext = table.get(extId);
  if (ext && !ext.capabilities.includes(cap)) return "not-granted";
  const owner = CAPABILITY_OWNER[cap];
  if (!owner) return "on"; // row / kv 之类的地基能力
  return isEnabled(settings, owner) ? "on" : "unavailable";
}

/**
 * 回绝时说给扩展听的话。
 *
 * 刻意**不抛异常**：调用方拿不到堆栈，界面上就只剩一句"出错了"，而它真正
 * 需要知道的是"图库没开，你自己想办法"。降级由调用方决定 ——
 * 宿主不替它做决定，这是整套能力的第三条边界。
 */
export function capabilityError(state: CapabilityState, cap: Capability): string | null {
  if (state === "on") return null;
  if (state === "not-granted") return `这个扩展没有申请 ${cap} 能力`;
  return `${cap} 能力当前不可用（提供它的模块没有启用）`;
}
