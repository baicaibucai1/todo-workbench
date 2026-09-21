/**
 * 应用配置：键名、默认值与主题落地。
 *
 * 配置存 core_settings（键值表），这里只负责"键叫什么、默认值是什么、怎么生效"，
 * 读写本身仍在 repo 层。UI 不应该出现裸的字符串键名。
 */

import type { SmartView } from "../types";

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
  reminderEnabled: "reminder.enabled",
  reminderSystem: "reminder.system",
  reminderSnooze: "reminder.snoozeMinutes",
  /**
   * 紧急阈值（分钟）：剩余时间少于这个值的待办与工单，会出现在侧边栏底部的紧急区。
   *
   * 做成可配置是因为"多近才算急"完全取决于手上是什么活儿：
   * 跟快递时效的人觉得 30 分钟就是火烧眉毛，排周计划的人觉得 2 天才算临近。
   * 写死一个值必然有一半人觉得它没用。
   */
  urgentMinutes: "urgent.thresholdMinutes",
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
 * 工单的过程态进度条也会开始折行。上限 720 是布局决定的 ——
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
 * 真要拿它排两周的活儿，那该去的是「计划内」视图。
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
  [SETTINGS.reminderEnabled]: "1",
  [SETTINGS.reminderSystem]: "0",
  [SETTINGS.reminderSnooze]: "10",
  [SETTINGS.urgentMinutes]: String(URGENT_MINUTES.default),
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
  { value: "planned", label: "计划内" },
  { value: "all", label: "全部" },
  { value: "orders", label: "工单" },
  { value: "gallery", label: "图库" },
];

export function isStartupView(v: string | undefined): v is SmartView {
  return STARTUP_VIEWS.some((x) => x.value === v);
}
