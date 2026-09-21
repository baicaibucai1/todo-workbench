#!/usr/bin/env node
/**
 * 桌面版实机验证（desktop-app.mjs）
 *
 * 为什么需要这一层：
 *
 * 浏览器 e2e 全绿**说明不了桌面版能用** —— 工具的加载链路在两种模式下完全不同：
 *   浏览器：Vite dev server 直接静态服务 /tools/<id>/index.html
 *   桌面：resource 目录 → asset 协议 → CSP → iframe
 * 已经因此漏掉过一个严重故障：桌面端代码去 %APPDATA%/tools 找工具，而工具实际装在
 * 安装目录的 _up_/tools 下 —— **四个工具全部打不开**，浏览器里却一切正常。
 *
 * 所以这里验的是那条链路上每一环的**事实**：
 *   1. 工具文件真的在可执行文件旁边（打包把资源放对了位置）
 *   2. 代码算出来的候选路径里，**确实有一个是存在的**（找的地方和放的地方对得上）
 *   3. assetProtocol.scope 放行了那个位置，CSP 也允许 iframe 加载 asset 协议
 *   4. 应用真能启动，不是崩在启动阶段
 *
 * 关于交互层：本想用 CDP（给 WebView2 传 --remote-debugging-port，再用 Playwright 连）
 * 去点开每个工具做断言。2026-09-19 把这条路彻底查了一遍，结论是**不可用**：
 *
 *   - WebView2 的调试端点是个很窄的窗口：浏览器进程起来时开端口（约启动后 2s 能
 *     /json/version 200），初始化完就关，之后连 127.0.0.1 直接是 status 0。
 *   - 抢在窗口内 connectOverCDP，最好情况下只能读一次（读到的是
 *     `正在初始化工作台…`），下一次操作就报 target closed 或 502。
 *   - 换成裸 WebSocket（Node 22 自带）+ /json/list 拿 target，能连上 ws，
 *     但 Runtime.evaluate 超时（拿到的 target 还是 about:blank）。
 *   - 顺便排除掉一个吓人的误判：**应用本身没崩**。进程能活 30s+、窗口在、
 *     WAL 在被写，页面停在"正在初始化工作台…"只是我们的连接赶在初始化中间。
 *     所以别把"读不到界面"当成"应用打不开"。
 *
 * 结论：交互部分保持尽力而为，失败只提示不判错。真正的判据是上面 1~4 ——
 * 它们全是**确定性**检查（文件在不在、路径对不对、CSP 放不放行），
 * 不依赖任何调试通道。要查"装完打不开"这类问题，用 tests/_diag-boot.mjs。
 *
 * 前置：已打包（node scripts/build-desktop.mjs）。
 * 用法：node tests/desktop-app.mjs [exe 路径] [--no-launch]
 */

import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const ROOT = "C:/AI_Production/Tools/main";
const RELEASE = path.join(ROOT, "src-tauri", "target", "x86_64-pc-windows-gnu", "release");
const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const argv = process.argv.slice(2);
const NO_LAUNCH = argv.includes("--no-launch");
const EXE = argv.find((a) => a.endsWith(".exe")) || path.join(RELEASE, "todo-workbench.exe");

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 1. 资源真的放在可执行文件旁边                                        */
/* ------------------------------------------------------------------ */

console.log("=== 桌面版实机验证 ===");
info("可执行文件", EXE);
if (!fs.existsSync(EXE)) {
  console.error("  [x] 找不到可执行文件，先跑：node scripts/build-desktop.mjs");
  process.exit(1);
}
check("应用可执行文件存在", true, `${(fs.statSync(EXE).size / 1048576).toFixed(1)} MB`);

const exeDir = path.dirname(EXE);
// Tauri 在 Windows 上把 resource_dir 解析为「可执行文件所在目录」
const resA = path.join(exeDir, "_up_", "tools");
const resB = path.join(exeDir, "tools");
const resDir = fs.existsSync(resA) ? resA : fs.existsSync(resB) ? resB : null;

console.log("");
console.log("1. 资源位置");
check("可执行文件旁有工具资源目录", !!resDir, resDir ?? `看了 ${resA} 和 ${resB}，都没有`);
if (!resDir) {
  console.error("  打包没有把工具放到可执行文件旁边，后面没法继续。");
  process.exit(1);
}
info("工具资源目录", resDir);

const diskTools = fs
  .readdirSync(resDir)
  .filter((d) => fs.statSync(path.join(resDir, d)).isDirectory())
  .sort();
info("其中的工具", diskTools.join(", "));
// 期望值从源码目录里数出来，而不是写死一个数字 —— 加一个内置工具要改的地方越少，
// 忘了改的概率就越低（之前 scratchpad 加进来时这条就漏过一次）。
const srcToolCount = fs
  .readdirSync(path.join(ROOT, "tools"))
  .filter((d) => fs.statSync(path.join(ROOT, "tools", d)).isDirectory()).length;
check(
  `资源目录里的工具数与源码一致（${srcToolCount} 个）`,
  diskTools.length === srcToolCount,
  `${diskTools.length} 个`,
);
// 「特殊单号记录」曾经是第 4 个工具，现在改成了原生视图（不再有工具目录）。
// 这里顺手钉住"它没有再被塞回工具目录"，否则 check-installer 的门禁会跟着对不上
check(
  "占位工具 special-orders 的目录已移除",
  !diskTools.includes("special-orders"),
  diskTools.join(","),
);

/* ------------------------------------------------------------------ */
/* 2. 代码算出的候选路径里，至少有一个存在（本次故障的核心）             */
/* ------------------------------------------------------------------ */

console.log("");
console.log("2. 路径契约：代码找的地方 == 文件放的地方");

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const identifier = conf.identifier;
const appDataDir = path.join(process.env.APPDATA ?? "", identifier);
info("code 的 appDataDir", appDataDir);

// 与 src/lib/tools.ts 的 desktopToolCandidates 保持一致。
// 两边语言不同（TS / mjs）没法共享模块，所以下面额外校验源码里确实写着这些候选，
// 防止「改了一边忘了另一边」。
const toolsSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "tools.ts"), "utf8");
check('tools.ts 里有 `_up_` 候选路径', /["'`]_up_["'`]/.test(toolsSrc), "_up_ 是 Tauri 对资源路径 `..` 的编码");
check(
  "tools.ts 的扫描同时覆盖 resourceDir 与 appDataDir",
  /resourceDir\(\)/.test(toolsSrc) && /appDataDir\(\)/.test(toolsSrc),
  "只扫 appDataDir 就是本次故障",
);

function candidatesFor(toolId, entry) {
  return [
    path.join(exeDir, "_up_", "tools", toolId, entry),
    path.join(exeDir, "tools", toolId, entry),
    path.join(appDataDir, "tools", toolId, entry),
  ];
}

let resolvable = 0;
for (const tool of diskTools) {
  const manifestPath = path.join(resDir, tool, "manifest.json");
  let entry = "index.html";
  try {
    entry = JSON.parse(fs.readFileSync(manifestPath, "utf8")).entry || "index.html";
  } catch {
    /* 用默认入口 */
  }
  const cands = candidatesFor(tool, entry);
  const hit = cands.find((c) => fs.existsSync(c));
  if (hit) resolvable++;
  check(
    `${tool}：候选路径命中（桌面端能找到入口文件）`,
    !!hit,
    hit ? path.relative(exeDir, hit) : "三个候选都不存在，打开必然是空白",
  );
}
check("全部工具都可解析", resolvable === diskTools.length, `${resolvable}/${diskTools.length}`);

/* ------------------------------------------------------------------ */
/* 3. 协议与 CSP 放行                                                   */
/* ------------------------------------------------------------------ */

console.log("");
console.log("3. 协议与 CSP");

const sec = conf.app?.security ?? {};
check("assetProtocol 已启用", sec.assetProtocol?.enable === true);

/** `$RESOURCE/x/**` 能否覆盖某个相对路径（通配符必须一次替换完） */
function scopeCovers(entry, rel) {
  if (typeof entry !== "string" || !/^\$RESOURCE/i.test(entry)) return false;
  const body = entry.replace(/^\$RESOURCE\/?/i, "");
  const pattern =
    "^" + body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*")) + "$";
  return new RegExp(pattern, "i").test(rel);
}
const relToRes = path.relative(exeDir, resDir).replace(/\\/g, "/");
const scopeOk = (sec.assetProtocol?.scope ?? []).some((s) => scopeCovers(s, `${relToRes}/x/y.html`));
check(
  "assetProtocol.scope 放行了工具所在目录",
  scopeOk,
  `目录 ${relToRes} vs scope ${JSON.stringify(sec.assetProtocol?.scope)}`,
);

const csp = {};
for (const part of String(sec.csp ?? "").split(";")) {
  const bits = part.trim().split(/\s+/).filter(Boolean);
  if (bits.length) csp[bits[0].toLowerCase()] = bits.slice(1).join(" ");
}
const frameSrc = csp["frame-src"] ?? csp["default-src"] ?? "";
check("CSP 允许 iframe 加载 asset 协议", /asset:|asset\.localhost/i.test(frameSrc), frameSrc || "(未设置)");
check("CSP 允许工具外联 https（AI 生成要调外部 API）", /https:/i.test(csp["connect-src"] ?? ""), csp["connect-src"] ?? "");

// 壁纸与清单走的是**同源路径**（/wallpapers/xxx.jpg、/wallpapers/index.json），
// 所以真正决定它们能不能加载的是 img-src / connect-src 里的 'self'。
// 这两个词一旦被删掉，浏览器里一切正常，装出来的应用里壁纸格子却是空的。
check(
  "CSP 的 img-src 允许 'self'（壁纸走同源路径）",
  /'self'|(^|\s)self(\s|$)/i.test(csp["img-src"] ?? ""),
  csp["img-src"] ?? "(未设置)",
);
check(
  "CSP 的 connect-src 允许 'self'（壁纸清单是同源 fetch）",
  /'self'|(^|\s)self(\s|$)/i.test(csp["connect-src"] ?? ""),
  csp["connect-src"] ?? "(未设置)",
);

/* ------------------------------------------------------------------ */
/* 4. 真启动一次，确认不是崩在启动阶段                                   */
/* ------------------------------------------------------------------ */

if (!NO_LAUNCH) {
  console.log("");
  console.log("4. 启动应用");

  const app = spawn(EXE, [], { stdio: "ignore", env: { ...process.env } });
  await sleep(7000);

  const tl = spawnSync("tasklist", ["/V", "/FI", "IMAGENAME eq todo-workbench.exe", "/FO", "CSV"], {
    maxBuffer: 1 << 24,
  });
  const txt = new TextDecoder("gbk").decode(tl.stdout);
  const rows = txt.split(/\r?\n/).filter((l) => /todo-workbench\.exe/i.test(l));
  let windowTitle = "";
  for (const line of rows) {
    const parts = line.split('","').map((s) => s.replace(/^"/, "").replace(/"\s*$/, ""));
    if (parts[8] && parts[8] !== "暂缺") windowTitle = parts[8];
  }
  check("应用进程存活", rows.length > 0, `${rows.length} 个进程`);
  check("主窗口已创建（有窗口标题）", !!windowTitle, windowTitle || "没读到窗口标题");
  if (windowTitle) info("窗口标题", windowTitle);

  // ---- CDP 交互（尽力而为）----
  // 这条通道有多不可靠见文件头注释：抢到窗口时能读一次，之后必断。
  // 所以这里只试一次「读一眼界面」，成功就留张截图；失败只提示不判错。
  // 别在这里堆断言 —— 会跑的断言必须是确定性的，否则只是"偶尔绿"的假信心。
  //
  // 随包静态资源（壁纸）在真宿主里能不能加载，靠 tests/wallpapers.mjs 的
  // 确定性检查（资源键确实嵌进了 exe）+ 本文件第 3 节检查的 CSP 同源放行来守。
  const CDP = 9223;
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire("C:/AI_Production/QQbot/");
    const { chromium } = req("playwright");

    spawn(EXE, [], {
      stdio: "ignore",
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` },
    });
    const probe = () =>
      new Promise((res) => {
        const q = http.get({ host: "127.0.0.1", port: CDP, path: "/json/version", timeout: 1500 }, (r) => {
          r.resume();
          res(true);
        });
        q.on("error", () => res(false));
        q.on("timeout", () => {
          q.destroy();
          res(false);
        });
      });
    let ready = false;
    for (let i = 0; i < 20; i++) {
      if (await probe()) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    if (ready) {
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
      const pg = b.contexts()[0].pages()[0];
      // 抓到的页面可能停在"正在初始化工作台…"（我们的连接赶在初始化中间），
      // 所以只记录看到什么，不当判据
      const text = (await pg.locator("body").innerText()).trim();
      info("CDP 读到的界面文本", text.slice(0, 40) || "(空)");
      await pg.screenshot({ path: path.join(SHOT_DIR, "30-desktop-app.png") });
      info("截图", "out/30-desktop-app.png");
      await b.close();
    } else {
      info("交互验证", "跳过（WebView2 调试端点未就绪，见文件头注释）");
    }
  } catch (e) {
    info("交互验证", `跳过（${String(e?.message ?? e).split("\n")[0].slice(0, 70)}）`);
  }

  // CDP 折腾一通之后应用还得活着 —— 这是真的会被判错的项：
  // 调试端口是塞给 WebView2 的额外启动参数，配错了可能把宿主一起带走。
  await sleep(1000);
  const after = spawnSync("tasklist", ["/FI", "IMAGENAME eq todo-workbench.exe", "/FO", "CSV"], {
    maxBuffer: 1 << 22,
  });
  const afterCount = new TextDecoder("gbk")
    .decode(after.stdout)
    .split(/\r?\n/)
    .filter((l) => /todo-workbench\.exe/i.test(l)).length;
  check("折腾完调试端口后应用依然存活", afterCount > 0, `${afterCount} 个进程`);

  spawnSync("taskkill", ["/IM", "todo-workbench.exe", "/F"], { stdio: "ignore" });
  info("已关闭应用", "");
}

console.log("");
console.log("=".repeat(52));
console.log(
  failures.length === 0 ? `通过 ${passed} 项` : `通过 ${passed} 项，失败 ${failures.length} 项`,
);
failures.forEach((f) => console.log("  FAIL  " + f));
console.log("=".repeat(52));
process.exit(failures.length === 0 ? 0 : 1);
