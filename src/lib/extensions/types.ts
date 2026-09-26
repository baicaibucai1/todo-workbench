/**
 * 扩展契约 —— 「工作台里什么东西是可以插进来的」这件事的唯一定义。
 *
 * ============================ 这套东西为什么存在 ============================
 *
 * 工作台的内核是**待办**：任务 / 清单 / 子任务、三个筛选视图、详情面板、
 * 提醒与紧急区。这几样是这个程序名字里承诺的东西，永远编译进主程序。
 *
 * 其余一切 —— 流程任务、特殊单号、图库、AI 助手、以及用户自己装的工具 ——
 * 都应当以**同一种形状**挂进来：一份清单 + 若干个注入点 + 若干项能力申请。
 *
 * 在这之前它们是以五种互不相同的形状挂进来的：
 *
 *   · 侧栏项     SMART_ITEMS 数组里写死一行，关不关要看 `specialOn`
 *   · 整页视图   App.tsx 里 `view === "gallery" ? <GalleryView/> : <TaskList/>`
 *   · 详情分区   DETAIL_SECTION_IDS 里写死六个 id
 *   · 模块开关   每个模块各写一套散落的判断（侧栏过滤、setView 拦截、
 *                提醒跳过、紧急区过滤、rows.ts 传参 —— 六七个文件各有一处）
 *   · 工具       又完全是另一套（tools/ 目录 + manifest + iframe）
 *
 * 每加一个功能要同时动五六处宿主代码，而**漏掉任何一处都不会报错**，只是
 * 表现出「界面上有一半不对」——这类 bug 查起来最贵。所以把它们收敛成一件事：
 * **注册表**。宿主组件只问注册表「现在该显示什么」，不再认识任何具体模块。
 *
 * ============================ 三条边界 ============================
 *
 * 1. **声明式**。扩展说「我要一个侧栏项、一个整页视图、我要用图库」，
 *    宿主决定给不给、怎么渲染。扩展拿不到宿主内部对象。
 *
 * 2. **能力是申请来的，不是继承来的**。跨扩展共享的东西（目前只有图库）
 *    要在 `capabilities` 里明确写出来；宿主按「提供这个能力的模块有没有启用」
 *    决定放不放行，没启用就返回一个结构化回绝（见 registry 的 capabilityState），
 *    由扩展自己降级 —— **宿主不替扩展做决定**。
 *
 * 3. **扩展仍然碰不到 core_\***。能力 != SQL 通道：拿到 `gallery` 能力意味着
 *    可以调用 `gallery.*` 那几个窄接口，不意味着可以查任何表。
 *    这条边界的物理实现在 toolBridge.ts，这里只是把它写进契约。
 */

import type { ComponentType } from "react";

/** 注入点种类：宿主允许一个扩展出现在哪些位置 */
export type InjectPointKind =
  /** 侧栏导航项（点开通常落到某个 view） */
  | "nav"
  /** 整页视图：占据主区（列表右侧那一大片） */
  | "view"
  /** 详情面板里的一个分区 */
  | "detailSection"
  /** 列表行上的按钮 */
  | "rowAction"
  /** 详情面板头部的按钮 */
  | "detailAction"
  /** 整页工具（iframe 装载，见 lib/tools.ts） */
  | "tool";

export interface InjectPoint {
  kind: InjectPointKind;
  /**
   * 宿主内的唯一 id（同一 kind 下不得重复）。
   * 它同时是 setView 的参数、`data-nav` 的值 —— 一个 id 到处用，
   * 是为了不让「侧栏叫它什么」和「路由里叫它什么」漂移成两个名字。
   */
  id: string;
  /**
   * 侧栏分组。**只有 kind 为 nav 时有意义**：
   *   tasks  —— "我想看哪些任务"（我的一天 / 重要 / 全部 / 流程任务 / 特殊单号）
   *   tools  —— 用户装的工具
   *   places —— "这个程序里还有什么地方可去"（图库 / 设置）
   *
   * 图库属于第三组而不是第一组：它不是任务的某种筛选，是另一个去处。
   */
  group?: "tasks" | "tools" | "places";
  /**
   * 注入组件（`detailSection` / `rowAction` / `detailAction`）的按钮文字或分区标题。
   * 省略时用工具名。
   */
  label?: string;
  /** `detailSection` 的高度（px）。其余注入点忽略 */
  height?: number;
  /**
   * 侧栏图标。**图标是项的属性，不是模块的属性** ——
   * 同一个模块可以注入好几项（内核一项带来我的一天 / 重要 / 全部），
   * 它们显然不该共用一个图标。
   */
  icon?: ExtensionIconName;
}

/** 用到的 lucide 图标（白名单：不让扩展凭字符串随便引图标） */
export type ExtensionIconName =
  | "sun"
  | "star"
  | "inbox"
  | "clipboard-list"
  | "timer"
  | "images"
  | "sparkles"
  | "package"
  | "folder-open";

/**
 * 宿主能力：宿主提供的、跨扩展**共享**的服务。
 *
 * 判据很简单：**这个东西是不是多个扩展都要用、又不属于任何一个扩展自己的**。
 * 图库符合（图片裁剪、尺码表、AI 生成的产物都往里落，谁都能取），
 * 所以它是能力；而"便签本自己的那张表"不符合，那是私有数据，走 `row`。
 */
export type Capability =
  /** 图库：读写共享素材库（gallery.*）。由 gallery 模块提供 */
  | "gallery"
  /** 附件仓库：内容寻址的文件读写。由内核提供 */
  | "attachments"
  /** 工具私有表：结构化 CRUD（row.*）。对所有工具开放 */
  | "row"
  /** 工具自己的键值配置（kv.*）。对所有工具开放 */
  | "kv"
  /**
   * 当前条目：注入组件挂在某条待办上时，可以**只读**地读这一条（task.get）。
   * 由内核提供。给它的理由是"注入组件要知道自己在替谁干活"，
   * 不给它写权限是另一条边界 —— 改待办只能走宿主的界面与助手的日程动作。
   */
  | "task";

/**
 * 扩展清单一项的**数据部分**。
 *
 * 内置模块写死在 registry.ts 的 BUILTIN_EXTENSIONS 里（它们是编译进主程序的，
 * 没有文件可读）；用户装的工具由 tools.ts 扫出来后转成同一形状（见
 * fromToolManifest）。两边形状一致，上层就不必分支。
 */
export interface ExtensionManifest {
  id: string;
  name: string;
  /** 一句话说明，显示在设置页的选装模块里 */
  description?: string;
  version: string;
  /** 注入点声明。空数组 = 这个扩展不占界面，只提供能力（例如纯数据模块） */
  injects: InjectPoint[];
  /** 需要向宿主申请的能力；宿主只放行这里写过的 */
  capabilities: Capability[];
  /**
   * 新建的库默认要不要它。
   *
   * 选装模块写 false —— 「没要过的东西不要出现在界面上」。
   * ⚠️ 它**只对新建的库生效**：老库由迁移按「有没有用过」回填
   * （见 migrations.ts 的 v17 / v18），否则一次升级就会让用户的东西凭空消失。
   */
  enabledByDefault: boolean;
  /**
   * 是不是内核的一部分。内核永远启用、不出现在选装列表里、也不许卸载 ——
   * 没有待办的工作台没有存在的意义。
   */
  core?: boolean;
}

/**
 * 注册表里的一条：清单 + 宿主才知道的那些东西。
 *
 * 和 ToolManifest 的 `source` 是同一个道理：**来源由宿主盖戳**，
 * 扩展自报的 source 一律不算（一个扩展若能把自己说成 bundled，
 * 卸载按钮就没了）。
 */
export interface ResolvedExtension extends ExtensionManifest {
  source: "builtin" | "tool";
  /**
   * 整页视图的渲染体。只有内置模块有（它就是个 React 组件）；
   * 工具走 iframe，由 toolBridge 装载，这里为 null。
   */
  component?: ComponentType;
  /** source === "tool" 时对应的工具 id */
  toolId?: string;
}

/** 内核的 id —— 待办本体。它不可关闭，也不出现在选装列表里 */
export const CORE_EXTENSION_ID = "core";

/* ------------------------------------------------------------------ */
/* 注入组件                                                            */
/* ------------------------------------------------------------------ */

/**
 * 工具可以**嵌进宿主界面**的位置。
 *
 * 这三条与 `InjectPointKind` 里的同名项是同一个东西的两面：
 * 那边是"宿主认得哪些位置"（契约），这边是"工具的 manifest 能申请哪些位置"
 * （外部输入）。刻意只开放这三个 —— 它们都是**局限在某一条待办上**的，
 * 一个组件即使写得糟糕，影响面也就是一个面板；而 `nav` / `view`
 * 是全局的，不该由一段运行时装进来的 HTML 占掉。
 */
export type ToolInjectKind = "detailSection" | "rowAction" | "detailAction";

export const TOOL_INJECT_KINDS: ToolInjectKind[] = [
  "detailSection",
  "rowAction",
  "detailAction",
];

export interface ToolInjectSpec {
  kind: ToolInjectKind;
  /** 按钮文字 / 分区标题。省略时用工具名 */
  label?: string;
  /** detailSection 的高度（px）。其余两种忽略 */
  height?: number;
}

/** detailSection 的高度区间：太矮装不下东西，太高会把详情面板顶满 */
export const INJECT_HEIGHT = { min: 80, max: 600, default: 180 } as const;

export function normalizeInjectHeight(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return INJECT_HEIGHT.default;
  return Math.min(INJECT_HEIGHT.max, Math.max(INJECT_HEIGHT.min, Math.round(n)));
}

/**
 * 把 manifest 里 `injects` 那段外部输入收拾成可信的声明。
 *
 * 与 `capabilities` 同样的处理：**认不出来的 kind 直接丢掉**，
 * 而不是存下来让宿主去判断一个自己不认识的位置。重复项按 kind 去重
 * （同一位置挂两次没有意义，只会多建一个 iframe）。
 */
export function normalizeInjects(raw: unknown): ToolInjectSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolInjectSpec[] = [];
  const seen = new Set<ToolInjectKind>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !(TOOL_INJECT_KINDS as string[]).includes(kind)) continue;
    const k = kind as ToolInjectKind;
    if (seen.has(k)) continue;
    seen.add(k);
    const label = (item as { label?: unknown }).label;
    const spec: ToolInjectSpec = { kind: k };
    if (typeof label === "string" && label.trim()) spec.label = label.trim().slice(0, 20);
    if (k === "detailSection") spec.height = normalizeInjectHeight((item as { height?: unknown }).height);
    out.push(spec);
  }
  return out;
}
