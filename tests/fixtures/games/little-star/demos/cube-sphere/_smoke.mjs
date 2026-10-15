/* cube-sphere demo 的冒烟验证（保留）：零控制台错误 / 网格统计 / 连续采样 /
 * 陆地占比标定 / 点击拾取 / 三张截图。并入主工程前每次改 demo 都跑一遍。 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 4324;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript; charset=utf-8" };

const srv = http.createServer((req, res) => {
  const p = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const buf = fs.readFileSync(path.join(ROOT, p));
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  } catch { if (p === "/favicon.ico") { res.writeHead(204); res.end(); } else { res.writeHead(404); res.end("nf"); } }
});
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errs.push("console: " + m.text()); });
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

await page.goto(`http://127.0.0.1:${PORT}/demos/cube-sphere/index.html`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__demo && window.__demo.ready, null, { timeout: 15000 });
await page.waitForTimeout(700);

/* ★ 单文件自足校验（v0.9.1）：这个 demo 以后可能被单独拷走（预览面板 / 直接发出去），
 * 那时相对引用的 ../../three.min.js 会 404，HUD 全成「—」而控制台只有一条 404。
 * 这里直接查「HTML 里还有没有外链脚本」和「页面有没有发出过任何失败请求」。 */
const selfContained = await page.evaluate(() =>
  Array.from(document.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"))
);
if (selfContained.length) errs.push("非自足：仍有外链脚本 " + JSON.stringify(selfContained));
const reqFail = [];
page.on("requestfailed", (r) => reqFail.push(r.url() + " :: " + (r.failure() || {}).errorText));
page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) reqFail.push(r.url() + " :: HTTP " + r.status()); });

const stats = await page.evaluate(() => ({
  api: window.__demo.stats(),
  tris: document.getElementById("s-tris").textContent,
  cells: document.getElementById("s-cells").textContent,
  ms: document.getElementById("s-ms").textContent,
  fps: document.getElementById("s-fps").textContent,
}));
console.log("stats:", JSON.stringify(stats));

const samples = await page.evaluate(() => {
  const out = [];
  [[0, 0], [45, 120], [-60, -30], [20, -140], [88, 10]].forEach(([la, lo]) => {
    out.push({ la, lo, ...window.__demo.sample(la, lo) });
  });
  return out;
});
console.log("连续采样:", samples.map((s) => `${s.la}/${s.lo} → h=${s.h} ${s.land ? "陆" : "海"}`).join(" | "));

/* 陆地占比（按面积均匀撒点）—— 海平面标定是否合理的判据 */
const landFrac = await page.evaluate(() => {
  let land = 0, n = 0, mn = 9, mx = -9;
  for (let i = 0; i < 4000; i++) {          // 球面均匀：z 均匀 → 天顶角反余弦
    const z = 1 - (2 * (i + 0.5)) / 4000;
    const th = i * 2.399963;                // 黄金角
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const la = (Math.asin(z) * 180) / Math.PI;
    const lo = (Math.atan2(r * Math.sin(th), r * Math.cos(th)) * 180) / Math.PI;
    const s = window.__demo.sample(la, lo);
    if (s.land) land++;
    if (s.h < mn) mn = s.h;
    if (s.h > mx) mx = s.h;
    n++;
  }
  return { land: +(land / n).toFixed(3), min: +mn.toFixed(3), max: +mx.toFixed(3) };
});
console.log("陆地占比 / 高程范围:", JSON.stringify(landFrac));

/* 真点击球体中心（画面正中），看拾取面板是否出值 */
await page.mouse.click(512, 400);
await page.waitForTimeout(250);
const picked = await page.evaluate(() => ({
  face: document.getElementById("p-face").textContent,
  cell: document.getElementById("p-cell").textContent,
  ll: document.getElementById("p-ll").textContent,
  h: document.getElementById("p-h").textContent,
  kind: document.getElementById("p-kind").textContent,
}));
console.log("拾取:", JSON.stringify(picked));

await page.screenshot({ path: path.join(ROOT, "demos", "cube-sphere", "shot-1-default.png") });

/* 近景：滚轮拉近，看轮廓是否还是多边形 */
await page.mouse.move(512, 400);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(ROOT, "demos", "cube-sphere", "shot-2-close.png") });

/* 格子线：按 G */
await page.keyboard.press("g");
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(ROOT, "demos", "cube-sphere", "shot-3-wire.png") });

/* ★ 断言：HUD 必须真的出值（只看截图肉眼扫会漏掉「全 —」这种静默失败） */
const hudFilled = await page.evaluate(() => {
  const ids = ["s-cells", "s-tris", "s-ms", "s-sea", "s-relief", "p-face", "p-cell", "p-h"];
  return ids.filter((id) => {
    const t = document.getElementById(id).textContent.trim();
    return t === "" || t === "—";
  });
});
console.log("HUD 空值项:", hudFilled.length ? "❌ " + JSON.stringify(hudFilled) : "✅ 无");
if (hudFilled.length) errs.push("HUD 未填值: " + JSON.stringify(hudFilled));
if (reqFail.length) errs.push("请求失败: " + reqFail.join(" | "));

console.log(errs.length ? "❌ 错误:\n" + errs.join("\n") : "✅ 零 console error / pageerror · 单文件自足 · HUD 出值");
await browser.close();
srv.close();
