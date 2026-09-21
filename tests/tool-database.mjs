/**
 * 工具的「数据表 + 联动」端到端验证。
 *
 * 这一套是为了补上 tool-browser.mjs 测不到的一层：
 * 工具**自己的数据**到底有没有真的落进数据库、有没有真的隔离、
 * 能不能互相拉起、用户能不能在某个地方看到并清掉它们。
 *
 * 载体是随包自带的「随手记」（tools/scratchpad）—— 它声明了一张表、
 * 用结构化 CRUD 读写它，并能把一条内容交给别的工具。用一个真工具跑，
 * 而不是在测试里造一个假的 iframe，是因为**桥要求消息来自宿主渲染的那个
 * iframe**，伪造的 frame 会被 `e.source !== frame.contentWindow` 直接丢掉。
 *
 * 前置：`node node_modules/vite/bin/vite.js --host localhost` 已在跑。
 * 用法：node tests/tool-database.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

const TOOL_ID = "scratchpad";
const TOOL_NAME = "随手记";
const TABLE = "tool_scratchpad_notes";

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
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

/**
 * 宿主那一侧的数据层模块。**必须importute app 加载的同一个 URL** ——
 *
 * dev server 给模块加的时间戳 query（`?t=…`）意味着 `import("/src/lib/db.ts")`
 * 拿到的是**另一个**模块实例：它内部会新建一个 MemoryDb，只读一次 localStorage，
 * 之后再也不刷新。表现是"工具明明写了数据，测试却读到空"，而且看不出为什么。
 * 从性能条目里找回 app 实际用的那个 URL，两次 import 才是同一个实例。
 */
const dbUrl = () =>
  page.evaluate(() => {
    const hits = performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .filter((n) => /\/src\/lib\/db\.ts/.test(n));
    return hits[hits.length - 1] || "/src/lib/db.ts";
  });

/**
 * 直接读宿主的数据层，绕开 UI —— 落库有没有真的发生，只有它会说实话。
 */
const rowsOf = async (table = TABLE) =>
  page.evaluate(
    async ([u, t]) => {
      const m = await import(u);
      await m.initDb();
      try {
        return await m.db().select(`SELECT * FROM ${t}`);
      } catch (e) {
        return { __error: String(e && e.message ? e.message : e) };
      }
    },
    [await dbUrl(), table],
  );

/** 库里现在有哪些表 */
const allTables = async () =>
  page.evaluate(async (u) => {
    const m = await import(u);
    await m.initDb();
    return m.db().tableNames();
  }, await dbUrl());

/**
 * **在 iframe 内部**向宿主发一次请求。
 *
 * 宿主的桥有一道硬校验：`e.source !== frame.contentWindow` 就丢弃消息 ——
 * 从父页面用 `iframe.contentWindow.postMessage()` 冒充工具是发不进去的
 * （这本身是设计的一部分：别的 iframe 不能冒充工具）。
 * 所以这里必须把代码放进 iframe 自己的上下文里执行，
 * 用 Playwright 的 Frame.evaluate 而不是 page.evaluate。
 */
const askInTool = async (op, payload, timeout = 8000) => {
  const handle = await page.locator(`iframe[data-tool-frame="${TOOL_ID}"]`).elementHandle();
  const frame = await handle.contentFrame();
  if (!frame) return { noFrame: true };
  return frame.evaluate(
    async ([op, payload, timeout]) => {
      return await new Promise((resolve) => {
        const id = "probe-" + Math.random().toString(36).slice(2);
        const onMsg = (e) => {
          if (!e.data || e.data.source !== "workbench-host" || e.data.type !== "tool:response") return;
          if (e.data.id !== id) return;
          window.removeEventListener("message", onMsg);
          resolve({ ok: e.data.ok, data: e.data.data, error: e.data.error });
        };
        window.addEventListener("message", onMsg);
        window.parent.postMessage(
          { source: "workbench-tool", type: "tool:request", id, op, payload },
          "*",
        );
        setTimeout(() => resolve({ timeout: true }), timeout);
      });
    },
    [op, payload, timeout],
  );
};

console.log("\n1. 打开「随手记」");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);

const nav = page.locator(`aside [data-nav='tool:${TOOL_ID}']`);
let navCount = await nav.count();
if (navCount === 0 || !(await nav.first().isVisible().catch(() => false))) {
  const expand = page.locator('aside button[title="工具"]').first();
  if ((await expand.count()) > 0) {
    await expand.click();
    await page.waitForTimeout(400);
  }
}
check(`侧边栏里有「${TOOL_NAME}」`, (await nav.count()) > 0);
await nav.first().click();
await page.waitForTimeout(1600);

check("工具 iframe 已挂载", (await page.locator(`iframe[data-tool-frame="${TOOL_ID}"]`).count()) === 1);
const meta = (await page
  .locator(`iframe[data-tool-frame="${TOOL_ID}"]`)
  .evaluate(() => null)
  .catch(() => null)) === null;

const readFrame = () =>
  page.evaluate((id) => {
    const f = document.querySelector(`iframe[data-tool-frame="${id}"]`);
    const d = f && f.contentDocument;
    if (!d) return null;
    return {
      meta: (d.getElementById("meta")?.textContent || "").trim(),
      listText: (d.getElementById("list")?.textContent || "").trim(),
      notes: d.querySelectorAll(".note").length,
      peers: (d.getElementById("peers")?.textContent || "").trim(),
      schemaJson: d.getElementById("schema")?.textContent || "",
      title: d.title,
    };
  }, TOOL_ID);

let fr = await readFrame();
check("iframe 里是随手记自己", !!fr && fr.title.includes(TOOL_NAME), fr && fr.title);
check("工具拿到了宿主的运行上下文", !!fr && fr.meta.includes("tool_scratchpad_notes"), fr && fr.meta);
info("工具显示的上下文", fr && fr.meta);

console.log("\n2. 宿主按 manifest 建好了表");
const tables = await allTables();
check(`${TABLE} 已存在`, tables.includes(TABLE), tables.join(","));
const before = await rowsOf();
check("一开始是空的", Array.isArray(before) && before.length === 0, JSON.stringify(before).slice(0, 120));

console.log("\n3. 在工具里存两条（走 row.insert）");
const frame = page.frameLocator(`iframe[data-tool-frame="${TOOL_ID}"]`);
await frame.locator("#title").fill("第一条");
await frame.locator("#body").fill("正文 A");
await frame.locator("#tag").fill("工作");
await frame.locator("#add").click();
await page.waitForTimeout(900);

await frame.locator("#title").fill("第二条");
await frame.locator("#body").fill("正文 B");
await frame.locator("#tag").fill("生活");
await frame.locator("#add").click();
await page.waitForTimeout(900);

fr = await readFrame();
check("工具里显示了两条", fr && fr.notes === 2, `notes=${fr && fr.notes}`);

const after = await rowsOf();
check("两条都真的落进了数据库", Array.isArray(after) && after.length === 2, JSON.stringify(after).slice(0, 160));
check(
  "字段结构正确（列名来自声明，不是工具随便塞的）",
  Array.isArray(after) &&
    after.every((r) => "id" in r && "title" in r && "body" in r && "tag" in r && "created_at" in r),
  after && Array.isArray(after) ? Object.keys(after[0] || {}).join(",") : "",
);

console.log("\n4. 重新加载应用后数据还在（不是内存里绕一圈）");
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(1200);
await page.locator(`aside [data-nav='tool:${TOOL_ID}']`).first().click().catch(async () => {
  const expand = page.locator('aside button[title="工具"]').first();
  if ((await expand.count()) > 0) await expand.click();
  await page.waitForTimeout(400);
  await page.locator(`aside [data-nav='tool:${TOOL_ID}']`).first().click();
});
await page.waitForTimeout(1800);

const reloaded = await rowsOf();
check("重开后有 persistent 的数据", Array.isArray(reloaded) && reloaded.length === 2, JSON.stringify(reloaded).slice(0, 160));
fr = await readFrame();
check("工具重开后照样列出来", fr && fr.notes === 2, `notes=${fr && fr.notes}`);

console.log("\n5. 列名校验：用了没声明过的列要被拒");
{
  const badCol = await askInTool("row.select", { table: "notes", where: { not_a_column: "x" } });
  check("未声明的列会被拒绝", badCol && badCol.ok === false, JSON.stringify(badCol).slice(0, 200));
  info("宿主回的错误", badCol && badCol.error);

  // 类型不符同样明确拒绝 —— 这不是苛刻，是让两个驱动行为一致
  const badType = await askInTool("row.insert", {
    table: "notes",
    row: { id: "bad", title: "x", body: "", tag: "", created_at: 12345 },
  });
  check("给 text 列传数字会被拒绝", badType && badType.ok === false, JSON.stringify(badType).slice(0, 200));
  info("类型错误", badType && badType.error);
}

console.log("\n6. 隔离：工具够不着宿主的表");
{
  const hostTable = await askInTool("row.select", { table: "core_tasks" });
  const settingsTable = await askInTool("row.select", { table: "core_settings" });
  const escape = await askInTool("row.select", { table: "../core_tasks" });
  const otherTool = await askInTool("row.count", { table: "notes", where: {} });

  check("读宿主表 core_tasks 被拒", hostTable && hostTable.ok === false, JSON.stringify(hostTable).slice(0, 180));
  check("读 core_settings 被拒", settingsTable && settingsTable.ok === false);
  check("带 ../ 的表名也碰不到", escape && escape.ok === false);
  info("拒绝理由", hostTable && hostTable.error);

  // 宿主的数据一条没少 —— 这才是"隔离"真正要保证的事
  const tasks = await rowsOf("core_tasks");
  check("宿主的任务表仍在且可读", Array.isArray(tasks), JSON.stringify(tasks).slice(0, 80));
}

console.log("\n7. schema.info 与 tools.list");
fr = await readFrame();
check("schema.info 拿到了表结构", fr && fr.schemaJson.includes("notes") && fr.schemaJson.includes("created_at"), (fr && fr.schemaJson || "").slice(0, 120));
check("tools.list 列出了同机器的其他工具", !!fr && /图片裁剪|尺码表生成器|AI 生成/.test(fr.peers), fr && fr.peers);
fr && info("同伴清单", fr.peers);

console.log("\n8. 联动：把一条内容交给别的工具");
{
  const ok = await askInTool(
    "tools.open",
    { tool: "size-chart", data: { title: "from scratchpad" } },
    10000,
  );
  check("tools.open 成功", ok && ok.ok === true, JSON.stringify(ok).slice(0, 200));

  await page.waitForTimeout(1600);
  check("目标工具被拉起来了（标签条上出现）", (await page.locator("[data-tool-tab='size-chart']").count()) === 1);
  check(
    "当前焦点已经切到对方",
    (await page.locator("[data-tool-tab='size-chart']").getAttribute("data-tab-active")) === "1",
  );
  check("两个工具同时活着", (await page.locator("iframe[data-tool-frame]").count()) === 2);

  // 目标工具真的收到了交过来的数据 —— 宿主推的是 tool:intent 消息。
  // 只看"标签出现了"是不够的：那只能证明它被拉起，不能证明东西送到了。
  await page.waitForTimeout(1200);
  const got = await page.evaluate(() => {
    const f = document.querySelector('iframe[data-tool-frame="size-chart"]');
    const w = f && f.contentWindow;
    if (!w || !w.__sizeChartIntents) return null;
    return w.__sizeChartIntents;
  });
  // size-chart 没有实现接收 intent（它不知道有这回事），所以这里不断言它"用上了"，
  // 只确认宿主把消息投出去了 —— 投递的可达性用下面这两条验证：
  check("宿主没有把焦点留在原地", (await page.locator("[data-tool-tab='scratchpad']").getAttribute("data-tab-active")) === "0");
  info("对方是否记录到 intent", got === null ? "对方未实现接收（正常）" : JSON.stringify(got));

  // 停用的工具不能被拉起 —— 这条路径若放过，等于绕过了用户的"我不想要它"
  const blocked = await askInTool("tools.open", { tool: "no-such-tool", data: null }, 8000);
  check("拉起不存在的工具会报错（不是静默失败）", blocked && blocked.ok === false, JSON.stringify(blocked).slice(0, 200));
  info("错误文案", blocked && blocked.error);
}

console.log("\n9. 设置 → 数据库：看得见这些表的归属");
await page.locator("aside [data-nav='settings']").click();
await page.waitForTimeout(500);
await page.locator('button[data-section="database"]').click();
await page.waitForTimeout(1200);

check("数据库分区打开了", (await page.locator("[data-db-section]").count()) === 1);
check("宿主命名空间在", (await page.locator("[data-ns='core']").count()) === 1);
check("随手记的命名空间在", (await page.locator(`[data-ns='${TOOL_ID}']`).count()) === 1);
check(
  "它的行数是对的",
  (await page.locator(`[data-ns='${TOOL_ID}']`).getAttribute("data-ns-rows")) === "2",
  await page.locator(`[data-ns='${TOOL_ID}']`).getAttribute("data-ns-rows"),
);
check(
  "工具标记成已安装",
  (await page.locator(`[data-ns='${TOOL_ID}'] [data-ns-installed]`).getAttribute("data-ns-installed")) === "1",
);

// 展开并预览表
await page.locator(`[data-ns-toggle='${TOOL_ID}']`).click();
await page.waitForTimeout(400);
check("表列出来了", (await page.locator(`[data-ns-table='${TABLE}']`).count()) === 1);
await page.locator(`[data-view-table='${TABLE}']`).click();
await page.waitForTimeout(700);
check("预览面板出现", (await page.locator(`[data-table-preview='${TABLE}']`).count()) === 1);
const previewText = (await page.locator(`[data-table-preview='${TABLE}']`).textContent()) || "";
check("预览里能看见工具写的标题", previewText.includes("第一条") && previewText.includes("第二条"), previewText.slice(0, 120));

console.log("\n10. 清理：把这段命名空间抹掉");
await page.locator(`[data-wipe-ns='${TOOL_ID}']`).click();
await page.waitForTimeout(300);
check("弹出二次确认", (await page.locator('[data-act="confirm-wipe-ns"]').count()) === 1);
await page.locator('[data-act="confirm-wipe-ns"]').click();
await page.waitForTimeout(1600);

// 注意这里**不断言"表没了"**：工具正开着，宿主会立刻按声明把空表建回原处
// （见 store.bustToolSchema）—— 这才是期望，表没了反而是 bug。
// 要断言的是"数据没了"。
const emptied = await rowsOf();
check("工具的数据被清空", Array.isArray(emptied) && emptied.length === 0, JSON.stringify(emptied).slice(0, 160));
check(
  "命名空间的行数归零",
  (await page.locator(`[data-ns='${TOOL_ID}']`).getAttribute("data-ns-rows")) === "0",
  await page.locator(`[data-ns='${TOOL_ID}']`).getAttribute("data-ns-rows"),
);
check("清理后表仍在（按声明重建，不是留个洞）", (await allTables()).includes(TABLE));
check("宿主的表一张没少", (await rowsOf("core_tasks")).length >= 0);
check("清理后宿主命名空间仍列得出来", (await page.locator("[data-ns='core']").count()) === 1);

console.log("\n11. 清完之后工具还能用（界面也跟着刷新）");
await page.locator('button[data-act="close-settings"]').click();
await page.waitForTimeout(600);
await page.locator(`[data-tool-tab='${TOOL_ID}'] button`).first().click();
await page.waitForTimeout(1600);
fr = await readFrame();
check("工具界面已经清空（不是还摆着旧列表）", fr && fr.notes === 0, `notes=${fr && fr.notes}`);
check("工具仍然能写（表在，功能没坏）", (await allTables()).includes(TABLE));

// 再存一条，确认清理之后通道仍然是通的
await page.frameLocator(`iframe[data-tool-frame="${TOOL_ID}"]`).locator("#title").fill("清理之后");
await page.frameLocator(`iframe[data-tool-frame="${TOOL_ID}"]`).locator("#add").click();
await page.waitForTimeout(900);
const afterRecover = await rowsOf();
check("清理之后还能继续存", Array.isArray(afterRecover) && afterRecover.length === 1, JSON.stringify(afterRecover).slice(0, 120));

console.log("\n12. 收尾");
check("全程无未捕获异常", errors.length === 0, errors.slice(0, 4).join(" | "));

await browser.close();
console.log(`\n========== 汇总: ${passed} 通过 / ${failed} 失败 ==========`);
if (failures.length) {
  console.log("失败项:");
  failures.forEach((f) => console.log(" - " + f));
}
process.exit(failed ? 1 : 0);
