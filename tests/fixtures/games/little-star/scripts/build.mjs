/**
 * Little Star —— 源码拼装器（src/*.js → game.js）+ 区块导航表生成
 * =====================================================================
 * 背景（v0.7.0 拆分）：game.js 逼近 3000 行后拆成 src/ 下 11 个片段。
 * 片段【不是】独立模块 —— 它们全都活在同一个 IIFE 里，靠「按 ORDER 顺序
 * 直接首尾相接」合成 game.js，所以片段之间照旧用裸标识符互相引用：
 * 不需要 import/export、不需要命名空间、不需要改任何一行业务代码。
 *
 * 三条铁律（改本脚本前先读）：
 *   1. ORDER 的顺序 = 代码的执行顺序，**不许重排**。确定性守恒（roll-check
 *      里的 rngDraws=884 / 星系「薄曙」）依赖顶层语句的执行顺序不变。
 *   2. 拼接是纯字符串连接，不做任何转写：输出 = 片段原文首尾相接，
 *      唯一的改动是把生成的导航表注入 @nav 标记区。
 *   3. 片段里不写导航表；导航表是**生成物**，只出现在 game.js 里。
 *
 * 用法：
 *   node scripts/build.mjs           拼装 + 注入导航表 + 写 game.js（默认动作）
 *   node scripts/build.mjs --check   只校验 game.js 与 src/ 是否一致（不同步退出码 1）
 *   node scripts/build.mjs --nav     只打印导航表（预览，不落盘）
 *
 * 何时要跑：改了 src/ 下任何片段之后。忘了也不要紧 —— verify.mjs 的 [0] 节
 *          会拿 --check 的同一套逻辑拦下来（浏览器里看到的一直是 game.js）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SRC_DIR = path.join(ROOT, "src");
const DIST = path.join(ROOT, "game.js");

/* ★ 片段清单 = 唯一事实来源：既定义拼装顺序，也定义 src/ 的完备性检查。
 * 命名规则 NN-名字.js（NN 是两位数序号，便于人眼排序）；加片段请加在语义
 * 位置最靠后的一处，并保持「序号升序 == 依赖顺序」。 */
export const ORDER = [
  "00-prologue.js",     /* 文件头 / 不变量 / IIFE 开 —— 只含注释与序言 */
  "10-core.js",         /* 基础工具：RNG / 绘制随机流 / 数值与 DOM 小工具 */
  "15-registry.js",     /* 对象类型注册表原语（表 = 本项目的骨架） */
  "20-data.js",         /* 静态数据：恒星库 / 行星物理与类型库 / 版本号 */
  "25-fsm.js",          /* 状态机原语 + 四台机器（选择 / 相机 / 覆盖层 / 面板） */
  "27-species.js",      /* 物种库（第一版：人类）+ 摇篮评分（纯函数，不抽随机数） */
  "28-materials.js",    /* 物资账（v0.9）：元素制家底 —— 14 大类 / 蕴藏·可采两本账（零 RNG） */
  "30-system.js",       /* 全局状态 / 星系生成 / three.js 基础三件套 */
  "34-moons.js",        /* 卫星系统（v0.14）：小天体环绕 + 嵌套聚焦的世界坐标口径 */
  "35-civ.js",          /* 文明：发源地选址 + 虚线信标 + 查询（v0.8） */
  "40-textures.js",     /* 程序化贴图（行星以外的贴图 + 全局资源，画布绘制） */
  "42-terrain.js",      /* 地形生成器（v0.11）：高程场 → 地表贴图 / 凹凸图 */
  "44-focus-surface.js",/* 聚焦地表（v0.12）：立方球连续地表 —— 聚焦档的表面表示 */
  "46-settlements.js",  /* 聚落系统（v0.13 · 实验性）：连续场选址 + 点击放置城市 */
  "50-scene.js",        /* 场景组装 + 每帧更新 */
  "60-star-fx.js",      /* 恒星专章：耀斑 / 镜头光斑 */
  "70-camera-input.js", /* 相机聚焦 + 输入（轨道相机 / 拾取） */
  "72-focus.js",        /* 聚焦镜头（v0.10）：贴近档距离 / 操作精度 / 顶部 HUD */
  "80-panel.js",        /* 右侧信息面板（选中天体时展开） */
  "90-guide.js",        /* 恒星指导书（游戏内科普档案，含内联 SVG 插图） */
  "99-boot.js"          /* 主循环 / 启动 / IIFE 收 —— 必须是最后一片 */
];

const BEGIN = "@nav:begin";
const END = "@nav:end";

/* 顶层区块标题：/* ====（≥3）标题 ==== *\/ ，单行收尾 */
const RE_BLOCK = /^\/\* ={3,}\s+(.+?)\s+={3,}\s*\*\/\s*$/;

/* 显示宽度：CJK / 全角按 2 列算，用于对齐表格 */
const RE_WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6B\uFF00-\uFF60\uFFE0-\uFFE6]/g;
const dw = (s) => String(s).replace(RE_WIDE, "xx").length;
const padEnd = (s, n) => s + " ".repeat(Math.max(0, n - dw(s)));
const padStart = (s, n) => " ".repeat(Math.max(0, n - dw(s))) + s;
const newlines = (s) => (s.match(/\n/g) || []).length;

/* ---- 读取片段（并检查 src/ 与 ORDER 严格一致） ---- */
export function readSources() {
  const names = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".js")).sort();
  const missing = ORDER.filter((f) => names.indexOf(f) < 0);
  const extra = names.filter((f) => ORDER.indexOf(f) < 0);
  if (missing.length || extra.length) {
    throw new Error(
      "src/ 与 ORDER 清单不一致（这是防呆，不是报错——请对齐 scripts/build.mjs 的 ORDER）：\n" +
      "  清单里有但磁盘上没有：" + (missing.join(", ") || "无") + "\n" +
      "  磁盘上有但清单里没有：" + (extra.join(", ") || "无")
    );
  }
  return ORDER.map((file) => ({ file, text: fs.readFileSync(path.join(SRC_DIR, file), "utf8") }));
}

/* ---- 每个片段在拼装结果里的起始行（0 号片段已注入导航表，行数会变，用实参） ---- */
function fragStarts(parts, prologueLines) {
  const starts = [];
  let cur = 1;
  for (let i = 0; i < parts.length; i++) {
    starts.push(cur);
    cur += i === 0 ? prologueLines : newlines(parts[i].text);
  }
  return starts;
}

/* ---- 扫描顶层区块（含它落在哪个片段：用起始行反查） ---- */
function collect(src, parts, starts) {
  const lines = src.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RE_BLOCK.exec(lines[i]);
    if (m) hits.push({ line: i + 1, title: m[1] });
  }
  const total = newlines(src);
  return hits.map((b, i) => {
    let k = parts.length - 1;
    while (k > 0 && starts[k] > b.line) k--;
    return {
      line: b.line,
      title: b.title,
      len: (i + 1 < hits.length ? hits[i + 1].line : total + 1) - b.line,
      at: "src/" + parts[k].file + ":" + (b.line - starts[k] + 1)
    };
  });
}

/* ---- 渲染导航表（每行前缀 " * "，直接嵌进 prologue 的块注释） ---- */
function render(blocks, parts, starts, prologueLines) {
  const wName = Math.max(20, ...blocks.map((b) => dw(b.title))) + 2;
  const out = [];
  out.push(" *   起点    区段   区块" + " ".repeat(wName - 4) + "源文件");
  out.push(" *   ─────  ─────  " + "─".repeat(wName) + "  ────────────────────────");
  for (const b of blocks) {
    out.push(" *   " + padStart(String(b.line), 5) + "  " + padStart(String(b.len), 5) + "  " +
      padEnd(b.title, wName) + "  " + b.at);
  }
  /* 总行数 = 已注入的 prologue + 其余片段（prologue 的行数这时已经变了，
   * 不能拿片段原文去加，否则页脚会少算导航表多出来的那几行） */
  const total = prologueLines + parts.slice(1).reduce((a, p) => a + newlines(p.text), 0);
  out.push(" *   共 " + blocks.length + " 个区块 · " + parts.length + " 个源文件 · " + total + " 行");
  return out.join("\n");
}

/* ---- 把导航表注入 prologue 的 @nav 标记区 ---- */
function injectNav(text, nav) {
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END);
  if (i < 0 || j < 0 || j < i) {
    throw new Error("src/00-prologue.js 缺少 " + BEGIN + " / " + END + " 标记区，已中止");
  }
  const head = text.slice(0, i + BEGIN.length);
  const endLineStart = text.lastIndexOf("\n", j) + 1;
  const tail = text.slice(endLineStart);
  return head + (nav ? "\n" + nav : "") + "\n" + tail;
}

/* ---- 拼装 ---- */
function assemble(parts, nav) {
  const texts = parts.map((p, i) => (i === 0 ? injectNav(p.text, nav) : p.text));
  return { text: texts.join(""), prologueLines: newlines(texts[0]) };
}

/* ---- 收敛到不动点 ----
 * 导航表自己占的行数会改变其后所有区块的行号（区块表在文件头），单次渲染
 * 必然差一个偏移量。所以反复「拼装 → 扫描 → 渲染 → 再拼装」，直到导航表
 * 连续两轮一模一样（实测 3 轮）。 */
export function toFixedPoint(parts) {
  let nav = "";
  for (let round = 0; round < 12; round++) {
    const a = assemble(parts, nav);
    const starts = fragStarts(parts, a.prologueLines);
    const next = render(collect(a.text, parts, starts), parts, starts, a.prologueLines);
    if (next === nav) return { text: a.text, nav, rounds: round };
    nav = next;
  }
  throw new Error("导航表未能收敛（12 轮仍未稳定），请检查 @nav 标记是否重复");
}

/* ---- 对外：生成结果 / 校验 ---- */
export function buildText() {
  return toFixedPoint(readSources()).text;
}
export function distText() {
  return fs.existsSync(DIST) ? fs.readFileSync(DIST, "utf8") : null;
}
export function checkSync() {
  const parts = readSources();
  const { text, rounds } = toFixedPoint(parts);
  const cur = distText();
  const ok = cur === text;
  /* 区块计数走 RE_BLOCK（文件头那条无标题的长等号线不算区块） */
  const blockCount = newlines(text) && text.split("\n").filter((l) => RE_BLOCK.test(l)).length;
  return {
    ok, rounds, blocks: blockCount || 0,
    fragments: parts.length,
    lines: newlines(text),
    detail: ok ? "与 src/ 一致" : (cur === null ? "game.js 不存在" : "与 src/ 不一致（跑 node scripts/build.mjs）")
  };
}

/* ---- 主流程（仅在被直接执行时运行，被 import 时保持静默） ---- */
function main() {
  const mode = process.argv[2] || "";
  if (mode === "--nav") {
    const parts = readSources();
    const { nav } = toFixedPoint(parts);
    console.log(nav.replace(/^ \* ?/gm, ""));
    console.log("\n（以上为预览，实际写入 game.js。--check 校验同步。）");
    return;
  }

  const parts = readSources();
  const { text, nav, rounds } = toFixedPoint(parts);
  const cur = distText();

  if (mode === "--check") {
    if (cur === text) {
      console.log("✓ game.js 与 src/ 一致（" + parts.length + " 个片段 · " + newlines(text) + " 行）。");
    } else {
      console.error("✗ game.js 与 src/ 不一致 —— 跑 node scripts/build.mjs 重新拼装。");
      process.exit(1);
    }
    return;
  }

  if (cur === text) {
    console.log("game.js 已是最新（" + parts.length + " 个片段 · " + newlines(text) + " 行），无需改动。");
  } else {
    fs.writeFileSync(DIST, text);
    console.log("已写 game.js：" + parts.length + " 个片段 · " + newlines(text) + " 行" +
      "（导航表收敛 " + rounds + " 轮）。");
    ORDER.forEach((f) => {
      const p = parts.find((x) => x.file === f);
      console.log("  + " + f.padEnd(22) + String(newlines(p.text)).padStart(5) + " 行");
    });
  }
}

if (path.basename(process.argv[1] || "") === "build.mjs") main();
