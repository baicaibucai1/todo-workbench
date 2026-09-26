/** 一次性脚本：linkTasks 的 INSERT 补 deleted；fetchLinkedTasks 容忍老行缺这个键 */
import fs from "node:fs";

const FILE = "src/lib/repo.ts";
const crlf = fs.readFileSync(FILE, "utf8").includes("\r\n");
let s = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
let n = 0;
function rep(name, oldStr, newStr, expect = 1) {
  const hits = s.split(oldStr).length - 1;
  if (hits !== expect) throw new Error(`${name}: 期望 ${expect} 次，命中 ${hits} 次`);
  s = s.replace(oldStr, newStr);
  n++;
  console.log(`✓ ${name}`);
}

rep(
  "linkTasks 写入 deleted",
  `  const at = now();
  await db().execute(
    \`INSERT INTO core_task_links (id, task_id, linked_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)\`,
    [uid(), taskId, linkedId, at, at],
  );
  return true;`,
  `  const at = now();
  // deleted 必须显式写 0。真 SQLite 上这一列有 DEFAULT 0，不写也没事；但浏览器
  // 演示用的 MemoryDb 是 schemaless 的 —— INSERT 没带的列就是**没有这个键**，
  // 于是 \`WHERE deleted = 0\` 永远不成立，新关联在演示模式里一建出来就是隐形的。
  await db().execute(
    \`INSERT INTO core_task_links (id, task_id, linked_id, deleted, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)\`,
    [uid(), taskId, linkedId, at, at],
  );
  return true;`,
);

rep(
  "fetchLinkedTasks 正向过滤",
  `      \`SELECT linked_id FROM core_task_links WHERE task_id = ? AND deleted = 0\`,`,
  `      \`SELECT linked_id FROM core_task_links WHERE task_id = ? AND (deleted = 0 OR deleted IS NULL)\`,`,
);

rep(
  "fetchLinkedTasks 反向过滤",
  `      \`SELECT task_id FROM core_task_links WHERE linked_id = ? AND deleted = 0\`,`,
  `      \`SELECT task_id FROM core_task_links WHERE linked_id = ? AND (deleted = 0 OR deleted IS NULL)\`,`,
);

rep(
  "说明为什么带 IS NULL",
  `export async function fetchLinkedTasks(taskId: string): Promise<Task[]> {`,
  `export async function fetchLinkedTasks(taskId: string): Promise<Task[]> {
  // \`deleted IS NULL\` 是给 v14 之前写下的关联行留的：那些行走的是"硬删除"，
  // 当时那列还不存在，MemoryDb 里的老快照也就没有这个键。真 SQLite 上该列
  // NOT NULL DEFAULT 0，这个分支永远不成立，留着不影响任何东西。`,
);

fs.writeFileSync(FILE, crlf ? s.replace(/\n/g, "\r\n") : s);
console.log(`共 ${n} 处，已写入 ${FILE}`);
