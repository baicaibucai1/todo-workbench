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
 */

import { db, dbInfo, isTauri } from "./db";
import { toolTable } from "./tools";
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
    /** gallery.get / gallery.put */
    id?: string;
    kind?: string;
    limit?: number;
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
}

export interface ToolBridge {
  /** 开始监听工具发来的请求 */
  attach: () => void;
  /** 停止监听（切工具/离开视图时调用） */
  detach: () => void;
  /** 主动把运行上下文推给工具（加载完成、主题切换时） */
  pushContext: () => void;
}

export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** 组装工具运行上下文 —— 工具据此显示"我连到哪儿了" */export function buildContext(toolId: string): ToolContext {
  const info = dbInfo();
  return {
    toolId,
    tablePrefix: `tool_${toolId.replace(/-/g, "_")}_`,
    driver: info.driver,
    schemaVersion: info.schemaVersion,
    theme: currentTheme(),
    runtime: isTauri() ? "desktop" : "browser",
    gallery: true,
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
 * @param toolId  当前工具的 id（表名前缀的来源）
 * @param getFrame 返回当前 iframe 元素；返回 null 时丢弃消息
 */
export function createToolBridge(
  toolId: string,
  getFrame: () => HTMLIFrameElement | null,
): ToolBridge {
  const post = (msg: unknown) => {
    const frame = getFrame();
    // 只发给已就绪的 iframe；目标 origin 用同源，工具由宿主同源服务
    frame?.contentWindow?.postMessage(msg, window.location.origin);
  };

  const reply = (id: string | undefined, ok: boolean, data: unknown) => {
    if (ok) post({ source: HOST_SOURCE, type: "tool:response", id, ok: true, data });
    else post({ source: HOST_SOURCE, type: "tool:response", id, ok: false, error: data });
  };

  const onMessage = async (e: MessageEvent) => {
    const frame = getFrame();
    // 只认当前 iframe 发来的消息：同页面其他 iframe 不能冒充这个工具
    if (!frame || e.source !== frame.contentWindow) return;

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
    detach: () => window.removeEventListener("message", onMessage),
    pushContext: () => post({ source: HOST_SOURCE, type: "tool:context", data: buildContext(toolId) }),
  };
}
