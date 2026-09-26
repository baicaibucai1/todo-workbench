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
 * 装载永远是**两次扫描**：只认磁盘上真实存在的工具目录
 *
 *   1. 用户数据区 <appDataDir>/tools/  —— 用户解压进去的、或自己丢进去的工具
 *   2. 安装包内 <resources>/tools/     —— 随安装包分发的内置工具
 *      （0.2.0 起**默认一个都没有**：安装包不再携带工具，见文末。）
 *
 * 关键设计：工具目录放在用户数据区而不是安装包内，
 * 这样新增工具不需要重新打包发版 —— 这正是"可更新"的一部分。
 *
 * ------------------------------------------------------------------
 * 安装包为什么不带工具了
 * ------------------------------------------------------------------
 * tools/ 里有 50 MB 的抠图模型（image-crop/ai，base64 分片塞在 .js 里）。
 * 把它写进 bundle.resources，每一个用户的每一次增量更新，都要为他可能根本
 * 用不到的那个工具下载几十兆 —— 而"工具可插拔"这件事本来就要求宿主不关心
 * 工具是从哪来的，放不进安装包从来不影响它能不能用。
 *
 * 所以 0.2.0 起：安装包本体不含任何工具文件，工具单独打成 zip 挂在同一份
 * Release 上（scripts/pack-tools.mjs），想要就下载解压；或者让内置助手现写一个。
 *
 * 由此带来一条硬约束，见 loadTools：**桌面端绝不能拿 BUILTIN_TOOLS 兜底**。
 * 否则新装的桌面版会列出五个点开就是"找不到入口"的工具 —— 侧边栏里看着有，
 * 实际打不开，比直接显示一个空列表糟糕得多。
 */

import { isTauri } from "./db";
import { validateToolSchema } from "./toolSchema";
import { CAPABILITY_NAMES } from "./extensions/registry";
import { normalizeInjects } from "./extensions/types";
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
    // 它要把裁好的图存进图库 —— 那是**不属于自己**的共享资源，
    // 所以必须申请；宿主据此决定放不放行（见 extensions/registry 的能力门）
    capabilities: ["gallery"],
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
    capabilities: ["gallery"],
  },
  {
    // 它是「一个网页工具怎么用宿主的数据表」的样板：manifest 里声明 schema，
    // 用结构化 CRUD 读写自己的 tool_scratchpad_notes，并能把一条内容交给别的工具。
    // 存在它，是为了让这套机制**有一个端到端跑起来的实例** —— 否则它只是文档。
    id: "scratchpad",
    name: "随手记",
    version: "1.0.0",
    description:
      "跑在工作台数据库里的便签本：增删改查自己的一张表，还能把内容交给别的工具。这也是「工具怎么用自己的数据表」的样板",
    icon: "notebook-pen",
    entry: "index.html",
    dbVersion: 1,
    author: "内置",
    schema: {
      tables: [
        {
          name: "notes",
          columns: [
            { name: "id", type: "text", pk: true },
            { name: "title", type: "text" },
            { name: "body", type: "text" },
            { name: "tag", type: "text" },
            { name: "created_at", type: "text" },
          ],
          indexes: [{ columns: ["created_at"] }],
        },
      ],
    },
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
    capabilities: ["gallery"],
  },
  // 这里**没有五子棋**，是故意的。
  //
  // 它是《单 HTML 工具编写标准》的活样本，当初为了验证「AI 能不能自己写出
  // 合格的工具」而生成，从来不是要发给用户的功能。tools/ 下每多一个目录，
  // 工具包 zip 就多一份、设置页就多一行 —— 一份开发样本摆在那儿，等于让
  // 每个用户都收到一个他没要过的东西。
  //
  // 所以它搬去了 tests/fixtures/gomoku/（2026-09-24）：不进工具包、不进设置页，
  // 但契约测试照跑（npm run gomoku:test，59 项断言把标准逐条钉死）。
  // 标准写在文档里会漂，钉在测试上才不会 —— 只是那份测试现在明确指向夹具目录。
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
    // schema 单独走一套校验（见 toolSchema.validateToolSchema）：它会被拼进 DDL，
    // 要求比普通字段严得多。**校验不通过就整个丢掉**，而不是留一半 ——
    // 工具因此只是"没有私有表"，row.* 会明确报出来，不会变成半残的可写状态。
    ...(() => {
      const schema = validateToolSchema(id, m.schema);
      return schema ? { schema } : {};
    })(),
    // 能力申请：要碰**不属于自己**的共享资源（目前只有图库）就得在这里写明。
    // 按白名单过滤，写什么奇奇怪怪的名字都会被丢掉；没写就是没有。
    ...(() => {
      const caps = (Array.isArray(m.capabilities) ? m.capabilities : []).filter((c): c is string =>
        typeof c === "string" && (CAPABILITY_NAMES as string[]).includes(c),
      );
      return caps.length ? { capabilities: caps } : {};
    })(),
    // 注入组件的挂载声明。同样是外部输入：只认白名单里的三个位置，
    // 认不出来的一律丢掉（见 extensions/types.ts 的 normalizeInjects）。
    ...(() => {
      const injects = normalizeInjects(m.injects);
      return injects.length ? { injects } : {};
    })(),
    // 命令声明：助手驱动它干活时可用的动作名。同样是外部输入，
    // 只认小写字母数字与连字符；没声明就是"不接受任何命令"。
    ...(() => {
      const cmds = normalizeCommands(m.commands);
      return cmds.length ? { commands: cmds } : {};
    })(),
  };
}

/** 命令名白名单。与 injects 同样的道理：认不出来的一律丢掉 */
export function normalizeCommands(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== "string") continue;
    const v = c.trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 12);
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
 *
 * 注意 `user` 的含义：**不是"在用户目录里的"**，而是"不在安装包里的"。
 * Rust 侧启动时会把内置工具复制到用户数据区（见 src-tauri/src/lib.rs 的
 * sync_builtin_tools），所以桌面端每个内置工具都同时存在于两处 ——
 * 若按目录位置分类，内置工具的 source 会全变成 user，卸载按钮就会出现，
 * 而用户点下去删掉的其实是内置工具的本地副本，升级时又会被装回来。
 * 判定依据只能是**安装包里有没有这个 id**。
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

  const bundledIds = new Set(bundled.map((t) => t.id));
  try {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const dir = await join(await appDataDir(), "tools");
    // 用户数据区里那些**不在安装包中**的，才是用户自己的工具
    user.push(...(await scanToolsDir(dir)).filter((t) => !bundledIds.has(t.id)));
    // 工具目录的位置**无条件记下来**：哪怕现在一个工具都没有。
    // 它只在"某个工具的入口文件找不到"时显示给用户，那种场合说成
    // 「浏览器模式的清单」纯属指错方向 —— 他会去源码里找，而该看的是这个目录。
    registryLocation = dir;
  } catch {
    // appData 取不到就算了，不影响内置工具
  }

  // 来源戳在这里盖：凡出现在安装包资源里的都算 bundled
  for (const t of bundled) t.source = "bundled";
  for (const t of user) t.source = "user";

  return { bundled, user };
}

/**
 * 扫描并注册全部工具。
 *
 * 桌面端**只认磁盘上真实存在的工具** —— 这里刻意不再用 BUILTIN_TOOLS 兜底。
 * 那一手兜底原先是给"资源目录扫不出来"留的退路，但 0.2.0 起「扫不出 Tools 的
 * 内置工具」是**正常状态**而不是故障，再拿清单补上去，就成了给用户看五个
 * 打不开的入口（详见文件头）。
 *
 * 浏览器模式反过来：那份清单是它唯一的来源，而且它是真能用的 —— tools/ 就在
 * 工程根目录，dev server 直接把它当静态资源服务。
 */
export async function loadTools(): Promise<ToolManifest[]> {
  if (!isTauri()) {
    registry = BUILTIN_TOOLS.map((t) => ({ ...t, source: "bundled" as const }));
    // 夹具工具排在后面（见本文件 loadFixtureTools 的说明）：
    // 它只在 dev + 带参数时出现，正式流程里这一行是空数组
    registry.push(...(await loadFixtureTools()));
    registryLocation = "内置清单（浏览器模式）";
    return registry;
  }

  const merged = new Map<string, ToolManifest>();

  // 1. 安装包内的工具（现在通常是空的一组）
  const { bundled, user } = await scanTauriTools();
  for (const t of bundled) merged.set(t.id, t);

  // 2. 用户数据区的工具（优先级最高，可覆盖同 id 的内置工具）
  for (const t of user) merged.set(t.id, t);

  registry = [...merged.values()];
  return registry;
}

export function listTools(): ToolManifest[] {
  return registry;
}

/**
 * 安装包里有哪些工具 —— 不管它们有没有被装到用户数据区。
 *
 * 存在的理由只有一个：内置工具被卸载之后就从注册表消失了，设置页也就
 * 再也列不出它，用户没有入口把它装回来。所以"可重装清单"必须另取一份。
 *
 * 桌面端**照实返回**，扫不到就是空数组：安装包现在已经不带工具，「安装包里
 * 有什么」这个问题常常的答案就是「没有」。以前在这里补 BUILTIN_TOOLS，会让设置页
 * 摆出五个「重新安装」按钮，而点下去必然是 reinstallBundledTool 的一句
 * 「安装包里找不到这个工具的文件」—— 一个注定报错的按钮比没有按钮更糟。
 *
 * 浏览器模式没有安装包，退化成内置清单（那份就是这里的"安装包"）。
 */
export async function loadBundledTools(): Promise<ToolManifest[]> {
  if (!isTauri()) return BUILTIN_TOOLS.map((t) => ({ ...t, source: "bundled" as const }));
  const { bundled } = await scanTauriTools();
  return bundled;
}

export function getTool(id: string): ToolManifest | undefined {
  return registry.find((t) => t.id === id);
}

/**
 * 过滤出当前启用的工具。
 *
 * 被停用的工具**仍然留在注册表里**（设置页要列出它们、要能重新启用），
 * 只是不进侧边栏、不参与工具区的挂载。
 */
export function filterEnabled(tools: ToolManifest[], disabled: Set<string>): ToolManifest[] {
  return tools.filter((t) => !disabled.has(t.id));
}

/**
 * 取"当前真正该显示的那个工具"。
 *
 * 单独抽出来是因为 App 与工具区都要做同一个判断：`activeToolId` 指向的
 * 工具可能已经被停用或卸载了，那时两边必须同时认为"没有工具在显示"——
 * 各写一遍 `tools.find(...)` 迟早会漂移成一边显示空白、一边显示待办。
 */
export function pickActiveTool(
  tools: ToolManifest[],
  activeToolId: string | null,
): ToolManifest | null {
  if (!activeToolId) return null;
  return tools.find((t) => t.id === activeToolId) ?? null;
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
/* ------------------------------------------------------------------ */
/* 测试夹具（仅开发模式）                                              */
/* ------------------------------------------------------------------ */

/**
 * 夹具工具的入口地址覆盖表。
 *
 * 存在的理由：浏览器演示模式**装不了工具**（没有可写的文件系统），
 * 于是"工具注入到宿主界面"这件事在浏览器里根本没有可注入的对象 ——
 * 而 20 个 e2e 套件全跑在浏览器里。
 *
 * 做法：`?fixtureTools=1` 时把 tests/fixtures/tools/ 下的夹具灌进注册表，
 * 入口地址直接指向夹具目录（`tools/<id>/` 下并没有它的文件）。
 *
 * 三重闸门，少一道都不行：
 *   · `import.meta.env.DEV` —— 打包后这段整段不成立
 *   · 必须显式带 `?fixtureTools=1` —— 开发时默认也不出现
 *   · 只在浏览器模式（桌面端走真实目录）
 * 所以用户永远看不到它，设置页也不会列出它。
 */
const fixtureUrls = new Map<string, string>();

function registerFixtureUrl(id: string, url: string): void {
  fixtureUrls.set(id, url);
}

/**
 * 解析 `?fixtureTools=` 的值：
 *   `undefined` —— 根本没带这个参数，一个夹具都不加载
 *   `null`      —— `1` / `all`，全部加载
 *   `Set`       —— 逗号分隔的 id 白名单
 *
 * 为什么要有白名单这一档：有的断言是"详情面板底部出现了 **1 个**注入分区"
 * （agent-sandbox.mjs），夹具一多就变成 2 个、测试假红。让套件点名要哪几个，
 * 比让所有夹具一起上、再回去改断言里的数字要好。
 */
function fixtureFilter(): Set<string> | null | undefined {
  if (typeof location === "undefined") return undefined;
  const m = /[?&]fixtureTools=([^&]*)/.exec(location.search);
  if (!m) return undefined;
  const v = decodeURIComponent(m[1]).trim();
  if (!v || v === "1" || v === "all") return null;
  return new Set(
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function loadFixtureTools(): Promise<ToolManifest[]> {
  // 不能写 `import.meta.env.DEV`：单测把源码用 esbuild 打成 Node bundle 跑，
  // 那里的 import.meta 上没有 env —— 直接取会 TypeError，整个套件当场崩。
  // 所以取成"可选"：取不到就是非开发环境，正是我们要的默认。
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (!env?.DEV) return [];
  const filter = fixtureFilter();
  if (filter === undefined) return [];
  try {
    const res = await fetch("/tests/fixtures/tools/index.json");
    if (!res.ok) return [];
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: ToolManifest[] = [];
    for (const item of raw) {
      const m = validateManifest(item);
      if (!m) continue;
      if (filter && !filter.has(m.id)) continue;
      registerFixtureUrl(m.id, `/tests/fixtures/tools/${m.id}/${m.entry}`);
      out.push(m);
    }
    return out;
  } catch {
    // 夹具读不到就当作没有 —— 正式开发流程里这才是常态
    return [];
  }
}

export async function resolveToolUrl(tool: ToolManifest): Promise<string | null> {
  const fixture = fixtureUrls.get(tool.id);
  if (fixture) return fixture;
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
 * 工具私有表的**前缀**，如 `tool_image_crop_`。
 *
 * 单独抽成一个函数，是因为"前缀怎么拼"这件事有四个地方要知道
 * （建表、清理、数据库分区枚举、推给工具的上下文），而它们各写一遍
 * 迟早会漂移成两套规则 —— 那正是本项目最常犯的那类错。
 */
export function toolPrefix(toolId: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(toolId)) {
    throw new Error(`非法的工具 id: ${toolId}`);
  }
  return `tool_${toolId.replace(/-/g, "_")}_`;
}

/**
 * 生成工具私有表名。
 * 强制加前缀，让工具表在同一个库里天然分区，卸载工具时便于清理。
 */
export function toolTable(toolId: string, table: string): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(table)) {
    throw new Error(`非法的表名: ${table}`);
  }
  return toolPrefix(toolId) + table;
}
