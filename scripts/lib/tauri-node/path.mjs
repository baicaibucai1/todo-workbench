/**
 * `@tauri-apps/api/path` 的 Node 侧替身（只给 scripts/agent-author.mjs 的打包用）。
 *
 * 为什么需要它：内置助手「真把工具写进磁盘」这条路，应用里靠 Tauri 的路径 API 找
 * `%APPDATA%/<identifier>/tools`，而 Node 里没有 Tauri。把这两个模块换成 Node 实现，
 * **src 里的真实代码一行都不用改**（toolStore.ts 的 installFromHtml 原样跑），
 * 于是「AI 写工具 → 落盘」这条链在命令行就能真跑、真验。
 *
 * 目录从环境变量来，由 scripts/agent-author.mjs 传入：
 *   TW_APPDATA   等价于 appDataDir()   —— 工具装到 <TW_APPDATA>/tools/<id>/
 *   TW_RESOURCE   等价于 resourceDir() —— 安装包资源目录（保持空即可，模拟"没有内置资源"）
 */
import path from "node:path";

const appData = process.env.TW_APPDATA || "";
const resource = process.env.TW_RESOURCE || "";

export async function appDataDir() {
  if (!appData) throw new Error("TW_APPDATA 没设置 —— 这是 agent-author 的 Node 替身，不是真 Tauri");
  return appData;
}

export async function resourceDir() {
  /**
   * ⚠️ **不能返回空串**：调用方会拿它去 join，空串会让路径变成相对的，
   * 于是 fs.exists() 按**当前工作目录**去判断 —— 结果是一个"意外存在"的候选
   * （比如 cwd 正好是仓库根，就命中了仓库里的 tools/<id>/index.html）。
   * 自检时真踩过：加载地址被解析成了仓库里的同名工具。
   *
   * 所以这里给一个**绝对且一定不存在**的兜底目录；`--resource` 指到安装目录时
   * 才是模拟"装好的应用"。两个来源目录的效果都在 tools.ts 的 scanTauriTools 里。
   */
  return resource || path.join(appData, "__no_resource_dir__");
}

/** Tauri 的 join 就是按平台拼路径，语义与 path.join 一致 */
export async function join(...parts) {
  return path.join(...parts);
}

export async function basename(p) {
  return path.basename(p);
}

export async function dirname(p) {
  return path.dirname(p);
}

export async function sep() {
  return path.sep;
}
