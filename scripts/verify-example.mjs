/**
 * 验 examples/ 下的样本工具：**用宿主的真代码**把它装一遍、建表，
 * 再用真的 toolBridge 把它的每个 op 跑一遍。
 *
 *   node scripts/verify-example.mjs                       # 默认验 kitchen-sink
 *   node scripts/verify-example.mjs --dir examples/xxx    # 验别的样本
 *
 * 它和 agent-author.mjs 走同一套路子：把 `@tauri-apps/*` 别名成 Node 替身
 * （scripts/lib/tauri-node/），于是 toolStore.installFromHtml 原样执行、
 * 工具真的落盘、表真的建出来。改了 samples 或改了契约之后跑一次，
 * 就知道"文档里写的"和"代码认的"还是不是一回事。
 *
 * 退出码：0 = 全部通过；1 = 有断言没过。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ESBUILD = path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild");
const ENTRY = path.join(ROOT, "scripts", "verify-example.core.mjs");
const OUT_DIR = path.join(ROOT, ".setup-tmp");
const OUT = path.join(OUT_DIR, "verify-example.bundle.mjs");

fs.mkdirSync(OUT_DIR, { recursive: true });

if (!fs.existsSync(ESBUILD)) {
  console.error("[verify-example] 找不到 esbuild，先 npm install");
  process.exit(1);
}

/** Tauri 模块 → Node 替身（相对路径必须带 ./） */
const ALIASES = {
  "@tauri-apps/api/path": "./scripts/lib/tauri-node/path.mjs",
  "@tauri-apps/plugin-fs": "./scripts/lib/tauri-node/fs.mjs",
  "@tauri-apps/api/core": "./scripts/lib/tauri-node/core.mjs",
};

/* spawnSync 在这个环境里会 EBUSY（PITFALLS 七十五），所以这里用异步 spawn */
function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit", windowsHide: true });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

const status = await run([
  ESBUILD,
  ENTRY,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  `--outfile=${OUT}`,
  "--external:jsdom",
  "--log-level=warning",
  ...Object.entries(ALIASES).map(([k, v]) => `--alias:${k}=${v}`),
]);
if (status !== 0) process.exit(status);

// ⚠️ 工具落点**必须**是临时目录：指向真实 appDataDir 会把样本装进用户的工具区
const tmpRoot = path.join(ROOT, ".setup-tmp", "verify-tools");
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(await run([OUT, ...process.argv.slice(2), "--tools-root", tmpRoot]));
