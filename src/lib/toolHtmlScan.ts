/**
 * 单文件 HTML 的「自包含」体检。
 *
 * 背景（2026-10-12 的真实现场）：用户把 tool.lu 的页面网址装成工具，
 * 装完一片狼藉 —— 那种整站页面引用了十几个外部脚本/样式/图片，
 * 而工具是在**离线 iframe** 里跑的：
 *   · 别人家的 CDN 有防盗链（tool.lu 实测：`403 X-Error-Info: EmptyReferer`）；
 *   · 跨源无 CORS 响应还有 Chromium 的 ORB 拦一道（`ERR_BLOCKED_BY_ORB`）；
 *   · 就算都放行，页面自带的导航/页脚也把工具区挤成一团。
 * 所以单文件工具必须是自包含的 —— 这不是我们的规矩严，是浏览器安全模型的现实。
 *
 * 这里的职责只有一件事：**在安装之前把真相说出来**。扫描是启发式的
 * （正则，不是完整 HTML 解析），宁可多报不可漏报 —— 报错了用户只是多点一下
 * 「仍要安装」，漏报了用户装进去一个坏工具还以为是我们坏了。
 */

export interface ExternalRefs {
  /** 外部脚本（<script src>） */
  scripts: string[];
  /** 外部样式（<link rel="stylesheet" href>） */
  styles: string[];
  /** 外部图片（<img src>） */
  images: string[];
}

/** 这些开头的引用跟着 HTML 本身走，不算外部 */
const SELF_CONTAINED = /^(data:|blob:|about:|#)/i;

function attrs(tag: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  return out;
}

function isExternal(url: string, relativeIsExternal: boolean): boolean {
  if (!url || SELF_CONTAINED.test(url)) return false;
  if (/^(https?:)?\/\//i.test(url)) return true; // 绝对地址或协议相对（//host/…）
  return relativeIsExternal; // 相对路径：单文件工具没有"同目录"，必然 404
}

/**
 * 扫描一份 HTML 里的外部引用。
 *
 * @param relativeIsExternal 单文件安装传 true（相对路径解析不到任何东西）；
 *   目录工具（zip，文件都跟着走）传 false —— 那时相对引用是合法的，
 *   只有绝对外链才值得警告。
 */
export function scanExternalRefs(html: string, relativeIsExternal: boolean): ExternalRefs {
  const refs: ExternalRefs = { scripts: [], styles: [], images: [] };

  // 去掉注释再扫：注释掉的示例代码不该算数
  const src = html.replace(/<!--[\s\S]*?-->/g, "");

  for (const tag of src.match(/<script\b[^>]*>/gi) ?? []) {
    for (const u of attrs(tag, "src")) {
      if (isExternal(u, relativeIsExternal)) refs.scripts.push(u);
    }
  }
  for (const tag of src.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.test(tag)) continue;
    const rel = (tag.match(/\brel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? "").toLowerCase();
    if (!/\bstylesheet\b|\bpreload\b/.test(rel)) continue;
    for (const u of attrs(tag, "href")) {
      if (isExternal(u, relativeIsExternal)) refs.styles.push(u);
    }
  }
  for (const tag of src.match(/<img\b[^>]*>/gi) ?? []) {
    for (const u of attrs(tag, "src")) {
      if (isExternal(u, relativeIsExternal)) refs.images.push(u);
    }
  }
  return refs;
}

/** 从 URL 取主机名，取不出来就原样返回（协议相对、畸形地址都可能） */
function hostOf(url: string): string {
  try {
    return new URL(url, "http://placeholder.invalid").hostname;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * 把扫描结果整理成给人看的警告行（导入框里逐条显示）。
 * 空数组 = 没问题。
 */
export function describeExternalRefs(refs: ExternalRefs): string[] {
  const lines: string[] = [];
  const total = refs.scripts.length + refs.styles.length + refs.images.length;
  if (total === 0) return lines;

  const hosts = [...new Set([...refs.scripts, ...refs.styles, ...refs.images].map(hostOf))];
  const hostText = hosts.length <= 3 ? hosts.join("、") : `${hosts.slice(0, 3).join("、")} 等 ${hosts.length} 个站点`;
  lines.push(
    `这个页面不是自包含的：引用了 ${total} 个外部资源（脚本 ${refs.scripts.length}、样式 ${refs.styles.length}、图片 ${refs.images.length}，来自 ${hostText}）。`,
  );
  lines.push(
    "工具在离线的 iframe 里运行，这些资源大概率加载不到（防盗链、跨源拦截都可能）—— 装进去界面多半是坏的。",
  );
  lines.push("建议：找真正单文件的工具；或在浏览器里把页面存成「网页，仅 HTML」并确认能离线打开，再拖进来。");
  return lines;
}

/** 从 HTML 里抠 <title>，给「从网址安装」当默认工具名用 */
export function titleFromHtml(html: string): string {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const clean = (t ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  // 「条形码生成器 - 在线工具」→ 取站名之前那段；没有分隔符就整段用
  const head = clean.split(/\s*[|·—\-–]\s*/)[0].trim();
  return (head || clean).slice(0, 30);
}

/**
 * 页面会不会向它自己的服务器发请求（统计 beacon、接口调用、服务端渲染的产物）。
 *
 * 这是**打包也救不了**的那部分：tool.lu 的条码是服务端生成的（点「生成」
 * 实际是拿一张远端图片），离线工具里界面照常、功能必然用不了。
 * 静态扫描只能给个启发式信号 —— 在 JS 里找网络调用的痕迹、
 * 在表单上找指向外部的 action。有就明说，别让人以为"打包 = 完整离线"。
 */
export function detectServerCalls(html: string): boolean {
  // 只看脚本与表单：把 script 内容掏出来（内联后的打包页里所有 JS 都是内联的）
  const js = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => m[1])
    .join("\n");
  if (/\bfetch\s*\(/.test(js)) return true;
  if (/XMLHttpRequest/.test(js)) return true;
  if (/\$\.(ajax|get|post|getJSON|getScript)\s*\(/.test(js)) return true;
  if (/\baxios\b/.test(js)) return true;
  const formAction = [...html.matchAll(/<form\b[^>]*\baction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => m[1]);
  if (formAction.some((a) => /^["']?(https?:)?\/\//i.test(a))) return true;
  return false;
}
