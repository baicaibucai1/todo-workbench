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
import { loadBundledTools, normalizeActions, normalizeSkill, validateManifest } from "./tools";
import { CAPABILITY_NAMES } from "./extensions/registry";
import { normalizeInjects } from "./extensions/types";
import { validateToolSchema } from "./toolSchema";
import { listZip, readZipEntry, safeRelPath } from "./toolZip";
import type { ToolManifest } from "../types";

/** 单文件工具的体积上限 */
export const HTML_MAX_BYTES = 8 * 1024 * 1024;

/** 工具包（zip）的体积上限，与 Rust 侧 toolpkg.rs 的 HARD_MAX_BYTES 对齐 */
export const ZIP_MAX_BYTES = 512 * 1024 * 1024;
/** 一个包里最多装多少个文件 —— 防的是"压缩包炸弹"，不是正常工具 */
export const ZIP_MAX_FILES = 4000;

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
  /**
   * 数据表声明。
   *
   * 导入界面仍然不暴露这个字段（还没设计出不给用户添堵的填法），
   * 但**它现在有真实的调用方**：内置 AI 助手的 install_tool / bind_database
   * 会带着一份 schema 进来 —— 那正是"不给用户添堵的填法"：
   * 用户说"我要记加班时长"，助手把表和界面一起写出来。
   */
  schema?: ToolManifest["schema"];
  /**
   * 要申请的宿主能力（gallery / task 等）。
   *
   * **按白名单过滤**：manifest 是外部输入，写什么都敢往上写。认不出来的名字
   * 当场丢掉，宿主便永远不会去判断一个自己不认识的"能力"。
   */
  capabilities?: string[];
  /** 要嵌进宿主界面的位置（注入组件）。同样是外部输入，走 normalizeInjects */
  injects?: unknown;
  /**
   * 注册给助手的动作（外部输入，走 normalizeActions）。
   *
   * 有了它，助手装完这个工具**立刻就能驱动它** —— 不必等用户打开，
   * 也不必自己拼命令名。它和 schema / capabilities 一样是"声明"：
   * 写在 manifest 里，由宿主读，源码里必须真的监听 `tool:command` 才作数。
   */
  actions?: unknown;
  /** 允许宿主在它没打开时起隐藏实例执行动作吗。默认关，见 types.ts 的 headless */
  headless?: boolean;
  /** 自带的使用说明（外部输入，走 normalizeSkill） */
  skill?: unknown;
  /** 作者。默认「导入」；AI 助手造的工具记「AI 助手」，出处要能查 */
  author?: string;
  dbVersion?: number;
}): ToolManifest {
  const schema = validateToolSchema(input.id.trim(), input.schema);
  const caps = (input.capabilities ?? [])
    .map((c) => String(c).trim())
    .filter((c) => (CAPABILITY_NAMES as string[]).includes(c));
  const injects = normalizeInjects(input.injects);
  const actions = normalizeActions(input.actions);
  const skill = normalizeSkill(input.skill, input.name.trim());
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    version: (input.version ?? "1.0.0").trim() || "1.0.0",
    description: input.description?.trim() || undefined,
    icon: input.icon?.trim() || "package",
    entry: input.entry ?? "index.html",
    dbVersion: Math.max(1, Math.floor(input.dbVersion ?? 1)),
    author: input.author?.trim() || "导入",
    source: "user",
    // 校验不通过就整份丢掉：宁可"这个工具没有表"，也不要一个半截可用的 schema
    ...(schema ? { schema } : {}),
    ...(caps.length ? { capabilities: caps } : {}),
    ...(injects.length ? { injects } : {}),
    ...(actions.length ? { actions } : {}),
    ...(input.headless === true ? { headless: true } : {}),
    ...(skill ? { skill } : {}),
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
 *
 * `overwrite` 是给内置 AI 助手用的：用户说"把那个工具改一下"时，
 * 它要能就地更新。**默认不开** —— 界面上手动导入时覆盖是不可逆的，
 * 而用户点「安装」时心里想的是"装一个新的"。
 */
export async function installFromHtml(input: {
  html: string;
  id: string;
  name: string;
  description?: string;
  icon?: string;
  /** 数据表声明。校验不过会被丢掉（调用方要自查，见 lib/agent/actions.ts） */
  schema?: ToolManifest["schema"];
  /** 宿主能力申请。按白名单过滤（见 buildManifest） */
  capabilities?: string[];
  /** 注入位置声明。外部输入，走 normalizeInjects */
  injects?: unknown;
  author?: string;
  /** 已存在同名工具时覆盖它。默认 false（报错而不是覆盖） */
  overwrite?: boolean;
}): Promise<{ manifest: ToolManifest; replaced: boolean }> {
  if (!canInstallTools()) throw new Error("浏览器演示模式无法安装工具，请在桌面版里操作");

  const html = input.html ?? "";
  if (!html.trim()) throw new Error("文件是空的");
  if (new TextEncoder().encode(html).length > HTML_MAX_BYTES) {
    throw new Error(`文件超过 ${Math.round(HTML_MAX_BYTES / 1024 / 1024)} MB 上限`);
  }
  if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
    throw new Error("这看起来不是一个 HTML 文件（里面没有 <html> 或 <body>）");
  }

  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const dir = await toolDir(input.id.trim());

  // 目录已存在：默认停手。用户数据区里可能躺着同一 id 的老工具
  // （甚至是本地改过的内置工具副本），覆盖是不可逆的。
  const exists = await fs.exists(dir);
  let replaced = false;
  if (exists) {
    if (!input.overwrite) {
      throw new Error(
        `已经存在 id 为「${input.id.trim()}」的工具目录，换个 id 或先卸载它`,
      );
    }
    replaced = true;
  }

  // 覆盖时 dbVersion 要算准：宿主按它决定要不要重跑建表。
  //   · 新声明和旧声明一样 → 保持原版本号（不重跑，避免无谓的 DDL）
  //   · 声明变了（或从无到有）→ +1（重跑 DDL；已存在的表不会被改列，
  //     这点写在 skills/data-binding 里，界面上也会提示）
  const prev = exists ? await readInstalledManifest(input.id.trim()) : null;
  let dbVersion = 1;
  if (prev?.schema) {
    const changed = JSON.stringify(prev.schema) !== JSON.stringify(input.schema ?? null);
    dbVersion = changed ? prev.dbVersion + 1 : prev.dbVersion;
  }

  const manifest = buildManifest({ ...input, dbVersion });

  const bad = checkToolId(manifest.id, replaced ? [] : []);
  if (bad) throw new Error(bad);

  const { root } = await paths();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeTextFile(await join(dir, "index.html"), html);
  await fs.writeTextFile(await join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifest, replaced };
}

/* ------------------------------------------------------------------ */
/* 工具包（.zip）                                                       */
/* ------------------------------------------------------------------ */

/**
 * 一个 zip 里识别出来的一个工具。
 *
 * 识别办法是**找 manifest.json**：它所在的那层目录就是一个工具的根。
 * 这样同一个包既能装一个工具（`mytool/manifest.json`），也能装一整个工具包
 * （Release 上那份 `tools/image-crop/manifest.json` + `tools/notes/...`）——
 * 后者正是"用一个包把全部工具更新一遍"要的形状。
 */
export interface ZipToolPlan {
  /** 包内这个工具的根目录；"" 表示就在包根 */
  root: string;
  /** 包里自带的 manifest（外部输入，已过滤）；没有则为 null */
  manifest: ToolManifest | null;
  /** 建议的 id（来自 manifest，没有 manifest 时取目录名） */
  id: string;
  name: string;
  version: string;
  /** 要落盘的文件（相对 root 的路径） */
  files: string[];
  /** 已经装着的同一个 id —— 非 null 表示这次是**更新** */
  replacing: ToolManifest | null;
  /** 非空表示这条装不了，值是不能装的原因 */
  error: string;
}

/**
 * 看一眼 zip 里有什么，**不动磁盘**。
 *
 * 先给人看清楚"这会装/更新哪几个"，再让他点确认 —— 工具 id 会变成私有表的
 * 表名前缀，覆盖又是不可逆的，让人过一眼比"先装了再说"省事。
 */
export async function planZipInstall(buf: ArrayBuffer): Promise<{
  tools: ZipToolPlan[];
  /** 被挡掉的包内路径（路径穿越之类的），界面要报出来 */
  skipped: string[];
}> {
  const entries = listZip(buf).filter((e) => !e.dir);
  if (entries.length > ZIP_MAX_FILES) {
    throw new Error(`这个包里有 ${entries.length} 个文件，超过 ${ZIP_MAX_FILES} 个上限`);
  }

  const skipped: string[] = [];
  const byPath = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    // 路径穿越 / 盘符 / 反斜杠一律拒绝：不能往工具目录之外写
    const rel = safeRelPath(e.name);
    if (!rel) {
      skipped.push(e.name);
      continue;
    }
    byPath.set(rel, e);
  }

  const roots = [...byPath.keys()]
    .filter((p) => p === "manifest.json" || p.endsWith("/manifest.json"))
    .map((p) => (p === "manifest.json" ? "" : p.slice(0, -"/manifest.json".length)))
    .sort();
  // 一个 manifest 都没有 → 整个包当一个工具（后面会让用户填 id 与名称）
  const dirs = roots.length ? roots : [""];

  const tools: ZipToolPlan[] = [];
  for (const root of dirs) {
    const prefix = root ? `${root}/` : "";
    const files = [...byPath.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .filter((p) => p.length > 0);

    let manifest: ToolManifest | null = null;
    if (byPath.has(`${prefix}manifest.json`)) {
      try {
        const raw = await readZipEntry(buf, byPath.get(`${prefix}manifest.json`)!);
        manifest = validateManifest(JSON.parse(new TextDecoder().decode(raw)));
      } catch {
        // manifest 坏了不算致命：下面按"没有 manifest"处理，让用户自己填 id
        manifest = null;
      }
    }

    const base = root ? root.split("/").pop() || "" : "";
    const rawId = manifest?.id || base;
    const idOk = /^[a-z][a-z0-9-]{1,31}$/.test(rawId);

    let replacing: ToolManifest | null = null;
    if (idOk && isTauri()) replacing = await readInstalledManifest(rawId);

    let error = "";
    if (!idOk) {
      error = manifest
        ? `包里这个工具的 id「${rawId}」不合法（只能用小写字母、数字和连字符，以字母开头，长度 2-32）`
        : `这个包里没有 manifest.json，也说不出工具 id（目录名「${base}」不合规则）—— 请手工指定 id`;
    }
    if (!files.some((f) => /\.html?$/i.test(f))) {
      error = error || `这个包里没有 HTML 入口文件（找到 ${files.length} 个文件，都不是 .html）`;
    }

    tools.push({
      root,
      manifest,
      id: rawId,
      name: manifest?.name || base || "未命名工具",
      version: manifest?.version || "0.0.0",
      files,
      replacing,
      error,
    });
  }

  return { tools, skipped };
}

/**
 * 把 zip 里的工具装进来（或就地更新）。
 *
 * 覆盖的写法是**先写新的、再删多余的**，不是"先删再写"：
 * 中途失败时前者留下的是"新旧混合"，后者留下的是"工具没了"。
 * 对一个正在用的工具来说，后者才是真的糟糕。
 *
 * @param fallback 包里没有 manifest 时用它补一份（id / 名称 / 图标 / 说明）
 */
export async function installFromZip(input: {
  zip: ArrayBuffer;
  /** 已存在同 id 的工具时就地更新。默认 false —— 覆盖不可逆 */
  overwrite?: boolean;
  fallback?: { id?: string; name?: string; icon?: string; description?: string };
  /**
   * 强制装到这个 id（界面上点某个工具的「更新」时用）。
   *
   * 存在的理由：包里的 manifest 写的 id 未必跟用户想更新的那个一致
   * （换个打包工具、改过一次 id 都会这样）。不强制的话会变成"装了一个新的，
   * 旧的还在" —— 用户点了更新，却什么都没更新。
   */
  forceId?: string;
}): Promise<{ installed: ToolManifest[]; updated: ToolManifest[] }> {
  if (!canInstallTools()) throw new Error("浏览器演示模式无法安装工具，请在桌面版里操作");
  if (input.zip.byteLength > ZIP_MAX_BYTES) {
    throw new Error(`包有 ${(input.zip.byteLength / 1024 / 1024).toFixed(1)} MB，超过 ${ZIP_MAX_BYTES / 1024 / 1024} MB 上限`);
  }

  const plan = await planZipInstall(input.zip);
  if (!plan.tools.length) throw new Error("这个压缩包里没找到可以装的工具（需要有 manifest.json，或至少一个 HTML 入口）");
  if (input.forceId && plan.tools.length !== 1) {
    throw new Error(
      `这个包里有 ${plan.tools.length} 个工具，没法整体更新到「${input.forceId}」—— 请用「选择 .zip 工具包」安装`,
    );
  }

  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const { root } = await paths();
  await fs.mkdir(root, { recursive: true });
  /** 包内路径 → 条目。整包只解析一次，循环里复用 */
  const entries = await planEntries(input.zip);

  const installed: ToolManifest[] = [];
  const updated: ToolManifest[] = [];

  for (const t of plan.tools) {
    if (t.error && !(t.root === "" && input.fallback?.id)) {
      throw new Error(t.error);
    }

    const id = (t.manifest?.id || t.id || input.fallback?.id || "").trim();
    const bad = /^[a-z][a-z0-9-]{1,31}$/.test(id)
      ? null
      : "id 只能用小写字母、数字和连字符，以字母开头，长度 2-32";
    if (bad) {
      // 包里没有 manifest 时，用用户在界面上填的那个 id
      const fb = (input.fallback?.id || "").trim();
      if (!fb) throw new Error(bad);
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(fb)) throw new Error(bad);
    }
    const finalId = input.forceId
      ? input.forceId.trim()
      : /^[a-z][a-z0-9-]{1,31}$/.test(id)
        ? id
        : (input.fallback?.id || "").trim();

    const dir = await toolDir(finalId);
    const replacing = await readInstalledManifest(finalId);
    if (replacing && !input.overwrite) {
      throw new Error(`已经存在 id 为「${finalId}」的工具，要更新它请勾上「覆盖已有工具」`);
    }

    const prefix = t.root ? `${t.root}/` : "";
    await fs.mkdir(dir, { recursive: true });
    for (const rel of t.files) {
      // 条目表只解析一次（在循环外）—— 放在这里是 O(文件数 × 包条目数)，
      // 一个带 50MB 模型目录的包会慢到像卡死
      const entry = entries.get(prefix + rel);
      if (!entry) continue;
      const data = await readZipEntry(input.zip, entry);
      const out = await join(dir, ...rel.split("/"));
      const parent = out.split(/[\\/]/).slice(0, -1).join("\\");
      if (parent) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(out, data);
    }

    // 删掉"上一版有、这一版没有"的文件。不做的话改版删掉的资源会一直躺着，
    // 而界面上完全看不出它还在（工具内部引用它时才会炸，那时已经很难查）
    const keep = new Set(t.files.map((f) => f.replace(/\//g, "\\")));
    for (const stale of await listFilesRecursively(dir)) {
      if (!keep.has(stale)) {
        await fs.remove(await join(dir, ...stale.split("\\")), { recursive: false }).catch(() => {});
      }
    }

    // manifest：包里有就用包里的（它是作者写的），否则按界面上填的补一份。
    // dbVersion 与 installFromHtml 同一套规则：schema 变了才 +1
    let manifest = t.manifest;
    if (!manifest) {
      manifest = buildManifest({
        id: finalId,
        name: input.fallback?.name?.trim() || t.name,
        description: input.fallback?.description,
        icon: input.fallback?.icon,
        author: "导入",
      });
    }
    const prev = replacing;
    let dbVersion = manifest.dbVersion ?? 1;
    if (prev?.schema) {
      const changed = JSON.stringify(prev.schema) !== JSON.stringify(manifest.schema ?? null);
      dbVersion = changed ? prev.dbVersion + 1 : prev.dbVersion;
    }
    manifest = { ...manifest, id: finalId, dbVersion };

    await fs.writeTextFile(await join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    (replacing ? updated : installed).push(manifest);
  }

  return { installed, updated };
}

/** planZipInstall 用的条目表（name → entry），这里再取一次以免重复解压 */
async function planEntries(buf: ArrayBuffer) {
  const map = new Map<string, ReturnType<typeof listZip>[number]>();
  for (const e of listZip(buf)) {
    if (e.dir) continue;
    const rel = safeRelPath(e.name);
    if (rel) map.set(rel, e);
  }
  return map;
}

/** 列出目录下的全部文件（相对路径，分隔符统一成 \），给"删多余文件"用 */
async function listFilesRecursively(dir: string): Promise<string[]> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await fs.readDir(rel ? await join(dir, rel) : dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}\\${e.name}` : e.name;
      if (e.isDirectory) await walk(child);
      else out.push(child);
    }
  };
  await walk("");
  return out;
}

/* ------------------------------------------------------------------ */
/* 从网址安装                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把一个网址指向的工具**源**下载下来（zip 或单个 HTML），不落库。
 *
 * 下载本身在 Rust（toolpkg::tool_download）做 —— webview 里的 fetch 受 CORS
 * 约束，而工具包挂在 Release 上，给不给跨域头不由我们决定。
 *
 * 为什么是「先下载、后确认」而不是「确认后边下边装」：
 * 网址指向什么在下载之前是未知数 —— 只有拿到手才能知道它是 zip（能看到包里
 * 有哪几个工具）还是 HTML（能扫出外部引用、能不能自包含）。这些都必须
 * **在用户按下「安装」之前**摆到台面上，否则就是 2026-10-12 那次事故：
 * 装完才发现是个整站网页，界面一片狼藉，用户以为是我们坏了。
 */
export async function downloadToolSource(
  url: string,
): Promise<{ kind: "zip"; bytes: ArrayBuffer } | { kind: "html"; text: string }> {
  if (!canInstallTools()) throw new Error("浏览器演示模式无法安装工具，请在桌面版里操作");

  const u = (url ?? "").trim();
  if (!u) throw new Error("先填一个网址");
  if (!/^https?:\/\//i.test(u)) throw new Error("只支持 http / https 开头的网址");

  const { invoke } = await import("@tauri-apps/api/core");
  const tempPath = (await invoke("tool_download", {
    url: u,
    maxBytes: ZIP_MAX_BYTES,
  })) as string;

  const fs = await import("@tauri-apps/plugin-fs");
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(tempPath);
  } finally {
    // 临时文件一定要删：它在 <appData>/tools/.incoming/ 下，
    // 留着就是一堆没人认领的几十兆
    await fs.remove(tempPath).catch(() => {});
  }

  // 按魔术字节判断类型，不看扩展名 —— 地址末尾常常是 ?download=1 之类的东西
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isZip) {
    return {
      kind: "zip",
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  if (!/<html[\s>]/i.test(text) && !/<body[\s>]/i.test(text)) {
    throw new Error("下载下来的既不是 zip 也不是 HTML —— 确认这个地址指向的是工具包或单个 HTML 文件");
  }
  return { kind: "html", text };
}

/**
 * 子资源抓取器：给「安装时内联外部资源」（toolInline.ts）用的底层。
 *
 * 走 Rust 的 tool_fetch（浏览器 UA + Referer），防盗链才拦不住；
 * 字节落在 .incoming 临时文件里，读完就删 —— 与 tool_download 同一套规矩。
 */
export function toolSubresourceFetcher(): import("./toolInline").SubResourceFetcher {
  return async (url, referer) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const fs = await import("@tauri-apps/plugin-fs");
    const [path, contentType] = await invoke<[string, string]>("tool_fetch", {
      url,
      referer,
      maxBytes: 6 * 1024 * 1024,
    });
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(path);
    } finally {
      await fs.remove(path).catch(() => {});
    }
    return { bytes, contentType };
  };
}

/* ---------------------------- 磁盘上的 manifest ---------------------------- */

/**
 * 读用户数据区里某个工具的 manifest.json。
 *
 * 存在的理由：**注册表里的 manifest 是扫描时的快照**，而"给工具绑数据表"
 * 要改的是磁盘上的那份 —— 改写必须以磁盘现状为基准，否则会把扫描之后
 * 别人（或另一个会话）写的改动覆盖掉。
 *
 * 读不到就是 null，不抛错：工具不存在、manifest 坏了、没权限，对调用方
 * 来说都是"这份用不了"，由它决定怎么说话。
 */
export async function readInstalledManifest(id: string): Promise<ToolManifest | null> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const file = await join(await toolDir(id), "manifest.json");
    if (!(await fs.exists(file))) return null;
    return validateManifest(JSON.parse(await fs.readTextFile(file)));
  } catch {
    return null;
  }
}

/**
 * 改写用户数据区里某个工具的 manifest.json。
 *
 * 只给「绑定数据表」用（见 lib/agent/actions.ts），所以它守着两条：
 *   1. 工具必须已经存在（不新建目录 —— 新建是 installFromHtml 的事）
 *   2. **只改 schema 与 dbVersion**，其余字段原样保留（用户自己改过的名字、
 *      说明、版本号都得留着；整份重写等于把他的修改抹平）
 */
export async function writeToolSchema(
  id: string,
  schema: ToolManifest["schema"],
): Promise<ToolManifest> {
  if (!canInstallTools()) throw new Error("浏览器演示模式无法改写工具文件，请在桌面版里操作");

  const prev = await readInstalledManifest(id);
  if (!prev) throw new Error(`工具目录里没有「${id}」的 manifest.json`);

  const next: ToolManifest = {
    ...prev,
    ...(schema ? { schema } : {}),
    dbVersion: schema ? (prev.schema ? prev.dbVersion + 1 : 1) : prev.dbVersion,
  };

  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  await fs.writeTextFile(
    await join(await toolDir(id), "manifest.json"),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
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
    return `已卸载「${tool.name}」；它随安装包分发，可以随时重新安装。它存的数据会留在库里（设置 → 数据库 可清理）`;
  }

  // 用户自己的工具：如果它恰好也在卸载清单里（曾经是内置工具、被卸载后
  // 用户又用同一个 id 导入了一个），把那一笔清掉，否则新装的那个
  // 会在下次启动被同步逻辑重新补上
  const set = await readUninstalled();
  if (set.delete(tool.id)) await writeUninstalled(set);
  return `已删除自己导入的工具「${tool.name}」（文件已删除，无法恢复）。它存的数据会留在库里（设置 → 数据库 可清理）`;
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
