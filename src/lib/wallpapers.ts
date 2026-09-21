/**
 * 壁纸清单与「背景」设置。
 *
 * 背景有两种模式：
 *   auto        —— 跟随视图（沿用各视图自己的渐变，即原来的样子）
 *   image:<文件> —— 用选中的那张必应壁纸铺满待办区
 *
 * 图片本身是**随包发布的静态资源**（public/wallpapers，由
 * scripts/fetch-wallpapers.mjs 抓取），不是运行时联网拉的：
 * 工作台离线优先，联网取图会让"换背景"在断网时变成一排加载不出来的灰格子。
 */

export type Wallpaper = {
  /** 文件名，也是设置里存的那个 id */
  file: string;
  /** 拍摄/发布日 YYYY-MM-DD */
  date: string;
  /** 抓取时的市场，换市场抓的两批图混在一个目录里，靠它区分来源 */
  mkt?: string;
  title: string;
  copyright: string;
  /** 必应原图地址，留档用，界面不依赖它 */
  url?: string;
};

export const WALLPAPER_DIR = "wallpapers";

/**
 * 部署根路径。
 *
 * 不能直接写 `/wallpapers/...`：开发时根是 `/`，但如果哪天把 demo 部署到子路径，
 * 绝对路径会 404。走 Vite 的 BASE_URL 才是跟着构建配置走的。
 * 这里用可选链兜底，是因为本模块的纯函数会被 Node 里的冒烟测试直接导入，
 * 那个环境没有 `import.meta.env`。
 */
const BASE_URL: string =
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";

/** 背景遮罩强度：照片明暗差异很大，只给一档必然有看不清的时候 */
export type ScrimLevel = "soft" | "medium" | "strong";

/**
 * 遮罩分两层：
 *   base —— 整块均匀压暗，保证列表行之间的白字（分组标题、空态文案）可读
 *   top  —— 顶部额外压暗，因为那里是白色的大标题，压不住就直接糊在天空上
 */
export const SCRIM: Record<ScrimLevel, { base: number; top: number; label: string }> = {
  soft: { base: 0.16, top: 0.34, label: "弱" },
  medium: { base: 0.3, top: 0.52, label: "中" },
  strong: { base: 0.46, top: 0.68, label: "强" },
};

export const SCRIM_LEVELS: ScrimLevel[] = ["soft", "medium", "strong"];

export function isScrimLevel(v: string | undefined): v is ScrimLevel {
  return v === "soft" || v === "medium" || v === "strong";
}

export type BackgroundSetting = { kind: "auto" } | { kind: "image"; file: string };

/** 从配置值解析背景。无法识别的值一律退回 auto —— 坏配置不该让界面变成一块空白 */
export function parseBackground(raw: string | undefined): BackgroundSetting {
  const v = (raw ?? "").trim();
  if (v.startsWith("image:")) {
    const file = v.slice("image:".length).trim();
    if (file) return { kind: "image", file };
  }
  return { kind: "auto" };
}

export function formatBackground(bg: BackgroundSetting): string {
  return bg.kind === "image" ? `image:${bg.file}` : "auto";
}

export function wallpaperUrl(file: string): string {
  return `${BASE_URL}${WALLPAPER_DIR}/${file}`;
}

let cache: Wallpaper[] | null = null;

/**
 * 读壁纸清单。
 *
 * 结果缓存在模块里：清单在一次会话内不会变，而设置界面每次切分区都会重新挂载，
 * 不缓存就是每次切回来都重新发一次请求。
 * 失败一律返回空数组 —— 调用方按"没有壁纸"处理（提示怎么抓），而不是抛异常。
 */
export async function loadWallpapers(): Promise<Wallpaper[]> {
  if (cache) return cache;
  try {
    const res = await fetch(`${BASE_URL}${WALLPAPER_DIR}/index.json`, {
      cache: "no-cache",
    });
    if (!res.ok) return (cache = []);
    const data = (await res.json()) as { items?: Wallpaper[] };
    cache = Array.isArray(data?.items)
      ? data.items.filter((it) => it && typeof it.file === "string" && it.file)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** 仅供测试：清掉清单缓存 */
export function resetWallpaperCache(): void {
  cache = null;
}
