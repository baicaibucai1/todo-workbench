/**
 * 数据库的只读体检。
 *
 * ------------------------------------------------------------------
 * 「各个数据库」到底是什么意思
 * ------------------------------------------------------------------
 * 工作台**只有一个数据库文件**。宿主的业务表（core_*）和每个工具的私有表
 * （tool_<id>_*）都住在同一个 SQLite 里 —— 分开的是**命名空间**，不是文件。
 *
 * 这个区分必须摆在界面上而不是留在注释里：用过别的插件体系的人会以为每个
 * 插件各有一个库文件，然后去找第二个文件、找不到就以为数据丢了。
 *
 * ------------------------------------------------------------------
 * 为什么列名是靠"看一行"推出来的，而不是查 PRAGMA
 * ------------------------------------------------------------------
 * 两个驱动能力不一样：SQLite 有 sqlite_master 与 PRAGMA table_info，
 * 浏览器的内存库只有一堆 Map 的键。这里一律走 `SELECT * LIMIT 1` 再取行对象的键
 * —— 两边都能给出一致的结果。空表推不出列名就显示"没有样品可看"，
 * 那也是诚实的结论，比去给 MemoryDb 补一套 PRAGMA 省事得多。
 */

import { db, dbInfo } from "./db";
import { toolPrefix } from "./tools";
import type { ToolManifest } from "../types";

/** 核心表的中文名。没登记的表直接显示表名 —— 显示错名字比不显示更糟 */
const CORE_TABLE_LABELS: Record<string, string> = {
  core_tasks: "待办任务",
  core_lists: "清单",
  core_steps: "任务子任务",
  core_task_links: "任务关联",
  core_settings: "偏好设置",
  core_work_orders: "流程任务",
  core_wo_flows: "流程模板",
  core_wo_stages: "流程过程态",
  core_wo_fields: "流程任务相关信息",
  core_wo_logs: "流转记录",
  core_wo_attachments: "流程任务附件",
  core_plan_items: "今日计划",
  core_gallery_items: "图库",
  core_tool_kv: "工具配置",
  core_tool_schema: "工具表版本台账",
};

export interface TableStat {
  /** 真实表名，如 core_tasks / tool_size_chart_drafts */
  name: string;
  /** 显示名。核心表翻译成中文，工具表保持原样 */
  label: string;
  rows: number;
  /** 列数。表是空的就推不出来，记 0 */
  columns: number;
}

export interface NamespaceStat {
  /**
   * 命名空间 id。宿主恒为 "core"，工具就是它的 tool id ——
   * 与表前缀一一对应（core_ / tool_<id>_）。
   */
  id: string;
  /** 显示名："宿主（核心）" 或工具名 */
  name: string;
  kind: "core" | "tool";
  /** 真实命名前缀 */
  prefix: string;
  /**
   * 这个工具**现在还装着吗**。
   *
   * 只对工具有意义。已经卸载的命名空间仍然列出来 —— 这正是用户
   * 「看各个数据库」想看到的：有哪些数据属于一个已经不在的工具。
   */
  installed: boolean;
  /**
   * 这段命名空间的归属能不能被确认。
   *
   * 绝大多数情况下能（要么工具还在，要么版本台账里留着它的 id）。
   * 不能的情况见 buildOrphan 的注释：前缀反推是有歧义的，
   * 拿不准就不给清理按钮 —— 宁可留着，不能删错别人的数据。
   */
  known: boolean;
  tables: TableStat[];
  /** 本命名空间的总行数 */
  rows: number;
}

export interface DbOverview {
  driver: "sqlite" | "memory";
  location: string;
  schemaVersion: number;
  tableCount: number;
  rowCount: number;
  namespaces: NamespaceStat[];
}

interface NsInput {
  id: string;
  name: string;
  kind: "core" | "tool";
  prefix: string;
  installed: boolean;
  known: boolean;
  tables: string[];
}

/**
 * 一次扫出全部命名空间与它们的表。
 *
 * 逐表 COUNT 看着笨，但这是**体检**不是热路径：只在打开设置页时跑一次，
 * 而且行数本来就是一个不该被缓存的数字（缓存了反而会撒谎）。
 */
export async function inspectDatabases(tools: ToolManifest[]): Promise<DbOverview> {
  const info = dbInfo();
  const all = await db().tableNames();

  const namespaces: NamespaceStat[] = [];

  const countNs = async (opts: NsInput): Promise<NamespaceStat> => {
    const tables: TableStat[] = [];
    for (const name of opts.tables) {
      const counted = await db().select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
      // 取一行只为数列名个数。空表推不出就记 0 —— 界面上显示"0 列"比显示"—"更省事，
      // 反正表里没有样品时用户也不会点开看
      const sample = await db().select<Record<string, unknown>>(`SELECT * FROM ${name} LIMIT 1`);
      tables.push({
        name,
        label: opts.kind === "core" ? (CORE_TABLE_LABELS[name] ?? name) : name,
        rows: Number(counted[0]?.n ?? 0),
        columns: sample.length ? Object.keys(sample[0]).length : 0,
      });
    }
    return {
      id: opts.id,
      name: opts.name,
      kind: opts.kind,
      prefix: opts.prefix,
      installed: opts.installed,
      known: opts.known,
      tables,
      rows: tables.reduce((a, t) => a + t.rows, 0),
    };
  };

  // 1. 宿主命名空间
  namespaces.push(
    await countNs({
      id: "core",
      name: "宿主（核心）",
      kind: "core",
      prefix: "core_",
      installed: true,
      known: true,
      tables: all.filter((n) => n.startsWith("core_")),
    }),
  );

  // 2. 每个已安装工具的命名空间。**没表的工具也要列**：
  //    "这个工具用没用表"这件事，答案"一张没有"同样是有用的信息。
  const seen = new Set<string>(["core"]);
  for (const t of tools) {
    const prefix = safePrefix(t.id);
    if (!prefix) continue;
    seen.add(t.id);
    namespaces.push(
      await countNs({
        id: t.id,
        name: t.name,
        kind: "tool",
        prefix,
        installed: true,
        known: true,
        tables: all.filter((n) => n.startsWith(prefix)),
      }),
    );
  }

  // 3. 已经卸载、但数据还在的命名空间。
  //
  //    tool id 从**版本台账**里取，而不是从表名反推 —— 表名 `tool_a_b_c`
  //    可能是 id=`a-b` 表=`c`，也可能是 id=`a` 表=`b_c`，反推有歧义，
  //    用它去驱动"清理"会把另一个工具的表一起删掉。
  //    台账（core_tool_schema）里的 id 是宿主当初自己写进去的，没有这种问题。
  const ledger = await db().select<{ tool_id: string }>(`SELECT tool_id FROM core_tool_schema`);
  for (const row of ledger) {
    const id = row.tool_id;
    if (seen.has(id)) continue;
    seen.add(id);
    const prefix = safePrefix(id);
    if (!prefix) continue;
    namespaces.push(
      await countNs({
        id,
        name: id,
        kind: "tool",
        prefix,
        installed: false,
        known: true,
        tables: all.filter((n) => n.startsWith(prefix)),
      }),
    );
  }

  // 4. 台账里也查不到的遗留表（工具在 v10 之前建的，或者被人手改过库）。
  //    列出来是为了"没有看不见的数据"，但不给清理按钮。
  for (const name of all) {
    const m = /^tool_(.+?)_/.exec(name);
    if (!m) continue;
    const guess = m[1];
    if ([...seen].some((id) => safePrefix(id) === `tool_${guess}_`)) continue;
    // 归属不明 -> 只展示，不提供任何操作
    const prefix = `tool_${guess}_`;
    namespaces.push(
      await countNs({
        id: `unknown:${guess}`,
        name: `归属不明（tool_${guess}_）`,
        kind: "tool",
        prefix,
        installed: false,
        known: false,
        tables: all.filter((n) => n.startsWith(prefix)),
      }),
    );
  }

  return {
    driver: info.driver,
    location: info.location,
    schemaVersion: info.schemaVersion,
    tableCount: all.length,
    rowCount: namespaces.reduce((a, n) => a + n.rows, 0),
    namespaces,
  };
}

/**
 * 预览一张表的内容。
 *
 * 表名必须在库里真实存在才受理 —— 这里是**唯一**一处把外部名字拼进 SQL 的地方，
 * 虽然调用方就是设置页自己，但把它做成白名单是个值得养成的习惯：
 * 下次谁从别处传个名字进来，也不会因此开出一道口子。
 */
export async function inspectTable(
  name: string,
  limit = 50,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; total: number }> {
  const all = await db().tableNames();
  if (!all.includes(name)) throw new Error(`库里没有「${name}」这张表`);

  const capped = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = await db().select<Record<string, unknown>>(`SELECT * FROM ${name} LIMIT ${capped}`);
  const counted = await db().select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
  return {
    columns: rows.length ? Object.keys(rows[0]) : [],
    rows,
    total: Number(counted[0]?.n ?? 0),
  };
}

/**
 * 工具 id -> 表前缀。id 非法时返回 null。
 *
 * 前缀只能从 tools.toolPrefix 拿。**不能**靠"往拼表名的那个函数里塞一个空表名"
 * 去凑：它那条**表名**正则要求首字符是字母，空表名会被判非法而抛错 ——
 * 前缀就永远取不到，于是每个工具都会掉进"归属不明"那一档。
 * 现象（设置页里所有工具都标成 unknown）离原因非常远，踩过一次。
 */
function safePrefix(toolId: string): string | null {
  try {
    return toolPrefix(toolId);
  } catch {
    return null;
  }
}
