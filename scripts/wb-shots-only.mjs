/** 一次性脚本：给 gen-readme-shots 加 --only 过滤 + 补拍「设置 · 同步」 */
import fs from "node:fs";

const FILE = "tests/gen-readme-shots.mjs";
let s = fs.readFileSync(FILE, "utf8");
let n = 0;
function rep(name, oldStr, newStr, expect = 1) {
  const hits = s.split(oldStr).length - 1;
  if (hits !== expect) throw new Error(`${name}: 期望 ${expect} 次，命中 ${hits} 次`);
  s = s.replace(oldStr, newStr);
  n++;
  console.log(`✓ ${name}`);
}

rep(
  "用法说明",
  ` * 用法（dev server 要先在 1420 上跑）：
 *   node tests/gen-readme-shots.mjs
 *
 * 产物写到 docs/screenshots/，文件名与 README 里的引用一一对应。`,
  ` * 用法（dev server 要先在 1420 上跑）：
 *   node tests/gen-readme-shots.mjs                       # 全部重拍
 *   node tests/gen-readme-shots.mjs --only settings-sync  # 只拍指定的（可跟多个）
 *
 * \`--only\` 是为了改一处界面时别把 15 张图全换掉 —— 全量重拍会让 diff 里
 * 混进一堆毫无变化的二进制文件，评审时根本看不出真正改的是哪张。
 *
 * 产物写到 docs/screenshots/，文件名与 README 里的引用一一对应。`,
);

rep(
  "加 ONLY 解析",
  `const shot = async (name) => {
  await page.waitForTimeout(700);`,
  `/** 只拍这几张；不给 --only 就是全拍 */
const onlyArg = process.argv.indexOf("--only");
const ONLY =
  onlyArg === -1
    ? null
    : new Set(process.argv.slice(onlyArg + 1).filter((a) => !a.startsWith("--")));
const want = (name) => !ONLY || ONLY.has(name);

const shot = async (name) => {
  if (!want(name)) return;
  await page.waitForTimeout(700);`,
);

rep(
  "补拍设置·同步",
  `await page.locator('[data-section="tools"]').click();
await shot("settings-tools");`,
  `await page.locator('[data-section="tools"]').click();
await shot("settings-tools");

// 「设置 · 同步」：演示模式下按钮是灰的、并有一段说明 —— 截的就是这个真实状态
await page.locator('[data-section="sync"]').click();
await shot("settings-sync");`,
);

rep(
  "工具循环也尊重 --only",
  `const toolNavs = page.locator('aside[data-sidebar-width] [data-nav^="tool:"]');
const toolCount = await toolNavs.count();
console.log(\`  发现 \${toolCount} 个工具位\`);
for (let i = 0; i < toolCount; i++) {`,
  `const toolNavs = page.locator('aside[data-sidebar-width] [data-nav^="tool:"]');
const toolCount = await toolNavs.count();
const wantTools = !ONLY || [...ONLY].some((x) => x.startsWith("tool-"));
if (toolCount && wantTools) console.log(\`  发现 \${toolCount} 个工具位\`);
for (let i = 0; wantTools && i < toolCount; i++) {`,
);

fs.writeFileSync(FILE, s);
console.log(`共 ${n} 处`);
