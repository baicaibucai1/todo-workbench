#!/usr/bin/env node
/**
 * agent-author 启动器。
 *
 * 只做一件事：把 scripts/agent-author.core.mjs 连同 src 里的真代码打成一个包，
 * 并在打包时把两个 Tauri 模块**换成 Node 替身**（见 scripts/lib/tauri-node/）。
 * 这样 src 一行都不用改，installFromHtml 原样执行、真的写磁盘。
 *
 * 为什么要先打包再跑：src 是 TypeScript + 动态 import，直接 node 跑不了；
 * 项目里 smoke / sync / agent-unit 三套测试都是这个套路（esbuild 打到 .mjs 再 node）。
 *
 * 用法（参数原样透传给 core，见 core 头部注释）：
 *   node scripts/agent-author.mjs --selftest
 *   node scripts/agent-author.mjs --provider deepseek --api-key sk-xxx
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ESBUILD = path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild");
const ENTRY = path.join(ROOT, "scripts", "agent-author.core.mjs");
const OUT_DIR = path.join(ROOT, ".setup-tmp");
const OUT = path.join(OUT_DIR, "agent-author.bundle.mjs");

fs.mkdirSync(OUT_DIR, { recursive: true });

if (!fs.existsSync(ESBUILD)) {
  console.error("[agent-author] 找不到 esbuild，先 npm install");
  process.exit(1);
}

/** Tauri 模块 → Node 替身（相对路径必须带 ./） */
const ALIASES = {
  "@tauri-apps/api/path": "./scripts/lib/tauri-node/path.mjs",
  "@tauri-apps/plugin-fs": "./scripts/lib/tauri-node/fs.mjs",
  "@tauri-apps/api/core": "./scripts/lib/tauri-node/core.mjs",
};

const args = [
  ENTRY,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  `--outfile=${OUT}`,
  "--external:jsdom",
  "--log-level=warning",
  ...Object.entries(ALIASES).map(([k, v]) => `--alias:${k}=${v}`),
];

const built = spawnSync(process.execPath, [ESBUILD, ...args], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
});
if (built.status !== 0) process.exit(built.status ?? 1);

const ran = spawnSync(process.execPath, [OUT, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
});
process.exit(ran.status ?? 1);
