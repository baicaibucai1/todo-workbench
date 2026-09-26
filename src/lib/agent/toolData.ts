/**
 * 助手替某个工具读写**它自己的私有表**。
 *
 * ------------------------------------------------------------------
 * 为什么要这一层，而不是直接给 SQL
 * ------------------------------------------------------------------
 * 用户会提出很实际的要求："把我这周的记录导进番茄钟里"、"把那几条数据
 * 删掉"。这些数据的主人是**工具**，不是助手 —— 但逐条手填太慢，
 * 工具自己又没有批量导入的界面。
 *
 * 于是要有这条路。它的边界画在三个地方：
 *
 *  1. **只能碰工具自己声明过的表**。表名来自那个工具的 manifest.schema，
 *     写别的名字直接拒绝 —— 等于把"工具私有数据"这块地盘的围栏
 *     从 iframe 边界挪到宿主里，但围栏还在。
 *  2. **只能走白名单操作**：select / count / insert / delete。
 *     没有 UPDATE（改一行不如删了重写清楚），没有 DROP，没有裸 SQL。
 *  3. **列与值都走参数化**。用户输入里带引号、分号都不影响 ——
 *     SQL 注入在这里没有任何入口。
 *
 * ------------------------------------------------------------------
 * 与工具自己走的那条桥（toolBridge）的区别
 * ------------------------------------------------------------------
 * 工具在 iframe 里，它通过 postMessage 请求 row.*，宿主校验后再执行。
 * 助手在宿主进程里，直接调这一层。两条路共用**同一套表名前缀规则**
 * （toolPrefix，见 lib/tools.ts），所以它们看到的是同一张表。
 */

import { toolPrefix } from "../tools";
import { db } from "../db";
import type { ToolManifest } from "../../types";

export interface ToolTableRow {
  name: string;
  columns: Array<{ name: string; type?: string }>;
}

/** 一个工具声明过的表名（含前缀后的真名） */
function declaredTables(tool: ToolManifest): Map<string, string[]> {
  const out = new Map<string, string[]>(); // 真表名 -> 列名
  const prefix = toolPrefix(tool.id);
  for (const t of tool.schema?.tables ?? []) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(t.name)) continue;
    out.set(
      `${prefix}${t.name}`,
      (t.columns ?? []).map((c) => c.name),
    );
  }
  return out;
}

export interface ToolDataResult {
  ok: boolean;
  message?: string;
  rows?: Array<Record<string, unknown>>;
  count?: number;
  /** 受影响行数（insert / delete） */
  affected?: number;
}

const IDENT = /^[a-z_][a-z0-9_]{0,39}$/;

/**
 * 在一个工具的私有表上执行一个白名单操作。
 *
 * 返回的 `message` 是**可以直接回给模型**的话 —— 它需要知道的是
 * "改用什么写法就对了"，而不是"操作失败"。
 */
export async function toolData(
  tool: ToolManifest,
  table: string,
  op: "select" | "count" | "insert" | "delete",
  payload: Record<string, unknown> = {},
): Promise<ToolDataResult> {
  const tables = declaredTables(tool);
  if (!tables.size) {
    return { ok: false, message: `「${tool.name}」没有声明任何数据表，所以它也没有数据可读写` };
  }
  if (!IDENT.test(table)) {
    return { ok: false, message: `表名「${table}」不合法（只允许小写字母、数字、下划线）` };
  }
  const full = `${toolPrefix(tool.id)}${table}`;
  const cols = tables.get(full);
  if (!cols) {
    return {
      ok: false,
      message: `「${tool.name}」没有声明表 ${table}。它声明过的表：${[...tables.keys()]
        .map((k) => k.slice(toolPrefix(tool.id).length))
        .join("、")}`,
    };
  }

  try {
    if (op === "select" || op === "count") {
      const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 200);
      if (op === "count") {
        const rows = await db().select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${full}`);
        return { ok: true, count: Number(rows[0]?.n ?? 0) };
      }
      const rows = await db().select<Record<string, unknown>>(
        `SELECT * FROM ${full} LIMIT ?`,
        [limit],
      );
      return { ok: true, rows, count: rows.length };
    }

    if (op === "insert") {
      const raw = (payload.values ?? payload.row ?? {}) as Record<string, unknown>;
      const keys = Object.keys(raw).filter((k) => IDENT.test(k) && cols.includes(k));
      if (!keys.length) {
        return {
          ok: false,
          message: `没有可写入的列。${table} 的列是：${cols.join("、")}`,
        };
      }
      const marks = keys.map(() => "?").join(", ");
      await db().execute(`INSERT INTO ${full} (${keys.join(", ")}) VALUES (${marks})`, [
        ...keys.map((k) => String(raw[k] ?? "")),
      ]);
      return { ok: true, affected: 1 };
    }

    // delete：**必须带 id**（整表清空不在这个动作的能力范围内）
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) {
      return {
        ok: false,
        message: "删数据必须指定 id（这个动作不支持整表清空 —— 那是设置 → 数据库里的事）",
      };
    }
    if (!cols.includes("id")) {
      return { ok: false, message: `表 ${table} 没有 id 列，没法按 id 删` };
    }
    await db().execute(`DELETE FROM ${full} WHERE id = ?`, [id]);
    return { ok: true, affected: 1 };
  } catch (e) {
    return { ok: false, message: `读写「${tool.name}」的数据时出错：${e instanceof Error ? e.message : String(e)}` };
  }
}
