/**
 * 五子棋工具的 Node 侧验证（不需要浏览器，不需要 dev server）。
 *
 * ------------------------------------------------------------------
 * 这个套件验的是什么
 * ------------------------------------------------------------------
 * 分两类，各占一半：
 *
 *   A. **把 tool-authoring 那份契约变成可执行断言**（第 1、2 段）。
 *      技能包里的「单 HTML 工具编写标准」是给模型看的文档，文档会漂 ——
 *      今天加一条规则，半年后没人知道某个工具还算不算合规。这里把其中最
 *      硬的几条（自包含 / 无外部引用 / data-* 齐备 / 响应宿主主题 /
 *      破坏性操作二次确认）钉在 gomoku 这份样本上。以后写新工具，
 *      把路径换掉就能直接复用这一段。
 *
 *   B. **工具逻辑本身**（第 3~8 段）。用 jsdom 把 index.html 跑起来，
 *      再手写一个"只说 toolBridge 那套 op"的迷你宿主，于是能真的：
 *      切模式、落子、看 AI 应手、连成五子、把战绩写进一张内存表、再清空。
 *      这比浏览器 e2e 快得多，也能方便地测边界（比如"落库失败时界面要说
 *      人话"这条，浏览器里很难造）。
 *
 * ------------------------------------------------------------------
 * 这个套件**验不到**什么
 * ------------------------------------------------------------------
 * 验不到它在**真的工作台**里被 iframe 装载、宿主真的为它建了
 * tool_gomoku_records 表、主题真的从宿主传下来。那些在 tests/gomoku.mjs
 * （浏览器 e2e）里验。两边一起才算完整。
 *
 * 用法：node tests/gomoku-unit.mjs
 */

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("C:/AI_Production/Tools/main/");
const { JSDOM } = require("jsdom");

const HTML_FILE = "tools/gomoku/index.html";
const MANIFEST_FILE = "tools/gomoku/manifest.json";
const SKILL_FILE = "src/lib/agent/skills.ts";
const REGISTRY_FILE = "src/lib/tools.ts";

const html = fs.readFileSync(HTML_FILE, "utf8");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
const extractScript = (t) =>
  [...t.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? `（${detail}）` : ""}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== */
section("1. 交付物契约（tool-authoring 的硬规则）");
/* ================================================================== */

const code = extractScript(html);
let syntaxError = null;
try {
  new Function(code);
} catch (e) {
  syntaxError = e.message;
}
check("内联脚本可编译", syntaxError === null, syntaxError ?? "");
check("是 HTML 文档（导入时会校验这条）", /<html[\s>]/i.test(html));
check("体积在 8 MB 上限内", Buffer.byteLength(html) < 8 * 1024 * 1024, `${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);

/* 自包含：一条外部引用都不许有 —— 工作台是离线应用，
   装了就打不开的东西等于坏的（技能里第一条硬规则） */
check("没有 <script src=>", !/<script[^>]+\ssrc=/i.test(html));
check("没有外部样式表 <link rel=stylesheet>", !/<link[^>]+rel=["']?stylesheet/i.test(html));
check("没有任何 http(s) 外链", !/https?:\/\//i.test(html));
check("没有 <img src=> 外链（图标须内联）", !/<img[^>]+src=["']https?:/i.test(html));

/* 自动化靠 data-* 断言（技能第五条界面规范） */
check("交互按钮都带 data-act", /data-act="place"/.test(html) && /data-act="undo"/.test(html));
check("关键状态挂在 body 的 data-* 上",
  /data-state=/.test(html) && /data-turn=/.test(html) && /data-moves=/.test(html) && /data-records=/.test(html));

/* 深浅色：不许写死白底黑字 */
check("有 html[data-theme=dark] 覆盖", /data-theme="dark"/.test(html));
check("处理宿主下发的 tool:context", /"tool:context"/.test(html));
check("收到 context 后落到 <html data-theme>", /documentElement\.dataset\.theme\s*=/.test(html));

/* 破坏性操作要二次确认（清空战绩） */
check("清空战绩是二次确认而不是一键清空", /data-armed/.test(html));

/* 不许有假按钮：每个 data-act 都得真的接上了行为，不能点了没反应。
   两种接法都算：JS 里按 data-act 值查（事件委托），或者该元素自己有 id
   而 JS 里引用了那个 id —— 后者同样是真的接了，别把它判成死按钮。 */
const acts = [...new Set([...html.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]))].sort();
const deadActs = acts.filter((a) => {
  if (code.includes(`"${a}"`) || code.includes(`'${a}'`)) return false;
  const re = new RegExp(`<[^>]*data-act="${a}"[^>]*>`, "g");
  for (const el of html.matchAll(re)) {
    const idm = /id="([a-zA-Z0-9_-]+)"/.exec(el[0]);
    if (idm && code.includes(`"${idm[1]}"`)) return false;
  }
  return true;
});
check("每个 data-act 都有实现（没有假按钮）", deadActs.length === 0,
  deadActs.length ? `没接上的：${deadActs.join("/")}` : `声明了 ${acts.length} 个`);

const ids = Object.keys(manifest).length;
check("manifest 字段齐（id/name/version/entry/dbVersion）",
  ["id", "name", "version", "entry", "dbVersion"].every((k) => manifest[k] !== undefined),
  `${ids} 个字段`);

/* ================================================================== */
section("2. 与宿主侧登记保持同源");
/* ================================================================== */

check("id 合法（小写字母开头、2–32 位）", /^[a-z][a-z0-9-]{1,31}$/.test(manifest.id), manifest.id);
/* icon 必须在技能列出的清单里，写错会退回默认包裹图标 */
const ICONS = ["sun", "star", "calendar", "inbox", "home", "package", "crop", "receipt", "image",
  "calculator", "file", "list", "settings", "boxes", "sparkles", "video", "hash", "notebook-pen", "bot"];
check("icon 在允许清单里", ICONS.includes(manifest.icon), String(manifest.icon));

const tab = manifest.schema.tables[0];
check("声明了一张私有表 records", tab.name === "records");
check("records 有且只有一个主键", tab.columns.filter((c) => c.pk).length === 1);
check("列类型只用 text/integer/real",
  tab.columns.every((c) => ["text", "integer", "real"].includes(c.type)));

const registry = fs.readFileSync(REGISTRY_FILE, "utf8");
check("src/lib/tools.ts 的 BUILTIN_TOOLS 里登记了它",
  new RegExp(`id:\\s*"${manifest.id}"`).test(registry));
check("tools.ts 里的 schema 与 manifest 同源（表名一致）",
  new RegExp(`name:\\s*"${tab.name}"`).test(registry));

const skills = fs.readFileSync(SKILL_FILE, "utf8");
check("技能包里写着这个自包含契约（规则与代码同源）",
  skills.includes("单个自包含 HTML") && skills.includes("data-*"));

/* ================================================================== */
section("3. 在迷你宿主里把它跑起来");
/* ================================================================== */

/**
 * 把 index.html 挂进 jsdom，配一个只说 toolBridge 那套 op 的迷你宿主。
 * @param {{failInsert?: boolean}} opts
 */
async function mount(opts = {}) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  const rows = [];
  const calls = [];

  win.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.source !== "workbench-tool") return;
    calls.push(m.op);
    let data = null, ok = true, error = null;
    if (m.op === "schema.info") {
      data = {
        tables: [{ name: "records", fullName: "tool_gomoku_records", pk: "id", columns: [] }],
      };
    } else if (m.op === "row.insert") {
      if (opts.failInsert) {
        ok = false;
        error = "表里没有这一列「stamp」";
      } else {
        rows.push(m.payload.row);
        data = { ok: true };
      }
    } else if (m.op === "row.select") {
      const rows0 = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      data = { rows: rows0, total: rows0.length, limit: 200, offset: 0 };
    } else if (m.op === "row.delete") {
      const i = rows.findIndex((r) => r.id === m.payload.id);
      if (i >= 0) rows.splice(i, 1);
      data = { ok: true };
    } else {
      ok = false;
      error = `不支持的操作：${m.op}`;
    }
    win.postMessage({ source: "workbench-host", type: "tool:response", id: m.id, ok, data, error }, "*");
  });

  await sleep(60);
  const doc = win.document;
  return {
    win,
    doc,
    rows,
    calls,
    get: () => doc.body.dataset,
    cell: (x, y) => doc.querySelector(`button[data-x="${x}"][data-y="${y}"]`),
    stone: (x, y) => {
      const c = doc.querySelector(`button[data-x="${x}"][data-y="${y}"]`);
      return c ? c.dataset.stone || "" : "?";
    },
    stoned: (color) => [...doc.querySelectorAll(`button[data-stone="${color}"]`)].length,
    tap: async (x, y) => { doc.querySelector(`button[data-x="${x}"][data-y="${y}"]`).click(); await sleep(10); },
    context: (theme) =>
      win.postMessage({
        source: "workbench-host",
        type: "tool:context",
        data: { theme, tablePrefix: "tool_gomoku_", driver: "memory", schemaVersion: 1, runtime: "browser" },
      }, "*"),
  };
}

const app = await mount();
check("棋盘是 15×15 = 225 格", app.doc.querySelectorAll(".cell").length === 225,
  String(app.doc.querySelectorAll(".cell").length));
check("启动状态：轮到你 · 0 手 · 人机模式",
  app.get().state === "playing" && app.get().turn === "human" && app.get().moves === "0" && app.get().mode === "ai",
  JSON.stringify(app.get()));
check("启动就往宿主问了表结构", app.calls.includes("schema.info"), app.calls.join(","));

app.context("dark");
await sleep(30);
check("宿主下发的主题落到了 <html data-theme>", app.doc.documentElement.dataset.theme === "dark");
check("界面上说明了数据落在哪张表（用户能自己核对）",
  app.doc.getElementById("meta").textContent.includes("tool_gomoku_records"),
  app.doc.getElementById("meta").textContent);

/* ================================================================== */
section("4. 两人对战：真的连成五子");
/* ================================================================== */

/* 人机模式下电脑会防守，自动化永远下不出五连 —— 所以「胜负判定 + 赢了要落库」
   这两条核心逻辑只能靠两人模式走完。这也是这个模式存在的理由。 */
app.doc.querySelector('[data-act="mode"][data-mode="duo"]').click();
await sleep(30);
check("切到两人模式后重开一局", app.get().mode === "duo" && app.get().moves === "0" && app.get().state === "playing");
check("模式按钮标出了当前选中", app.doc.querySelector('[data-act="mode"][data-mode="duo"]').dataset.on === "1");

/* 黑连五，白在角上陪着走 —— 黑先手，第 9 手成五 */
const seq = [[7, 7], [0, 0], [8, 7], [1, 0], [9, 7], [2, 0], [10, 7], [3, 0], [11, 7]];
for (const [x, y] of seq) await app.tap(x, y);
await sleep(60);

check("黑方连成五子", app.get().state === "win", app.get().state);
check("黑白交替落子，共 9 手", app.get().moves === "9", app.get().moves);
check("连成的五个子被标出来了", app.doc.querySelectorAll(".cell.win").length === 5,
  String(app.doc.querySelectorAll(".cell.win").length));
check("轮到谁变成 -（结束了）", app.get().turn === "-");
check("状态文案说清了是哪一方赢", app.doc.getElementById("status").textContent.includes("黑胜"),
  app.doc.getElementById("status").textContent);

/* 落库：这是"它说它记了"和"它真记了"的区别 */
check("战绩真的写进了表（1 条）", app.rows.length === 1, `${app.rows.length} 条`);
check("记的是胜负与手数", app.rows[0]?.result === "win" && app.rows[0]?.moves === 9,
  JSON.stringify(app.rows[0] ?? {}));
check("落库成功标记写到了 DOM 上", app.get().saved === "1");
check("战绩面板按胜负数：1 胜 0 负 0 和", app.doc.getElementById("stats").textContent === "1 胜 · 0 负 · 0 和",
  app.doc.getElementById("stats").textContent);
check("列表里显示的是「胜」而不是「和」",
  app.doc.querySelector(".rec .r")?.dataset.r === "win" && app.doc.querySelector(".rec .r").textContent === "胜",
  app.doc.querySelector(".rec")?.textContent ?? "");

/* 结束后不能再落子 */
await app.tap(5, 5);
check("一局结束后再点棋盘无效", app.get().moves === "9" && app.stone(5, 5) === "");

/* ================================================================== */
section("5. 清空战绩要点两次");
/* ================================================================== */

const clearBtn = app.doc.getElementById("clear");
clearBtn.click();
await sleep(20);
check("第一次点只是上膛，不删数据",
  clearBtn.dataset.armed === "1" && app.rows.length === 1 && clearBtn.textContent.includes("再点一次"),
  clearBtn.textContent);
clearBtn.click();
await sleep(60);
check("第二次点才真清空", app.rows.length === 0, `${app.rows.length} 条`);
check("按钮恢复原状（不会卡在确认态）",
  clearBtn.dataset.armed === undefined && clearBtn.textContent === "清空战绩");
check("面板回到空状态", app.get().records === "0" && app.doc.getElementById("stats").textContent === "还没有战绩");

/* ================================================================== */
section("6. 人机对战：电脑会应手，悔棋退两手");
/* ================================================================== */

app.doc.querySelector('[data-act="mode"][data-mode="ai"]').click();
await sleep(30);
check("切回人机模式后重开", app.get().mode === "ai" && app.get().moves === "0");

await app.tap(7, 7);
check("我落子后轮到电脑（data-turn=ai）", app.get().moves === "1" && app.get().turn === "ai");
await sleep(300);
check("电脑真的回落了一手", app.get().moves === "2" && app.get().turn === "human", app.get().moves);
check("盘上是 1 黑 1 白", app.stoned("black") === 1 && app.stoned("white") === 1);
check("电脑落在我这一子的附近（不是乱下）", /^[6-8],[6-8]$/.test(app.get().last) || /^7,[6-8]$/.test(app.get().last),
  app.get().last);

check("电脑那手没用随机数（同样局面走同一步）", app.get().last === "7,6", app.get().last);

app.doc.getElementById("undo").click();
await sleep(30);
check("悔棋退到我落子之前（电脑那手一并退掉）",
  app.get().moves === "0" && app.stoned("black") === 0 && app.stoned("white") === 0,
  `moves=${app.get().moves} 黑${app.stoned("black")} 白${app.stoned("white")}`);
check("悔棋后可以重新落子", app.get().state === "playing" && app.get().turn === "human");

/* ================================================================== */
section("7. 电脑真的会防守（人闷头连线赢不了）");
/* ================================================================== */

/* 人沿 y=7 一路连点：如果电脑只顾自己下、不回防，人第 5 手就五连了。
   这条断言是"AI 不是摆设"的硬证据。 */
let placed = 0;
for (let round = 0; round < 8; round++) {
  const empties = [...app.doc.querySelectorAll('button[data-y="7"]')].filter((c) => !c.dataset.stone);
  if (!empties.length) break;
  empties.sort((a, b) => Math.abs(+a.dataset.x - 7) - Math.abs(+b.dataset.x - 7));
  empties[0].click();
  placed++;
  await sleep(320);
  if (app.get().state !== "playing") break;
}
const row7 = [...app.doc.querySelectorAll('button[data-y="7"]')];
const white7 = row7.filter((c) => c.dataset.stone === "white").length;
check(`人连点 ${placed} 手也没能连成五`, app.get().state !== "win", app.get().state);
check("电脑在这条线上落过子（有回防动作）", white7 >= 1, `白子 ${white7}`);

/* ================================================================== */
section("8. 写库失败必须摆在界面上");
/* ================================================================== */

const bad = await mount({ failInsert: true });
bad.doc.querySelector('[data-act="mode"][data-mode="duo"]').click();
await sleep(30);
for (const [x, y] of seq) await bad.tap(x, y);
await sleep(60);
check("落库失败时标记为 0（不是假装成功）", bad.get().saved === "0", bad.get().saved);
check("界面上明确报出失败原因",
  bad.doc.getElementById("dbnote").textContent.includes("表里没有这一列"),
  bad.doc.getElementById("dbnote").textContent);
check("棋局本身不受落库失败影响（照样判定出胜负）", bad.get().state === "win");
check("读不到成绩时也不假装有数据", bad.get().records === "0");

/* ================================================================== */

console.log(`\n五子棋工具（Node 侧）：通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log("失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
