/**
 * 工具私有表的建iku与回收。
 *
 * ------------------------------------------------------------------
 * 为什么由宿主建表，而不是让工具自己发 CREATE TABLE
 * ------------------------------------------------------------------
 * 工具桥是 postMessage 通道，工具说什么都得过宿主这一道。若把 DDL 也开出去，
 * 宿主就得**逐字解析工具的 SQL** 才能确信它没在建 `core_tasks2` 或者给
 * core_settings 加一列 —— 那等于把整个字符串解析的安全性押在自己写的正则上。
 *
 * 声明式没这个包袱：工具交一张"我要什么表、每列什么类型"的清单上来，
 * 宿主逐项校验后再自己拼 SQL。**表名与列名全部来自宿主拼出来的东西**，
 * 工具传的值只可能出现在 `?` 占位符里。
 *
 * ------------------------------------------------------------------
 * 记版本为什么不退 FOREIGN KEY 那套
 * ------------------------------------------------------------------
 * 工具表之间没有引用关系（工具的私有库是自己的，跨工具引用应该走
 * 「图库 / 工具联动」两条明路），所以不需要外键。真正需要的是
 * **"宿主上一次为这个工具建到哪个版本"** —— 记在 core_tool_schema 里。
 * 没有它，工具作者改了表结构之后宿主要么每回重跑 DDL，要么永远看不出版本变了。
 *
 * ------------------------------------------------------------------
 * 卸载工具时的数据
 * ------------------------------------------------------------------
 * 默认**保留**（dropToolNamespace 只在用户亲手点"清理"时才调用）：
 * 卸载是"我不用了"，不是"把历史抹掉"。装回来还能接着看，
 * 这也是设置页「数据库」分区要把"已卸载但仍占着表"的工具单独标出来的原因。
 */

import { db } from "./db";
import { toolPrefix, toolTable } from "./tools";
import type { ToolColumn, ToolSchema, ToolTableDef } from "../types";

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

/**
 * 列名 / 裸表名的字符集。
 * 与 toolTable() 的表名约束同源（它是 ^[a-z][a-z0-9_]{0,47}$）：
 * 只允许小写字母、数字、下划线，且必须以字母开头。
 *
 * 为什么这么窄：这些名字会**直接拼进 SQL 字符串**。
 * 参数化的值可以任意，标识符不行 —— 一旦放宽到允许空格或分号，
 * `SELECT ... WHERE <col> = ?` 就有被拼成另一条语句的余地。
 */
const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;

/** 一个工具最多声明多少张表 / 一张表最多多少列。防止一份畸形清单撑爆宿主 */
const MAX_TABLES = 12;
const MAX_COLUMNS = 40;
const MAX_INDEXES = 8;

export interface ValidatedTable extends ToolTableDef {
  /** 校验通过后的主键列名。一定存在 —— 没主键的表做不了 update/delete */
  pkColumn: string;
  /** 宿主拼出的完整表名，如 tool_image_crop_records */
  fullName: string;
}

/**
 * 校验工具声明的 schema。
 *
 * 返回 null 表示整份作废 —— **不做部分采纳**。理由：一半生效一半报错的工具
 * 最难排查（"第二张表为什么没有"，而 manifest 看着是对的）；
 * 全部退回"这个工具没有私有表"至少是一个明确、可见的状态。
 */
export function validateToolSchema(
  toolId: string,
  raw: unknown,
): ToolSchema | null {
  if (!raw || typeof raw !== "object") return null;
  const maybe = raw as { tables?: unknown };
  if (!Array.isArray(maybe.tables)) return null;

  const tables: ToolTableDef[] = [];
  const seen = new Set<string>();

  for (const t of maybe.tables.slice(0, MAX_TABLES)) {
    if (!t || typeof t !== "object") return null;
    const td = t as {
      name?: unknown;
      columns?: unknown;
      indexes?: unknown;
    };

    if (typeof td.name !== "string" || !NAME_RE.test(td.name)) return null;
    if (seen.has(td.name)) return null; // 同名表：后面的会悄悄覆盖前面的
    seen.add(td.name);

    if (!Array.isArray(td.columns) || td.columns.length === 0) return null;
    if (td.columns.length > MAX_COLUMNS) return null;

    const columns: ToolColumn[] = [];
    const colSeen = new Set<string>();
    let pkCount = 0;

    for (const c of td.columns) {
      if (!c || typeof c !== "object") return null;
      const cd = c as Record<string, unknown>;

      const name = cd.name;
      if (typeof name !== "string" || !NAME_RE.test(name)) return null;
      if (colSeen.has(name)) return null;
      colSeen.add(name);

      const type = cd.type;
      if (type !== "text" && type !== "integer" && type !== "real") return null;

      const pk = cd.pk === true;
      if (pk) pkCount++;
      // 结构化 CRUD 按主键定位一行，没有主键就没法实现 update/delete
      if (pkCount > 1) return null;

      const col: ToolColumn = { name, type };
      if (pk) col.pk = true;
      if (cd.notNull === true) col.notNull = true;

      const dflt = cd.default;
      if (dflt !== undefined && dflt !== null) {
        // 默认值按其类型收窄：给 integer 列塞字符串，SQLite 会静默存进去、
        // 之后按数字比较就全是错的，而这里拒绝只是多一句"不合法"。
        if (type === "integer" || type === "real") {
          if (typeof dflt !== "number" || !Number.isFinite(dflt)) return null;
        } else if (typeof dflt !== "string") {
          return null;
        }
        col.default = dflt;
      }
      columns.push(col);
    }

    if (pkCount !== 1) return null;

    const table: ToolTableDef = { name: td.name, columns };

    if (td.indexes !== undefined) {
      if (!Array.isArray(td.indexes) || td.indexes.length > MAX_INDEXES) return null;
      const indexes = [];
      const colSet = new Set(columns.map((c) => c.name));
      for (const ix of td.indexes) {
        if (!ix || typeof ix !== "object") return null;
        const ixd = ix as { columns?: unknown; unique?: unknown };
        if (
          !Array.isArray(ixd.columns) ||
          ixd.columns.length === 0 ||
          ixd.columns.length > 4
        ) {
          return null;
        }
        // 索引列必须是本表已声明的列 —— 否则能借索引名把别的列名带进 SQL
        for (const c of ixd.columns) {
          if (typeof c !== "string" || !colSet.has(c)) return null;
        }
        indexes.push({
          columns: ixd.columns as string[],
          ...(ixd.unique === true ? { unique: true } : {}),
        });
      }
      table.indexes = indexes;
    }

    tables.push(table);
  }

  if (tables.length === 0) return null;

  // 提前把表名拼一遍，工具 id 非法（或拼出的表名重复）在这儿就炸，
  // 而不是等到 CREATE 时被 SQLite 拒 —— 那种失败会和"表真的坏了"混在一起
  for (const t of tables) {
    try {
      toolTable(toolId, t.name);
    } catch {
      return null;
    }
  }

  return { tables };
}

/** 把 VALUES 里的默认值转成 SQL 字面量。**只接受已校验收窄过的类型** */
function sqlLiteral(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/** 拼一列的定义。名字与类型都来自刚过校验的清单，值只有 DEFAULT 走到这里 */
function columnDdl(col: ToolColumn): string {
  const parts: string[] = [col.name, col.type.toUpperCase()];
  if (col.pk) parts.push("PRIMARY KEY");
  else if (col.notNull) parts.push("NOT NULL");
  // 主键自带 NOT NULL，不必重复写（写了 SQLite 也接受，但两处的语义容易看岔）
  if (col.default !== undefined) parts.push(`DEFAULT ${sqlLiteral(col.default)}`);
  return parts.join(" ");
}

/**
 * 按工具的 schema 声明建表。
 *
 * 幂等且**按版本跳过**：台账里记着的版本与 manifest.dbVersion 一致时直接返回，
 * 连 DDL 都不发。省一次往返是小事，关键是避免"每次挂载都重跑 DDL"这种
 * 看起来无害、实则掩盖版本漂移的写法。
 *
 * @param version manifest.dbVersion
 */
export async function ensureToolSchema(
  toolId: string,
  version: number,
  schema: ToolSchema,
): Promise<{ applied: boolean; tables: ValidatedTable[] }> {
  const validated = buildValidatedTables(toolId, schema);
  if (validated.length === 0) return { applied: false, tables: [] };

  const ledger = await schemaVersionOf(toolId);
  if (ledger === version) return { applied: false, tables: validated };

  // 一次发过去，而不是一张表一趟 IPC：桌面端每趟都要往 Rust 跑一圈，
  // 而 DDL 本来就是原子的准备动作，中途失败下一次挂载会重新来过。
  const script = validated.map(createTableSql).join(";\n");
  await db().execute(script);

  // 台账更新用「先查后写」而不是 INSERT OR REPLACE：
  // 内存库的 mini-SQL 不认 upsert 语法，两个驱动得共用同一段 SQL
  // （core_tool_kv 的 kv.set 也是这个处理，理由一致）。
  const now = new Date().toISOString();
  if (ledger === null) {
    await db().execute(
      `INSERT INTO core_tool_schema (tool_id, version, applied_at) VALUES (?, ?, ?)`,
      [toolId, version, now],
    );
  } else {
    await db().execute(
      `UPDATE core_tool_schema SET version = ?, applied_at = ? WHERE tool_id = ?`,
      [version, now, toolId],
    );
  }

  return { applied: true, tables: validated };
}

/** 造带完整表名与主键的实现用结构（validator 通过之后才能调） */
export function buildValidatedTables(
  toolId: string,
  schema: ToolSchema,
): ValidatedTable[] {
  return schema.tables.map((t) => ({
    ...t,
    pkColumn: t.columns.find((c) => c.pk)!.name,
    fullName: toolTable(toolId, t.name),
  }));
}

function createTableSql(t: ValidatedTable): string {
  const cols = t.columns.map(columnDdl).join(", ");
  const head = `CREATE TABLE IF NOT EXISTS ${t.fullName} (${cols})`;
  const idx = (t.indexes ?? []).map((ix, i) => {
    const name = `idx_${t.fullName}_${i}`;
    return `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name} ON ${t.fullName} (${ix.columns.join(", ")})`;
  });
  return [head, ...idx].join(";\n");
}

/** 台账里记的版本；从没建过返回 null */
export async function schemaVersionOf(toolId: string): Promise<number | null> {
  const rows = await db().select<{ version: number }>(
    `SELECT version FROM core_tool_schema WHERE tool_id = ?`,
    [toolId],
  );
  return rows.length ? Number(rows[0].version) : null;
}

/* ------------------------------------------------------------------ */
/* 回收                                                                */
/* ------------------------------------------------------------------ */

/**
 * 清空某个工具在数据库里的全部痕迹：私有表、配置 KV、schema 台账。
 *
 * **只在用户亲手点"清理"时调用**，卸载工具不碰它（理由见文件头）。
 *
 * 返回清掉了哪些东西，用于界面提示 —— "删了 3 张表共 128 行"比
 * "已清理"有用得多，后者让人怀疑到底做没做。
 */
export async function dropToolNamespace(
  toolId: string,
): Promise<{ tables: string[]; rows: number; kvRows: number }> {
  // 与建表时用的是同一个前缀函数（tools.toolPrefix）—— 各拼一遍迟早漂移，
  // 而漂移的后果是"清理时删错了命名空间"
  let prefix = "";
  try {
    prefix = toolPrefix(toolId);
  } catch {
    throw new Error(`非法的工具 id: ${toolId}`);
  }

  const all = await db().tableNames();
  const mine = all.filter((n) => n.startsWith(prefix));

  let rows = 0;
  for (const name of mine) {
    const counted = await db().select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${name}`,
    );
    rows += Number(counted[0]?.n ?? 0);
    await db().execute(`DROP TABLE IF EXISTS ${name}`);
  }

  const kv = await db().select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM core_tool_kv WHERE tool_id = ?`,
    [toolId],
  );
  const kvRows = Number(kv[0]?.n ?? 0);
  await db().execute(`DELETE FROM core_tool_kv WHERE tool_id = ?`, [toolId]);

  // 台账一并删掉：下次重装这个工具要按"从没建过"重跑一遍 DDL，
  // 留着旧版本号会让它以为表还在（而表已经被删了）。
  await db().execute(`DELETE FROM core_tool_schema WHERE tool_id = ?`, [toolId]);

  return { tables: mine, rows, kvRows };
}
