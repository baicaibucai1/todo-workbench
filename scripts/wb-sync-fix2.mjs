/** 收尾：sync.ts 的冲突判定 + syncClient.ts 的分片顺序（repo.ts 已在上一脚本改完） */
import fs from "node:fs";

let n = 0;
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
  console.log(`✓ ${file}`);
}

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
