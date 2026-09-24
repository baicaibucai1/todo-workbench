/**
 * 跑一遍全部浏览器 e2e，汇总通过/失败。
 * 这些脚本都要 dev server 在 localhost:1420 上（已起）。
 * 逐个跑，不并发 —— 它们共用同一个 dev server 与 localStorage，并发会互相踩。
 *
 * ⚠️ 这里只收**需要浏览器**的套件。不依赖浏览器的三套走 npm 脚本：
 *   npm run smoke       —— 数据层 / 仓库 / 工具隔离
 *   npm run sync:test   —— 同步的合并算法与写回（含 MemoryDb 往返）
 *   npm run agent:test  —— AI 助手的动作协议、权限门、流式解析（含 MemoryDb 往返）
 * 漏跑它们不会让这一轮变红，所以改完数据层记得单独跑一次。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SUITES = [
  ["task-detail.mjs", []],
  ["todo-extras.mjs", []],
  ["daily-settings.mjs", []],
  // 同步分区：只验界面这一层（默认只勾待办、勾选落库、演示模式下的禁用态）。
  // 合并算法与写回走的是 Node 侧的 npm run sync:test —— 那边不需要浏览器，
  // 也不会因为多开一个渲染进程而拖慢这一轮。
  ["sync-panel.mjs", []],
  ["background.mjs", []],
  ["tool-browser.mjs", []],
  // 工具自己的数据表与互相调用；依赖 tool-browser 之后仍在同一份 localStorage 上跑，
  // 但结尾会自己清掉 namespace，所以放在 tool-browser 之后无副作用
  ["tool-database.mjs", []],
  // 五子棋：既验"工具在工作台里真的能玩"，也验它有没有守住 tool-authoring
  // 那份契约（自包含 / data-* / 响应主题）。它只往自己的表里写战绩，不动别人。
  ["gomoku.mjs", []],
  ["image-crop-ai.mjs", []],
  ["placeholder-tools.mjs", []],
  ["ai-gen.mjs", []],
  // 跨源工具桥：dev 下工具与宿主同源，只有这一个套件能挡住 targetOrigin 那类
  // "只在装出来的应用里复现"的断链（详见套件头注释）
  ["cross-origin-bridge.mjs", []],
  ["gallery.mjs", ["--fresh"]],
  ["wallpapers.mjs", []],
  ["attachments.mjs", ["--fresh"]],
  ["orders-view.mjs", ["--fresh"]],
  ["special-orders.mjs", ["--fresh"]],
  ["urgent.mjs", ["--fresh"]],
  ["panel-resize.mjs", ["--fresh"]],
  // AI 助手：用 page.route 拦掉对话端点、喂自己拼的 SSE 分片，所以不连任何模型。
  // 它开头会清一次 localStorage、结尾再清一次，所以放在最后 —— 不打扰别人。
  // **它验不到"真把工具写进磁盘"**（那要桌面版的 fs），见套件头注释。
  ["agent.mjs", []],
  // 助手的入口与容器：悬浮球的拖动/落点持久化、窗口形态（靠右停靠而不是
  // 铺满整屏的模态）、以及多会话（新建=新开一段而不是清空、切换、两段式删除）。
  // 同样拦掉模型端点，同样自己清库。
  ["agent-ball.mjs", []],
];

const rows = [];

/**
 * 套件之间的喘息时间。
 *
 * 上一个套件的 Edge 进程不是 close() 一返回就彻底消失的；紧接着拉起下一个时，
 * 机器上同时有十几个渲染进程在收尾，下一个套件开局那几个"固定等 1.5 秒"的
 * 断言就会随机挂掉 —— 表现为"单独跑全绿、连着跑就红"。加一秒半的间隔比在
 * 每个套件里到处加超时便宜得多。
 */
const settle = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (const [file, args] of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [`tests/${file}`, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  const ms = Date.now() - t0;
  settle(1500);
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  // 汇总行有三种写法：
  //   「通过 267 项，失败 0 项」/「结果：25 通过 / 0 失败」/「汇总: 29 通过 / 0 失败」
  const m =
    out.match(/通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/) ||
    out.match(/(?:结果|汇总)[：:]\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/) ||
    out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /通过|失败|PASS|FAIL|✔|✘/.test(l))
    .slice(-1)[0];
  rows.push({
    file,
    code: r.status,
    pass: m ? Number(m[1]) : null,
    fail: m ? Number(m[2]) : null,
    ms,
    tail: line || "",
  });
  const tag = r.status === 0 ? "OK  " : "FAIL";
  console.log(
    `  ${tag}  ${file.padEnd(24)} exit=${r.status}  ${m ? `${m[1]} 通过 / ${m[2]} 失败` : "（没读到汇总）"}  ${(ms / 1000).toFixed(1)}s`,
  );
  if (r.status !== 0) {
    console.log("       尾行:", JSON.stringify(line));
    // 两类失败都要露出来：断言失败（FAIL）和**抛异常**（Playwright 的
    // TimeoutError / 元素找不到）。只抓 FAIL 的话，崩在 await 上的套件
    // 会只剩一句"没读到汇总"，等于没有信息。
    const fails = out
      .split("\n")
      .filter((l) => /FAIL|失败|not ok|✘|Error|error:|waiting for locator/.test(l))
      .slice(0, 10);
    for (const f of fails) console.log("       ", f.trim().slice(0, 170));
  }
}

const bad = rows.filter((r) => r.code !== 0);
console.log("\n=========================");
console.log(`共 ${rows.length} 个套件，失败 ${bad.length} 个`);
console.log(`合计通过 ${rows.reduce((a, r) => a + (r.pass ?? 0), 0)} 项`);
if (bad.length) console.log("失败套件：" + bad.map((r) => r.file).join(", "));
fs.writeFileSync(".setup-tmp/e2e-summary.json", JSON.stringify(rows, null, 2));
process.exit(bad.length ? 1 : 0);
