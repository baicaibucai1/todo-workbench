/**
 * 选表窗口的前端这一层 —— 桌面端专用。
 *
 * 它存在的唯一理由：**网页端做不了这件事**。网页端本身是个浏览器页面，
 * 浏览器不允许你去读另一个站点的页面（跨域就是墙），也不允许你往里面注入脚本。
 * 所以「让用户登录、自己挑一张表」这条最省事的路，只有桌面端走得通 ——
 * 这里开的是一个真的窗口（WebView2），用户在里面登录、翻自己的文档，
 * 我们隔着窗口问一句"你现在看的是哪张表"。
 *
 * 三条规矩：
 *  1. **不碰登录态**。不读 Cookie、不读 localStorage —— 登录票多半是 HttpOnly，
 *     读也读不出来，读出来也很快过期。真要取数据时，是让**窗口里的页面自己
 *     发请求**（脚本在页面上下文里 fetch，票由浏览器自动带上），我们只要结果。
 *     这一批还没走到取数据，只做"认出在看哪张表"。
 *  2. **结果走窗口标题递出来**。Tauri v2 的 eval 不返回值（Rust 侧也一样），
 *     所以脚本把结果写进 `document.title`，再由 `kdocs_title` 读回来。
 *     写完立刻把原标题还原 —— 那是文档的标题，用户是要看的。
 *  3. **认出来的东西要给用户看**。金山文档的网址有好几种形态（分享链接里的
 *     `/l/xxx` 是 link_id，不是文档 ID），我们只是**尽量猜**，然后把原始网址
 *     一并摊给他核对 —— 猜错比悄悄用错好一万倍。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";

/** 结果在标题里的标记。加前缀是为了和"文档自己的标题"区分开 */
const MARK = "KDOCS-PROBE|";

export const desktopOnly = () => isTauri();

/** 打开（或复用）选表窗口。url 留空就进金山文档的我的文档 */
export async function openPicker(url = ""): Promise<"created" | "reused"> {
  const how = await invoke<string>("kdocs_open_picker", { url });
  return how === "reused" ? "reused" : "created";
}

export async function closePicker(): Promise<void> {
  await invoke<void>("kdocs_close_picker");
}

export type Probe = {
  /** 窗口里当前的网址 */
  href: string;
  /** 文档的标题（金山文档会把它设成文件名） */
  docTitle: string;
  /** 从网址里猜出来的文档 ID。猜不出来就是空串 */
  guess: string;
};

class PickerClosed extends Error {}

/** 往窗口里跑一段脚本。窗口被用户关掉了会明确抛出 */
async function evalInPicker(script: string): Promise<void> {
  try {
    await invoke<void>("kdocs_eval", { script });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (msg.includes("还没打开")) throw new PickerClosed("选表窗口已经关了");
    throw err;
  }
}

async function readTitle(): Promise<string> {
  try {
    return await invoke<string>("kdocs_title");
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (msg.includes("还没打开")) throw new PickerClosed("选表窗口已经关了");
    throw err;
  }
}

/**
 * 问一句"你现在看的是哪张表"。
 *
 * 先把 `标记 + 网址 + 原标题` 写进标题，读回来，再把标题还原。
 * 中间那 120ms 窗口标题会变成一串怪东西 —— 是刻意的代价，不这么做拿不到结果。
 */
export async function probeOnce(): Promise<Probe> {
  await evalInPicker(
    `window.__kdTitle = window.__kdTitle || document.title;` +
      `document.title = ${JSON.stringify(MARK)} + location.href + '|' + window.__kdTitle;`,
  );
  await new Promise((r) => setTimeout(r, 120));
  const title = await readTitle();
  // 还原标题，别把用户的文档名盖掉
  await evalInPicker(`document.title = window.__kdTitle || document.title;`).catch(() => {});

  if (!title.startsWith(MARK)) {
    throw new Error(`没读到窗口里的网址（标题是「${title}」）—— 页面可能还在加载`);
  }
  const body = title.slice(MARK.length);
  const cut = body.lastIndexOf("|");
  const href = cut > 0 ? body.slice(0, cut) : body;
  const docTitle = cut > 0 ? body.slice(cut + 1) : "";
  return { href, docTitle, guess: guessFileToken(href) };
}

/**
 * 从网址里猜文档 ID。
 *
 * 已知形态（**尚未用真实账号验证过**，所以这里只是尽力而为）：
 *   · `https://www.kdocs.cn/l/xxxxx`      —— 打开/分享用的链接，这一段是 link_id
 *   · `https://www.kdocs.cn/et/xxxxx`     —— 表格的文档地址
 * 取最后一个非空路径段。猜不出来给空串，由界面提示用户手动填。
 */
export function guessFileToken(href: string): string {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("kdocs.cn") && !u.hostname.endsWith("wps.cn")) return "";
    const segs = u.pathname.split("/").filter(Boolean);
    // `/l/xxx` 这种是分享链接，最后一段是 link_id —— 它不是文档 ID，
    // 但先记下来，界面上会说清楚"这是链接 ID，可能不是文档 ID"。
    return segs.length ? segs[segs.length - 1] : "";
  } catch {
    return "";
  }
}

/** 这段网址是不是一张表格（大致判断，别太当真） */
export function looksLikeSheet(href: string): boolean {
  return /\/(et|ksheet|dbt|sheets?)\b|\/l\//i.test(href);
}
