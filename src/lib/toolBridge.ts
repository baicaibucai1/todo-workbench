/**
 * 工具 ↔ 宿主 的数据通道（postMessage 代查）。
 *
 * ToolHost 的注释里一直写着「需要数据时通过 postMessage 向宿主请求，宿主代查」，
 * 但这条通道此前并没有实现 —— 工具只能自带静态内容，拿不到任何数据。
 * 它最初是为了让「特殊单号记录」能绑定数据库而补的；那个功能后来改成了原生工单
 * （时效要跟流转绑定，塞进工具私有表就得把整套工单子系统重写一遍），
 * 但这层通道对「工具要读自己的数据」这件事仍然有效，所以留着。
 *
 * 刻意做成**受限通道**，而不是通用 SQL 代理：
 *
 *   1. 工具永远不发送完整表名，只发送**裸表名**（如 "records"），
 *      由宿主用 toolTable() 拼出 `tool_<id>_<table>`。
 *      这样工具在物理上不可能碰到 core_tasks 或别的工具的表 ——
 *      是安全边界，不是"约定"。
 *   2. 只认白名单操作（info / count / kv.*），没有任意 SQL 通道。
 *      真做登记功能时再按需加窄接口，而不是先开个口子「以后方便」。
 *   3. 回消息前校验 event.source 必须是当前 iframe 的 contentWindow，
 *      防止同页面里其他 iframe 冒充工具发请求。
 *
 * kv.* 是给工具存自己配置用的（API Key、上次选的模型、生成历史…）。
 * 同样**不接受工具传来的 tool_id** —— tool_id 由宿主从「这条消息是哪个
 * iframe 发来的」推导出来，所以工具读写不到别的工具的键。
 * 注意它和 count 的区别：count 碰的是工具**私有表**，kv 碰的是 core_tool_kv
 * 里属于本工具的那几行。两条路都不给工具任何越界可能。
 *
 * ------------------------------------------------------------------
 * gallery.* —— 一次**有意识的边界放宽**，理由写在这里备查
 * ------------------------------------------------------------------
 * 图库是全局资源，不是某个工具的私有数据，所以 gallery.* 打破了
 * "工具只能碰自己的东西"那条线：任何工具都能列出图库、读一条图、往里写。
 *
 * 为什么接受这个放宽：
 *   1. 需求本身如此。「图片裁剪/尺码表的产物默认进图库、AI 生成的参考图
 *      直接从图库挑」—— 这三件事缺了跨工具访问就都做不成。
 *   2. 工具是**用户自己装进来的** HTML，本来就能跑任意脚本。
 *      把图库挡在外面并不会让恶意工具变安全，只会让正常工具写不出东西。
 *   3. 放宽的部分仍然是**受限**的：只能碰媒体，只能通过 id 索引
 *      （拿不到仓库路径，也就无从遍历文件系统），写入的大小有上限，
 *      而且**写入方身份由宿主盖戳**（见下）。
 *
 * 仍然守住的三条：
 *   · 工具传的是 id，不是路径 —— rel_path 由宿主从数据库查，工具拼不出 `../`
 *   · gallery.put 的 origin **不接受工具传值**，由 tool_id 映射而来，
 *     所以一个工具无法把自己的产物伪装成另一个工具的产物（provenance 可信）
 *   · 单条读取有字节上限，避免一次 postMessage 把内存打爆
 *
 * 设计取向：工具是外部输入，一律按不可信数据处理。多写三十行划清边界，
 * 好过以后为了"先跑起来"补一个任意 SQL 的口子。
 *
 * ------------------------------------------------------------------
 * row.* —— 工具的私有数据表
 * ------------------------------------------------------------------
 * 工具要在 manifest 里**声明**自己用哪些表（see lib/toolSchema.ts），
 * 宿主按声明建好，然后这里提供结构化 CRUD：
 *
 *   row.count / row.select / row.insert / row.update / row.delete / schema.info
 *
 * 刻意**不是** SQL 通道，而是"表名 + 行对象 + 等值筛选"：
 *
 *   1. 表名与列名一律取宿主侧那份**已校验的声明**，工具传进来的是索引；
 *      没声明过的表或列在这里就报错，根本走不到 SQL 里。
 *   2. 没有 JOIN、没有子查询、没有表达式 —— 工具拿不到 `core_tasks`，
 *      即使它在 Core 里塞个奇怪的值也无路可走。
 *   3. 值**按列类型强校验**（integer 列传字符串直接拒）。这条不是为了防攻击，
 *      是为了让两个驱动行为一致：SQLite 有类型亲和性会默默转，
 *      浏览器 demo 的内存库不会 —— 不校验就会出现"网页里好使、装上就错位"。
 *
 * 主键对每个 CRUD 都很关键：update / delete 只能按主键定位一行。
 * 这也是为什么声明表时**必须有且只能有一个主键列**。
 *
 * ------------------------------------------------------------------
 * tools.* —— 工具之间的联动
 * ------------------------------------------------------------------
 * 工具各在一个 iframe 里，彼此看不见对方，所以联动只能由宿主中转：
 *
 *   tools.list  看看这台机器上还有哪些工具（拿不到入口地址，只能拿到元信息）
 *   tools.open  拉起某个工具并把一份数据交给它（对方没在跑就先挂上）
 *   tools.send  给**已经在运行**的工具发一条消息（收不到会明确报错）
 *
 * 为什么不做通用事件总线：工具 A 发一件事、工具 B 订阅它，听着很松耦合，
 * 但 B 没在运行时这次发送是**静默丢失**的 —— 用户点"发给 XX"，什么都没发生。
 * 显式调用会先把对方拉起来，失败也能报出"它没装/被停用了"。
 *
 * 安全边界：转交的数据只在本机 postMessage 通道里流动，**不经过数据库**，
 * 工具依然拿不到别的表。tools.open 也不能让工具未经用户操作就互相拉起
 * （见 store.openToolWithIntent —— 它走的是和用户点侧边栏同一条路径）。
 */

import { db, dbInfo, isTauri, type Param } from "./db";
import { toolPrefix, toolTable } from "./tools";
import type { ValidatedTable } from "./toolSchema";
import { postToTool, registerToolPoster, unregisterToolPoster } from "./toolLink";
import {
  addToGallery,
  fetchGallery,
  getGalleryItem,
  makeThumb,
  notifyGalleryChanged,
  readGalleryDataUrl,
  THUMB_MAX,
} from "./gallery";
import type { GalleryItem, GalleryKind, GalleryOrigin } from "../types";

/** 协议标记，避免和页面里其他 postMessage 流量串台 */
export const TOOL_SOURCE = "workbench-tool";
export const HOST_SOURCE = "workbench-host";

/** 工具可以请求的操作白名单 */
export type ToolOp =
  | "info"
  | "count"
  | "kv.get"
  | "kv.set"
  | "kv.all"
  | "kv.del"
  /** 私有数据表：结构化 CRUD。见文件头「row.* —— 工具的私有数据表」 */
  | "row.count"
  | "row.select"
  | "row.insert"
  | "row.update"
  | "row.delete"
  | "schema.info"
  /** 工具联动。见文件头「tools.* —— 工具之间的联动」 */
  | "tools.list"
  | "tools.open"
  | "tools.send"
  | "gallery.list"
  | "gallery.get"
  | "gallery.put";

/**
 * 工具私有 KV 的键名约束。
 * 比表名宽松（允许点号和冒号，方便工具用 "config.image" 这种命名），
 * 但仍然限死字符集，避免奇怪的东西进到 SQL 参数里。
 */
const KV_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * 单个值的大小上限。
 *
 * 浏览器 demo 的库是整库快照存 localStorage（通常 5 MB 上限），
 * 让工具随便塞大字符串会把整个 demo 库撑爆 —— 表现是"保存成功但下次打开数据没了"，
 * 极难排查。所以这里直接拒绝，让工具自己改存 URL 或截断。
 */
const KV_VALUE_MAX = 512 * 1024;

/**
 * 经桥读一条图库原图时的大小上限。
 *
 * 比仓库本身的图片上限（20 MB）更严，因为这条路上多了一道
 * **postMessage 序列化**：20 MB 的 PNG 转成 base64 是约 27 MB 的字符串，
 * 跨 iframe 传一趟会让两边的内存瞬时翻好几倍，桌面端还可能直接卡住。
 * 10 MB 足够覆盖"拿来当生成参考图"这个用途（各家生图接口自己也在 10 MB 上下），
 * 超了就明确报错让用户换一张小的，而不是把应用拖垮。
 */
const GALLERY_READ_MAX = 10 * 1024 * 1024;

/** gallery.list 一次最多返回多少条 */
const GALLERY_LIST_MAX = 200;
/** gallery.list 一次默认返回多少条 */
const GALLERY_LIST_DEFAULT = 60;

interface ToolRequest {
  source?: string;
  type?: string;
  /** 请求 id，由工具生成，宿主原样回带，便于工具配对 */
  id?: string;
  op?: ToolOp;
  payload?: {
    table?: string;
    key?: string;
    value?: unknown;
    /* row.* —— 结构化 CRUD 的参数 */
    /** 等值筛选：{ status: "done" }，值为 null 表示 IS NULL */
    where?: Record<string, unknown>;
    /** 插入/更新的一行；update 里叫 patch，只写要改的列 */
    row?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    /** 主键值，update / delete 用它定位一行 */
    id?: unknown;
    /** 排序列名（必须是表里声明过的），只支持单列 */
    orderBy?: string;
    orderDir?: "asc" | "desc";
    limit?: number;
    offset?: number;
    /** tools.open / tools.send */
    tool?: string;
    event?: string;
    data?: unknown;
    kind?: string;
    search?: string;
    dataUrl?: string;
    /** gallery.put 的另一条入口：给网址，由宿主下载（见 handler 里的说明） */
    url?: string;
    title?: string;
    prompt?: string;
    note?: string;
    /**
     * gallery.put：内容已在图库里时复用已有记录，不再插一条。
     *
     * 专为「工具的产出默认留一份」这条规则准备 —— 自动存档是替用户保管的，
     * 一次导出可能产生十几张图，不去重的话图库会被同一张图刷屏。
     * 用户**亲手点**存图库时不要传：他要的就是"再留一份"。
     */
    dedupe?: boolean;
  };
}

/** row.select 一次最多返回多少行 */
const ROW_SELECT_MAX = 200;
/** row.select 一次默认返回多少行 */
const ROW_SELECT_DEFAULT = 50;
/**
 * 单个字段值的大小上限（含插入/更新的值）。
 * 理由与 kv 那条一致：demo 库是整库快照存 localStorage，塞大字符串会把整个库撑爆。
 */
const ROW_VALUE_MAX = 512 * 1024;

/** tools.list 回报的一项 —— 只给元信息，**不给入口地址** */
export interface ToolLinkMeta {
  id: string;
  name: string;
  icon?: string;
  version: string;
  description?: string;
  /** 此刻有没有 iframe 挂着（决定 tools.send 能不能投到） */
  running: boolean;
  /** 是不是当前正在看的那个 */
  active: boolean;
}

export interface ToolContext {
  toolId: string;
  /** 工具私有表名前缀，如 tool_image_crop_ */
  tablePrefix: string;
  driver: "sqlite" | "memory";
  schemaVersion: number;
  theme: "light" | "dark";
  runtime: "desktop" | "browser";
  /**
   * 宿主是否提供图库通道（gallery.*）。
   *
   * 存在的理由是**版本错配**：工具与宿主分开升级，用户完全可能在一个
   * 还没有图库的宿主上装了一个会调 gallery.* 的新工具。
   * 没有这个标记的话，那种情况只会表现为"点了没反应"或一句含糊的
   * "不支持的操作"，用户无从判断是自己装错了还是软件坏了。
   * 工具据此把相关入口置灰并说明原因。
   */
  gallery: true;
  /**
   * 宿主是否提供数据表通道（row.* / schema.info）。
   *
   * 老版本的宿主没有这条通道。工具若想在那种宿主上降级（退回 kv 存储），
   * 靠的就是这两个布尔值 —— 否则只能先调一次、看会不会报错。
   */
  data: true;
  /** 宿主是否提供工具联动（tools.*） */
  link: true;
}

export interface ToolBridge {
  /** 开始监听工具发来的请求 */
  attach: () => void;
  /** 停止监听（切工具/离开视图时调用） */
  detach: () => void;
  /** 主动把运行上下文推给工具（加载完成、主题切换时） */
  pushContext: () => void;
  /** 给本工具发一条事件消息（别的工具经宿主转过来） */
  postEvent: (event: string, data: unknown) => void;
  /** 把"被别的工具拉起"这件事连同数据一起推过去 */
  postIntent: (data: unknown, from: string | null) => void;
}

/**
 * 按工具的声明取出一张表。
 *
 * **只认宿主侧那份已校验的声明** —— 工具给的名字在这里只是个索引键。
 * 它没有声明过的表走不通，也就碰不到 `core_settings` 或别的工具的表：
 * 那也不 possible 通过它进到 SQL 里。
 */
function lookupTable(tables: ValidatedTable[], bare: unknown): ValidatedTable {
  if (typeof bare !== "string" || !bare) {
    throw new Error("缺少 table 参数（填 manifest 里声明过的裸表名，如 \"records\"）");
  }
  const hit = tables.find((t) => t.name === bare);
  if (!hit) {
    const names = tables.map((t) => t.name);
    throw new Error(
      names.length === 0
        ? "这个工具没有声明任何数据表（manifest 里缺 schema），row.* 用不了"
        : `没有声明过「${bare}」这张表。可用的是：${names.join("、")}`,
    );
  }
  return hit;
}

/** 列是否存在。列名校验与外面那层 utf-8 检查同源，见 toolSchema.NAME_RE */
function lookupColumn(t: ValidatedTable, col: string) {
  const hit = t.columns.find((c) => c.name === col);
  if (!hit) throw new Error(`表「${t.name}」里没有「${col}」这一列`);
  return hit;
}

/**
 * 校验一个值是否符合列类型，并转成能进参数化的形态。
 *
 * 严格是因为**两个驱动的类型处理不一样**：SQLite 有类型亲和性，往 integer 列
 * 写字符串会转成数字；浏览器的内存库原样存着字符串。不校验的结果是
 * 「网页预览里是对的，装成 exe 之后排序和比较全错」 —— 这类错位极难发现，
 * 所以宁可在这里明确拒绝。
 */
function coerceValue(t: ValidatedTable, col: string, raw: unknown): Param {
  const def = lookupColumn(t, col);
  if (raw === null) return null;

  switch (def.type) {
    case "integer":
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw new Error(`列「${col}」是 integer，收到的是 ${describeType(raw)}`);
      }
      return raw;
    case "real":
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(`列「${col}」是 real，收到的是 ${describeType(raw)}`);
      }
      return raw;
    case "text":
    default:
      if (typeof raw !== "string") {
        throw new Error(`列「${col}」是 text，收到的是 ${describeType(raw)}`);
      }
      if (raw.length > ROW_VALUE_MAX) {
        throw new Error(`列「${col}」的值超过 ${Math.round(ROW_VALUE_MAX / 1024)} KB 上限`);
      }
      return raw;
  }
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/**
 * 校验一个对象里全是这张表声明过的列，返回列值对。
 *
 * **多余列一律拒绝**（不是忽略）：工具传错列名时，"悄悄丢掉"会让
 * 「我写了但没存进去」变成一个没有报错、没有线索的现象。明确报错，
 * 工具作者一眼就知道自己写错了什么。
 */
function readRow(
  t: ValidatedTable,
  raw: unknown,
  label: string,
): Array<[string, Param]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} 必须是一个对象（列名 -> 值）`);
  }
  const out: Array<[string, Param]> = [];
  for (const [col, v] of Object.entries(raw as Record<string, unknown>)) {
    out.push([col, coerceValue(t, col, v)]);
  }
  if (out.length === 0) throw new Error(`${label} 是空的，至少给一列`);
  return out;
}

/** 等值筛选条件 -> SQL 片段。null 值转 IS NULL，其余转 `= ?` */
function buildWhere(
  t: ValidatedTable,
  where: unknown,
): { clause: string; params: Param[] } {
  if (where === undefined || where === null) return { clause: "", params: [] };
  const pairs = readRow(t, where, "where");
  const parts: string[] = [];
  const params: Param[] = [];
  for (const [col, v] of pairs) {
    lookupColumn(t, col);
    if (v === null) parts.push(`${col} IS NULL`);
    else {
      parts.push(`${col} = ?`);
      params.push(v);
    }
  }
  return {
    clause: parts.length ? ` WHERE ${parts.join(" AND ")}` : "",
    params,
  };
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** 组装工具运行上下文 —— 工具据此显示"我连到哪儿了" */
export function buildContext(toolId: string): ToolContext {
  const info = dbInfo();
  return {
    toolId,
    // 走 toolPrefix 而不是再拼一遍 —— 前缀规则只有一处定义，见 lib/tools.ts
    tablePrefix: toolPrefix(toolId),
    driver: info.driver,
    schemaVersion: info.schemaVersion,
    theme: currentTheme(),
    runtime: isTauri() ? "desktop" : "browser",
    gallery: true,
    data: true,
    link: true,
  };
}

/**
 * 校验工具传来的 KV 键名。非法直接抛错 —— 由 onMessage 的 try/catch
 * 统一转成错误回复，和 toolTable() 对非法表名的处理方式一致。
 */
function readKey(raw: unknown): string {
  if (typeof raw !== "string" || !KV_KEY_RE.test(raw)) {
    throw new Error(`非法的 key（只允许字母数字与 _ . : -，长度 1-64）：${String(raw)}`);
  }
  return raw;
}

/**
 * 内置工具 → 图库来源标记。
 *
 * **origin 一律由宿主按 tool_id 推断，绝不接受工具传来的值** ——
 * 这是 provenance（产物出处）能不能信的关键。若允许工具自报，
 * 任何一个工具都能把产物伪装成"AI 生成"（那样会带着提示词一起显示），
 * 而"这条图是谁放进来的"正是排查图库问题时唯一可靠的线索。
 *
 * 不认识的自定义工具落到 manual —— 说"用户手动导入的"是诚实的，
 * 因为我们确实不认识它。
 */
const TOOL_ORIGIN: Record<string, GalleryOrigin> = {
  "ai-gen": "ai-gen",
  "image-crop": "image-crop",
  "size-chart": "size-chart",
};

function originForTool(toolId: string): GalleryOrigin {
  return TOOL_ORIGIN[toolId] ?? "manual";
}

/**
 * 缩略图缓存。
 *
 * key 用 rel_path —— 它含内容哈希前缀（`2026-09/a1b2c3d4-图.png`），
 * **内容变了路径就变了**，所以这个缓存不会拿到过期的东西，
 * 也就不需要失效逻辑。
 *
 * 仍然设上限并按插入顺序淘汰：一张 320px 的 JPEG 约 20 KB，
 * 300 张约 6 MB，是能接受的上限；不设的话，用户翻一个大图库
 * 就能让宿主内存一直涨。
 */
const thumbCache = new Map<string, string>();
const THUMB_CACHE_MAX = 300;

function cachedThumb(relPath: string): string | undefined {
  return thumbCache.get(relPath);
}

function rememberThumb(relPath: string, thumb: string): void {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    // Map 的迭代顺序就是插入顺序，删最早那个即可（FIFO 足够，
    // 这里不需要真正的 LRU —— 图库浏览是顺序翻的，不是随机访问）
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
  thumbCache.set(relPath, thumb);
}

/** 供测试重置 */
export function __resetThumbCache(): void {
  thumbCache.clear();
}

/** 把图库条目转成给工具看的形状。**不含仓库路径** —— 工具拿不到路径就无从越界。 */
interface ToolGalleryItem {
  id: string;
  title: string;
  kind: GalleryKind;
  origin: GalleryOrigin;
  width: number | null;
  height: number | null;
  size: number | null;
  createdAt: string;
  prompt: string;
  thumb: string;
  /**
   * 这一份内容图库里本来就有（`dedupe` 命中），本次没有新建记录。
   *
   * 工具据此把提示语从"已存进图库"换成"图库里已有这一份" ——
   * 自动存档是静默发生的，用户没点过保存却看到图库条数没变，
   * 不给这句话就会以为存档坏了。
   */
  dup: boolean;
}

async function toToolItem(item: GalleryItem): Promise<ToolGalleryItem> {
  let thumb = "";
  if (item.kind === "image" && item.relPath) {
    const hit = cachedThumb(item.relPath);
    if (hit !== undefined) {
      thumb = hit;
    } else {
      try {
        thumb = await makeThumb(item.relPath, THUMB_MAX);
        if (thumb) rememberThumb(item.relPath, thumb);
      } catch {
        // 单张图读失败（文件被手动清理过）不该让整个列表失败，
        // 那一格显示成空占位即可
        thumb = "";
      }
    }
  }
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    origin: item.origin,
    width: item.width,
    height: item.height,
    size: item.size,
    createdAt: item.createdAt,
    prompt: item.prompt,
    thumb,
    dup: item.dup === true,
  };
}

/**
 * 创建到某个工具 iframe 的桥。
 *
 * @param toolId      当前工具的 id（表名前缀与联动身份的来源）
 * @param getFrame    返回当前 iframe 元素；返回 null 时丢弃消息
 * @param getTables   宿主侧已校验过的表声明（见 toolSchema.buildValidatedTables）。
 *                    没声明任何表的工具拿到空数组 —— 那时 row.* 一律报
 *                    "这个工具没有声明任何表"，而不是去猜列名。
 * @param openTool    拉起另一个工具并把一份数据交给它
 */
export function createToolBridge(
  toolId: string,
  getFrame: () => HTMLIFrameElement | null,
  opts: {
    getTables: () => ValidatedTable[];
    openTool?: (id: string, payload: unknown) => Promise<void>;
    /** 当前机器上的其他工具（tools.list 用）。由组件从 store 组装后传进来 */
    peers?: () => ToolLinkMeta[];
  },
): ToolBridge {
  /**
   * 工具 iframe 的真实 origin。
   *
   * ⚠️ **不能填 `window.location.origin`**。桌面端工具是经 asset 协议加载的
   * （`http://asset.localhost/C%3A%5C…%5Cindex.html`），而宿主页面在
   * `http://tauri.localhost` —— 两者不同源。postMessage 的 targetOrigin 不匹配时
   * 浏览器把整条消息**静默丢弃**：不报错、不告警，宿主以为发了、工具以为没人理。
   * 表现是所有桥操作全部超时（工具 KV 写不进、图库存不进），而同样的代码在
   * dev 下（工具与宿主同源）全绿 —— 所以只能靠这里写对，测不出来。
   *
   * 取值顺序：收到工具消息后按 `e.origin` 收紧（最准）> 首帧用 `"*"`。
   *
   * 首帧为什么不用 iframe.src 推导：src 写的地址**不等于**最终加载的地址。
   * 一旦中间有重定向（或将来工具改成先落地页再跳转），按 src 推出的 origin 是错的，
   * 而错的值不会产生任何报错 —— 消息照样被静默丢掉，宿主还以为自己发成功了。
   * 更糟的是这会变成死结：context 没到 → 工具不发请求 → 宿主永远学不到真实 origin。
   *
   * `"*"` 在这里是安全的：postMessage 的目标是**明确指定的那个 contentWindow**，
   * 不是广播，`*` 只是不限制该窗口此刻的 origin。能收到消息的只有工具这个 iframe。
   */
  let toolOrigin: string | null = null;

  const post = (msg: unknown) => {
    const frame = getFrame();
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(msg, toolOrigin ?? "*");
  };

  // 注册到联动通道：别的工具要找这个工具时，宿主从这里拿到它的投递函数。
  // 注销必须可靠（见 return 里的 detach），否则会留下一个指向死 iframe 的函数：
  // 调它不报错，但对方永远收不到 —— 正是"发了没反应"最难查的那种。
  registerToolPoster(toolId, post);

  const reply = (id: string | undefined, ok: boolean, data: unknown) => {
    if (ok) post({ source: HOST_SOURCE, type: "tool:response", id, ok: true, data });
    else post({ source: HOST_SOURCE, type: "tool:response", id, ok: false, error: data });
  };

  const onMessage = async (e: MessageEvent) => {
    const frame = getFrame();
    // 只认当前 iframe 发来的消息：同页面其他 iframe 不能冒充这个工具
    if (!frame || e.source !== frame.contentWindow) return;

    // 校验通过后才认这个 origin，之后的回复用它作 targetOrigin（见 post 的说明）
    if (e.origin && e.origin !== "null") toolOrigin = e.origin;

    const req = e.data as ToolRequest | undefined;
    if (!req || req.source !== TOOL_SOURCE || req.type !== "tool:request") return;

    const { id, op, payload } = req;

    try {
      if (op === "info") {
        reply(id, true, buildContext(toolId));
        return;
      }

      if (op === "count") {
        const bare = payload?.table;
        if (typeof bare !== "string" || !bare) {
          reply(id, false, "缺少 table 参数（只接受裸表名，如 \"records\"）");
          return;
        }
        // toolTable 会校验表名字符集并强制加前缀：
        // 传 "records" -> tool_image_crop_records；
        // 传 "../core_tasks" 之类的会在这里直接抛错。
        const full = toolTable(toolId, bare);
        const rows = await db().select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${full}`);
        reply(id, true, { table: full, count: Number(rows[0]?.n ?? 0) });
        return;
      }

      if (op === "kv.get") {
        const key = readKey(payload?.key);
        const rows = await db().select<{ value: string }>(
          `SELECT value FROM core_tool_kv WHERE tool_id = ? AND key = ?`,
          [toolId, key],
        );
        // 键不存在时回 null 而不是抛错 —— "还没配过"是正常状态，不是错误
        return reply(id, true, { key, value: rows[0]?.value ?? null });
      }

      if (op === "kv.set") {
        const key = readKey(payload?.key);

        const value = payload?.value;
        if (typeof value !== "string") return reply(id, false, "value 必须是字符串");
        if (value.length > KV_VALUE_MAX) {
          return reply(id, false, `value 超过 ${Math.round(KV_VALUE_MAX / 1024)} KB 上限`);
        }

        // 先查后写，而不是 INSERT OR REPLACE：
        // 内存库的 mini-SQL 没有实现 upsert 语法，两个驱动要共用同一段 SQL。
        const now = new Date().toISOString();
        const exists = await db().select<{ n: number }>(
          `SELECT COUNT(*) AS n FROM core_tool_kv WHERE tool_id = ? AND key = ?`,
          [toolId, key],
        );
        if (Number(exists[0]?.n ?? 0) > 0) {
          await db().execute(
            `UPDATE core_tool_kv SET value = ?, updated_at = ? WHERE tool_id = ? AND key = ?`,
            [value, now, toolId, key],
          );
        } else {
          await db().execute(
            `INSERT INTO core_tool_kv (tool_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
            [toolId, key, value, now],
          );
        }
        return reply(id, true, { key, ok: true, bytes: value.length });
      }

      if (op === "kv.all") {
        const rows = await db().select<{ key: string; value: string }>(
          `SELECT key, value FROM core_tool_kv WHERE tool_id = ?`,
          [toolId],
        );
        const entries: Record<string, string> = {};
        for (const r of rows) entries[r.key] = r.value;
        return reply(id, true, { entries });
      }

      if (op === "kv.del") {
        const key = readKey(payload?.key);
        await db().execute(`DELETE FROM core_tool_kv WHERE tool_id = ? AND key = ?`, [toolId, key]);
        return reply(id, true, { key, ok: true });
      }

      /* ---------------------- 私有数据表（结构化 CRUD） ----------------------
       * 表、列一律来自 opts.getTables() —— 宿主侧那份已校验的声明。
       * 构造出来 SQL 里的标识符永远出自债权人的口袋，工具只能提供值。 */

      if (op === "schema.info") {
        const tables = opts.getTables();
        return reply(id, true, {
          tables: tables.map((t) => ({
            name: t.name,
            fullName: t.fullName,
            pk: t.pkColumn,
            columns: t.columns.map((c) => ({
              name: c.name,
              type: c.type,
              pk: c.pk === true,
              notNull: c.notNull === true,
            })),
          })),
        });
      }

      if (op === "row.count") {
        const t = lookupTable(opts.getTables(), payload?.table);
        const { clause, params } = buildWhere(t, payload?.where);
        const rows = await db().select<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${t.fullName}${clause}`,
          params,
        );
        return reply(id, true, { table: t.name, count: Number(rows[0]?.n ?? 0) });
      }

      if (op === "row.select") {
        const t = lookupTable(opts.getTables(), payload?.table);
        const { clause, params } = buildWhere(t, payload?.where);

        // 排序列必须是本表的列，方向只能是 asc/desc 字面量 —— 两处都不是传值托管的，
        // 所以 ORDER BY 里不可能出现表达式或注入出来的额外语句
        let orderClause = "";
        if (typeof payload?.orderBy === "string" && payload.orderBy) {
          lookupColumn(t, payload.orderBy);
          const dir = payload.orderDir === "desc" ? "DESC" : "ASC";
          orderClause = ` ORDER BY ${payload.orderBy} ${dir}`;
        }

        const wanted = Math.floor(Number(payload?.limit) || ROW_SELECT_DEFAULT);
        const limit = Math.min(ROW_SELECT_MAX, Math.max(1, wanted));
        const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));

        const limitClause = ` LIMIT ${limit} OFFSET ${offset}`;
        const rows = await db().select<Record<string, unknown>>(
          `SELECT * FROM ${t.fullName}${clause}${orderClause}${limitClause}`,
          params,
        );
        // total 是"不限分页时一共多少行"，工具要用它翻页就得再算一次 ——
        // 不随这次查询白送的话，工具只能靠"这次返回的行数 < limit"猜到头，
        // 而最后正好一页齐全时会误判还有下一页。
        const counted = await db().select<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${t.fullName}${clause}`,
          params,
        );
        return reply(id, true, {
          table: t.name,
          rows,
          total: Number(counted[0]?.n ?? 0),
          limit,
          offset,
        });
      }

      if (op === "row.insert") {
        const t = lookupTable(opts.getTables(), payload?.table);
        const pairs = readRow(t, payload?.row, "row");

        // 主键必须给：宿主不肯替工具生成 id，因为生成规则一旦定下来，
        // 工具作者就少了一个"我自己能保证幂等"的手段（重复导入时要靠自己的业务键）
        const pkValue = pairs.find(([c]) => c === t.pkColumn)?.[1];
        if (pkValue === undefined || pkValue === null) {
          throw new Error(`插入必须给出主键列「${t.pkColumn}」的值`);
        }

        const cols = pairs.map(([c]) => c);
        await db().execute(
          `INSERT INTO ${t.fullName} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          pairs.map(([, v]) => v),
        );
        // 回写回去的那一行：工具拿到的是宿主实际存的东西（而不是自己猜的去持久化结果）
        const written = await db().select<Record<string, unknown>>(
          `SELECT * FROM ${t.fullName} WHERE ${t.pkColumn} = ?`,
          [pkValue],
        );
        return reply(id, true, { table: t.name, id: pkValue, row: written[0] ?? null });
      }

      if (op === "row.update") {
        const t = lookupTable(opts.getTables(), payload?.table);
        const pkValue = coerceValue(t, t.pkColumn, payload?.id);
        if (pkValue === null) throw new Error(`缺少主键值 id（列「${t.pkColumn}」）`);

        const pairs = readRow(t, payload?.patch, "patch");
        const cols = pairs.map(([c]) => c);
        await db().execute(
          `UPDATE ${t.fullName} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${t.pkColumn} = ?`,
          [...pairs.map(([, v]) => v), pkValue],
        );
        const written = await db().select<Record<string, unknown>>(
          `SELECT * FROM ${t.fullName} WHERE ${t.pkColumn} = ?`,
          [pkValue],
        );
        return reply(id, true, { table: t.name, id: pkValue, row: written[0] ?? null });
      }

      if (op === "row.delete") {
        const t = lookupTable(opts.getTables(), payload?.table);
        const pkValue = coerceValue(t, t.pkColumn, payload?.id);
        if (pkValue === null) throw new Error(`缺少主键值 id（列「${t.pkColumn}」）`);

        await db().execute(
          `DELETE FROM ${t.fullName} WHERE ${t.pkColumn} = ?`,
          [pkValue],
        );
        return reply(id, true, { table: t.name, id: pkValue, deleted: true });
      }

      /* ------------------------------ 工具联动 ------------------------------
       * 见文件头「tools.* —— 工具之间的联动」。三条一句话概括：
       * list 看元信息、open 拉起并转交数据、send 只给已经在跑的工具。 */

      if (op === "tools.list") {
        const list = opts.peers ? opts.peers() : [];
        return reply(id, true, { tools: list });
      }

      if (op === "tools.open") {
        const target = payload?.tool;
        if (typeof target !== "string" || !target) {
          return reply(id, false, "缺少 tool 参数（要拉起的工具 id）");
        }
        if (target === toolId) {
          return reply(id, false, "不能拉起自己 —— 要刷新界面请让用户点工具头部的「重置」");
        }
        if (!opts.openTool) {
          return reply(id, false, "这个宿主没有提供工具联动");
        }
        try {
          await opts.openTool(target, payload?.data ?? null);
        } catch (err) {
          // openTool 抛出的都是"这个工具没装 / 被停用了"这类用户可以处理的原因，
          // 直接把话传回去，别换成含糊的"拉起失败"
          return reply(id, false, err instanceof Error ? err.message : String(err));
        }
        return reply(id, true, { tool: target, opened: true });
      }

      if (op === "tools.send") {
        const target = payload?.tool;
        if (typeof target !== "string" || !target) {
          return reply(id, false, "缺少 tool 参数");
        }
        if (target === toolId) return reply(id, false, "不能给自己发消息");
        const event = payload?.event;
        if (typeof event !== "string" || !event) {
          return reply(id, false, "缺少 event 参数（对方监听的事件名）");
        }
        // 只投已经在运行的工具。不替对方拉起来的原因写在文件头：
        // 静默失败是最难查的一类，"对方没在跑"必须是一个明确的错误。
        const delivered = postToTool(target, {
          source: HOST_SOURCE,
          type: "tool:event",
          event,
          data: payload?.data ?? null,
          from: toolId,
        });
        if (!delivered) {
          return reply(
            id,
            false,
            `「${target}」此刻没有在运行，消息没送到。请先用 tools.open 把它拉起来`,
          );
        }
        return reply(id, true, { tool: target, delivered: true });
      }

      /* ---------------- 图库 ----------------
       * 安全性说明见文件头「gallery.* —— 一次有意识的边界放宽」。
       * 三处共同点：工具只能传 id / 内容，**永远传不了路径**。 */

      if (op === "gallery.list") {
        const rawKind = payload?.kind;
        const kind: GalleryKind | "all" =
          rawKind === "image" || rawKind === "video" ? rawKind : "all";

        // 夹在 1..GALLERY_LIST_MAX 之间：不限的话，工具传个 999999
        // 就意味着宿主要把一整个图库（连缩略图）全生成出来再塞进一条消息
        const wanted = Math.floor(Number(payload?.limit) || GALLERY_LIST_DEFAULT);
        const limit = Math.min(GALLERY_LIST_MAX, Math.max(1, wanted));

        const items = await fetchGallery({
          kind,
          search: typeof payload?.search === "string" ? payload.search : "",
          limit,
        });
        const shaped: ToolGalleryItem[] = [];
        // 串行而不是 Promise.all：一次并行几十张图的解码会把主线程压满，
        // 界面上表现为"点了图库之后整个工作台卡一下"。串行多花的时间
        // 被缓存摊掉了（同一个图库第二次打开直接命中）
        for (const it of items) shaped.push(await toToolItem(it));

        return reply(id, true, { items: shaped, limit, count: shaped.length });
      }

      if (op === "gallery.get") {
        const gid = payload?.id;
        if (typeof gid !== "string" || !gid) return reply(id, false, "缺少 id 参数");

        const item = await getGalleryItem(gid);
        if (!item) return reply(id, false, "这条记录不在图库里（可能已被删除）");

        const { dataUrl, mime } = await readGalleryDataUrl(item, GALLERY_READ_MAX);
        return reply(id, true, {
          id: item.id,
          title: item.title,
          kind: item.kind,
          dataUrl,
          mime,
          width: item.width,
          height: item.height,
        });
      }

      if (op === "gallery.put") {
        const dataUrl = payload?.dataUrl;
        const srcUrl = payload?.url;
        const hasInline = typeof dataUrl === "string" && dataUrl.length > 0;
        const hasUrl = typeof srcUrl === "string" && srcUrl.length > 0;
        if (!hasInline && !hasUrl) {
          return reply(id, false, "缺少 dataUrl 或 url 参数");
        }

        // 为什么允许传网址、由宿主去下：
        // 生图接口回报的往往是**第三方对象存储的临时链接**（如 OSS，24 小时失效），
        // 而这类存储默认不给 CORS 头。让工具自己 fetch 会被浏览器拦掉，
        // 而这种失败在工具里只能报成一句含糊的"网络错误"。
        // 宿主这边有 Rust reqwest（桌面）或直接 fetch（浏览器 demo），
        // 而且附件功能早就把这条下载链路跑熟了 —— 复用比新开一条稳。
        // 也正因为要下载，**必须先落盘再入库**，见 lib/gallery.ts 的顺序约定。
        //
        // 单条读取有字节上限，写入同样有 —— 上限在 addToGallery 里按媒体类型判。
        const item = await addToGallery({
          dataUrl: hasInline ? dataUrl : undefined,
          url: hasInline ? undefined : srcUrl,
          title: typeof payload?.title === "string" ? payload.title.slice(0, 200) : "",
          prompt: typeof payload?.prompt === "string" ? payload.prompt.slice(0, 4000) : "",
          note: typeof payload?.note === "string" ? payload.note.slice(0, 1000) : "",
          // ★ 来源由宿主按 tool_id 盖章，工具自报的一律忽略
          origin: originForTool(toolId),
          // 去重只在工具**自动存档**时开（payload 里显式传 true），
          // 手动保存不传 —— 两种意图由工具区分，宿主不做猜测
          dedupe: payload?.dedupe === true,
        });

        // 图库界面若正开着，让它自己刷新（见 lib/gallery.ts 的 GALLERY_CHANGED）
        notifyGalleryChanged();
        return reply(id, true, await toToolItem(item));
      }

      reply(id, false, `不支持的操作：${String(op)}`);
    } catch (err) {
      // 工具传了非法表名、表不存在等，都回一条错误而不是让宿主崩
      reply(id, false, err instanceof Error ? err.message : String(err));
    }
  };

  return {
    attach: () => window.addEventListener("message", onMessage),
    detach: () => {
      window.removeEventListener("message", onMessage);
      unregisterToolPoster(toolId, post);
    },
    pushContext: () => post({ source: HOST_SOURCE, type: "tool:context", data: buildContext(toolId) }),
    postEvent: (event: string, data: unknown) =>
      post({ source: HOST_SOURCE, type: "tool:event", event, data }),
    postIntent: (data: unknown, from: string | null) =>
      post({ source: HOST_SOURCE, type: "tool:intent", data, from }),
  };
}
