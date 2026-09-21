/**
 * 单文件工具的「内联 onclick → window 导出」一致性检查。
 *
 * 为什么需要它：这些工具是**双击也能开**的单文件 HTML，
 * 所以大量交互写成 `onclick="foo()"` 这种内联属性。
 * 内联属性只在全局作用域里找名字，于是脚本要把函数挂到 window 上。
 *
 * 两类错误都是**运行时才炸**的，`node --check` 查不出来：
 *   1. 死导出：`window.foo = foo` 但 foo 早被改名删掉 —— 脚本一加载就
 *      ReferenceError，整个工具白屏。裁剪工具真实发生过一次：
 *      refillNow 已改名 fillApply，导出行却留着，于是每次打开工具
 *      控制台都飘一条 "refillNow is not defined"。
 *   2. 漏导出：onclick 用了 foo 但没挂 window —— 平时没事，点下去才报错。
 *      只有 `<script type="module">` 会这样（模块作用域不是全局），
 *      经典脚本的顶层 function 本身就是全局，不算问题。
 */

import fs from "node:fs";

/**
 * @param {string} file 工具的 index.html 绝对路径
 * @returns {string[]} 问题列表，空数组表示没问题
 */
export function checkToolExports(file) {
  const t = fs.readFileSync(file, "utf8");
  const problems = [];

  // 内联 onclick 用到的名字
  const htmlOnly = t.replace(/<script[\s\S]*?<\/script>/g, "");
  const used = new Set([...htmlOnly.matchAll(/onclick="([a-zA-Z0-9_]+)\(/g)].map((m) => m[1]));

  // 脚本是不是模块：模块作用域里不挂 window 就点不动
  const isModule = /<script[^>]*type\s*=\s*"module"/i.test(t);

  // window.X = Y（Y 为裸标识符才算，赋值表达式跳过）
  const exported = new Map();
  for (const m of t.matchAll(/window\.([A-Za-z0-9_]+)\s*=\s*/g)) {
    const rest = t.slice(m.index, m.index + 200);
    const bare = /^window\.[A-Za-z0-9_]+\s*=\s*([A-Za-z0-9_]+)\s*[;\n]/.exec(rest);
    exported.set(m[1], bare ? bare[1] : null);
  }

  const defined = new Set([
    ...[...t.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]),
    ...[...t.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]),
  ]);

  for (const [name, val] of exported) {
    if (val && !defined.has(val)) {
      problems.push(`死导出：window.${name} = ${val}（${val} 没定义，工具一加载就报错）`);
    }
  }

  if (isModule) {
    for (const u of used) {
      if (!exported.has(u)) problems.push(`漏导出：onclick 用了 ${u}()，模块脚本没挂 window`);
    }
  }

  return problems;
}
