/**
 * 工单附件的本地仓库（前端侧的门面）。
 *
 * 和 lib/db.ts 是同一个套路：**一套接口，两个实现**。
 * 浏览器 demo 与桌面打包共用同一份业务代码，业务层不关心文件到底存在哪。
 *
 * | | 文件存哪 | 谁负责写 | 取 URL 的方式 |
 * |---|---|---|---|
 * | 桌面 | `%APPDATA%/待办工作台/attachments/` | Rust（invoke） | asset 协议 |
 * | 浏览器 demo | IndexedDB | 这里 | blob URL |
 *
 * 为什么桌面端不自己写文件、非要绕到 Rust：
 * **跨域**。webview 里 fetch 第三方图片地址会被同源策略拦掉，
 * 而图片站绝大多数不给 CORS 头。这条在真实站点上试过，一半的图下不来。
 * Rust 侧用 reqwest 直连没有这回事。
 *
 * 浏览器 demo 只能硬扛 CORS（fetch 失败就降级成"存链接"），
 * 但 demo 本来就是为了验证产品形态，不追求真实下载成功率。
 */

import { isTauri } from "./db";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AttachmentKind } from "../types";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单文件大小上限。
 *
 * 图片卡在 20 MB：超过这个数已经不是"一张图"了，多半是没压过的原图或分层文件，
 * 放进仓库只会让仓库迅速膨胀，而它该走的是网盘链接。
 * 视频给到 200 MB：这是"能离线看一段"的下限，再大就该留链接了。
 */
export const SIZE_LIMIT: Record<"image" | "video", number> = {
  image: 20 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

/** 选本地文件时的扩展名白名单 —— 只收图片和视频，其余一律走链接 */
export const MEDIA_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg",
  "mp4", "webm", "mov", "mkv", "avi", "m4v",
];

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 本地时间的月份分桶，形如 `2026-09`。用本地时间而不是 UTC：
 *  仓库目录是给人看的，凌晨 0 点存的东西不该被塞进上个月的文件夹。 */
export function monthBucket(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** MIME → 附件类型。认不出的一律算 link，也就是"不留本地副本"。 */
export function kindFromMime(mime: string): AttachmentKind {
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return "link";
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg", "ico"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"]);

/** 按扩展名先猜一下类型。只用于"要不要提示用户"，最终以真实 MIME 为准。 */
export function guessKindFromUrl(url: string): AttachmentKind {
  const ext = extFromName(url);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "link";
}

function extFromName(name: string): string {
  const clean = (name || "").split(/[?#]/)[0];
  const base = clean.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 网址里能读出来的文件名 */
export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return last || u.hostname;
  } catch {
    return url;
  }
}

/** 链接显示用的站点名。用 host 而不是 hostname —— 端口是有用的信息，
 *  内网地址（127.0.0.1:8080）去掉端口就认不出是哪个服务了。 */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.host || u.hostname).replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 本机路径里能读出来的文件名 */
export function fileNameFromPath(p: string): string {
  return (p || "").split(/[/\\]/).pop() || p || "file";
}

/**
 * 把各种 throw 出来的东西变成一句能给用户看的话。
 *
 * 需要它是因为错误来源太杂：Rust 命令返的是字符串、fetch 抛的是 TypeError、
 * 我们自己的 Error 带的是中文说明。直接 `String(e)` 会得到
 * "TypeError: Failed to fetch" 这种对用户毫无帮助的东西。
 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e ?? "未知错误");
}

/** 文件名净化，与 Rust 侧 safe_name 保持一致的策略（保留中文，替换非法字符） */
export function safeName(raw: string): string {
  const base = (raw || "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/\.+$/, "")
    .trim();
  if (!cleaned) return "file";
  if (cleaned.length <= 80) return cleaned;
  const ext = extFromName(cleaned);
  // 截断后的总长必须仍然 ≤ 80。"~" 和 "." 也要占位，少减一位就会得到
  // 一个 81 字符的名字 —— 而 Windows 的路径长度是硬上限，超了会写不进去。
  const keep = 80 - (ext ? ext.length + 2 : 0);
  return ext ? `${cleaned.slice(0, keep)}~.${ext}` : cleaned.slice(0, 80);
}

/** 人类可读的体积 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 时长，毫秒 → `1:23` / `1:02:03` */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/**
 * 内容指纹。
 *
 * 优先用 crypto.subtle 的 SHA-256 —— 与 Rust 侧 ring 算的是同一个值，
 * 所以两边算出来的 hash 可以直接比对、跨环境一致地去重。
 * 拿不到 subtle（非安全上下文）时退到自实现的 FNV-1a：
 * 强度差得多，但只用于 demo 里的重复检测，不承担安全职责。
 */
export async function contentHash(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes);

  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", buf as unknown as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return fnv1a128Hex(buf);
}

function fnv1a128Hex(bytes: Uint8Array): string {
  // FNV-1a 128 位，用 BigInt 手算。慢，但只在不安全上下文里兜底。
  const PRIME = 309485009821345068724781371n;
  const MASK = (1n << 128n) - 1n;
  let h = 144066263297769815596495629667062367629n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(32, "0");
}

/**
 * 拆开一个 data URL 或裸 base64，得到 (MIME, 字节)。
 *
 * 两个驱动都要它：桌面端其实是在 Rust 里解码的（这段只用于浏览器 demo），
 * 但**两边必须按同一套规则理解输入** —— 否则同一个 data URL 在浏览器里
 * 存成 png、在桌面端存成 bin，表现差异要到打包后才显形。
 * 所以规则写在 TS 里当参考实现，Rust 侧 split_data_url + b64_decode 与它对齐。
 *
 * 浏览器端只能用 atob，它不认 URL-safe 的 `-` `_`，也不认省略的 padding，
 * 这两种在实际数据里都出现过（canvas 导出正常，AI 接口回报的 base64 会省 padding），
 * 所以先规整再解。
 */
export function decodeDataUrl(raw: string): { mime: string | null; bytes: Uint8Array } {
  let mime: string | null = null;
  let body = raw;

  if (raw.startsWith("data:")) {
    const comma = raw.indexOf(",");
    if (comma >= 0) {
      const meta = raw.slice(5, comma);
      mime = meta.split(";")[0] || null;
      body = raw.slice(comma + 1);
    } else {
      // 只有前缀没有逗号：当成裸数据，别把 "image/png" 当成内容解
      body = raw.slice(5);
    }
  }

  const norm = body.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);

  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

/* ------------------------------------------------------------------ */
/* 接口                                                                */
/* ------------------------------------------------------------------ */

export interface StoredFile {
  /** 仓库内相对路径 —— 这个才是存进数据库的值 */
  relPath: string;
  /** 绝对路径，仅用于转 asset URL */
  absPath: string;
  size: number;
  hash: string;
  mime: string;
}

export interface RepoUsage {
  files: number;
  bytes: number;
}

export interface AttachmentStore {
  readonly driver: "tauri" | "browser";
  /** 仓库根目录（给人看的路径） */
  root(): Promise<string>;
  /** 相对路径 → 能直接喂给 img/video/a 的 URL */
  url(relPath: string): Promise<string>;
  /** 仓库里的文件还在不在（用户可能手动清理过磁盘） */
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<boolean>;
  usage(): Promise<RepoUsage>;
  /** 把网址下载进仓库 */
  download(url: string, opts: { name?: string; maxBytes: number }): Promise<StoredFile>;
  /** 把本机文件放进仓库。桌面上是绝对路径，浏览器里是 File 对象 */
  importLocal(source: string | File, opts: { maxBytes: number }): Promise<StoredFile>;
  /**
   * 把**内存里的一串字节**放进仓库。
   *
   * 这是给"在界面上当场产生、从未落过盘、也不在任何网址上"的内容用的：
   * 图片裁剪的 canvas 导出、AI 生成的图（接口回报 base64、或回报一个
   * 很快就会失效的临时 URL）。前两个入口都覆盖不到这类内容。
   */
  putDataUrl(data: string, opts: { name?: string; maxBytes: number }): Promise<StoredFile>;
}

/** 本机文件选择器返回的东西：桌面是路径数组，浏览器是 File 数组 */
export type PickedLocal = Array<string | File>;

/* ------------------------------------------------------------------ */
/* 实现一：桌面（走 Rust 命令）                                          */
/* ------------------------------------------------------------------ */

class TauriAttachmentStore implements AttachmentStore {
  readonly driver = "tauri" as const;
  /** Rust 侧算好的仓库根目录，取一次就够了 */
  private rootCache: string | null = null;

  private async rootPath(): Promise<string> {
    if (this.rootCache) return this.rootCache;
    this.rootCache = await invoke<string>("attachment_dir");
    return this.rootCache;
  }

  async root(): Promise<string> {
    return this.rootPath();
  }

  async url(relPath: string): Promise<string> {
    // asset 协议要的是绝对路径。tauri.conf.json 的 assetProtocol.scope
    // 必须包含 $APPDATA/attachments/**，否则这一步拿到的 URL 会被拒绝加载。
    const root = await this.rootPath();
    return convertFileSrc(`${root}\\${relPath.replace(/\//g, "\\")}`);
  }

  exists(relPath: string): Promise<boolean> {
    return invoke<boolean>("attachment_exists", { rel: relPath });
  }

  remove(relPath: string): Promise<boolean> {
    return invoke<boolean>("attachment_remove", { rel: relPath });
  }

  usage(): Promise<RepoUsage> {
    return invoke<RepoUsage>("attachment_usage");
  }

  download(url: string, opts: { name?: string; maxBytes: number }): Promise<StoredFile> {
    return invoke<StoredFile>("attachment_download", {
      url,
      name: opts.name ?? null,
      month: monthBucket(),
      maxBytes: opts.maxBytes,
    });
  }

  importLocal(source: string | File): Promise<StoredFile> {
    if (typeof source !== "string") {
      // 桌面端不该走到这里：原生对话框给的是路径而不是 File。
      // 真走到了说明调用方选错了入口，直接报错好过静默失败。
      return Promise.reject(new Error("桌面端请用原生文件对话框提供的路径"));
    }
    return invoke<StoredFile>("attachment_import", {
      src: source,
      name: null,
      month: monthBucket(),
    });
  }

  putDataUrl(data: string, opts: { name?: string; maxBytes: number }): Promise<StoredFile> {
    // 解码放在 Rust 里：一个 2 MB 的 PNG 变成约 2.7 MB 的字符串过 IPC，
    // 比让它变成几百万个 JSON 数字强得多。maxBytes 也由 Rust 侧的硬上限兜底，
    // 这里先按调用方给的上限做一次字符串层面的粗筛，省得白传一趟。
    if (data.length > (opts.maxBytes / 3) * 4 + 16) {
      return Promise.reject(new Error(`内容超过 ${formatBytes(opts.maxBytes)} 上限`));
    }
    return invoke<StoredFile>("attachment_put", {
      data,
      name: opts.name ?? null,
      month: monthBucket(),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 实现二：浏览器 demo（IndexedDB + blob URL）                          */
/* ------------------------------------------------------------------ */

const IDB_NAME = "todo-workbench:attachments";
const IDB_STORE = "files";

interface IdbRecord {
  relPath: string;
  blob: Blob;
  mime: string;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "relPath" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("打不开 IndexedDB"));
  });
}

async function idbPut(rec: IdbRecord): Promise<void> {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("写入 IndexedDB 失败"));
  });
  db.close();
}

async function idbGet(relPath: string): Promise<IdbRecord | null> {
  const db = await openIdb();
  const rec = await new Promise<IdbRecord | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(relPath);
    req.onsuccess = () => resolve((req.result as IdbRecord) ?? null);
    req.onerror = () => reject(req.error ?? new Error("读取 IndexedDB 失败"));
  });
  db.close();
  return rec;
}

async function idbDelete(relPath: string): Promise<boolean> {
  const existed = !!(await idbGet(relPath));
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(relPath);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("删除 IndexedDB 记录失败"));
  });
  db.close();
  return existed;
}

async function idbAll(): Promise<IdbRecord[]> {
  const db = await openIdb();
  const all = await new Promise<IdbRecord[]>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve((req.result as IdbRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("遍历 IndexedDB 失败"));
  });
  db.close();
  return all;
}

class IdbAttachmentStore implements AttachmentStore {
  readonly driver = "browser" as const;

  /**
   * blob URL 缓存。
   * 每个 URL 都会把整个对象钉在内存里，媒体多了会很可观，
   * 所以删除时**必须**撤销，否则附件删了内存还占着。
   */
  private urls = new Map<string, string>();

  async root(): Promise<string> {
    return "IndexedDB（浏览器 demo 没有真实文件系统）";
  }

  async url(relPath: string): Promise<string> {
    const cached = this.urls.get(relPath);
    if (cached) return cached;
    const rec = await idbGet(relPath);
    if (!rec) throw new Error("文件不在仓库里");
    const u = URL.createObjectURL(rec.blob);
    this.urls.set(relPath, u);
    return u;
  }

  async exists(relPath: string): Promise<boolean> {
    return !!(await idbGet(relPath));
  }

  async remove(relPath: string): Promise<boolean> {
    const u = this.urls.get(relPath);
    if (u) {
      URL.revokeObjectURL(u);
      this.urls.delete(relPath);
    }
    return idbDelete(relPath);
  }

  async usage(): Promise<RepoUsage> {
    const all = await idbAll();
    return { files: all.length, bytes: all.reduce((n, r) => n + (r.blob?.size ?? 0), 0) };
  }

  async download(url: string, opts: { name?: string; maxBytes: number }): Promise<StoredFile> {
    // 这里只能硬扛 CORS。跨域被拦时给出可操作的提示，
    // 而不是把浏览器的 TypeError 原样抛给用户看。
    let res: Response;
    try {
      res = await fetch(url, { mode: "cors", credentials: "omit" });
    } catch {
      throw new Error("这个站点不允许跨域下载（浏览器限制）。桌面版可以直连，这里只能改存链接");
    }
    if (!res.ok) throw new Error(`对方返回 ${res.status}`);

    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > opts.maxBytes) {
      throw new Error(`文件 ${formatBytes(len)}，超过 ${formatBytes(opts.maxBytes)} 上限`);
    }

    const blob = await res.blob();
    if (blob.size > opts.maxBytes) {
      throw new Error(`文件 ${formatBytes(blob.size)}，超过 ${formatBytes(opts.maxBytes)} 上限`);
    }
    return this.storeBlob(blob, opts.name || fileNameFromUrl(url));
  }

  async importLocal(source: string | File, opts: { maxBytes: number }): Promise<StoredFile> {
    if (typeof source === "string") {
      throw new Error("浏览器端拿不到本机路径，请用文件选择器");
    }
    if (source.size > opts.maxBytes) {
      throw new Error(`文件 ${formatBytes(source.size)}，超过 ${formatBytes(opts.maxBytes)} 上限`);
    }
    return this.storeBlob(source, source.name || "file");
  }

  async putDataUrl(data: string, opts: { name?: string; maxBytes: number }): Promise<StoredFile> {
    const { mime, bytes } = decodeDataUrl(data);
    if (bytes.length > opts.maxBytes) {
      throw new Error(`内容 ${formatBytes(bytes.length)}，超过 ${formatBytes(opts.maxBytes)} 上限`);
    }
    // ⚠️ 与桌面端的**已知差异**：桌面端会按 magic bytes 重判真实类型，
    // 浏览器 demo 没有这套探测（storeBlob 直接用 blob.type）。
    // 所以这里的 MIME 就是最终值 —— 调用方必须给对。
    // 两条真实来源（canvas.toDataURL / 生图接口回报的 b64_json）都自带正确 MIME，
    // 所以这个差异在正常路径上不会显形；但**别在浏览器里拿它去存改过后缀的东西**。
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: mime || "application/octet-stream",
    });
    return this.storeBlob(blob, opts.name || "image");
  }

  private async storeBlob(blob: Blob, rawName: string): Promise<StoredFile> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await contentHash(bytes);
    const name = safeName(rawName);
    const bucket = monthBucket();
    const relPath = `${bucket}/${hash.slice(0, 8)}-${name}`;

    const mime = blob.type || "application/octet-stream";
    // 与桌面端一致：内容寻址，同一份内容只存一次
    if (!(await idbGet(relPath))) {
      await idbPut({ relPath, blob, mime });
    }
    return { relPath, absPath: relPath, size: blob.size, hash, mime };
  }
}

/* ------------------------------------------------------------------ */
/* 环境装配                                                            */
/* ------------------------------------------------------------------ */

let store: AttachmentStore | null = null;

export function attachmentStore(): AttachmentStore {
  if (!store) store = isTauri() ? new TauriAttachmentStore() : new IdbAttachmentStore();
  return store;
}

/** 仅供测试重置 */
export function __resetAttachmentStore(): void {
  store = null;
}

/**
 * 仅供测试注入替身。
 *
 * 为什么必须有这个口子：数据层（图库/附件）里最值钱的那几条规则 ——
 * 「先落文件再写元数据」「文件按内容去重、删除前跨表数引用」——
 * 全都发生在"仓库"与"数据库"的**交界处**，而真实仓库在单测环境里
 * 要么要 IndexedDB（jsdom 没有），要么要 Tauri 命令（更不可能）。
 * 没有替身就只能不测，或者测一个假的仓库行为 —— 那等于没测。
 *
 * 生产代码永远不要调它。传 null 等价于 __resetAttachmentStore()。
 */
export function __setAttachmentStore(s: AttachmentStore | null): void {
  store = s;
}

/* ------------------------------------------------------------------ */
/* 取本机文件                                                          */
/* ------------------------------------------------------------------ */

/**
 * 拉起本机文件选择器，只允许图片和视频。
 *
 * 其它类型**故意不支持**：本地文件不像网址那样有个可以存下来的链接，
 * 而产品约定是"文件用链接"。与其把一个本机路径伪装成链接（换台机器就失效），
 * 不如直接说清楚——界面上也是这么提示的。
 */
export async function pickLocalMedia(): Promise<PickedLocal> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      directory: false,
      title: "选择图片或视频",
      filters: [{ name: "图片与视频", extensions: MEDIA_EXTENSIONS }],
    });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  }

  // 浏览器：临时 input，不留在 DOM 里
  return new Promise<PickedLocal>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,video/*";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const files: File[] = input.files ? [...input.files] : [];
      input.remove();
      resolve(files);
    });
    // 用户取消时不会有 change 事件。把取消当成"什么都没选"，
    // 靠 window 重新拿到焦点来兜底关闭（不然 input 会一直挂在 DOM 上）
    window.addEventListener(
      "focus",
      () => {
        setTimeout(() => {
          if (input.isConnected) {
            input.remove();
            resolve([]);
          }
        }, 300);
      },
      { once: true },
    );
    input.click();
  });
}

/* ------------------------------------------------------------------ */
/* 打开外部链接                                                        */
/* ------------------------------------------------------------------ */

/**
 * 用系统默认程序打开链接。
 *
 * 桌面上必须绕到 Rust：webview 默认不允许新开窗口，
 * 界面里 `window.open` 会静默失败（点下去毫无反应，也不报错）。
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_external", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/* ------------------------------------------------------------------ */
/* 媒体尺寸探测                                                        */
/* ------------------------------------------------------------------ */

export interface MediaSize {
  width: number;
  height: number;
  durationMs: number | null;
}
