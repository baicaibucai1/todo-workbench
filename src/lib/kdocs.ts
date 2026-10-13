/**
 * 金山文档（WPS 在线表格）的客户端 —— 只做**服务端 OpenAPI**这一套。
 *
 * 两套 API 别混：
 *   · `openapi.wps.cn/v7/...`  WPS 365 的，要商业高级版/旗舰版才有文档接口权限
 *   · `developer.kdocs.cn/api/v1/openapi/...`  金山文档的，**个人版就能用**
 * 这里是后者。用户是个人免费版（金山文档 kdocs.cn），只有这一条路走得通。
 *
 * 三条从文档里抄下来、随手就会踩的规矩：
 *  1. `file_token` 是文档 ID，**不是**分享链接 `/l/xxxx` 里的那个 link_id；
 *  2. 三类表（多维 dbt / 传统 et / 智能 ksheet）的 file_id 与路径前缀**不通用**，
 *     这里只做智能表格（ksheet）—— 它有结构化的 records 接口，字段对字段，
 *     比拿 AirScript 拼单元格字符串稳得多；
 *  3. access_token 只活 24 小时，refresh_token 活 90 天。短期令牌要能自动续，
 *     否则用户每三天就得重新授权一次（那等于没做）。
 *
 * ⚠️ 现阶段**只读**：拉取记录、看字段。写入留到下一步 —— 双向同步要先看清
 * 对面字段长什么样、改名了怎么办，再动笔写回去。
 */

import { SETTINGS } from "./settings";

/**
 * 请求前缀。
 *
 * 浏览器直连 developer.kdocs.cn 会被 CORS 挡掉（文档也写明换取令牌"必须从
 * 服务器调用"），所以开发时由 vite 把它代理过去（见 vite.config.ts 的 /kdocs-api）。
 * 桌面版里没有 vite，暂时**明确报错**而不是硬试一次 —— 静默失败最难查。
 */
const PROXY = "/kdocs-api";
const OAUTH_HOST = "https://developer.kdocs.cn";

/** 需要的权限：读个人文档。下一步要写回时再加 edit_personal_files */
export const KDOCS_SCOPES = "access_personal_files,edit_personal_files";

export type KdocsConfig = {
  appId: string;
  appKey: string;
  fileToken: string;
  sheetId: string;
};

export type KdocsTokenState = {
  accessToken: string;
  /** 到期时刻（毫秒）。0 = 不知道 */
  expiry: number;
  refreshToken: string;
  account: string;
};

export function readKdocsConfig(settings: Record<string, string>): KdocsConfig {
  return {
    appId: (settings[SETTINGS.kdocsAppId] ?? "").trim(),
    appKey: (settings[SETTINGS.kdocsAppKey] ?? "").trim(),
    fileToken: (settings[SETTINGS.kdocsFileToken] ?? "").trim(),
    sheetId: (settings[SETTINGS.kdocsSheetId] ?? "").trim(),
  };
}

export function readKdocsToken(settings: Record<string, string>): KdocsTokenState {
  return {
    accessToken: (settings[SETTINGS.kdocsAccessToken] ?? "").trim(),
    expiry: Number(settings[SETTINGS.kdocsTokenExpiry] ?? "") || 0,
    refreshToken: (settings[SETTINGS.kdocsRefreshToken] ?? "").trim(),
    account: (settings[SETTINGS.kdocsAccount] ?? "").trim(),
  };
}

/** 差哪一样。返回空串=齐了；否则是给用户看的一句人话 */
export function missingConfigHint(cfg: KdocsConfig): string {
  if (!cfg.appId) return "还差应用 ID（在金山开放平台建应用后给的那串）";
  if (!cfg.appKey) return "还差应用密钥（AppKey）";
  if (!cfg.fileToken) return "还差表格的文档 ID（file_token）";
  if (!cfg.sheetId) return "还差工作表 ID（新建的智能表格一般是 1）";
  return "";
}

/** 令牌看着还能用吗。留 5 分钟余量，别卡在最后一秒才去续 */
export function tokenLooksFresh(t: KdocsTokenState): boolean {
  return !!t.accessToken && (!t.expiry || t.expiry - Date.now() > 5 * 60 * 1000);
}

/**
 * 授权页地址。
 *
 * redirect_uri 必须是**应用后台登记过的回调地址之一**，否则授权页会直接拒绝。
 * 桌面应用没有公网域名，所以默认拿当前页面的 origin 拼 —— 用户在开发者后台
 * 把 `http://127.0.0.1:1420/oauth/kdocs` 登记进去即可（本地回环是常规做法）。
 */
export function buildAuthUrl(cfg: KdocsConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    app_id: cfg.appId,
    scope: KDOCS_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `${OAUTH_HOST}/h5/auth?${q.toString()}`;
}

/** 回调地址：当前页面 origin + 固定路径。桌面版（tauri://）另说，先只管 web */
export function defaultRedirectUri(): string {
  return `${globalThis.location?.origin ?? "http://127.0.0.1:1420"}/oauth/kdocs`;
}

class KdocsError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** 把接口返回的 code 翻成人话。文档的错误码表很长，这里只翻最常见的几个 */
function friendly(code: number, fallback: string): string {
  switch (code) {
    case 20001:
      return "授权码无效或已过期（它只活 5 分钟）—— 重新点一次授权";
    case 20007:
      return "令牌无效（AccessTokenInvalid）—— 点「去授权」重新连一次";
    case 401:
      return "令牌无效或过期";
    case 403:
      return "这个应用没有该文档的权限（检查 scope 与文档归属）";
    default:
      return fallback || `金山文档接口返回错误码 ${code}`;
  }
}

async function callApi<T>(
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  if (!globalThis.location?.origin?.includes("127.0.0.1") && !import.meta.env.DEV) {
    // 桌面版/生产构建里没有 vite 代理，直连会被 CORS 拒
    throw new Error("当前环境还没有金山文档的转发通道（桌面版待补），暂时只能在网页端用");
  }
  const qs = new URLSearchParams(init?.query ?? {}).toString();
  const res = await fetch(`${PROXY}${path}${qs ? `?${qs}` : ""}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`金山文档接口 HTTP ${res.status}`);
  // 错误体里的文案字段叫 `message`（实测：{"code":20007,"message":"AccessTokenInvalid"}）
  const json = (await res.json()) as { code?: number; data?: T; result?: string; message?: string };
  if (json.code && json.code !== 0) {
    throw new KdocsError(json.code, friendly(json.code, json.message ?? ""));
  }
  return json.data as T;
}

/** 授权码换令牌。返回的东西要立刻落库（它顺带给出 refresh_token） */
export async function exchangeCode(
  cfg: KdocsConfig,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const data = await callApi<{ access_token: string; refresh_token: string; expires_in: number }>(
    "/api/v1/oauth2/access_token",
    { query: { code, app_id: cfg.appId, app_key: cfg.appKey } },
  );
  return {
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? "",
    expiresIn: Number(data.expires_in ?? 0) || 86400,
  };
}

/** 用 refresh_token 续一个短期令牌。90 天内都好使，过期只能重新授权 */
export async function refreshToken(
  cfg: KdocsConfig,
  refresh: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const data = await callApi<{ access_token: string; refresh_token: string; expires_in: number }>(
    "/api/v1/oauth2/refresh_token",
    { method: "POST", query: { app_id: cfg.appId }, body: { app_key: cfg.appKey, refresh_token: refresh } },
  );
  return {
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? refresh,
    expiresIn: Number(data.expires_in ?? 0) || 86400,
  };
}

/** 顺手拿一下账号昵称，让界面能说"已连接为 xxx" */
export async function fetchProfile(token: string): Promise<string> {
  try {
    const data = await callApi<{ nickname?: string }>("/api/v1/openapi/user/basic", {
      query: { access_token: token },
    });
    return data?.nickname ?? "";
  } catch {
    return "";
  }
}

export type KdocsRecord = {
  /** 记录 ID，智能表格自己发的 —— 后续做双向同步时它就是两边的锚点 */
  recordId?: string;
  fields: Record<string, unknown>;
};

type RecordsResponse = {
  records?: Array<{ record_id?: string; fields?: Record<string, unknown> }>;
  offset?: string;
  total?: number;
};

/**
 * 拉一页记录。
 *
 * 分页靠 `offset`：返回里还有 offset 就说明后面还有，没有就是最后一页。
 * 默认 100 条一页；一次拉全量时要自己拼（见 fetchAllRecords）。
 */
export async function fetchRecords(
  cfg: KdocsConfig,
  token: string,
  opts?: { offset?: string; pageSize?: number },
): Promise<{ records: KdocsRecord[]; nextOffset: string; total: number | null }> {
  const query: Record<string, string> = {
    access_token: token,
    pageSize: String(opts?.pageSize ?? 100),
  };
  if (opts?.offset) query.offset = opts.offset;
  const data = await callApi<RecordsResponse>(
    `/api/v1/openapi/ksheet/${encodeURIComponent(cfg.fileToken)}/sheets/${encodeURIComponent(cfg.sheetId)}/records`,
    { query },
  );
  return {
    records: (data?.records ?? []).map((r) => ({
      recordId: r.record_id,
      fields: r.fields ?? {},
    })),
    nextOffset: data?.offset ?? "",
    total: typeof data?.total === "number" ? data.total : null,
  };
}

/** 全量拉取（分页拼起来）。maxPages 是安全阀，别让一次误配把几千页拉下来 */
export async function fetchAllRecords(
  cfg: KdocsConfig,
  token: string,
  maxPages = 50,
): Promise<KdocsRecord[]> {
  const out: KdocsRecord[] = [];
  let offset = "";
  for (let i = 0; i < maxPages; i += 1) {
    const page = await fetchRecords(cfg, token, offset ? { offset } : {});
    out.push(...page.records);
    if (!page.nextOffset) break;
    offset = page.nextOffset;
  }
  return out;
}

/** 一条记录的字段名集合 —— 用来给用户看"对面表里到底有哪些列" */
export function fieldNamesOf(records: KdocsRecord[], limit = 40): string[] {
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r.fields)) {
      seen.add(k);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}
