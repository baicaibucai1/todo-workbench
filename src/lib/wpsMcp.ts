/**
 * WPS SkillHub MCP —— 「我的云文档」直连的**编排层**。
 *
 * 传输全在 `src-tauri/src/wps_mcp.rs`：设备码授权、换令牌、MCP 握手。
 * 浏览器跨不过 mcp-center.wps.cn 的 CORS，所以这条路天生只属于桌面版 ——
 * 每个函数进门先查 isTauri()，网页端明确报错而不是静默失败。
 *
 * 和隔壁那条 WPS 通道别混（两套授权互不通用）：
 *   · `kwiki.ts` → 知识库（zhishi.wps.cn），令牌只碰那个知识库里的文件，
 *                  而且只有它能列出知识库目录（MCP 只看得见「我的云文档」根目录）；
 *   · 这里（MCP） → 全部云文档，令牌的爆炸半径最大。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";
import { SETTINGS } from "./settings";

/* ------------------------------------------------------------------ */
/* 类型（与 Rust 的 serde 字段逐字对应）                                */
/* ------------------------------------------------------------------ */

export type McpBegin = {
  auth_code: string;
  auth_url: string;
  client_id: string;
};

export type McpStatus = "waiting" | "ok" | "cancelled" | "enterprise";

export type McpPoll = {
  status: McpStatus;
  token: string;
  expires_in: number;
  message: string;
};

export type McpProbe = {
  /** tools/list 的工具数。当前服务端全量是 625 */
  tools: number;
  /** 根目录云文档数；-1 = 工具清单通了但列文件没读到 */
  files: number;
  sample: string[];
  /** 授权账号昵称。MCP 没有"我是谁"接口，从列文件的 created_by 里取；空 = 没读到 */
  user: string;
  server: string;
  version: string;
  /** 非致命提示（比如「清单通了，列文件失败」） */
  note: string;
};

/** 设置里读出来的连接状态。`enabled` 是用户在界面上按下的那个「确认启用」 */
export type McpConfig = {
  token: string;
  clientId: string;
  enabled: boolean;
  /** 令牌到期时刻（毫秒时间戳）。0 = 服务端没给 */
  expiry: number;
  lastAt: string;
  tools: string;
  files: string;
  /** 上次探测到的账号昵称（存设置里，重开设置页也能显示） */
  user: string;
};

/* ------------------------------------------------------------------ */
/* 配置读取                                                            */
/* ------------------------------------------------------------------ */

export function readMcpConfig(settings: Record<string, string>): McpConfig {
  return {
    token: settings[SETTINGS.wpsMcpToken] || "",
    clientId: settings[SETTINGS.wpsMcpClientId] || "",
    enabled: settings[SETTINGS.wpsMcpEnabled] === "1",
    expiry: Number(settings[SETTINGS.wpsMcpExpiry] || 0) || 0,
    lastAt: settings[SETTINGS.wpsMcpLastAt] || "",
    tools: settings[SETTINGS.wpsMcpTools] || "",
    files: settings[SETTINGS.wpsMcpFiles] || "",
    user: settings[SETTINGS.wpsMcpUser] || "",
  };
}

function desktopOnly(): never {
  throw new Error(
    "WPS MCP 只在桌面版可用 —— 浏览器过不了金山服务器的跨域限制（打包出来的那个才行）",
  );
}

/* ------------------------------------------------------------------ */
/* 三个动作                                                            */
/* ------------------------------------------------------------------ */

/** ① 生成本地授权码。**码由本地生成**，服务端只认「被登录用户确认过的码」 */
export async function mcpBegin(): Promise<McpBegin> {
  if (!isTauri()) desktopOnly();
  return invoke<McpBegin>("wps_mcp_begin");
}

/** ② 轮询换令牌。`waiting` 是正常状态，不是错误 */
export async function mcpPoll(authCode: string): Promise<McpPoll> {
  if (!isTauri()) desktopOnly();
  return invoke<McpPoll>("wps_mcp_poll", { authCode });
}

/** ③ 握手 + 清点：initialize → tools/list → 真调一次 list_my_files */
export async function mcpProbe(token: string, clientId: string): Promise<McpProbe> {
  if (!isTauri()) desktopOnly();
  return invoke<McpProbe>("wps_mcp_probe", { token, clientId });
}

/**
 * ③' 桥接：调白名单里的一个 MCP 工具，返回**业务信封**。
 *
 * Rust 侧（`wps_mcp_bridge`）有硬白名单 —— 就算这里被工具桥的输入绕晕，
 * 能触达的也只有列文件 / 读表 / 读文档 / 写智能文档那几个。信封解包
 * （code==0、取 data.detail.*）由调用方做：每个工具的形状都不一样。
 */
export async function mcpBridgeTool(
  tool: string,
  args: Record<string, unknown>,
  token: string,
  clientId: string,
): Promise<unknown> {
  if (!isTauri()) desktopOnly();
  const text = await invoke<string>("wps_mcp_bridge", { token, clientId, tool, args });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`MCP 返回的不是 JSON：${text.slice(0, 120)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 台账同步（2026-10-19 从 AirScript 迁来）                             */
/* ------------------------------------------------------------------ */

/** 与 Rust `WpsPull` 逐字对应 */
export type McpPull = {
  file_kuid: string;
  header: string[];
  rows: Array<Record<string, string>>;
};

/** 与 Rust `WpsCloudPush` 逐字对应 */
export type McpPush = {
  count: number;
  /** 写了几列（含补在末尾的新列） */
  columns: number;
  /** 末尾补了几列（表里原来没有的台账列） */
  appended: number;
  file_kuid: string;
};

/** 云文档根目录里的一份文件（挑表格时列出来给人选） */
export type McpFile = {
  id: string;
  name: string;
  /** 修改时间（秒）。0 = 服务端没给 */
  mtime: number;
  /** "folder" = 文件夹（进不去）；其余是可绑定的文件 */
  ftype: string;
};

/** 列根目录文件（最多 8 页 × 50 —— 挑一份表用不了更多） */
export async function mcpListFiles(token: string, clientId: string): Promise<McpFile[]> {
  if (!isTauri()) desktopOnly();
  const out: McpFile[] = [];
  let pageToken = "";
  for (let i = 0; i < 8; i++) {
    const args: Record<string, unknown> = { page_size: 50 };
    if (pageToken) args.page_token = pageToken;
    const data = (await mcpBridgeTool("list_my_files", args, token, clientId)) as {
      items?: Array<Record<string, unknown>>;
      next_page_token?: string;
    };
    for (const it of data.items ?? []) {
      const id = String(it.id ?? "");
      const name = String(it.name ?? "");
      if (!id || !name) continue;
      out.push({
        id,
        name,
        mtime: Number(it.mtime ?? 0) || 0,
        ftype: String(it.type ?? "file"),
      });
    }
    pageToken = String(data.next_page_token ?? "");
    if (!pageToken) break;
  }
  return out;
}

/**
 * 拉取在线表格 → 按台账列名映射成本地行。
 *
 * 语义与原来那条直连路一致（整行全空跳过、只认 14 个中文表头），
 * 只是传输层换成 MCP —— 用户不用再去表格里建脚本、复制 webhook 和令牌。
 */
export async function mcpSheetPull(
  fileId: string,
  sheet: string,
  token: string,
  clientId: string,
): Promise<McpPull> {
  if (!isTauri()) desktopOnly();
  return invoke<McpPull>("wps_mcp_sheet_pull", {
    token,
    clientId,
    fileId,
    sheet: sheet || null,
  });
}

/**
 * 推送台账到在线表格：**只写台账那 14 列**。
 *
 * 对账逻辑（找列 / 缺列补末尾 / 多出的旧行清空 / 表头认不出就停手）全在
 * Rust 的 `plan_cloud_write`，这次只换了下发方式，语义一个字没改。
 */
export async function mcpSheetPush(
  fileId: string,
  sheet: string,
  rows: Array<Record<string, unknown>>,
  token: string,
  clientId: string,
): Promise<McpPush> {
  if (!isTauri()) desktopOnly();
  return invoke<McpPush>("wps_mcp_sheet_push", {
    token,
    clientId,
    fileId,
    sheet: sheet || null,
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* 授权窗口                                                            */
/* ------------------------------------------------------------------ */

/**
 * ④ 在**程序内**弹出授权页。
 *
 * 不能在界面里 `window.open`：Tauri 的 webview 不允许新开窗口，
 * 点下去没有任何反应（`attachments.ts:629` 记过同一个坑）。
 * 这里由 Rust 建一个内嵌浏览器窗口，用户在里面登录并点「同意」。
 * 窗口建不出来时（极少见）调用方退回到系统浏览器。
 */
export async function mcpOpenAuth(url: string): Promise<void> {
  if (!isTauri()) desktopOnly();
  await invoke("wps_mcp_open_auth", { url });
}

/** ⑤ 收掉授权窗口。成功 / 取消 / 超时 / 离开页面都要调 */
export async function mcpCloseAuth(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("wps_mcp_close_auth");
  } catch {
    /* 窗口早就没了，不算错 */
  }
}

/** ⑥ 授权窗口还开着吗（用户手动叉掉窗口时就别再空等了） */
export async function mcpAuthAlive(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("wps_mcp_auth_alive");
  } catch {
    return false;
  }
}
