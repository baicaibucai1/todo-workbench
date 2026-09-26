/**
 * 清理生成物与调试残留 —— 把工作区收回"只有源码"的样子。
 *
 *   node scripts/clean.mjs              # 只报告，不动手（默认）
 *   node scripts/clean.mjs --yes        # 真的删
 *   node scripts/clean.mjs --deep       # 连 src-tauri/target 一起删
 *   node scripts/clean.mjs --old        # 顺带删掉 release-assets 里的旧版本包
 *
 * ------------------------------------------------------------------
 * 为什么默认不删
 * ------------------------------------------------------------------
 * 这个仓库里"没进版本控制的东西"分成两类，混在一起最危险：
 *
 *   一类是**随时能重建的生成物**：dist/、target/、各种 .log、.setup-tmp/ 里
 *     那些一次性调试脚本与日志。删了顶多花几分钟重编。
 *   一类是**丢了就真没了**的：`.tauri-key`（更新签名私钥，丢了以后发版
 *     签名对不上，老用户更新会失败）、`tools/*\/ai/`（50 MB 的本地模型副本，
 *     要跑 sync-tools 才搬得回来）、`release-assets/`（已发布的产物）。
 *
 * 所以脚本默认**只报告**，而且要显式 `--yes` 才动手；后一类一律不碰。
 *
 * ------------------------------------------------------------------
 * 为什么单独留 --deep
 * ------------------------------------------------------------------
 * `src-tauri/target/` 是这个仓库里最大的一块（实测 12 GB 量级），
 * 删掉之后下次打包要完整重编 3–5 分钟。它不是"随手可清"的东西，
 * 所以不给它混进默认档：空间紧的时候再 `--deep`。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YES = process.argv.includes("--yes");
const DEEP = process.argv.includes("--deep");
const OLD = process.argv.includes("--old");

/* ------------------------------------------------------------------ */
/* 体积                                                                */
/* ------------------------------------------------------------------ */

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let t = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      try {
        t += sizeOf(path.join(p, e.name));
      } catch {
        /* 读不了的跳过，不让它拖垮整个统计 */
      }
    }
    return t;
  } catch {
    return 0;
  }
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2);
const human = (n) => (n >= 1024 * 1024 * 1024 ? gb(n) + " GB" : mb(n) + " MB");

/* ------------------------------------------------------------------ */
/* 清单                                                                */
/* ------------------------------------------------------------------ */

/** 目录 / 具体文件 */
const items = [];

function addFile(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  items.push({ rel, abs: p, kind: "file", size: sizeOf(p) });
}

function addDir(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  items.push({ rel, abs: p, kind: "dir", size: sizeOf(p) });
}

/* 前端构建产物 */
addDir("dist");

/* 一次性调试脚本与日志（200+ 个 .txt/.log/.mjs，全是当时排查用的一次性产物） */
addDir(".setup-tmp");

/* e2e 截图：里面有真实待办与流程任务数据，本就不该留在本机 */
addDir("shots");

/* 散在根目录与各处的调试残留 */
for (const f of ["probe-result.txt", "环境自检报告.txt"]) addFile(f);
try {
  for (const f of fs.readdirSync(ROOT)) {
    if (f.startsWith(".") && f.endsWith(".log")) addFile(f);
  }
} catch {
  /* 根目录读不了就算了 */
}

/* 测试跑出来的日志与 esbuild 打包产物（.gitignore 里已一条条列着） */
try {
  for (const f of fs.readdirSync(path.join(ROOT, "tests"))) {
    if (f.startsWith(".") && (f.endsWith(".log") || f.endsWith(".bundle.mjs"))) {
      addFile(path.join("tests", f));
    }
  }
} catch {
  /* 同上 */
}

/* 大块头，需要 --deep */
if (DEEP) addDir(path.join("src-tauri", "target"));

/* 旧版本发布包：GitHub Release 上都还在，本地没必要留一堆 */
if (OLD) {
  const dir = path.join(ROOT, "release-assets");
  try {
    const files = fs.readdirSync(dir);
    // 当前版本从 package.json 读，不在版本库里写死
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const f of files) {
      if (!/\.(zip|exe|sig)$/i.test(f)) continue;
      if (f.includes(pkg.version)) continue; // 当前版本的留着
      const p = path.join(dir, f);
      items.push({ rel: path.join("release-assets", f), abs: p, kind: "file", size: sizeOf(p) });
    }
  } catch {
    /* release-assets 不存在就算了 */
  }
}

/* ------------------------------------------------------------------ */
/* 报告 / 执行                                                          */
/* ------------------------------------------------------------------ */

const line = (c = "-") => console.log(c.repeat(66));

line("=");
console.log(`清理清单（${YES ? "执行" : "只报告，加 --yes 才动手"}）`);
line("=");

if (!items.length) {
  console.log("  没有可清理的东西，工作区已经是干净的。");
  process.exit(0);
}

items.sort((a, b) => b.size - a.size);
let total = 0;
for (const it of items) {
  total += it.size;
  console.log(`  ${human(it.size).padStart(11)}  ${it.rel}`);
}
line();
console.log(`  合计 ${human(total)}${DEEP ? "（含 cargo target）" : ""}`);
console.log("");
console.log("  不动的：node_modules/ · .tauri-key（更新签名私钥）· release-assets/ 当前版本");
console.log("          · tools/*/ai/（本地模型副本）· src-tauri/.cargo/ · update.json");
if (!DEEP) console.log("  src-tauri/target 未列入（要连它一起清，加 --deep）");
line();

if (!YES) {
  console.log("  这是预演。确认无误后加 --yes 执行。");
  process.exit(0);
}

let done = 0;
let freed = 0;
for (const it of items) {
  try {
    fs.rmSync(it.abs, { recursive: true, force: true });
    freed += it.size;
    done++;
    console.log(`  已删 ${it.rel}`);
  } catch (e) {
    console.log(`  ⚠️ 没删掉 ${it.rel} —— ${e.message}`);
  }
}
line();
console.log(`删掉 ${done}/${items.length} 项，释放 ${human(freed)}`);
if (DEEP) console.log("提示：target 已清，下次打包会完整重编（3–5 分钟）。");
process.exit(done === items.length ? 0 : 1);
