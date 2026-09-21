/**
 * 全局状态。
 *
 * 只放 UI 与跨组件的共享状态；任务数据本身仍以数据库为准，
 * 每次变更后重新拉取，避免状态与库不一致。
 */

import { create } from "zustand";
import type {
  Repeat,
  SmartView,
  Step,
  Task,
  TaskList,
  ToolManifest,
  WoAttachment,
  WoField,
  WoLog,
  WorkFlow,
  WorkOrder,
  WorkOrderKind,
  WorkStage,
} from "./types";
import * as repo from "./lib/repo";
import { dbInfo, initDb, type DbInfo } from "./lib/db";
import { loadTools, filterEnabled, loadBundledTools, toolLocation } from "./lib/tools";
import {
  applyTheme,
  isStartupView,
  isThemeMode,
  parseDisabledTools,
  parseToolKeepState,
  SETTINGS,
  withDefaults,
} from "./lib/settings";
import { sendNotification } from "./lib/notify";
import { firstVisibleRow } from "./lib/rows";
import {
  attachmentStore,
  errorText,
  formatBytes,
  guessKindFromUrl,
  kindFromMime,
  fileNameFromPath,
  fileNameFromUrl,
  hostOf,
  pickLocalMedia,
  SIZE_LIMIT,
  type PickedLocal,
} from "./lib/attachments";

export type ViewKey = SmartView | "list";

/**
 * 「当前该保持挂载的工具」的唯一算法。
 *
 * 三处会改这个集合 —— 打开工具、重新扫描注册表、改「保持工具状态」开关 ——
 * 各写一遍必然会漂移（踩过的坑：某个入口忘了剪掉被停用的工具，
 * 于是工具区挂着一个侧边栏里已经不存在的工具，谁也不知道它是哪来的）。
 *
 * 规则：
 *   保持开 → 打开过的都留着，按打开顺序；id 追加到末尾
 *   保持关 → 只留当前这一个（切走即卸载，就是改动之前的行为）
 *   两种情况都要剪掉"已启用集合之外的"工具
 */
function aliveAfterOpen(
  state: { settings: Record<string, string>; aliveToolIds: string[]; enabledTools: ToolManifest[] },
  id: string | null,
  /** 覆盖启用集合：reloadTools 里注册表刚换过，state 上还是旧的 */
  enabledOverride?: ToolManifest[],
): string[] {
  const enabled = enabledOverride ?? state.enabledTools;
  const isOn = (x: string) => enabled.some((t) => t.id === x);
  const keepAlive = parseToolKeepState(state.settings[SETTINGS.toolKeepState]);
  const prev = state.aliveToolIds.filter(isOn);

  if (!id) return keepAlive ? prev : [];
  if (!keepAlive) return [id];
  return prev.includes(id) ? prev : [...prev, id];
}

/**
 * 一条时效提醒。
 *
 * 带上 level 而不是只给工单：临期和逾期要说的话不一样
 * （"还剩 20 分钟" vs "已经超时 40 分钟"），逾期那条也要更显眼。
 * dueAt 一起带上，卡片上就能直接算"还剩多久"，不必再去查一遍工单。
 */
export interface OrderDueAlert {
  orderId: string;
  no: string;
  title: string;
  dueAt: string;
  level: "soon" | "overdue";
  /**
   * 卡片上的「查看」要跳到能看见这张单的视图。
   * 特殊单号进 special 视图，其它（流程步骤配了默认时长）进 orders ——
   * 不然点了"查看"会落到一个不含该单的列表上，看着像跳错了。
   */
  kind: WorkOrderKind;
}

/** 添加一条附件的结果，给界面决定提示什么 */
export type AttachOutcome =
  | { status: "ok"; kind: "image" | "video"; title: string; deduped: boolean }
  /** 地址不是图片/视频，按约定改存链接了 */
  | { status: "link"; title: string; reason: string }
  | { status: "error"; message: string; url: string };

export interface LocalAttachResult {
  added: number;
  /** 没能加进来的，附上原因 */
  failed: Array<{ name: string; reason: string }>;
}

interface State {
  ready: boolean;
  dbInfo: DbInfo | null;

  lists: TaskList[];
  tasks: Task[];
  /** 注册表里的全部工具（含被停用的，设置页要列出它们） */
  tools: ToolManifest[];
  /** 当前启用的工具 —— 侧边栏与工具区只看这一份 */
  enabledTools: ToolManifest[];
  /** 安装包里有哪些工具 —— 用来列出"已卸载、可重新安装"的内置工具 */
  bundledTools: ToolManifest[];
  toolsPath: string;
  /**
   * 本次会话打开过、且仍保持挂载的工具（按打开顺序）。
   *
   * 只在「保持工具状态」打开时会出现多个：切走的工具不卸载，只是隐藏。
   * 关掉那个开关就退化成"只有当前这一个"。
   */
  aliveToolIds: string[];
  /**
   * 每个工具的重载次数。工具头部的「重置」按一下就 +1，
   * 工具区把它当 iframe 的 key —— key 变了 iframe 重建，工具回到初始状态。
   */
  toolReloads: Record<string, number>;

  /** 工单：流程模板、过程态、当前视图的工单、今日计划、当前工单的流转记录 */
  flows: WorkFlow[];
  stages: WorkStage[];
  orders: WorkOrder[];
  /**
   * 紧急区的候选池：**跨视图**的未完成任务与未完结工单。
   *
   * 单独存一份的原因与当初计划表一样：store.tasks / store.orders 只是
   * **当前视图**的数据，而紧急区要扫的是"所有还欠着的事"，
   * 拿当前视图去算会漏掉别的清单里快到点的那条 ——
   * 漏的偏偏正是最该被看见的。
   */
  urgentTasks: Task[];
  urgentOrders: WorkOrder[];
  woLogs: WoLog[];

  /** 当前打开工单的附件（图片/视频/链接混排） */
  attachments: WoAttachment[];
  /**
   * 每张工单的附件数量，列表行上显示「带 3 个附件」用。
   * 单独存一份而不去数 attachments：那个只是"当前打开的那张工单"的。
   */
  woAttachmentCounts: Record<string, number>;
  /** 附件仓库占用，设置页显示 */
  repoUsage: { files: number; bytes: number } | null;
  /** 正在下载/复制，界面据此禁用输入并给进度感 */
  attachBusy: boolean;

  view: ViewKey;
  activeListId: string | null;

  search: string;
  /** 当前打开的工具 id，null 表示显示待办模块 */
  activeToolId: string | null;
  /** 当前在右侧详情面板中查看的任务 id，null 表示显示的是工单或空态 */
  activeTaskId: string | null;
  /**
   * 当前在右侧详情面板中查看的工单 id。
   *
   * 与 activeTaskId 互斥（同一时刻只有一个非空）而不是合成一个
   * `{kind,id}` 对象：既有代码里 activeTaskId 被到处引用，
   * 换结构会把改动扩散到每个组件。互斥不变量由 openTask / openOrder 维持。
   */
  activeOrderId: string | null;
  /**
   * 用户是否手动关掉过详情。
   *
   * 右侧面板现在「始终展开」，所以要区分两种情况：
   * "还没选过"（该自动补选第一条）和"用户主动关掉了"（不该再弹回来）。
   * 少这个标记的话，用户一按 × 就会被 refresh 立刻重新选中，
   * 表现得像按钮坏了。
   */
  detailClosedByUser: boolean;
  /** 侧边栏是否折叠 */
  sidebarOpen: boolean;
  /** 设置界面是否打开 */
  settingsOpen: boolean;
  /**
   * 流程编辑器是否打开，以及打开时聚焦哪套流程。
   * 做成全局状态而不是挂在某个组件里：入口有两个（工单详情里「编辑流程」、
   * 底部创建器的齿轮），挂局部会让两处各渲染一份编辑器。
   */
  flowEditorOpen: boolean;
  flowEditorFlowId: string | null;
  /** 键值对配置，已补默认值 */
  settings: Record<string, string>;

  /** 步骤按任务 id 分组，任务行要显示 2/5 这种进度，所以随任务一起加载 */
  stepsByTask: Record<string, Step[]>;
  /** 当前详情任务所关联的任务（关联是无向的） */
  linkedTasks: Task[];
  /** 已到点、等待用户处理的提醒 */
  reminders: Task[];
  /**
   * 特殊单号的处理时效到点了，等待用户处理。
   *
   * 单独一个队列而不是并进 reminders：两者的**处置动作不一样**。
   * 任务提醒能"稍后提醒 10 分钟"，而时效提醒稍后提醒是没有意义的 ——
   * 该做的是推进流程或者延长时效。并进一个队列就得在渲染时到处判断
   * "这条能不能 snooze"，最后一定会有人漏判。
   */
  orderDues: OrderDueAlert[];

  loadLinks: (taskId: string) => Promise<void>;
  linkTask: (taskId: string, linkedId: string) => Promise<void>;
  unlinkTask: (taskId: string, linkedId: string) => Promise<void>;

  addStep: (taskId: string, title: string) => Promise<void>;
  toggleStep: (step: Step) => Promise<void>;
  renameStep: (id: string, title: string) => Promise<void>;
  removeStep: (id: string) => Promise<void>;

  checkReminders: () => Promise<void>;
  dismissReminder: (taskId: string) => Promise<void>;
  snoozeReminder: (taskId: string, minutes: number) => Promise<void>;
  /** 关掉一条时效提醒（不延长时效，只是不再弹这张卡） */
  dismissOrderDue: (orderId: string) => Promise<void>;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  openSettings: (open: boolean) => void;
  setView: (view: ViewKey, listId?: string) => Promise<void>;
  openTool: (id: string | null) => void;
  /** 关掉某个工具：从挂载集合里移除（真释放 iframe），必要时把焦点交给前一个 */
  closeTool: (id: string) => void;
  /** 关掉全部工具并退回待办 */
  closeAllTools: () => void;
  /** 让某个工具重新加载（清掉它当前的状态） */
  reloadTool: (id: string) => void;
  /** 重新扫描工具目录（安装 / 卸载之后调用） */
  reloadTools: () => Promise<void>;
  /** 打开/关闭右侧任务详情面板 */
  openTask: (id: string | null) => void;
  /** 打开右侧工单详情面板 */
  openOrder: (id: string | null) => void;
  /**
   * 从紧急区（或其它跨视图的入口）打开一条待办/工单。
   *
   * 为什么不能直接用 openTask / openOrder：右侧详情只认**当前视图**里的数据
   * （shownTask 是从 store.tasks 里 find 出来的），而紧急区扫的是全库 ——
   * 点一条别的清单里的待办，详情会直接掉进空态，看着像点了没反应。
   * 所以不在当前视图时先切到「全部」（待办与工单混排的那个视图）再选中。
   */
  openUrgent: (kind: "task" | "order", id: string) => Promise<void>;
  /** 打开/关闭流程编辑器；传 flowId 表示聚焦到那套流程 */
  openFlowEditor: (flowId: string | null) => void;
  /** 自动选中当前列表的第一条，让右侧详情始终有内容 */
  selectFirst: () => void;
  /** 改任务的任意白名单字段（备注、所属列表、提醒等），改完自动刷新 */
  patchTask: (id: string, patch: Partial<Task>) => Promise<void>;
  setSearch: (q: string) => void;
  toggleSidebar: () => void;

  /* ------------------------------ 工单 ------------------------------ */
  createOrder: (input: repo.NewWorkOrderInput) => Promise<string>;
  patchOrder: (id: string, patch: Partial<WorkOrder>) => Promise<void>;
  removeOrder: (id: string) => Promise<void>;
  /** 推进过程态（会留痕，是工单区别于待办的核心动作） */
  advanceOrder: (woId: string, stageId: string, note?: string) => Promise<void>;
  toggleOrderImportant: (o: WorkOrder) => Promise<void>;
  loadWoLogs: (woId: string) => Promise<void>;

  /** 当前详情工单绑定的相关信息（特殊单号：另一个快递单号、用户名…） */
  woFields: WoField[];
  /**
   * 全部特殊单号的相关信息字段（按单分组用）。
   *
   * 与 `woFields`（当前打开那张单的字段，详情面板用）分开存：
   * 「特殊单号」记录视图的搜索要跨**所有**单的字段值找匹配
   * （用户记得的往往是某个手机尾号或补发单号，不是标题），
   * 每次搜索逐单查库会把取数变成 N 次往返。
   */
  allWoFields: WoField[];
  loadWoFields: (woId: string) => Promise<void>;
  addWoField: (woId: string, label: string, value: string) => Promise<void>;
  editWoField: (id: string, patch: Partial<WoField>) => Promise<void>;
  removeWoField: (id: string) => Promise<void>;

  /* --------------------------- 流程模板编辑 --------------------------- */
  addFlow: (name: string) => Promise<void>;
  renameFlow: (id: string, name: string) => Promise<void>;
  removeFlow: (id: string) => Promise<string | null>;
  makeFlowDefault: (id: string) => Promise<void>;
  addStage: (flowId: string, name: string) => Promise<void>;
  editStage: (id: string, patch: Partial<WorkStage>) => Promise<void>;
  removeStage: (id: string) => Promise<string | null>;
  reorderStage: (id: string, dir: -1 | 1) => Promise<void>;

  /* ------------------------------ 紧急区 ------------------------------ */
  /** 重新拉取紧急区候选池（跨视图的未完成任务 + 未完结工单） */
  loadUrgent: () => Promise<void>;

  /* ------------------------------ 附件 ------------------------------ */
  loadAttachments: (woId: string) => Promise<void>;
  /** 贴一个网址：是图片/视频就下载进仓库，否则按约定存成链接 */
  attachFromUrl: (url: string) => Promise<AttachOutcome>;
  /** 从本机选图片/视频放进仓库；返回 null 表示用户取消了选择 */
  attachLocal: () => Promise<LocalAttachResult | null>;
  patchAttachment: (
    id: string,
    patch: Partial<Pick<WoAttachment, "title" | "note" | "width" | "height" | "durationMs">>,
  ) => Promise<void>;
  removeAttachment: (id: string) => Promise<void>;
  reorderAttachment: (id: string, dir: -1 | 1) => Promise<void>;
  /** 渲染到页面时顺手量一下尺寸，回填一次 */
  probeAttachment: (a: WoAttachment, size: { width: number; height: number; durationMs: number | null }) => Promise<void>;
  /** 文件被清掉/换机器后，用当初的下载地址补回来 */
  reattachFromSource: (id: string) => Promise<AttachOutcome>;
  refreshRepoUsage: () => Promise<void>;

  addTask: (title: string, opts?: { repeat?: Repeat }) => Promise<void>;
  toggleDone: (task: Task) => Promise<void>;
  toggleImportant: (task: Task) => Promise<void>;
  toggleMyDay: (task: Task) => Promise<void>;
  removeTask: (id: string) => Promise<void>;
  renameTask: (id: string, title: string) => Promise<void>;
  setDueDate: (id: string, date: string | null) => Promise<void>;
  setRepeat: (id: string, repeat: Repeat) => Promise<void>;

  addList: (name: string) => Promise<void>;
  renameList: (id: string, name: string) => Promise<void>;
  removeList: (id: string) => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  dbInfo: null,

  lists: [],
  tasks: [],
  tools: [],
  enabledTools: [],
  bundledTools: [],
  toolsPath: "",
  aliveToolIds: [],
  toolReloads: {},

  flows: [],
  stages: [],
  orders: [],
  urgentTasks: [],
  urgentOrders: [],
  woLogs: [],
  woFields: [],
  allWoFields: [],

  attachments: [],
  woAttachmentCounts: {},
  repoUsage: null,
  attachBusy: false,

  view: "myday",
  activeListId: null,

  search: "",
  activeToolId: null,
  activeTaskId: null,
  activeOrderId: null,
  detailClosedByUser: false,
  sidebarOpen: true,
  settingsOpen: false,
  flowEditorOpen: false,
  flowEditorFlowId: null,
  settings: {},

  stepsByTask: {},
  linkedTasks: [],
  reminders: [],
  orderDues: [],

  init: async () => {
    await initDb();
    await repo.seedIfEmpty();
    // 流程与示例工单分开种：老用户的库里已有清单，seedIfEmpty 会直接返回，
    // 写在那里的话升级后就永远看不到工单功能。示例工单必须在流程之后，
    // 否则它找不到可用的过程态。
    await repo.seedWorkOrderFlowsIfEmpty();
    await repo.seedDemoWorkOrdersIfEmpty();
    const [tools, bundledTools, rawSettings] = await Promise.all([
      loadTools(),
      loadBundledTools(),
      repo.getAllSettings(),
    ]);
    const settings = withDefaults(rawSettings);
    const theme = settings[SETTINGS.theme];
    const enabledTools = filterEnabled(tools, parseDisabledTools(settings[SETTINGS.toolsDisabled]));

    set({
      dbInfo: dbInfo(),
      tools,
      enabledTools,
      bundledTools,
      toolsPath: toolLocation(),
      settings,
      // 配置决定初始形态：侧边栏是否展开、进来先看哪个视图
      sidebarOpen: settings[SETTINGS.sidebarOpen] !== "0",
      view: isStartupView(settings[SETTINGS.startupView])
        ? (settings[SETTINGS.startupView] as SmartView)
        : "myday",
    });
    applyTheme(isThemeMode(theme) ? theme : "light");

    // 支持 ?tool=<id> 直达某个工具。
    // 没有路由的桌面应用里，这一条让"把某个工具甩给人看"变成可分享的链接，
    // 自动化验证也省去了一步点击。
    // 只认启用中的工具：停用过的工具被直达链接拉起来，等于停用没生效。
    const wantTool = new URLSearchParams(window.location.search).get("tool");
    if (wantTool && enabledTools.some((t) => t.id === wantTool)) {
      set({ activeToolId: wantTool, aliveToolIds: [wantTool] });
    }

    await get().refresh();
    // 右侧栏始终展开的前提是它得有内容 —— 进来就选中第一条，
    // 而不是让用户面对一块"请选择任务"的空白
    if (!get().activeToolId) get().selectFirst();
    set({ ready: true });
  },

  refresh: async () => {
    // 每日任务的跨天重置放在取数前：保证"今天"看到的状态一定是最新的
    await repo.rolloverDailyTasks();

    const { view, activeListId, search } = get();
    const keyword = search.trim();

    // 搜索时跨列表、跨视图检索：用户输入关键词的意图是「找到它」，
    // 若仍按当前视图过滤，会出现「明明有这条任务却搜不到」的困惑。
    const query: repo.TaskQuery = keyword
      ? { view: "all", search: keyword, includeDone: true }
      : {
          view: view === "list" ? "list" : view,
          listId: activeListId ?? undefined,
          // 必须带上已完成任务：界面需要它们来渲染「已完成」折叠分组，
          // 由 TaskList 自行区分未完成与已完成，而不是在查询阶段丢掉。
          includeDone: true,
        };

    // 工单查询与任务共用视图语义（见 repo.fetchWorkOrders）。
    // list 视图下工单不属于任何清单，会返回空数组 —— 这是有意的。
    const orderQuery: repo.OrderQuery = keyword
      ? { view: "all", search: keyword, includeDone: true }
      : { view: view === "list" ? "list" : view, includeDone: true };

    const [lists, tasks, stepsByTask, flows, stages, orders, woAttachmentCounts, allWoFields] =
      await Promise.all([
        repo.fetchLists(),
        repo.fetchTasks(query),
        repo.fetchAllSteps(),
        repo.fetchFlows(),
        repo.fetchStages(),
        repo.fetchWorkOrders(orderQuery),
        repo.attachmentCounts(),
        // 相关信息字段全量取一份：单表一次扫描，换来「特殊单号」视图
        // 的跨单搜索不用逐单回库（见 allWoFields 的说明）
        repo.fetchAllWoFields(),
      ]);
    set({ lists, tasks, stepsByTask, flows, stages, orders, woAttachmentCounts, allWoFields });
    // 紧急区扫的是全部待办与工单，跟当前视图无关，单独跑一次
    await get().loadUrgent();

    // 选中的对象已经不在当前列表里（被删了、或者切了视图）时补选第一条。
    // 少了这一步，右侧详情会持续显示一条已经不存在的记录 ——
    // 面板"始终展开"会让这种残留特别显眼。
    const { activeTaskId, activeOrderId, detailClosedByUser } = get();
    if (detailClosedByUser) return;

    const taskAlive = !!activeTaskId && tasks.some((t) => t.id === activeTaskId);
    const orderAlive = !!activeOrderId && orders.some((o) => o.id === activeOrderId);
    if (!taskAlive && !orderAlive) get().selectFirst();
  },

  setView: async (view, listId) => {
    set({
      view,
      activeListId: view === "list" ? (listId ?? null) : null,
      activeToolId: null,
      // 离开工具不等于关掉它：保持状态开着时它继续挂在后台（见 aliveToolIds）
      aliveToolIds: aliveAfterOpen(get(), null),
      // 切视图时清掉当前选中：详情属于"某一条记录"，视图变了它大概率不在新列表里。
      // 清掉并重置"用户关过"的标记，好让下面的 refresh 自动补选新视图的第一条。
      activeTaskId: null,
      activeOrderId: null,
      detailClosedByUser: false,
      settingsOpen: false,
    });
    await get().refresh();
  },

  openTool: (id) =>
    set({
      activeToolId: id,
      settingsOpen: false,
      aliveToolIds: aliveAfterOpen(get(), id),
    }),

  closeTool: (id) => {
    const { aliveToolIds, activeToolId } = get();
    const rest = aliveToolIds.filter((x) => x !== id);
    // 关掉的正是当前这个：把焦点交给挂载集合里的最后一个（也就是刚看过的那个），
    // 而不是一律退回待办 —— 用户连开几个工具的意图是"在它们之间来回看"
    set({
      aliveToolIds: rest,
      activeToolId: activeToolId === id ? (rest[rest.length - 1] ?? null) : activeToolId,
    });
  },

  closeAllTools: () => set({ aliveToolIds: [], activeToolId: null }),

  reloadTool: (id) =>
    set((s) => ({ toolReloads: { ...s.toolReloads, [id]: (s.toolReloads[id] ?? 0) + 1 } })),

  reloadTools: async () => {
    const [tools, bundledTools] = await Promise.all([loadTools(), loadBundledTools()]);
    const { settings, activeToolId } = get();
    const enabledTools = filterEnabled(tools, parseDisabledTools(settings[SETTINGS.toolsDisabled]));

    // 统一在这里收口三件事：被停用/被卸载的工具不能继续保持挂载，
    // 也不能继续占着 activeToolId（否则工具区一片空白、待办也不显示）。
    const alive = aliveAfterOpen(get(), activeToolId, enabledTools);
    set({
      tools,
      enabledTools,
      bundledTools,
      toolsPath: toolLocation(),
      aliveToolIds: alive,
      activeToolId:
        activeToolId && enabledTools.some((t) => t.id === activeToolId) ? activeToolId : null,
    });
  },

  // 任务与工单的选中互斥：两个都非空会让右侧不知道该渲染哪个
  openTask: (id) =>
    // 附件的状态只服务于"当前打开的那张工单"。切到待办时一起清掉，
    // 免得任务详情里留着上一条工单的附件。切换回同一张工单时组件会重新挂载、
    // 重新拉一次，不会因此显示不全。
    set({ activeTaskId: id, activeOrderId: null, detailClosedByUser: !id, attachments: [], woFields: [] }),
  openOrder: (id) => set({ activeOrderId: id, activeTaskId: null, detailClosedByUser: !id }),

  openUrgent: async (kind, id) => {
    const { tasks, orders } = get();
    const inView =
      kind === "task" ? tasks.some((t) => t.id === id) : orders.some((o) => o.id === id);
    if (!inView) {
      // 换视图必须走 refresh 重新取数，否则详情还是找不到它 ——
      // 但**不能在 refresh 之前 openTask**：refresh 末尾的"补选第一条"会把它顶掉
      set({
        view: "all",
        activeListId: null,
        activeToolId: null,
        aliveToolIds: aliveAfterOpen(get(), null),
        detailClosedByUser: false,
        settingsOpen: false,
      });
      await get().refresh();
    }
    if (kind === "task") get().openTask(id);
    else get().openOrder(id);
  },

  openFlowEditor: (flowId) =>
    set({ flowEditorOpen: !!flowId, flowEditorFlowId: flowId }),

  /**
   * 自动选中第一条 —— 用户原话「右侧栏始终展开，默认展开第一个待办」。
   *
   * 选的是**列表肉眼看到的第一行**，共用 `lib/rows.ts` 的分组排序逻辑。
   * 这一点不能偷懒：之前按"store 里的顺序取第一条未完成"来选，
   * 而列表是按日期排的，于是高亮在第 3 行、详情却显示第 1 行，
   * 备注写到了 A 任务上、界面打开的却是 B —— 极端难查。
   * 现在只要列表怎么排，选中就怎么选。
   */
  selectFirst: () => {
    const { tasks, orders, view } = get();
    const first = firstVisibleRow(tasks, orders, view);
    if (!first) {
      set({ activeTaskId: null, activeOrderId: null });
      return;
    }
    set(
      first.kind === "task"
        ? { activeTaskId: first.task.id, activeOrderId: null }
        : { activeOrderId: first.order.id, activeTaskId: null },
    );
  },

  /**
   * 开关设置。
   *
   * 刻意**不清掉**当前选中的任务/工单：右侧面板现在是常驻的，
   * 清掉的话每次关掉设置都会掉进空态，用户得重新点一遍原来那条。
   * 隐藏交给 TaskDetail 自己判断（settingsOpen 时不渲染），选中的状态留着。
   */
  openSettings: (open) => set({ settingsOpen: open }),

  loadSettings: async () => {
    const settings = withDefaults(await repo.getAllSettings());
    const theme = settings[SETTINGS.theme];
    set({ settings });
    applyTheme(isThemeMode(theme) ? theme : "light");
  },

  saveSettings: async (patch) => {
    const before = get().settings;
    const next = { ...before, ...patch };

    /**
     * 把配置里会牵动别的切片的那几项同步过去。
     *
     * 抽成闭包是为了**能重放一遍**：落库失败回退时要用旧值把它们推回去。
     * 判断条件一律看 `patch`（这次到底改了哪几项），取值看传进来的 `values`。
     */
    const applyEffects = (values: Record<string, string>) => {
      const theme = values[SETTINGS.theme];
      if (SETTINGS.theme in patch && theme && isThemeMode(theme)) applyTheme(theme);

      // 侧边栏默认展开这项要立刻生效，否则用户还得手动试一下才知道有没有保存
      if (SETTINGS.sidebarOpen in patch) {
        set({ sidebarOpen: values[SETTINGS.sidebarOpen] !== "0" });
      }

      // 工具相关设置同样要立刻生效：停用一个工具后它必须马上从侧边栏消失，
      // 关掉「保持工具状态」后已经在后台挂着的工具也要立刻释放，
      // 而不是等下次启动才生效 —— 那样用户会以为开关没保存上。
      if (SETTINGS.toolsDisabled in patch || SETTINGS.toolKeepState in patch) {
        const s = get();
        const enabledTools = filterEnabled(
          s.tools,
          parseDisabledTools(values[SETTINGS.toolsDisabled]),
        );
        // 当前正看着的工具被停用了 → 连选中一起清掉，否则工具区空白、待办也不显示
        const activeToolId =
          s.activeToolId && enabledTools.some((t) => t.id === s.activeToolId)
            ? s.activeToolId
            : null;
        set({
          enabledTools,
          activeToolId,
          aliveToolIds: aliveAfterOpen({ ...s, enabledTools }, activeToolId, enabledTools),
        });
      }
    };

    // **先写内存，再落库。** 顺序反了会同时踩两个坑：
    //
    //   ① 旧写法是 `await repo.setSettings(patch)` 之后才 set。拖面板宽度是
    //      「松手才落库」，而松手时 useDragWidth 会立刻丢掉本地接管值、
    //      回落到 `storedWidth`；此时 store 还没更新，于是先弹回旧宽度，
    //      等 IPC 回来再跳回新宽度。web 预览里 MemoryDb 是同步的，看不到；
    //      exe 里是 SQLite IPC，这段窗口足够长到肉眼可见。
    //   ② 更糟的是落库一旦抛错，`set` 根本不会执行，界面**永久**停在旧值上。
    //      而 exe 里正好有个「抛错但不报红」的静默失败（事务跨连接，见
    //      src-tauri/src/db_tx.rs），于是表现为「拖完弹回、重启也不记得」。
    //
    // 现在同步写内存：调用方在同一个事件里发的 `setDragWidth(null)` 会和这里
    // 合批，只渲染一次、直接就是新宽度，中间不闪。
    set({ settings: next });
    applyEffects(next);

    try {
      await repo.setSettings(patch);
    } catch (err) {
      // 落库失败必须回退：界面显示一个并不存在的配置，下次启动又变回去，
      // 比当场报错难查得多。
      set({ settings: before });
      applyEffects(before);
      throw err;
    }
  },

  patchTask: async (id, patch) => {
    await repo.updateTask(id, patch);
    await get().refresh();
  },

  setSearch: (q) => {
    set({ search: q });
    void get().refresh();
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  addTask: async (title, opts) => {
    const t = title.trim();
    if (!t) return;
    const { view, activeListId, lists } = get();
    const repeat = opts?.repeat ?? "none";

    // 目标列表：列表视图用当前列表；智能视图落到第一个列表
    const listId =
      view === "list" && activeListId ? activeListId : (lists[0]?.id ?? null);
    if (!listId) {
      const created = await repo.createList("任务", "#d4537e");
      await repo.createTask({ listId: created.id, title: t, myDay: view === "myday", repeat });
    } else {
      await repo.createTask({
        listId,
        title: t,
        // 在「重要」「计划」视图下新建，直接带上该视图的属性更符合直觉
        important: view === "important",
        myDay: view === "myday",
        dueDate: view === "planned" ? repo.today() : null,
        repeat,
      });
    }
    await get().refresh();
  },

  toggleDone: async (task) => {
    const done = !task.done;
    await repo.updateTask(task.id, {
      done,
      // 每日任务勾上只代表"今天做完了"，记下日期；跨天由 rolloverDailyTasks 重置回未完成
      ...(task.repeat === "daily" ? { repeatDoneOn: done ? repo.today() : null } : {}),
    });
    await get().refresh();
  },

  setRepeat: async (id, repeat) => {
    // 从"每天"改回"不重复"时顺手清掉完成日期，否则这行会带着一个没人用的残留值
    await repo.updateTask(id, {
      repeat,
      ...(repeat === "none" ? { repeatDoneOn: null } : {}),
    });
    await get().refresh();
  },

  /* ------------------------------ 步骤 ------------------------------ */

  addStep: async (taskId, title) => {
    if (!title.trim()) return;
    await repo.createStep(taskId, title);
    await get().refresh();
  },

  toggleStep: async (step) => {
    await repo.updateStep(step.id, { done: !step.done });
    await get().refresh();
  },

  renameStep: async (id, title) => {
    const t = title.trim();
    if (!t) return;
    await repo.updateStep(id, { title: t });
    await get().refresh();
  },

  removeStep: async (id) => {
    await repo.deleteStep(id);
    await get().refresh();
  },

  /* ------------------------------ 关联 ------------------------------ */

  loadLinks: async (taskId) => {
    set({ linkedTasks: await repo.fetchLinkedTasks(taskId) });
  },

  linkTask: async (taskId, linkedId) => {
    const ok = await repo.linkTasks(taskId, linkedId);
    if (!ok) return;
    await get().loadLinks(taskId);
  },

  unlinkTask: async (taskId, linkedId) => {
    await repo.unlinkTasks(taskId, linkedId);
    await get().loadLinks(taskId);
  },

  /* ------------------------------ 提醒 ------------------------------ */

  checkReminders: async () => {
    if (get().settings[SETTINGS.reminderEnabled] === "0") return;

    const nowMs = Date.now();
    const due = (await repo.fetchRemindableTasks()).filter(
      (t) => t.remindAt && new Date(t.remindAt).getTime() <= nowMs,
    );

    // 已经在队列里的不再重复入队，否则每 30 秒扫一次会堆出一摞相同的卡片。
    // 注意这里**不能**在没有到期任务时提前 return —— 下面还有时效要扫。
    if (due.length) {
      const queued = new Set(get().reminders.map((t) => t.id));
      const fresh = due.filter((t) => !queued.has(t.id));
      if (fresh.length) {
        set((s) => ({ reminders: [...s.reminders, ...fresh] }));
        if (get().settings[SETTINGS.reminderSystem] === "1") {
          for (const t of fresh) sendNotification(t.title, "任务提醒");
        }
      }
    }

    /* --------------------- 特殊单号的处理时效 --------------------- */

    // 与任务提醒共用同一个开关：用户关掉提醒是"别打扰我"，
    // 不会期望工单那边还在弹。
    const soonMs = repo.DUE_SOON_MINUTES * 60_000;
    const alerts: OrderDueAlert[] = [];
    for (const o of await repo.fetchOrdersForDueReminder()) {
      if (!o.stageDueAt) continue;
      const at = new Date(o.stageDueAt).getTime();
      if (Number.isNaN(at)) continue;
      // 已过点就是逾期，否则只有进入"临期"窗口才提醒 ——
      // 不然每张单从建立那一刻起就一直在提醒，提醒会变成噪音
      const level: OrderDueAlert["level"] = at <= nowMs ? "overdue" : "soon";
      if (level === "soon" && at - nowMs > soonMs) continue;
      // 同一档只提醒一次。标记存在库里而不是内存里 ——
      // 队列重启即空，靠队列去重会让每次打开应用都重弹一遍。
      if (o.stageDueNotifiedAt === level) continue;
      alerts.push({
        orderId: o.id,
        no: o.no,
        title: o.title,
        dueAt: o.stageDueAt,
        level,
        kind: o.kind,
      });
    }

    if (!alerts.length) return;

    // 卡片还在队列里（用户还没处理）就不重复加。标记照样落库，
    // 免得每 30 秒再算一遍同一批单子。
    const seen = new Set(get().orderDues.map((a) => `${a.orderId}:${a.level}`));
    const add = alerts.filter((a) => !seen.has(`${a.orderId}:${a.level}`));
    for (const a of alerts) await repo.markOrderDueNotified(a.orderId, a.level);

    if (add.length) {
      set((s) => ({ orderDues: [...s.orderDues, ...add] }));
      if (get().settings[SETTINGS.reminderSystem] === "1") {
        for (const a of add) {
          sendNotification(
            a.level === "overdue" ? `已超时：${a.title}` : `即将超时：${a.title}`,
            a.no ? `单号 ${a.no}` : "特殊单号的处理时效",
          );
        }
      }
    }
  },

  dismissOrderDue: async (orderId) => {
    // 只把卡片收起来，**不动时效本身** —— 时效是业务数据，
    // "我知道了"不该悄悄把它清掉。要改时效请到详情里改。
    set((s) => ({ orderDues: s.orderDues.filter((a) => a.orderId !== orderId) }));
  },

  dismissReminder: async (taskId) => {
    set((s) => ({ reminders: s.reminders.filter((t) => t.id !== taskId) }));
    // 一次性提醒：确认后就把提醒时间清掉，下次启动不会再弹
    await repo.updateTask(taskId, { remindAt: null });
    await get().refresh();
  },

  snoozeReminder: async (taskId, minutes) => {
    set((s) => ({ reminders: s.reminders.filter((t) => t.id !== taskId) }));
    await repo.updateTask(taskId, {
      remindAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    });
    await get().refresh();
  },

  toggleImportant: async (task) => {
    await repo.updateTask(task.id, { important: !task.important });
    await get().refresh();
  },

  toggleMyDay: async (task) => {
    await repo.updateTask(task.id, { myDay: !task.myDay });
    await get().refresh();
  },

  removeTask: async (id) => {
    await repo.deleteTask(id);
    // 删掉的正好是正在看的那条时，详情面板必须一起关掉，
    // 否则会渲染一个已经在库里消失的任务
    if (get().activeTaskId === id) set({ activeTaskId: null });
    await get().refresh();
  },

  renameTask: async (id, title) => {
    const t = title.trim();
    if (!t) return;
    await repo.updateTask(id, { title: t });
    await get().refresh();
  },

  setDueDate: async (id, date) => {
    await repo.updateTask(id, { dueDate: date });
    await get().refresh();
  },

  /* ------------------------------ 工单 ------------------------------ */

  createOrder: async (input) => {
    const o = await repo.createWorkOrder(input);
    await get().refresh();
    set({ activeOrderId: o.id, activeTaskId: null, detailClosedByUser: false });
    return o.id;
  },

  patchOrder: async (id, patch) => {
    await repo.updateWorkOrder(id, patch);
    await get().refresh();
  },

  removeOrder: async (id) => {
    await repo.deleteWorkOrder(id);
    if (get().activeOrderId === id) set({ activeOrderId: null });
    await get().refresh();
  },

  advanceOrder: async (woId, stageId, note) => {
    await repo.moveOrderToStage(woId, stageId, note ?? "");
    await get().refresh();
    // 流转记录跟着一起刷新，不然详情里的时间线要等下次重新打开才更新
    if (get().activeOrderId === woId) await get().loadWoLogs(woId);
  },

  toggleOrderImportant: async (o) => {
    await repo.updateWorkOrder(o.id, { important: !o.important });
    await get().refresh();
  },

  loadWoLogs: async (woId) => {
    set({ woLogs: await repo.fetchWoLogs(woId) });
  },

  /* ------------------- 绑定的相关信息（特殊单号） ------------------- */

  loadWoFields: async (woId) => {
    set({ woFields: await repo.fetchWoFields(woId) });
  },

  addWoField: async (woId, label, value) => {
    await repo.createWoField(woId, label, value);
    set({ woFields: await repo.fetchWoFields(woId) });
  },

  editWoField: async (id, patch) => {
    await repo.updateWoField(id, patch);
    const woId = get().activeOrderId;
    if (woId) set({ woFields: await repo.fetchWoFields(woId) });
  },

  removeWoField: async (id) => {
    await repo.deleteWoField(id);
    const woId = get().activeOrderId;
    if (woId) set({ woFields: await repo.fetchWoFields(woId) });
  },

  /* ------------------------------ 附件 ------------------------------ */

  loadAttachments: async (woId) => {
    set({ attachments: await repo.fetchAttachments(woId) });
  },

  /**
   * 贴网址添加附件。
   *
   * 流程是「先下下来，再决定怎么存」——**类型由真实内容决定，不由网址后缀决定**。
   * 很多图床的地址根本没有 `.jpg`，反过来也有把 `.jpg` 指向一个 HTML 页面的。
   * 按后缀猜就会同时犯两种错：该存的没存、不该当图片的当成了图片。
   *
   * 下下来之后：
   *   是图片/视频 → 留在仓库里
   *   不是        → **把刚落盘的文件删掉**，改存链接
   * 后半步不能省。否则仓库里会慢慢堆满"下下来了但其实只存了链接"的垃圾文件，
   * 而且没有任何记录指向它们，谁也清理不到。
   */
  attachFromUrl: async (raw) => {
    const url = raw.trim();
    const fail = (message: string): AttachOutcome => ({ status: "error", message, url });

    if (!url) return fail("请输入网址");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("这不是一个有效的网址，检查一下是不是漏了 http://");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // file: / javascript: / data: 都挡在这里。前两个是安全问题，
      // data: 是几百 KB 的 base64 塞进输入框，都不是"网址"的用法。
      return fail(`只支持 http/https 网址，收到的是 ${parsed.protocol}`);
    }

    const woId = get().activeOrderId;
    if (!woId) return fail("请先打开一张工单");

    const store = attachmentStore();
    const name = fileNameFromUrl(url);
    set({ attachBusy: true });
    try {
      // 下载时用的是**视频上限**：此时还不知道它是什么，
      // 用图片的 20 MB 去卡会把一个 30 MB 的原图误判成"超限"。
      // 真正的分类限制在拿到 MIME 之后再判。
      const stored = await store.download(url, { name, maxBytes: SIZE_LIMIT.video });
      const kind = kindFromMime(stored.mime);

      if (kind === "link") {
        await store.remove(stored.relPath);
        const title = name || hostOf(url);
        await repo.createAttachment({
          woId,
          kind: "link",
          title,
          sourceUrl: url,
          mime: stored.mime,
        });
        await get().loadAttachments(woId);
        await get().refresh();
        return {
          status: "link",
          title,
          reason: `这个地址返回的是 ${stored.mime || "非媒体内容"}`,
        };
      }

      if (kind === "image" && stored.size > SIZE_LIMIT.image) {
        await store.remove(stored.relPath);
        return fail(
          `图片 ${formatBytes(stored.size)}，超过 ${formatBytes(SIZE_LIMIT.image)} 上限。` +
            `大图建议压一下，或者改存链接`,
        );
      }

      const dup = (await repo.refCountByHash(stored.hash)) > 0;
      await repo.createAttachment({
        woId,
        kind,
        title: name || "附件",
        relPath: stored.relPath,
        sourceUrl: url,
        mime: stored.mime,
        size: stored.size,
        hash: stored.hash,
      });
      await get().loadAttachments(woId);
      await get().refresh();
      return { status: "ok", kind, title: name || "附件", deduped: dup };
    } catch (e) {
      return fail(errorText(e));
    } finally {
      set({ attachBusy: false });
    }
  },

  /**
   * 从本机选图片/视频。
   *
   * 只收图片和视频，其它类型一律拒绝并说明原因 ——
   * 本地文件没有一个"可以存下来、换台机器还能用"的链接，
   * 而产品约定是"文件用链接"。与其把一个本机路径伪装成链接（换机即失效），
   * 不如直接讲清楚该怎么做。
   */
  attachLocal: async () => {
    const woId = get().activeOrderId;
    if (!woId) return { added: 0, failed: [{ name: "", reason: "请先打开一张工单" }] };

    let picked: PickedLocal;
    try {
      picked = await pickLocalMedia();
    } catch (e) {
      return { added: 0, failed: [{ name: "", reason: errorText(e) }] };
    }
    if (!picked.length) return null; // 用户取消了

    const store = attachmentStore();
    const result: LocalAttachResult = { added: 0, failed: [] };
    set({ attachBusy: true });
    try {
      for (const source of picked) {
        const name = typeof source === "string" ? fileNameFromPath(source) : source.name || "file";
        const guess = guessKindFromUrl(name);
        if (guess === "link") {
          result.failed.push({
            name,
            reason: "本地只收图片和视频。其它文件请先上传到网盘，再贴链接过来",
          });
          continue;
        }

        const limit = SIZE_LIMIT[guess];
        try {
          const stored = await store.importLocal(source, { maxBytes: limit });
          const kind = kindFromMime(stored.mime);
          if (kind === "link") {
            // 后缀骗人（比如 .jpg 其实是个文本文件）。文件已经复制进去了，
            // 得撤掉，不能留成孤儿。
            await store.remove(stored.relPath);
            result.failed.push({ name, reason: "这个文件的内容不是图片或视频" });
            continue;
          }
          await repo.createAttachment({
            woId,
            kind,
            title: name,
            relPath: stored.relPath,
            sourceUrl: null, // 本地来的没有可回填的下载地址
            mime: stored.mime,
            size: stored.size,
            hash: stored.hash,
          });
          result.added++;
        } catch (e) {
          result.failed.push({ name, reason: errorText(e) });
        }
      }
    } finally {
      set({ attachBusy: false });
    }

    await get().loadAttachments(woId);
    await get().refresh();
    return result;
  },

  patchAttachment: async (id, patch) => {
    await repo.updateAttachment(id, patch);
    const woId = get().activeOrderId;
    if (woId) await get().loadAttachments(woId);
  },

  removeAttachment: async (id) => {
    const woId = get().activeOrderId;
    // 先删库、拿回"可以顺手删的文件"。数据库层已经判过引用计数了，
    // 这里只管把文件清掉，不再做判断。
    const orphan = await repo.deleteAttachment(id);
    if (orphan) {
      try {
        await attachmentStore().remove(orphan);
      } catch {
        // 文件删不掉（被占用、权限）不该让"删除附件"这个操作失败 ——
        // 记录已经软删除了，界面上它就是没了。剩下的孤儿文件由仓库清理兜底。
      }
    }
    if (woId) await get().loadAttachments(woId);
    await get().refresh();
  },

  reorderAttachment: async (id, dir) => {
    await repo.moveAttachment(id, dir);
    const woId = get().activeOrderId;
    if (woId) await get().loadAttachments(woId);
  },

  probeAttachment: async (a, size) => {
    // 只在还没有尺寸时回填，避免每次渲染都写一次库
    if (a.width != null && a.height != null) return;
    await repo.updateAttachment(a.id, {
      width: size.width,
      height: size.height,
      durationMs: size.durationMs,
    });
    const woId = get().activeOrderId;
    if (woId) await get().loadAttachments(woId);
  },

  reattachFromSource: async (id) => {
    const cur = get().attachments.find((a) => a.id === id);
    if (!cur?.sourceUrl) return { status: "error", message: "这条附件没有可用的下载地址", url: "" };

    const store = attachmentStore();
    set({ attachBusy: true });
    try {
      const stored = await store.download(cur.sourceUrl, {
        name: cur.title,
        maxBytes: SIZE_LIMIT.video,
      });
      // 覆盖路径与指纹，标题保持用户可能改过的那个
      await repo.updateAttachment(id, {
        relPath: stored.relPath,
        hash: stored.hash,
        size: stored.size,
        mime: stored.mime,
      });
      const woId = get().activeOrderId;
      if (woId) await get().loadAttachments(woId);
      return { status: "ok", kind: kindFromMime(stored.mime) === "video" ? "video" : "image", title: cur.title, deduped: false };
    } catch (e) {
      return { status: "error", message: errorText(e), url: cur.sourceUrl };
    } finally {
      set({ attachBusy: false });
    }
  },

  refreshRepoUsage: async () => {
    try {
      set({ repoUsage: await attachmentStore().usage() });
    } catch {
      set({ repoUsage: null });
    }
  },

  /* --------------------------- 流程模板编辑 --------------------------- */

  // 下面几个动作都走同一条套路：改库 → 刷新。流程改动会影响所有工单的
  // 过程态显示，局部改内存很容易和库里的实际状态脱节。

  addFlow: async (name) => {
    await repo.createFlow(name);
    await get().refresh();
  },

  renameFlow: async (id, name) => {
    await repo.renameFlow(id, name);
    await get().refresh();
  },

  /** 返回 null 表示成功，否则是给用户看的原因 */
  removeFlow: async (id) => {
    const r = await repo.deleteFlow(id);
    if (!r.ok) return r.reason ?? "删除失败";
    await get().refresh();
    return null;
  },

  makeFlowDefault: async (id) => {
    await repo.setDefaultFlow(id);
    await get().refresh();
  },

  addStage: async (flowId, name) => {
    await repo.createStage(flowId, name);
    await get().refresh();
  },

  editStage: async (id, patch) => {
    await repo.updateStage(id, patch);
    await get().refresh();
  },

  removeStage: async (id) => {
    const r = await repo.deleteStage(id);
    if (!r.ok) return r.reason ?? "删除失败";
    await get().refresh();
    return null;
  },

  reorderStage: async (id, dir) => {
    await repo.moveStage(id, dir);
    await get().refresh();
  },

  /* ------------------------------ 紧急区 ------------------------------ */

  /**
   * 拉紧急区的候选池。
   *
   * 这里只管"把还可能紧急的东西取回来"，**不在这里算紧不急** ——
   * 紧不急取决于"现在几点"，是每一分钟都在变的结论，
   * 放在组件里按 tick 重算（见 components/UrgentPanel.tsx）；
   * 而"哪些事存在"只在数据变化时变，跟着 refresh 走就够了。
   *
   * 已经完成的待办、已完结的工单在这里就被过滤掉：
   * 它们不再"欠着"，混进来只会让紧急区的数字虚高。
   */
  loadUrgent: async () => {
    const [tasks, orders] = await Promise.all([
      repo.fetchTasks({ view: "all", includeDone: false }),
      repo.fetchWorkOrders({ view: "all", includeDone: false }),
    ]);
    set({ urgentTasks: tasks, urgentOrders: orders.filter((o) => !o.closed) });
  },

  addList: async (name) => {
    const n = name.trim();
    if (!n) return;
    const list = await repo.createList(n);
    await get().refresh();
    await get().setView("list", list.id);
  },

  renameList: async (id, name) => {
    const n = name.trim();
    if (!n) return;
    await repo.renameList(id, n);
    await get().refresh();
  },

  removeList: async (id) => {
    await repo.deleteList(id);
    const { activeListId } = get();
    if (activeListId === id) await get().setView("myday");
    else await get().refresh();
  },
}));
