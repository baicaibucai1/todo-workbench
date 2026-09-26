/**
 * 壁纸清单与「背景」设置。
 *
 * 背景有三种：
 *   auto         —— 跟随视图（沿用各视图自己的渐变，即原来的样子）
 *   image:<文件> —— 用选中的那张必应壁纸铺满待办区
 *   custom:<路径> —— 用**用户自己传的**那张图（存在附件仓库里）
 *
 * 必应的图是**随包发布的静态资源**（public/wallpapers，由
 * scripts/fetch-wallpapers.mjs 抓取），不是运行时联网拉的：
 * 工作台离线优先，联网取图会让"换背景"在断网时变成一排加载不出来的灰格子。
 *
 * 自定义的那部分走 attachmentStore（见 lib/attachments.ts）：
 * 桌面上落在 AppData 的仓库目录里，浏览器 demo 落在 IndexedDB。
 * 不另起一套存储 —— 同样的"我传进来的文件"应该在同一处，清理、查占用
 * 都复用现成的入口，而不是让用户在两个地方找自己传过的图。
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

export type BackgroundSetting =
  | { kind: "auto" }
  | { kind: "image"; file: string }
  | { kind: "custom"; path: string };

/**
 * 从配置值解析背景。无法识别的值一律退回 auto —— 坏配置不该让界面变成一块空白。
 *
 * ⚠️ 前缀判断有顺序：自定义的 `custom:` 必须排在 `image:` 之前判断没有依赖
 * （两者前缀不同，其实无所谓），但**新增种类时要记得这里加分支**，
 * 漏了的表现是"选了新类型，界面退回跟随视图"，很难联想到是解析漏了。
 */
export function parseBackground(raw: string | undefined): BackgroundSetting {
  const v = (raw ?? "").trim();
  if (v.startsWith("custom:")) {
    const path = v.slice("custom:".length).trim();
    if (path) return { kind: "custom", path };
  }
  if (v.startsWith("image:")) {
    const file = v.slice("image:".length).trim();
    if (file) return { kind: "image", file };
  }
  return { kind: "auto" };
}

export function formatBackground(bg: BackgroundSetting): string {
  if (bg.kind === "image") return `image:${bg.file}`;
  if (bg.kind === "custom") return `custom:${bg.path}`;
  return "auto";
}

/** 内置壁纸的 URL。自定义的不走这里 —— 它的地址要异步向仓库要 */
export function wallpaperUrl(file: string): string {
  return `${BASE_URL}${WALLPAPER_DIR}/${file}`;
}

/* ------------------------------------------------------------------ */
/* 自定义壁纸                                                          */
/* ------------------------------------------------------------------ */

export interface CustomWallpaper {
  /** 附件仓库内的相对路径 —— 这是唯一持久化的标识 */
  path: string;
  /** 原始文件名，只在界面上给人看 */
  name: string;
}

/**
 * 单张壁纸的大小上限。
 *
 * 壁纸是要铺满整个待办区、每次开应用都解码一次的。一张 4K 的 PNG 有十几 MB，
 * 只为当背景太浪费；12 MB 足够放下绝大多数相机直出的 JPG。
 */
export const WALLPAPER_MAX_BYTES = 12 * 1024 * 1024;

/** 只收图片：视频壁纸会一直占着解码器，这是个工作台不是主题商店 */
export const WALLPAPER_IMAGE_ONLY = /^image\//;

export function parseCustomWallpapers(raw: string | undefined): CustomWallpaper[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((x): x is CustomWallpaper => !!x && typeof x.path === "string" && !!x.path)
      .map((x) => ({ path: x.path, name: typeof x.name === "string" ? x.name : x.path }));
  } catch {
    // 手改数据库、旧版本留下的坏 JSON：当作"没有自定义壁纸"，
    // 而不是让设置页整个白屏
    return [];
  }
}

export function formatCustomWallpapers(list: CustomWallpaper[]): string {
  return JSON.stringify(list);
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
