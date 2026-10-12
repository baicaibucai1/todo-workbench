/**
 * 安装时把单文件 HTML 的**外部资源抓下来内联**，让工具落地就是完整的。
 *
 * 为什么做这件事：工具在离线 iframe（asset 协议）里跑，页面上任何
 * `//cdn.example/x.js` 都活不成 —— 防盗链（tool.lu 实测 `403 EmptyReferer`）、
 * Chromium 的 ORB、还有整站页面自带的导航把工具区挤成一团。
 * 2026-10-12 用户明确要求：别光提示，**把资源抓进来打包**。
 *
 * 所以流程变成：下载页面 → 抓取它引用的每个脚本/样式/图片 → 内联
 *   · script src      → `<script>内容</script>`（转义 `</script` 与 `<!--`）
 *   · link stylesheet → `<style>内容</style>`，内容里的 `url(...)` 再抓成 data: URI
 *   · img src         → `data:image/...;base64`（丢掉 srcset，留下会用外链的候选）
 *   · favicon         → 抓得到就内联，抓不到就静默删掉（不值得为它亮警告）
 *   · @import         → 递归抓一层（字体图标站常这么引）
 *
 * 抓取走 Rust（tool_fetch：浏览器 UA + Referer，绕防盗链），由调用方注入 ——
 * 这样本模块在 Node 里可以用本地 http 服务器做**真实端到端测试**（tests/tool-htmlscan.mjs）。
 *
 * 抓不到的（403 / 超大 / 相对地址没有基准）会进 `failed` 列表，由上层转成
 * 导入框里的警告 —— 「提示」还在，只是从唯一手段降级成了兜底。
 */

export interface SubResourceFetcher {
  /** 抓一个二进制资源；referer 传页面自己的地址（防盗链看的就是它） */
  (url: string, referer: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export interface InlineOutcome {
  kind: "script" | "style" | "img" | "favicon" | "cssAsset";
  url: string;
}

export interface InlineFailure {
  url: string;
  reason: string;
}

export interface InlineResult {
  html: string;
  inlined: InlineOutcome[];
  failed: InlineFailure[];
}

/** 单个资源的大小上限：图片/字体超过它多半不是"资源"而是"附件"了 */
const DEFAULT_MAX_RESOURCE_BYTES = 6 * 1024 * 1024;

/** 这些开头的引用跟着文档走，不用抓 */
const SELF_CONTAINED = /^(data:|blob:|about:|#|javascript:)/i;

/** 并发抓取上限 —— 太高容易被站点当 CC 攻击 */
const CONCURRENCY = 5;

/** 把引用解析成绝对地址；解析不了（相对地址且没有基准）返回 null */
function resolveUrl(ref: string, base: string): string | null {
  const u = ref.trim();
  if (!u || SELF_CONTAINED.test(u)) return null;
  try {
    return new URL(u, base || undefined).toString();
  } catch {
    return null;
  }
}

/**
 * 这条引用像不像一个**真的资源地址**。
 *
 * 正则扫 HTML 会被内联 JS 里的模板字符串骗：`document.write("<script src='"
 * + x + "'>")` 里的 `<script src='...'>` 看起来和真标签一模一样（tool.lu 的
 * facebox 就是这么混进 4 条 404 假警报的）。真地址几乎不会有引号/加号/美元符
 * 拼接痕迹，而且要么带路径、要么带个像样的资源扩展名。
 */
function plausibleRef(ref: string): boolean {
  const u = ref.trim();
  if (!u) return false;
  if (/['"`+$<>{}\\]/.test(u)) return false; // JS 模板/字符串拼接的残留
  if (!u.includes("/") && !/\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|woff2?|ttf|otf|eot|mp4|webm|wasm)([?#]|$)/i.test(u)) {
    return false; // 既不是路径也不是可辨认的资源扩展名
  }
  return true;
}

/** 限流并发的 map */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** 从字节流猜 MIME：Content-Type 可信就用它，不然按魔术字节认 */
export function sniffMime(bytes: Uint8Array, contentType: string): string {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("image/") || ct.startsWith("font/")) return ct;
  const b = bytes;
  const u32 = (o: number) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  if (b.length > 8 && u32(0) === 0x89504e47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length > 12 && b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  if (b.length > 4 && b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && (b[3] === 0x46 || b[3] === 0x32))
    return b[3] === 0x32 ? "font/woff2" : "font/woff";
  if (b.length > 5 && b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "font/ttf";
  if (b.length > 5 && b[0] === 0x4f && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x4f) return "font/otf";
  const head = new TextDecoder().decode(bytes.slice(0, 300)).trimStart();
  if (head.startsWith("<") || head.startsWith("<?xml")) return "image/svg+xml";
  return ct || "application/octet-stream";
}

function toDataUri(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/** 内联进 <script> 前的转义：这两个序列会把 script 标签提前终结掉 */
function escapeScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

/**
 * 从标签属性串里剥掉指定属性。必须**循环剥到稳定** —— 全局正则一遍扫过时，
 * 前一个匹配会把属性间的空格一起吃掉，导致下一个属性不再满足 `\s+` 前缀而幸存
 * （实测 `<script src integrity crossorigin>` 剥完剩下 crossorigin，就是这么来的）。
 */
function stripAttrs(s: string, names: string[]): string {
  const re = new RegExp(`\\s+(${names.join("|")})\\s*(=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "gi");
  let prev;
  do {
    prev = s;
    s = s.replace(re, " ");
  } while (s !== prev);
  return s;
}

/** 内联进 <style> 前的转义 */
function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

interface Ctx {
  base: string;
  fetchBin: SubResourceFetcher;
  maxBytes: number;
  /** 同一个 URL 只抓一次：缓存的是 Promise（并发去重），失败也会记进 failed */
  cache: Map<string, Promise<{ bytes: Uint8Array; contentType: string }>>;
  inlined: InlineOutcome[];
  failed: InlineFailure[];
  failuresByUrl: Map<string, string>;
  /** 进度：三个主处理阶段里每敲定一项就 +1（css 里的 url() 是二级发现，不计入） */
  tick: () => void;
}

function fetchResource(ctx: Ctx, url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const hit = ctx.cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    try {
      const r = await ctx.fetchBin(url, ctx.base);
      if (r.bytes.length > ctx.maxBytes) {
        throw new Error(`资源 ${(r.bytes.length / 1048576).toFixed(1)} MB 超过单个上限`);
      }
      return r;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!ctx.failuresByUrl.has(url)) {
        ctx.failuresByUrl.set(url, reason);
        ctx.failed.push({ url, reason });
      }
      throw err;
    }
  })();
  ctx.cache.set(url, p);
  // 失败必然有 pooled 里的 worker 在 await，这里兜一道防 unhandledrejection
  p.catch(() => {});
  return p;
}

/** 抓文本资源；抓回来的是 HTML（防盗链页）时按失败算 */
async function fetchText(ctx: Ctx, url: string, what: string): Promise<string> {
  const { bytes, contentType } = await fetchResource(ctx, url);
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    throw new Error(`${what} 抓回来的是 HTML —— 多半被防盗链拦了（Referer 不对）`);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 抓 css 里的 url(...) 与 @import，改成 data: URI / 内联内容。
 * base 是**这份 css 自己的地址**（相对引用以它为基准，不是以页面）。
 */
async function inlineCssUrls(ctx: Ctx, css: string, cssUrl: string, depth: number): Promise<string> {
  let out = css;

  // @import：抓进来递归处理后内联（只递归一层，防环）
  if (depth === 0) {
    const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;
    const imports: Array<{ whole: string; ref: string }> = [];
    for (const m of out.matchAll(importRe)) {
      const ref = m[2] ?? m[4] ?? "";
      if (ref) imports.push({ whole: m[0], ref });
    }
    await pooled(imports, CONCURRENCY, async ({ whole, ref }) => {
      const abs = resolveUrl(ref, cssUrl);
      if (!abs) return;
      try {
        const text = await fetchText(ctx, abs, "@import 的样式表");
        const inner = await inlineCssUrls(ctx, text, abs, depth + 1);
        out = out.replace(whole, escapeStyle(inner));
        ctx.inlined.push({ kind: "style", url: abs });
      } catch {
        // 失败保持原样，fetchResource 已记进 failed
      }
    });
  }

  // url(...)：图片和字体都走 data: URI
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const refs: Array<{ whole: string; ref: string }> = [];
  for (const m of out.matchAll(urlRe)) {
    const ref = m[2] ?? "";
    if (!ref || SELF_CONTAINED.test(ref)) continue;
    if (!plausibleRef(ref)) continue; // css/JS 里的模板残留
    refs.push({ whole: m[0], ref });
  }
  await pooled(refs, CONCURRENCY, async ({ whole, ref }) => {
    const abs = resolveUrl(ref, cssUrl);
    if (!abs) return;
    try {
      const { bytes, contentType } = await fetchResource(ctx, abs);
      const uri = toDataUri(bytes, sniffMime(bytes, contentType));
      out = out.split(whole).join(`url("${uri}")`);
      ctx.inlined.push({ kind: "cssAsset", url: abs });
    } catch {
      // 保持原样：离线时这个 url() 加载不到，但样式表其他部分还能用
    }
  });
  return out;
}

/**
 * 主入口：把 html 里的外部资源尽量抓齐、内联掉。
 * `baseUrl` 是页面自己的地址（相对引用与防盗链 Referer 都以它为基准；
 * 从文件导入时传空串 —— 那时只有绝对地址抓得到，相对的进 failed）。
 */
export async function inlineExternalResources(
  html: string,
  baseUrl: string,
  fetchBin: SubResourceFetcher,
  opts?: { maxResourceBytes?: number; onProgress?: (done: number) => void },
): Promise<InlineResult> {
  // 总数没法提前算准：css 里的 url() 是二级发现，抓完才知道还有多少。
  // 所以进度只报"已处理多少个"，别给一个会被冲破的假总数（tool.lu 实测 70/35 就是这么来的）。
  let done = 0;
  const ctx: Ctx = {
    base: baseUrl,
    fetchBin,
    maxBytes: opts?.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES,
    cache: new Map(),
    inlined: [],
    failed: [],
    failuresByUrl: new Map(),
    tick: () => {
      done += 1;
      try {
        opts?.onProgress?.(done);
      } catch {
        // 进度回调不许把打包本身炸了
      }
    },
  };

  /* ---------- 1. <script src> ---------- */
  {
    const re = /<script\b([^>]*)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    const matches: Array<{ whole: string; open: string; ref: string }> = [];
    for (const m of html.matchAll(re)) {
      matches.push({ whole: m[0], open: m[1] + (m[5] ?? ""), ref: m[2] ?? m[3] ?? m[4] ?? "" });
    }
    await pooled(matches, CONCURRENCY, async ({ whole, open, ref }) => {
      try {
        // JS 模板字符串伪装的"标签"：静默跳过，不进 failed（它不是真资源）
        if (ref && !SELF_CONTAINED.test(ref) && !plausibleRef(ref)) return;
        const abs = resolveUrl(ref, baseUrl);
        if (!abs) {
          if (ref && !SELF_CONTAINED.test(ref)) {
            if (!ctx.failuresByUrl.has(ref)) {
              ctx.failed.push({ url: ref, reason: "相对路径，且没有可用的基准地址" });
              ctx.failuresByUrl.set(ref, "相对路径");
            }
          }
          return;
        }
        try {
          const js = await fetchText(ctx, abs, "脚本");
          // 留下 type（module）这类无害属性；src / integrity / crossorigin / defer / async 必须去
          const kept = stripAttrs(open, ["src", "integrity", "crossorigin", "defer", "async"])
            .replace(/\s+/g, " ")
            .trim();
          html = html.replace(whole, kept ? `<script ${kept}>${escapeScript(js)}</script>` : `<script>${escapeScript(js)}</script>`);
          ctx.inlined.push({ kind: "script", url: abs });
        } catch {
          // 保持原样，failed 里已经记了
        }
      } finally {
        ctx.tick();
      }
    });
  }

  /* ---------- 2. <link rel=stylesheet|preload> ---------- */
  {
    const re = /<link\b[^>]*>/gi;
    const tags = [...html.matchAll(re)].map((m) => m[0]);
    await pooled(tags, CONCURRENCY, async (tag) => {
      try {
        const rel = (tag.match(/\brel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? "").toLowerCase();
        const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const ref = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
        const isStyle = /\bstylesheet\b/.test(rel);
        const isFavicon = /\bicon\b/.test(rel);
        if (!ref) return;
        if (!SELF_CONTAINED.test(ref) && !plausibleRef(ref)) return; // JS 模板残留，静默跳过

        // favicon：抓得到就内联，抓不到就静默删掉 —— 不值得为它亮警告
        if (isFavicon) {
          const abs = resolveUrl(ref, baseUrl);
          if (abs) {
            try {
              const { bytes, contentType } = await fetchResource(ctx, abs);
              const uri = toDataUri(bytes, sniffMime(bytes, contentType));
              html = html.replace(tag, tag.replace(href![0], `href="${uri}"`));
              ctx.inlined.push({ kind: "favicon", url: abs });
            } catch {
              html = html.replace(tag, "");
            }
          } else {
            html = html.replace(tag, "");
          }
          return;
        }
        if (!isStyle) return;

        const abs = resolveUrl(ref, baseUrl);
        if (!abs) {
          if (!ctx.failuresByUrl.has(ref)) {
            ctx.failed.push({ url: ref, reason: "相对路径，且没有可用的基准地址" });
            ctx.failuresByUrl.set(ref, "相对路径");
          }
          return;
        }
        try {
          const css = await fetchText(ctx, abs, "样式表");
          const media = tag.match(/\bmedia\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? "";
          const packed = await inlineCssUrls(ctx, css, abs, 0);
          const mediaAttr = media ? ` media=${media}` : "";
          html = html.replace(tag, `<style${mediaAttr}>${escapeStyle(packed)}</style>`);
          ctx.inlined.push({ kind: "style", url: abs });
        } catch {
          // 保持原样
        }
      } finally {
        ctx.tick();
      }
    });
  }

  /* ---------- 3. <img src> ---------- */
  {
    const re = /<img\b[^>]*>/gi;
    const tags = [...html.matchAll(re)].map((m) => m[0]);
    await pooled(tags, CONCURRENCY, async (tag) => {
      try {
        const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const ref = src ? (src[1] ?? src[2] ?? src[3] ?? "") : "";
        if (!ref || SELF_CONTAINED.test(ref)) return;
        if (!plausibleRef(ref)) return; // JS 模板残留，静默跳过
        const abs = resolveUrl(ref, baseUrl);
        if (!abs) {
          if (!ctx.failuresByUrl.has(ref)) {
            ctx.failed.push({ url: ref, reason: "相对路径，且没有可用的基准地址" });
            ctx.failuresByUrl.set(ref, "相对路径");
          }
          return;
        }
        try {
          const { bytes, contentType } = await fetchResource(ctx, abs);
          const uri = toDataUri(bytes, sniffMime(bytes, contentType));
          let patched = tag.replace(src![0], `src="${uri}"`);
          // srcset 里还是外链候选，留着它浏览器就会去抓外面的
          patched = stripAttrs(patched, ["srcset", "sizes"]);
          html = html.replace(tag, patched);
          ctx.inlined.push({ kind: "img", url: abs });
        } catch {
          // 保持原样
        }
      } finally {
        ctx.tick();
      }
    });
  }

  /* ---------- 4. 页面自带的 <style> 与 style="…url(…)…" ---------- */
  {
    // 扫描源要先剥掉 <script>：JS 字符串里常有 style="url('+x+')" 这种模板，
    // 拿去当真地址抓只会得到一堆 404 假警报（tool.lu 实测 5 条全是这么来的）
    const scanSource = html.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
    const styleBlocks = [...scanSource.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[0]);
    await pooled(styleBlocks, CONCURRENCY, async (tag) => {
      const inner = tag.replace(/^<style\b[^>]*>/i, "").replace(/<\/style\s*>$/i, "");
      const packed = await inlineCssUrls(ctx, inner, baseUrl, 1);
      if (packed !== inner) html = html.replace(tag, tag.replace(inner, packed));
    });

    const styleAttrs = [...scanSource.matchAll(/style\s*=\s*"([^"]*url\([^"]*)"/gi)].map((m) => m[1]);
    await pooled(styleAttrs, CONCURRENCY, async (css) => {
      const packed = await inlineCssUrls(ctx, css, baseUrl, 1);
      if (packed !== css) html = html.replace(css, packed);
    });
  }

  return { html, inlined: ctx.inlined, failed: ctx.failed };
}
