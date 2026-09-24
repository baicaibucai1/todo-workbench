/**
 * `@tauri-apps/api/core` 的 Node 侧替身（只给 scripts/agent-author.mjs 的打包用）。
 *
 * 真实现里的 convertFileSrc 会去读 window.__TAURI_INTERNALS__ 把本地路径换成
 * asset 协议的 URL；Node 里没有 WebView，也没有那个协议，所以这里返回 file://
 * —— 它只被用来**打印"装完该从哪儿加载"**，不参与任何判断。
 */
import { pathToFileURL } from "node:url";

export function convertFileSrc(filePath) {
  return pathToFileURL(filePath).href;
}

export async function invoke(cmd) {
  throw new Error(`Node 替身没有实现 invoke("${cmd}") —— agent-author 只跑"写工具到磁盘"这条链`);
}
