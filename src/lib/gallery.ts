/**
 * 图库 —— 工作台里所有图片/视频的**共同落点**。
 *
 * ============================ 设计要点 ============================
 *
 * 1) 只有一张表，不是一个工具。
 *    「图库」的用法就是"一个地方存所有素材，谁都能往里放、谁都能从里面取"：
 *    图片裁剪的产物、尺码表的成品、AI 生成的结果、用户自己导入的图，
 *    全都落到同一处；而 AI 生成的参考图必须能直接从图库里挑。
 *    做成 tools/gallery 就做不到 —— 工具在物理上拿不到别的工具的数据
 *    （见 toolBridge.ts 的安全边界），双向联动无从谈起。
 *
 * 2) 文件仍然走附件那套**内容寻址仓库**（Rust 的 attachments.rs）。
 *    这里只存 rel_path / hash，不碰字节；文件真正落在哪由 Rust 决定。
 *    所以 desktop 与浏览器 demo 的行为差异被关在 attachments.ts 里面，
 *    本文件两个驱动共用同一份逻辑。
 *
 * 3) ⚠️ **查询必须留在内存库的 SQL 子集里**，因为它不支持的东西
 *    会**静默返回空**（不是报错，比报错危险得多，见 db.ts 的注释）。
 *    能用：单表 WHERE / OR 分组 / LIKE / ORDER BY / LIMIT / COUNT(*)。
 *    不能用：JOIN、子查询、**OFFSET**。
 *    所以搜索是"先按 kind/origin 取回来、再在 JS 里过滤"，
 *    而不是把三个 LIKE 塞进一条 SQL —— 后者两驱行为可能不一致，
 *    而这类不一致只会在浏览器 demo 里显形，最难查。
 */

import { db } from "./db";
import {
  attachmentStore,
  fileNameFromUrl,
  formatBytes,
  guessKindFromUrl,
  kindFromMime,
  SIZE_LIMIT,
} from "./attachments";
import { refCountByHash } from "./repo";
import type { GalleryItem, GalleryKind, GalleryOrigin } from "../types";

/* ------------------------------------------------------------------ */
/* 行 ↔ 模型                                                           */
/* ------------------------------------------------------------------ */

interface RawGallery {
  id: string;
  title: string;
  kind: string;
  rel_path: string | null;
  source_url: string | null;
  mime: string;
  size_bytes: number | null;
  hash: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  origin: string;
  prompt: string;
  note: string;
  deleted: number;
  created_at: string;
}

function toItem(r: RawGallery): GalleryItem {
  return {
    id: r.id,
    title: r.title,
    // 数据库里是裸字符串（SQLite 没有枚举）。认不出的一律当图片：
    // 图库的界面按类型分栏，落到"图片"是最不容易让人找不到东西的兜底。
    kind: r.kind === "video" ? "video" : "image",
    relPath: r.rel_path,
    sourceUrl: r.source_url,
    mime: r.mime,
    size: r.size_bytes,
    hash: r.hash,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    origin: (r.origin || "manual") as GalleryOrigin,
    prompt: r.prompt,
    note: r.note,
    createdAt: r.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export interface GalleryQuery {
  /** 不限时传 "all"（默认） */
  kind?: GalleryKind | "all";
  origin?: GalleryOrigin | "all";
  /** 关键词，匹配标题 / 提示词 / 备注。空串表示不过滤 */
  search?: string;
  /** 最多返回多少条。0 或不传表示不限 */
  limit?: number;
}

/** 关键词匹配。大小写不敏感 —— 与 SQLite 的 LIKE 默认行为保持一致。 */
function matches(q: GalleryItem, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return (
    q.title.toLowerCase().includes(n) ||
    q.prompt.toLowerCase().includes(n) ||
    q.note.toLowerCase().includes(n)
  );
}

/**
 * 列出图库条目，最新的在前。
 *
 * 搜索走 JS 过滤而不是 SQL LIKE，原因见文件头第 3 条。
 * 注意随之而来的一条约束：**有搜索词时不能在 SQL 里加 LIMIT** ——
 * 否则只是"在最近 N 条里搜"，用户会看到"明明在图库里却搜不到"。
 */
export async function fetchGallery(query: GalleryQuery = {}): Promise<GalleryItem[]> {
  const where: string[] = ["deleted = 0"];
  const params: (string | number)[] = [];

  if (query.kind && query.kind !== "all") {
    where.push("kind = ?");
    params.push(query.kind);
  }
  if (query.origin && query.origin !== "all") {
    where.push("origin = ?");
    params.push(query.origin);
  }

  const search = (query.search ?? "").trim();
  const limit = search ? 0 : (query.limit ?? 0);

  // created_at 可能精确到毫秒都相同（工具批量写入时），补 id 保证顺序稳定，
  // 否则同一批图每次刷新顺序都可能变，看起来像"图自己会跑"
  let sql = `SELECT * FROM core_gallery_items WHERE ${where.join(" AND ")}
             ORDER BY created_at DESC, id DESC`;
  if (limit > 0) sql += ` LIMIT ${Math.floor(limit)}`;

  const rows = await db().select<RawGallery>(sql, params);
  const items = rows.map(toItem);
  return search ? items.filter((i) => matches(i, search)).slice(0, query.limit || undefined) : items;
}

/**
 * 按内容指纹找一条还在图库里的记录。
 *
 * 存在的理由只有一个：**工具的产出默认留一份进图库之后，重复是常态** ——
 * 同一张图反复导出、同一个提示词再生成一次、批量处理里同一份源图被处理两遍。
 * 内容寻址让这些重复在**仓库里只占一份字节**，但数据库里仍是 N 条记录，
 * 用户看到的就是"同一张图在图库里排了一整排"，而且越用越脏。
 *
 * 所以自动存档那条路要先问一句"这一份是不是已经有了"。
 *
 * 只按 hash 判，**不看 origin**：图库关心的是字节，不是谁放的。
 * 一张 AI 生成的图被裁剪工具原样导出一次，图库里已经有这份内容了，
 * 再记一条只是噪音。
 */
export async function findGalleryByHash(hash: string | null): Promise<GalleryItem | null> {
  if (!hash) return null;
  const rows = await db().select<RawGallery>(
    `SELECT * FROM core_gallery_items WHERE hash = ? AND deleted = 0
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [hash],
  );
  return rows.length ? toItem(rows[0]) : null;
}

/** 图库条目总数（未删除），给侧边栏角标用 */
export async function countGallery(): Promise<number> {
  const rows = await db().select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM core_gallery_items WHERE deleted = 0`,
  );
  return rows[0]?.c ?? 0;
}

/** 按来源统计，用于界面上的筛选计数 */
export async function galleryCountsByOrigin(): Promise<Record<string, number>> {
  const rows = await db().select<{ origin: string; c: number }>(
    `SELECT origin, COUNT(*) AS c FROM core_gallery_items WHERE deleted = 0 GROUP BY origin`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.origin || "manual"] = Number(r.c ?? 0);
  return out;
}

export async function getGalleryItem(id: string): Promise<GalleryItem | null> {
  const rows = await db().select<RawGallery>(
    `SELECT * FROM core_gallery_items WHERE id = ?`,
    [id],
  );
  return rows[0] ? toItem(rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();

/**
 * 图库条目的 id：**必须时间有序**，不能用纯随机。
 *
 * 原因是真实会发生的事：从裁剪工具一次导入两三张、或 AI 一次出四张，
 * 这些记录落在同一毫秒里，`created_at` 完全相同。此时 `ORDER BY created_at DESC`
 * 的第二排序键若还是个随机串，顺序就成了"看数据库心情"——
 * 同一批图每次刷新位置都可能变，用户看到的就是"图自己会跑"。
 *
 * 所以前缀是毫秒时间戳（36 进制定长，保证字符串比较等于数值比较），
 * 中间两位是同一毫秒内的自增序号，尾部才补随机防碰撞。
 * 这样 `ORDER BY created_at DESC, id DESC` 真的是"最新在前、同批按导入序"。
 */
let uidSeq = 0;
let uidLastMs = 0;
const uid = (): string => {
  const ms = Date.now();
  if (ms === uidLastMs) uidSeq += 1;
  else {
    uidLastMs = ms;
    uidSeq = 0;
  }
  return (
    ms.toString(36).padStart(9, "0") +
    (uidSeq % 1296).toString(36).padStart(2, "0") +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
};

/** 按类型取大小上限。图库只收媒体，不会走到 link 那档。 */
function limitFor(kind: GalleryKind): number {
  return SIZE_LIMIT[kind === "video" ? "video" : "image"];
}

/**
 * 放进图库的三种输入，**三选一**。
 *
 * 它们对应三条不同的落盘路径，不是"随便传哪个都行"：
 *   dataUrl → 内存里当场产生的内容（canvas 导出、AI 回报的 base64）
 *   url     → 网上的东西（AI 回报的临时 URL、用户粘贴的地址）
 *   local   → 本机已有的文件（桌面是路径，浏览器是 File 对象）
 */
export interface AddMediaInput {
  dataUrl?: string;
  url?: string;
  local?: string | File;
  title?: string;
  origin: GalleryOrigin;
  prompt?: string;
  note?: string;
  /** 探测到的尺寸，调用方补；缺省就留空等事后回填 */
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /**
   * 内容已在图库里时，返回已有那条（标 `dup: true`）而不是再插一条。
   *
   * 只有**自动存档**这类"替用户保管"的场景该开：那一次保存不是用户主动点的，
   * 重复了也无从解释。用户亲自点「存进图库」时不该开 —— 他明确要留一份，
   * 哪怕内容一样（比如同一个提示词重新生成了一次，本来就该是两条）。
   */
  dedupe?: boolean;
}

/**
 * 把一份媒体放进图库：**先落文件、再写元数据**。
 *
 * 顺序不能反。反过来的话，文件写失败时库里会留下一条指向空气的记录，
 * 界面上表现为一张永远加载不出来的破图，而用户无法判断是网络问题
 * 还是数据坏了。先落文件则最坏情况是"仓库里多了个没人引用的文件"——
 * 那只是浪费几 MB，不会骗人。
 *
 * 去重（dedupe）也建立在这个顺序上：**先落盘、拿到 hash、再决定插不插**。
 * 落盘本身是幂等的（同一份字节 → 同一个 rel_path），所以"为了查重先落一次盘"
 * 不会留下垃圾，只是白算一次哈希。反过来想先查 hash 是做不到的 ——
 * 内容还没落盘，指纹无从谈起。
 */
export async function addToGallery(input: AddMediaInput): Promise<GalleryItem> {
  const store = attachmentStore();

  // 先用"名字 / 网址"猜类型，只为把大小上限和标题定下来；
  // 真正的类型以落盘后仓库回报的 mime 为准（桌面端会按 magic bytes 重判）。
  // 注意 kindFromMime / guessKindFromUrl 返回的是附件的三分法（含 "link"），
  // 而图库只有 image / video 两档 —— 所以这里要收敛一次：
  // 认不出的一律按图片处理（用图片的上限，宁可错在更严的那一侧）。
  const guessName = input.url ? fileNameFromUrl(input.url) : (input.title || "image");
  const guessRaw =
    input.local instanceof File
      ? kindFromMime(input.local.type)
      : input.url
        ? guessKindFromUrl(input.url)
        : "image";
  const kind: GalleryKind = guessRaw === "video" ? "video" : "image";
  const maxBytes = limitFor(kind);

  const stored = input.dataUrl
    ? await store.putDataUrl(input.dataUrl, { name: guessName, maxBytes })
    : input.url
      ? await store.download(input.url, { name: guessName, maxBytes })
      : input.local != null
        ? await store.importLocal(input.local, { maxBytes })
        : (() => {
            throw new Error("没有给出任何内容（dataUrl / url / local 至少要有一样）");
          })();

  // 落盘后的真实 mime 才作数：data URL 里谎报、网址后缀骗人都是常事，
  // 而桌面端的 store_bytes 已经用 magic bytes 判过一次了
  const realKind: GalleryKind = kindFromMime(stored.mime) === "video" ? "video" : "image";
  const title = (input.title || "").trim() || stored.relPath.split("/").pop() || "未命名";

  const item: GalleryItem = {
    id: uid(),
    title,
    kind: realKind,
    relPath: stored.relPath,
    sourceUrl: input.url ?? null,
    mime: stored.mime,
    size: stored.size,
    hash: stored.hash,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    origin: input.origin,
    prompt: input.prompt ?? "",
    note: input.note ?? "",
    createdAt: nowIso(),
  };

  // 命中已有内容：把那一条交回去，不新增记录（理由见 findGalleryByHash 的注释）
  if (input.dedupe && item.hash) {
    const prev = await findGalleryByHash(item.hash);
    if (prev) return { ...prev, dup: true };
  }

  await db().execute(
    `INSERT INTO core_gallery_items
       (id, title, kind, rel_path, source_url, mime, size_bytes, hash,
        width, height, duration_ms, origin, prompt, note, deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      item.id,
      item.title,
      item.kind,
      item.relPath,
      item.sourceUrl,
      item.mime,
      item.size,
      item.hash,
      item.width,
      item.height,
      item.durationMs,
      item.origin,
      item.prompt,
      item.note,
      item.createdAt,
    ],
  );

  return item;
}

/** 改标题/备注/探测到的尺寸。只允许改这几个字段，文件与来源不可变。 */
export async function updateGalleryItem(
  id: string,
  patch: Partial<Pick<GalleryItem, "title" | "note" | "width" | "height" | "durationMs">>,
): Promise<void> {
  const map: Record<string, string> = {
    title: "title",
    note: "note",
    width: "width",
    height: "height",
    durationMs: "duration_ms",
  };
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, col] of Object.entries(map)) {
    if (!(key in patch)) continue;
    sets.push(`${col} = ?`);
    const v = (patch as Record<string, unknown>)[key];
    params.push(v == null ? null : (v as string | number));
  }
  if (!sets.length) return;
  params.push(id);
  await db().execute(`UPDATE core_gallery_items SET ${sets.join(", ")} WHERE id = ?`, params);
}

/**
 * 从图库删除一条，返回"可以顺手删掉的仓库文件"（没有则 null）。
 *
 * **文件是内容寻址的，不能想删就删**：同一份字节可能同时被
 * 某张工单的附件和另一条图库记录引用。所以这里只做引用计数判断，
 * 真正的删除交给调用方（它才有文件仓库的句柄）。
 * 引用计数**跨两张表**，见 repo.refCountByHash 的注释。
 *
 * 幂等：已经软删过的记录直接返回 null。返回非 null 的含义是
 * "这个文件现在可以删了"，而删过一次之后再给同一个路径，调用方会去
 * 删一个已经不存在的文件 —— 无害，但会让"删了几个"的统计虚高。
 */
export async function deleteGalleryItem(id: string): Promise<string | null> {
  const rows = await db().select<RawGallery>(
    `SELECT * FROM core_gallery_items WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.deleted) return null;

  // 软删除：先把记录标记掉，再数引用 —— 顺序反了会把自己算进去，
  // 于是引用数永远 ≥ 1，文件永远删不掉
  await db().execute(`UPDATE core_gallery_items SET deleted = 1 WHERE id = ?`, [id]);

  if (!row.hash || !row.rel_path) return null;
  const live = await refCountByHash(row.hash);
  return live > 0 ? null : row.rel_path;
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                            */
/* ------------------------------------------------------------------ */

const ORIGIN_LABEL: Record<GalleryOrigin, string> = {
  manual: "手动导入",
  "ai-gen": "AI 生成",
  "image-crop": "图片裁剪",
  "size-chart": "尺码表",
};

export function originLabel(o: GalleryOrigin): string {
  return ORIGIN_LABEL[o] ?? o;
}

/** 来源的语义色，与侧边栏/工具区既有的配色对应 */
export const ORIGIN_COLOR: Record<GalleryOrigin, string> = {
  manual: "#8a8985",
  "ai-gen": "#7c5cff",
  "image-crop": "#378add",
  "size-chart": "#1d9e75",
};

/** 一键摘要，给卡片底部那行小字用 */
export function summarize(item: GalleryItem): string {
  const bits: string[] = [];
  if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
  if (item.size) bits.push(formatBytes(item.size));
  if (!bits.length) bits.push(item.mime || "未知类型");
  return bits.join(" · ");
}

/* ------------------------------------------------------------------ */
/* 变更广播                                                            */
/* ------------------------------------------------------------------ */

/**
 * "图库变了"的事件名。
 *
 * 为什么需要它：往图库里写东西的有三个不同的地方 ——
 * 图库界面自己（导入/删除）、工具 iframe（经桥进来的 gallery.put）、
 * 以及将来可能的批量导入。而后两者发生的时候，**图库界面一无所知**：
 * 工具是 iframe，写库是在宿主进程里做的；界面上又没有一个"刷新"按钮
 * 能覆盖这种情况。
 *
 * 定成全局事件而不是塞进 store：写库的地方（toolBridge）不该反过来
 * 依赖某个 React 组件的存在，监听方也可能不止一个。
 */
export const GALLERY_CHANGED = "workbench:gallery-changed";

/** 广播"图库变了"。写入方调它，界面自己监听 */
export function notifyGalleryChanged(): void {
  // 非浏览器环境（单元测试里直接调数据层）没有 window，静默跳过
  globalThis.dispatchEvent?.(new CustomEvent(GALLERY_CHANGED));
}

/* ------------------------------------------------------------------ */
/* 缩略图                                                              */
/* ------------------------------------------------------------------ */

/** 缩略图最长边的默认像素数 */
export const THUMB_MAX = 320;

/**
 * 生成一张缩略图的 data URL。
 *
 * 为什么需要它（而不是直接把原图 URL 给工具）：
 * 工具跑在 iframe 里，**桌面端它与宿主不同源**（工具走 asset 协议）。
 * 把宿主仓库的 asset URL 交给工具，能不能加载取决于那条链路是否跨源 ——
 * 这正是 PITFALLS 里"桌面端 iframe 的 postMessage 可能双向被丢弃"那类
 * 问题的近亲，而桌面端交互层没有自动化把守（desktop-app.mjs 明确测不了）。
 * 所以这里**不赌链路**：缩略图以 data URL 的形式跟着消息走，
 * 消息能到，图就能显示，与源、协议、CSP 全都无关。
 *
 * 代价是多一次解码 + 重编码。但图库在工具里就是一片选择用的格子，
 * 320px 足够，一次也就几十毫秒。
 *
 * 视频返回空串 —— 抽首帧要在 <video> 上 seek，还得等时机，
 * 换来的只是一格预览。工具那边画个图标即可，不值得为此引入不确定性。
 */
export async function makeThumb(relPath: string, max: number = THUMB_MAX): Promise<string> {
  const url = await attachmentStore().url(relPath);
  const img = new Image();
  img.src = url;
  // decode() 而不是 onload：onload 在有些实现里早于解码完成，
  // 这时候画到 canvas 上会得到一张空白图
  await img.decode();

  const w = img.naturalWidth || max;
  const h = img.naturalHeight || max;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

/**
 * 读一条图库文件的**完整**内容，返回 data URL。
 *
 * 这是给"把图库里的图喂给生成接口"用的：生图接口普遍接受公开 URL 或
 * data URI，而仓库里的文件是本地的，所以只能转成 data URI 送过去。
 */
export async function readGalleryDataUrl(
  item: GalleryItem,
  maxBytes: number,
): Promise<{ dataUrl: string; mime: string }> {
  if (!item.relPath) throw new Error("这条记录没有本地文件");
  if (item.size != null && item.size > maxBytes) {
    throw new Error(`原图 ${formatBytes(item.size)}，超过 ${formatBytes(maxBytes)} 上限`);
  }

  const url = await attachmentStore().url(item.relPath);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读取失败：${res.status}`);
  const blob = await res.blob();
  if (blob.size > maxBytes) {
    throw new Error(`原图 ${formatBytes(blob.size)}，超过 ${formatBytes(maxBytes)} 上限`);
  }

  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // 分块拼，避免一次 apply 几万个参数把栈打爆
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  const mime = item.mime || blob.type || "application/octet-stream";
  return { dataUrl: `data:${mime};base64,${btoa(bin)}`, mime };
}
