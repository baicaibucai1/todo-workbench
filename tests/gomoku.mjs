/**
 * 五子棋在工作台里的浏览器验证。
 *
 * ------------------------------------------------------------------
 * 这个套件为什么分三层
 * ------------------------------------------------------------------
 *   宿主层 —— 侧边栏有没有它、点开后 iframe 指向哪、头部显示什么、
 *             有没有把控制台弄脏。这一层证明"它被装进了工作台"。
 *   工具层 —— 在 iframe 里真的下一局：切模式、落子、电脑应手、
 *             连成五子、清空战绩。这一层证明"它作为一个工具真的能用"。
 *   数据层 —— **直接读宿主的数据层**，不看界面。这一层最要紧：
 *             "界面显示了 1 胜"和"库里真的有 1 行"是两回事，
 *             而这个功能最容易骗人的地方恰好就是前者。
 *
 * 契约那部分（自包含 / data-* / 主题）在 tests/gomoku-unit.mjs 里用 jsdom
 * 验过了 —— 那套不需要浏览器，跑得快。两边一起才算完整。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge（与 Tauri 的 WebView2 同源）。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/gomoku.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

const TOOL_ID = "gomoku";
const TOOL_NAME = "五子棋";
const TABLE = "tool_gomoku_records";

const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });

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
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/gomoku-${n}.png` });

/* ------------------------------------------------------------------ */
/* 宿主数据层：绕开界面，直接读工作台那份落盘快照                       */
/* ------------------------------------------------------------------ */

/**
 * 读持久化快照。内存库每执行一次 SQL 都会立刻写回它（见 db.ts 的 persist()），
 * 所以它就是"库里到底有什么"的真相。
 *
 * 为什么不 import db.ts 再 select：dev server 给模块加时间戳 query，
 * `import("/src/lib/db.ts")` 拿到的是**另一个实例**，而且它只读一次
 * localStorage、之后再也不刷新 —— 同一个 realm 里第二次调用会读回陈旧内存态。
 * 表现是"删掉的数据还在"，而且看不出为什么（第一次踩到的就是这个，
 * 见 tests/tool-database.mjs 里同一处注释）。快照不依赖任何实例，最硬。
 */
const SNAPSHOT_KEY = "todo-workbench:demo-db";

const snapshotTables = () =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    try {
      return (JSON.parse(raw).tables || []).map(([name]) => name);
    } catch {
      return [];
    }
  }, SNAPSHOT_KEY);

/** 某张表现在有哪些行 */
const rowsOf = async (table = TABLE) =>
  page.evaluate(
    ([key, t]) => {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      try {
        const hit = (JSON.parse(raw).tables || []).find(([name]) => name === t);
        return hit ? hit[1] : [];
      } catch {
        return [];
      }
    },
    [SNAPSHOT_KEY, table],
  );

/* ------------------------------------------------------------------ */
/* 工具 iframe                                                         */
/* ------------------------------------------------------------------ */

/** 打开工具（`?tool=` 直链），返回它自己的 frame */
async function openTool() {
  await page.goto(`${BASE}?tool=${TOOL_ID}`, { waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(1400);
  const el = page.locator(`iframe[data-tool-frame="${TOOL_ID}"]`);
  if ((await el.count()) === 0) return null;
  await el.waitFor({ state: "attached" });
  await page.waitForTimeout(900);
  return page.frames().find((f) => /\/tools\/[^/]+\//.test(f.url())) ?? null;
}

const frame = () => page.frameLocator(`iframe[data-tool-frame="${TOOL_ID}"]`);

/** 读工具内部挂出来的状态（同源，可以直接读 contentDocument） */
const toolState = () =>
  page.evaluate((id) => {
    const f = document.querySelector(`iframe[data-tool-frame="${id}"]`);
    const d = f && f.contentDocument;
    if (!d) return null;
    const cell = (x, y) => {
      const el = d.querySelector(`button[data-x="${x}"][data-y="${y}"]`);
      return el ? el.dataset.stone || "" : "?";
    };
    const count = (sel) => d.querySelectorAll(sel).length;
    return {
      title: d.title,
      theme: d.documentElement.dataset.theme,
      ...d.body.dataset,
      cells: count(".cell"),
      wins: count(".cell.win"),
      black: count('[data-stone="black"]'),
      white: count('[data-stone="white"]'),
      status: (d.getElementById("status")?.textContent || "").trim(),
      table: (d.getElementById("meta")?.textContent || "").trim(),
      stats: (d.getElementById("stats")?.textContent || "").trim(),
      dbnote: (d.getElementById("dbnote")?.textContent || "").trim(),
      recText: (d.querySelector(".rec")?.textContent || "").trim(),
      recResult: d.querySelector(".rec .r")?.dataset.r ?? "",
      center: cell(7, 7),
    };
  }, TOOL_ID);

/** 在工具里点一格 */
async function tap(x, y) {
  await frame().locator(`button[data-x="${x}"][data-y="${y}"]`).click();
  await page.waitForTimeout(60);
}

/* ================================================================== */
console.log("\n1. 装进工作台：侧边栏与 iframe");
/* ================================================================== */

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);

const nav = page.locator(`aside [data-nav='tool:${TOOL_ID}']`);
if ((await nav.count()) === 0 || !(await nav.first().isVisible().catch(() => false))) {
  const expand = page.locator('aside button[title="工具"]').first();
  if ((await expand.count()) > 0) {
    await expand.click();
    await page.waitForTimeout(400);
  }
}
check(`侧边栏里有「${TOOL_NAME}」`, (await nav.count()) > 0);

await nav.first().click();
await page.waitForTimeout(1500);
check("点开后挂载了承载它的 iframe",
  (await page.locator(`iframe[data-tool-frame="${TOOL_ID}"]`).count()) === 1);

const iframeSrc = (await page.locator(`iframe[data-tool-frame="${TOOL_ID}"]`).getAttribute("src")) || "";
info("iframe src", iframeSrc);
check("iframe 指向工具自己的入口", iframeSrc.includes(`/tools/${TOOL_ID}/`), iframeSrc);

const headerText = ((await page.locator("header").last().textContent().catch(() => "")) || "").replace(/\s+/g, " ");
info("工具头部", headerText.trim());
check("头部显示工具名", headerText.includes(TOOL_NAME));
check("头部显示版本号", /v\d+\.\d+\.\d+/.test(headerText));

/* ================================================================== */
console.log("\n2. 宿主按 manifest 建好了它要的表");
/* ================================================================== */

const tables = await snapshotTables();
check(`${TABLE} 已存在（说明 manifest 里的 schema 生效了）`, tables.includes(TABLE),
  tables.filter((t) => t.startsWith("tool_")).join(","));

const before = await rowsOf();
check("一开始战绩是空的", Array.isArray(before) && before.length === 0,
  JSON.stringify(before).slice(0, 120));

/* ================================================================== */
console.log("\n3. 工具真的跑起来了");
/* ================================================================== */

let st = await toolState();
check("iframe 里是五子棋自己", !!st && st.title.includes(TOOL_NAME), st && st.title);
check("棋盘是 15×15 = 225 格", !!st && st.cells === 225, st && String(st.cells));
check("工具拿到了宿主上下文（知道自己落在哪张表）",
  !!st && st.table.includes(TABLE), st && st.table);
check("启动状态是干净的", !!st && st.state === "playing" && st.moves === "0" && st.mode === "ai",
  st && JSON.stringify({ state: st.state, moves: st.moves, mode: st.mode }));
await shot("01-open");

/* ================================================================== */
console.log("\n4. 宿主切深色，工具跟着变");
/* ================================================================== */

await page.evaluate(async () => {
  const mod = await import("/src/lib/settings.ts");
  mod.applyTheme("dark");
});
await page.waitForTimeout(700);
st = await toolState();
check("深色主题传进了 iframe", !!st && st.theme === "dark", st && st.theme);
const darkBg = await frame().locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
info("深色下的工具背景", darkBg);
check("深色下背景真的变暗（不是写死白底）", darkBg === "rgb(28, 28, 26)", darkBg);
await shot("02-dark");

await page.evaluate(async () => {
  const mod = await import("/src/lib/settings.ts");
  mod.applyTheme("light");
});
await page.waitForTimeout(500);
st = await toolState();
check("切回浅色也跟着变", !!st && st.theme === "light", st && st.theme);

/* ================================================================== */
console.log("\n5. 两人对战：连成五子并把战绩写进库");
/* ================================================================== */

await frame().locator('[data-act="mode"][data-mode="duo"]').click();
await page.waitForTimeout(200);
st = await toolState();
check("切到两人模式后重开一局", !!st && st.mode === "duo" && st.moves === "0");

const seq = [[7, 7], [0, 0], [8, 7], [1, 0], [9, 7], [2, 0], [10, 7], [3, 0], [11, 7]];
for (const [x, y] of seq) await tap(x, y);
await page.waitForTimeout(900);

st = await toolState();
check("黑方连成五子", !!st && st.state === "win", st && st.state);
check("五连被标出来了", !!st && st.wins === 5, st && String(st.wins));
check("界面说清了是哪一方赢", !!st && st.status.includes("黑胜"), st && st.status);
check("棋盘上 5 黑 4 白", !!st && st.black === 5 && st.white === 4,
  st && `黑${st.black} 白${st.white}`);
await shot("03-win");

const after = await rowsOf();
check("**宿主的数据层里真的多了一行**", Array.isArray(after) && after.length === 1,
  JSON.stringify(after).slice(0, 160));
check("那一行记的是 win 与 9 手",
  Array.isArray(after) && after[0] && after[0].result === "win" && Number(after[0].moves) === 9,
  Array.isArray(after) ? JSON.stringify(after[0]) : "");
check("界面上的战绩与库里一致（1 胜）", !!st && st.stats === "1 胜 · 0 负 · 0 和", st && st.stats);
check("列表条目显示「胜」而不是被算成和",
  !!st && st.recResult === "win" && st.recText.includes("胜"), st && st.recText);
check("没有把写库失败提示挂在界面上", !!st && st.dbnote === "", st && st.dbnote);

/* ================================================================== */
console.log("\n6. 重开工作台，战绩还在（说明是真落库，不是只存在内存）");
/* ================================================================== */

await openTool();
let st2 = await toolState();
check("重新打开后战绩仍是 1 条", !!st2 && st2.records === "1", st2 && st2.records);
check("统计也还是 1 胜", !!st2 && st2.stats === "1 胜 · 0 负 · 0 和", st2 && st2.stats);

/* ================================================================== */
console.log("\n7. 清空战绩要点两次，而且删的是库里的行");
/* ================================================================== */

const clearBtn = frame().locator("#clear");
await clearBtn.click();
await page.waitForTimeout(300);
st2 = await toolState();
check("第一次点只是上膛，界面上的战绩还在", !!st2 && st2.records === "1", st2 && st2.records);
const armedText = await clearBtn.textContent();
check("按钮换成了确认文案", String(armedText).includes("再点一次"), String(armedText));
const midway = await rowsOf();
check("库里此时也没被删", Array.isArray(midway) && midway.length === 1,
  JSON.stringify(midway).slice(0, 120));

await clearBtn.click();
await page.waitForTimeout(900);
st2 = await toolState();
const cleared = await rowsOf();
check("第二次点才真清空（库里 0 行）", Array.isArray(cleared) && cleared.length === 0,
  JSON.stringify(cleared).slice(0, 120));
check("界面回到空状态", !!st2 && st2.records === "0" && st2.stats === "还没有战绩",
  st2 && st2.stats);
const restored = await clearBtn.textContent();
check("按钮恢复原状（不卡在确认态）", restored.trim() === "清空战绩", restored.trim());

/* ================================================================== */
console.log("\n8. 人机对战：电脑会应手");
/* ================================================================== */

await frame().locator('[data-act="mode"][data-mode="ai"]').click();
await page.waitForTimeout(250);
await tap(7, 7);
st2 = await toolState();
check("我落子后轮到电脑", !!st2 && st2.moves === "1" && st2.turn === "ai",
  st2 && `moves=${st2.moves} turn=${st2.turn}`);
await page.waitForTimeout(700);
st2 = await toolState();
check("电脑真的回了一手", !!st2 && st2.moves === "2" && st2.turn === "human", st2 && st2.moves);
check("盘上 1 黑 1 白", !!st2 && st2.black === 1 && st2.white === 1,
  st2 && `黑${st2.black} 白${st2.white}`);
info("电脑落点", st2 && st2.last);
await shot("04-ai");

await frame().locator("#undo").click();
await page.waitForTimeout(300);
st2 = await toolState();
check("悔棋退到我落子之前（电脑那手一并退掉）",
  !!st2 && st2.moves === "0" && st2.black === 0 && st2.white === 0,
  st2 && `moves=${st2.moves}`);

/* ================================================================== */
console.log("\n9. 收尾：控制台干净");
/* ================================================================== */

check("全程没有控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

console.log(`\n五子棋（浏览器）：通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log("失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
