/**
 * 工具的安装 / 卸载。
 *
 * 工具的存放规则在 lib/tools.ts 的文件头已经写过：工具是**用户数据区的目录**，
 * 不是为了加工具就得重新发版才这么设计的。这个文件负责补齐最后一块 ——
 * 让用户能在界面上把工具装进来、卸下去。
 *
 * ------------------------------------------------------------------
 * 三种状态，别混为一谈
 * ------------------------------------------------------------------
 *   · 安装（install）  磁盘上有 <appData>/tools/<id>/ 这个目录
 *   · 启用（enable）   人愿意在侧边栏看到它 —— 记在设置里，见 settings.ts
 *   · 挂载（mount）    此刻正跑在工具区里（见 store 的 aliveToolIds）
 *
 * 停用不删文件、卸载不碰设置：两个维度正交。用户停用一个工具是"先别烦我"，
 * 卸载是"我不要了"，把后者做成前者的副作用，用户下次就找不到它了。
 *
 * ------------------------------------------------------------------
 * 内置工具的卸载为什么要多一个清单文件
 * ------------------------------------------------------------------
 * 内置工具（随安装包分发）在启动时会被 Rust 侧同步到用户数据区
 * （src-tauri/src/lib.rs 的 sync_builtin_tools），这是「新增工具不必重新
 * 打包发版」的技术前提。但它带来一个直接后果：**把用户区的目录删掉，
 * 下次启动它又回来了** —— 用户会以为卸载按钮坏了。
 *
 * 所以卸载内置工具要同时做两件事：删目录 + 往 <appData>/tools/.uninstalled
 * 里记一笔，Rust 侧同步时跳过清单里的 id。这个文件是宿主与 Rust 之间的
 * 契约，用纯文本一行一个 id，方便手改也方便排查。
 *
 * 用户导入的工具不需要清单 —— 安装包里本来就没有它，删了就真没了。
 */

import { isTauri } from "./db";
import { loadBundledTools } from "./tools";
import type { ToolManifest } from "../types";

/** 单文件工具的体积上限 */
export const HTML_MAX_BYTES = 8 * 1024 * 1024;

/** 卸载记录文件名（与 Rust 侧约定的名字，改一处必须改两处） */
const UNINSTALLED_FILE = ".uninstalled";

const TOOL_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** 能不能安装工具 —— 浏览器演示模式没有可写的文件系统 */
export function canInstallTools(): boolean {
  return isTauri();
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

async function paths() {
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const root = await join(await appDataDir(), "tools");
  return { root, join };
}

/** 工具根目录 <appData>/tools */
export async function toolsRoot(): Promise<string> {
  const { root } = await paths();
  return root;
}

/** 某个工具的安装目录 */
export async function toolDir(id: string): Promise<string> {
  const { root, join } = await paths();
  return join(root, id);
}

/* ------------------------------------------------------------------ */
/* id 与 manifest                                                      */
/* ------------------------------------------------------------------ */

/**
 * 从文件名推一个建议的工具 id。
 *
 * 中文名推不出 ASCII（"尺码助手.html" → 空串），这种情况退回 `tool-<时间戳36进制>`，
 * 保证一定合法、也一定不重复。反正导入确认框里这个值是可编辑的，
 * 与其猜一个错的，不如给一个明显是"占位"的。
 *
 * @param taken 已占用的 id（会算进冲突检测，避免覆盖已有工具目录）
 */
export function suggestToolId(fileName: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const stem = String(fileName ?? "")
    .replace(/\.(html?|htm)$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  let base = stem;
  // id 必须以字母开头；纯数字或空串都要补前缀
  if (!/^[a-z]/.test(base)) base = base ? `t${base}` : "";
  // 下限 2 个字符（与 manifest 校验一致），太短的一律换成时间戳占位
  if (base.length < 2) base = `tool-${Date.now().toString(36)}`;
  base = base.slice(0, 28).replace(/-+$/, "");

  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * 校验用户填的工具 id，返回错误说明；没问题返回 null。
 *
 * 报错文案要说清"为什么不行"，因为 id 会变成工具私有表的表名前缀 ——
 * 这是安全边界（见 toolTable 的注入防护），不是风格偏好。
 */
export function checkToolId(id: string, taken: Iterable<string> = []): string | null {
  const v = (id ?? "").trim();
  if (!v) return "id 不能为空";
  if (!TOOL_ID_RE.test(v)) {
    return "只能用小写字母、数字和连字符，以字母开头，长度 2-32";
  }
  if (new Set(taken).has(v)) return `id「${v}」已被占用（换个名字，或先卸载原来那个）`;
  return null;
}

/** 组装 manifest（不落盘，便于单测） */
export function buildManifest(input: {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  version?: string;
  entry?: string;
}): ToolManifest {
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    version: (input.version ?? "1.0.0").trim() || "1.0.0",
    description: input.description?.trim() || undefined,
    icon: input.icon?.trim() || "package",
    entry: input.entry ?? "index.html",
    dbVersion: 1,
    author: "导入",
    source: "user",
  };
}

/* ------------------------------------------------------------------ */
/* 安装 / 卸载                                                         */
/* ------------------------------------------------------------------ */

/** 递归复制目录（安装包资源 → 用户数据区） */
async function copyTree(from: string, to: string): Promise<number> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");

  await fs.mkdir(to, { recursive: true });
  let n = 0;
  for (const e of await fs.readDir(from)) {
    const src = await join(from, e.name);
    const dst = await join(to, e.name);
    if (e.isDirectory) n += await copyTree(src, dst);
    else {
      await fs.copyFile(src, dst);
      n++;
    }
  }
  return n;
}

/**
 * 从一个 HTML 文件安装工具。
 *
 * 只写两个文件（index.html + manifest.json），所以**单文件工具的一切外部引用
 * 都必须是自包含的**：内联的 CSS/JS、或 data: URI。相对路径引用
 * （`src="helper.js"`）不会跟着进来 —— 桌面端工具经 asset 协议加载，
 * 相对引用本来也会被解析到站点根（见 ToolHost 里那段警告）。
 */
export async function installFromHtml(input: {
  html: string;
  id: string;
  name: string;
  description?: string;
  icon?: string;
}): Promise<ToolManifest> {
  if (!canInstallTools()) throw new Error("浏览器演示模式无法安装工具，请在桌面版里操作");

  const html = input.html ?? "";
  if (!html.trim()) throw new Error("文件是空的");
  if (new TextEncoder().encode(html).length > HTML_MAX_BYTES) {
    throw new Error(`文件超过 ${Math.round(HTML_MAX_BYTES / 1024 / 1024)} MB 上限`);
  }
  if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
    throw new Error("这看起来不是一个 HTML 文件（里面没有 <html> 或 <body>）");
  }

  const manifest = buildManifest(input);
  const bad = checkToolId(manifest.id);
  if (bad) throw new Error(bad);

  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const dir = await toolDir(manifest.id);

  // 目录已存在就停手。这里**不做覆盖**：用户数据区里可能躺着同一 id 的
  // 老工具（甚至是本地改过的内置工具副本），覆盖是不可逆的。
  if (await fs.exists(dir)) {
    throw new Error(`已经存在 id 为「${manifest.id}」的工具目录，换个 id 或先卸载它`);
  }

  const { root } = await paths();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeTextFile(await join(dir, "index.html"), html);
  await fs.writeTextFile(
    await join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return manifest;
}

/* ---------------------------- 卸载记录 ---------------------------- */

/** 读「已卸载的内置工具」清单 */
export async function readUninstalled(): Promise<Set<string>> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const { root } = await paths();
    const file = await join(root, UNINSTALLED_FILE);
    if (!(await fs.exists(file))) return new Set();
    const text = await fs.readTextFile(file);
    return new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => TOOL_ID_RE.test(l)));
  } catch {
    // 读不到就当作"没有卸载记录"—— 内置工具会照常同步，不会因为它把工具藏起来
    return new Set();
  }
}

async function writeUninstalled(ids: Set<string>): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const { root } = await paths();
  await fs.mkdir(root, { recursive: true });
  const body = [...ids].sort().join("\n");
  await fs.writeTextFile(await join(root, UNINSTALLED_FILE), body ? `${body}\n` : "");
}

/**
 * 卸载一个工具。
 *
 * 返回的字符串用于界面提示 —— 两种来源的后果不一样，必须说清楚：
 * 内置工具删了能从安装包装回来，导入的工具删了就真没了。
 */
export async function uninstallTool(tool: ToolManifest): Promise<string> {
  if (!canInstallTools()) throw new Error("浏览器演示模式无法卸载工具，请在桌面版里操作");

  const fs = await import("@tauri-apps/plugin-fs");
  const dir = await toolDir(tool.id);

  if (await fs.exists(dir)) {
    await fs.remove(dir, { recursive: true });
  }

  if (tool.source === "bundled") {
    const set = await readUninstalled();
    set.add(tool.id);
    await writeUninstalled(set);
    return `已卸载「${tool.name}」；它随安装包分发，可以随时重新安装`;
  }

  // 用户自己的工具：如果它恰好也在卸载清单里（曾经是内置工具、被卸载后
  // 用户又用同一个 id 导入了一个），把那一笔清掉，否则新装的那个
  // 会在下次启动被同步逻辑重新补上
  const set = await readUninstalled();
  if (set.delete(tool.id)) await writeUninstalled(set);
  return `已删除自己导入的工具「${tool.name}」（文件已删除，无法恢复）`;
}

/**
 * 重新安装一个被卸载的内置工具：从安装包资源复制回用户数据区。
 *
 * 不需要重启应用 —— 复制完由调用方重新扫一遍注册表即可。
 */
export async function reinstallBundledTool(id: string): Promise<void> {
  if (!canInstallTools()) throw new Error("浏览器演示模式无法安装工具，请在桌面版里操作");

  const bundled = await loadBundledTools();
  if (!bundled.some((t) => t.id === id)) {
    throw new Error(`安装包里没有「${id}」这个工具`);
  }

  const { resourceDir, join } = await import("@tauri-apps/api/path");
  const rd = await resourceDir();
  const srcCandidates = [await join(rd, "_up_", "tools", id), await join(rd, "tools", id)];

  const fs = await import("@tauri-apps/plugin-fs");
  const src = (await Promise.all(srcCandidates.map(async (p) => ((await fs.exists(p)) ? p : null)))).find(
    (p) => p !== null,
  );
  if (!src) throw new Error("安装包里找不到这个工具的文件（可能这个构建没有带上它）");

  await copyTree(src, await toolDir(id));

  const set = await readUninstalled();
  if (set.delete(id)) await writeUninstalled(set);
}
