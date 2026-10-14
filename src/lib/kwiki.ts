/**
 * WPS 知识库（kwiki）在线表格 —— 台账联动的**编排层**。
 *
 * 分工：传输全在 Rust 侧（`src-tauri/src/wps.rs`：设备码登录、知识库/文件列表、
 * 上传、下载，以及 xlsx 的构建与解析）。浏览器跨不过 zhishi.wps.cn 的 CORS，
 * 所以这条路**天生只属于桌面版** —— 每个函数进门都先查 isTauri()，
 * 网页端明确报错而不是静默失败。
 *
 * 这一层只做三件事：
 *   1. 列定义与状态派生（推上去的表头、拉回来的映射都靠它）；
 *   2. 行怎么比对（拉取时哪些算新增、哪些算改动）；
 *   3. 写库怎么写（走应用自己的事务，写完通知工具刷新）。
 *
 * ⚠️ 与 `.workbuddy/sync-ledger.py`（手动同步脚本）是**同一套算法的两个拷贝**，
 * 与 `src-tauri/src/wps.rs` 的 COLUMNS 也是同一份约定的两个拷贝。用户要的是
 * "程序自己完成"，那份脚本是蓝本 —— 列顺序、状态口径、比对锚点必须逐条一致，
 * 否则推上去的表头和拉回来的映射会对不上。改一处，三处一起改。
 */

import { invoke } from "@tauri-apps/api/core";
import { db, isTauri } from "./db";
import { HOST_SOURCE } from "./toolBridge";
import { postToTool } from "./toolLink";
import { getTool, toolTable } from "./tools";
import { ensureToolSchema, validateToolSchema } from "./toolSchema";
import { SETTINGS } from "./settings";

/* ------------------------------------------------------------------ */
/* 常量：工具、表、事件                                                  */
/* ------------------------------------------------------------------ */

/** 台账住在哪个工具里。写死而不是从设置读：联动就是给这一个工具做的 */
export const LEDGER_TOOL_ID = "abnormal-ticket";
/** 该工具私有表的名字（不带前缀） */
const LEDGER_TABLE = "tickets";

/**
 * 拉取写库后发给工具的事件名。
 *
 * 与工具已有的 `schema:reset`（设置页清数据时发）同一个通道、同一种命名风格。
 * 少了它，数据库明明写进去了，工具界面还摆着旧列表 —— 两种真相对不上，
 * 是最容易让人以为"同步没生效"的场景。
 */
export const KWIKI_PULLED_EVENT = "kwiki:pulled";

/**
 * 台账列：左边是 SQLite 列名，右边是在线表格里的表头（顺序即列顺序）。
 *
 * ⚠️ 与 `src-tauri/src/wps.rs` 的 COLUMNS、sync-ledger.py 的 COLUMNS
 * 是同一份约定的三个拷贝。`_status`（当前状态）是**派生列**：推上去给人看，
 * 拉回来时不写库（见 PULL_SKIP）。
 */
export const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["order_sn", "订单号"],
  ["tracking_no", "快递单号"],
  ["courier", "快递公司"],
  ["shipped_at", "发货时间"],
  ["store", "店铺"],
  ["category", "情况"],
  ["title", "详细描述"],
  ["handling", "处理方式"],
  ["result", "结果"],
  ["settled", "结账"],
  ["_status", "当前状态"],
  ["note", "处理情况"],
  ["created_at", "登记时间"],
  ["updated_at", "更新时间"],
];

/**
 * 拉取时**不回写**的列。
 *
 *   · `id` 是本机主键，对面的行没有这个概念（按订单号/快递单号认人）；
 *   · `_status` 是派生列（flow/handling/result 算出来的），写它等于把
 *     一个会变的展示值钉成事实，下次本地一改流程就对不上；
 *   · `created_at` 保留本机首次登记的时刻（对面的登记时间只是参考）；
 *   · `flow` / `remind_at` / `remind_task` 是本地结构（流程轨迹、提醒待办），
 *     对面表格里没有对应列，硬写会造出幽灵数据。
 */
const PULL_SKIP = new Set([
  "id",
  "_status",
  "created_at",
  "updated_at",
  "flow",
  "remind_at",
  "remind_task",
]);

/* ------------------------------------------------------------------ */
/* 类型（与 Rust 侧命令的出入参一一对应，字段名是 Rust 结构体原名）        */
/* ------------------------------------------------------------------ */

export type LedgerRow = Record<string, string>;

export type WpsLogin = { device_code: string; login_url: string };
export type WpsLoginState = { status: "waiting" | "ok"; token: string; message: string };
export type WpsAccount = { token: string; expires_in: number; is_personal: boolean };
export type WpsSpace = { kuid: string; drive_id: string; name: string };
export type WpsFile = { kuid: string; title: string; doc_type: string; size: number };
export type WpsPushResult = { count: number; file_kuid: string };
export type WpsPull = { file_kuid: string; header: string[]; rows: LedgerRow[] };

/** 拉取计划：将要新增的行、将要改动的行（改动只带差异列） */
export type PullPlan = {
  adds: LedgerRow[];
  updates: Array<{ row: LedgerRow; patch: Record<string, string> }>;
};

/* ------------------------------------------------------------------ */
/* 状态派生与比对锚点（与工具里的 statusOf / keyOf 同一套口径）            */
/* ------------------------------------------------------------------ */

/** 解析流程 JSON。坏数据一律当没记过流程 —— 与工具里 parseFlow 一致 */
function parseFlow(raw: unknown): Array<{ n: string; t: string }> {
  try {
    const arr = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s: unknown) => {
        const step = s as { n?: unknown };
        return step && typeof step.n === "string" && step.n.trim();
      })
      .map((s: { n: unknown; t?: unknown }) => ({ n: String(s.n).trim(), t: String(s.t ?? "") }));
  } catch {
    return [];
  }
}

/**
 * 当前状态：记了流程看**最后一步**的名称（流程是用户亲手记的轨迹，最诚实）；
 * 没记过流程才派生 —— 补了结果 → 已关闭，补了处理方式 → 处理中，否则待处理。
 */
export function statusOf(row: Partial<LedgerRow>): string {
  const fl = parseFlow(row.flow);
  if (fl.length) return fl[fl.length - 1].n;
  if (String(row.result ?? "").trim()) return "已关闭";
  if (String(row.handling ?? "").trim()) return "处理中";
  return "待处理";
}

/** 两边比对的锚点：订单号优先，没有就用快递单号（与登记时的校验一致） */
export function keyOf(row: Partial<LedgerRow>): string {
  return String(row.order_sn ?? "").trim() || String(row.tracking_no ?? "").trim();
}

const txt = (v: unknown): string => (v == null ? "" : String(v));

/* ------------------------------------------------------------------ */
/* 读本地台账                                                          */
/* ------------------------------------------------------------------ */

/**
 * 确保工具的私有表在，返回完整表名。
 *
 * 桌面端默认**一个内置工具都不带**（0.2.0 起刻意如此），表也就跟着不存在。
 * 能从注册表拿到 manifest 就按它自己的 schema 建一次（结构与工具里逐字一致），
 * 拿不到才报错 —— 报错也要说清楚缺什么，别让用户对着一个空表发呆。
 */
async function ensureLedgerTable(): Promise<string> {
  const name = toolTable(LEDGER_TOOL_ID, LEDGER_TABLE);
  const tool = getTool(LEDGER_TOOL_ID);
  if (tool) {
    const schema = validateToolSchema(tool.id, tool.schema);
    if (schema) await ensureToolSchema(tool.id, tool.dbVersion, schema);
  }
  const have = await db().tableNames();
  if (!have.includes(name)) {
    throw new Error("本地还没有异常单号登记的表格 —— 先到 设置 → 工具 里把这个工具装回来");
  }
  return name;
}

/**
 * 读本地台账（只读）。
 *
 * 返回**整行**（含 `id`、`flow`、`remind_*` 这些不在 COLUMNS 里的列）：
 *   · `id` 是拉取更新时的 WHERE 条件，少了它更新会静默匹配不到任何行；
 *   · `flow` 服务于本地的 `_status` 派生。
 * 推送给 Rust 时多带的键无所谓 —— build_xlsx 只按 COLUMNS 取键。
 */
export async function readLedger(): Promise<LedgerRow[]> {
  const table = await ensureLedgerTable();
  const rows = await db().select<Record<string, unknown>>(
    `SELECT * FROM ${table} ORDER BY created_at DESC`,
  );
  return rows.map((r) => {
    const row: LedgerRow = {};
    for (const [k, v] of Object.entries(r)) row[k] = txt(v);
    row._status = statusOf(row);
    return row;
  });
}

/* ------------------------------------------------------------------ */
/* 拉取：比对与写库                                                     */
/* ------------------------------------------------------------------ */

/**
 * 拿在线表格的行和本地比对，算出该新增什么、该改什么。
 *
 * 只**预览不写**由调用方决定（设置页要先给用户看一遍差异再确认）——
 * 写库是不可逆的，而"它会改我哪些单子"必须在使用前看得见。
 */
export function planPull(remote: LedgerRow[], local: LedgerRow[]): PullPlan {
  const lmap = new Map<string, LedgerRow>();
  for (const row of local) {
    const k = keyOf(row);
    if (k) lmap.set(k, row);
  }

  const adds: LedgerRow[] = [];
  const updates: PullPlan["updates"] = [];
  for (const row of remote) {
    const k = keyOf(row);
    if (!k) continue; // 订单号、快递单号都没有 —— 与登记校验同一个口径，不当数据
    const mine = lmap.get(k);
    if (!mine) {
      adds.push(row);
      continue;
    }
    const patch: Record<string, string> = {};
    for (const [col] of COLUMNS) {
      if (PULL_SKIP.has(col)) continue;
      const v = txt(row[col]).trim();
      // 空值不当"改动"：对面空格子可能只是没填，把它写过来会抹掉本地已有的值
      if (v && v !== txt(mine[col]).trim()) patch[col] = v;
    }
    if (Object.keys(patch).length) updates.push({ row: mine, patch });
  }
  return { adds, updates };
}

/** 新行的主键生成规则，与工具里 add() 逐字一致（否则两边 id 格式会分叉） */
function newId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把拉取计划写进数据库，然后通知工具刷新。
 *
 * 走 `db().transaction` 而不是逐条 execute：新增和改动静是一件事，
 * 写一半停下的后果是"台账多出半页"。事务必须整体成功或整体没有
 * （理由见 db.ts 里 transaction 的注释：IPC 分四次会落不同连接）。
 */
export async function applyPull(plan: PullPlan): Promise<{ added: number; updated: number }> {
  const table = await ensureLedgerTable();
  const now = new Date().toISOString();
  const statements: Array<{ sql: string; params?: Array<string | number | null> }> = [];

  for (const row of plan.adds) {
    const vals: Record<string, string> = {};
    for (const [col] of COLUMNS) if (col !== "_status") vals[col] = txt(row[col]).trim();
    vals.id = newId();
    // 对面的登记时间只是参考：没有就按现在算，updated_at 一律落到本次同步的时刻
    vals.created_at = vals.created_at || now;
    vals.updated_at = now;
    vals.flow = "";
    vals.remind_at = "";
    vals.remind_task = "";
    const cols = Object.keys(vals);
    statements.push({
      sql: `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      params: cols.map((c) => vals[c]),
    });
  }

  for (const { row, patch } of plan.updates) {
    const cols = [...Object.keys(patch), "updated_at"];
    statements.push({
      sql: `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(",")} WHERE id = ?`,
      params: [...cols.map((c) => (c === "updated_at" ? now : patch[c])), row.id],
    });
  }

  if (statements.length) await db().transaction(statements);

  // 工具要是开着，让它自己重拉一次。没开着也无妨：下次打开就是新数据
  // （postToTool 的返回值就是"投出去没有"，这里不需要判断 —— 刷新是锦上添花）。
  postToTool(LEDGER_TOOL_ID, {
    source: HOST_SOURCE,
    type: "tool:event",
    event: KWIKI_PULLED_EVENT,
    data: { added: plan.adds.length, updated: plan.updates.length },
  });

  return { added: plan.adds.length, updated: plan.updates.length };
}

/* ------------------------------------------------------------------ */
/* Rust 命令包装（每条都带 isTauri 门禁）                                */
/* ------------------------------------------------------------------ */

/** 网页端一句话说明白：这条路跨不过 CORS，只有桌面版能做 */
function desktopOnly(): never {
  throw new Error("WPS 在线表格联动只在桌面版里可用 —— 网页端跨不过 WPS 的跨域限制");
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null || v === "") throw new Error(what);
  return v;
}

/** 生成设备码，拿到用户要打开的授权网址 */
export async function loginStart(): Promise<WpsLogin> {
  if (!isTauri()) desktopOnly();
  return invoke<WpsLogin>("wps_login_start");
}

/** 轮询授权结果。`waiting` = 用户还没点同意（不是错误） */
export async function loginPoll(deviceCode: string): Promise<WpsLoginState> {
  if (!isTauri()) desktopOnly();
  return invoke<WpsLoginState>("wps_login_poll", { deviceCode });
}

/** 查令牌状态（剩余有效期、是不是个人账号） */
export async function accountInfo(token: string): Promise<WpsAccount> {
  if (!isTauri()) desktopOnly();
  return invoke<WpsAccount>("wps_account", { token });
}

/** 知识库列表 */
export async function listSpaces(token: string): Promise<WpsSpace[]> {
  if (!isTauri()) desktopOnly();
  return invoke<WpsSpace[]>("wps_spaces", { token });
}

/** 某个知识库下的文件列表（用来确认那张表在不在） */
export async function listFiles(token: string, spaceKuid: string): Promise<WpsFile[]> {
  if (!isTauri()) desktopOnly();
  return invoke<WpsFile[]>("wps_files", { token, kuid: spaceKuid });
}

/**
 * 整表推送：本地台账 → 在线表格。
 *
 * Rust 侧负责 下载模板 → 拼表 → 上传 → 删旧 → 改名（顺序不能换，见 wps.rs）。
 * 这里只负责把行准备好、把参数查齐。
 *
 * @param rows 已读好的台账行；不传则自己读。传进来是为了让调用方能先看一眼
 *   「一条都没有」—— 空表推送会把线上那份移进回收站，得不偿失。
 */
export async function pushLedger(
  token: string,
  spaceKuid: string,
  driveId: string,
  title: string,
  rows?: LedgerRow[],
) {
  if (!isTauri()) desktopOnly();
  need(token, "还没登录 WPS");
  need(spaceKuid, "还没选知识库");
  need(driveId, "这个知识库没给出 drive_id，没法上传");
  need(title, "表格标题不能为空");
  const body = rows ?? (await readLedger());
  return invoke<WpsPushResult>("wps_push", {
    token,
    spaceKuid,
    driveId,
    title,
    rows: body,
  });
}

/** 整表拉取：在线表格 → 行数据（键已是 SQLite 列名）。写库由 planPull/applyPull 负责 */
export async function pullLedger(token: string, spaceKuid: string, title: string): Promise<WpsPull> {
  if (!isTauri()) desktopOnly();
  need(token, "还没登录 WPS");
  need(spaceKuid, "还没选知识库");
  need(title, "表格标题不能为空");
  return invoke<WpsPull>("wps_pull", { token, spaceKuid, title });
}

/* ------------------------------------------------------------------ */
/* 设置的读写辅助                                                      */
/* ------------------------------------------------------------------ */

/** 读 kwiki 相关设置（去空白）。UI 不应该出现裸的键名 */
export function readKwikiConfig(settings: Record<string, string>): {
  token: string;
  expiry: number;
  account: string;
  spaceKuid: string;
  driveId: string;
  tableTitle: string;
} {
  const expiry = Number(settings[SETTINGS.kwikiTokenExpiry] ?? "");
  return {
    token: (settings[SETTINGS.kwikiToken] ?? "").trim(),
    expiry: Number.isFinite(expiry) && expiry > 0 ? expiry : 0,
    account: (settings[SETTINGS.kwikiAccount] ?? "").trim(),
    spaceKuid: (settings[SETTINGS.kwikiSpaceKuid] ?? "").trim(),
    driveId: (settings[SETTINGS.kwikiDriveId] ?? "").trim(),
    // 默认标题就是用户那张表的名字（与 sync-ledger.py 里同一个值）
    tableTitle: (settings[SETTINGS.kwikiTableTitle] ?? "").trim() || "异常台账",
  };
}
