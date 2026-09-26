/** 一次性脚本：MEMORY.md 更新 schema 版本 / e2e 数字 / 加同步约定（3000 字符封顶，同时做等价精简） */
import fs from "node:fs";

const FILE = "C:/AI_Production/Tools/.workbuddy/memory/MEMORY.md";
let s = fs.readFileSync(FILE, "utf8");
const before = s.length;
let n = 0;
function rep(name, oldStr, newStr, expect = 1) {
  const hits = s.split(oldStr).length - 1;
  if (hits !== expect) throw new Error(`${name}: 期望 ${expect} 次，命中 ${hits} 次`);
  s = s.replace(oldStr, newStr);
  n++;
}

/* ---- 1. 版本与数字 ---- */

rep("schema v12→v14", "**当前 schema = v12**", "**当前 schema = v14**");
rep("e2e 数字", "（17 套件 992 项）", "（18 套件 1041 项）");

/* ---- 2. 新增：同步的硬性约定 ---- */

rep(
  "加同步约定",
  `- 专属视图两处不能漏：\`fetchTasks\` 分支 \`return []\` + \`rows.ts\` 里 \`done\` 置空。`,
  `- 专属视图两处不能漏：\`fetchTasks\` 分支 \`return []\` + \`rows.ts\` 里 \`done\` 置空。
- **同步**（坚果云 WebDAV）：分片只碰自己的表，写回走 **upsert**（附件级联删除）；
  **设置不进同步**、文件本体不上传；给表加列时**所有 INSERT 都要显式带上**（PITFALLS 四十七）。`,
);

/* ---- 3. 等价精简：腾出上面那几行的位置 ---- */

rep(
  "精简 CONVENTIONS 第 10 节",
  `- ⛔ **共享仓库禁止** \`git gc\` / \`reflog expire\` / 手删 \`.git/\` 子目录
  （\`.git/worktrees/\` 是**所有 worktree 的注册表**，删了它们全失效 → 09-22 事故，见
  CONVENTIONS 第 10 节）。怀疑坏了先 \`git fsck\` **只读诊断**，别急着修。
  改动没合并时存一份到 \`.workbuddy/backup/<分支>-<日期>/\`。`,
  `- ⛔ **共享仓库禁止** \`git gc\` / \`reflog expire\` / 手删 \`.git/\` 子目录（\`.git/worktrees/\`
  是所有 worktree 的注册表 → 09-22 事故，CONVENTIONS 第 10 节）。先 \`git fsck\` 只读诊断；
  改动没合并时存一份到 \`.workbuddy/backup/<分支>-<日期>/\`。`,
);

rep(
  "精简环境坑",
  `详见 CONVENTIONS 第 8 节。最常撞的：\`ls/head/grep/rm\` 不可用 → **列目录用 node fs**、
**别用 \`| head\`**（吃输出会误判）；\`npm run xxx\` 失败 → 直跑 \`node node_modules/<pkg>/…\`；
⚠️ **git 协议本机不通** → 前置 \`HTTP_PROXY= HTTPS_PROXY=\`，仍不通走 API 推送。
- ⚠️ 长驻 dev server 服务**旧模块**（tsc 绿却报 \`xxx is not defined\`）→ 先重启（PITFALLS 二十八）。
- ⚠️ \`git update-ref\` 写 \`refs/remotes/*\` **静默失效** → 手写 loose ref（PITFALLS 四十五）。`,
  `详见 CONVENTIONS 第 8 节。\`ls/head/grep/rm\` 不可用 → **列目录用 node fs**、**别用 \`| head\`**；
\`npm run xxx\` 失败 → 直跑 \`node node_modules/<pkg>/…\`；
⚠️ **git 协议本机不通** → 前置 \`HTTP_PROXY= HTTPS_PROXY=\`，仍不通走 API 推送；
\`update-ref\` 写 \`refs/remotes/*\` **静默失效** → 手写 loose ref（PITFALLS 四十五）；长驻
dev server 服务**旧模块**（tsc 绿却报 \`xxx is not defined\`）→ 先重启（PITFALLS 二十八）。`,
);

rep(
  "精简工具项",
  `  \`row.*\`/\`gallery.*\`）；**卸载保留数据**；工具永不跑迁移。`,
  `  \`row.*\`/\`gallery.*\`）；卸载保留数据；永不跑迁移。`,
);

rep(
  "精简紧急区",
  `- **紧急区**：待办、流程任务（时效/交付日）、子任务（\`due_at\`，只认自设时刻的；
  父完成/不在池不算）。\`lib/urgent.ts\`。`,
  `- **紧急区**：待办、流程任务（时效/交付日）、子任务（\`due_at\`，只认自设时刻的）；
  \`lib/urgent.ts\`。`,
);

fs.writeFileSync(FILE, s);
console.log(`${n} 处替换；${before} → ${s.length} 字符`);
if (s.length > 3000) console.log("⚠️ 仍超出 3000");
