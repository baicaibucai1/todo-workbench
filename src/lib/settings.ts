/**
 * 应用配置：键名、默认值与主题落地。
 *
 * 配置存 core_settings（键值表），这里只负责"键叫什么、默认值是什么、怎么生效"，
 * 读写本身仍在 repo 层。UI 不应该出现裸的字符串键名。
 */

import type { SmartView } from "../types";
import { DEFAULT_DETAIL_SECTIONS } from "./detailSections";
/* 键名与默认值在这里；「特殊单号」那几个偏好的**解析**放在 lib/special.ts，
   因为列的合法范围、复制模板的取值集合都是那个领域自己才知道的事。 */

export type ThemeMode = "light" | "dark" | "system";

export const SETTINGS = {
  profileName: "profile.name",
  profileEmail: "profile.email",
  profileColor: "profile.color",
  theme: "appearance.theme",
  /** 待办区背景：auto（跟随视图渐变）或 image:<壁纸文件名> */
  background: "appearance.background",
  /** 壁纸上的遮罩强度：soft | medium | strong */
  bgScrim: "appearance.bgScrim",
  startupView: "behavior.startupView",
  sidebarOpen: "behavior.sidebarOpen",
  /**
   * 右侧详情面板宽度（px），由面板左边缘拖拽决定。
   * 存成设置而不是组件内部 state：这是"我习惯看多宽"这类偏好，
   * 每次打开应用都要重新拖一次的话，这个功能等于没有。
   */
  detailWidth: "behavior.detailWidth",
  /**
   * 侧边栏宽度（px），由侧栏右边缘拖拽决定。
   * 紧凑模式（一档折叠）去掉之后，宽度就只剩这一条调节路径了 ——
   * 同样是"我习惯看多宽"的偏好，必须跨启动保留。
   */
  sidebarWidth: "behavior.sidebarWidth",
  /**
   * 右侧详情面板里，一条待办的各分区按什么顺序显示（JSON 数组）。
   *
   * 排在最上面的那块决定"打开待办第一眼是什么"：天天在改日期的人要它第一，
   * 拿待办当便签的人要备注第一。解析与重排见 lib/detailSections.ts。
   */
  detailSectionOrder: "behavior.detailSectionOrder",
  reminderEnabled: "reminder.enabled",
  reminderSystem: "reminder.system",
  reminderSnooze: "reminder.snoozeMinutes",
  /**
   * 紧急阈值（分钟）：剩余时间少于这个值的待办与流程任务，会出现在侧边栏底部的紧急区。
   *
   * 做成可配置是因为"多近才算急"完全取决于手上是什么活儿：
   * 跟快递时效的人觉得 30 分钟就是火烧眉毛，排周计划的人觉得 2 天才算临近。
   * 写死一个值必然有一半人觉得它没用。
   */
  urgentMinutes: "urgent.thresholdMinutes",
  /**
   * 工具切走再切回来时，是否保持它原来的状态。
   *
   * 开启时工具的 iframe 常驻挂载，切走只是隐藏 —— 用户在里面调的样式、
   * 载入的数据、翻到第几页都还在。关掉则每次切回来都是"刚打开"的样子。
   * 默认开，因为**重置是破坏性的、保持不是**：一次误操作丢掉半小时的编辑，
   * 比多占几十兆内存难受得多；而想回到初始态的人随时可以按工具头部的「重置」。
   */
  toolKeepState: "tools.keepState",
  /**
   * 被停用的工具 id（逗号分隔）。
   *
   * 与「卸载」分开：停用只是不在侧边栏出现、不加载，文件还在；
   * 卸载是连文件一起删（见 lib/toolStore.ts）。两者都记在这里，
   * 因为它们的生效方式一样 —— 都是"过滤注册表"。
   */
  toolsDisabled: "tools.disabled",
  /**
   * 「特殊单号」记录表上额外挂哪些列（JSON 数组，元素是相关信息字段名）。
   *
   * 字段名是用户自己起的，所以"哪一列该上表"只有他自己知道：
   * 有人要一眼看到客户，有人要看到补发单号。写死几列等于所有人都要
   * 点开详情才能核对 —— 那这个记录表就白做了。
   */
  /**
   * 是否启用「特殊单号」模块。
   *
   * 关掉的是**入口与提醒**，不是数据：侧边栏入口、专属视图、创建弹窗里的类型切换、
   * 「我的一天」里那一组、以及时效提醒与紧急区都会停；已经建好的单子仍留在
   * 「流程任务」列表里，可以照常打开、推进、收尾，开关一打开就全回来。
   * 默认启用 —— 关闭必须是显式动作，缺键不等于"用户不要它"。
   */
  specialEnabled: "special.enabled",
  specialColumns: "special.columns",
  /** 相关信息的复制格式（见 lib/special.ts 的 CopyTemplate） */
  specialCopyTemplate: "special.copyTemplate",
  /** 记录表的行高密度：comfortable | compact */
  specialDensity: "special.density",
  /**
   * 快递单号的查询渠道：快递100 / 菜鸟 / 快递商官网（见 lib/couriers.ts）。
   *
   * 它是**全局偏好**而不是每张单的属性：一个人手上跑的单子渠道是固定的
   * （做平台单就一直用菜鸟），每张单都选一次等于把习惯变成重复劳动。
   */
  specialTrackChannel: "special.trackChannel",

  /* ------------------------------ 同步 ------------------------------ */

  /**
   * 同步用哪个网盘：`webdav`（坚果云、群晖、Nextcloud 都走这个）或 `onedrive`。
   *
   * 两者是**两套协议**，不是同一套的两种填法：OneDrive 个人版没有 WebDAV，
   * 走的是 Microsoft Graph + OAuth 登录。所以这个键决定的是
   * 「下面哪些字段有意义」—— 选了 OneDrive，账号密码那几项就不该再出现。
   * 默认保持 webdav：不能因为多了个新后端，就让老用户的配置换一种读法。
   */
  syncProvider: "sync.provider",

  /**
   * 坚果云 WebDAV 的服务地址。
   *
   * 默认是官方地址；做成可配置不只是"以后能换服务商"——
   * 群晖、Nextcloud、InfiniCLOUD 都提供 WebDAV，同一套代码能直接用。
   */
  syncBaseUrl: "sync.baseUrl",
  syncUsername: "sync.username",
  /**
   * 应用密码。
   *
   * ⚠️ **明文存在本机 SQLite 里**，没有做加密。理由：加密密钥也得存在本机
   * 才能自动同步（否则每次同步都要用户输一遍密码），而用系统凭据管理器
   * 要新增依赖、可能连带触发整树重编（见 attachments.rs 顶部那条教训）。
   * 代价是有限的 —— 数据库文件本来就在用户自己的机器上。
   * 但**界面上必须说清楚**，不能让用户以为它被加密了。
   */
  syncPassword: "sync.password",
  /** 远程目录，相对服务地址。多级用 / 分隔 */
  syncDir: "sync.dir",
  /**
   * 要同步的分片，逗号分隔。
   *
   * 默认 **只有 tasks** —— 「默认只同步待办」是刻意的：待办是每天在用的核心，
   * 流程任务/图库/附件的数据量与隐私权重都不一样，让用户自己决定要不要一起走。
   */
  syncShards: "sync.shards",
  /** 本机标识。首次使用时生成一个 uuid 并落库，此后不变 */
  syncDeviceId: "sync.deviceId",
  /** 设备名。用来在"上次是另一台机器写的"这类提示里说得清楚 */
  syncDeviceName: "sync.deviceName",
  /** 上次成功同步的时刻与摘要。只用于展示，不参与任何判断 */
  syncLastAt: "sync.lastAt",
  syncLastSummary: "sync.lastSummary",

  /* ---------------------------- OneDrive ---------------------------- */

  /**
   * Azure 应用（客户端）ID。
   *
   * 公共客户端的 client_id **不是密钥** —— 它本来就会出现在授权页的网址里，
   * 内置进应用、明文存在设置里都无妨。真正要保密的是下面那个 refresh_token。
   */
  onedriveClientId: "onedrive.clientId",
  /**
   * 长期令牌，用来换短期 access_token。
   *
   * ⚠️ 与 syncPassword 同一个待遇：**明文存在本机 SQLite 里**，没有加密
   * （理由见上面那条）。它比应用密码还要敏感一点 —— 拿到它就能读写你
   * OneDrive 里这个应用的专属文件夹。
   * 唯一的好消息是**同步设置本身不参与同步**，它不会被带到别的机器上。
   */
  onedriveRefreshToken: "onedrive.refreshToken",
  /** 已连接账号（邮箱）。只用于界面显示"已连接为 xxx" */
  onedriveAccount: "onedrive.account",

  /* ---------------------------- AI 助手 ---------------------------- */

  /**
   * 助手用哪家的对话接口（见 lib/agent/providers.ts 的 AGENT_PROVIDERS）。
   *
   * 和同步那边同一个道理：这个键决定"下面哪些字段有意义、请求打到哪个主机"。
   * 未知值会被 agentProvider() 收拢到 custom（**不是**回落到第一家）——
   * 回落到别家意味着把 API Key 发到一个用户没配过的主机。
   */
  agentProvider: "agent.provider",
  /** 接口根地址。留空则用服务商的默认地址 */
  agentBaseUrl: "agent.baseUrl",
  /**
   * API Key。
   *
   * ⚠️ 与同步密码、OneDrive 的 refresh_token 同一个待遇：**明文存在本机
   * SQLite 里**（理由见 syncPassword 那条）。区别是它通常还有额度上限、
   * 且可以随时在服务商后台吊销，所以风险比网盘令牌低一点 ——
   * 但界面上仍然要写清楚它没被加密。
   */
  agentApiKey: "agent.apiKey",
  /** 模型名。允许自由填写，见 providers 的 editableModel */
  agentModel: "agent.model",
  /**
   * 三项权限，各是一个 "1"/"0"。
   *
   * 默认全开：一个不能干活的内置助手只是一个更贵的输入框。但**默认开不等于
   * 不能关** —— 能改你文件系统的东西，必须有一个明确的刹车（见 lib/agent/actions.ts 的 gate）。
   */
  agentPermWriteTools: "agent.perm.writeTools",
  agentPermSchedules: "agent.perm.schedules",
  agentPermDatabase: "agent.perm.database",
  /**
   * 助手悬浮球的落点（`"x,y"`，以视口左上角为原点的像素）。
   *
   * 存成设置而不是组件内部 state：位置是"我习惯把它扔在哪儿"这类偏好，
   * 每次启动都弹回右下角的话，把它拖开就等于白拖一次。
   * **松手才落库** —— 拖动过程中每移一像素写一次库，是拿磁盘 I/O
   * 换一个没人看得见的中间态。
   *
   * 空串 = 用默认落点（右下角），见 lib/agent/ball.ts。
   */
  agentBallPos: "agent.ballPos",
  /**
   * 助手**窗口**上次在哪儿（左上角坐标，字符串 "x,y"）。
   *
   * 和球同理：位置是习惯，每次打开都回到同一点的话，把它挪开等于白挪一次。
   * 窗口尤其如此 —— 它盖在主界面上，压住哪一块取决于当时在看什么，
   * 这个位置只能由用户决定。空串 = 首次打开，落到左下角（见 windowGeom.ts）。
   */
  agentWindowPos: "agent.windowPos",
  /**
   * 上次在看哪一段对话。
   *
   * 存它是因为助手属于"我上次说到一半"的地方：重启后如果回到第一段历史，
   * 而刚才那段被顶到列表下面，用户的第一反应是"它把我的对话弄丢了"。
   */
  agentCurrentChat: "agent.currentChat",
} as const;

/** 头像可选色，与列表色板同源，避免两套颜色语言 */
export const AVATAR_COLORS = [
  "#d4537e",
  "#378add",
  "#1d9e75",
  "#ba7517",
  "#534ab7",
  "#d85a30",
];

export const DEFAULT_PROFILE = {
  name: "",
  email: "",
  color: AVATAR_COLORS[0],
};

/**
 * 两处可拖面板的宽度边界，放在 DEFAULT_SETTINGS 之前是因为默认值要引用它们
 * （const 有暂时性死区，顺序反了启动就炸）。
 *
 * 详情面板：下限 280 是内容决定的 —— 再窄的话"开始与交付"那两行日期会挤成两行，
 * 流程任务的过程态进度条也会开始折行。上限 720 是布局决定的 ——
 * 面板过宽会把中间的待办列表压到只剩一列字，主次就颠倒了。
 *
 * 侧边栏：下限 220 再窄就装不下"尺码表生成器"这种长清单名，
 * 上限 420 是让它不至于吃掉半个列表区。
 */
export const DETAIL_WIDTH = { min: 280, max: 720, default: 360 } as const;
export const SIDEBAR_WIDTH = { min: 220, max: 420, default: 280 } as const;

/**
 * 紧急阈值的边界（分钟）。
 *
 * 下限 5 分钟：再小就没有任何意义 —— 一条"还剩 3 分钟"的待办
 * 在你看到它的时候往往已经过期了，等于把紧急区变成逾期区。
 * 上限 14 天是布局决定的：紧急区的定位是"接下来这一两天要出手的"，
 * 真要按日期排两周的活儿，那看的是列表本身（到期日跟着行走），不是这里。
 */
export const URGENT_MINUTES = { min: 5, max: 20160, default: 480 } as const;

/** 阈值档位。给下拉用；不在档位里的值（自定义）由数字输入兜住 */
export const URGENT_PRESETS: Array<{ minutes: number; label: string }> = [
  { minutes: 30, label: "30 分钟" },
  { minutes: 60, label: "1 小时" },
  { minutes: 120, label: "2 小时" },
  { minutes: 240, label: "4 小时" },
  { minutes: 480, label: "8 小时" },
  { minutes: 720, label: "12 小时" },
  { minutes: 1440, label: "1 天" },
  { minutes: 2880, label: "2 天" },
  { minutes: 4320, label: "3 天" },
  { minutes: 10080, label: "7 天" },
];

export const DEFAULT_SETTINGS: Record<string, string> = {
  [SETTINGS.profileName]: DEFAULT_PROFILE.name,
  [SETTINGS.profileEmail]: DEFAULT_PROFILE.email,
  [SETTINGS.profileColor]: DEFAULT_PROFILE.color,
  [SETTINGS.theme]: "light",
  [SETTINGS.background]: "auto",
  [SETTINGS.bgScrim]: "medium",
  [SETTINGS.startupView]: "myday",
  [SETTINGS.sidebarOpen]: "1",
  [SETTINGS.detailWidth]: String(DETAIL_WIDTH.default),
  [SETTINGS.sidebarWidth]: String(SIDEBAR_WIDTH.default),
  [SETTINGS.detailSectionOrder]: JSON.stringify(DEFAULT_DETAIL_SECTIONS),
  [SETTINGS.reminderEnabled]: "1",
  [SETTINGS.reminderSystem]: "0",
  [SETTINGS.reminderSnooze]: "10",
  [SETTINGS.urgentMinutes]: String(URGENT_MINUTES.default),
  [SETTINGS.toolKeepState]: "1",
  [SETTINGS.toolsDisabled]: "",
  [SETTINGS.specialEnabled]: "1",
  [SETTINGS.specialColumns]: "[]",
  [SETTINGS.specialCopyTemplate]: "label-cn",
  [SETTINGS.specialDensity]: "comfortable",
  [SETTINGS.specialTrackChannel]: "kuaidi100",
  [SETTINGS.syncBaseUrl]: "https://dav.jianguoyun.com/dav",
  [SETTINGS.syncUsername]: "",
  [SETTINGS.syncPassword]: "",
  [SETTINGS.syncDir]: "待办工作台",
  [SETTINGS.syncShards]: "tasks",
  [SETTINGS.syncDeviceId]: "",
  [SETTINGS.syncDeviceName]: "",
  [SETTINGS.syncLastAt]: "",
  [SETTINGS.syncLastSummary]: "",
  // 新后端不改变既有行为：默认仍是坚果云 WebDAV
  [SETTINGS.syncProvider]: "webdav",
  [SETTINGS.onedriveClientId]: "",
  [SETTINGS.onedriveRefreshToken]: "",
  [SETTINGS.onedriveAccount]: "",
  // 助手默认指向 Agnes（工作台里已经接入的那家），模型选 Agent 向的那个；
  // Key 留空 → 界面停在"还没配好"的状态里，明确告诉用户缺什么
  [SETTINGS.agentProvider]: "agnes",
  [SETTINGS.agentBaseUrl]: "",
  [SETTINGS.agentApiKey]: "",
  [SETTINGS.agentModel]: "agnes-3.0-flash",
  // 三项权限默认全开，见 SETTINGS 里的说明
  [SETTINGS.agentPermWriteTools]: "1",
  [SETTINGS.agentPermSchedules]: "1",
  [SETTINGS.agentPermDatabase]: "1",
  // 空串 = 悬浮球用默认落点（右下角）；当前会话空串 = 载入时选最近动过的那段
  [SETTINGS.agentBallPos]: "",
  [SETTINGS.agentWindowPos]: "",
  [SETTINGS.agentCurrentChat]: "",
};

/**
 * 把设置里的面板宽度读成一个安全数字。
 *
 * 手改数据库、旧版本残留、或者以后换单位都可能留下脏值，
 * 一律夹到边界内 —— 宽度一旦算成 NaN，面板会以 0 宽度渲染，
 * 表现是"面板整个不见了"，且没有任何报错可查。
 */
function clampWidth(raw: string | undefined, r: WidthRange): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return r.default;
  return Math.min(r.max, Math.max(r.min, Math.round(n)));
}

type WidthRange = { min: number; max: number; default: number };

export function parseDetailWidth(raw: string | undefined): number {
  return clampWidth(raw, DETAIL_WIDTH);
}

export function parseSidebarWidth(raw: string | undefined): number {
  return clampWidth(raw, SIDEBAR_WIDTH);
}

/**
 * 助手悬浮球的落点（`"x,y"`）→ 坐标，读不出来给 null。
 *
 * 为什么只解析、不夹视口边界：**只有拿得到当前视口的人才知道边界是多少**。
 * 一个被拖到 2200 的 x，在 2560 的显示器上是合法的、在 1366 的笔记本上
 * 已经在视口外（球会渲染到看不见的地方）。夹取交给拿得到 window 的那一层
 * （lib/agent/ball.ts 的 clampBallPos）。
 */
export function parseBallPos(raw: string | undefined): { x: number; y: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw ?? "");
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * 把设置里的紧急阈值读成一个安全分钟数。
 *
 * 同样一律夹到边界内：阈值算成 NaN 时比较的结果恒为 false，
 * 表现是紧急区**永远空着**，且不报错 —— 用户只会以为自己没有急事。
 */
export function parseUrgentMinutes(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return URGENT_MINUTES.default;
  return Math.min(URGENT_MINUTES.max, Math.max(URGENT_MINUTES.min, Math.round(n)));
}

/** 读取配置并补上默认值，调用方不必处理 undefined */
export function withDefaults(raw: Record<string, string>): Record<string, string> {
  return { ...DEFAULT_SETTINGS, ...raw };
}

/* ------------------------------------------------------------------ */
/* 工具的停用清单与状态保持                                             */
/* ------------------------------------------------------------------ */

/**
 * 工具 id 的合法字符集，与 tools.ts 的 manifest 校验、toolTable() 的表名前缀
 * 保持一致。停用清单是从设置里读出来的**字符串**，可能被手改过，
 * 所以不合法的一律丢掉 —— 而不是把脏值传下去。
 */
const TOOL_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** 解析停用清单（逗号分隔）。空白项、重复项、非法 id 全部过滤掉。 */
export function parseDisabledTools(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (TOOL_ID_RE.test(id)) out.add(id);
  }
  return out;
}

/** 序列化停用清单：排序去重，让同一个集合永远写出同一串，便于比对与手改。 */
export function formatDisabledTools(ids: Iterable<string>): string {
  const clean = [...new Set(ids)].filter((id) => TOOL_ID_RE.test(id)).sort();
  return clean.join(",");
}

/** 在停用清单上增删一个工具，返回新的清单串 */
export function toggleDisabledTool(current: string | undefined, id: string, disabled: boolean): string {
  const set = parseDisabledTools(current);
  if (disabled) set.add(id);
  else set.delete(id);
  return formatDisabledTools(set);
}

/**
 * 是否保持工具状态。
 *
 * 只有显式写了 "0" 才算关 —— 缺键、空串、别的值都按默认（保持）处理。
 * 方向不能反：写错一个键就把用户的工具状态丢掉，代价不对等。
 */
export function parseToolKeepState(raw: string | undefined): boolean {
  return raw !== "0";
}

/**
 * 「特殊单号」模块是否启用。
 *
 * 与 parseToolKeepState 同一条方向：**只有显式写了 "0" 才算关** ——
 * 缺键、空串、手改数据库留下的脏值一律按默认（启用）处理。
 * 方向不能反：反过来写的话，一次意外的脏值就会让用户那批记录从界面上
 * 凭空消失，而他还不知道发生了什么。
 */
export function parseSpecialEnabled(raw: string | undefined): boolean {
  return raw !== "0";
}

export function isThemeMode(v: string | undefined): v is ThemeMode {
  return v === "light" || v === "dark" || v === "system";
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 把主题模式解析成实际要用的浅/深 */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    if (typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches) return "dark";
    return "light";
  }
  return mode;
}

/**
 * 把主题写到 <html data-theme>。
 *
 * 颜色都走 CSS 变量（见 styles.css），所以这里只切一个属性就够，
 * 不用给每个组件传主题。
 */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(mode);
}

/** 跟随系统时订阅系统主题变化；返回取消订阅函数 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export const STARTUP_VIEWS: Array<{ value: SmartView; label: string }> = [
  { value: "myday", label: "我的一天" },
  { value: "important", label: "重要" },
  { value: "all", label: "全部" },
  { value: "orders", label: "流程任务" },
  { value: "gallery", label: "图库" },
  // AI 助手也能作为启动视图：习惯一进来就让它排今天的人有这个需求，
  // 而且它和别的视图没有互斥关系（都能随时切走）
  { value: "agent", label: "AI 助手" },
];

export function isStartupView(v: string | undefined): v is SmartView {
  return STARTUP_VIEWS.some((x) => x.value === v);
}

/* ------------------------------------------------------------------ */
/* AI 助手的配置与权限                                                  */
/* ------------------------------------------------------------------ */

/**
 * 读助手配置。
 *
 * 只做"取出与去空白"，**不做校验**（地址合不合法、模型名对不对都不在这里判）。
 * 判断交给 lib/agent/providers.ts 的 agentConfigProblems —— 那里才知道
 * 每一家的默认地址是什么、缺哪一项该怎么补。
 */
export function readAgentConfig(settings: Record<string, string>): {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  return {
    provider: (settings[SETTINGS.agentProvider] ?? "").trim() || "agnes",
    // 地址与 Key 都去空白：从文档里复制粘贴最容易带上首尾空格，
    // 而带上空格的 Key 会得到一个 401，报错里完全看不出原因
    baseUrl: (settings[SETTINGS.agentBaseUrl] ?? "").trim(),
    apiKey: (settings[SETTINGS.agentApiKey] ?? "").trim(),
    model: (settings[SETTINGS.agentModel] ?? "").trim(),
  };
}

/**
 * 读权限。
 *
 * 与其它布尔开关同一条方向：**只有显式写了 "0" 才算关**。
 * 缺键、空串、手改数据库留下的脏值一律按"开"处理 ——
 * 反过来写的话，一次意外的脏值会静默阉掉助手的动手能力，
 * 而用户只会看到它一直在说"我没有权限"，找不出为什么。
 */
export function parseAgentPermissions(settings: Record<string, string>): {
  writeTools: boolean;
  schedules: boolean;
  database: boolean;
} {
  const on = (key: string) => settings[key] !== "0";
  return {
    writeTools: on(SETTINGS.agentPermWriteTools),
    schedules: on(SETTINGS.agentPermSchedules),
    database: on(SETTINGS.agentPermDatabase),
  };
}
