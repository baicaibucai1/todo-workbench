/**
 * 「示例数据」开关的专项验证。
 *
 * ============================ 为什么它必须独立成一个入口 ============================
 *
 * v20 起示例数据是**选装、默认关**（见 SETTINGS.seedSampleData 的注释）。
 * 这带来两条要验的路径，而它们**不能在同一个进程里验**：
 *
 *   · 默认关：空库跑一遍 seed*IfEmpty，什么都不该出现 —— 在 smoke.mjs 里验；
 *   · 打开关：把开关写成 1 再跑一遍，清单 / 任务 / 流程 / 示例流程任务都该出现。
 *
 * 第二条不能在 smoke 里接着做，因为 repo 的三个 seed*IfEmpty 都用**模块级
 * Promise 做了串行锁**（为 React StrictMode 的双跑准备的，见 repo 里
 * seedPromise 的注释）。第一轮"默认不种"已经被缓存住，第二次调用拿到的
 * 还是那个已完成的 Promise —— 这不是 bug，是锁该有的行为。
 *
 * 也不能在 smoke 里 spawnSync 出本文件：本机沙箱下 spawnSync 一律 EBUSY
 * （errno -4082，见 MEMORY.md 记的那条环境坑），报出来会伪装成"功能坏了"。
 *
 * 所以它就是**一个平级的测试入口**，由 `npm run smoke` 在同一批 esbuild
 * 构建里编译、在 smoke 之后单独执行 —— 自己的进程、自己的模块实例，锁干净。
 *
 * 用法：node tests/seed-opt-in.mjs（或 npm run smoke，它会顺带跑这个）
 */

import { JSDOM } from "jsdom";

/* ---------- 准备浏览器环境（localStorage 是 MemoryDb 的落盘介质） ---------- */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

/* ---------- 测试框架（与 smoke.mjs 同款极简实现） ---------- */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---------- 载入业务模块 ---------- */

const { initDb } = await import("../src/lib/db.ts");
const repo = await import("../src/lib/repo.ts");
const { SETTINGS } = await import("../src/lib/settings.ts");

console.log("\n示例数据开关（选装，v20）");

await initDb();

// 关键一步：先把开关显式打开。它是"默认关"的，不写这一笔下面什么都种不上。
// 注意读法方向 —— repo 的 wantSampleData 只认 "1"，
// 缺键/空串/别的任何值都算关（与 registry 的 enabledByDefault 方向相反，
// 理由见 SETTINGS.seedSampleData 的注释）。
await repo.setSetting(SETTINGS.seedSampleData, "1");

await repo.seedIfEmpty();
await repo.seedWorkOrderFlowsIfEmpty();
await repo.seedDemoWorkOrdersIfEmpty();

const lists = await repo.fetchLists();
const tasks = await repo.fetchTasks({ view: "all", includeDone: true });
const flows = await repo.fetchFlows();
const orders = await repo.fetchWorkOrders({ view: "orders", includeDone: true });

check("种下清单", lists.length >= 2, `${lists.length} 个`);
check("列表名称正确", lists.some((l) => l.name === "工作"), lists.map((l) => l.name).join(","));
check("种下示例任务", tasks.length >= 4, `${tasks.length} 条`);
check("存在已完成任务（演示折叠分组）", tasks.some((t) => t.done));
check("存在「我的一天」任务", tasks.some((t) => t.myDay));
check("存在重要任务", tasks.some((t) => t.important));
check("存在每日重复任务", tasks.some((t) => t.repeat === "daily"));

check("种下三套流程模板", flows.length === 3, `${flows.length} 套`);
check("有且只有一个默认流程", flows.filter((f) => f.isDefault).length === 1);
check(
  "默认流程是「标准流程」",
  flows.find((f) => f.isDefault)?.name === "标准流程",
  flows.find((f) => f.isDefault)?.name ?? "(无)",
);
check("种下示例流程任务", orders.length >= 2, `${orders.length} 张`);

/* ---------- 反向：把开关改回 0，已有的数据不该被删掉 ---------- */

/*
 * 这是这个开关最容易被人误解的一点：它的语义是**"下次库空时要不要种"**，
 * 不是"关掉就把示例删掉"。用户库里已经有的东西一律不动 ——
 * 否则关一个开关就删数据，那是另一种更糟的意外。
 */
await repo.setSetting(SETTINGS.seedSampleData, "0");
await repo.seedIfEmpty();
check("关掉开关不删已有清单", (await repo.fetchLists()).length === lists.length);
check(
  "关掉开关不删已有任务",
  (await repo.fetchTasks({ view: "all", includeDone: true })).length === tasks.length,
);

console.log(`\n${"=".repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failed ? 1 : 0);
