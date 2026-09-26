/**
 * 主题色：两个角色、一组预设、以及"怎么把它落到 CSS 上"。
 *
 * 两个角色（accent / primary）的分工写在 styles.css 的变量定义处，这里只管值。
 *
 * ⚠️ 两条硬约束，改动前先读：
 *
 * 1. **任何进入 CSS 的颜色都必须先过 fitForUi()**。
 *    界面上凡是 bg-primary / bg-accent 的地方，字色都写死了白色。所以可选范围
 *    被限制在"白字能看清"的明度区间内 —— 不是限制用户的审美，是避免为了
 *    支持浅色主题色去改 30 多处 text-white。取色器给不出看不清的字，
 *    比让它给出、然后到处补可读色要省事得多，也不会漏。
 *
 * 2. **落地方式是写 <html> 的内联 style**，不是换 class、不是重新构建。
 *    内联样式优先级高于 :root 里的 @theme 变量，所以改完立刻生效，
 *    也不需要为每个可能的色值预生成工具类（Tailwind 在构建时就得知道类名）。
 */

import { SETTINGS } from "./settings";

/* ------------------------------------------------------------------ */
/* 色值算术                                                            */
/* ------------------------------------------------------------------ */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 支持 #abc / abc / #aabbcc / aabbcc；带透明度的（#aabbcc80）按不合法处理 */
export function normalizeHex(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return "#" + s.toLowerCase();
}

export function hexToRgb(hex: string): Rgb {
  const n = normalizeHex(hex);
  if (!n) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

export function rgbToHex(c: Rgb): string {
  const p = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

export function rgbToHsl(c: Rgb): Hsl {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToRgb(c: Hsl): Rgb {
  const h = ((c.h % 360) + 360) % 360;
  const s = clamp(c.s, 0, 1);
  const l = clamp(c.l, 0, 1);
  const cc = (1 - Math.abs(2 * l - 1)) * s;
  const x = cc * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - cc / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [cc, x, 0];
  else if (h < 120) rgb = [x, cc, 0];
  else if (h < 180) rgb = [0, cc, x];
  else if (h < 240) rgb = [0, x, cc];
  else if (h < 300) rgb = [x, 0, cc];
  else rgb = [cc, 0, x];
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}

/** 两色按比例混合，t=0 取 a，t=1 取 b */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

/** amount > 0 往白走，< 0 往黑走 */
export function shade(hex: string, amount: number): string {
  return amount >= 0 ? mixHex(hex, "#ffffff", amount) : mixHex(hex, "#000000", -amount);
}

/** WCAG 相对亮度，用来决定字色 */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function readableTextOn(hex: string): string {
  return luminance(hex) > 0.45 ? "#1a1a1a" : "#ffffff";
}

/* ------------------------------------------------------------------ */
/* 可用区间                                                            */
/* ------------------------------------------------------------------ */

/**
 * 明度钳制区间（HSL 的 L）。
 *
 * 上限 0.62：再亮白字就糊了（bg-primary 上的字是白色的）。
 * 下限 0.30：再深就跟深色主题的面板背景分不开了，按钮看着像窟窿。
 */
export const L_RANGE = { min: 0.3, max: 0.62 } as const;

/**
 * 饱和度过低的颜色当不了主题色 —— 天空的灰、水泥的白，取出来是"没换色"。
 *
 * ⚠️ 只在**从图片取色**时生效（见 fitForUi 的第二个参数）。
 * 人手工挑的低饱和配色是有意为之（比如那套"石墨"），不该被强行提浓。
 */
export const S_MIN = 0.22;

/**
 * 白字能站得住的最大相对亮度。
 *
 * 比 readableTextOn 的阈值（0.45）再压一点留余量：卡在边界上的色，
 * 换到另一块屏幕上就分不清了。
 */
const WHITE_TEXT_MAX_LUMA = 0.42;

/**
 * 把一个任意颜色收拾成能当主题色用的样子：保住色相，把明度拉进区间。
 *
 * @param liftSaturation 是否把过灰的颜色提浓。从壁纸取色时给 true，
 *                       应用用户挑好的配色时给 false。
 */
export function fitForUi(hex: string, liftSaturation = true): string {
  const n = normalizeHex(hex);
  if (!n) return DEFAULT_THEME.accent;
  const hsl = rgbToHsl(hexToRgb(n));
  const s = liftSaturation && hsl.s < S_MIN ? S_MIN : hsl.s;
  let l = clamp(hsl.l, L_RANGE.min, L_RANGE.max);
  let out = rgbToHex(hslToRgb({ h: hsl.h, s, l }));

  /*
   * 光按 HSL 的明度钳制**不够**。
   *
   * 纯黄 #ffff00 的 L 只有 0.5，稳稳落在区间里，可它的相对亮度是 0.93 ——
   * 人眼对绿通道最敏感（权重 0.7152），黄和青在同样的 L 下要亮得多。
   * 只按 L 收一道，纯黄会原样过关，然后按钮上的白字糊成一片。
   * 所以这里再按 WCAG 相对亮度退一次，一直退到白字站得住为止。
   */
  let guard = 0;
  while (luminance(out) > WHITE_TEXT_MAX_LUMA && l > L_RANGE.min && guard++ < 32) {
    l -= 0.02;
    out = rgbToHex(hslToRgb({ h: hsl.h, s, l }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 预设色板                                                            */
/* ------------------------------------------------------------------ */

export interface Palette {
  id: string;
  /** 给用户看的名字 */
  name: string;
  /** 品牌色 */
  accent: string;
  /** 主操作色 */
  primary: string;
}

/**
 * 每套给**两个**色，不是一个 —— 换主题色要换的是整套关系。
 *
 * accent 与 primary 之间留 60°~120° 的色相差或明显的明度差：
 * 太接近的话，同屏上"这是我的标记"和"这个能点"就分不清了。
 */
export const PALETTES: Palette[] = [
  { id: "rouge", name: "胭脂", accent: "#d4537e", primary: "#378add" },
  { id: "crabapple", name: "海棠", accent: "#e0623d", primary: "#2f7d6a" },
  { id: "amber", name: "秋香", accent: "#c9962c", primary: "#8a5a2b" },
  { id: "pine", name: "松翠", accent: "#2f9e6f", primary: "#1f6f8b" },
  { id: "lake", name: "湖蓝", accent: "#2b8ac6", primary: "#185a9d" },
  { id: "indigo", name: "靛紫", accent: "#7a6ad0", primary: "#3f51b5" },
  { id: "lotus", name: "藕荷", accent: "#c2649a", primary: "#6a4c93" },
  // 「石墨」是唯一一套低饱和的：就是要那个低调的冷灰。
  // 它的两个色在明度上拉开（0.46 / 0.35）而不是靠色相 —— 同色相深浅配，
  // 是灰调子该有的样子。也正因如此，applyThemeColors 对它不提饱和度。
  { id: "graphite", name: "石墨", accent: "#6b7280", primary: "#4a5568" },
];

export const DEFAULT_THEME: Palette = PALETTES[0];

export function paletteById(id: string): Palette | null {
  return PALETTES.find((p) => p.id === id) ?? null;
}

/** 当前配色落在哪套预设上（都不匹配则返回 null，说明是自定义色） */
export function matchPalette(accent: string, primary: string): Palette | null {
  const a = normalizeHex(accent);
  const p = normalizeHex(primary);
  if (!a || !p) return null;
  return PALETTES.find((x) => x.accent === a && x.primary === p) ?? null;
}

/* ------------------------------------------------------------------ */
/* 落地                                                                */
/* ------------------------------------------------------------------ */

export interface ThemeColors {
  accent: string;
  primary: string;
}

/**
 * 从设置里读出配色；空值或非法值退回默认色板。
 *
 * ⚠️ 键名必须走 SETTINGS，不能写 `settings.accent` 这种裸字段：
 * 存进数据库的键是 `appearance.accent`，写成裸字段会永远读到 undefined，
 * 于是"改了色重启又变回去"，而界面上一句报错都没有（2026-09-24 实测踩到）。
 */
export function themeColorsFrom(settings: Record<string, string>): ThemeColors {
  const accent = normalizeHex(settings[SETTINGS.accent]);
  const primary = normalizeHex(settings[SETTINGS.primary]);
  return {
    accent: accent ?? DEFAULT_THEME.accent,
    primary: primary ?? DEFAULT_THEME.primary,
  };
}

const VAR_ACCENT = "--color-accent";
const VAR_ACCENT_DARK = "--color-accent-dark";
const VAR_PRIMARY = "--color-primary";

/**
 * 把配色写进 <html> 的内联 style。
 *
 * 传 null 表示"恢复默认"：此时要**删掉**内联属性而不是写成默认值 ——
 * 写死进去的话，将来改 DEFAULT_THEME 老用户看不到新默认色。
 */
export function applyThemeColors(colors: ThemeColors | null): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  if (!colors) {
    el.style.removeProperty(VAR_ACCENT);
    el.style.removeProperty(VAR_ACCENT_DARK);
    el.style.removeProperty(VAR_PRIMARY);
    return;
  }
  // 第二个参数 false：不提饱和度。用户挑的配色（含预设里那套"石墨"）
  // 是什么就是什么，只兜"白字看不清"这一条底线。
  const accent = fitForUi(colors.accent, false);
  const primary = fitForUi(colors.primary, false);
  el.style.setProperty(VAR_ACCENT, accent);
  // 深色变体：往黑里压，供需要"同一色更深一档"的地方用（悬停、按下）
  el.style.setProperty(VAR_ACCENT_DARK, shade(accent, -0.28));
  el.style.setProperty(VAR_PRIMARY, primary);
}
