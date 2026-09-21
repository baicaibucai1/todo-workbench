#!/usr/bin/env node
/**
 * 工具副本与外部源文件的同步守卫。
 *
 * 为什么需要它：工具契约要求每个工具目录自带一份 index.html
 * （tools/<id>/index.html），而尺码生成器同时还有一份独立发行用的单文件版本，
 * 放在隔壁 `图片裁剪/尺码生成器/` 下。两份是同一份代码的两次投递 ——
 * 一份给浏览器直接打开，一份给工作台当工具嵌。
 *
 * 没有这个守卫，就会出现「网页版修了 bug，工作台里那份还是旧的」这种
 * 最难查的问题：两边看起来都对，只是行为不一样。
 *
 * 用法：
 *   node scripts/sync-tools.mjs            把源文件同步到工具目录
 *   node scripts/sync-tools.mjs --check    只校验，不一致时退出码 1
 *   node scripts/sync-tools.mjs --quiet    只在有问题时输出
 *
 * 注意：源文件缺失只算警告不算错误 —— 打包只需要工具目录里那份，
 * 源文件在不在都不影响出包。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkToolExports } from "./check-tool-exports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const QUIET = argv.includes("--quiet");

/**
 * 工具 id → 外部源文件（相对项目根目录）。
 *
 * 只登记「确实存在两份副本」的工具 —— 每多一条，就多一份要保持一致的镜像。
 * 不在这里的工具（如 ai-gen）是工作台独有的，没有外部源。
 *
 * image-crop 曾经是「在工作台里重写的精简版」，2026-09-19 改为直接镜像
 * 隔壁的 CROP STUDIO 完整版，于是也纳入守卫。
 */
const SOURCES = {
  "size-chart": "../图片裁剪/尺码生成器/size-chart.html",
  "image-crop": "../图片裁剪/图片裁剪工具/index.html",
};

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const say = (msg) => {
  if (!QUIET) console.log(msg);
};

let changed = 0;
let problems = 0;
let problems_total = 0;
let skipped = 0;

say("[sync-tools] 工具副本同步检查");

for (const [id, rel] of Object.entries(SOURCES)) {
  const dest = path.join(ROOT, "tools", id, "index.html");
  const src = path.resolve(ROOT, rel);

  if (!fs.existsSync(src)) {
    // 源文件不在不影响出包：工具目录里那份是自足的
    say(`  [跳过] ${id}：源文件不存在 ${rel}`);
    skipped++;
    continue;
  }
  if (!fs.existsSync(dest)) {
    console.log(`  [缺失] ${id}：找不到工具入口 tools/${id}/index.html`);
    problems++;
    continue;
  }

  const hs = sha256(src);
  const hd = sha256(dest);

  if (hs === hd) {
    say(`  [一致] ${id}`);
    continue;
  }

  changed++;
  if (CHECK) {
    console.log(`  [不一致] ${id}`);
    console.log(`      源   ${rel}  ${hs.slice(0, 16)}…  ${fs.statSync(src).size} 字节`);
    console.log(`      工具 tools/${id}/index.html  ${hd.slice(0, 16)}…  ${fs.statSync(dest).size} 字节`);
    console.log(`      修复：node scripts/sync-tools.mjs`);
  } else {
    fs.copyFileSync(src, dest);
    say(`  [已同步] ${id}：${fs.statSync(src).size} 字节`);
  }
}

/*
 * 顺手再过一遍所有工具的「内联 onclick ↔ window 导出」。
 *
 * 这道检查挂在同步守卫里而不是单独一个脚本，是因为它管的正是
 * **同步造成的那一类事故**：源文件改了函数名，副本跟着换，
 * 而留在副本里的旧导出行只有跑起来才暴露。放在同一道门禁上，
 * 下一次同步就把它挡住。
 */
const TOOLS_DIR = path.join(ROOT, "tools");
say("[sync-tools] 内联 onclick 与 window 导出一致性");
for (const id of fs.readdirSync(TOOLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)) {
  const entry = path.join(TOOLS_DIR, id, "index.html");
  if (!fs.existsSync(entry)) continue;
  const problems = checkToolExports(entry);
  if (problems.length) {
    console.log(`  [导出错误] ${id}`);
    for (const p of problems) console.log(`      ✗ ${p}`);
    problems_total++;
  }
}

if (CHECK) {
  if (problems) {
    console.log(`\n[sync-tools] ${problems} 个工具入口缺失。`);
    process.exit(1);
  }
  if (problems_total) {
    console.log(`\n[sync-tools] ${problems_total} 个工具的导出对不上，修好后重跑。`);
    process.exit(1);
  }
  if (changed) {
    console.log(`\n[sync-tools] ${changed} 个工具与源文件不一致，请运行 node scripts/sync-tools.mjs 同步。`);
    process.exit(1);
  }
  say(`\n[sync-tools] 全部一致${skipped ? `（${skipped} 个跳过）` : ""}。`);
  process.exit(0);
}

say(`\n[sync-tools] 完成：同步 ${changed} 个，跳过 ${skipped} 个，缺失 ${problems} 个，导出错误 ${problems_total} 个。`);
process.exit(problems || problems_total ? 1 : 0);
