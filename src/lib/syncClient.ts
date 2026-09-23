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

export interface SyncConfig {
  baseUrl: string;
  username: string;
  password: string;
  dir: string;
  shards: SyncShardId[];
  deviceId: string;
  deviceName: string;
}

/** 与 Rust 侧 webdav::DavConfig 一一对应（那边是 camelCase 反序列化） */
interface RustDavConfig {
  baseUrl: string;
  username: string;
  password: string;
  dir: string;
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
    baseUrl: (settings[SETTINGS.syncBaseUrl] ?? "").trim() || DEFAULT_BASE_URL,
    username: (settings[SETTINGS.syncUsername] ?? "").trim(),
    password: settings[SETTINGS.syncPassword] ?? "",
    // 目录允许空串（直接放服务根目录），所以这里不填默认值 ——
    // 默认值在 DEFAULT_SETTINGS 里，用户清空就是清空
    dir: (settings[SETTINGS.syncDir] ?? "").trim(),
    shards: parseShards(settings[SETTINGS.syncShards]),
    deviceId,
    deviceName:
      (settings[SETTINGS.syncDeviceName] ?? "").trim() || `设备-${deviceId.slice(0, 4)}`,
  };
}

/** 账号密码填全了才算配好 */
export function isSyncConfigured(cfg: SyncConfig): boolean {
  return !!cfg.baseUrl && !!cfg.username && !!cfg.password;
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

export function shardFileName(shard: SyncShardId): string {
  return `${shard}.json`;
}

/* ------------------------------------------------------------------ */
/* 传输                                                                */
/* ------------------------------------------------------------------ */

/** 验证账号并确保远程目录存在。成功返回一句给人看的话 */
export async function checkConnection(cfg: SyncConfig): Promise<string> {
  assertDesktop();
  if (!isSyncConfigured(cfg)) {
    throw new Error("先填账号和应用密码");
  }
  const r = await invoke<{ dirExists: boolean; message: string }>("webdav_check", {
    cfg: davOf(cfg),
  });
  return r.message;
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
    throw new Error("先填账号和应用密码");
  }

  const at = new Date().toISOString();
  const results: ShardReport[] = [];

  for (const shard of cfg.shards) {
    const name = shardFileName(shard);
    try {
      // 1) 本地快照（含软删除的墓碑）
      const local = await exportShardPayload(shard);

      // 2) 云端那份。404 返回 null，不是错误 —— 首次同步本来就没有
      const raw = await invoke<string | null>("webdav_get", {
        cfg: davOf(cfg),
        name,
      });
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
      await invoke<number>("webdav_put", {
        cfg: davOf(cfg),
        name,
        text: serializeShard(envelope),
      });

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
