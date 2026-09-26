/** 收尾：MEMORY.md 再精简到 3000 以内 */
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

rep(
  "主项目目录串",
  "`main\\`（源码）、`main-b\\`（会话 B 的 worktree）、`图片裁剪\\`、`minimax-h3\\`（PITFALLS 三十六）、\n`待办工作台\\`（实机安装目录）。另有 suisui-app（`C:\\AI_Production\\suisui-app`，PITFALLS 三十三）。",
  "`main\\`（源码）、`main-b\\`（会话 B）、`待办工作台\\`（实机安装目录）、\n`图片裁剪\\`、`minimax-h3\\`（PITFALLS 三十六）；suisui-app 在 `C:\\AI_Production\\suisui-app`。",
);

rep(
  "同步约定再压",
  `- **同步**（坚果云 WebDAV）：分片只碰自己的表，写回走 **upsert**（附件级联删除）；
  **设置不进同步**、文件本体不上传；给表加列时**所有 INSERT 都要显式带上**（PITFALLS 四十七）。`,
  `- **同步**（坚果云 WebDAV）：分片只碰自己的表，写回走 **upsert**（附件级联删除）；
  **设置不进同步**、不传文件本体；加列时**所有 INSERT 都要显式带上**（PITFALLS 四十七）。`,
);

rep(
  "每日任务再压",
  "子任务批量 `stepsByTask`，**禁每行单独查库**。",
  "子任务批量 `stepsByTask`，禁每行单独查库。",
);

rep(
  "发版项压",
  "- **发版**：`node scripts/publish-release.mjs`（Release + `update.json` + 匿名验证）；\n  ⚠️ **资产名必须纯 ASCII**（GitHub 静默丢中文，PITFALLS 四十五）。",
  "- **发版**：`scripts/publish-release.mjs`（Release + `update.json` + 匿名验证）；\n  ⚠️ **资产名必须纯 ASCII**（GitHub 静默丢中文，PITFALLS 四十五）。",
);

rep(
  "打包项压",
  "- 打包 `node scripts/build-desktop.mjs`（两道门禁，3~5 分钟）；**打包前清空 `dist/`**\n  （删 >50 条会被守卫拦）。",
  "- 打包 `scripts/build-desktop.mjs`（两道门禁，3~5 分钟）；**打包前清空 `dist/`**（一次删 >50 条会被拦）。",
);

fs.writeFileSync(FILE, s);
console.log(`${n} 处替换；${before} → ${s.length} 字符`);
console.log(s.length <= 3000 ? "✓ 在 3000 以内" : "⚠️ 仍超出");
