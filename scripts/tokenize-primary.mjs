/**
 * 一次性 codemod：把硬编码的「选中蓝」#378add 换成 --color-primary 令牌。
 *
 * 为什么要机械化：85 处散在 18 个文件里，手改必然漏，而漏掉一处的表现是
 * 「换色后某个按钮还是蓝的」，在 diff 里根本看不出来。
 *
 * 只换**样式用法**。下面这几类是**数据**，改了会把用户数据写坏，脚本显式跳过：
 *   - migrations.ts：列的 DEFAULT '#378add'（建表默认值，历史数据就是它）
 *   - repo.ts / syncRepo.ts：新建列表/阶段的默认色（写进数据库的字符串）
 *   - settings.ts：头像底色候选（写进 core_settings）
 *   - gallery.ts：origin 图例色
 *
 * 用法：
 *   node scripts/tokenize-primary.mjs --dry   # 先看要改什么
 *   node scripts/tokenize-primary.mjs         # 确认后再改
 */

import fs from "node:fs";
import path from "node:path";

/** 数据类文件：一个都不碰 */
const SKIP = new Set([
  "src/lib/migrations.ts",
  "src/lib/repo.ts",
  "src/lib/syncRepo.ts",
  "src/lib/settings.ts",
  "src/lib/gallery.ts",
]);

const ROOT = "src";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Tailwind 任意值语法 → 令牌。
 * 允许前缀修饰符（focus: / hover: / focus-within:）与透明度后缀（/25）。
 *   bg-[#378add]            → bg-primary
 *   focus:border-[#378add]  → focus:border-primary
 *   ring-[#378add]/25       → ring-primary/25
 */
const RE_CLASS = /([a-z-]+:)?(border|bg|text|ring|from|to|via|fill|stroke|shadow)-\[#378add\](\/\d+)?/gi;

/** JS 里的字符串字面量：内联 style 可以直接吃 var() */
const RE_JS = /"#378add"/gi;

function transform(src) {
  const before = src;
  let out = src.replace(RE_CLASS, (_m, pre, util, alpha) => `${pre ?? ""}${util}-primary${alpha ?? ""}`);
  out = out.replace(RE_JS, () => '"var(--color-primary)"');
  return { out, changed: out !== before };
}

const dry = process.argv.includes("--dry");
let files = 0;
let total = 0;

for (const p of walk(ROOT)) {
  if (SKIP.has(p)) continue;
  const src = fs.readFileSync(p, "utf8");
  if (!/#378add/i.test(src)) continue;
  const { out, changed } = transform(src);
  if (!changed) continue;
  const n = (src.match(/#378add/gi) || []).length;
  const left = (out.match(/#378add/gi) || []).length;
  files += 1;
  total += n - left;
  console.log(`${dry ? "[dry] " : ""}${p}  ${n} → 剩 ${left}`);
  if (!dry) fs.writeFileSync(p, out);
}

console.log(`\n${dry ? "将修改" : "已修改"} ${files} 个文件，替换 ${total} 处。`);
if (dry) console.log("（干跑：没有写入。去掉 --dry 才会真正改文件）");

// 复核：改完不该还剩「样式类」里的硬编码（数据文件除外）
if (!dry) {
  const leftovers = [];
  for (const p of walk(ROOT)) {
    if (SKIP.has(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    src.split("\n").forEach((l, i) => {
      if (/#378add/i.test(l)) leftovers.push(`${p}:${i + 1} | ${l.trim().slice(0, 90)}`);
    });
  }
  if (leftovers.length) {
    console.log("\n⚠️ 仍有残留，需人工判断：");
    leftovers.forEach((l) => console.log("  " + l));
  } else {
    console.log("✓ 样式层无残留硬编码");
  }
}

void path;
