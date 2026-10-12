/**
 * 内联器（src/lib/toolInline.ts）的端到端测试。
 *
 * 不 mock fetch —— 本地起一个真 http 服务器扮演"站点"，断言 Referer 真的传了、
 * 抓回来的字节真的进了 HTML、防盗链 404 的资源真的进了 failed 列表。
 * 跑法：npm run inline:test（esbuild 打包后 node 执行）
 */
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require(process.cwd() + "/node_modules/esbuild");
const { inlineExternalResources, sniffMime } = await (async () => {
  const out = path.join(os.tmpdir(), `inline-${Date.now()}.mjs`);
  await esbuild.build({
    entryPoints: [process.cwd() + "/src/lib/toolInline.ts"],
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
const { scanExternalRefs } = await (async () => {
  const out = path.join(os.tmpdir(), `scan-${Date.now()}.mjs`);
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

/* ---------------- 假站点 ---------------- */
// 一张最小"PNG"（只要签名对，sniffMime 就认；浏览器不真渲染它）
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const seenReferers = new Map(); // path -> referer

const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  seenReferers.set(u, req.headers.referer ?? "(没有)");
  const send = (ct, body) => {
    res.writeHead(200, { "Content-Type": ct });
    res.end(body);
  };
  if (u === "/page.html") {
    send("text/html", `<!doctype html><html><head>
      <meta charset="utf-8">
      <title>测试工具页</title>
      <link rel="stylesheet" href="/style.css">
      <link rel="icon" href="/favicon.ico">
      <link rel="dns-prefetch" href="//other.example">
    </head><body>
      <script src="/app.js" integrity="sha384-xxx" crossorigin="anonymous"></script>
      <script type="module" src="/mod.mjs"></script>
      <script src="/missing.js"></script>
      <img src="/pic.png" srcset="/pic.png 2x" alt="图">
      <div style="background-image:url(/bg.png)">x</div>
      <style>.keep{color:red}</style>
    </body></html>`);
    return;
  }
  if (u === "/app.js") {
    // 故意带着会提前终结标签的序列
    send("application/javascript", `console.log("</script> hi"); if(0){<!--} ok();`);
    return;
  }
  if (u === "/mod.mjs") { send("application/javascript", `import "/dep.js"; export const a = 1;`); return; }
  if (u === "/dep.js") { send("application/javascript", `export const b = 2;`); return; }
  if (u === "/style.css") {
    send("text/css", `@import url("/extra.css");\nbody{background:url(/bg.png);font-family:x}`);
    return;
  }
  if (u === "/extra.css") { send("text/css", `.i{background:url(/icon.svg)}`); return; }
  if (u === "/bg.png" || u === "/pic.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(Buffer.from(PNG)); return; }
  if (u === "/icon.svg") { send("image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg"/>`); return; }
  if (u === "/favicon.ico") { res.writeHead(200, { "Content-Type": "image/x-icon" }); res.end(Buffer.from([0,0,1,0])); return; }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/** 测试用的抓取器：node http + referer（与 tool_store 里的 tauri 版同一个形状） */
const fetchBin = (url, referer) =>
  new Promise((resolve, reject) => {
    http
      .get(url, { headers: { referer } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`对方返回 ${res.statusCode}`)); return; }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          bytes: new Uint8Array(Buffer.concat(chunks)),
          contentType: res.headers["content-type"] ?? "",
        }));
      })
      .on("error", reject);
  });

const page = await (async () => {
  const r = await fetch(`${base}/page.html`);
  return r.text();
})();

/* ---------------- 跑内联 ---------------- */
const progress = [];
const res = await inlineExternalResources(page, `${base}/page.html`, fetchBin, {
  onProgress: (d) => progress.push(d),
});

/* ---------------- 断言 ---------------- */
check("app/mod 的 src 被拿掉（只剩 missing.js 留原状）", !/src="\/(app|mod)\.m?js"/.test(res.html));
check("app.js 内容进来了", res.html.includes('console.log("<\\/script> hi")'), res.html.slice(0, 200));
check("<!-- 也被转义", res.html.includes("<\\!--"));
check("integrity/crossorigin 被剥掉", !res.html.includes("integrity") && !res.html.includes("crossorigin"));
check("module 的 type 保留", /<script\s+type="module">/.test(res.html));
check("样式表变成 <style>", !/<link[^>]*stylesheet/i.test(res.html) && /body\{/.test(res.html));
check("css 里的 url() 变成 data:image/png", (res.html.match(/url\("data:image\/png;base64,/g) ?? []).length >= 2,
  `出现 ${(res.html.match(/url\("data:image\/png/g) ?? []).length} 次（样式表 + 内联 style 两处）`);
check("@import 的 extra.css 被递归内联", res.html.includes(".i{") && !/@import/i.test(res.html));
check("svg 图标转成 data:image/svg+xml", res.html.includes("data:image/svg+xml;base64,"));
check("img 变成 data URI 且 srcset 被丢掉", /<img[^>]*src="data:image\/png;base64,[^"]*"/.test(res.html) && !/srcset/i.test(res.html));
check("favicon 被内联成 data:", /rel="icon"[^>]*href="data:image\/x-icon;base64,/.test(res.html) || /href="data:image\/x-icon;base64,[^"]*"\s*rel="icon"/.test(res.html));
check("dns-prefetch 这种非样式 link 不动", res.html.includes('rel="dns-prefetch"'));
check("页面自带的 <style> 内容保留", res.html.includes(".keep{color:red}"));
check("404 的脚本留在原处且进 failed", res.html.includes('src="/missing.js"') && res.failed.some((f) => f.url.endsWith("/missing.js")));
check("failed 只有 1 项（其余全抓到）", res.failed.length === 1, JSON.stringify(res.failed));
check("抓到的总数 = 8（脚本2+样式2+图片2+favicon1+css资产2 减去缓存去重）", res.inlined.length >= 7,
  JSON.stringify(res.inlined.map((i) => i.kind)));
check("打包后再扫描：只剩 missing.js 一个外链", scanExternalRefs(res.html, true).scripts.length === 1,
  JSON.stringify(scanExternalRefs(res.html, true)));
check("Referer 真的传了（防盗链就靠它）", seenReferers.get("/app.js") === `${base}/page.html`, seenReferers.get("/app.js"));
check("进度回调在动且递增", progress.length >= 3 && progress[progress.length - 1] > progress[0],
  `进度点 ${progress.length} 个，末值 ${progress[progress.length - 1]}`);

/* ---------------- sniffMime ---------------- */
check("PNG 签名优先于瞎写的 Content-Type", sniffMime(PNG, "text/html") === "image/png");
check("SVG 文本认成 image/svg+xml", sniffMime(new TextEncoder().encode("<svg/>"), "") === "image/svg+xml");
check("WOFF2 认成 font/woff2", sniffMime(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0]), "") === "font/woff2");
check("未知字节回落到 Content-Type", sniffMime(new Uint8Array([1, 2, 3]), "application/octet-stream") === "application/octet-stream");

/* ---------------- 相对地址 + 空基准（从文件导入的场景） ---------------- */
{
  // 绝对地址用本地服务器的一个真实资源 —— 别用不存在的域名，那是测网络不是测内联
  const r2 = await inlineExternalResources(
    `<img src="rel.png"><img src="${base}/pic.png">`,
    "",
    fetchBin,
  );
  check("无基准时相对地址进 failed", r2.failed.some((f) => f.url === "rel.png"), JSON.stringify(r2.failed));
  check("无基准时绝对地址照样抓", r2.inlined.some((i) => i.kind === "img"), JSON.stringify(r2.inlined));
}

server.close();
console.log(`\n  ${passed} 项通过, ${failed} 项失败`);
process.exit(failed ? 1 : 0);
