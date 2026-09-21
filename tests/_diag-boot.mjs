/**
 * 一次性诊断：打包后的应用启动后到底活不活得下来。
 *
 * 起因：CDP 连上后读到 body 是"正在初始化工作台…"，两秒后页面消失。
 * 需要分清是「启动慢」还是「初始化中途挂了」——后者是发布级故障，
 * 而且浏览器里怎么测都测不出来（浏览器走的是 MemoryDb，根本不碰 SQLite 迁移）。
 *
 * 做法：带调试端口启动，每秒记录一次：进程是否存活、页面是否还活着、
 * 界面上到哪一步了、数据库文件长什么样。
 *
 * 用法：node tests/_diag-boot.mjs
 */

import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const RELEASE = "C:/AI_Production/Tools/main/src-tauri/target/x86_64-pc-windows-gnu/release";
const EXE = path.join(RELEASE, "todo-workbench.exe");
const CDP = 9344;
const DATA = path.join(process.env.APPDATA ?? "", "com.sogapopo.todo-workbench");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(pathname) {
  return new Promise((res) => {
    const q = http.get({ host: "127.0.0.1", port: CDP, path: pathname, timeout: 1500 }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    });
    q.on("error", () => res({ status: 0 }));
    q.on("timeout", () => {
      q.destroy();
      res({ status: 0 });
    });
  });
}

function listFiles(dir, depth = 0) {
  if (depth > 2 || !fs.existsSync(dir)) return [];
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listFiles(p, depth + 1));
    else out.push(`${path.relative(dir, p)}  ${st.size} B  ${st.mtime.toLocaleTimeString("zh-CN")}`);
  }
  return out;
}

function aliveCount() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq todo-workbench.exe", "/FO", "CSV"], {
    maxBuffer: 1 << 22,
  });
  const txt = new TextDecoder("gbk").decode(r.stdout);
  return txt.split(/\r?\n/).filter((l) => /todo-workbench\.exe/i.test(l)).length;
}

console.log("数据目录:", DATA);
console.log("启动前该目录内容:");
for (const f of listFiles(DATA)) console.log("   ", f);

spawnSync("taskkill", ["/IM", "todo-workbench.exe", "/F"], { stdio: "ignore" });
await sleep(1500);

const before = aliveCount();
console.log(`\n清理后残留进程: ${before}`);

const app = spawn(EXE, [], {
  stdio: "ignore",
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` },
});
console.log(`已启动 pid=${app.pid}\n`);

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

let browser = null;
for (let i = 0; i < 30; i++) {
  const v = await probe("/json/version");
  if (v.status === 200) {
    console.log(`调试端点就绪：${(i + 1) * 500}ms`);
    break;
  }
  await sleep(500);
}

try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
} catch (e) {
  console.log("connectOverCDP 失败:", String(e.message).split("\n")[0]);
}

const t0 = Date.now();
for (let i = 1; i <= 24; i++) {
  await sleep(1000);
  const t = ((Date.now() - t0) / 1000).toFixed(0);
  const procs = aliveCount();
  const exited = app.exitCode !== null;
  let page = "—";
  try {
    const pages = browser ? browser.contexts()[0].pages() : [];
    if (pages.length) {
      const snap = await pages[0].evaluate(() => ({
        ready: document.readyState,
        text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 44),
        aside: !!document.querySelector("aside"),
        rows: document.querySelectorAll("[data-task-id]").length,
        err: document.querySelector("[data-fatal]") ? "有致命错误块" : "",
      }));
      page = `${snap.ready} / "${snap.text}" / aside=${snap.aside} rows=${snap.rows} ${snap.err}`;
    } else {
      page = "无 page（target 已消失）";
    }
  } catch (e) {
    page = `page 读不到：${String(e.message).split("\n")[0].slice(0, 50)}`;
  }
  console.log(
    `+${t.padStart(2)}s  进程=${procs}  spawn退出码=${exited ? app.exitCode : "运行中"}  ${page}`,
  );
}

console.log("\n数据目录:");
for (const f of listFiles(DATA)) console.log("   ", f);

try {
  if (browser) await browser.close();
} catch {
  /* 已断开 */
}
spawnSync("taskkill", ["/IM", "todo-workbench.exe", "/F"], { stdio: "ignore" });
console.log("\n已关闭应用。");
