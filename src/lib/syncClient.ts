/**
 * 同步的编排层：读写配置、调 Rust 传输层、把「拉 → 合 → 写回 → 推」串起来。
 *
 * 三层分工，别混：
 *   - `sync.ts`      纯合并算法（可被 e2e 完整覆盖）
 *   - `syncRepo.ts`  数据库搬运（导出快照 / 写回合并结果）
 *   - 本文件         配置 + 网络 + 编排
 *
 * 浏览器演示模式里这一层会**明确报错**而不是静默失败：WebDAV 用的
 * PROPFIND / MKCOL 浏览器根本发不出去（预检就过不了），所以同步注定
 * 只能在桌面版里用。让按钮点了没反应、或者报一个看不懂的 CORS 错误，
 * 都比直接说清楚差。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";
import { setSettings } from "./repo";
import { SETTINGS } from "./settings";
import {
  SHARD_FORMAT,
  addStats,
  emptyStats,
  mergeShard,
  parseShard,
  serializeShard,
  type SyncConflict,
  type SyncShard,
  type SyncShardId,
  type SyncStats,
} from "./sync";
import { applyShardPayload, exportShardPayload } from "./syncRepo";

export const DEFAULT_BASE_URL = "https://dav.jianguoyun.com/dav";

/** 分片的固定顺序。界面按它排，序列化也按它，两边不会各排各的 */
export const ALL_SHARDS: SyncShardId[] = ["tasks", "orders", "gallery", "attachments"];

/**
 * 同步的后端。
 *
 * 这是**两套完全不同的协议**，不是同一套的两种填法：
 *   - `webdav`   坚果云、群晖、Nextcloud —— 账号密码走 Basic Auth，
 *                用 PROPFIND / MKCOL 建目录
 *   - `onedrive` Microsoft Graph + OAuth 登录 —— **OneDrive 个人版没有 WebDAV**，
 *                那套 d.docs.live.net 的映射靠应用密码，微软早废弃了
 *
 * 除了"传输"这一层，配置解析以上的所有东西（分片、合并、墓碑、设备名）
 * 两个后端完全共用 —— 这正是当初把传输单独切一层的原因。
 */
export type SyncProvider = "webdav" | "onedrive";

export const SYNC_PROVIDERS: ReadonlyArray<{ id: SyncProvider; label: string; hint: string }> = [
  {
    id: "webdav",
    label: "坚果云 WebDAV",
    hint: "群晖、Nextcloud、InfiniCLOUD 等任何 WebDAV 服务都填这里",
  },
  {
    id: "onedrive",
    label: "OneDrive",
    hint: "走微软 Graph API。需要先在 Azure 注册一个免费应用，再点「连接 OneDrive」",
  },
];

/**
 * 解析后端标识。**未知值一律回落到 webdav** ——
 * 老用户的设置里没有这个键，手改数据库也可能留下脏值，
 * 而"回落到 webdav"对他们正是原来的行为（配置一个字节都不用改）。
 */
export function parseSyncProvider(raw: string | undefined): SyncProvider {
  return raw === "onedrive" ? "onedrive" : "webdav";
}

export function providerLabel(id: SyncProvider): string {
  return SYNC_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

export interface SyncConfig {
  provider: SyncProvider;
  /** 要同步的分片。两种后端共用同一套分片 */
  shards: SyncShardId[];
  deviceId: string;
  deviceName: string;

  /* ------------------------------ WebDAV ------------------------------ */
  baseUrl: string;
  username: string;
  password: string;
  /** 远程目录，相对 baseUrl。OneDrive 用不到它（固定是应用专属文件夹） */
  dir: string;

  /* ----------------------------- OneDrive ----------------------------- */
  /** Azure 应用的客户端 ID。公共客户端的 client_id **不是密钥** */
  onedriveClientId: string;
  /** 长期令牌。与 syncPassword 同类：明文存本机、不参与同步 */
  onedriveRefreshToken: string;
  /** 已连接账号，仅用于界面显示 */
  onedriveAccount: string;
}

/** 与 Rust 侧 webdav::DavConfig 一一对应（那边是 camelCase 反序列化） */
interface RustDavConfig {
  baseUrl: string;
  username: string;
  password: string;
  dir: string;
}

/** 与 Rust 侧 onedrive::OneDriveConfig 一一对应 */
interface RustOneDriveConfig {
  clientId: string;
  refreshToken: string;
  accessToken: string;
}

export interface ShardReport {
  shard: SyncShardId;
  stats: SyncStats;
  conflicts: SyncConflict[];
  /** 云端本来有没有这个分片。false = 这次是首次同步，本地是源头 */
  hadRemote: boolean;
  /** 云端那份是哪台设备写的 */
  remoteDevice?: string;
  remoteAt?: string;
  /** 这个分片失败了。**失败不中断其他分片** —— 一个分片坏掉不该让整次同步白跑 */
  error?: string;
}

export interface SyncReport {
  at: string;
  shards: ShardReport[];
  stats: SyncStats;
  conflicts: SyncConflict[];
  okCount: number;
  failCount: number;
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/**
 * 同步**必须在桌面版里跑**。
 *
 * 不只是"浏览器发不出 PROPFIND"这一条：浏览器演示模式的数据在
 * localStorage 里，和桌面版的 SQLite 是两套完全独立的数据 ——
 * 就算能发请求，同步的也不是用户以为的那份数据。
 */
export function assertDesktop(): void {
  if (!isTauri()) {
    throw new Error(
      "同步需要桌面版。浏览器演示模式的数据存在 localStorage 里，与桌面版的数据库是两套，而且 WebDAV 用的 PROPFIND / MKCOL 方法浏览器发不出去。",
    );
  }
}

export function newDeviceId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
}

/**
 * 解析勾选的分片。
 *
 * 空串、全是非法值、键不存在 —— 一律回落到 `["tasks"]`。
 * **不返回空数组**：那会让"立即同步"变成一个什么都不做的动作，
 * 而用户按了按钮却毫无反应，是界面上最难解释的一种状态。
 */
export function parseShards(raw: string | undefined): SyncShardId[] {
  const out: SyncShardId[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim() as SyncShardId;
    if (ALL_SHARDS.includes(id) && !out.includes(id)) out.push(id);
  }
  // 按固定顺序回排：同一个集合无论设置串怎么写，读出来都是同一串，
  // 界面勾选框的顺序与写回的字符串不会因为历史顺序不同而漂移
  return out.length ? ALL_SHARDS.filter((s) => out.includes(s)) : ["tasks"];
}

/** 序列化成设置里的字符串。按固定顺序去重，保证同一个集合永远写出同一串 */
export function formatShards(ids: SyncShardId[]): string {
  return ALL_SHARDS.filter((s) => ids.includes(s)).join(",");
}

export function readSyncConfig(settings: Record<string, string>): SyncConfig {
  const stored = (settings[SETTINGS.syncDeviceId] ?? "").trim();
  const deviceId = stored || newDeviceId();
  return {
    provider: parseSyncProvider(settings[SETTINGS.syncProvider]),
    shards: parseShards(settings[SETTINGS.syncShards]),
    deviceId,
    deviceName:
      (settings[SETTINGS.syncDeviceName] ?? "").trim() || `设备-${deviceId.slice(0, 4)}`,
    baseUrl: (settings[SETTINGS.syncBaseUrl] ?? "").trim() || DEFAULT_BASE_URL,
    username: (settings[SETTINGS.syncUsername] ?? "").trim(),
    password: settings[SETTINGS.syncPassword] ?? "",
    // 目录允许空串（直接放服务根目录），所以这里不填默认值 ——
    // 默认值在 DEFAULT_SETTINGS 里，用户清空就是清空
    dir: (settings[SETTINGS.syncDir] ?? "").trim(),
    onedriveClientId: (settings[SETTINGS.onedriveClientId] ?? "").trim(),
    onedriveRefreshToken: settings[SETTINGS.onedriveRefreshToken] ?? "",
    onedriveAccount: (settings[SETTINGS.onedriveAccount] ?? "").trim(),
  };
}

/**
 * 算不算配好了。两种后端"配好"的门槛不一样 ——
 * 用一个共用判断会让 OneDrive 用户被要求去填 WebDAV 的账号密码。
 */
export function isSyncConfigured(cfg: SyncConfig): boolean {
  if (cfg.provider === "onedrive") {
    // 有长期令牌就等于登录过了；client_id 是它成立的前提
    return !!cfg.onedriveClientId && !!cfg.onedriveRefreshToken;
  }
  return !!cfg.baseUrl && !!cfg.username && !!cfg.password;
}

/** 还没配好时该提示什么。缺的东西两个后端不同，不能共用一句 */
export function missingConfigHint(cfg: SyncConfig): string {
  if (cfg.provider === "onedrive") {
    return cfg.onedriveClientId
      ? "还没连接 OneDrive，先点「连接 OneDrive」完成一次授权"
      : "先填 Azure 应用的客户端 ID，再点「连接 OneDrive」";
  }
  return "先填账号和应用密码";
}

/** 首次使用时把新生成的设备 id 落库，否则每次启动都会换一个身份 */
export async function persistDeviceId(cfg: SyncConfig): Promise<void> {
  await setSettings({
    [SETTINGS.syncDeviceId]: cfg.deviceId,
    [SETTINGS.syncDeviceName]: cfg.deviceName,
  });
}

function davOf(cfg: SyncConfig): RustDavConfig {
  return {
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    password: cfg.password,
    dir: cfg.dir,
  };
}

function onedriveOf(cfg: SyncConfig, accessToken: string): RustOneDriveConfig {
  return {
    clientId: cfg.onedriveClientId,
    refreshToken: cfg.onedriveRefreshToken,
    accessToken,
  };
}

export function shardFileName(shard: SyncShardId): string {
  return `${shard}.json`;
}

/* ------------------------------------------------------------------ */
/* 传输                                                                */
/* ------------------------------------------------------------------ */

/** 远端一个文件的信息。两个后端字段对齐，上层不必区分来源 */
export interface RemoteEntry {
  size: number;
  modified: string;
}

/**
 * 一轮同步要用的传输句柄。
 *
 * 做成"先开句柄、再反复用"而不是四个散函数，是因为 **OneDrive 的短期令牌
 * 得整轮共用**：每取一个分片都刷一次令牌，既慢又容易被限流。
 * 开句柄时刷一次，之后整轮复用。
 */
export interface RemoteTarget {
  /** 验通并确保远端目录可用。返回一句给人看的话 */
  check(): Promise<string>;
  get(name: string): Promise<string | null>;
  put(name: string, text: string): Promise<number>;
  stat(name: string): Promise<RemoteEntry | null>;
}

/**
 * OneDrive 短期令牌的缓存。
 *
 * 放在模块作用域而**不落库**：它一小时后必然失效，落库只会多一份迟早要清的
 * 脏数据；而且它比 refresh_token 更该少落盘 —— 短期令牌本身就是"用完即弃"的。
 */
let cachedToken: { token: string; expiresAt: number; forClient: string } | null = null;

/** 微软给的有效期是 3600 秒。留一分钟余量，避免卡在过期那一瞬间 */
function tokenTtlMs(expiresIn: number): number {
  const secs = expiresIn > 0 ? expiresIn : 3600;
  return Math.max(60_000, (secs - 60) * 1000);
}

async function onedriveAccessToken(cfg: SyncConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.forClient === cfg.onedriveClientId && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  const r = await invoke<{ accessToken: string; refreshToken: string; expiresIn: number }>(
    "onedrive_refresh",
    { cfg: onedriveOf(cfg, "") },
  );

  // ⚠️ 微软的 refresh_token 是**会滚动**的：每次刷新可能发一个新的，旧的随后失效。
  // 不写回去的话，这一轮同步照样能跑完，下一次点同步才失败 —— 而且报的还是
  // 「授权已失效」，看起来像用户的问题。
  if (r.refreshToken && r.refreshToken !== cfg.onedriveRefreshToken) {
    cfg.onedriveRefreshToken = r.refreshToken;
    await setSettings({ [SETTINGS.onedriveRefreshToken]: r.refreshToken });
  }

  cachedToken = {
    token: r.accessToken,
    expiresAt: now + tokenTtlMs(r.expiresIn),
    forClient: cfg.onedriveClientId,
  };
  return r.accessToken;
}

/** 清掉内存里的短期令牌。断开账号、重新登录时都要调 —— 否则下一次还会拿旧账号的去试 */
export function forgetOneDriveToken(): void {
  cachedToken = null;
}

/**
 * 打开一个传输句柄。
 *
 * OneDrive 要先刷一次令牌，所以这一步必然是异步的；WebDAV 其实不必，
 * 但接口统一成异步，上层就不用按后端起两套写法。
 */
export async function openRemote(cfg: SyncConfig): Promise<RemoteTarget> {
  if (cfg.provider === "onedrive") {
    const od = onedriveOf(cfg, await onedriveAccessToken(cfg));
    return {
      async check() {
        const r = await invoke<{ folderExists: boolean; folderPath: string; message: string }>(
          "onedrive_check",
          { cfg: od },
        );
        return r.message;
      },
      get: (name) => invoke<string | null>("onedrive_get", { cfg: od, name }),
      put: (name, text) => invoke<number>("onedrive_put", { cfg: od, name, text }),
      async stat(name) {
        const r = await invoke<RemoteEntry | null>("onedrive_stat", { cfg: od, name });
        return r ? { size: r.size, modified: r.modified } : null;
      },
    };
  }

  const dav = davOf(cfg);
  return {
    async check() {
      const r = await invoke<{ dirExists: boolean; message: string }>("webdav_check", { cfg: dav });
      return r.message;
    },
    get: (name) => invoke<string | null>("webdav_get", { cfg: dav, name }),
    put: (name, text) => invoke<number>("webdav_put", { cfg: dav, name, text }),
    async stat(name) {
      const r = await invoke<RemoteEntry | null>("webdav_stat", { cfg: dav, name });
      return r ? { size: r.size, modified: r.modified } : null;
    },
  };
}

/** 验证账号 / OneDrive 授权，并确保远端目录存在。返回一句给人看的话 */
export async function checkConnection(cfg: SyncConfig): Promise<string> {
  assertDesktop();
  if (!isSyncConfigured(cfg)) throw new Error(missingConfigHint(cfg));
  const remote = await openRemote(cfg);
  return remote.check();
}

/**
 * 走一遍 OneDrive 授权登录，成功后立刻把长期令牌落库。
 *
 * **这个调用会等几分钟**（开着浏览器等用户登录授权），调用方必须先把
 * "正在等浏览器"的状态显示出来，否则界面看起来像卡死了。
 */
export async function signInOneDrive(cfg: SyncConfig): Promise<string> {
  assertDesktop();
  if (!cfg.onedriveClientId) {
    throw new Error("先填 Azure 应用的客户端 ID，再点「连接 OneDrive」");
  }
  const r = await invoke<{ refreshToken: string; account: string; message: string }>(
    "onedrive_sign_in",
    { cfg: onedriveOf(cfg, "") },
  );
  forgetOneDriveToken();
  await setSettings({
    [SETTINGS.onedriveRefreshToken]: r.refreshToken,
    [SETTINGS.onedriveAccount]: r.account,
  });
  return r.message;
}

/** 断开 OneDrive：清掉本机的长期令牌与账号显示。云端那份数据**不动** —— 断开不等于删数据 */
export async function signOutOneDrive(): Promise<void> {
  forgetOneDriveToken();
  await setSettings({
    [SETTINGS.onedriveRefreshToken]: "",
    [SETTINGS.onedriveAccount]: "",
  });
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

/**
 * 跑一次同步。
 *
 * 每个分片独立走一遍「清点本地 → 取云端 → 合并 → 写回本地 → 推回云端」，
 * 分片之间**互不影响**：一个分片失败不影响其他分片，
 * 已成功的分片也不会回滚（它们各自已经是完整状态了，回滚反而会丢东西）。
 */
export async function runSync(cfg: SyncConfig): Promise<SyncReport> {
  assertDesktop();
  if (!isSyncConfigured(cfg)) {
    throw new Error(missingConfigHint(cfg));
  }

  const at = new Date().toISOString();
  const results: ShardReport[] = [];

  // 句柄在一轮开始时开一次：OneDrive 的令牌只刷这一次，之后整轮复用。
  // 开不出来（网络不通 / 授权失效）就整轮到此为止 —— 这时候没有一个分片有救，
  // 让四个分片各报一遍同样的错只会把界面刷满，反而看不见真正的原因
  const remote = await openRemote(cfg);

  for (const shard of cfg.shards) {
    const name = shardFileName(shard);
    try {
      // 1) 本地快照（含软删除的墓碑）
      const local = await exportShardPayload(shard);

      // 2) 云端那份。不存在时返回 null，不是错误 —— 首次同步本来就没有
      const raw = await remote.get(name);
      const cloud = raw ? parseShard(raw, shard) : null;

      // 3) 合并
      const merged = cloud
        ? mergeShard(shard, local, cloud.payload)
        : { payload: local, stats: emptyStats(), conflicts: [] as SyncConflict[] };

      // 4) 写回本地。云端没有这个分片时不写 —— 本地本来就是源头，
      //    原样写回去只是白白多跑一次事务
      if (cloud) await applyShardPayload(shard, merged.payload);

      // 5) 推回云端。**总是推**：分片只有几十 KB，而"只在有变化时推"
      //    需要先证明"没变化"，那个比较本身会因为数组顺序不同而误判，
      //    不值得为省这点流量去承担一次漏传的风险
      const envelope: SyncShard = {
        app: "todo-workbench",
        format: SHARD_FORMAT,
        shard,
        updatedAt: at,
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
        payload: merged.payload,
      };
      await remote.put(name, serializeShard(envelope));

      results.push({
        shard,
        stats: merged.stats,
        conflicts: merged.conflicts,
        hadRemote: !!cloud,
        remoteDevice: cloud?.deviceName,
        remoteAt: cloud?.updatedAt,
      });
    } catch (e) {
      results.push({
        shard,
        stats: emptyStats(),
        conflicts: [],
        hadRemote: false,
        error: errText(e),
      });
    }
  }

  const report: SyncReport = {
    at,
    shards: results,
    stats: results.reduce((a, r) => addStats(a, r.stats), emptyStats()),
    conflicts: results.flatMap((r) => r.conflicts),
    okCount: results.filter((r) => !r.error).length,
    failCount: results.filter((r) => !!r.error).length,
  };

  // 只在**有分片成功**时才记"上次同步"。全失败还写一笔，
  // 会让界面显示一个误导的"上次同步成功时间"
  if (report.okCount > 0) {
    await setSettings({
      [SETTINGS.syncLastAt]: at,
      [SETTINGS.syncLastSummary]: summarizeReport(report),
    });
  }

  return report;
}

/** 一句话摘要，存进设置供下次打开时显示 */
export function summarizeReport(r: SyncReport): string {
  const s = r.stats;
  const bits = [`取回 ${s.added}`, `更新 ${s.updated}`, `上传 ${s.pushed}`];
  if (r.conflicts.length) bits.push(`冲突 ${r.conflicts.length}`);
  if (r.failCount) bits.push(`失败 ${r.failCount}`);
  return bits.join(" · ");
}

/** 把毫秒时间戳格式化成"几分钟前"这类相对说法。设置页里比绝对时间好读 */
export function relativeTime(iso: string, now = Date.now()): string {
  if (!iso) return "还没同步过";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "还没同步过";
  const diff = now - t;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}
