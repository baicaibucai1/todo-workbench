#!/usr/bin/env node
/**
 * 内置工具登记点一致性审计：`npm run tool:audit`
 *
 * ============================ 它守的是什么 ============================
 *
 * 一个内置工具的**真源**只有一份：tools/<id>/manifest.json。
 * 但同一件事还被抄在另外六处，抄的时候没人检查：
 *
 *   src/lib/tools.ts            BUILTIN_TOOLS（浏览器 demo 用的静态清单）
 *   tests/tool-registry.mjs     ALL / ENABLED / THEME 三份清单
 *   README.md                   工具表 + 那句「表里的 N 个」
 *   scripts/sync-tools.mjs      镜像工具的外部源文件（不在 git 里）
 *
 * 漏改任何一处都不报错，只是「界面上有一半不对」：demo 里的版本跟桌面端
 * 不一样、某个工具的深浅色没人测、README 少一行 —— 都属于查起来最贵的那类。
 *
 * 所以这一条命令把七处对一遍，**不一致就退出码 1**。它不修任何东西：
 * 修是 `npm run tool:new` 的事（它会一并改掉），这里只负责说"哪儿不对"。
 *
 * 用法：
 *   node scripts/audit-tools.mjs          人读的报表
 *   node scripts/audit-tools.mjs --quiet  只在有问题时输出（接 CI 用这个）
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOOLS = path.join(ROOT, "tools");
const QUIET = process.argv.includes("--quiet");

/** 与 src/lib/tools.ts、src/lib/toolStore.ts 保持一致 */
const TOOL_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

const errors = [];
const warns = [];
const oks = [];

function ok(msg) {
  oks.push(msg);
  if (!QUIET) console.log(`  [ok] ${msg}`);
}
function bad(msg, detail = "") {
  errors.push(detail ? `${msg} —— ${detail}` : msg);
  console.log(`  [✗] ${msg}${detail ? `\n       ${detail}` : ""}`);
}
function warn(msg, detail = "") {
  warns.push(msg);
  console.log(`  [!] ${msg}${detail ? ` —— ${detail}` : ""}`);
}

function section(title) {
  if (!QUIET) console.log(`\n=== ${title} ===`);
}

const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);

/** README 里写的是「表里的六个」这种中文数字 */
const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function cnToNum(s) {
  if (s === "十") return 10;
  return CN.indexOf(s);
}

/* ------------------------------------------------------------------ */
/* 0. 收集真源                                                          */
/* ------------------------------------------------------------------ */

section("1. 工具目录与 manifest");

if (!exists(TOOLS)) {
  bad("找不到 tools/ 目录");
  finish();
}

/** id → manifest 对象（真源） */
const real = new Map();
for (const e of fs.readdirSync(TOOLS, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!e.isDirectory()) continue;
  const mf = path.join(TOOLS, e.name, "manifest.json");
  if (!exists(mf)) {
    // 没有 manifest 的目录不算工具：可能是附属资源（image-crop/ai）
    if (exists(path.join(TOOLS, e.name, "index.html"))) {
      bad(`tools/${e.name}/ 有 index.html 却没有 manifest.json`);
    }
    continue;
  }
  let m;
  try {
    m = JSON.parse(read(mf));
  } catch (err) {
    bad(`tools/${e.name}/manifest.json 不是合法 JSON`, err.message);
    continue;
  }
  real.set(e.name, m);
}

if (real.size === 0) {
  bad("tools/ 下没有任何带 manifest.json 的工具目录");
  finish();
}
ok(`扫到 ${real.size} 个工具：${[...real.keys()].join(" / ")}`);

/* ------------------------------------------------------------------ */
/* 1. manifest 自身                                                     */
/* ------------------------------------------------------------------ */

const ICONS = readIconWhitelist();
const TAGS = readTagWhitelist();

for (const [id, m] of real) {
  const where = `tools/${id}/manifest.json`;
  if (m.id !== id) bad(`${where} 的 id 是「${m.id}」，跟目录名不一致`);
  if (!TOOL_ID_RE.test(String(m.id ?? ""))) bad(`${where} 的 id 不合法`, String(m.id));
  if (!m.name || !String(m.name).trim()) bad(`${where} 缺 name`);
  if (!SEMVER.test(String(m.version ?? ""))) bad(`${where} 的 version 不是 x.y.z`, String(m.version));
  if (m.icon && !ICONS.includes(m.icon)) {
    bad(`${where} 的 icon「${m.icon}」不在白名单`, `可选：${ICONS.join(" / ")}`);
  }
  if (m.tags) {
    for (const t of m.tags) {
      if (!TAGS.includes(t)) bad(`${where} 的 tag「${t}」不在白名单`, `可选：${TAGS.join(" / ")}`);
    }
  }
  const entry = m.entry || "index.html";
  if (!exists(path.join(TOOLS, id, entry))) {
    bad(`${where} 的 entry 指向 ${entry}，但文件不存在`);
  }
  if (!Number.isInteger(m.dbVersion) || m.dbVersion < 1) {
    bad(`${where} 的 dbVersion 必须是 ≥1 的整数`, String(m.dbVersion));
  }
  if (!m.schema && m.dbVersion !== 1) {
    warn(`${where} 没有 schema 却把 dbVersion 写成了 ${m.dbVersion}`, "没表的工具恒为 1");
  }
}
if (!errors.length) ok(`${real.size} 份 manifest 字段自检通过`);

/* ------------------------------------------------------------------ */
/* 2. BUILTIN_TOOLS（src/lib/tools.ts）                                 */
/* ------------------------------------------------------------------ */

section("2. src/lib/tools.ts 的 BUILTIN_TOOLS");

const builtin = parseBuiltinTools();
if (!builtin) {
  bad("解析不出 src/lib/tools.ts 里的 BUILTIN_TOOLS");
} else {
  const bIds = new Set(builtin.map((t) => t.id));
  const rIds = new Set(real.keys());

  for (const id of rIds) if (!bIds.has(id)) bad(`tools/${id}/ 存在，但 BUILTIN_TOOLS 里没登记`);
  for (const id of bIds) if (!rIds.has(id)) bad(`BUILTIN_TOOLS 里有「${id}」，但 tools/ 下没这个目录`);

  // 逐字段对账 —— 这一段是重点：整份 manifest 是手抄的，
  // 抄漏一个版本号，浏览器 demo 和桌面端就跑着两份不同的工具
  const byId = new Map(builtin.map((t) => [t.id, t]));
  for (const [id, m] of real) {
    const b = byId.get(id);
    if (!b) continue;
    for (const key of ["name", "version", "icon", "entry", "author", "dbVersion"]) {
      const a = m[key];
      const c = b[key];
      if (JSON.stringify(a ?? null) !== JSON.stringify(c ?? null)) {
        bad(
          `${id} 的 ${key} 两边不一致`,
          `manifest=${JSON.stringify(a ?? null)} / BUILTIN_TOOLS=${JSON.stringify(c ?? null)}`,
        );
      }
    }
    const sa = JSON.stringify(m.schema ?? null);
    const sb = JSON.stringify(b.schema ?? null);
    if (sa !== sb) bad(`${id} 的 schema 两边不一致`, `manifest=${sa}\n       BUILTIN=${sb}`);
    const ta = JSON.stringify(m.tags ?? null);
    const tb = JSON.stringify(b.tags ?? null);
    if (ta !== tb) bad(`${id} 的 tags 两边不一致`, `${ta} / ${tb}`);
  }
  if (!errors.length) ok(`BUILTIN_TOOLS 与 ${real.size} 份 manifest 逐字段一致`);
}

/* ------------------------------------------------------------------ */
/* 3. tests/tool-registry.mjs                                           */
/* ------------------------------------------------------------------ */

section("3. tests/tool-registry.mjs（三份写死清单）");

const regPath = path.join(ROOT, "tests/tool-registry.mjs");
if (!exists(regPath)) {
  bad("缺 tests/tool-registry.mjs");
} else {
  // Windows 下绝对路径不能直接 import，得转成 file:// URL
  const reg = await import(pathToFileURL(regPath).href);
  const rIds = [...real.keys()].sort();

  const diff = (a, b) => [
    a.filter((x) => !b.includes(x)).map((x) => `多出 ${x}`),
    b.filter((x) => !a.includes(x)).map((x) => `少了 ${x}`),
  ].flat();

  const dAll = diff([...reg.ALL_TOOL_IDS].sort(), rIds);
  if (dAll.length) bad("ALL_TOOL_IDS 与 tools/ 对不上", dAll.join("；"));
  else ok(`ALL_TOOL_IDS ${reg.ALL_TOOL_IDS.length} 个，与目录一致`);

  // 默认启用的 = 全部 减去 settings.ts 里默认停用的
  const disabledByDefault = readDefaultDisabled().filter((x) => rIds.includes(x));
  const expectEnabled = rIds.filter((x) => !disabledByDefault.includes(x));
  const dEn = diff([...reg.ENABLED_TOOL_IDS].sort(), expectEnabled);
  if (dEn.length) {
    bad(
      "ENABLED_TOOL_IDS 与「全部 − 默认停用」对不上",
      `${dEn.join("；")}；settings.ts 默认停用=[${disabledByDefault.join(",")}]`,
    );
  } else ok(`ENABLED_TOOL_IDS ${reg.ENABLED_TOOL_IDS.length} 个（默认停用：${disabledByDefault.join(",") || "无"}）`);

  const themeIds = reg.THEME_TOOLS.map((x) => x[0]).sort();
  const dTh = diff(themeIds, rIds);
  if (dTh.length) bad("THEME_TOOLS 与 tools/ 对不上（漏一个 = 那个工具的深浅色没人测）", dTh.join("；"));
  else ok(`THEME_TOOLS ${reg.THEME_TOOLS.length} 个，覆盖全部工具`);
}

/* ------------------------------------------------------------------ */
/* 4. README                                                            */
/* ------------------------------------------------------------------ */

section("4. README.md 工具表");

const readme = read(path.join(ROOT, "README.md"));
{
  const before = errors.length; // 只按这一节新出的错判断，别被前面的连坐
  const head = "| 工具 | 版本 | 做什么 |";
  const at = readme.indexOf(head);
  if (at < 0) {
    bad("README 里找不到工具表（表头应为" + head + "）");
  } else {
    const lines = readme.slice(at).split("\n");
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].startsWith("|")) break;
      const cells = lines[i].replace(/\r$/, "").split("|").slice(1, -1).map((s) => s.trim());
      if (cells[0] && !/^-+$/.test(cells[0])) rows.push(cells);
    }
    // 表里的第一列是**工具名**，而 manifest 的 name 才是真源
    const byName = new Map([...real.values()].map((m) => [m.name, m]));
    const seen = new Set();
    for (const r of rows) {
      const m = byName.get(r[0]);
      if (!m) {
        bad(`README 工具表里有一行「${r[0]}」，tools/ 下没有这个工具`);
        continue;
      }
      seen.add(m.id);
      if (r[1] !== m.version) {
        bad(`README 里「${r[0]}」的版本是 ${r[1]}，manifest 里是 ${m.version}`);
      }
    }
    for (const id of real.keys()) if (!seen.has(id)) bad(`README 工具表里少了「${real.get(id).name}」`);
    if (errors.length === before) ok(`README 工具表 ${rows.length} 行，名称与版本都对得上`);

    // 那句「表里的 N 个」
    const m = /表里的([一二三四五六七八九十]+)个/.exec(readme.slice(Math.max(0, at - 400), at));
    if (m) {
      const n = cnToNum(m[1]);
      if (n !== real.size) {
        bad(`README 写着「表里的${m[1]}个」，实际有 ${real.size} 个`);
      } else ok(`「表里的${m[1]}个」与实际一致`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. 镜像工具（外部源文件不在 git 里）                                   */
/* ------------------------------------------------------------------ */

section("5. 镜像工具的外部源文件");

const sources = parseSyncSources();
if (Object.keys(sources).length === 0) {
  if (!QUIET) ok("没有登记镜像工具（没有外部源文件要守）");
} else {
  for (const [id, rel] of Object.entries(sources)) {
    const src = path.resolve(ROOT, rel);
    const dst = path.join(TOOLS, id, "index.html");
    if (!exists(src)) {
      // 与 sync-tools.mjs 一致：缺源文件只是警告（打包只需要工具目录里那份）
      warn(`镜像源缺失：${rel}`, "不影响出包，但改完工具目录要记得回灌");
      continue;
    }
    if (!exists(dst)) {
      bad(`登记了镜像源，但 tools/${id}/index.html 不存在`);
      continue;
    }
    const a = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex");
    const b = crypto.createHash("sha256").update(fs.readFileSync(dst)).digest("hex");
    if (a !== b) {
      bad(
        `tools/${id}/index.html 与源 ${rel} 不一致`,
        "tools:sync 的方向是 源 → 工具，现在跑会把改动冲掉；改完请先回灌源文件",
      );
    } else ok(`${id} 与源文件逐字节一致`);
  }
}

/* ------------------------------------------------------------------ */
/* 6. 自包含与独立运行的几条硬要求                                        */
/* ------------------------------------------------------------------ */

section("6. 工具 HTML 的硬要求");

for (const [id, m] of real) {
  const html = read(path.join(TOOLS, id, m.entry || "index.html"));
  const miss = [];
  if (!/bindState/.test(html)) miss.push("宿主状态机（body.dataset.bindState）");
  if (!/<link rel="icon"/.test(html)) miss.push("内联 favicon（否则控制台留一条 404）");
  if (!/color-scheme/.test(html)) miss.push("color-scheme（深色下原生控件会是浅色一坨）");
  if (/data-host-only/.test(html) && !/\[data-host-only\][^{]*\{[^}]*display:\s*none/.test(html)) {
    miss.push("[data-host-only] 的 display:none 规则（只标属性会被作者样式盖掉）");
  }
  if (miss.length) warn(`tools/${id}/index.html 缺：${miss.join("；")}`, "独立运行那一档会出问题");
}
if (!warns.length && !QUIET) ok(`${real.size} 份 HTML 都满足自包含与独立运行的硬要求`);

finish();

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function finish() {
  console.log("");
  if (errors.length === 0) {
    console.log(`  ✓ 工具登记点全部对齐（${oks.length} 项通过${warns.length ? `，${warns.length} 条提醒` : ""}）\n`);
    process.exit(0);
  }
  console.log(`  ✗ ${errors.length} 处不一致${warns.length ? `，另有 ${warns.length} 条提醒` : ""}：`);
  for (const e of errors) console.log(`     · ${e}`);
  console.log("\n  修法：能改的交给 `npm run tool:new`；已经存在的工具改了 manifest，");
  console.log("        就把 tools.ts / tool-registry.mjs / README 里对应那几处手动补齐。\n");
  process.exit(1);
}

/** 从 src/lib/icons.ts 抠出图标名白名单 */
function readIconWhitelist() {
  const src = read(path.join(ROOT, "src/lib/icons.ts"));
  const m = /export const ICONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/^\s{2}"?([a-z0-9-]+)"?\s*:/gm)].map((x) => x[1]);
}

/** 从 src/lib/tools.ts 抠出 TOOL_TAG_NAMES */
function readTagWhitelist() {
  const src = read(path.join(ROOT, "src/lib/tools.ts"));
  const m = /export const TOOL_TAG_NAMES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * 把 src/lib/tools.ts 里那段数组字面量抠出来求值。
 *
 * 不 import 那个文件是因为它连带 import 了 db / tauri 那一串，
 * 在 Node 里跑不起来；而这段字面量本身就是合法 JS（类型注解在它外面）。
 */
function parseBuiltinTools() {
  const src = read(path.join(ROOT, "src/lib/tools.ts"));
  const open = "const BUILTIN_TOOLS: ToolManifest[] = [";
  const at = src.indexOf(open);
  if (at < 0) return null;
  const close = src.indexOf("\n];", at);
  if (close < 0) return null;
  const body = src.slice(at + open.length, close);
  try {
    // ★ body 末尾必须补一个换行：数组最后一个元素后面常跟着解释性注释（比如
    //   「这里没有五子棋」那块），截取到 close 时 body 以 `// 注释` 结尾 ——
    //   直接拼 `[${body}]` 的话收尾的 `]` 会被行注释吞掉，报"Unexpected end of
    //   input"。文件是 CRLF 时行尾的 \r 恰好替我们终止了注释，所以这个坑
    //   平时看不出来 —— 直到某次编辑把文件变成 LF（比如 sed -i）。别赌行尾。
    // eslint-disable-next-line no-eval
    const arr = eval(`[${body}\n]`);
    return Array.isArray(arr) ? arr : null;
  } catch (err) {
    bad("BUILTIN_TOOLS 那段字面量求值失败", err.message);
    return null;
  }
}

/** settings.ts 里 DEFAULT_SETTINGS[tools.disabled] 的初始值 */
function readDefaultDisabled() {
  const src = read(path.join(ROOT, "src/lib/settings.ts"));
  const m = /\[SETTINGS\.toolsDisabled\]:\s*"([^"]*)"/.exec(src);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

/** sync-tools.mjs 里 SOURCES 的登记 */
function parseSyncSources() {
  const p = path.join(ROOT, "scripts/sync-tools.mjs");
  if (!exists(p)) return {};
  const src = read(p);
  const m = /const SOURCES\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!m) return {};
  const out = {};
  for (const x of m[1].matchAll(/"([a-z0-9-]+)"\s*:\s*"([^"]+)"/g)) out[x[1]] = x[2];
  return out;
}

