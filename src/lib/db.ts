/**
 * 数据库访问层。
 *
 * 这里刻意做了两层抽象，原因是：
 * - Tauri 环境下用真实 SQLite（tauri-plugin-sql）
 * - 浏览器 demo 环境下用 localStorage 持久化的内存库
 *
 * 上层业务代码只依赖 Db 接口，不关心底层是哪种实现。
 * 这样「先跑 demo 验证产品形态」和「打包成桌面应用」用的是同一份业务代码。
 */

import { invoke } from "@tauri-apps/api/core";

import { migrations, CURRENT_SCHEMA_VERSION } from "./migrations";

export type Param = string | number | null;

export interface Db {
  select<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  execute(sql: string, params?: Param[]): Promise<void>;
  /** 在事务中执行一批语句，任一步失败则整体回滚 */
  transaction(statements: Array<{ sql: string; params?: Param[] }>): Promise<void>;
  /**
   * 列出库里所有用户表名。
   *
   * 存在的理由是设置页的「数据库」分区：一个库文件里住着宿主的 core_*
   * 和各工具的 tool_<id>_*，"有哪些命名空间"只能问数据库自己。
   * 两个驱动的实现方式完全不同（SQLite 有 sqlite_master，内存库只有 Map 的键），
   * 所以把它放进接口，而不是让上层各自去猜。
   */
  tableNames(): Promise<string[]>;
}

/** 供 UI 展示数据库当前状态 */
export interface DbInfo {
  driver: "sqlite" | "memory";
  /** 数据库文件路径或 localStorage 键名 */
  location: string;
  schemaVersion: number;
}

/* ------------------------------------------------------------------ */
/* 实现一：内存库（浏览器 demo 用），快照持久化到 localStorage            */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

interface TableDef {
  name: string;
  rows: Row[];
}

const STORAGE_KEY = "todo-workbench:demo-db";

/**
 * 一个够用的 SQL 子集解释器。
 * 只支持本项目实际用到的语句形态，目的是让 demo 跑通，不是通用数据库。
 */
class MemoryDb implements Db {
  private tables = new Map<string, TableDef>();
  private version = 0;

  constructor() {
    this.restore();
  }

  private restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const snap = JSON.parse(raw) as {
        version: number;
        tables: Array<[string, Row[]]>;
      };
      this.version = snap.version ?? 0;
      for (const [name, rows] of snap.tables ?? []) {
        this.tables.set(name, { name, rows });
      }
    } catch {
      /* 快照损坏则从空库开始，不阻塞启动 */
    }
  }

  private persist() {
    try {
      const tables: Array<[string, Row[]]> = [];
      for (const [name, t] of this.tables) tables.push([name, t.rows]);
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: this.version, tables }),
      );
    } catch {
      /* 超配额时忽略，内存态仍然可用 */
    }
  }

  private table(name: string): TableDef {
    let t = this.tables.get(name);
    if (!t) {
      t = { name, rows: [] };
      this.tables.set(name, t);
    }
    return t;
  }

  /** 执行 DDL / DML，返回受影响行数 */
  private run(sql: string, params: Param[] = []): number {
    const s = sql.trim().replace(/;$/, "");

    // CREATE TABLE
    const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s);
    if (create) {
      this.table(create[1]);
      return 0;
    }

    // DROP TABLE —— 必须真删，不能"认了这条语句但什么都不做"。
    //
    // 不加这个分支时，DROP 会落到函数末尾的 `return 0`（看起来执行成功），
    // 后果是"设置 → 数据库 → 清理"在浏览器 demo 里点了没反应，
    // 而界面还提示"已清理 N 张表" —— 一个谎报成功的动作，比报错难查得多。
    // 工具的私有表被清理、按声明重建都靠它，不是边角功能。
    const drop = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i.exec(s);
    if (drop) {
      this.tables.delete(drop[1]);
      return 0;
    }

    // CREATE INDEX —— 内存库不需要索引
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(s)) return 0;
    if (/^PRAGMA/i.test(s)) return 0;

    // INSERT
    const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(s);
    if (insert) {
      const [, tableName, colsRaw, valsRaw] = insert;
      const cols = colsRaw.split(",").map((c) => c.trim());
      const vals = valsRaw.split(",").map((v) => v.trim());
      let pi = 0;
      const row: Row = {};
      cols.forEach((col, i) => {
        row[col] = vals[i] === "?" ? (params[pi++] ?? null) : this.literal(vals[i]);
      });
      this.table(tableName).rows.push(row);
      return 1;
    }

    // UPDATE ... SET ... WHERE ...
    const update = /^UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is.exec(s);
    if (update) {
      const [, tableName, setRaw, whereRaw] = update;
      const assigns: Array<[string, string]> = parseAssignments(setRaw);

      // 参数顺序与 SQL 中的 ? 出现顺序一致：先 SET 再 WHERE。
      // 所以 SET 里的 ? 从 0 开始消耗，WHERE 从 SET 消耗完的位置继续。
      const setParamCount = assigns.filter(([, v]) => v === "?").length;
      const whereBase = setParamCount;

      const target = this.table(tableName);
      let n = 0;
      for (const row of target.rows) {
        if (whereRaw && !this.match(row, whereRaw, params, whereBase)) continue;

        let pi = 0;
        for (const [col, valExpr] of assigns) {
          row[col] = valExpr === "?" ? (params[pi++] ?? null) : this.literal(valExpr);
        }
        n++;
      }
      return n;
    }

    // DELETE FROM
    const del = /^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is.exec(s);
    if (del) {
      const [, tableName, whereRaw] = del;
      const target = this.table(tableName);
      const before = target.rows.length;
      target.rows = whereRaw
        ? target.rows.filter((r) => !this.match(r, whereRaw, params))
        : [];
      return before - target.rows.length;
    }

    return 0;
  }

  /** 把 SQL 字面量转成 JS 值 */
  private literal(token: string): unknown {
    const t = token.trim();
    if (/^NULL$/i.test(t)) return null;
    if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'");
    const n = Number(t);
    if (!Number.isNaN(n) && t !== "") return n;
    return t;
  }

  /**
   * WHERE 求值入口。
   *
   * 先按顶层 OR 拆分支，任一分支成立即成立；没有 OR 时整体按 AND 处理。
   * 这样 `(a = 1 OR b = 2)` 这类分组条件才能被正确求值
   * （`我的一天` 的筛选就依赖它）。
   *
   * @param base 本条件在整体参数数组中的起始偏移。
   *   UPDATE 语句里 SET 子句会先消耗掉若干参数，WHERE 必须从它之后开始取，
   *   否则会读到属于 SET 的参数，导致更新条件错乱。
   */
  private match(row: Row, whereRaw: string, params: Param[], base = 0): boolean {
    const s = stripOuterParens(whereRaw);
    const ors = splitTopLevelBy(s, "OR");

    if (ors.length > 1) {
      let offset = base;
      for (const branch of ors) {
        if (this.matchAnd(row, branch, params, offset)) return true;
        // 分支没命中也要跳过它占掉的占位符，后面的分支才取得到正确的参数
        offset += countPlaceholders(branch);
      }
      return false;
    }

    return this.matchAnd(row, s, params, base);
  }

  /**
   * 极简 AND 求值。
   *
   * 支持：col op ? / col op 字面量、col IS NULL / IS NOT NULL、col LIKE ?。
   */
  private matchAnd(row: Row, whereRaw: string, params: Param[], base = 0): boolean {
    let pi = base;
    const conds = splitAnd(whereRaw);
    for (const cond of conds) {
      const inner = stripOuterParens(cond);

      // 单个条件内部也可能是 OR 分组，如 (my_day = 1 OR due_date = ?)，
      // 递归回 match 处理；参数按整组占位符数推进，后面的条件才取得对。
      if (splitTopLevelBy(inner, "OR").length > 1) {
        if (!this.match(row, inner, params, pi)) return false;
        pi += countPlaceholders(inner);
        continue;
      }

      const c = inner.replace(/^\(+|\)+$/g, "").trim();

      const isNull = /^(\w+)\s+IS\s+NULL$/i.exec(c);
      if (isNull) {
        if (row[isNull[1]] !== null && row[isNull[1]] !== undefined) return false;
        continue;
      }
      const notNull = /^(\w+)\s+IS\s+NOT\s+NULL$/i.exec(c);
      if (notNull) {
        if (row[notNull[1]] === null || row[notNull[1]] === undefined) return false;
        continue;
      }

      // LIKE，支持 %（任意长度）与 _（单字符）
      const like = /^(\w+)\s+(?:NOT\s+)?LIKE\s+(.+)$/i.exec(c);
      if (like) {
        const [, col, rhs] = like;
        const negate = /\sNOT\s+LIKE/i.test(c);
        const pattern = String(rhs === "?" ? (params[pi++] ?? "") : this.literal(rhs));
        const hit = likeMatch(String(row[col] ?? ""), pattern);
        if (negate ? hit : !hit) return false;
        continue;
      }

      const cmp = /^(\w+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/.exec(c);
      if (cmp) {
        const [, col, op, rhs] = cmp;
        const left = row[col];
        const right = rhs === "?" ? params[pi++] : this.literal(rhs);
        // SQLite 中布尔以 0/1 存储，JS 侧做宽松比较
        const l = typeof left === "boolean" ? (left ? 1 : 0) : left;
        const r = typeof right === "boolean" ? (right ? 1 : 0) : right;
        switch (op) {
          case "=":
            if (l !== r) return false;
            break;
          case "!=":
          case "<>":
            if (l === r) return false;
            break;
          case ">":
            if (!((l as number) > (r as number))) return false;
            break;
          case "<":
            if (!((l as number) < (r as number))) return false;
            break;
          case ">=":
            if (!((l as number) >= (r as number))) return false;
            break;
          case "<=":
            if (!((l as number) <= (r as number))) return false;
            break;
        }
        continue;
      }
      // 无法识别的条件按不匹配处理，避免静默污染数据
      return false;
    }
    return true;
  }

  /** 极简 SELECT：支持 WHERE / GROUP BY / ORDER BY / LIMIT，以及常见聚合函数 */
  private query<T>(sql: string, params: Param[] = []): T[] {
    const s = sql.trim().replace(/;$/, "");

    const m =
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/is.exec(
        s,
      );
    if (!m) return [];
    const [, colsRaw, tableName, whereRaw, groupRaw, orderRaw, limitRaw] = m;

    let rows = [...this.table(tableName).rows];
    if (whereRaw) rows = rows.filter((r) => this.match(r, whereRaw, params));

    // GROUP BY：按分组列聚合，其余列用聚合函数计算
    if (groupRaw) {
      const groupCols = groupRaw.split(",").map((c) => c.trim());
      const buckets = new Map<string, Row[]>();
      for (const r of rows) {
        const key = groupCols.map((c) => String(r[c] ?? "")).join("\u0000");
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(r);
      }

      const projections = splitTopLevel(colsRaw);
      const out: Row[] = [];
      for (const [, groupRows] of buckets) {
        const row: Row = {};
        for (const p of projections) {
          // 形如 COUNT(*) AS c 或 COUNT(*) c
          const aggM = /^(COUNT|MIN|MAX|SUM|AVG)\((.+?)\)(?:\s+AS\s+(\w+)|\s+(\w+))?$/i.exec(p.trim());
          if (aggM) {
            const [, fn, inner, aliasA, aliasB] = aggM;
            const alias = aliasA ?? aliasB ?? fn.toLowerCase();
            row[alias] = aggregate(fn, groupRows.map((r) => r[inner.trim()]));
            continue;
          }
          // 普通列，如 list_id
          const colM = /^(\w+)(?:\s+AS\s+(\w+))?$/i.exec(p.trim());
          if (colM) {
            const [, col, alias] = colM;
            row[alias ?? col] = groupRows[0]?.[col] ?? null;
          }
        }
        out.push(row);
      }
      rows = out;
      // 分组后 ORDER BY 已在聚合结果上处理，这里直接返回避免列名对不上
      return rows as unknown as T[];
    }

    if (orderRaw) {
      const terms = orderRaw.split(",").map((t) => t.trim().split(/\s+/));
      rows.sort((a, b) => {
        for (const [col, dir] of terms) {
          const av = a[col];
          const bv = b[col];
          if (av === bv) continue;
          // NULL 统一排在后面，与 SQLite ASC 行为一致（这里简化处理）
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          const cmp = av > bv ? 1 : -1;
          return /DESC/i.test(dir ?? "") ? -cmp : cmp;
        }
        return 0;
      });
    }

    if (limitRaw) rows = rows.slice(0, Number(limitRaw));

    // COUNT(*) 聚合成单行结果
    const countMatch = /^COUNT\(\*\)(?:\s+AS\s+(\w+))?$/i.exec(colsRaw.trim());
    if (countMatch) {
      const alias = countMatch[1] ?? "count";
      return [{ [alias]: rows.length } as unknown as T];
    }

    // 单一聚合表达式，如 COUNT(*) AS c、MIN(sort_order) AS m
    const agg = /^(COUNT|MIN|MAX|SUM|AVG)\((.+?)\)(?:\s+AS\s+(\w+))?$/i.exec(colsRaw.trim());
    if (agg) {
      const [, fn, inner, aliasRaw] = agg;
      const alias = aliasRaw ?? fn.toLowerCase();
      return [{ [alias]: aggregate(fn, rows.map((r) => r[inner.trim()])) } as unknown as T];
    }

    // 普通列投影
    if (colsRaw.trim() === "*") return rows as unknown as T[];
    const wanted = colsRaw.split(",").map((c) => c.trim().split(/\s+AS\s+/i).pop()!.trim());
    return rows.map((r) => {
      const out: Row = {};
      for (const w of wanted) out[w] = r[w] ?? null;
      return out as unknown as T;
    });
  }

  async select<T>(sql: string, params?: Param[]): Promise<T[]> {
    return this.query<T>(sql, params);
  }

  async tableNames(): Promise<string[]> {
    return [...this.tables.keys()].sort();
  }

  async execute(sql: string, params?: Param[]): Promise<void> {
    // 一个 execute 里可能塞了多条语句（迁移脚本就是如此）
    for (const stmt of splitStatements(sql)) {
      this.run(stmt, params);
    }
    this.persist();
  }

  async transaction(statements: Array<{ sql: string; params?: Param[] }>): Promise<void> {
    // 先快照，失败则回滚
    const snapshot = new Map<string, Row[]>();
    for (const [name, t] of this.tables) snapshot.set(name, t.rows.map((r) => ({ ...r })));
    try {
      for (const { sql, params } of statements) {
        for (const stmt of splitStatements(sql)) this.run(stmt, params ?? []);
      }
      this.persist();
    } catch (err) {
      this.tables = new Map(
        [...snapshot].map(([name, rows]) => [name, { name, rows }]),
      );
      throw err;
    }
  }

  /** 应用迁移并把 user_version 落在内存里 */
  async migrate(): Promise<void> {
    const pending = migrations.filter((m) => m.version > this.version);
    for (const m of pending) {
      await this.transaction([{ sql: m.sql }]);
      this.version = m.version;
      this.persist();
    }
  }

  get schemaVersion() {
    return this.version;
  }
}

/** 计算聚合函数。COUNT 计行数，其余只对数值列生效，无可比值时返回 null。 */
function aggregate(fn: string, vals: unknown[]): number | null {
  const nums = vals.filter((v): v is number => typeof v === "number");
  switch (fn.toUpperCase()) {
    case "COUNT":
      return vals.length;
    case "MIN":
      return nums.length ? Math.min(...nums) : null;
    case "MAX":
      return nums.length ? Math.max(...nums) : null;
    case "SUM":
      return nums.reduce((a, b) => a + b, 0);
    case "AVG":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    default:
      return null;
  }
}

/** 按顶层逗号切分投影列表，聚合函数参数里的逗号不会被误切 */
function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (const ch of raw) {
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (ch === "," && depth === 0 && !inStr) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 按顶层 AND 切分条件。括号内的 AND 不切分，避免破坏 (a = ? AND b = ?) 这类分组 */
function splitAnd(whereRaw: string): string[] {
  return splitTopLevelBy(whereRaw, "AND");
}

/**
 * 按顶层的 AND / OR 切分表达式。
 *
 * 括号与字符串字面量内的同名关键字不参与切分；
 * 关键字两侧必须是空白，避免把列名里恰好含 and / or 的单词切断。
 */
function splitTopLevelBy(raw: string, keyword: "AND" | "OR"): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }

    if (
      depth === 0 &&
      !inStr &&
      raw.slice(i, i + keyword.length).toUpperCase() === keyword &&
      /\s/.test(raw[i - 1] ?? " ") &&
      /\s/.test(raw[i + keyword.length] ?? " ")
    ) {
      out.push(cur);
      cur = "";
      i += keyword.length - 1;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 去掉包住整个表达式的多余括号，如 `(a = 1 OR b = 2)` */
function stripOuterParens(raw: string): string {
  let s = raw.trim();
  while (s.startsWith("(") && closesAtEnd(s)) s = s.slice(1, -1).trim();
  return s;
}

/** 首个 `(` 是否正好在末尾闭合 —— 否则 `(a) AND (b)` 会被误判成整体分组 */
function closesAtEnd(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
}

/** 统计占位符数量：OR 分支没命中时要跳过它吃掉的参数 */
function countPlaceholders(expr: string): number {
  let n = 0;
  let inStr = false;
  for (const ch of expr) {
    if (ch === "'") inStr = !inStr;
    else if (ch === "?" && !inStr) n++;
  }
  return n;
}

/** SQL LIKE 语义：% 匹配任意长度，_ 匹配单字符；大小写不敏感（与 SQLite 默认一致） */
function likeMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${regex}$`, "is").test(value);
}

/**
 * 解析 SET 子句的赋值列表。
 * 只按顶层逗号切分，函数调用或括号内的逗号不会被误切。
 */
function parseAssignments(setRaw: string): Array<[string, string]> {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";

  for (const ch of setRaw) {
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (ch === "," && depth === 0 && !inStr) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  return parts.map((pair) => {
    // 用第一个 = 切分，值里可能含 =（如比较表达式）
    const idx = pair.indexOf("=");
    if (idx < 0) return [pair.trim(), ""] as [string, string];
    return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()] as [string, string];
  });
}

/** 把一段 SQL 脚本切成单条语句，跳过字符串字面量里的分号 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inStr = !inStr;
      cur += ch;
      continue;
    }
    if (ch === ";" && !inStr) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ------------------------------------------------------------------ */
/* 实现二：真实 SQLite（Tauri 桌面环境）                                */
/* ------------------------------------------------------------------ */

/**
 * 数据库连接串。
 *
 * Rust 侧 `db_instances` 是**以这个字符串为键**缓存连接池的
 * （见 tauri-plugin-sql 的 `load` 命令），事务命令要按同一个键去取池子，
 * 所以这里必须只有一处定义、原样传回去。
 */
const DB_URL = "sqlite:todo-workbench.db";

class SqliteDb implements Db {
  private conn: {
    select: (sql: string, params?: unknown[]) => Promise<unknown>;
    execute: (sql: string, params?: unknown[]) => Promise<unknown>;
  };
  /** 连接串，事务命令用它从 Rust 侧取回同一个连接池 */
  private url: string;

  constructor(conn: SqliteDb["conn"], url: string) {
    this.conn = conn;
    this.url = url;
  }

  static async open(): Promise<SqliteDb> {
    const mod = await import("@tauri-apps/plugin-sql");
    const conn = await mod.default.load(DB_URL);
    return new SqliteDb(conn as unknown as SqliteDb["conn"], DB_URL);
  }

  async select<T>(sql: string, params?: Param[]): Promise<T[]> {
    return (await this.conn.select(sql, params ?? [])) as T[];
  }

  async tableNames(): Promise<string[]> {
    // 排除 SQLite 自己的内部表（自动索引、序列器等），它们对用户没有意义，
    // 出现在设置页里只会让人以为数据多了 pointlessly
    const rows = await this.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    return rows.map((r) => r.name);
  }

  async execute(sql: string, params?: Param[]): Promise<void> {
    await this.conn.execute(sql, params ?? []);
  }

  /**
   * 事务必须交给 Rust 侧的命令执行 —— 这里**不能**自己发 BEGIN/COMMIT。
   *
   * 插件的 `execute` 实现是 `pool.execute(query)`，语义为「从连接池现取一条
   * 连接、执行完就还」，而 sqlx 池的空闲连接是 FIFO 轮转的。把
   * `BEGIN / DELETE / INSERT / COMMIT` 发成四次独立 IPC，它们会落在四条
   * 不同的连接上，净效果是「DELETE 被 autocommit 提交、INSERT 卡在一条
   * 没人提交的事务里、COMMIT 报 cannot commit」，即**数据既没写进去又被删了**。
   * 具体推导见 src-tauri/src/db_tx.rs 顶部。
   */
  async transaction(statements: Array<{ sql: string; params?: Param[] }>): Promise<void> {
    await invoke("db_transaction", { db: this.url, statements });
  }

  async migrate(): Promise<void> {
    const rows = await this.select<{ user_version: number }>("PRAGMA user_version");
    const current = rows[0]?.user_version ?? 0;
    for (const m of migrations.filter((x) => x.version > current)) {
      await this.transaction([{ sql: m.sql }]);
      await this.execute(`PRAGMA user_version = ${m.version}`);
    }
  }

  get schemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }
}

/* ------------------------------------------------------------------ */
/* 单例初始化                                                          */
/* ------------------------------------------------------------------ */

/** 是否运行在 Tauri 容器里 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let instance: Db | null = null;
let info: DbInfo = {
  driver: "memory",
  location: `${STORAGE_KEY} (localStorage)`,
  schemaVersion: 0,
};

/**
 * 初始化中的 Promise。
 *
 * 必须做并发去重：React StrictMode 下 effect 会执行两次，
 * 两个 init() 并发跑会导致 seedIfEmpty 双双看到空库、各插一份种子数据，
 * 表现就是侧边栏出现重复列表。这里用同一个 Promise 让第二次调用直接复用结果。
 */
let initPromise: Promise<DbInfo> | null = null;

/** 初始化数据库：自动选择驱动并跑完迁移。幂等且并发安全。 */
export async function initDb(): Promise<DbInfo> {
  if (instance) return info;
  if (initPromise) return initPromise;

  initPromise = (async (): Promise<DbInfo> => {
    if (isTauri()) {
      const db = await SqliteDb.open();
      await db.migrate();
      instance = db;
      info = {
        driver: "sqlite",
        location: "%APPDATA%/todo-workbench/todo-workbench.db",
        schemaVersion: db.schemaVersion,
      };
    } else {
      const db = new MemoryDb();
      await db.migrate();
      instance = db;
      info = {
        driver: "memory",
        location: `${STORAGE_KEY} (localStorage)`,
        schemaVersion: db.schemaVersion,
      };
    }
    return info;
  })();

  try {
    return await initPromise;
  } catch (err) {
    // 失败后允许重试，否则一次偶发错误会让应用永久卡在未初始化状态
    initPromise = null;
    throw err;
  }
}

export function db(): Db {
  if (!instance) throw new Error("数据库尚未初始化，请先 await initDb()");
  return instance;
}

export function dbInfo(): DbInfo {
  return info;
}

/** 清空 demo 数据，仅浏览器模式有效 */
export function resetDemoDb() {
  if (info.driver !== "memory") return;
  localStorage.removeItem(STORAGE_KEY);
  instance = null;
  initPromise = null;
}
