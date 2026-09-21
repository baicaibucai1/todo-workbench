/**
 * 工具数据演示。
 *
 * 用来证明「工具表和核心表共库但命名空间隔离」这条设计是可运行的。
 * 真实的订单记录工具会自己发 SQL，这里是宿主的演示替身。
 */

import { db } from "./db";
import { toolTable } from "./tools";

export interface DemoOrder {
  id: string;
  order_no: string;
  amount: number;
}

/** 建立工具私有表并写入示例数据，返回表名与内容 */
export async function fetchToolDemoData(
  toolId: string,
): Promise<{ table: string; rows: DemoOrder[] }> {
  const table = toolTable(toolId, "orders");

  await db().execute(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         TEXT PRIMARY KEY,
      order_no   TEXT NOT NULL,
      amount     REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  const existing = await db().select<DemoOrder>(`SELECT * FROM ${table} ORDER BY order_no`);
  if (existing.length) return { table, rows: existing };

  const seed: Array<[string, number]> = [
    ["SO-20260917-001", 1280.5],
    ["SO-20260917-002", 340],
    ["SO-20260917-003", 86.8],
  ];
  const nowIso = new Date().toISOString();

  for (const [no, amount] of seed) {
    await db().execute(
      `INSERT INTO ${table} (id, order_no, amount, created_at) VALUES (?, ?, ?, ?)`,
      [`ord-${no}`, no, amount, nowIso],
    );
  }

  const rows = await db().select<DemoOrder>(`SELECT * FROM ${table} ORDER BY order_no`);
  return { table, rows };
}
