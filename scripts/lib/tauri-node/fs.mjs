/**
 * `@tauri-apps/plugin-fs` 的 Node 侧替身（只给 scripts/agent-author.mjs 的打包用）。
 *
 * 覆盖 toolStore.ts / tools.ts 实际用到的全部方法：
 *   mkdir / readDir / copyFile / exists / writeTextFile / readTextFile / remove
 *
 * 语义按 Tauri 插件对齐，几处要紧的差别写在各函数注释里。
 * 它只是"把 fs 换成 Node 的 fs"，**不掺任何业务逻辑** —— 装出来的东西必须与
 * 桌面版装的完全一样，否则这个替身就没有验证价值了。
 */
import fs from "node:fs";
import path from "node:path";

export async function mkdir(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: !!opts.recursive });
}

export async function exists(p) {
  return fs.existsSync(p);
}

/** Tauri 的 readDir 返回 DirEntry[]（name + isDirectory/isFile/isSymlink） */
export async function readDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    isFile: e.isFile(),
    isSymlink: e.isSymbolicLink(),
  }));
}

export async function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

export async function writeTextFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, "utf8");
}

export async function readTextFile(file) {
  return fs.readFileSync(file, "utf8");
}

export async function readFile(file) {
  return new Uint8Array(fs.readFileSync(file));
}

export async function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data));
}

/** 卸载路径用得到；recursive 与否按调用方给的来（Tauri 的 remove 同参） */
export async function remove(target, opts = {}) {
  fs.rmSync(target, { recursive: !!opts.recursive, force: true });
}

export async function rmdir(target, opts = {}) {
  fs.rmSync(target, { recursive: !!opts.recursive, force: true });
}
