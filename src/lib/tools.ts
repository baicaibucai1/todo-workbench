/**
 * 工具装载子系统。
 *
 * 契约：每个工具是一个目录，内含 manifest.json + 入口 HTML。
 *
 *   tools/image-crop/
 *     manifest.json
 *     index.html
 *
 * manifest.json 结构见 types.ts 的 ToolManifest。
 *
 * 扫描顺序（后面的覆盖前面的同名工具，便于用户覆盖内置工具）：
 *   1. 应用包内 <resources>/tools/     —— 随安装包分发的内置工具
 *   2. 用户数据区 <appDataDir>/tools/  —— 用户自己丢进去的工具
 *
 * 关键设计：工具目录放在用户数据区而不是安装包内，
 * 这样新增工具不需要重新打包发版 —— 这正是"可更新"的一部分。
 */

import { isTauri } from "./db";
import type { ToolManifest } from "../types";

/* ------------------------------------------------------------------ */
/* 内置工具清单（浏览器 demo 用；打包时由构建脚本生成真实的 tools/ 目录）  */
/* ------------------------------------------------------------------ */

/**
 * 内置工具在打包环境下由 Tauri 端读取 `tools/` 目录得到。
 * 浏览器 demo 没有文件系统，这里给出一份等价的静态清单。
 * 两者的 schema 完全一致，因此上层代码无需分支。
 *
 * 注意：浏览器模式下工具的 HTML 由 Vite dev server 直接服务
 * （`tools/` 在工程根目录下，见 resolveToolUrl），
 * 所以新增工具时除了往 tools/ 丢目录，也要同步在这里登记一条。
 */
const BUILTIN_TOOLS: ToolManifest[] = [
  {
    // 图片编辑器 Image Studio：与隔壁 图片裁剪/图片裁剪工具/index.html 是同一份文件，
    // 由 scripts/sync-tools.mjs 守着 SHA-256 一致性，改一边记得同步另一边。
    //
    // 它带一个可选资源目录 ai/（约 50MB 的抠图模型 + ORT wasm，base64 分片，
    // 用 <script src> 加载）。**整目录缺失不影响使用**，只是智能填充退回纯 JS ——
    // 所以打包时没有带上那 50MB，工具仍然完整可用。
    id: "image-crop",
    name: "图片裁剪",
    version: "2.0.0",
    description:
      "图片编辑器 Image Studio：裁剪 / 尺寸与比例 / 镜像 / 选区填充 / 批量导出；可从工作台图库直接取图，导出的图默认自动存回图库（开关可关）",
    icon: "crop",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
  },
  {
    id: "size-chart",
    name: "尺码表生成器",
    version: "1.1.0",
    description: "粘贴 Excel 尺码数据，套用主题生成可直接发布的尺码表图片；导出的图默认在工作台图库留一份（开关可关），同一份内容不重复占条目",
    icon: "list",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
  },
  {
    // 已接入 Agnes AI（生图 / 生视频 / 对话，OpenAI 风格接口）。
    // 服务商与能力都以「描述符」形式写在工具内部的 PROVIDERS 里，
    // 加一家新 API 只动工具，不用动宿主。
    id: "ai-gen",
    name: "AI 生成",
    version: "0.5.0",
    description:
      "文生图 / 图生图、文生视频与对话。已接入阿里云百炼（万相、千问图像、Z-Image 共 21 档，按族走各自接口）与 Agnes AI，出图默认自动存进图库（开关可关）、参考图可从图库挑，生成结果可一键放回参考图继续编辑",
    icon: "sparkles",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
  },
];

/** 内存中的已注册工具 */
let registry: ToolManifest[] = [];
let registryLocation = "内置清单（浏览器模式）";

/* ------------------------------------------------------------------ */
/* manifest 校验                                                       */
/* ------------------------------------------------------------------ */

/**
 * 校验 manifest。工具是外部输入，必须当作不可信数据处理 ——
 * 一个坏掉的 manifest 不应该让整个应用起不来。
 */
export function validateManifest(raw: unknown): ToolManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;

  const id = typeof m.id === "string" ? m.id.trim() : "";
  const name = typeof m.name === "string" ? m.name.trim() : "";
  const entry = typeof m.entry === "string" ? m.entry.trim() : "";

  // id 会参与表名拼接，必须严格限制字符集，否则有 SQL 注入风险
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) return null;
  if (!name || !entry) return null;
  // 禁止通过 ../ 逃逸出工具目录
  if (entry.includes("..") || entry.startsWith("/") || /^[a-z]+:/i.test(entry)) return null;

  return {
    id,
    name,
    version: typeof m.version === "string" ? m.version : "0.0.0",
    description: typeof m.description === "string" ? m.description : undefined,
    icon: typeof m.icon === "string" ? m.icon : "package",
    entry,
    dbVersion: Number.isInteger(m.dbVersion) ? (m.dbVersion as number) : 1,
    author: typeof m.author === "string" ? m.author : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 扫描一个工具目录，返回其中合法的工具。
 * 单个工具读坏了只跳过它 —— 工具是外部输入，不该拖垮整个应用。
 */
async function scanToolsDir(dir: string): Promise<ToolManifest[]> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");

  if (!(await fs.exists(dir))) return [];
  const out: ToolManifest[] = [];
  for (const e of await fs.readDir(dir)) {
    if (!e.isDirectory) continue;
    try {
      const manifestPath = await join(dir, e.name, "manifest.json");
      if (!(await fs.exists(manifestPath))) continue;
      const manifest = validateManifest(JSON.parse(await fs.readTextFile(manifestPath)));
      if (manifest) out.push(manifest);
    } catch {
      // 单个工具读取失败不影响其他工具
    }
  }
  return out;
}

/**
 * 桌面端工具的两个来源，都要扫。
 *
 * 这个函数以前只扫用户数据区 —— 注释里写着「应用包内 resources」是第 1 级来源，
 * 但那一级从来没实现过。后果是：安装包把工具老老实实装进了安装目录，
 * 应用却从不往那儿看，于是**桌面版所有工具都打不开**（浏览器 demo 走 Vite 静态服务，
 * 一直正常，把这个问题掩盖了很久）。
 */
async function scanTauriTools(): Promise<{ bundled: ToolManifest[]; user: ToolManifest[] }> {
  const bundled: ToolManifest[] = [];
  const user: ToolManifest[] = [];

  try {
    const { resourceDir, join } = await import("@tauri-apps/api/path");
    const rd = await resourceDir();
    // 资源路径里的 `..` 被 Tauri 编码成 `_up_`，所以工具在 _up_/tools 下。
    // 也试一下不带 _up_ 的位置，万一以后 resources 配置改成不含 `..` 的形式。
    bundled.push(...(await scanToolsDir(await join(rd, "_up_", "tools"))));
    if (bundled.length === 0) bundled.push(...(await scanToolsDir(await join(rd, "tools"))));
  } catch {
    // 取不到资源目录就当作没有内置工具，由 BUILTIN_TOOLS 兜底
  }

  try {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const dir = await join(await appDataDir(), "tools");
    user.push(...(await scanToolsDir(dir)));
    if (user.length) registryLocation = dir;
  } catch {
    // appData 取不到就算了，不影响内置工具
  }

  return { bundled, user };
}

/**
 * 扫描并注册全部工具。
 * 用户数据区的工具会覆盖同 id 的内置工具，方便本地调试和替换。
 */
export async function loadTools(): Promise<ToolManifest[]> {
  const merged = new Map<string, ToolManifest>();

  // 1. 硬编码清单兜底（浏览器模式唯一来源；桌面端扫描失败时也有得用）
  for (const t of BUILTIN_TOOLS) merged.set(t.id, t);

  // 2. 安装包内的工具（真实文件，以磁盘为准）
  const { bundled, user } = await scanTauriTools();
  for (const t of bundled) merged.set(t.id, t);

  // 3. 用户数据区的工具（优先级最高，可覆盖同 id 内置工具）
  for (const t of user) merged.set(t.id, t);

  registry = [...merged.values()];
  return registry;
}

export function listTools(): ToolManifest[] {
  return registry;
}

export function getTool(id: string): ToolManifest | undefined {
  return registry.find((t) => t.id === id);
}

export function toolLocation(): string {
  return registryLocation;
}

/** 最近一次解析尝试过的候选路径（工具打不开时显示它，省得靠猜） */
let lastCandidates: string[] = [];

export function lastToolCandidates(): string[] {
  return lastCandidates;
}

/**
 * 桌面端工具文件的候选位置，按优先级排列。
 *
 * 为什么是多候选而不是写死一个：工具落在哪由 `bundle.resources` 决定，
 * 而资源路径里的 `..` 会被 Tauri 编码成 `_up_`
 * （`../tools/x` → `$RESOURCE/_up_/tools/x`）。这是 Tauri 的资源路径规则，
 * 不由我们决定。硬编码单一路径的话，改一次 resources 配置就全挂 ——
 * 而且是在「装完双击打开」那一刻才挂，浏览器里根本测不出来。
 */
async function desktopToolCandidates(tool: ToolManifest): Promise<string[]> {
  const out: string[] = [];
  const { appDataDir, resourceDir, join } = await import("@tauri-apps/api/path");

  const add = async (...parts: string[]) => {
    try {
      out.push(await join(...parts));
    } catch {
      // 某个基准目录取不到就跳过这个候选
    }
  };

  try {
    const rd = await resourceDir();
    await add(rd, "_up_", "tools", tool.id, tool.entry); // 当前实际位置
    await add(rd, "tools", tool.id, tool.entry); // 若将来改成不带 `..` 的 resources
  } catch {
    // 非桌面构建下取不到资源目录
  }
  try {
    await add(await appDataDir(), "tools", tool.id, tool.entry); // 用户自己丢的工具
  } catch {
    // 同上
  }
  return out;
}

/**
 * 解析工具的入口 URL。
 *
 * 桌面端：先按候选路径逐个探测文件是否存在，再用 asset 协议指向它。
 * 浏览器端：`tools/` 就在工程根目录下，dev server 会把它当静态资源直接服务，
 *   所以返回同源的 /tools/<id>/<entry> 即可 —— 开发时工具就真的嵌进来了，
 *   不必等到打包才能看到效果。
 *   生产构建由 vite.config.ts 的 workbenchTools 插件把 tools/ 复制到 dist/。
 */
export async function resolveToolUrl(tool: ToolManifest): Promise<string | null> {
  if (!isTauri()) {
    // BASE_URL 保证部署在子路径下时也拼得对
    const base = import.meta.env.BASE_URL || "/";
    return `${base.replace(/\/$/, "")}/tools/${tool.id}/${tool.entry}`;
  }
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const fs = await import("@tauri-apps/plugin-fs");

    const candidates = await desktopToolCandidates(tool);
    lastCandidates = candidates;
    if (candidates.length === 0) return null;

    for (const p of candidates) {
      try {
        if (await fs.exists(p)) return convertFileSrc(p);
      } catch {
        // 探测失败当作不存在，继续看下一个候选
      }
    }

    // 一个都不存在：返回 null，而不是「指向空气的 URL」。
    // 指向不存在的文件只会得到一个白屏 iframe，而白屏是最没有信息量的反馈；
    // 返回 null 后上层能把「找过哪些位置」显示出来。
    return null;
  } catch {
    return null;
  }
}

/**
 * 生成工具私有表名。
 * 强制加前缀，让工具表在同一个库里天然分区，卸载工具时便于清理。
 */
export function toolTable(toolId: string, table: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(toolId)) {
    throw new Error(`非法的工具 id: ${toolId}`);
  }
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(table)) {
    throw new Error(`非法的表名: ${table}`);
  }
  return `tool_${toolId.replace(/-/g, "_")}_${table}`;
}
