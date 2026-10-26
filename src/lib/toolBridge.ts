/**
 * 工具 ↔ 宿主 的数据通道（postMessage 代查）。
 *
 * ToolHost 的注释里一直写着「需要数据时通过 postMessage 向宿主请求，宿主代查」，
 * 但这条通道此前并没有实现 —— 工具只能自带静态内容，拿不到任何数据。
 * 它最初是为了让「特殊单号记录」能绑定数据库而补的；那个功能后来改成了原生流程任务
 * （时效要跟流转绑定，塞进工具私有表就得把整套流程任务子系统重写一遍），
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
 * 图床是全局资源，不是某个工具的私有数据，所以 gallery.* 打破了
 * "工具只能碰自己的东西"那条线：任何工具都能列出图床、读一条图、往里写。
 *
 * 为什么接受这个放宽：
 *   1. 需求本身如此。「图片裁剪/尺码表的产物默认进图床、AI 生成的参考图
 *      直接从图床挑」—— 这三件事缺了跨工具访问就都做不成。
 *   2. 工具是**用户自己装进来的** HTML，本来就能跑任意脚本。
 *      把图床挡在外面并不会让恶意工具变安全，只会让正常工具写不出东西。
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
 * task.* —— 待办的两扇门，一读一写，边界完全相反
 * ------------------------------------------------------------------
 * task.get    只读它挂着的那一条（注入组件专用，连"给我 id X"都不给）；
 * task.remind 只写一条新的（整页工具可用，落下来的待办带宿主盖章的来源标记）。
 *
 * 为什么写不开成通用 task.create：让外部 HTML 随意造待办，等于把"工作台里
 * 有哪些事"的权柄交给第三方 —— 订提醒不需要那么大权限。窄口的语义是
 * "工具替用户订一条**会响的**提醒"，myDay/important/清单都不开放，
 * cancel 也只认自己订的那条。实现见 handler 里那段注释。
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
 *
 * ------------------------------------------------------------------
 * wps.mcp* —— 官方 agent 入口（「我的云文档」直连）
 * ------------------------------------------------------------------
 * 与 wps.files/fileRead/fileWrite（知识库路）并列的另一条 WPS 通道：
 * SkillHub MCP，令牌能碰**全部云文档**。
 *
 * 三道门，一个都不能少：
 *   1. manifest 声明 `wps` capability（和知识库路同一道门）；
 *   2. 设置 → WPS 授权 里完成授权（令牌只待在本机）；
 *   3. **用户按过「确认启用」**（wps.mcp.enabled=1）—— 授权成功只证明
 *      账号能用，用户没点头之前工具一个字都读不到。
 *
 * 能触达的 MCP 工具是 Rust 侧的**硬白名单**（wps_mcp.rs 的 BRIDGE_TOOLS）：
 * 列文件 / 读表格 / 读文档 / 写智能文档，就这五个 —— 这条命令不该变成
 * "625 个工具随便调"的口子。令牌只待在宿主，iframe 永远拿不到。
 */

import { invoke } from "@tauri-apps/api/core";
import { db, dbInfo, isTauri, type Param } from "./db";
import { toolPrefix, toolTable } from "./tools";
import type { ValidatedTable } from "./toolSchema";
import { postToTool, registerToolPoster, unregisterToolPoster } from "./toolLink";
import {
  addToImagebed,
  fetchImagebed,
  getImagebedItem,
  makeThumb,
  notifyImagebedChanged,
  readImagebedDataUrl,
  THUMB_MAX,
} from "./imagebed";
import {
  createList,
  createTask,
  deleteTask,
  fetchLists,
  fetchTaskById,
  notifyTasksChanged,
} from "./repo";
import type { ImagebedItem, ImagebedKind, ImagebedOrigin } from "../types";
import { capabilityError, capabilityState } from "./extensions/registry";
import type { ToolInjectKind } from "./extensions/types";
import {
  bindByLink,
  listBindable,
  readBoundFile,
  writeBoundFile,
} from "./wpsLink";
import {
  mcpBridgeTool,
  mcpProbe,
  mcpSheetPull,
  mcpSheetPush,
} from "./wpsMcp";
import {
  COLUMNS,
  applyPull,
  planPull,
  readLedger,
  sheetRows,
  type LedgerRow,
  type PullPlan,
} from "./kwiki";
import { SETTINGS } from "./settings";
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
  | "gallery.put"
  /** 注入组件读**它挂着的那一条**待办（只读）。见文件头「task.get」 */
  | "task.get"
  /**
   * 工具替用户订一条提醒（在待办里落一条带来源标记的待办）。
   * 见文件头「task.remind —— 工具代订提醒」与 handler 处的说明。
   */
  | "task.remind"
  /**
   * 用系统默认程序打开一个自定义协议链接（唤起本机客户端）。
   *
   * 工具**不能**自己 `location.href = "pddim:..."`：它跑在 sandbox iframe 里，
   * Chromium 拦下自定义协议导航时会把整个 iframe 换成「已阻止此内容」错误页，
   * 唤起失败之外，工具里没提交的东西也一起没了。协议白名单在 Rust 侧。
   */
  | "shell.open"
  /**
   * 绑定一份 WPS 知识库文件并读写它。
   *
   * 四个 op 共用一道 `wps` 能力门：list 列可绑定的文件、bindLink 把分享链接
   * 复制进知识库、fileRead 读内容、fileWrite 写回（新建→删旧→改名）。
   * 令牌不出宿主；但每次写都会借用户的账号动知识库，所以能力要在 manifest 里明说。
   */
  | "wps.files"
  | "wps.bindLink"
  | "wps.fileRead"
  | "wps.fileWrite"
  /**
   * WPS MCP（SkillHub）：官方 agent 入口，「我的云文档」直连。
   * 见文件头「wps.mcp* —— 官方 agent 入口」；令牌不出宿主，
   * 且必须在 设置 → WPS 授权 里**确认启用**后这组 op 才有响应。
   */
  | "wps.mcpProbe"
  | "wps.mcpFiles"
  | "wps.mcpBind"
  | "wps.mcpRead"
  | "wps.mcpDocWrite"
  /** 整块写回表格（官方入口这条路上表格也能改 —— 见 mcpSheetWrite 那段注释） */
  | "wps.mcpSheetWrite"
  /**
   * 台账同步三件套（给「异常单号登记」这类"自己就是一本台账"的工具用）：
   *   · mcpLink  分享链接 → 文件信息（认表用，不需要登录）
   *   · mcpPush  本地台账 → 在线表格
   *   · mcpPull  在线表格 → 差异预览（**不写库**）
   *   · mcpApply 把上一次 mcpPull 的预览真正写进库
   *
   * ★ 为什么对账留在宿主：只写台账 14 列、表头认不出就停手、长订单号前置单引号
   *   这套保护在 Rust 里（`wps_cloud_plan.rs`，带断言）。放在工具页里就等于
   *   给一份关键保护开第二份实现 —— 改一处必漏另一处。
   */
  | "wps.mcpLink"
  | "wps.mcpPush"
  | "wps.mcpPull"
  | "wps.mcpApply";

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
 * 经桥读一条图床原图时的大小上限。
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

/**
 * wps.fileWrite 的上限。
 *
 * 桥是 postMessage 通道：一张几万行的表在两边各序列化一遍，桌面端会明显卡。
 * 2000 行 × 几十列已经远超"在工具里手改"的合理范围；真有大表，应该回 WPS 里改。
 */
const WPS_WRITE_MAX_ROWS = 2000;
/** 文档正文上限（字符）。50 万字足够长文，再长就不该塞进 iframe 编辑了 */
const WPS_WRITE_MAX_TEXT = 500_000;

/** 把工具传来的任意值收成 string[]（非数组一律当空） */
function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x == null ? "" : String(x)));
}

/* ------------------------------ wps.mcp* 辅助 ------------------------------ */

/**
 * `wps.mcpPull` 算出来、等着 `wps.mcpApply` 落库的计划。
 *
 * 只留一份（后一次拉取覆盖前一次）：工具既拿不到令牌也碰不到数据库，
 * 把计划传进 iframe 再传回来，只是给"工具伪造写库内容"多开一次机会。
 */
let pendingPull: PullPlan | null = null;
/** 这份计划属于哪个数据库（v1.19.0）—— 拉取时记下，写库时照着落，别落到默认库去 */
let pendingPullDb = "";

/** 绑定对象里那个"工作表"字段。payload 的键是宽泛类型，统一这样取 */
function sheetOf(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const s = (v as { sheet?: unknown }).sheet;
  return typeof s === "string" ? s.trim() : "";
}

/** 给工具看的"这一行是哪条"—— 只够认人，不给整行（工具不需要，也不必拿） */
/**
 * 列 key → 中文列名：明细里要给人看「快递单号」，不是 tracking_no。
 *
 * ★ 必须**惰性**建：toolBridge 与 kwiki 互相 import（kwiki 要桥接的 HOST_SOURCE，
 * 桥接要 kwiki 的 COLUMNS）。在模块顶层直接读 COLUMNS，谁先被加载谁拿到
 * undefined —— 症状是 `npm run kwiki:test` 在导入期就崩（2026-10-25 发现）。
 */
let columnLabelCache: Record<string, string> | null = null;
function columnLabel(key: string): string {
  if (!columnLabelCache) {
    columnLabelCache = Object.fromEntries(COLUMNS.map(([k, l]) => [k, l]));
  }
  return columnLabelCache[key] || key;
}

function pullBrief(row: LedgerRow): { key: string; store: string; status: string } {
  return {
    key: String(row.order_sn || row.tracking_no || ""),
    store: String(row.store || ""),
    status: String(row._status || ""),
  };
}

/** MCP 业务信封：{code, message, data}。code!=0 就是失败（2026-10-19 实测约定） */
function mcpBiz(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object") throw new Error("MCP 返回的不是业务信封");
  const env = v as { code?: unknown; message?: unknown; data?: unknown };
  if (Number(env.code) !== 0) {
    throw new Error(
      typeof env.message === "string" && env.message
        ? env.message
        : `MCP 业务码 ${String(env.code)}`,
    );
  }
  return (env.data ?? {}) as Record<string, unknown>;
}

function mcpObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function mcpArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 读表格用的上限。与写回同量级：postMessage 通道两边各序列化一遍，别把内存打爆 */
const MCP_SHEET_MAX_ROWS = 2000;
const MCP_SHEET_MAX_COLS = 60;

/**
 * 把 get_range_data 的稀疏格点拼成稠密网格。
 *
 * 服务端给的是「非空格 + 坐标」列表（空格不给），rowFrom/colFrom 是
 * 0-based 起点合快合并单元格只写在左上角。拼网格时只取每个格的左上角 ——
 * 合并单元格的重复值会自然落在左上，右下留空，跟表格里的观感一致。
 */
function mcpAssembleGrid(
  cells: unknown[],
  rowTo: number,
  colTo: number,
): string[][] {
  const grid: string[][] = Array.from({ length: rowTo + 1 }, () =>
    Array.from({ length: colTo + 1 }, () => ""),
  );
  for (const raw of cells) {
    const c = mcpObj(raw);
    const r = Number(c.rowFrom);
    const col = Number(c.colFrom);
    if (!Number.isFinite(r) || !Number.isFinite(col)) continue;
    if (r < 0 || r > rowTo || col < 0 || col > colTo) continue;
    const text = c.cellText ?? c.originalCellValue;
    grid[r][col] = text == null ? "" : String(text);
  }
  return grid;
}

/** MCP 侧按扩展名判断能不能整段写回：整文替换的入口只开了智能文档 */
function mcpDocWritable(name: string): boolean {
  return /\.otl$/i.test(name.trim());
}

/**
 * 长数字必须**当文本写**，否则服务端按 double 存，末尾几位直接丢了。
 *
 * 实测（2026-10-19）：直接写 `6931234567890123456` → 读回 `6.93123E+18`。
 * 前导单引号是表格里"这一格是文本"的老规矩，实测读回**一字不差**；
 * `="…"` 也行，但那会让格子变成公式，用户在 WPS 里再点一下容易懵。
 * 前导零同理（"007" 当数字写就变 7），所以一起保护。
 */
function mcpCellText(v: string): string {
  if (/^\d{15,}$/.test(v)) return `'${v}`;
  if (/^0\d+$/.test(v)) return `'${v}`;
  return v;
}

/** 单次批量写的格数上限。服务端没明说写有多少，按读的 5 万格打个对折留余量 */
const MCP_WRITE_BATCH = 5000;

/** 二维表格：逐行收成 string[]；非数组的行当空行 */
function stringGrid(v: unknown): string[][] {
  if (!Array.isArray(v)) return [];
  return v.map((row) => stringList(row));
}

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
     * gallery.put：内容已在图床里时复用已有记录，不再插一条。
     *
     * 专为「工具的产出默认留一份」这条规则准备 —— 自动存档是替用户保管的，
     * 一次导出可能产生十几张图，不去重的话图床会被同一张图刷屏。
     * 用户**亲手点**存图床时不要传：他要的就是"再留一份"。
     */
    dedupe?: boolean;
    /* task.remind —— 工具代订提醒的参数 */
    /** book（订一条提醒待办）或 cancel（取消本工具订的那条） */
    action?: string;
    /** book：提醒时刻（ISO 或 yyyy-MM-ddTHH:mm，本地时区） */
    dueAt?: string;
    /** book：调用方自己的关联 id（如异常单的行 id），原样记进待办备注 */
    ref?: string;
    /** cancel：要取消的那条待办 id（book 的返回值） */
    taskId?: string;
    /* wps.* —— 绑定文件读写 */
    /** 金山文档分享链接（`https://www.kdocs.cn/l/xxx`），也接受裸 id */
    link?: string;
    /** 绑定文件的节点 id（保存后一定会变，界面要拿返回值更新） */
    kuid?: string;
    /** 原始 doc_type（s / ksheet / w / o）—— 决定写回走哪条路 */
    docType?: string;
    /** 表格：表头 + 数据行（写回时一并发给宿主） */
    header?: string[];
    rows?: string[][];
    /** 绑定对象（知识库那条路的 {kuid,title,doc_type,kind}；MCP 那条路的 {mcp,id,name,kind}） */
    binding?: unknown;
    /* wps.mcp* —— 官方 agent 入口（「我的云文档」直连） */
    /** 要绑定的文件 id（list_my_files 给的那个） */
    fileId?: string;
    /** 文件名（原样存进绑定，写回时靠扩展名判断能不能写） */
    name?: string;
    /** sheet / doc —— 宿主只信扩展名推断与这个的结合 */
    fileKind?: string;
    /** 文档写回模式：replace（整文替换）/ append。工具目前只用 replace */
    mode?: string;
    /** 文档：正文纯文本 */
    text?: string;
    /** wps.mcpPush：true = 只算对账、一格都不写（推送前先看会改掉什么） */
    dryRun?: boolean;
    /** wps.mcpPush：true = 强制同步，表上有本地没有的行会被清空（默认不动） */
    force?: boolean;
    /**
     * wps.mcpPush / mcpPull：这次同步只碰哪个数据库（工具里的多库，v1.19.0）。
     * 空 = 整本台账（老工具不带这个字段，行为不变）。
     */
    dbId?: string;
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
   * 宿主此刻是否为**这个工具**开放图床通道（gallery.*）。
   *
   * 现在是会变的（以前恒为 true）：图床已经改成选装模块，
   * 它关着的时候这儿就是 false。判据有两层 —— 工具在 manifest 里申请过，
   * 并且提供这个能力的模块开着。
   *
   * 它存在的理由仍然成立：**工具与宿主分开**。用户完全可能在宿主没有图床
   * （或图床关着）的情况下装了一个会调 gallery.* 的工具，没有这个标记的话
   * 那种情况只会表现为"点了没反应"或一句含糊的"不支持的操作"。
   * 工具据此把入口置灰、把产物改成下载到本地。
   */
  gallery: boolean;
  /**
   * 宿主是否提供数据表通道（row.* / schema.info）。
   *
   * 老版本的宿主没有这条通道。工具若想在那种宿主上降级（退回 kv 存储），
   * 靠的就是这两个布尔值 —— 否则只能先调一次、看会不会报错。
   */
  data: true;
  /** 宿主是否提供工具联动（tools.*） */
  link: true;
  /**
   * **注入组件**的挂载上下文：它挂在哪、替哪条待办干活。
   *
   * 整页工具没有这个字段（它不和某条待办绑定）。注入组件靠它决定自己
   * 显示什么 —— 同一个组件挂在两条待办上是两个 iframe 实例、
   * 两份 `ctx.inject`，互不干扰。
   *
   * 有了它才需要 `task` 能力：组件只被允许读 `taskId` 指的**那一条**，
   * 不能拿 id 去翻别的（见 task.get 的实现）。
   */
  inject?: { kind: ToolInjectKind; taskId: string };
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

/**
 * 组装工具运行上下文 —— 工具据此显示"我连到哪儿了"。
 *
 * settings 由调用方传进来而不是在这里向 store 取：lib 层不认识 UI 状态，
 * 桥也就能在测试里被单独建起来（给一份普通对象即可）。
 */
export function buildContext(
  toolId: string,
  settings: Record<string, string>,
  inject?: ToolContext["inject"],
): ToolContext {
  const info = dbInfo();
  return {
    toolId,
    // 走 toolPrefix 而不是再拼一遍 —— 前缀规则只有一处定义，见 lib/tools.ts
    tablePrefix: toolPrefix(toolId),
    driver: info.driver,
    schemaVersion: info.schemaVersion,
    theme: currentTheme(),
    runtime: isTauri() ? "desktop" : "browser",
    // 图床是**申请来的**：manifest 里写过、且那个模块开着，才是 true
    gallery: capabilityState(settings, toolId, "gallery") === "on",
    data: true,
    link: true,
    ...(inject ? { inject } : {}),
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
 * 内置工具 → 图床来源标记。
 *
 * **origin 一律由宿主按 tool_id 推断，绝不接受工具传来的值** ——
 * 这是 provenance（产物出处）能不能信的关键。若允许工具自报，
 * 任何一个工具都能把产物伪装成"AI 生成"（那样会带着提示词一起显示），
 * 而"这条图是谁放进来的"正是排查图床问题时唯一可靠的线索。
 *
 * 不认识的自定义工具落到 manual —— 说"用户手动导入的"是诚实的，
 * 因为我们确实不认识它。
 */
const TOOL_ORIGIN: Record<string, ImagebedOrigin> = {
  "ai-gen": "ai-gen",
  "image-crop": "image-crop",
  "size-chart": "size-chart",
  // 订单附图单独一档：图床里能只筛出这批「证据图」，
  // 而不是跟着几十张手动素材混在一起
  "abnormal-ticket": "abnormal-ticket",
};

function originForTool(toolId: string): ImagebedOrigin {
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
 * 300 张约 6 MB，是能接受的上限；不设的话，用户翻一个大图床
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
    // 这里不需要真正的 LRU —— 图床浏览是顺序翻的，不是随机访问）
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
  thumbCache.set(relPath, thumb);
}


/** 把图床条目转成给工具看的形状。**不含仓库路径** —— 工具拿不到路径就无从越界。 */
interface ToolImagebedItem {
  id: string;
  title: string;
  kind: ImagebedKind;
  origin: ImagebedOrigin;
  width: number | null;
  height: number | null;
  size: number | null;
  createdAt: string;
  prompt: string;
  thumb: string;
  /**
   * 这一份内容图床里本来就有（`dedupe` 命中），本次没有新建记录。
   *
   * 工具据此把提示语从"已存进图床"换成"图床里已有这一份" ——
   * 自动存档是静默发生的，用户没点过保存却看到图床条数没变，
   * 不给这句话就会以为存档坏了。
   */
  dup: boolean;
}

async function toToolItem(item: ImagebedItem): Promise<ToolImagebedItem> {
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
    /**
     * 当前设置（能力门要用）。同样是惰性的：每次判断现取，
     * 否则用户在设置里打开图床之后，已经挂着的工具要重启才会看到。
     */
    getSettings?: () => Record<string, string>;
    /**
     * 注入组件的挂载上下文（整页工具不给）。
     *
     * 有了它，`task.get` 才知道该读哪一条 —— 也**只有**它指定的那一条能读：
     * 组件不能拿 id 去翻别人的待办，这就是"注入组件只读当前条目"的边界。
     */
    getInject?: () => ToolContext["inject"];
  },
): ToolBridge {
  const currentSettings = (): Record<string, string> => opts.getSettings?.() ?? {};
  const currentInject = (): ToolContext["inject"] | undefined => opts.getInject?.();
  /**
   * 工具 iframe 的真实 origin。
   *
   * ⚠️ **不能填 `window.location.origin`**。桌面端工具是经 asset 协议加载的
   * （`http://asset.localhost/C%3A%5C…%5Cindex.html`），而宿主页面在
   * `http://tauri.localhost` —— 两者不同源。postMessage 的 targetOrigin 不匹配时
   * 浏览器把整条消息**静默丢弃**：不报错、不告警，宿主以为发了、工具以为没人理。
   * 表现是所有桥操作全部超时（工具 KV 写不进、图床存不进），而同样的代码在
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
        reply(id, true, buildContext(toolId, currentSettings(), currentInject()));
        return;
      }

      /*
       * shell.open —— 唤起本机客户端（自定义协议）。
       *
       * 为什么不放给界面自己 `location.href = "pddim:..."`：
       * 工具跑在 sandbox iframe 里，Chromium 拦下自定义协议导航时会把
       * **整个 iframe** 换成「已阻止此内容」错误页 —— 不只是唤起失败，
       * 工具里还没提交的东西也一起没了（异常单号 1.12.1 的真实事故）。
       *
       * 协议白名单在 Rust（`open_protocol`），这里只做能力门 + 形状检查。
       */
      if (op === "shell.open") {
        const state = capabilityState(currentSettings(), toolId, "shell");
        if (state !== "on") {
          return reply(id, false, `唤起客户端不可用：${capabilityError(state, "shell")}`);
        }
        const url = typeof payload?.url === "string" ? payload.url.trim() : "";
        if (!url) return reply(id, false, "缺少要唤起的链接");
        try {
          await invoke("open_protocol", { url });
          reply(id, true, { url });
        } catch (err) {
          reply(id, false, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      /*
       * task.get —— 注入组件读它挂着的那一条待办。
       *
       * 两道门，缺一不可：
       *   1. manifest 里申请过 `task` 能力（与 gallery 同一套规矩）
       *   2. **此刻确实挂在某条待办上**（整页工具没有上下文，一律拒绝）
       *
       * 第 2 条是"最小权限"的落地：组件拿不到"给我 id X 的待办"这种接口，
       * 它只能读宿主已经决定给它的那一条。想读别的？没有这条路。
       * 返回的是**只读快照**，改待办仍然只能走宿主的界面与助手的日程动作。
       */
      if (op === "task.get") {
        const state = capabilityState(currentSettings(), toolId, "task");
        if (state !== "on") {
          reply(id, false, `读当前待办不可用：${capabilityError(state, "task")}`);
          return;
        }
        const inject = currentInject();
        if (!inject?.taskId) {
          reply(id, false, "这个组件没有挂在任何一条待办上，task.get 只有在注入到详情/行内/详情头部时才有意义");
          return;
        }
        const task = await fetchTaskById(inject.taskId);
        if (!task) {
          reply(id, false, "它挂着的那条待办已经不存在了（可能刚被删除）");
          return;
        }
        reply(id, true, {
          id: task.id,
          title: task.title,
          note: task.note ?? "",
          done: !!task.done,
          important: !!task.important,
          myDay: !!task.myDay,
          dueDate: task.dueDate ?? null,
          remindAt: task.remindAt ?? null,
          listId: task.listId ?? null,
          createdAt: task.createdAt,
        });
        return;
      }

      /*
       * task.remind —— 工具替用户**订一条提醒**。
       *
       * 与 task.get 是一对刻意的反差：
       *   · task.get 是"只读当前这一条"，注入组件专用；
       *   · task.remind 是"往待办里落一条新的"，整页工具就能用 ——
       *     工具自己管着业务数据（如异常单），到点该干什么只有它知道，
       *     但"到点要弹卡"这件事是待办的提醒机制在管。两边各干各的，
       *     中间就缺一座桥：工具订提醒 → 宿主落一条带 remindAt 的待办。
       *
       * 落下来的待办带 originTool（宿主按发请求的 iframe 盖章，工具自报不认），
       * 界面在行上标「来自工具 X」，用户分得清"这条是我建的"还是"工具代订的"。
       * 到点后走的是待办自己的提醒机制（右下角卡片、可完成/推迟），与手建待办
       * 完全一致 —— 工具不需要、也不允许自己再造一套提醒队列。
       *
       * 边界刻意收窄：
       *   · 只能**新建**（title/dueAt/note 由工具给，myDay/important 不开放），
       *     不能改已有的、不能按 id 读别人的待办 —— 写入口子开得越窄越好；
       *   · cancel 只认**本工具**订的那条（按 originTool 比对），不能替别人删；
       *   · 重复 book 由调用方（工具）自己先 cancel 旧的 —— 宿主不猜"哪条算同一个提醒"。
       */
      if (op === "task.remind") {
        const state = capabilityState(currentSettings(), toolId, "task");
        if (state !== "on") {
          reply(id, false, `工具提醒不可用：${capabilityError(state, "task")}`);
          return;
        }

        if (payload?.action === "cancel") {
          const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
          if (!taskId) return reply(id, false, "cancel 缺少 taskId（book 回给你的那条待办 id）");
          const t = await fetchTaskById(taskId);
          if (!t) {
            // 那条已经不存在了（用户自己删了/完成了）。取消的目的是"别再提醒"，
            // 目的已达成 —— 回 ok 让工具把本地状态清掉，而不是报一个吓人的错。
            return reply(id, true, { taskId, deleted: false, gone: true });
          }
          if (t.originTool !== toolId) {
            return reply(id, false, "那条待办不是本工具订的提醒，不能替别人删");
          }
          await deleteTask(taskId);
          notifyTasksChanged();
          return reply(id, true, { taskId, deleted: true });
        }

        // 默认（以及任何不是 "cancel" 的 action）都按 book 处理 —— 参数只有一组，
        // 不必让工具再传 action: "book"。
        const title = typeof payload?.title === "string" ? payload.title.trim() : "";
        if (!title) return reply(id, false, "缺少 title（提醒落在待办上要显示的那句话）");
        if (title.length > 200) {
          return reply(id, false, `title 超过 200 字（收到 ${title.length} 个）—— 提醒是一行标题，请写短一点`);
        }
        const rawDue = typeof payload?.dueAt === "string" ? payload.dueAt.trim() : "";
        const due = rawDue ? new Date(rawDue) : null;
        if (!due || isNaN(due.getTime())) {
          return reply(id, false, "dueAt 要是一个合法时刻（ISO 字符串，或 yyyy-MM-ddTHH:mm）");
        }
        const note = typeof payload?.note === "string" ? payload.note.slice(0, 1000) : "";
        const ref = typeof payload?.ref === "string" ? payload.ref.slice(0, 64) : "";

        // 落哪个清单：用第一个；一个都没有（全新库）就建「个人」——
        // 与助手建日程同一套兜底，用户不用先去建清单才能订提醒。
        const lists = await fetchLists();
        const list = lists[0] ?? (await createList("个人"));
        const remindAt = due.toISOString();
        // ref 不单独存列（待办没有这个概念），拼进备注，将来要认账时搜得到
        const fullNote = ref
          ? note
            ? `${note}\n来源引用：${ref}`
            : `来源引用：${ref}`
          : note;

        const task = await createTask({
          listId: list.id,
          title,
          note: fullNote,
          remindAt,
          originTool: toolId, // ★ 来源由宿主盖章；工具传什么都不看
        });
        notifyTasksChanged();
        return reply(id, true, {
          taskId: task.id,
          listId: list.id,
          listName: list.name,
          remindAt,
        });
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

      /* ---------------- 图床 ----------------
       * 安全性说明见文件头「gallery.* —— 一次有意识的边界放宽」。
       * 三处共同点：工具只能传 id / 内容，**永远传不了路径**。 */

      // 能力门：图床是**申请来的**服务，不是工具装上了就自动有的。
      // 回绝不抛异常而是给一句有方向的错 —— 工具要能据此降级
      // （把产物改成下载到本地），而不是弹一个"失败"了事。
      // 三态而不是布尔，是因为工具作者需要知道该去改自己还是去开模块。
      if (op === "gallery.list" || op === "gallery.get" || op === "gallery.put") {
        const state = capabilityState(currentSettings(), toolId, "gallery");
        if (state !== "on") {
          return reply(id, false, `图床通道不可用：${capabilityError(state, "gallery")}`);
        }
      }

      if (op === "gallery.list") {
        const rawKind = payload?.kind;
        const kind: ImagebedKind | "all" =
          rawKind === "image" || rawKind === "video" ? rawKind : "all";

        // 夹在 1..GALLERY_LIST_MAX 之间：不限的话，工具传个 999999
        // 就意味着宿主要把一整个图床（连缩略图）全生成出来再塞进一条消息
        const wanted = Math.floor(Number(payload?.limit) || GALLERY_LIST_DEFAULT);
        const limit = Math.min(GALLERY_LIST_MAX, Math.max(1, wanted));

        const items = await fetchImagebed({
          kind,
          search: typeof payload?.search === "string" ? payload.search : "",
          limit,
        });
        const shaped: ToolImagebedItem[] = [];
        // 串行而不是 Promise.all：一次并行几十张图的解码会把主线程压满，
        // 界面上表现为"点了图床之后整个工作台卡一下"。串行多花的时间
        // 被缓存摊掉了（同一个图床第二次打开直接命中）
        for (const it of items) shaped.push(await toToolItem(it));

        return reply(id, true, { items: shaped, limit, count: shaped.length });
      }

      if (op === "gallery.get") {
        const gid = payload?.id;
        if (typeof gid !== "string" || !gid) return reply(id, false, "缺少 id 参数");

        const item = await getImagebedItem(gid);
        if (!item) return reply(id, false, "这条记录不在图床里（可能已被删除）");

        const { dataUrl, mime } = await readImagebedDataUrl(item, GALLERY_READ_MAX);
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
        // 也正因为要下载，**必须先落盘再入库**，见 lib/imagebed.ts 的顺序约定。
        //
        // 单条读取有字节上限，写入同样有 —— 上限在 addToImagebed 里按媒体类型判。
        const item = await addToImagebed({
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

        // 图床界面若正开着，让它自己刷新（见 lib/imagebed.ts 的 IMAGEBED_CHANGED）
        notifyImagebedChanged();
        return reply(id, true, await toToolItem(item));
      }

      /* ------------------------------ WPS 绑定文件 ------------------------------
       * 工具只传 kuid / 标题 / 内容：令牌和知识库都从宿主设置里现取
       * （见 lib/wpsLink.ts），工具永远碰不到 kwiki.token。
       * 能力门是必须的 —— 写回会借用户的账号在知识库里"新建 → 删旧 → 改名"。 */
      if (
        op === "wps.files" ||
        op === "wps.bindLink" ||
        op === "wps.fileRead" ||
        op === "wps.fileWrite" ||
        op === "wps.mcpProbe" ||
        op === "wps.mcpFiles" ||
        op === "wps.mcpBind" ||
        op === "wps.mcpRead" ||
        op === "wps.mcpDocWrite" ||
        op === "wps.mcpSheetWrite" ||
        op === "wps.mcpLink" ||
        op === "wps.mcpPush" ||
        op === "wps.mcpPull" ||
        op === "wps.mcpApply"
      ) {
        const state = capabilityState(currentSettings(), toolId, "wps");
        if (state !== "on") {
          return reply(id, false, `WPS 读写不可用：${capabilityError(state, "wps")}`);
        }
        const settings = currentSettings();

        if (op === "wps.files") {
          return reply(id, true, { files: await listBindable(settings) });
        }
        if (op === "wps.bindLink") {
          const link = typeof payload?.link === "string" ? payload.link : "";
          return reply(id, true, { binding: await bindByLink(link, settings) });
        }

        /* ---------------- wps.mcp* —— 官方 agent 入口 ----------------
         * 比知识库那条路多一道门：用户必须在设置里按过「确认启用」。
         * 授权成功 ≠ 同意 —— 这个令牌能碰的是全部云文档。 */
        if (
          op === "wps.mcpProbe" ||
          op === "wps.mcpLink" ||
          op === "wps.mcpFiles" ||
          op === "wps.mcpBind" ||
          op === "wps.mcpRead" ||
          op === "wps.mcpDocWrite" ||
          op === "wps.mcpSheetWrite" ||
          op === "wps.mcpPush" ||
          op === "wps.mcpPull" ||
          op === "wps.mcpApply"
        ) {
          /* 分享链接 → 文件信息。**不需要令牌**（匿名只读元数据），
           * 所以放在令牌检查之前 —— 用户还没授权时也能先把表认下来。 */
          if (op === "wps.mcpLink") {
            const link = typeof payload?.link === "string" ? payload.link.trim() : "";
            if (!link) return reply(id, false, "先粘贴一条 WPS 授权的分享链接");
            const info = await invoke<{
              link_id: string;
              file_id: string;
              name: string;
              kind: string;
              owner: string;
              permission: string;
              group_name: string;
            }>("wps_link_info", { link });
            if (!info.file_id) {
              return reply(id, false, "这条链接没解析出文件 —— 确认它还在分享中");
            }
            if (info.kind !== "sheet") {
              return reply(
                id,
                false,
                `「${info.name}」不是表格（认出来是 ${info.kind}）—— 台账要接在表格上`,
              );
            }
            return reply(id, true, {
              file: {
                id: info.file_id,
                name: info.name,
                linkId: info.link_id,
                permission: info.permission,
                owner: info.owner,
              },
            });
          }

          const mcpToken = String(settings[SETTINGS.wpsMcpToken] || "").trim();
          const mcpClientId = String(settings[SETTINGS.wpsMcpClientId] || "").trim();
          if (!mcpToken || !mcpClientId) {
            return reply(id, false, "还没连接 WPS MCP —— 去 设置 → WPS 授权 完成授权");
          }
          if (settings[SETTINGS.wpsMcpEnabled] !== "1") {
            return reply(id, false, "WPS MCP 未启用 —— 在 设置 → WPS 授权 里按「确认启用」");
          }

          if (op === "wps.mcpProbe") {
            const r = await mcpProbe(mcpToken, mcpClientId);
            return reply(id, true, { server: { name: r.server || "SkillHub MCP", tools: r.tools } });
          }

          if (op === "wps.mcpFiles") {
            // 翻页拿全根目录（每页 50，最多 8 页 —— 400 份文件对"挑一份绑定"足够了）
            const files: Array<{ id: string; name: string; mtime: number; ftype: string }> = [];
            let pageToken = "";
            for (let i = 0; i < 8; i++) {
              const args: Record<string, unknown> = { page_size: 50 };
              if (pageToken) args.page_token = pageToken;
              const data = mcpBiz(await mcpBridgeTool("list_my_files", args, mcpToken, mcpClientId));
              for (const raw of mcpArr(data.items)) {
                const it = mcpObj(raw);
                const fid = String(it.id ?? "");
                const fname = String(it.name ?? "");
                if (!fid || !fname) continue;
                files.push({
                  id: fid,
                  name: fname,
                  mtime: Number(it.mtime ?? 0) || 0,
                  // 服务端的 type 就是 "folder" / "file"，工具按 ftype==="folder" 分流
                  ftype: String(it.type ?? "file"),
                });
              }
              pageToken = String(data.next_page_token ?? "");
              if (!pageToken) break;
            }
            return reply(id, true, { files });
          }

          if (op === "wps.mcpBind") {
            // 绑定只是记一笔（文件 id + 名字 + 类型），不碰网络。
            // 令牌在宿主手里，工具拿着 binding 也只能通过桥读
            const fileId = typeof payload?.fileId === "string" ? payload.fileId.trim() : "";
            const name = typeof payload?.name === "string" ? payload.name.trim() : "";
            const fileKind = payload?.fileKind === "doc" ? "doc" : "sheet";
            if (!fileId) return reply(id, false, "缺少 fileId（要绑定哪份文件）");
            if (!name) return reply(id, false, "缺少文件名");
            return reply(id, true, { binding: { mcp: true, id: fileId, name, kind: fileKind } });
          }

          if (op === "wps.mcpRead") {
            const b = mcpObj(payload?.binding);
            const fileId = String(b.id ?? "").trim();
            const fname = String(b.name ?? "");
            if (!fileId) return reply(id, false, "绑定里没有文件 id —— 重新绑定一次");

            if (b.kind === "doc") {
              // 文档（智能文档 / docx / md…）：read_file 直接给 markdown 正文
              const data = mcpBiz(
                await mcpBridgeTool("read_file", { file_id: fileId, format: "markdown" }, mcpToken, mcpClientId),
              );
              return reply(id, true, {
                doc: { kind: "doc", text: String(data.content ?? "") },
              });
            }

            // 表格：先探表（顺便拿到已用范围），再读选区拼网格
            if (/\.dbt$/i.test(fname)) {
              return reply(id, false, "多维表格(.dbt)暂时不能在这里打开 —— 它要先选表，等下一版接 dbsheet 那组工具");
            }
            const info = mcpObj(
              mcpBiz(await mcpBridgeTool("sheet.get_sheets_info", { file_id: fileId }, mcpToken, mcpClientId)).detail,
            );
            const sheets = mcpArr(info.sheetsInfo).map(mcpObj);
            const sheet = sheets[0];
            if (!sheet) return reply(id, false, "这份表格没有可见的工作表");
            // 已用范围（sheetsInfo 给的就是非空边界），再卡到桥的序列化上限内
            const rowTo = Math.min(Number(sheet.rowTo ?? 0) || 0, MCP_SHEET_MAX_ROWS - 1);
            const colTo = Math.min(Number(sheet.colTo ?? 0) || 0, MCP_SHEET_MAX_COLS - 1);
            const detail = mcpObj(
              mcpBiz(
                await mcpBridgeTool(
                  "sheet.get_range_data",
                  {
                    file_id: fileId,
                    worksheet_id: Number(sheet.sheetId ?? 0),
                    range: { rowFrom: 0, rowTo, colFrom: 0, colTo },
                  },
                  mcpToken,
                  mcpClientId,
                ),
              ).detail,
            );
            const grid = mcpAssembleGrid(mcpArr(detail.rangeData), rowTo, colTo);
            return reply(id, true, {
              doc: {
                kind: "sheet",
                sheet: String(sheet.sheetName ?? ""),
                header: grid[0] ?? [],
                rows: grid.slice(1),
              },
            });
          }

          /* 表格整块写回。
           *
           * 官方入口这条路**能写** —— 工具界面上写"只能读"是它自己的判断，
           * 不是服务端限制（`Agent测试表` 里的值就是 agent 写进去的）。
           * 两个必须处理对的地方：
           *   1. 格子变少时，多出来的旧格要**显式写空串** —— 只写新内容的话
           *      表里会留着上一版的尾巴（实测写 "" 确实能清掉）。
           *   2. 15 位以上的数字（订单号）必须当文本写，否则被 double 吃掉末尾。
           */
          if (op === "wps.mcpSheetWrite") {
            const sb = mcpObj(payload?.binding);
            const sFileId = String(sb.id ?? "").trim();
            if (!sFileId) return reply(id, false, "绑定里没有文件 id —— 重新绑定一次");
            const header = stringList(payload?.header);
            const rows = stringGrid(payload?.rows);
            if (!header.length && !rows.length) {
              return reply(id, false, "没有要保存的内容（表头和数据都是空的）");
            }
            if (rows.length > WPS_WRITE_MAX_ROWS) {
              return reply(id, false, `行数超过上限（最多 ${WPS_WRITE_MAX_ROWS} 行）`);
            }

            // ① 探表：绑定里只有表名，worksheet_id 得现查；顺带拿到旧的已用范围
            const sInfo = mcpObj(
              mcpBiz(
                await mcpBridgeTool("sheet.get_sheets_info", { file_id: sFileId }, mcpToken, mcpClientId),
              ).detail,
            );
            const sheets = mcpArr(sInfo.sheetsInfo).map(mcpObj);
            const want = String(sb.sheet ?? "").trim();
            const sheet = sheets.find((s) => String(s.sheetName ?? "") === want) ?? sheets[0];
            if (!sheet) return reply(id, false, "这份表格没有可见的工作表");
            const sheetId = Number(sheet.sheetId ?? 0);
            const oldRowTo = Math.max(Number(sheet.rowTo ?? 0) || 0, 0);
            const oldColTo = Math.max(Number(sheet.colTo ?? 0) || 0, 0);

            // ② 新旧取大：新内容覆盖到哪写到哪，旧内容多出来的那些格补空串
            const grid = [header, ...rows];
            const nCols = grid.reduce((m, r) => Math.max(m, r.length), 0);
            const rowEnd = Math.min(Math.max(grid.length - 1, oldRowTo), MCP_SHEET_MAX_ROWS - 1);
            const colEnd = Math.min(Math.max(nCols - 1, oldColTo), MCP_SHEET_MAX_COLS - 1);
            const ops: Array<Record<string, unknown>> = [];
            for (let r = 0; r <= rowEnd; r++) {
              const line = grid[r] ?? [];
              for (let c = 0; c <= colEnd; c++) {
                const v = line[c] ?? "";
                ops.push({
                  opType: "formula",
                  rowFrom: r,
                  rowTo: r,
                  colFrom: c,
                  colTo: c,
                  formula: v === "" ? "" : mcpCellText(v),
                });
              }
            }

            // ③ 分批下发（一次几万格会让请求变大、失败就得整批重来）
            for (let i = 0; i < ops.length; i += MCP_WRITE_BATCH) {
              mcpBiz(
                await mcpBridgeTool(
                  "sheet.update_range_data",
                  {
                    file_id: sFileId,
                    worksheet_id: sheetId,
                    rangeData: ops.slice(i, i + MCP_WRITE_BATCH),
                  },
                  mcpToken,
                  mcpClientId,
                ),
              );
            }
            return reply(id, true, { result: { wrote: ops.length } });
          }

          /* ---------------- 台账同步（工具侧入口） ----------------
           * 这三个 op 是「异常单号登记」自己那张设置卡用的，与设置页的推/拉
           * 走同一条路 —— 差别只在于 file_id 由工具带来（工具自己记绑定），
           * 不再读设置里的 `wps.mcp.ledgerFile`。 */

          if (op === "wps.mcpPush") {
            const pb = mcpObj(payload?.binding);
            const pFileId = String(pb.id || payload?.fileId || "").trim();
            const pSheet = sheetOf(payload?.binding) || sheetOf(payload);
            if (!pFileId) return reply(id, false, "还没绑定表格 —— 先在工具设置里粘一条分享链接");
            /* v1.19.0：只推**当前这个库**的单子。工具可以建多个库、各绑一张表，
               不按库筛就等于把别的库的单子也写进这张表。 */
            const pDbId = String(payload?.dbId ?? "").trim();
            const rows = await readLedger(pDbId || undefined);
            if (!rows.length) return reply(id, false, "这个数据库里一条异常单都没有 —— 先登记几例再推");
            // dryRun：先算一遍对账（会覆盖几行、会清空几行），一格都不写。
            // 工具拿到这两个数字，要删东西时先问一句再真推。
            const dry = payload?.dryRun === true;
            const force = payload?.force === true;
            const r = await mcpSheetPush(
              pFileId,
              pSheet,
              // 时间列先统一成「YYYY-MM-DD HH:mm」：老数据的 ISO 摆进表里
              // 既刺眼又是 UTC 时刻（差 8 小时），见 kwiki.sheetRows
              sheetRows(rows) as unknown as Array<Record<string, unknown>>,
              mcpToken,
              mcpClientId,
              dry,
              force,
            );
            return reply(id, true, {
              count: r.count,
              appended: r.appended,
              added: r.added,
              changed: r.changed,
              orphanRows: r.orphan_rows,
              removed: r.removed,
              dryRun: r.dry_run,
              // 逐条明细（表上原值 → 本机值）：确认框要把"改哪几格"摊开
              diffs: r.diffs,
            });
          }

          if (op === "wps.mcpPull") {
            const gb = mcpObj(payload?.binding);
            const gFileId = String(gb.id || payload?.fileId || "").trim();
            const gSheet = sheetOf(payload?.binding) || sheetOf(payload);
            if (!gFileId) return reply(id, false, "还没绑定表格 —— 先在工具设置里粘一条分享链接");
            const res = await mcpSheetPull(gFileId, gSheet, mcpToken, mcpClientId);
            // 只跟**当前这个库**的本地行比对（同上：多库不筛会串味）
            const gDbId = String(payload?.dbId ?? "").trim();
            const local = await readLedger(gDbId || undefined);
            const plan = planPull(res.rows as unknown as Parameters<typeof planPull>[0], local);
            // 计划留在宿主：工具拿不到令牌也碰不到数据库，传回去再传回来只是
            // 多一次"工具可以伪造写库内容"的机会
            pendingPull = plan;
            pendingPullDb = gDbId;
            return reply(id, true, {
              header: res.header,
              adds: plan.adds.map(pullBrief),
              updates: plan.updates.map((u) => ({
                ...pullBrief(u.row),
                changes: Object.keys(u.patch),
                // 字段级明细：表上是什么 → 会写成什么。只给 changes 那几个列名
                // 的话，人还是得自己去表上找那一格对，等于没说。
                diffs: Object.keys(u.patch).map((c) => ({
                  col: c,
                  label: columnLabel(c),
                  from: String(u.row[c] ?? ""),
                  to: u.patch[c],
                })),
              })),
            });
          }

          if (op === "wps.mcpApply") {
            if (!pendingPull) return reply(id, false, "没有待写入的结果 —— 先点「拉取」");
            const plan = pendingPull;
            const planDb = pendingPullDb;
            pendingPull = null;
            pendingPullDb = "";
            const r = await applyPull(plan, planDb || undefined);
            return reply(id, true, r);
          }

          // wps.mcpDocWrite：整段写回，只开给智能文档（服务端就这一个整文替换入口）
          const wb = mcpObj(payload?.binding);
          const wFileId = String(wb.id ?? "").trim();
          const wName = String(wb.name ?? "");
          const text = typeof payload?.text === "string" ? payload.text : "";
          const mode = payload?.mode === "append" ? "append" : "replace";
          if (!wFileId) return reply(id, false, "绑定里没有文件 id —— 重新绑定一次");
          if (!text) return reply(id, false, "没有要保存的正文");
          if (text.length > WPS_WRITE_MAX_TEXT) {
            return reply(id, false, `正文超过上限（最多 ${WPS_WRITE_MAX_TEXT} 字）`);
          }
          if (!mcpDocWritable(wName)) {
            return reply(id, false, `.${wName.split(".").pop() || "?"} 暂不支持整段写回 —— WPS 的写回入口只开了智能文档(.otl)`);
          }
          mcpBiz(
            await mcpBridgeTool(
              "otl.insert_content",
              { file_id: wFileId, content: text, format: "markdown", mode },
              mcpToken,
              mcpClientId,
            ),
          );
          return reply(id, true, { result: {} });
        }


        const kuid = typeof payload?.kuid === "string" ? payload.kuid.trim() : "";
        const title = typeof payload?.title === "string" ? payload.title : "";
        const docType = typeof payload?.docType === "string" ? payload.docType : "";
        if (!kuid) return reply(id, false, "缺少 kuid（要读写哪份文件）");
        const binding = { kuid, title, doc_type: docType, kind: "" };

        if (op === "wps.fileRead") {
          return reply(id, true, { doc: await readBoundFile(binding, settings) });
        }

        // 写回：工具是外部输入，先把形状与体积卡住，别让它把宿主撑爆
        const header = stringList(payload?.header);
        const rows = stringGrid(payload?.rows);
        const text = typeof payload?.text === "string" ? payload.text : "";
        if (!header.length && !text) {
          return reply(id, false, "没有要保存的内容（表头 / 正文都是空的）");
        }
        if (rows.length > WPS_WRITE_MAX_ROWS) {
          return reply(id, false, `行数超过上限（最多 ${WPS_WRITE_MAX_ROWS} 行）`);
        }
        if (text.length > WPS_WRITE_MAX_TEXT) {
          return reply(id, false, `正文超过上限（最多 ${WPS_WRITE_MAX_TEXT} 字）`);
        }
        return reply(id, true, { result: await writeBoundFile(binding, { header, rows, text }, settings) });
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
    // 注入组件的挂载上下文要跟着一起推 —— 漏了它的症状是"组件永远停在
    // 等上下文"，而界面上看着一切正常（iframe 挂着、也没报错）
    pushContext: () =>
      post({
        source: HOST_SOURCE,
        type: "tool:context",
        data: buildContext(toolId, currentSettings(), currentInject()),
      }),
    postEvent: (event: string, data: unknown) =>
      post({ source: HOST_SOURCE, type: "tool:event", event, data }),
    postIntent: (data: unknown, from: string | null) =>
      post({ source: HOST_SOURCE, type: "tool:intent", data, from }),
  };
}
