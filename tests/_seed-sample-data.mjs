/**
 * e2e 里把库准备成「新装机器 + 示例数据开关打开」的样子。
 *
 * ------------------------------------------------------------------
 * 为什么要有这个文件
 * ------------------------------------------------------------------
 * v20 起示例数据是**选装、默认关**（见 SETTINGS.seedSampleData 的注释）：
 * 新建的库打开就是干干净净，一个清单都没有。于是所有"进来就假设有
 * 两个清单、六条待办"的套件，开局都会红在 `sidebarText.includes("工作")`
 * 上 —— 看上去像功能炸了，其实只是没人去按那个开关。
 *
 * 这里**刻意和 _enable-module.mjs 走相反的路**：那个走真实界面，因为它验的
 * 就是"设置页里找得到这个开关"；而这里要的是**回到"刚装好"的数据状态**，
 * 界面点不点得到不是重点，重点是库得是空的再加开关打开。
 * 所以直接改 MemoryDb 的快照，比在界面上又点开关又删数据快得多，
 * 也稳得多（删数据那几步本身就可能被别的用例影响）。
 *
 * ------------------------------------------------------------------
 * 两步走，别想一步
 * ------------------------------------------------------------------
 * MemoryDb 的快照（localStorage 的 `todo-workbench:demo-db`）里，
 * settings 就是 core_settings 表的一行行记录。但**第一次打开页面之前
 * 那个键根本不存在** —— 没有表可以改。
 *
 * 所以必须：
 *   ① 先 goto 一轮，让应用建表 + 迁移 + 写入默认配置；
 *   ② 这时快照里才有 core_settings，把开关那行改成 "1"、其余表清空；
 *   ③ reload —— 新一轮启动时 seedIfEmpty 读到"开 + 空库"，把示例种进去。
 *
 * ------------------------------------------------------------------
 * ★ 源必须和套件一致：localhost 与 127.0.0.1 是**两个源**
 * ------------------------------------------------------------------
 * localStorage 按源隔离，而 `http://localhost:1420/` 与
 * `http://127.0.0.1:1420/` 在 Chromium 里是**两个不同的源**（主机名不同）。
 * 两者都通得到同一个 dev server，所以"都能打开"这件事完全不说明它们共用数据。
 *
 * 这个文件曾经硬编码 `http://localhost:1420/` 作为基准地址，于是套件若用
 * `--url http://127.0.0.1:1420/` 跑，示例数据就被种到了**另一个源**上，
 * 套件在它自己那个源里看到的仍是一个刚建好的空库 —— 第 1 节那 4 项
 * （今日任务 / 每日任务 / 每日标记 / 归到每日任务一节）全红，
 * 而报错文字指向的是"种子里没有每日任务"，把人带去翻种子逻辑。
 * 实测：同一份代码不带 `--url` 跑 30/30 通过，带 `--url http://127.0.0.1:1420/`
 * 跑必然 26/4 —— 确定性复现，跟代码改动无关。
 *
 * 现在基准地址按套件同一套规则解析：`--url` 参数 → 页面当前地址 → 默认 localhost。
 * 并且最后一步会**自检**，种不上就抛错并写明用的哪个源，不再让这种问题
 * 伪装成业务断言失败。
 *
 * ------------------------------------------------------------------
 * 直改 localStorage 还有一个次要点：会被应用整块回写覆盖
 * ------------------------------------------------------------------
 * 第 ② 步是绕过应用改的快照，应用内存里的 MemoryDb 并不知道；它每次
 * execute / transaction 都会把**自己内存里的全部表**整块写回。所以这里
 * 先等 `aside` 出现（它只在 init() 完成、迁移全跑完后才渲染），再等快照
 * 停止变化若干毫秒，最后 reload 后核对一遍 —— 把"改动被启动期那串
 * 迁移落盘冲掉"的窗口收掉。
 *
 * 用法：
 *   import { prepareFreshWithSampleData } from "./_seed-sample-data.mjs";
 *   await prepareFreshWithSampleData(page);
 *   // 若套件的地址不是默认那个：
 *   await prepareFreshWithSampleData(page, { url: BASE });
 */

export const DEMO_KEY = "todo-workbench:demo-db";

/** 示例数据开关在 core_settings 里的键（与 SETTINGS.seedSampleData 一致） */
export const SAMPLE_KEY = "behavior.seedSampleData";

/** 与各套件相同的一套地址解析：`--url` 参数 → 页面当前地址 → 默认 */
function resolveBase(page, explicit) {
  if (explicit) return new URL(explicit);
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--url");
  if (i !== -1 && argv[i + 1]) return new URL(argv[i + 1]);
  const cur = page.url();
  if (cur && cur !== "about:blank") return new URL(cur);
  return new URL("http://localhost:1420/");
}

/** 等快照停止变化：应用启动期的迁移是"每迁移一版就整块落盘"的一串写入 */
async function waitSnapshotSettle(page, key, quietMs = 500, timeoutMs = 8000) {
  const started = Date.now();
  let last = null;
  let quietSince = Date.now();
  for (;;) {
    const cur = await page.evaluate((k) => localStorage.getItem(k), key);
    if (cur !== last) {
      last = cur;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return true;
    }
    if (Date.now() - started > timeoutMs) return false;
    await page.waitForTimeout(100);
  }
}

/** 读回"该看的两件事"：开关还在不在、清单有没有种上 */
function readOutcome(page) {
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    if (!raw) return { 快照: "无" };
    let snap;
    try {
      snap = JSON.parse(raw);
    } catch {
      return { 快照: "解析失败" };
    }
    const rows = (n) => (snap.tables.find((t) => t[0] === n) || [null, []])[1];
    const on = rows("core_settings").find((r) => r.key === "behavior.seedSampleData");
    return {
      开关: on ? String(on.value) : "没有这一行",
      清单数: rows("core_lists").length,
      任务数: rows("core_tasks").length,
    };
  }, DEMO_KEY);
}

/**
 * 把浏览器演示库重置成「空库 + 示例数据开关打开」，然后重新加载。
 *
 * @param page      playwright 的 page（必须已经 launch，不必先 goto）
 * @param url       套件用的地址；不传则按 `--url` 参数 / 页面当前地址推。
 *                  ⚠️ 必须与套件后面导航用的地址**同源**，否则 localStorage 不通行
 * @param attempts  自检不通过时的重试次数（默认 3：偶发的竞态重来一般就中）
 * @returns         实际做了什么的说明，便于套件在日志里打出来
 * @throws          重试后仍未种上时抛错 —— 夹具没准备好，后面的断言都不可信
 */
export async function prepareFreshWithSampleData(page, { url, attempts = 3 } = {}) {
  const base = resolveBase(page, url);
  let outcome = { 快照: "未开始" };
  let lastResult = "";

  for (let i = 1; i <= attempts; i++) {
    // ① 跑一轮，等应用**真正启动完**（aside 只在 init() 完成后才渲染）
    await page.goto(base.href, { waitUntil: "networkidle" });
    await page.waitForSelector("aside", { timeout: 20000 });
    await waitSnapshotSettle(page, DEMO_KEY);

    // ② 改快照
    const result = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return "no-snapshot";
      const snap = JSON.parse(raw);
      const settings = snap.tables.find((t) => t[0] === "core_settings");
      if (!settings) return "no-settings-table";

      const row = settings[1].find((r) => r.key === "behavior.seedSampleData");
      if (row) row.value = "1";
      else settings[1].push({ key: "behavior.seedSampleData", value: "1" });

      // 清空**除配置表之外**的所有表。
      //
      // 刻意不列白名单（"要清 core_lists、core_tasks……"）：那样每加一张表
      // 就要回来补一笔，漏掉的表现是"示例数据没种上"（isEmpty 判据看到了残留），
      // 而报错会指向种子逻辑，排查要绕很远。反过来写就一劳永逸。
      //
      // 用户资料存在 core_settings 里，所以它会被保留 ——
      // 依赖「资料区显示邮箱/未设置占位」的断言仍然成立。
      for (const t of snap.tables) {
        if (t[0] !== "core_settings") t[1] = [];
      }
      localStorage.setItem(key, JSON.stringify(snap));
      return "ok";
    }, DEMO_KEY);

    lastResult = result;
    if (result !== "ok") {
      // 快照还没建起来（页面太慢或地址不对）——重试比立刻抛错更有用
      if (i < attempts) continue;
      break;
    }

    // ③ 重新加载：这一轮 seedIfEmpty 会看到"开关开 + 空库"
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("aside", { timeout: 20000 });
    await page.waitForTimeout(300);

    // ④ 自检：改进去的东西还在吗、示例真的种上了吗
    outcome = await readOutcome(page);
    if (outcome.开关 === "1" && outcome.清单数 > 0) {
      return i === 1 ? "ok" : `ok（第 ${i} 次才种上）`;
    }
  }

  throw new Error(
    `示例数据没能准备好（返回 ${lastResult || "—"}，最后看到的现场 ${JSON.stringify(outcome)}）。` +
      `基准地址：${base.href}。` +
      `常见原因：套件导航用的地址与本夹具不同源（localhost:1420 与 127.0.0.1:1420 是**两个源**，` +
      `localStorage 各存一份），或页面启动太慢。`,
  );
}
