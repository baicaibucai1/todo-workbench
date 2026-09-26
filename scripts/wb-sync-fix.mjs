/** 一次性脚本：修掉同步测试暴露出来的两处问题 */
import fs from "node:fs";

let n = 0;
const ok = (m) => console.log(`✓ ${m}`);

function edit(file, pairs) {
  const crlf = fs.readFileSync(file, "utf8").includes("\r\n");
  let s = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const [oldStr, newStr, expect = 1] of pairs) {
    const hits = s.split(oldStr).length - 1;
    if (hits !== expect) throw new Error(`${file}: 期望 ${expect} 次，命中 ${hits} 次\n${oldStr.slice(0, 120)}`);
    s = s.replace(oldStr, newStr);
    n++;
  }
  fs.writeFileSync(file, crlf ? s.replace(/\n/g, "\r\n") : s);
  ok(file);
}

/* ---------------- 1. fetchTasks：空 WHERE 子句 ---------------- */

edit("src/lib/repo.ts", [
  [
    `  const rows = await db().select<RawTask>(
    \`SELECT * FROM core_tasks WHERE \${where.join(" AND ")}
     ORDER BY done ASC, sort_order ASC, created_at DESC\`,
    params,
  );`,
    `  // where 可能整个是空的：同步路径（includeDeleted）不推 \`deleted = 0\`，
  // 而 view="all" 本身也不加条件 —— 这时拼出来是 \`WHERE  ORDER BY\`，语法错误。
  // 真 SQLite 直接抛、MemoryDb 静默返回空，两边都表现为"同步一条数据都取不到"。
  const clause = where.length ? \`WHERE \${where.join(" AND ")}\` : "";
  const rows = await db().select<RawTask>(
    \`SELECT * FROM core_tasks \${clause}
     ORDER BY done ASC, sort_order ASC, created_at DESC\`,
    params,
  );`,
  ],
  [
    `  const rows = await db().select<RawOrder>(
    \`SELECT * FROM core_work_orders WHERE \${where.join(" AND ")}
     ORDER BY sort_order ASC, created_at DESC\`,
    params,
  );`,
    `  // 同 fetchTasks：includeDeleted + view="all" 会让 where 整个为空
  const clause = where.length ? \`WHERE \${where.join(" AND ")}\` : "";
  const rows = await db().select<RawOrder>(
    \`SELECT * FROM core_work_orders \${clause}
     ORDER BY sort_order ASC, created_at DESC\`,
    params,
  );`,
  ],
]);

/* ---------------- 2. sync.ts：冲突判定剔掉同步元数据 ---------------- */

edit("src/lib/sync.ts", [
  [
    `/* ------------------------------------------------------------------ */
/* 结果                                                                */
/* ------------------------------------------------------------------ */`,
    `/**
 * 判断两条记录是不是**同一份内容**。
 *
 * 比之前要把同步自己的元数据（updatedAt / createdAt）剔掉：同一处改动
 * 被两端各记了一次时，内容一模一样而时间戳必然不同，把它们算进比较
 * 就等于"每次同步都报一堆冲突" —— 而冲突提示一旦变成噪音，
 * 真正被覆盖掉的那一条就再也提醒不到人了。
 *
 * 只剔这两个键：completedAt / dueAt 这类是**用户可见的状态**，得留着比。
 */
export function sameContent(a: unknown, b: unknown): boolean {
  return stableJson(stripStamps(a)) === stableJson(stripStamps(b));
}

function stripStamps(x: unknown): unknown {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(stripStamps);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (k === "updatedAt" || k === "createdAt") continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 结果                                                                */
/* ------------------------------------------------------------------ */`,
  ],
  [
    `    if (winner !== "same" && stableJson(l) !== stableJson(r)) {`,
    `    if (winner !== "same" && !sameContent(l, r)) {`,
  ],
  [
    `  return out.length ? out : ["tasks"];`,
    `  // 按固定顺序回排：同一个集合无论设置串怎么写，读出来都是同一串，
  // 界面勾选框的顺序与写回的字符串不会因为历史顺序不同而漂移
  return out.length ? ALL_SHARDS.filter((s) => out.includes(s)) : ["tasks"];`,
  ],
]);

edit("src/lib/syncClient.ts", [
  [
    `  return out.length ? out : ["tasks"];`,
    `  // 按固定顺序回排：同一个集合无论设置串怎么写，读出来都是同一串，
  // 界面勾选框的顺序与写回的字符串不会因为历史顺序不同而漂移
  return out.length ? ALL_SHARDS.filter((s) => out.includes(s)) : ["tasks"];`,
  ],
]);

console.log(`共 ${n} 处替换`);
