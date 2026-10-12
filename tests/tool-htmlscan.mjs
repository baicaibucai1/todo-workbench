/**
 * 单文件 HTML 自包含体检（src/lib/toolHtmlScan.ts）的单元测试。
 *
 * 测试数据用两份真文件，不用手造的玩具 HTML：
 *   · C:/AI_Production/Tools/gomoku.html —— 独立五子棋，自包含（应 0 外链）
 *   · 用户 2026-10-12 真实装进来的 tool.lu 条码页 —— 整站网页（应报一堆外链）
 *     路径在 %APPDATA%，不在仓库里；不在就跳过那组（换机器跑测试不炸）。
 *
 * 跑法：npm run htmlscan:test（esbuild 打包后 node 执行，见 package.json）
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url"; // ★ Windows 下动态 import 绝对路径必须转 file:// URL

const require = createRequire(import.meta.url);
const esbuild = require(process.cwd() + "/node_modules/esbuild");
const { scanExternalRefs, describeExternalRefs, titleFromHtml } = await (async () => {
  const out = path.join(os.tmpdir(), `htmlscan-${Date.now()}.mjs`);
  await esbuild.build({
    entryPoints: [process.cwd() + "/src/lib/toolHtmlScan.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: out,
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(out).href);
  fs.rmSync(out, { force: true });
  return mod;
})();

let passed = 0;
let failed = 0;
const check = (n, c, d = "") => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ` —— ${d}` : ""}`); }
};

/* ---------------- 1. 自包含页面：独立五子棋 ---------------- */
{
  const file = "C:/AI_Production/Tools/gomoku.html";
  if (fs.existsSync(file)) {
    const refs = scanExternalRefs(fs.readFileSync(file, "utf8"), true);
    const n = refs.scripts.length + refs.styles.length + refs.images.length;
    check("gomoku.html 应 0 外部引用", n === 0, JSON.stringify(refs).slice(0, 120));
    check("gomoku.html 不产生警告行", describeExternalRefs(refs).length === 0);
  } else {
    console.log("  SKIP  gomoku.html 不在（换机器）");
  }
}

/* ---------------- 2. 真实现场：tool.lu 整站页 ---------------- */
const toolLu = "C:/Users/Sogap/AppData/Roaming/com.sogapopo.todo-workbench/tools/https-tool-lu-barcode/index.html";
if (fs.existsSync(toolLu)) {
  const html = fs.readFileSync(toolLu, "utf8");
  const refs = scanExternalRefs(html, true);
  const total = refs.scripts.length + refs.styles.length + refs.images.length;
  check("tool.lu 页面应报出外部引用", total > 0, `total=${total}`);
  check("脚本/样式/图片三类都抓到了", refs.scripts.length > 0 && refs.styles.length > 0 && refs.images.length > 0,
    JSON.stringify({ s: refs.scripts.length, c: refs.styles.length, i: refs.images.length }));
  check("警告行非空且说了加载不到", describeExternalRefs(refs).some((l) => l.includes("加载不到")));
  const hostLine = describeExternalRefs(refs).find((l) => l.includes("来自"));
  check("警告行点了站点名", !!hostLine && hostLine.includes("tool.lu"), hostLine ?? "(无)");
  // 协议相对地址（//s1.tool.lu/...）必须算外部
  check("协议相对地址被算作外部", refs.scripts.some((u) => u.startsWith("//")));
  check("页面 <title> 抠出「条形码生成器」", titleFromHtml(html) === "条形码生成器", titleFromHtml(html));
} else {
  console.log("  SKIP  tool.lu 样本不在本机（%APPDATA% 里没装）");
}

/* ---------------- 3. 人造用例：边界与误报 ---------------- */
{
  const refs = scanExternalRefs(
    `<!doctype html><html><head>
      <link rel="dns-prefetch" href="//cdn.example.com">
      <link rel="canonical" href="https://site.example/page/">
      <link rel="stylesheet" href="https://cdn.example.com/a.css">
      <!-- <script src="//commented.example.com/x.js"></script> -->
    </head><body>
      <script src="data:text/js,1"></script>
      <script src="blob:xxx"></script>
      <script src="#local"></script>
      <script src="//proto.example.com/p.js"></script>
      <script src="https://abs.example.com/a.js"></script>
      <script src="relative.js"></script>
      <img src="data:image/png;base64,xx">
      <img src="/root.png">
      <img src="https://pic.example.com/p.png">
    </body></html>`,
    true, // 单文件：相对路径也算外部
  );
  check("data:/blob:/# 不算外链", !refs.scripts.some((u) => /^(data:|blob:|#)/i.test(u)));
  check("注释掉的脚本不算数", !refs.scripts.some((u) => u.includes("commented")));
  check("dns-prefetch/canonical 不算样式", refs.styles.length === 1, JSON.stringify(refs.styles));
  check("脚本抓到 3 个（协议相对/绝对/相对）", refs.scripts.length === 3, JSON.stringify(refs.scripts));
  check("图片抓到 2 个（根相对与 https 都算外部）", refs.images.length === 2, JSON.stringify(refs.images));

  // 同一份 HTML，目录工具视角：相对引用合法，绝对外链仍要报
  const refs2 = scanExternalRefs(
    `<script src="relative.js"></script><img src="/root.png"><script src="https://abs.example.com/a.js"></script>`,
    false,
  );
  check("目录模式下相对引用不算外链", refs2.scripts.length === 1 && refs2.scripts[0].includes("abs.example.com"),
    JSON.stringify(refs2));

  // 空串 / 纯内联页面
  check("空 HTML 不报", describeExternalRefs(scanExternalRefs("", true)).length === 0);
  check("单引号属性也认", scanExternalRefs("<script src='//q.example/x.js'></script>", true).scripts.length === 1);
  check("无引号属性也认", scanExternalRefs("<script src=//q.example/x.js></script>", true).scripts.length === 1);
}

console.log(`\n  ${passed} 项通过, ${failed} 项失败`);
process.exit(failed ? 1 : 0);
