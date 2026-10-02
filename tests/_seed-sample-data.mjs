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
 * 用法：
 *   import { prepareFreshWithSampleData } from "./_seed-sample-data.mjs";
 *   await prepareFreshWithSampleData(page);
 */

export const DEMO_KEY = "todo-workbench:demo-db";

/** 示例数据开关在 core_settings 里的键（与 SETTINGS.seedSampleData 一致） */
export const SAMPLE_KEY = "behavior.seedSampleData";

/**
 * 把浏览器演示库重置成「空库 + 示例数据开关打开」，然后重新加载。
 *
 * @param page  playwright 的 page（必须已经 launch，不必先 goto）
 * @returns     实际做了什么的说明，便于套件在日志里打出来
 */
export async function prepareFreshWithSampleData(page) {
  const base = new URL(page.url() === "about:blank" ? "http://localhost:1420/" : page.url());

  // ① 跑一轮，让表建起来、默认配置写进去
  await page.goto(base.href, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

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

  // ③ 重新加载：这一轮 seedIfEmpty 会看到"开关开 + 库空"
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  return result;
}
