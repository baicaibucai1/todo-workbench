/**
 * Little Star —— Web 端真机验证（v0.13.0：源码拆分 src/ 20 片段 + 拼装器 build.mjs）
 *
 * 覆盖（25 节，与下方 `/* ---- N. ... ---- *\/` 区块注释一一对应）：
 *   0. 工程自检：game.js 是否等于 src/ 片段的拼装结果（不需要浏览器）
 *   1. 加载 / WebGL / rAF 渲染调用
 *   2. 场景精简（v0.5）：飞船 / 卫星 / 空间站 / 防务平台 / 彗星全部下线
 *   3. 默认界面：面板隐藏 · 左上角工具条 · 指导书默认关闭
 *      + ★ 黑白硬边审计（UI 本体 R=G=B 无彩色 · 圆角统一 · 边框 ≥ 2px）
 *   4. 交互：拖拽旋转 · 滚轮缩放
 *   5. 单击行星 → 右侧面板（★ 三个分区 + 构成行 + 科学数据，无「卫星」行）
 *   6. 单击恒星 → 恒星面板
 *   7. 双击行星聚焦（平滑拉近 + 镜头跟随）
 *   8. 双击空白回全景
 *   9. 场景动态：行星公转推进
 *  10. 恒星：干净球体 + 动态表面 shader + 柔光晕
 *  11. ★ 星型库：15 种，取值全部落在真实科学区间（含斯特藩-玻尔兹曼自洽）
 *      + ★ 确定性守恒锚点（rngDraws=884 / starRoll=0.374455 / 命中 M / 星系「薄曙」）
 *  12. ★ 星型切换：15 种逐一 setStarType，视觉 / 光照 / 面板同步、零报错
 *  13. ★ 选中效果：白色括号（呼吸淡入，精灵而非环状网格）+ 扫描细环
 *  14. ★ 指导书：栏目化 —— 左栏 13 栏导航 + 右栏**一次只渲染一栏**，逐栏真点击巡览
 *      （累计 13 张表 / 31 个 chip / 3 个小标题）· 翻页条 · ←→ 键 · 栏目记忆 · 三路关闭
 *  15. 耀斑爆发（手动触发 → 粒子喷发）
 *  16. 镜头光斑（主光斑 / 对侧鬼影链，光学正确）
 *  17. ★ 行星物理：四项优化的机器判据 ——
 *      ① 表面温度由恒星与距离独立复算（含辐照 / 温室两步）
 *      ② 构成三项质量占比和 = 100 + 由成分独立复算质量（构成真的进了公式）
 *      ③ 挥发分相态与表面温度一致（构成随温度变）
 *      ④ 轨道：宜居带随恒星重算 · 亮度带 · 开普勒速度序
 *      ⑤ 全字段有限数（NaN 不得静默传播）
 *  18. ★ 物种与文明（v0.8 新增）：物种库（人类）+ 发源地选址 ——
 *      ① 评分公式独立复算（逐颗行星对账）+ 榜首 = 发源地（平局取内侧）
 *      ② 重载确定性：刷新后发源地仍是同一颗（世界事实，不是一次性抽签）
 *      ③ 发源地信标（虚线环）恰 1 枚且挂在发源地上
 *      ④ 右侧「行星 / 资源 / 文明」三页标签：真点击开出，文明页与快照同源，机器 = DOM
 *      ⑤ 换恒星 → 发源地按新温度重新选举，切回后复原
 *  19. ★ 物资（v0.9 新增）：元素制家底 —— 14 大类 · 两本账（蕴含 ≠ 可采）——
 *      ① 表结构：自造单位口径 · 元素单一归属 · 配方闭包 · 取率随工程单调不减
 *      ② 两本账逐颗逐类独立复算（配方 × 构成 × 质量 → 元素 kg → 归户 → 取率）
 *      ③ 守恒 Σ蕴藏 ≡ 行星质量（机器精度）· 零 RNG（实时抽数一格不动）
 *      ④ 资源页真点击 + 内容与快照同源 + 15 星型标签闭包扫描 + 重载确定性
 *  20. ★ 聚焦镜头（v0.10 新增）：相机第三态 focus ——
 *      ★ v0.12：聚焦档表面表示换成立方球连续地表（贴图升级路径退役，见 22）
 *      ① 双击行星 → focus：距离 = 行星半径 × 3.6（clamp 1.6~9.4）+ minR 放宽 + HUD 现身
 *      ② 「镜头内基本全是星球」：行星屏幕投影直径 ≥ 视口高 50%（真投影量取）
 *      ③ 距地表读数随缩放实时更新（推导量，与 cameraState().surface 同源）
 *      ④ 操作精度提高：聚焦态滚轮一步 < 全景态一步的 60%（灵敏度 ×0.32）
 *      ⑤ Esc → 回落 follow（同目标、中距离、HUD 隐藏、minR 复原）
 *      ⑥ 双击空白 → free（goal 92、目标清空、minR 复原不泄漏）
 *      ⑦ focus 态拉远后双击换目标（幂等：仍聚焦、目标与距离换成新行星）
 *  21. ★ 结构层（v0.7 新增；v0.9 起五张表 / 四台机器）：对象注册表 + 状态机 ——
 *      ① 每张表（恒星 15 / 行星 16 / 物种 1 / 物资 14 / 文明 1）体检为零问题，且 id 与数据同源
 *      ② 体检器自检：人为植入的重复 id / 缺字段**真被抓到**（守卫不是摆设）
 *      ③ 四台机器全程零非法转移；表外事件真被拦（探针，且不留痕）
 *      ④ 投影对账：机器状态 = G 里的字段 = DOM（驱动一遍交互逐帧比对）
 *  22. ★ 聚焦地表（v0.12 新增）：立方球连续地表 = 聚焦档的表面表示 ——
 *      ① 聚焦固态行星：立方球亮（6 面 × 64² 格）+ 贴图网格隐；退出原样还原
 *      ② 物理同源：海平面重标定 0.5 且水面覆盖 = 挥发分丰度（与贴图管线同一保证）
 *      ③ 确定性：重建签名一致 + 零 RNG（聚焦/重建不碰主随机流）
 *      ④ 气态行星不参与（没有固体表面，维持贴图）· 云层与 planetCloudy 同源
 *  23. ★ 聚落系统（v0.13 新增 · 实验性）：聚焦档在星球表面放置聚落 ——
 *      ① B 键选址模式 + 光标预览 · ② 硬闸门 = 连续场纯函数（海 / 坡度 / 极冠 / 叠城）
 *      ③ 点击放置（UI 全链路）· ④ 站心贴地（worldToLocal · 连续场）
 *      ⑤ 重建自愈（数据是真值源）· ⑥ 全景档点位标记
 *  24. 全程零 console error / pageerror
 *
 * 用法：node verify.mjs   （端口 4322，与常驻预览服务器 4321 错开，可随时运行）
 *       截图输出到 screenshots/n*.png（索引见 README.md）
 *
 * 配套：scripts/roll-check.mjs（确定性静态复算）· scripts/build.mjs（src/ 拼装 + 导航表）
 *       本脚本第 0 节已内置「拼装是否同步」自检，故三者可独立运行、无需 runner。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "screenshots");
const PORT = 4322;
const BASE = `http://127.0.0.1:${PORT}/`;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };

/* 各星型的科学取值区间（真实天体实测 / 理论区间）——「取值要在对应的区间」的判据 */
const RANGES = {
  M:   { tempK: [2400, 3700],    radiusSol: [0.10, 0.70],    massSol: [0.08, 0.45],   lumSol: [5e-5, 0.08] },
  K:   { tempK: [3700, 5200],    radiusSol: [0.70, 0.96],    massSol: [0.50, 0.85],   lumSol: [0.08, 0.60] },
  G:   { tempK: [5200, 6000],    radiusSol: [0.96, 1.15],    massSol: [0.80, 1.04],   lumSol: [0.60, 1.50] },
  F:   { tempK: [6000, 7500],    radiusSol: [1.15, 1.40],    massSol: [1.04, 1.40],   lumSol: [1.50, 5.00] },
  A:   { tempK: [7500, 10000],   radiusSol: [1.40, 1.80],    massSol: [1.40, 2.10],   lumSol: [5.00, 25.0] },
  B:   { tempK: [10000, 30000],  radiusSol: [1.80, 6.60],    massSol: [2.10, 16.0],   lumSol: [25.0, 30000] },
  O:   { tempK: [30000, 50000],  radiusSol: [6.60, 15.0],    massSol: [16.0, 90.0],   lumSol: [10000, 1e6] },
  RG:  { tempK: [3500, 4500],    radiusSol: [20, 100],       massSol: [0.8, 8.0],     lumSol: [100, 3000] },
  RSG: { tempK: [3400, 4000],    radiusSol: [400, 1500],     massSol: [10, 40],       lumSol: [1e4, 1e6] },
  L:   { tempK: [1300, 2400],    radiusSol: [0.07, 0.15],    massSol: [0.013, 0.070], lumSol: [1e-6, 1e-3] },
  T:   { tempK: [700, 1300],     radiusSol: [0.07, 0.15],    massSol: [0.013, 0.070], lumSol: [1e-7, 1e-4] },
  Y:   { tempK: [250, 700],      radiusSol: [0.07, 0.15],    massSol: [0.005, 0.030], lumSol: [1e-9, 1e-6] },
  WD:  { tempK: [5000, 100000],  radiusSol: [0.008, 0.020],  massSol: [0.17, 1.35],   lumSol: [1e-4, 1] },
  NS:  { tempK: [1e5, 1e7],      radiusSol: [1e-5, 3e-5],    massSol: [1.1, 2.5],     lumSol: [1e-3, 1] },
  BH:  { tempK: [0, 0],          radiusSol: [1e-5, 1e-4],    massSol: [3, 100],       lumSol: [0, 0] }
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const file = path.join(HERE, p);
      if (!file.startsWith(HERE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, "127.0.0.1", () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  —— " + detail : ""}`);
}
async function shot(page, name) {
  await sleep(900);
  await page.screenshot({ path: path.join(SHOTS, name) });
  console.log(`  📷 ${name}`);
}

/* 找一个远离行星/恒星、且不在右侧面板区域的空白点（供真实点击） */
async function findEmptyPoint(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const st = g.getState();
    const W = window.innerWidth, H = window.innerHeight;
    const ss = g.starScreenPos();
    const cands = [[60, 60], [60, H - 60], [W / 2, 70], [W / 2, H - 70], [120, H / 2], [W / 4, H / 3]];
    for (const [x, y] of cands) {
      if (x > W - 360) continue;                     // 避开右侧面板
      if (y < 80 && x < 300) continue;               // 避开左上角工具条
      let ok = Math.hypot(ss.x - x, ss.y - y) > 110; // 避开恒星
      if (ok) for (const p of st.planets) {
        const sp = g.planetScreenPos(p.name);
        if (sp && Math.hypot(sp.x - x, sp.y - y) < 80) { ok = false; break; }
      }
      if (ok) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  });
}

/* 把镜头稳定到「恒星居中、近距离」，供星体视觉巡检 */
async function frameStar(page, radius) {
  await page.evaluate((r) => {
    window.__game.clearSelection();
    window.__game.holdTarget(true);
    window.__game.setTarget(0, 0, 0);
    window.__game.setOrbitAngles(0.9, 1.12);
    window.__game.zoomTo(r);
  }, radius);
  await sleep(700);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith(".png")) fs.rmSync(path.join(SHOTS, f));
  const srv = await startServer();
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    /* ---- 0. 工程自检：src/ → game.js 的拼装一致性（不需要浏览器） ---- */
    console.log("\n[0] 工程自检：game.js 是否等于 src/ 片段的拼装结果");
    {
      const { checkSync } = await import("./scripts/build.mjs");
      const s = checkSync();
      check("game.js 与 src/ 一致（不一致就跑 node scripts/build.mjs）", s.ok, s.detail);
      /* ★ 数字写死：加/删片段或顶层区块时必须**有意**改这里，防止顺手改坏拼装而不自知 */
      check("★ 20 个源片段 · 24 个顶层区块", s.fragments === 20 && s.blocks === 24,
        `${s.fragments} 片段 · ${s.blocks} 区块 · ${s.lines} 行`);
    }

    /* ---- 1. 加载与渲染 ---- */
    console.log("\n[1] 页面加载 / WebGL / 渲染");
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 15000 });
    const hasGL = await page.evaluate(() => {
      const c = document.getElementById("scene");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    });
    check("WebGL 上下文", hasGL);
    const f1 = await page.evaluate(() => window.__game.getState().frames);
    await sleep(1000);
    const f2 = await page.evaluate(() => window.__game.getState().frames);
    check("rAF 持续渲染", f2 > f1 + 20, `${f1} → ${f2} 帧`);
    const dc = await page.evaluate(() => window.__game.drawCalls());
    check("渲染调用正常（非空场景）", dc > 20, `drawCalls=${dc}`);
    const st0 = await page.evaluate(() => window.__game.getState());
    const verInfo = await page.evaluate(() => ({
      api: window.__game.version,
      badge: (document.getElementById("ver") || {}).textContent || ""
    }));
    check("版本号为 0.13.0（调试接口）", verInfo.api === "0.13.0");
    check("右下角版本戳与调试接口同源", verInfo.badge === "v" + verInfo.api, `#ver = "${verInfo.badge}"`);
    console.log(`  ℹ 星系「${st0.system}」 · ${st0.starType}（${st0.starId}） · ${st0.planets.length} 颗行星`);
    await shot(page, "n1-system.png");

    /* ---- 2. 场景元素（v0.5 精简） ---- */
    console.log("\n[2] 场景元素：聚焦恒星与行星");
    const vis = await page.evaluate(() => window.__game.sceneStats());
    check("恒星", vis.star);
    check("行星数量 5-7", vis.planets >= 5 && vis.planets <= 7, `${vis.planets} 颗`);
    check("行星全部带表面纹理", vis.textured === vis.planets, `${vis.textured}/${vis.planets}`);
    check("小行星带", vis.beltRocks >= 100, `${vis.beltRocks} 块`);
    check("飞船 / 空间站 / 防务平台 / 彗星 / 卫星已下线（v0.5）",
      vis.ships === 0 && !vis.station && !vis.platform && !vis.comet && vis.moons === 0,
      `ships=${vis.ships} station=${vis.station} platform=${vis.platform} comet=${vis.comet} moons=${vis.moons}`);
    check("★ 宜居带标线在场景里（v0.6 轨道优化）", vis.hzLines === 2, `${vis.hzLines} 条虚线`);
    const civ0 = await page.evaluate(() => window.__game.civInfo());
    check("★ 发源地信标在场景里（v0.8）：恰 1 枚，且挂在发源地上",
      vis.civRings === 1 && civ0.length === 1 && civ0[0].beacon === true,
      `${vis.civRings} 枚 · 挂在「${civ0[0] ? civ0[0].home : "?"}」`);

    /* ★ 场景图全量审计（比上面的计数断言硬）：
     *   sceneStats 的 ships / moons 等字段在实现被删后就没有生产者了，恒为 0——
     *   万一有「建了网格但没接线到字段」的残留，计数照样报 0。
     *   唯一抓得住残留的办法是直接遍历 scene：网格总数必须正好等于
     *   恒星 1 + 行星 + 云 + 大气 + 行星环 + 小行星带碎块。
     *   多一个 = 有没删干净的可见元素；少一个 = 有元素没建出来。 */
    const grid = await page.evaluate(() => {
      const r = window.__game.debugRefs();
      let meshes = 0, sprites = 0, points = 0, lines = 0;
      (function walk(o) {
        if (o.type === "Mesh") meshes++;
        else if (o.type === "Sprite") sprites++;
        else if (o.type === "Points") points++;
        else if (o.type === "Line" || o.type === "LineLoop") lines++;
        (o.children || []).forEach(walk);
      })(r.scene);
      return { meshes, sprites, points, lines };
    });
    const expectMeshes = 1 + vis.planets + vis.clouds + vis.atmo + vis.rings + vis.beltRocks;
    check("场景图审计：网格总数与元素构成吻合（无残留对象）",
      grid.meshes === expectMeshes,
      `实测 ${grid.meshes} = 恒星 1 + 行星 ${vis.planets} + 云 ${vis.clouds} + 大气 ${vis.atmo} + 环 ${vis.rings} + 碎石 ${vis.beltRocks}（Sprite ${grid.sprites} / Points ${grid.points} / Line ${grid.lines}）`);
    /* 线类对象也点名：行星轨道线（每颗一条）+ 宜居带虚线（最多 2）+ 发源地信标（v0.8，恰 1） */
    const expectLines = vis.planets + vis.hzLines + vis.civRings;
    check("★ 线类对象审计：轨道线 + 宜居带 + 信标环（无残留、无遗漏）",
      grid.lines === expectLines,
      `实测 ${grid.lines} = 轨道 ${vis.planets} + 宜居带 ${vis.hzLines} + 信标 ${vis.civRings}`);
    console.log(`  ℹ 云层 ${vis.clouds} · 行星环 ${vis.rings} · 大气辉光 ${vis.atmo}`);

    /* ---- 3. 默认界面 ---- */
    console.log("\n[3] 默认界面：面板隐藏 + 工具条 + 黑白硬边规范");
    const ui = await page.evaluate(() => ({
      legacy: document.querySelector("#topbar, #hint, #view-tag, #planet-bar, #tooltip, #toasts, #system-label"),
      panelHidden: document.getElementById("panel").classList.contains("hidden"),
      panelPE: getComputedStyle(document.getElementById("panel")).pointerEvents,
      panelOpacity: getComputedStyle(document.getElementById("panel")).opacity,
      canvas: !!document.getElementById("scene"),
      hud: !!document.getElementById("hud"),
      btn: !!document.getElementById("guide-btn"),
      guideDisplay: getComputedStyle(document.getElementById("guide")).display,
      guideOpen: window.__game.guideOpen(),
      hint: document.querySelector(".hud-hint") ? document.querySelector(".hud-hint").textContent : ""
    }));
    check("未选中时面板隐藏", ui.panelHidden && ui.panelPE === "none", `opacity=${ui.panelOpacity}`);
    check("无遗留 UI 元素", ui.legacy === null);
    check("画布存在", ui.canvas);
    check("左上角工具条 + 指导书入口", ui.hud && ui.btn);
    check("指导书默认关闭", ui.guideDisplay === "none" && ui.guideOpen === false);

    /* ★ 黑白硬边审计（v0.5 视觉规范，10-14 定的基调）：
     *   判据一：UI 本体的背景 / 边框 / 文字必须是黑·白·灰 —— RGB 三分量相等（无色相）。
     *   判据二：主容器圆角为 0，外框线宽 ≥ 2px（「粗线条边框」）。
     *   彩色只允许出现在**数据色块**上（.p-dot / .g-dot 由 JS 写入天体真实颜色）。
     *   这条断言的意义：把「别再把 UI 染回蓝色」变成机器可查的规则。 */
    const bw = await page.evaluate(() => {
      const achromatic = (c) => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || "");
        return !m || (m[1] === m[2] && m[2] === m[3]);
      };
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      const panel = cs("#panel"), btn = cs("#guide-btn"), book = cs(".g-book"), hint = cs(".hud-hint");
      const nav = cs("#guide-nav"), tab = cs("#p-tabs .p-tab"), foldC = cs("#p-fold"), dkC = cs("#p-dock .dock-tab");
      const groups = {
        面板: [panel.backgroundColor, panel.borderTopColor, panel.color],
        标签页: [tab.backgroundColor, tab.borderBottomColor, tab.color],
        收起钮: [foldC.backgroundColor, foldC.borderTopColor, foldC.color],
        标签坞: [dkC.backgroundColor, dkC.borderTopColor, dkC.color],
        指导书按钮: [btn.backgroundColor, btn.borderTopColor, btn.color],
        书页: [book.backgroundColor, book.borderTopColor],
        栏目导航: [nav.backgroundColor, nav.borderRightColor],
        提示文字: [hint.color]
      };
      const bad = [];
      for (const k in groups) for (const c of groups[k]) if (!achromatic(c)) bad.push(`${k}=${c}`);
      return {
        bad,
        radius: [panel.borderTopLeftRadius, btn.borderTopLeftRadius, book.borderTopLeftRadius].join(" / "),
        radiusOk: parseFloat(panel.borderTopLeftRadius) > 0 &&
                  panel.borderTopLeftRadius === book.borderTopLeftRadius &&
                  parseFloat(btn.borderTopLeftRadius) > 0,
        lw: parseFloat(panel.borderTopWidth) || 0
      };
    });
    check("黑白体系：UI 本体无彩色（R=G=B）", bw.bad.length === 0,
      bw.bad.length ? bw.bad.join(" · ") : "面板 / 收起钮 / 右侧标签坞 / 按钮 / 书页 / 栏目导航 / 提示 全部无色相");
    check("圆角统一（容器同值、非 0）+ 粗边框 ≥ 2px", bw.radiusOk && bw.lw >= 2,
      `圆角 ${bw.radius} · 面板边框 ${bw.lw}px`);

    /* ---- 4. 交互：拖拽旋转 + 滚轮缩放 ---- */
    console.log("\n[4] 交互：拖拽 / 缩放");
    const th0 = await page.evaluate(() => window.__game.cameraState().theta);
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(560, 430, { steps: 8 });
    await page.mouse.up();
    await sleep(200);
    const th1 = await page.evaluate(() => window.__game.cameraState().theta);
    check("拖拽旋转", Math.abs(th1 - th0) > 0.05, `theta ${th0} → ${th1}`);
    const r0 = await page.evaluate(() => window.__game.cameraState().radius);
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, -240);
    await sleep(350);
    const r1 = await page.evaluate(() => window.__game.cameraState().radius);
    check("滚轮拉近", r1 < r0 - 1, `radius ${r0} → ${r1}`);
    await page.mouse.wheel(0, 240);
    await sleep(350);
    const r2 = await page.evaluate(() => window.__game.cameraState().radius);
    check("滚轮拉远", r2 > r1 + 1, `radius ${r1} → ${r2}`);

    /* ---- 5. 单击行星 → 信息面板 ---- */
    console.log("\n[5] 单击行星 → 右侧信息面板（含收起 / 展开）");
    const p0 = await page.evaluate(() => {
      const st = window.__game.getState();
      const pl = st.planets[0];
      return { name: pl.name, pos: window.__game.planetScreenPos(pl.name) };
    });
    await page.mouse.click(p0.pos.x, p0.pos.y);
    await sleep(300);
    const selP = await page.evaluate(() => window.__game.getState().selectedPlanet);
    const panel1 = await page.evaluate(() => {
      const el = document.getElementById("panel");
      const btns = [...document.querySelectorAll("#p-actions button")];
      const rows = [...document.querySelectorAll("#p-rows .p-row")];
      return {
        hidden: el.classList.contains("hidden"),
        kind: el.dataset.kind, name: el.dataset.name,
        rowCount: rows.length,
        secs: [...document.querySelectorAll("#p-rows .p-sec")].map((s) => s.textContent),
        // 键值对（避免「值里也含同样文字」造成的假绿灯）
        keys: rows.map((r) => (r.querySelector(".k") || {}).textContent || ""),
        text: document.getElementById("p-rows").textContent,
        btns: btns.length,
        disabled: btns.length > 0 && btns.every((b) => b.disabled)
      };
    });
    const KEY_NEED = ["分类", "半径", "质量", "构成", "平均密度", "表面重力", "逃逸速度",
      "轨道半径", "公转周期", "轨道速度", "恒星辐照",
      "自转周期", "平衡温度", "表面温度", "温度带", "大气", "表面"];
    const keyMiss = KEY_NEED.filter((k) => !panel1.keys.includes(k));
    check("单击行星 → 选中", selP === p0.name, `selected=${selP}`);
    check("面板展开且为行星数据", !panel1.hidden && panel1.kind === "planet" && panel1.name === p0.name);
    check("★ 行星数据分三区（物理量 / 轨道 / 自转与大气）",
      panel1.secs.length === 3 && panel1.secs.join("|") === "物理量|轨道|自转与大气", panel1.secs.join(" ｜ "));
    check("★ 17 项科学数据齐全", keyMiss.length === 0 && panel1.rowCount === KEY_NEED.length,
      keyMiss.length ? "缺 " + keyMiss.join("/") : `${panel1.rowCount} 行`);
    check("★ 「构成」行给出质量占比（含百分号）",
      /构成/.test(panel1.keys.join()) && /\d+%/.test(panel1.text), "含 N% 占比");
    check("行星面板无「卫星」行（v0.5 下线）", !panel1.text.includes("卫星"));
    check("操作按钮占位且禁用", panel1.btns >= 2 && panel1.disabled, `${panel1.btns} 个`);
    await shot(page, "n2-panel-planet.png");

    /* ★ 面板可收起（收起 = **整条面板向右侧收进去**，滑出视口右边缘，右边缘留一枚标签页）。
     *   判据是几何：收起后面板的左缘必须跑到视口宽之外（不是「把内容藏起来」——
     *   宽高与行数都不许变，只是收到屏幕外），标签坞里那一枚标签必须贴住右边缘。
     *   两个入口各管一个方向：标题条的「收起 →」只负责收（箭头指着收进去的方向）；
     *   收起来之后靠右边缘标签坞里的标签页拉回来。
     *   与下面那条「点空白 → 面板收起」是**两件事**：那是未选中时整条面板退场（.hidden，
     *   FSM_SELECT 的投影），这里是选中着但用户把面板收到右边去了（.folded，视图偏好）。
     *   所以这里连带验：取消选中不重置折叠偏好（标签坞跟着退场）、重新选中仍收在屏外。 */
    const readFold = () => page.evaluate(() => {
      const el = document.getElementById("panel");
      const b = document.getElementById("p-fold");
      const dock = document.getElementById("p-dock");
      const tab = document.querySelector("#p-dock .dock-tab");
      const r = el.getBoundingClientRect(), tr = tab.getBoundingClientRect();
      const W = window.innerWidth;
      return {
        foldLabel: b ? b.textContent.replace(/\s+/g, "") : "",
        folded: el.classList.contains("folded"),
        hiddenClass: el.classList.contains("hidden"),
        name: document.getElementById("p-name").textContent,
        rowCount: document.querySelectorAll("#p-rows .p-row").length,
        W, left: Math.round(r.left), right: Math.round(r.right),
        w: Math.round(r.width), h: Math.round(r.height),
        offRight: r.left >= W - 1,          /* 整条已收进右边缘外（收起态） */
        flushRight: r.right >= W - 1,       /* 展开态：右缘贴住窗口（右侧不留空隙） */
        fits: r.left >= -1 && r.right <= W + 1,   /* 整条在视口里（横向） */
        dock: {
          shown: getComputedStyle(dock).display !== "none",
          tabs: document.querySelectorAll("#p-dock .dock-tab").length,
          panel: tab.getAttribute("data-panel"),
          arrow: (tab.querySelector(".dk-arrow") || {}).textContent || "",
          label: (tab.querySelector(".dk-name") || {}).textContent || "",
          left: Math.round(tr.left), right: Math.round(tr.right), h: Math.round(tr.height)
        }
      };
    });

    const fold0 = await readFold();
    check("★ 标题条上是「收起 →」钮（箭头指着收进去的方向；默认展开态：整条在视口内、标签坞不占位）",
      fold0.foldLabel === "收起→" && !fold0.folded && fold0.fits && fold0.flushRight &&
      !fold0.dock.shown && fold0.rowCount === KEY_NEED.length,
      `钮「${fold0.foldLabel}」· 面板 ${fold0.w}×${fold0.h}px · 右缘贴到窗口（缝 ${fold0.W - fold0.right}px）`);

    /* ★ 「从右侧自然生出的一块」而不是浮卡：右侧不留空隙、不给右圆角、不描右边框。
     *   左侧两角仍是容器档 --r（8px）—— 只有「长出去」的那一头是方的。 */
    const seam = await page.evaluate(() => {
      const el = document.getElementById("panel");
      const c = getComputedStyle(el), r = el.getBoundingClientRect();
      return {
        gap: Math.round(window.innerWidth - r.right), right: Math.round(r.right), W: window.innerWidth,
        tl: c.borderTopLeftRadius, tr: c.borderTopRightRadius, br: c.borderBottomRightRadius,
        bw: c.borderRightWidth
      };
    });
    check("★ 面板贴住窗口右缘（右侧无空隙 / 无右圆角 / 无右边框）—— 读作「从右侧自然生出的一块」",
      seam.gap === 0 && parseFloat(seam.tr) === 0 && parseFloat(seam.br) === 0 &&
      parseFloat(seam.bw) === 0 && parseFloat(seam.tl) > 0,
      `右缘 ${seam.right} = 视口宽 ${seam.W} · 圆角 左 ${seam.tl} / 右 ${seam.tr} · 右边框 ${seam.bw}`);

    await page.click("#p-fold");
    await sleep(450);        /* 滑出过渡 0.2s：量的是终态 */
    const fold1 = await readFold();
    check("★ 收起 = 整条向右侧收进去（滑出视口右边缘），不是把内容叠起来",
      fold1.folded && fold1.offRight && fold1.rowCount === KEY_NEED.length,
      `左缘 ${fold1.left} ≥ 视口宽 ${fold1.W} · 面板 ${fold1.w}×${fold1.h}px 宽高原样`);
    check("★ 收起后右边缘出现标签坞：一枚竖排「面板」标签页、贴边可点（箭头指回拉出方向）",
      fold1.dock.shown && fold1.dock.tabs === 1 && fold1.dock.panel === "info" &&
      fold1.dock.arrow === "←" && fold1.dock.label === "面板" &&
      fold1.dock.right >= fold1.W - 1 && fold1.dock.left < fold1.W && fold1.dock.h > 30,
      `标签 x ${fold1.dock.left}..${fold1.dock.right}（视口宽 ${fold1.W}）· 高 ${fold1.dock.h}px · ${fold1.dock.tabs} 枚`);
    await shot(page, "n2b-panel-folded.png");

    const emptyPt = await findEmptyPoint(page);
    await page.mouse.click(emptyPt.x, emptyPt.y);
    await sleep(300);
    const cleared = await page.evaluate(() => {
      const el = document.getElementById("panel");
      return {
        sel: window.__game.getState().selectedPlanet,
        hidden: el.classList.contains("hidden"),
        folded: el.classList.contains("folded"),
        dockShown: getComputedStyle(document.getElementById("p-dock")).display !== "none"
      };
    });
    check("点空白 → 取消选中", cleared.sel === null);
    check("面板收起", cleared.hidden === true);
    check("★ 退场不重置折叠偏好（.hidden = 没选中，.folded = 收到右边，两层各管各的）",
      cleared.folded === true && cleared.dockShown === false,
      "folded 留着 → 下次选中直接从收起态开始；标签坞跟着退场（点不出空面板）");

    /* 行星在公转，位置要现取（p0.pos 是本节开头量的，中间隔着截图与几次点击） */
    const again = await page.evaluate((n) => window.__game.planetScreenPos(n), p0.name);
    await page.mouse.click(again.x, again.y);     /* 真点击：重新选中同一颗 */
    await sleep(300);
    const fold2 = await readFold();
    check("★ 折叠是视图偏好：重新选中仍收在屏外、标签坞回来、内容照常改写",
      !fold2.hiddenClass && fold2.folded && fold2.offRight && fold2.dock.shown &&
      fold2.name === p0.name && fold2.rowCount === KEY_NEED.length,
      `标题「${fold2.name}」· 面板仍在屏外 · 17 行原样`);

    await page.click("#p-dock .dock-tab");   /* 走标签坞这条入口，验它在屏幕最边缘也点得到 */
    await sleep(450);
    const fold3 = await readFold();
    check("★ 点标签坞里的标签页 → 面板滑回来（整条入屏、贴住右缘、17 行原样、标签坞退场）",
      fold3.fits && fold3.flushRight && !fold3.folded && fold3.rowCount === KEY_NEED.length &&
      !fold3.dock.shown && fold3.foldLabel === "收起→",
      `右缘 ${fold3.right} = 视口宽 ${fold3.W} · ${fold3.rowCount} 行 · 高 ${fold3.h}px`);

    /* ---- 6. 单击恒星 → 恒星面板 ---- */
    console.log("\n[6] 单击恒星 → 恒星面板");
    let starSel = null;
    for (let i = 0; i < 12; i++) {
      starSel = await page.evaluate(() => {
        const g = window.__game;
        const ss = g.starScreenPos();
        const st = g.getState();
        let clear = Infinity;
        for (const p of st.planets) {
          const sp = g.planetScreenPos(p.name);
          if (sp) clear = Math.min(clear, Math.hypot(sp.x - ss.x, sp.y - ss.y));
        }
        return { ss, clear: Math.round(clear) };
      });
      if (starSel.clear >= 90) break;
      await sleep(1000);
    }
    check("恒星可点区域无遮挡", starSel.clear >= 90, `最近行星 ${starSel.clear}px`);
    await page.mouse.click(starSel.ss.x, starSel.ss.y);
    await sleep(300);
    const panelStar = await page.evaluate(() => {
      const el = document.getElementById("panel");
      return {
        hidden: el.classList.contains("hidden"),
        kind: el.dataset.kind, name: el.dataset.name,
        sub: document.getElementById("p-sub").textContent,
        text: document.getElementById("p-rows").textContent
      };
    });
    const si0 = await page.evaluate(() => window.__game.starInfo());
    check("单击恒星 → 恒星面板", !panelStar.hidden && panelStar.kind === "star" && panelStar.name === st0.system, `kind=${panelStar.kind}`);
    check("面板含光谱型与实测值", panelStar.text.includes("光谱型") && panelStar.text.includes(si0.spec), `spec=${si0.spec}`);
    check("面板含温度 / 半径 / 质量 / 光度 / 活动性",
      ["表面温度", "半径", "质量", "光度", "活动性"].every((k) => panelStar.text.includes(k)));
    check("副标题标出天体类别", /恒星|亚恒星|致密天体/.test(panelStar.sub), `sub=${panelStar.sub}`);
    await shot(page, "n3-panel-star.png");

    /* ---- 7. 双击行星聚焦（v0.10 起 = 相机第三态 focus） ---- */
    console.log("\n[7] 双击聚焦");
    const target = await page.evaluate(() => {
      const st = window.__game.getState();
      const pl = st.planets[1] || st.planets[0];
      return { name: pl.name, pos: window.__game.planetScreenPos(pl.name) };
    });
    await page.mouse.dblclick(target.pos.x, target.pos.y);
    await sleep(150);
    const cam1 = await page.evaluate(() => window.__game.cameraState());
    check("双击行星 → 聚焦（v0.10：相机第三态 focus，不再只是 follow）",
      cam1.focus === target.name && cam1.goal < 60 && cam1.mode === "focus",
      `focus=${cam1.focus} goal=${cam1.goal} mode=${cam1.mode}`);
    await sleep(900);
    const cam2 = await page.evaluate(() => window.__game.cameraState());
    check("镜头平滑拉近", cam2.radius < cam1.radius - 3, `${cam1.radius} → ${cam2.radius}`);
    await sleep(1200);
    const follow = await page.evaluate((nm) => {
      const g = window.__game;
      const cs = g.cameraState();
      const wp = g.planetWorldPos(nm);
      return { d: +Math.hypot(cs.target.x - wp.x, cs.target.y - wp.y, cs.target.z - wp.z).toFixed(2) };
    }, target.name);
    check("镜头跟随行星", follow.d < 3.5, `target↔行星距离 ${follow.d}`);
    await shot(page, "n4-focus.png");

    /* ---- 8. 双击空白回全景 ---- */
    console.log("\n[8] 双击空白回全景");
    const emptyPt2 = await findEmptyPoint(page);
    await page.mouse.dblclick(emptyPt2.x, emptyPt2.y);
    await sleep(200);
    const camU = await page.evaluate(() => window.__game.cameraState());
    check("双击空白 → 取消聚焦", camU.focus === null && camU.goal === 92, `focus=${camU.focus} goal=${camU.goal}`);
    await sleep(1500);
    const camU2 = await page.evaluate(() => window.__game.cameraState());
    check("镜头拉回全景", camU2.radius > cam2.radius + 10, `${cam2.radius} → ${camU2.radius}`);

    /* ---- 9. 场景动态：公转 ---- */
    console.log("\n[9] 场景动态");
    const dyn0 = await page.evaluate(() => window.__game.planetAngle(window.__game.getState().planets[0].name));
    await sleep(1300);
    const dyn1 = await page.evaluate(() => window.__game.planetAngle(window.__game.getState().planets[0].name));
    check("行星公转推进", dyn1 !== dyn0, `angle ${dyn0} → ${dyn1}`);

    /* ---- 10. 恒星：干净球体 / 动态表面 / 柔光晕 ---- */
    console.log("\n[10] 恒星：干净球体 / 动态表面 / 柔光晕");
    await frameStar(page, 26);
    const si1 = await page.evaluate(() => window.__game.starInfo());
    console.log(`  ℹ 恒星「${si1.name}」 · ${si1.typeName}（${si1.spec}）· ${si1.tempK} K · ${si1.radiusSol} R☉ · 活动性 ${si1.preset.flareRate}`);
    check("恒星为动态着色器材质", si1.shader === true);
    check("材质参数由光谱型驱动", si1.uNoise === si1.preset.noise && si1.uSpot === si1.preset.spot, `noise=${si1.uNoise} / spot=${si1.uSpot}`);
    check("科学数据齐全", !!(si1.spec && si1.tempK > 0 && si1.radiusSol > 0 && si1.massSol > 0 && si1.lumSol > 0));
    check("柔光晕（内外双层精灵）", si1.halo === true);
    check("干净的球体（无冕流尖刺 / 日冕环 / 日珥弧）",
      si1.clean.streamer && si1.clean.coronas && si1.clean.prominences,
      JSON.stringify(si1.clean));
    await sleep(650);
    const si2 = await page.evaluate(() => window.__game.starInfo());
    check("表面流动持续推进", si2.uTime > si1.uTime + 0.2, `uTime ${si1.uTime} → ${si2.uTime}`);
    await shot(page, "n5-star-close.png");

    /* ---- 11. ★ 星型库：15 种，取值全部落在科学区间 ---- */
    console.log("\n[11] 星型库：取值区间校验");
    const lib = await page.evaluate(() => window.__game.starTypeTable());
    check("星型库共 15 种", lib.length === 15, `${lib.length} 种`);
    check("id 唯一", new Set(lib.map((t) => t.id)).size === lib.length);
    check("每型均有中文名 / 光谱型 / 颜色", lib.every((t) => t.name && t.spec && /^#[0-9a-f]{6}$/.test(t.color)));

    const oob = [];
    const KEYS = ["tempK", "radiusSol", "massSol", "lumSol"];
    for (const t of lib) {
      const R = RANGES[t.id];
      if (!R) { oob.push(`${t.id} 无区间定义`); continue; }
      for (const k of KEYS) {
        const v = t[k], [lo, hi] = R[k];
        if (!(v >= lo && v <= hi)) oob.push(`${t.id}.${k}=${v} ∉ [${lo}, ${hi}]`);
      }
    }
    check("★ 15 种取值全部落在科学区间", oob.length === 0, oob.slice(0, 4).join(" | ") || "全部合规");

    /* 斯特藩-玻尔兹曼自洽：L = 4πR²σT⁴（黑洞无固有辐射，跳过；容差 4×） */
    const sbBad = [];
    const T_SUN = 5780;
    for (const t of lib) {
      if (t.id === "BH") continue;
      const expect = Math.pow(t.radiusSol, 2) * Math.pow(t.tempK / T_SUN, 4);
      const ratio = expect / t.lumSol;
      if (ratio > 4 || ratio < 0.25) sbBad.push(`${t.id}: 期望 ${expect.toExponential(2)} vs 登记 ${t.lumSol}（${ratio.toFixed(1)}×）`);
    }
    check("★ 光度与半径/温度自洽（L = 4πR²σT⁴，±4× 容差）", sbBad.length === 0, sbBad.slice(0, 3).join(" | ") || "全部自洽");

    const wSum = lib.reduce((a, t) => a + t.w, 0);
    const wM = lib.find((t) => t.id === "M").w / wSum;
    const wRare = (lib.find((t) => t.id === "O").w + lib.find((t) => t.id === "NS").w + lib.find((t) => t.id === "BH").w) / wSum;
    check("权重贴近真实统计（M 最多 · O/NS/BH 稀有）", wM > 0.5 && wRare < 0.002,
      `M=${(wM * 100).toFixed(1)}% · O+NS+BH=${(wRare * 100).toFixed(3)}%`);

    /* ★ 确定性守恒锚点（与 scripts/roll-check.mjs 的静态复算对账）
     * rngDraws = 抽到星型时主 RNG 的累计抽数。它一变就说明贴图段多抽/少抽了，
     * 全序列已漂移 —— 此时必须回去重新校准星型权重（见 README「确定性守恒」）。 */
    check("★ 主 RNG 抽数锚点未漂移（884 抽）", st0.rngDraws === 884, `实测 ${st0.rngDraws} 抽 / 期望 884`);
    check("★ 星系抽值仍为锚定值 0.374455", st0.starRoll === 0.374455, `实测 ${st0.starRoll}`);
    check("★ 抽值稳定命中 M 型（薄曙不漂移）", st0.starId === "M" && st0.system === "薄曙",
      `roll=${st0.starRoll} → ${st0.starId} · 星系「${st0.system}」`);

    /* ---- 12. ★ 星型切换：15 种逐一预览 ---- */
    console.log("\n[12] 星型切换：15 种逐一预览（视觉 / 光照 / 面板同步）");
    await frameStar(page, 30);
    const ssPos = await page.evaluate(() => window.__game.starScreenPos());
    await page.mouse.click(ssPos.x, ssPos.y);   // 选中恒星，面板随类型刷新
    await sleep(300);

    const sweepBad = [];
    for (const t of lib) {
      const r = await page.evaluate((id) => {
        const ok = window.__game.setStarType(id);
        const si = window.__game.starInfo();
        const sv = window.__game.starVis();
        const ss = window.__game.sceneStats();
        const el = document.getElementById("panel");
        return {
          ok, typeId: si.typeId, spec: si.spec, klass: sv.klass,
          hasPlasma: sv.hasPlasma, hasPhoton: sv.hasPhoton, halo: sv.halo,
          light: sv.light, flareRate: sv.flareRate, star: ss.star,
          panelKind: el.dataset.kind, sub: document.getElementById("p-sub").textContent,
          rows: document.getElementById("p-rows").textContent
        };
      }, t.id);
      if (!r.ok) { sweepBad.push(`${t.id} 切换失败`); continue; }
      if (r.typeId !== t.id || r.spec !== t.spec) sweepBad.push(`${t.id} 类型/光谱型未同步`);
      if (!r.star || !r.halo) sweepBad.push(`${t.id} 星体或光晕缺失`);
      // 面板副标题须带上该型中文名（致密天体走「类别」行，不含光谱型字面量）
      if (!r.panelKind || r.panelKind !== "star" || !r.sub.includes(t.name)) {
        sweepBad.push(`${t.id} 面板未刷新（sub=${r.sub}）`);
      }
      if (t.id === "BH") {
        if (r.hasPlasma) sweepBad.push("BH 不应生成等离子表面");
        if (!r.hasPhoton) sweepBad.push("BH 缺光子环");
        if (r.flareRate !== 0) sweepBad.push("BH 不应有耀斑");
      } else {
        if (!r.hasPlasma) sweepBad.push(`${t.id} 缺等离子表面`);
        if (t.id === "NS" && r.flareRate !== 0) sweepBad.push("NS 不应有耀斑");
      }
    }
    check("★ 15 种全部可切换且状态同步（零异常）", sweepBad.length === 0, sweepBad.slice(0, 4).join(" | ") || "15/15 通过");

    /* 关键 klass 的视觉差异抽查 */
    const bhd = await page.evaluate(() => { window.__game.setStarType("BH"); return window.__game.starVis(); });
    check("黑洞：无等离子表面 + 光子环 + 暖色吸积光", bhd.hasPlasma === false && bhd.hasPhoton === true && bhd.klass === "bh");
    await shot(page, "n8-type-bh.png");
    const nsd = await page.evaluate(() => { window.__game.setStarType("NS"); return window.__game.starVis(); });
    check("中子星：等离子表面 + 无耀斑（脉冲自发光）", nsd.hasPlasma === true && nsd.flareRate === 0);
    await shot(page, "n9-type-ns.png");
    const rsg = await page.evaluate(() => { window.__game.setStarType("RSG"); return { v: window.__game.starVis(), i: window.__game.starInfo() }; });
    check("红超巨星：半径 ≫ 主序（800 R☉）", rsg.i.radiusSol > 400, `${rsg.i.radiusSol} R☉`);
    await shot(page, "n10-type-rsg.png");
    await page.evaluate(() => window.__game.setStarType("M"));
    const back = await page.evaluate(() => window.__game.starInfo());
    check("切回 M 型（恢复正常星系）", back.typeId === "M" && back.spec === "M5V", `${back.typeId}/${back.spec}`);

    /* ---- 13. ★ 选中效果 ---- */
    console.log("\n[13] 选中效果：白色括号 + 扫描环");
    await page.evaluate(() => window.__game.clearSelection());
    await frameStar(page, 30);
    const fx0 = await page.evaluate(() => window.__game.selectionFx());
    check("未选中时无标记", fx0.star.visible === false && fx0.star.opacity < 0.05, `opacity=${fx0.star.opacity}`);

    const ssP = await page.evaluate(() => window.__game.starScreenPos());
    await page.mouse.click(ssP.x, ssP.y);
    await sleep(600);
    const fx1 = await page.evaluate(() => window.__game.selectionFx());
    await sleep(320);
    const fx2 = await page.evaluate(() => window.__game.selectionFx());
    check("选中恒星 → 括号淡入", fx1.star.visible === true && fx1.star.opacity > 0.25, `opacity=${fx1.star.opacity}`);
    check("选中标记是精灵（不是环状网格）", fx1.star.isSprite === true);
    check("括号呼吸（透明度随时间起伏）", fx1.star.opacity !== fx2.star.opacity, `${fx1.star.opacity} → ${fx2.star.opacity}`);
    check("细环同步出现且缓慢扫描", fx1.starRing.visible === true && fx1.starRing.rot !== fx2.starRing.rot,
      `rot ${fx1.starRing.rot} → ${fx2.starRing.rot}`);
    await shot(page, "n11-select-star.png");

    const plT = await page.evaluate(() => {
      const p = window.__game.getState().planets[0];
      return { pos: window.__game.planetScreenPos(p.name) };
    });
    await page.mouse.click(plT.pos.x, plT.pos.y);
    await sleep(500);
    const fxp = await page.evaluate(() => window.__game.selectionFx());
    check("选中行星 → 行星括号淡入、恒星括号退场",
      fxp.planet.visible === true && fxp.planet.opacity > 0.25 && fxp.star.visible === false,
      `planet=${fxp.planet.opacity} star=${fxp.star.opacity}`);

    /* ---- 14. ★ 指导书：栏目化（v0.6.1） ---- */
    console.log("\n[14] 指导书：左栏导航 + 右栏单栏渲染（导言 + 恒星篇 6 + 行星篇 6）");
    await page.evaluate(() => window.__game.clearSelection());
    await page.click("#guide-btn");          // 真实点击
    await sleep(350);
    const shell = await page.evaluate(() => {
      const el = document.getElementById("guide");
      const nav = document.getElementById("guide-nav");
      const body = document.getElementById("guide-body");
      const items = [...nav.querySelectorAll(".gn-item")];
      return {
        open: window.__game.guideOpen(),
        display: getComputedStyle(el).display,
        info: window.__game.guideInfo(),
        navLabels: items.map((b) => b.textContent),
        navParts: [...nav.querySelectorAll(".g-part")].map((p) => p.textContent),
        onIdx: items.findIndex((b) => b.classList.contains("on")),
        bodySecs: body.querySelectorAll(".g-sec").length,
        navW: Math.round(nav.getBoundingClientRect().width),
        bodyW: Math.round(body.getBoundingClientRect().width),
        navRight: getComputedStyle(nav).borderRightWidth,
        toc: body.querySelectorAll(".gt-item").length
      };
    });
    check("点击「天体指导书」→ 覆盖层展开", shell.open === true && shell.display === "flex");
    check("★ 左栏 13 栏（导言 + 恒星篇 6 + 行星篇 6）",
      shell.navLabels.length === 13 && shell.info.count === 13,
      shell.navLabels.length + " 栏：" + shell.navLabels.slice(0, 4).join(" / ") + " …");
    check("★ 左栏两个篇分隔（恒星篇 / 行星篇）", shell.navParts.join("|") === "恒 星 篇|行 星 篇",
      shell.navParts.join(" ｜ "));
    check("★ 右栏一次只渲染一栏 —— 不再是一页长卷", shell.bodySecs === 1, `右栏 ${shell.bodySecs} 节`);
    check("左栏 / 右栏并排（导航有宽度 + 分隔线）",
      shell.navW >= 150 && shell.bodyW > shell.navW && parseFloat(shell.navRight) >= 1,
      `导航 ${shell.navW}px ／ 正文 ${shell.bodyW}px`);
    check("默认落在「导言」，页内目录 = 12 栏", shell.onIdx === 0 && shell.toc === 12,
      `on=${shell.onIdx} 目录 ${shell.toc} 条`);

    /* 真实点击左栏逐栏巡览：每栏读一次 DOM，顺带累计全书内容（一栏落地一次 = 内容都在） */
    const per = [];
    for (let i = 0; i < 13; i++) {
      await page.click(`#guide-nav .gn-item[data-goto="${i}"]`);
      await sleep(90);
      per.push(await page.evaluate(() => {
        const body = document.getElementById("guide-body");
        const sec = body.querySelector(".g-sec");
        const pager = body.querySelector(".g-page");
        const btns = pager ? [...pager.querySelectorAll(".gp-btn")] : [];
        return {
          secs: body.querySelectorAll(".g-sec").length,
          title: sec ? sec.querySelector("h3").textContent : "",
          crumb: (body.querySelector(".g-crumb") || {}).textContent || "",
          on: document.querySelector("#guide-nav .gn-item.on").getAttribute("data-goto"),
          tables: body.querySelectorAll(".g-tbl").length,
          rows: body.querySelectorAll(".g-tbl tbody tr").length,
          chips: body.querySelectorAll(".g-chip").length,
          pChips: body.querySelectorAll(".g-chip.col").length,
          cur: body.querySelectorAll(".g-chip.cur").length,
          subs: body.querySelectorAll(".g-sub").length,
          figs: body.querySelectorAll(".g-fig svg").length,
          figCur: body.querySelectorAll(".g-fig .fg-cur").length,
          figOverflow: [...body.querySelectorAll(".g-fig svg")].some((s) => s.getBoundingClientRect().width > body.clientWidth + 1),
          mid: (body.querySelector(".gp-mid") || {}).textContent || "",
          prevOff: btns[0] ? btns[0].disabled : false,
          scrollTop: body.scrollTop,
          scrollable: body.scrollHeight > body.clientHeight,
          bookH: Math.round(document.querySelector(".g-book").getBoundingClientRect().height),
          navH: Math.round(document.getElementById("guide-nav").getBoundingClientRect().height),
          bodyH: Math.round(body.getBoundingClientRect().height),
          text: body.textContent
        };
      }));
    }
    const sum = (f) => per.reduce((a, x) => a + f(x), 0);
    const allText = per.map((x) => x.text).join("\n");
    check("★ 巡览 13 栏：每栏落地都是 1 节（其余不渲染）", per.every((x) => x.secs === 1),
      per.map((x) => x.secs).join(""));
    check("★ 高亮跟随点击（点第 n 栏 → 左栏第 n 项高亮）", per.every((x, i) => x.on === String(i)),
      per.map((x) => x.on).join(""));
    check("★ 标题与栏目清单一一对应（无重复 / 无遗漏）",
      per.map((x) => x.title).join("|") === shell.info.titles.join("|"));
    check("★ 篇脚注正确（导言无脚注，其余各栏等于所属篇）",
      per[0].crumb === "" && per.slice(1, 7).every((x) => x.crumb === "恒 星 篇") &&
      per.slice(7).every((x) => x.crumb === "行 星 篇"));
    check("★ 全书累计 13 张表 / ≥ 55 行", sum((x) => x.tables) === 13 && sum((x) => x.rows) >= 55,
      `${sum((x) => x.tables)} 张 / ${sum((x) => x.rows)} 行`);
    check("★ 星型库 15 种 · 行星库 16 型", per[6].chips === 15 && per[12].pChips === 16,
      `星型 ${per[6].chips} · 行星 ${per[12].pChips}`);
    check("★ 16 型全部写有「构成：」文案", (per[12].text.match(/构成：/g) || []).length === 16,
      `出现 ${(per[12].text.match(/构成：/g) || []).length} 次`);
    check("★ 栏内小标题 3 个（九章 2 + 十一章 1，目录篇名不计入）", sum((x) => x.subs) === 3,
      `合计 ${sum((x) => x.subs)} 个：九=${per[9].subs} 十一=${per[11].subs}`);
    check("当前星型 / 本星系行星各打「本星系」标", per[6].cur === 1 && per[12].cur >= 1,
      `星型库 ${per[6].cur} · 行星库 ${per[12].cur}`);
    check("★ 科普插图 3 张（栏目一 光谱序列 / 二 赫罗图 / 五 演化归宿）",
      per[1].figs === 1 && per[2].figs === 1 && per[5].figs === 1 && sum((x) => x.figs) === 3,
      `插图分布：${per.map((x, i) => (x.figs ? i : "")).filter(Boolean).join(" / ")}`);
    check("★ 三张图都在书里标出本星系的恒星（高亮格 / 标记点 / 白框行）",
      per[1].figCur === 1 && per[2].figCur === 1 && per[5].figCur >= 1,
      `cur 元素：光谱 ${per[1].figCur} · 赫罗 ${per[2].figCur} · 归宿 ${per[5].figCur}`);
    check("插图不撑破正文栏（SVG 自适应宽度）", per.every((x) => !x.figOverflow));

    /* ★ 插图配色审计：SVG 里的 CSS 变量必须真的解析出来。
     * 陷阱：写了一个本页没有的变量（如 var(--color-text-primary)）→ 声明无效 → fill 回退成
     * **初始值黑色** → 黑字画在近黑底上 = 看着像「图没画出来」。所以逐类抽查实际填充色。 */
    await page.click('#guide-nav .gn-item[data-goto="2"]');
    await sleep(200);
    const figCss = await page.evaluate(() => {
      const fig = document.querySelector(".g-fig");
      const rgb = (el) => (el ? getComputedStyle(el).fill : "");
      const parse = (c) => (/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c) || [, 0, 0, 0]).slice(1).map(Number);
      const hi = rgb(fig.querySelector("text.fg-hi")), lo = rgb(fig.querySelector("text.fg-lo"));
      const plain = rgb(fig.querySelector("svg > text"));
      const zone = getComputedStyle(fig.querySelector(".fg-zone"));
      return {
        hi, lo, plain,
        hiOk: parse(hi).every((v) => v === 255),
        visOk: [lo, plain].every((c) => { const p = parse(c); return p[0] === p[1] && p[1] === p[2] && p[0] > 90; }),
        zoneFill: zone.fill, zoneStroke: zone.stroke,
        cap: (fig.querySelector("figcaption") || {}).textContent || ""
      };
    });
    check("★ 插图强调文字 = 纯白（变量已解析，不是回退黑）", figCss.hiOk, `fill=${figCss.hi}`);
    check("★ 插图正文 / 脚注 = 灰阶且够亮（黑底上看得见）", figCss.visOk, `正文 ${figCss.plain} · 脚注 ${figCss.lo}`);
    check("插图区域框用书中变量着色（无新色相）",
      figCss.zoneFill.startsWith("rgba(255, 255, 255") && figCss.zoneStroke === "rgb(42, 42, 42)",
      `${figCss.zoneFill} / ${figCss.zoneStroke}`);
    check("★ 图注写明本星系恒星在图上的落点", /本星系/.test(figCss.cap) && /落在/.test(figCss.cap),
      figCss.cap.slice(0, 46) + "…");
    check("翻页条：第 n ÷ 13 栏 + 首页禁用「上一栏」",
      per[0].prevOff === true && per[0].mid === "1 ÷ 13" && per[6].mid === "7 ÷ 13" && per[12].mid === "13 ÷ 13",
      `${per[0].mid} / ${per[6].mid} / ${per[12].mid}`);
    check("换栏后正文回到顶部", per.every((x) => x.scrollTop <= 2), per.map((x) => x.scrollTop).join(","));
    /* ★ 书页高度固定：13 栏的短长差异极大（导言 vs 行星库），逐栏量一次，必须一模一样 */
    check("★ 书页高度固定 —— 不随栏目长短伸缩",
      new Set(per.map((x) => x.bookH)).size === 1 && per[0].bookH === 900 - 72,
      `量到 ${[...new Set(per.map((x) => x.bookH))].join(" / ")}px（视口 900 − 上下 36px 边距）`);
    check("左栏与正文等高（各占一半 .g-main，各自滚动）",
      per.every((x) => Math.abs(x.navH - x.bodyH) <= 1 && x.bodyH > 600),
      `导航 ${per[0].navH}px ／ 正文 ${per[0].bodyH}px`);
    check("长栏（行星库 16 型）超出可视区、可滚动", per[12].scrollable === true);
    check("★ 行星篇含量化资料（三种储库 / 相态分档 / 混合密度 / 两条梯度 / 雪线）",
      ["铁镍核", "硅酸盐幔", "挥发分", "水冰", "液态水", "水汽", "已蒸干",
        "混合密度", "金属丰度", "雪线", "宜居带", "开普勒"].every((k) => allText.includes(k)));
    check("科普内容含光谱序列 / 光度级 / 褐矮星 / 致密天体 / 演化归宿",
      ["O5V", "M5V", "超巨星", "褐矮星", "白矮星", "中子星", "黑洞", "初始质量"].every((k) => allText.includes(k)));

    /* 三屏留念：导言（目录 + 左栏）／九章构成／十一章实测／十二章行星库 */
    const gotoShot = async (idx, name) => {
      await page.click(`#guide-nav .gn-item[data-goto="${idx}"]`);
      await sleep(280);
      await page.screenshot({ path: path.join(SHOTS, name) });
      console.log(`  📷 ${name}`);
    };
    await gotoShot(2, "n16-guide-hr.png");     // 赫罗图（插图样张，顺带留档）
    await gotoShot(0, "n12-guide.png");
    await gotoShot(9, "n13-guide-compose.png");
    await gotoShot(11, "n15-guide-measure.png");
    await gotoShot(12, "n14-guide-planets.png");

    /* ← → 键翻栏（书开着时键盘归书） */
    await page.keyboard.press("ArrowLeft");
    await sleep(160);
    const kL = await page.evaluate(() => window.__game.guideInfo().sel);
    check("← 键翻到上一栏", kL === 11, `sel=${kL}`);
    await page.keyboard.press("ArrowRight");
    await sleep(160);
    await page.keyboard.press("ArrowRight");
    await sleep(160);
    const kR = await page.evaluate(() => window.__game.guideInfo().sel);
    check("→ 键翻到下一栏（末栏不越界）", kR === 12, `sel=${kR}`);

    await page.keyboard.press("Escape");
    await sleep(250);
    check("Esc 关闭指导书", (await page.evaluate(() => window.__game.guideOpen())) === false);

    await page.click("#guide-btn");
    await sleep(250);
    check("★ 栏目记忆：重开回到上次读到的那一栏",
      (await page.evaluate(() => window.__game.guideInfo().sel)) === 12,
      `上次停在 13 ÷ 13`);
    await page.click("#guide-close");
    await sleep(250);
    check("× 按钮关闭指导书", (await page.evaluate(() => window.__game.guideOpen())) === false);

    await page.click("#guide-btn");
    await sleep(250);
    await page.mouse.click(60, 820);          // 书页之外的遮罩
    await sleep(250);
    check("点击背景遮罩关闭", (await page.evaluate(() => window.__game.guideOpen())) === false);

    /* ---- 15. 耀斑爆发 ---- */
    console.log("\n[15] 耀斑爆发");
    await frameStar(page, 26);
    const fired0 = await page.evaluate(() => window.__game.starInfo().flaresFired);
    await page.evaluate(() => window.__game.triggerFlare());
    await sleep(260);
    const fa = await page.evaluate(() => window.__game.starInfo());
    check("耀斑触发（计数递增）", fa.flaresFired > fired0, `${fired0} → ${fa.flaresFired}`);
    check("耀斑粒子正在喷发", fa.flareActive === true);
    await page.screenshot({ path: path.join(SHOTS, "n6-flare.png") });
    console.log("  📷 n6-flare.png");

    /* ---- 16. 镜头光斑 ---- */
    console.log("\n[16] 镜头光斑（科幻光学）");
    await page.evaluate(() => {
      window.__game.holdTarget(true);
      window.__game.setTarget(20, 0, 0);
      window.__game.zoomTo(72);
    });
    await sleep(600);
    const lf = await page.evaluate(() => window.__game.lensFlareState());
    const off = Math.hypot(lf.star.x, lf.star.y);
    check("光斑可见（恒星在画内）", lf.visible === true, `star ndc (${lf.star.x}, ${lf.star.y})`);
    check("恒星偏离画面中心", off > 0.05, `偏移 ${off.toFixed(3)}`);
    check("鬼影 ≥ 3", lf.ghosts.length >= 3, `${lf.ghosts.length} 个`);
    const opp = lf.ghosts.every((g) => g.x * lf.star.x + g.y * lf.star.y < 0);
    check("鬼影位于光源对侧（光学正确）", opp, lf.ghosts.map((g) => `(${g.x},${g.y})`).join(" "));
    await shot(page, "n7-lens-flare.png");

    /* v0.11.1 光学修正：光源被行星挡住 → 光斑必须熄灭。
     * 摆法：相机放到「最大行星的背光外侧」，让 相机—行星—恒星 三点共线，
     * 恒星的投影点落进行星投影圆盘正中 —— 此前光斑会隔着行星画出来（假）。 */
    const occPlanet = await page.evaluate(() => {
      const st = window.__game.getState();
      const pl = st.planets.reduce((a, b) => (b.size > a.size ? b : a));
      const p = window.__game.planetWorldPos(pl.name);
      const L = Math.hypot(p.x, p.y, p.z) || 1;
      window.__game.holdTarget(true);
      window.__game.setTarget(p.x, p.y, p.z);
      window.__game.setOrbitAngles(Math.atan2(p.x, p.z), Math.acos(Math.max(-1, Math.min(1, p.y / L))));
      window.__game.zoomTo(30);
      return pl.name;
    });
    await sleep(500);
    const lf2 = await page.evaluate(() => window.__game.lensFlareState());
    check(
      "光源被行星挡住 → 光斑熄灭（v0.11.1）",
      lf2.visible === false && lf2.occl > 0.9,
      `挡光行星 ${occPlanet} · occl=${lf2.occl}`
    );
    await page.evaluate(() => {
      window.__game.holdTarget(false);
      window.__game.setTarget(0, 0, 0);
    });
    await page.evaluate(() => window.__game.holdTarget(false));

    /* ---- 17. ★ 行星物理：四项优化的机器判据 ---- */
    console.log("\n[17] ★ 行星物理 / 构成 / 轨道（四项优化的机器判据）");

    /* 本节的立场：不核对「代码里写的常数」，而是**用公式独立复算一遍**，
     * 再和页面里跑出来的数对账。公式一律照抄教科书，常数写死在断言里
     * （AU_KM / R☉→AU / 地球 g / 地球 v_esc / 混合密度用的三种材料密度），
     * 因此只要有人把 game.js 里的公式改错，这里立刻红。 */
    const AU_KM = 1.495978707e8, R_SOL_AU = 0.00465047;
    const RHO_I = 7.87, RHO_S = 3.3, RHO_V = 1.0, IRON_E = 0.32;
    const RHO_REF_INV = IRON_E / RHO_I + (1 - IRON_E) / RHO_S;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6) * Math.max(1, Math.abs(b));

    const pd = await page.evaluate(() => window.__game.planetData());
    const si17 = await page.evaluate(() => window.__game.starInfo());
    console.log(`  ℹ ${pd.length} 颗行星 · 恒星「${si17.name}」${si17.typeName} ${si17.tempK} K / ${si17.radiusSol} R☉ / ${si17.lumSol} L☉`);
    for (const p of pd) {
      console.log(`     ${p.name.replace(si17.name + " ", "")}  ${p.typeName.padEnd(6)}  ` +
        `a=${p.au.toFixed(4)}AU  T_eq=${Math.round(p.teq)}→T_surf=${Math.round(p.tempSurf)}K  ` +
        `R=${p.rE.toFixed(2)}R⊕  M=${p.mE >= 100 ? Math.round(p.mE) : p.mE.toFixed(2)}M⊕  ` +
        `ρ=${p.dens.toFixed(2)}  g=${p.g.toFixed(1)}  ${p.comp.map((c) => c[0] + c[1] + "%").join("·")}`);
    }

    /* ⑤ 先查数值完整性：NaN 会静默穿过 toFixed 与比较运算，把断言变成假绿灯 */
    const nanBad = [];
    for (const p of pd) {
      for (const k of ["au", "teq0", "teq", "tempSurf", "rE", "mE", "radiusKm", "dens", "g", "vEsc",
        "periodDays", "vOrbit", "orbitSpeed", "rotH", "insol", "iron", "water", "metal", "compSum"]) {
        if (!Number.isFinite(p[k])) nanBad.push(`${p.name}.${k}=${p[k]}`);
      }
    }
    check("★ 行星全字段为有限数（NaN 不得静默传播）", nanBad.length === 0,
      nanBad.slice(0, 4).join(" | ") || `${pd.length} 颗 × 19 项`);

    /* ① 表面温度：取决于恒星与距离 */
    const tBad = [];
    for (const p of pd) {
      const teq = p.star.tempK * Math.pow(1 - p.albedo, 0.25) * Math.sqrt(p.star.radiusSol / (2 * (p.au / R_SOL_AU)));
      if (!near(teq, p.teq, 1e-6)) tBad.push(`${p.name} T_eq ${Math.round(p.teq)} ≠ 复算 ${Math.round(teq)}`);
      if (!near(p.teq * p.green, p.tempSurf, 1e-9)) tBad.push(`${p.name} T_surf ${Math.round(p.tempSurf)} ≠ T_eq×${p.green}`);
      const S = p.star.lumSol / (p.au * p.au);
      if (!near(S, p.insol, 1e-9)) tBad.push(`${p.name} 辐照 ${p.insol} ≠ L/a² ${S}`);
      const teq0 = p.star.tempK * Math.pow(1 - 0.30, 0.25) * Math.sqrt(p.star.radiusSol / (2 * (p.au / R_SOL_AU)));
      if (!near(teq0, p.teq0, 1e-6)) tBad.push(`${p.name} T_eq0 ${Math.round(p.teq0)} ≠ 复算 ${Math.round(teq0)}`);
    }
    check("★ 平衡/表面温度 · 辐照由「恒星 + 距离」独立复算通过", tBad.length === 0,
      tBad.slice(0, 3).join(" | ") || `T_eq = T★(1−A)^¼√(R★/2a) · T_surf = T_eq×温室系数 · S = L★/a²`);

    const temps = pd.map((p) => p.teq0);
    const mono = temps.every((t, i) => i === 0 || t <= temps[i - 1] + 1e-9);
    check("★ 离恒星越远 T_eq0 越低（单调性）", mono,
      temps.map((t) => Math.round(t)).join(" K → ") + " K");

    /* ③ 构成：三项整数百分比，和恰好 100，且由成分独立复算质量 */
    const cBad = [], mBad = [], phaseBad = [];
    const VOL_STATES = ["水冰", "冰水", "液态水", "水汽", "挥发分（被剥离）", "挥发分（已蒸干）"];
    for (const p of pd) {
      if (p.comp.length !== 3) cBad.push(`${p.name} 项数 ${p.comp.length}`);
      if (p.compSum !== 100) cBad.push(`${p.name} 和 ${p.compSum}`);
      if (!p.comp.every((a) => Number.isInteger(a[1]) && a[1] >= 0)) cBad.push(`${p.name} 非整数占比`);
      if (!p.comp.every((a) => a[0] && a[0].length >= 2)) cBad.push(`${p.name} 有空标签`);

      if (p.bulk === "rock") {
        // 质量：R^3.57 基准 × 混合密度比（1/ρ = Σxᵢ/ρᵢ）—— 与 game.js 各自独立算一遍
        const iron = cl(0.06 + 0.86 * p.metal, 0.03, 0.70);
        const vol = Math.max(cl((p.water - 0.45) * 0.75, 0, 0.40) * (p.atmoP === "无" ? 0.12 : 1), 0.008);
        let sil = 1 - iron - vol, ir2 = iron;
        if (sil < 0.05) { sil = 0.05; ir2 = Math.max(0.03, 1 - sil - vol); }
        const ratio = cl(RHO_REF_INV / (ir2 / RHO_I + sil / RHO_S + vol / RHO_V), 0.60, 1.45);
        const base = p.rE <= 1.5 ? Math.pow(p.rE, 3.57) : 5.06 * Math.pow(p.rE / 1.5, 2);
        if (!near(base * ratio, p.mE, 1e-9)) mBad.push(`${p.name} M ${p.mE.toFixed(4)} ≠ 复算 ${(base * ratio).toFixed(4)}`);
        // 面板上的构成占比必须就是这套分量（四舍五入后）
        const got = { 铁镍核: ir2, 硅酸盐幔: sil, VOL: vol };
        for (const a of p.comp) {
          const exp = a[0] === "铁镍核" ? got.铁镍核 : (a[0] === "硅酸盐幔" ? got.硅酸盐幔 : got.VOL);
          if (Math.abs(a[1] - exp * 100) > 1.0001) cBad.push(`${p.name} ${a[0]} ${a[1]}% ≠ ${(exp * 100).toFixed(1)}%`);
        }
        // 相态：三档优先级 —— 蒸干(≥900K) > 被剥离(无大气且贫挥发分) > 温度相态
        const vs = p.tempSurf < 200 ? "水冰" : (p.tempSurf < 273 ? "冰水" : (p.tempSurf <= 373 ? "液态水" : "水汽"));
        const want17 = p.tempSurf >= 900 ? "挥发分（已蒸干）"
          : ((p.atmoP === "无" && p.water < 0.55) ? "挥发分（被剥离）" : vs);
        const label = (p.comp.find((a) => VOL_STATES.includes(a[0])) || ["?"])[0];
        if (label !== p.volLabel) phaseBad.push(`${p.name} comp 标签 ${label} ≠ volLabel ${p.volLabel}`);
        if (p.volLabel !== want17) phaseBad.push(`${p.name} ${Math.round(p.tempSurf)}K/${p.atmoP} → ${p.volLabel} ≠ ${want17}`);
      } else {
        const heavy = cl(30 / (1 + p.mE / 50), 3, 28);
        const want = p.typeId === "icegiant"
          ? { 水氨甲烷幔: 100 - cl(9 - 3 * (p.mE / 17), 2, 9) - cl(13 + 3 * (p.mE / 17), 13, 18), 岩石核: cl(13 + 3 * (p.mE / 17), 13, 18), "H₂·He": cl(9 - 3 * (p.mE / 17), 2, 9) }
          : { "H₂·He": 100 - heavy, 水氨冰: heavy * 0.55, 岩石核: heavy * 0.45 };
        for (const a of p.comp) {
          if (!(a[0] in want)) { cBad.push(`${p.name} 未知储库 ${a[0]}`); continue; }
          if (Math.abs(a[1] - want[a[0]]) > 1.0001) cBad.push(`${p.name} ${a[0]} ${a[1]}% ≠ ${want[a[0]].toFixed(1)}%`);
        }
      }
    }
    check("★ 构成：恰好 3 项 · 整数百分比 · 和为 100 · 与公式吻合", cBad.length === 0,
      cBad.slice(0, 3).join(" | ") || pd.map((p) => p.comp.map((a) => a[1]).reduce((x, y) => x + y, 0)).join("/"));
    check("★ 质量由「半径 + 构成」独立复算通过（构成真的进了公式）", mBad.length === 0,
      mBad.slice(0, 3).join(" | ") || "M = R^3.57 × 混合密度比（岩质全部吻合）");
    check("★ 挥发分相态随表面温度（构成受温度约束）", phaseBad.length === 0,
      phaseBad.slice(0, 3).join(" | ") || pd.filter((p) => p.bulk === "rock").map((p) => Math.round(p.tempSurf) + "K→" + p.volLabel).join(" · "));

    /* ② 行星分类必须是「抽值 → 表序扫描」推出来的，而不是写死的 */
    const typeTbl = await page.evaluate(() => window.__game.planetTypeTable());
    const resolveInVerify = (c) => {
      for (const t of typeTbl) {
        if (t.kind !== c.bulk) continue;
        if (c.teq0 < t.t0 || c.teq0 >= t.t1) continue;
        if (t.water && !(c.water >= t.water[0] && c.water < t.water[1])) continue;
        if (t.metal !== null && c.metal < t.metal) continue;
        if (t.atmoMin !== null && c.atmo < t.atmoMin) continue;
        if (t.atmoMax !== null && c.atmo >= t.atmoMax) continue;
        if (t.rMax !== null && c.rE >= t.rMax) continue;
        if (t.carbon && !c.carbon) continue;
        return t.id;
      }
      return "barren";                       // 表内全不中 → 兜底型
    };
    const winBad = [];
    for (const p of pd) {
      const gotId = resolveInVerify(p);
      if (gotId !== p.typeId) winBad.push(`${p.name} 重跑得 ${gotId} ≠ 实际 ${p.typeId}`);
      const t = typeTbl.find((x) => x.id === p.typeId);
      if (t) {
        if (t.kind !== p.bulk) winBad.push(`${p.name} bulk ${p.bulk} ≠ 型的 kind ${t.kind}`);
        if (t.massRange && !(p.mE >= t.massRange[0] && p.mE <= t.massRange[1])) winBad.push(`${p.name} 质量 ${p.mE} ∉ 型的区间`);
      }
    }
    check("★ 行星分类可由抽值独立重跑推出（表序扫描，含兜底）", winBad.length === 0,
      winBad.slice(0, 3).join(" | ") || pd.map((p) => p.typeName).join(" / "));
    check("★ 行星库 16 型 · id 唯一 · 每型有构成与条件文案",
      typeTbl.length === 16 && new Set(typeTbl.map((t) => t.id)).size === 16 &&
      typeTbl.every((t) => t.comp && t.cond && t.surface && t.atmo && /^#[0-9a-f]{6}$/.test(t.color)),
      `${typeTbl.length} 型：` + typeTbl.map((t) => t.name).join("/"));

    /* ④ 自转 / 公转 / g / v_esc 自洽 */
    const oBad = [];
    for (const p of pd) {
      const P = 365.25 * Math.sqrt(p.au ** 3 / (p.star.massSol + p.mE / 332946));
      if (!near(P, p.periodDays, 1e-9)) oBad.push(`${p.name} 周期 ${p.periodDays.toFixed(4)} ≠ 开普勒 ${P.toFixed(4)}`);
      const v = 2 * Math.PI * p.au * AU_KM / (p.periodDays * 86400);
      if (!near(v, p.vOrbit, 1e-9)) oBad.push(`${p.name} 轨道速度 ${p.vOrbit.toFixed(4)} ≠ 2πa/P ${v.toFixed(4)}`);
      const g = 9.807 * p.mE / (p.rE * p.rE);
      if (!near(g, p.g, 1e-9)) oBad.push(`${p.name} g ${p.g.toFixed(4)} ≠ GM/R² ${g.toFixed(4)}`);
      const ve = 11.186 * Math.sqrt(p.mE / p.rE);
      if (!near(ve, p.vEsc, 1e-9)) oBad.push(`${p.name} v_esc ${p.vEsc.toFixed(4)} ≠ √(2GM/R) ${ve.toFixed(4)}`);
      const dens = 5.514 * p.mE / (p.rE ** 3);
      if (!near(dens, p.dens, 1e-9)) oBad.push(`${p.name} 密度 ${p.dens.toFixed(4)} ≠ M/V ${dens.toFixed(4)}`);
      if (p.tidal && !near(p.rotH, p.periodDays * 24, 1e-9)) oBad.push(`${p.name} 潮汐锁定但自转 ≠ 公转`);
      if (!p.tidal && p.rotH < 6 - 1e-9) oBad.push(`${p.name} 自由自转 ${p.rotH} 超出 6–66 h`);
    }
    check("★ 开普勒周期 · 轨道速度 · g · v_esc · 密度 · 自转全部自洽", oBad.length === 0,
      oBad.slice(0, 3).join(" | ") || "6 条关系式逐颗复算通过");

    const vOrder = pd.map((p) => p.vOrbit);
    const vMono = vOrder.every((v, i) => i === 0 || v < vOrder[i - 1]);
    check("★ 轨道速度内快外慢（v = 2πa/P 的必然结果）", vMono,
      vOrder.map((v) => v.toFixed(1)).join(" → ") + " km/s");
    const spd = pd.map((p) => p.orbitSpeed);
    const spdBad = pd.filter((p, i) => !near(p.orbitSpeed, 10.2 / Math.pow(p.au * 700, 1.5), 1e-9));
    check("★ 视觉公转按 1/a^1.5 缩放（内圈显著更快）", spdBad.length === 0 && spd[0] > spd[spd.length - 1] * 4,
      `${spd[0].toFixed(4)} → ${spd[spd.length - 1].toFixed(4)}（${(spd[0] / spd[spd.length - 1]).toFixed(1)}×）`);

    /* ④b 轨道优化：宜居带随恒星重算 + 亮度带 */
    const hz = await page.evaluate(() => window.__game.hzInfo());
    const LO = Math.sqrt(si17.lumSol / 1.1), HI = Math.sqrt(si17.lumSol / 0.53);
    check("★ 宜居带两条边界由恒星光度算出", hz.lines === 2 && hz.au.length === 2 && near(hz.au[0], LO, 1e-3) && near(hz.au[1], HI, 1e-3),
      `${hz.au[0]} / ${hz.au[1]} AU ＝ √(L★/1.1) / √(L★/0.53) = ${LO.toFixed(4)} / ${HI.toFixed(4)}`);
    const inHZ = pd.filter((p) => p.tempSurf >= 273 && p.tempSurf <= 373);
    check("★ 落在宜居带温度窗口内的行星数与几何带一致",
      inHZ.every((p) => p.au >= hz.au[0] * 0.92 && p.au <= hz.au[1] * 1.08) && inHZ.length >= 1,
      `${inHZ.length} 颗：` + (inHZ.map((p) => p.name.replace(si17.name + " ", "") + "(" + Math.round(p.tempSurf) + "K)").join(" ") || "无"));

    const ofx = await page.evaluate(() => window.__game.orbitFx());
    check("★ 轨道亮度带：行星所在弧段亮、其余退成暗线",
      ofx.length === pd.length && ofx.every((o) => o.max - o.min > 0.3) && ofx.every((o) => o.min <= 0.12) && ofx.every((o) => o.seg === 96),
      ofx.map((o) => `${o.min}→${o.max}`).join(" "));

    /* 换恒星：宜居带与行星温度必须跟着重算；行星分类与构成占比不该变 */
    const before = pd.map((p) => ({ id: p.typeId, iron: p.iron, water: p.water, teq: p.teq }));
    const after = await page.evaluate(() => {
      window.__game.setStarType("G");
      const o = {
        hz: window.__game.hzInfo(),
        star: window.__game.starInfo(),
        p: window.__game.planetData().map((x) => ({ id: x.typeId, iron: x.iron, water: x.water, teq: x.teq, vol: x.volLabel }))
      };
      window.__game.setStarType("M");
      return o;
    });
    const changedT = after.p.filter((p, i) => Math.abs(p.teq - before[i].teq) > 0.01).length;
    const keptId = after.p.filter((p, i) => p.id === before[i].id && Math.abs(p.iron - before[i].iron) < 1e-9).length;
    check("★ 换恒星 → 温度与宜居带整体重算", changedT === pd.length && after.hz.au[0] > hz.au[0] * 3,
      `${changedT}/${pd.length} 颗温度变化 · 宜居带 ${hz.au[0]} → ${after.hz.au[0]} AU（G 型比 M 型亮得多）`);
    check("★ 换恒星不改行星出身（分类与铁镍占比不变，只有相态可能变）", keptId === pd.length,
      `${keptId}/${pd.length} 颗保持一致`);

    /* ★ 贴图是算出来的：等价证据 = 每颗行星一条独立随机流，且世界骨架抽数不受影响 */
    check("★ 每颗行星拥有互不相同的贴图随机流种子",
      new Set(pd.map((p) => p.seed)).size === pd.length && pd.every((p) => Number.isInteger(p.seed) && p.seed > 0),
      pd.map((p) => p.seed).join(" / "));
    check("★ 贴图绘制未扰动世界骨架（主 RNG 仍是 884 抽）", st0.rngDraws === 884, `实测 ${st0.rngDraws} 抽`);
    check("★ 云层只出现在「有大气 + 岩质 + 温度适中」的行星上", vis.clouds >= 0 && vis.clouds <= pd.filter((p) => p.bulk === "rock" && p.atmo >= 0.40 && p.tempSurf > 150 && p.tempSurf < 700).length,
      `${vis.clouds} 颗有云 / ${pd.filter((p) => p.bulk === "rock" && p.atmo >= 0.40 && p.tempSurf > 150 && p.tempSurf < 700).length} 颗符合条件`);

    /* ---- 18. ★ 物种与文明（v0.8）：发源地选址 + 右侧三页标签（行星 / 资源 / 文明） ---- */
    console.log("\n[18] ★ 物种与文明：发源地选址 + 右侧标签页（行星 / 资源 / 文明）");

    /* 本节的立场：文明 = 物种 × 发源地。「发源地是哪颗」必须是**可复算**的
     * —— 评分公式在 verify 里独立重写一遍，逐颗行星对账；「刷新后还是不是同一颗」
     * 用整页重载来证明。参差的自由度（平局、气态行星、换恒星）全在断言里点名。 */

    /* ① 重载前先收官：[1]–[17] 的全部真点击 / API 巡览，一次都没踩到表外的组合 */
    const fsmPre = await page.evaluate(() => window.__game.fsm());
    check("★ 重载前零非法转移（[1]–[17] 的完整交互巡览）", fsmPre.illegal === 0,
      Object.keys(fsmPre.machines).map((k) => k + "=" + fsmPre.machines[k].state).join(" · "));

    /* ② 物种表：人类在册，评分口径齐全（权重和 = 100 —— 注册表体检另行把关） */
    const spT = await page.evaluate(() => window.__game.speciesTable());
    const human = spT[0] || { weights: {}, cradle: {}, atmoPref: {} };
    const wSumH = (human.weights.temp || 0) + (human.weights.water || 0) + (human.weights.atmo || 0) + (human.weights.grav || 0);
    check("★ 物种库：人类在册（学名 / 文明命名 / 四项权重和 = 100）",
      spT.length === 1 && human.id === "human" && human.sci === "Homo sapiens" &&
      !!human.civ && human.civ.name === "人类文明" && wSumH === 100,
      `${spT.length} 种：${human.name || "?"}（${human.sci || "?"}）· ${human.civ ? human.civ.name : "?"} · 权重和 ${wSumH}`);

    /* ③ 发源地是确定性世界事实：整页重载后必须一模一样 */
    const civPre = await page.evaluate(() => window.__game.civInfo());
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 15000 });
    const civPost = await page.evaluate(() => window.__game.civInfo());
    const st18 = await page.evaluate(() => window.__game.getState());
    const c0 = civPost[0] || {};
    check("★ 发源地确定性：整页重载后仍是同一颗行星（同分同名次）",
      !!civPre[0] && !!c0.home && civPre[0].home === c0.home && civPre[0].score === c0.score,
      `${civPre[0] ? civPre[0].home : "?"}（${civPre[0] ? civPre[0].score : "?"} 分）→ 重载 → ${c0.home}（${c0.score} 分）`);
    check("★ 重载后确定性锚点不变（884 抽 / 0.374455 / 薄曙 / M）",
      st18.rngDraws === 884 && st18.starRoll === 0.374455 && st18.starId === "M" && st18.system === "薄曙",
      `${st18.rngDraws} 抽 · roll=${st18.starRoll} · 「${st18.system}」${st18.starId}`);

    /* ④ 选址公式独立复算：照抄 27-species.js 的口径在 verify 里重写一遍 */
    const pd18 = await page.evaluate(() => window.__game.planetData());
    const board18 = await page.evaluate(() => window.__game.cradleBoard("human"));
    const SC = human.cradle, WH = human.weights;
    const band18 = (v, a, b, lo, hi) => v >= a && v <= b ? 1 : (v < a ? (v <= lo ? 0 : (v - lo) / (a - lo)) : (v >= hi ? 0 : (hi - v) / (hi - b)));
    const score18 = (p) => {
      if (p.bulk !== "rock") return { total: 0, parts: [0, 0, 0, 0] };
      const t = band18(p.tempSurf, SC.comfortK[0], SC.comfortK[1], SC.surviveK[0], SC.surviveK[1]);
      let w;
      if (p.water < 0.08) w = 0;
      else if (p.tempSurf > 273 && p.tempSurf < 373) w = Math.max(0, Math.min(1, 0.4 + 0.6 * (p.water - SC.waterMin) / (SC.waterFull - SC.waterMin)));
      else if (p.tempSurf <= 273 && p.tempSurf > 200) w = 0.25;
      else if (p.tempSurf >= 373 && p.tempSurf < 900) w = p.water >= SC.waterMin ? 0.15 : 0;
      else w = 0;
      const a = human.atmoPref[p.atmoP] || 0;
      const g = Math.max(0, Math.min(1, 1 - Math.abs(p.g - SC.gravBest) / SC.gravTol));
      const parts = [Math.round(WH.temp * t), Math.round(WH.water * w), Math.round(WH.atmo * a), Math.round(WH.grav * g)];
      return { total: parts.reduce((x, y) => x + y, 0), parts };
    };
    const calc18 = pd18.map((p) => { const s = score18(p); return { name: p.name, total: s.total, parts: s.parts }; });
    const boardBad = [];
    if (!board18 || board18.length !== pd18.length) boardBad.push("评分榜长度不符：" + (board18 ? board18.length : "null"));
    else pd18.forEach((p, i) => {
      if (board18[i].name !== p.name) boardBad.push(`${p.name} 榜名错位（${board18[i].name}）`);
      else if (board18[i].total !== calc18[i].total) boardBad.push(`${p.name} 榜 ${board18[i].total} ≠ 复算 ${calc18[i].total}`);
    });
    check("★ 摇篮评分逐颗复算通过（纯函数：只读温度 / 液态水 / 大气 / 重力）", boardBad.length === 0,
      boardBad.slice(0, 3).join(" | ") || pd18.map((p, i) => p.name.replace(st18.system + " ", "") + ":" + calc18[i].total).join(" "));

    const rank18 = calc18.map((c, i) => ({ name: c.name, total: c.total, idx: i }))
      .sort((a, b) => b.total - a.total || a.idx - b.idx);
    check("★ 发源地 = 全星系评分最高者（平局取更内侧）", rank18.length > 0 && c0.home === rank18[0].name,
      `榜首「${rank18[0] ? rank18[0].name : "?"}」${rank18[0] ? rank18[0].total : "?"} 分 · 次席「${rank18[1] ? rank18[1].name : "—"}」${rank18[1] ? rank18[1].total : "—"} 分`);

    const win18 = calc18.find((c) => c.name === c0.home) || { parts: [] };
    const partOk = (c0.parts || []).length === 4 &&
      c0.parts.every((p, i) => p.v === win18.parts[i]) &&
      c0.parts.reduce((a, p) => a + p.v, 0) === c0.score &&
      c0.parts.reduce((a, p) => a + p.max, 0) === 100;
    check("★ 评分分项可复算、和 = 总分（40 + 25 + 20 + 15 = 100 分制）", partOk,
      (c0.parts || []).map((p) => `${p.k} ${p.v}/${p.max}（${p.note}）`).join(" · "));
    check("★ 文明快照自洽：次席 / 并列标记 / 评语与复算同源",
      rank18.length < 2 ? c0.second === null
        : (c0.second && rank18[1] && c0.second.name === rank18[1].name && c0.second.total === rank18[1].total &&
           c0.tie === (c0.second.total === c0.score)),
      `次席「${c0.second ? c0.second.name + " " + c0.second.total + " 分" : "—"}」${c0.tie ? "（并列）" : ""} · 评语：${c0.report || "?"}`);

    /* ⑤ 信标：重载后重新挂牌，仍在发源地上 */
    check("★ 发源地信标（重载后）：仍在位", c0.beacon === true,
      `环在「${c0.home}」上：${c0.beacon === true}`);

    /* ⑥ 右侧标签页：真点击发源地行星 → 标签栏出现；真点击切到文明页 */
    await page.evaluate((nm) => {
      const w = window.__game.planetWorldPos(nm);
      window.__game.holdTarget(true);
      window.__game.setTarget(w.x, w.y, w.z);
      window.__game.zoomTo(42);
    }, c0.home);
    await sleep(600);
    const hpPos = await page.evaluate((nm) => window.__game.planetScreenPos(nm), c0.home);
    await page.mouse.click(hpPos.x, hpPos.y);
    await sleep(350);
    const tab1 = await page.evaluate(() => {
      const g = window.__game;
      return {
        sel: g.getState().selectedPlanet,
        pan: g.fsm().machines["面板"].state,
        tabsHidden: document.getElementById("p-tabs").classList.contains("hidden"),
        labels: [...document.querySelectorAll("#p-tabs .p-tab")].map((b) => b.textContent),
        rowsShown: !document.getElementById("p-rows").classList.contains("hidden"),
        civShown: !document.getElementById("p-civ").classList.contains("hidden"),
        resShown: !document.getElementById("p-res").classList.contains("hidden")
      };
    });
    check("★ 点击发源地行星 → 出现「行星 / 资源 / 文明」标签栏（默认停在行星页）",
      tab1.sel === c0.home && !tab1.tabsHidden && tab1.labels.join("|") === "行星|资源|文明" &&
      tab1.pan === "planet" && tab1.rowsShown && !tab1.civShown && !tab1.resShown,
      `选中 ${tab1.sel} · 标签 ${tab1.labels.join(" / ")} · 机器=${tab1.pan} · 行星页${tab1.rowsShown ? "显示" : "隐藏"} · 文明页${tab1.civShown ? "显示" : "隐藏"}`);

    await page.click('#p-tabs .p-tab[data-tab="civ"]');   /* 真实点击 */
    await sleep(300);
    const tab2 = await page.evaluate(() => {
      const on = document.querySelector("#p-tabs .p-tab.on");
      return {
        pan: window.__game.fsm().machines["面板"].state,
        on: on ? on.getAttribute("data-tab") : null,
        civShown: !document.getElementById("p-civ").classList.contains("hidden"),
        rowsHidden: document.getElementById("p-rows").classList.contains("hidden"),
        resHidden: document.getElementById("p-res").classList.contains("hidden"),
        text: document.getElementById("p-civ").textContent
      };
    });
    check("★ 点「文明」标签 → 文明页显示、行星页让位（机器 = DOM 同步）",
      tab2.pan === "civ" && tab2.civShown && tab2.rowsHidden && tab2.resHidden && tab2.on === "civ",
      `机器=${tab2.pan} · 高亮=${tab2.on} · 文明页${tab2.civShown ? "显示" : "隐藏"} · 行星页${tab2.rowsHidden ? "让位" : "未让位"}`);
    const civKeys = ["人类文明", "人类", "Homo sapiens", "发源地", "适居评分", "温度", "液态水", "大气", "重力"];
    const missKeys = civKeys.filter((k) => !tab2.text.includes(k));
    check("★ 文明页含名称 / 物种 / 发源地 / 四项摇篮评分", missKeys.length === 0,
      missKeys.length ? "缺 " + missKeys.join("/") : `含 ${civKeys.length} 个关键字段`);
    check("★ 文明页数据与文明快照同源（评分 + 报告句）",
      tab2.text.includes(c0.score + " / 100") && tab2.text.includes(c0.report),
      `${c0.score} / 100 · 报告句「${(c0.report || "").slice(0, 24)}…」`);
    await shot(page, "n17-panel-civ.png");

    /* ⑦ 非发源地行星（v0.9：标签栏扩展到所有行星）：文明钮隐去、资源页可用；
     * 从文明页切过去自动回落（机器 = DOM 依旧成立） */
    const otherP = pd18.find((p) => p.name !== c0.home);
    await page.evaluate((nm) => window.__game.selectPlanetByName(nm), otherP.name);
    await sleep(250);
    const tab3 = await page.evaluate(() => ({
      sel: window.__game.getState().selectedPlanet,
      pan: window.__game.fsm().machines["面板"].state,
      tabsHidden: document.getElementById("p-tabs").classList.contains("hidden"),
      civTabHidden: document.querySelector('#p-tabs .p-tab[data-tab="civ"]').classList.contains("hidden"),
      resTabHidden: document.querySelector('#p-tabs .p-tab[data-tab="res"]').classList.contains("hidden"),
      civShown: !document.getElementById("p-civ").classList.contains("hidden"),
      resShown: !document.getElementById("p-res").classList.contains("hidden"),
      rowsShown: !document.getElementById("p-rows").classList.contains("hidden")
    }));
    check("★ 非发源地行星：标签栏在（行星 / 资源）· 文明钮隐去 · 从文明页自动回落行星页",
      tab3.sel === otherP.name && !tab3.tabsHidden && tab3.civTabHidden && !tab3.resTabHidden &&
      tab3.pan === "planet" && !tab3.civShown && !tab3.resShown && tab3.rowsShown,
      `${tab3.sel}：文明钮${tab3.civTabHidden ? "隐去" : "仍在"} · 资源钮${tab3.resTabHidden ? "隐去" : "在"} · 机器=${tab3.pan} · 行星页${tab3.rowsShown ? "显示" : "隐藏"}`);

    /* ⑧ 换恒星 → 发源地按新温度重新选举；切回 M 型复原（发源地不是一次性抽签） */
    const refound = await page.evaluate(() => {
      const g = window.__game;
      const before = g.civInfo()[0].home;
      g.setStarType("G");
      const mid = {
        home: g.civInfo()[0].home, score: g.civInfo()[0].score,
        board: g.cradleBoard("human")
      };
      g.setStarType("M");
      return { before, mid, after: { home: g.civInfo()[0].home, score: g.civInfo()[0].score, rings: g.sceneStats().civRings } };
    });
    const midRank = (refound.mid.board || []).slice().sort((a, b) => b.total - a.total || a.idx - b.idx);
    check("★ 换恒星（G 型）→ 发源地按新条件重新选举（评分最高者胜出）",
      !!midRank[0] && refound.mid.home === midRank[0].name,
      `G 型榜首「${midRank[0] ? midRank[0].name : "?"}」${midRank[0] ? midRank[0].total : "?"} 分 → 发源地 ${refound.mid.home}（M 型下为 ${refound.before}）`);
    check("★ 切回 M 型 → 发源地与信标复原（确定性的往返）",
      refound.after.home === refound.before && refound.after.score === c0.score && refound.after.rings === 1,
      `${refound.before} → G 型「${refound.mid.home}」→ M 型「${refound.after.home}」· 信标 ${refound.after.rings} 枚`);

    /* ⑨ 收尾：镜头与选中复位（[19] 物资节从一个平常状态开始） */
    await page.evaluate(() => {
      window.__game.holdTarget(false);
      window.__game.setTarget(0, 0, 0);
      window.__game.zoomTo(92);
      window.__game.clearSelection();
    });
    await sleep(250);

    /* ---- 19. ★ 物资（v0.9 新增）：元素制家底 —— 两本账（蕴含 ≠ 可采）· 零 RNG ---- */
    console.log("\n[19] ★ 物资：14 大类 · 蕴藏 / 可采 两本账（机器判据）");

    /* 本节的立场：资源不标准化「物质」，标准化「账本」—— 所以账本必须**可复算**。
     * verify 侧照抄推导口径重写一遍（构成% × 质量 × 配方 → 元素 kg → 归户 → 取率），
     * 逐颗行星逐个大类与游戏内数字对账。两条硬约束各有专门断言：
     *   守恒：Σ蕴藏 ≡ 行星质量（整数百分比 × 归一化配方 → 精确到机器精度）
     *   零 RNG：主 RNG 的**实时**抽数在推导前后一格不动（884 是历史锚点，验不了这个） */
    const mt = await page.evaluate(() => window.__game.materialsTable());
    const pm = await page.evaluate(() => window.__game.planetMaterials());
    const pd19 = await page.evaluate(() => window.__game.planetData());

    /* ① 账本口径：自造显示单位「单位物资」= 10²¹ kg；内部按 kg 记账（可溯源）；工程锁 L0 */
    check("★ 账本口径：单位物资 = 10²¹ kg · 地球质量常数在册 · 工程等级 L0（科技树未上线）",
      mt.unit === "单位物资" && mt.unitKg === 1e21 && mt.earthKg === 5.9722e24 &&
      mt.eng.level === 0 && mt.eng.name === "L0",
      `1 单位 = ${mt.unitKg.toExponential(0)} kg · M⊕ = ${mt.earthKg.toExponential(4)} kg · ${mt.eng.name}`);

    /* ② 14 大类 = 9 现役 + 5 待命；显示名口径：单质单列带元素符号（「氢 H」）、族不带 */
    const cats = mt.categories;
    const nAct = cats.filter((c) => c.status === "active").length;
    const nStb = cats.filter((c) => c.status === "standby").length;
    const labelBad = cats.filter((c) => c.label !== c.name + (c.members.length === 1 ? " " + c.members[0] : ""));
    check("★ 物资表：14 大类 = 9 现役 + 5 待命 · id 唯一 · 显示名口径正确",
      cats.length === 14 && nAct === 9 && nStb === 5 && new Set(cats.map((c) => c.id)).size === 14 &&
      labelBad.length === 0,
      cats.map((c) => c.name + (c.status === "standby" ? "（待命）" : "")).join(" · "));

    /* ③ 元素单一归属：31 种元素恰属一个大类（铁单列 ⇒ 过渡金属只剩镍铬锰钴） */
    const elemIds = mt.elements.map((e) => e.id);
    const owner19 = {}, ownBad = [];
    for (const c of cats) for (const el of c.members) {
      if (!elemIds.includes(el)) ownBad.push(`${c.id} 的成员 ${el} 不在元素表`);
      else if (owner19[el]) ownBad.push(`${el} 双重归属（${owner19[el]} / ${c.id}）`);
      else owner19[el] = c.id;
    }
    for (const e of elemIds) if (!owner19[e]) ownBad.push(`${e} 无归属`);
    check("★ 元素单一归属：31 种元素恰属 14 大类之一（不重不漏）",
      ownBad.length === 0 && elemIds.length === 31 && new Set(elemIds).size === 31,
      ownBad.slice(0, 3).join(" | ") || `${elemIds.length} 种元素 · 31 个归属 · 无重复无遗漏`);

    /* ④ 配方闭包：verify 从原始值独立归一化 —— 既查「原始和接近 1」，也查游戏内归一化没算错 */
    const recLabels = Object.keys(mt.recipes).sort();
    const clsLabels = Object.keys(mt.siteClass).sort();
    const recBad = [];
    if (recLabels.join("|") !== clsLabels.join("|")) recBad.push("配方键 ≠ 可及档键（须一一对应）");
    if (mt.labels.slice().sort().join("|") !== recLabels.join("|")) recBad.push("labels 快照 ≠ 配方键");
    for (const k of Object.keys(mt.recipesRaw)) {
      const raw = mt.recipesRaw[k];
      const s = Object.keys(raw).reduce((a, el) => a + raw[el], 0);
      if (Math.abs(s - 1) > 5e-4) recBad.push(`${k} 原始和 ${s}（偏离过大）`);
      for (const el of Object.keys(raw)) {
        if (!elemIds.includes(el)) recBad.push(`${k} 含表外元素 ${el}`);
        const mine = raw[el] / s, theirs = (mt.recipes[k] || {})[el];
        if (!(Math.abs(mine - theirs) <= 1e-12)) recBad.push(`${k}.${el} 归一化 ${theirs} ≠ 复算 ${mine}`);
      }
    }
    for (const k of recLabels) {
      const s = Object.keys(mt.recipes[k]).reduce((a, el) => a + mt.recipes[k][el], 0);
      if (Math.abs(s - 1) > 1e-9) recBad.push(`${k} 归一化后和 ≠ 1（${s}）`);
    }
    check("★ 配方 12 张闭包：标签 ↔ 可及档一一对应 · 元素在册 · 归一化精确和为 1",
      recBad.length === 0,
      recBad.slice(0, 3).join(" | ") || `${recLabels.length} 张：` + recLabels.slice(0, 4).join(" / ") + " …");

    /* ⑤ 取率表：三档齐备、值域 (0,1]、随工程等级单调不减（「可采只增不减」的结构保证） */
    const rateBad = [];
    for (const cls of ["surface", "crust", "deep"]) {
      const arr = mt.siteRates[cls];
      if (!arr || !arr.length) { rateBad.push(`${cls} 缺取率`); continue; }
      arr.forEach((v, i) => {
        if (!(v > 0 && v <= 1)) rateBad.push(`${cls}[${i}]=${v} 越界`);
        if (i > 0 && v < arr[i - 1]) rateBad.push(`${cls} 随等级下降`);
      });
    }
    check("★ 取率表：表层 ×1 · 岩壳 ×0.1 · 深部 ×0.01（L0）· 随等级单调不减（上限 1）",
      rateBad.length === 0 && mt.siteRates.surface[0] === 1 &&
      mt.siteRates.crust[0] === 0.1 && mt.siteRates.deep[0] === 0.01,
      rateBad.slice(0, 3).join(" | ") || "surface 1.0 · crust 0.10 · deep 0.01（L0 三档）");

    /* ⑥ 零 RNG：连算三遍账本（含带名过滤），主 RNG 实时抽数一格不动 */
    const rngProbe = await page.evaluate(() => {
      const g = window.__game;
      const before = g.rngLive();
      g.planetMaterials();
      g.materialsTable();
      g.planetMaterials(g.getState().planets[2].name);
      return { before, after: g.rngLive() };
    });
    check("★ 零 RNG：连算三遍账本 / 快照，主 RNG 实时抽数一格不动",
      rngProbe.before === rngProbe.after,
      `实时抽数 ${rngProbe.before} → ${rngProbe.after}（历史锚点 884 只作对照）`);

    /* ⑦ 带名过滤与全量同源（planetMaterials / planetData 同款签名） */
    const filt19 = await page.evaluate((nm) => window.__game.planetMaterials(nm), pd19[2].name);
    check("★ planetMaterials 可按名过滤：单颗结果与全量逐字节相同",
      filt19.length === 1 && JSON.stringify(filt19[0]) === JSON.stringify(pm[2]),
      `${pd19[2].name}：过滤 ${filt19.length} 条 · 与全量第 3 条一致`);

    /* ⑧ 两本账独立复算（本节核心）：从原始配方出发全链重算一遍 ——
     *   质量 kg = mE × 5.9722e24；每个构成桶 × 配方元素占比 → 元素 kg；
     *   元素 kg 按物资表归户 → 大类两本账；可采再乘构成桶的取率。
     * 逐颗行星对账：蕴藏 / 可采 / 单位换算 / 行序 / 零量清单 / 行和 = 总账。 */
    const ledBad = [], consBad = [], rowBad = [];
    let maxCons = 0;
    for (let i = 0; i < pd19.length; i++) {
      const p = pd19[i], m = pm[i];
      const massKg = p.mE * mt.earthKg;
      const hold = {}, ext = {};
      const unmatched = [];
      for (const [label, pct] of p.comp) {
        const raw = mt.recipesRaw[label];
        if (!raw) { unmatched.push(label); continue; }
        const s = Object.keys(raw).reduce((a, el) => a + raw[el], 0);
        const rate = mt.siteRates[mt.siteClass[label]][mt.eng.level];
        const bucket = massKg * pct / 100;
        for (const el of Object.keys(raw)) {
          const kg = bucket * (raw[el] / s);
          hold[el] = (hold[el] || 0) + kg;
          ext[el] = (ext[el] || 0) + kg * rate;
        }
      }
      if (m.name !== p.name) ledBad.push(`第 ${i} 颗名不对（${m.name} vs ${p.name}）`);
      if (unmatched.length) ledBad.push(`${p.name} 构成标签无配方：${unmatched.join("/")}`);
      if (!near(m.massKg, massKg, 1e-12)) ledBad.push(`${p.name} 质量 ${m.massKg} ≠ ${massKg}`);
      if (!near(m.totalUnits, massKg / mt.unitKg, 1e-12)) ledBad.push(`${p.name} 总单位数不符`);
      const rel = Math.abs(m.holdKg - massKg) / massKg;   /* 守恒：Σ蕴藏 ≡ 质量 */
      if (rel > maxCons) maxCons = rel;
      if (rel > 1e-12) consBad.push(`${p.name} Σ蕴藏 与质量偏差 ${rel.toExponential(2)}`);
      if (!(m.extKg <= m.holdKg * (1 + 1e-9))) consBad.push(`${p.name} 可采 > 蕴藏`);
      let sH = 0, sE = 0;
      for (const c of cats) {
        const h = c.members.reduce((a, el) => a + (hold[el] || 0), 0);
        const e = c.members.reduce((a, el) => a + (ext[el] || 0), 0);
        sH += h; sE += e;
        const row = m.rows.find((r) => r.id === c.id);
        if (h === 0) {
          if (row) rowBad.push(`${p.name}·${c.name} 复算为零却有行`);
          else if (!m.zero.includes(c.label)) rowBad.push(`${p.name}·${c.label} 应在零量一行`);
          continue;
        }
        if (!row) { rowBad.push(`${p.name}·${c.name} 缺行`); continue; }
        if (!near(row.holdKg, h, 1e-9)) rowBad.push(`${p.name}·${c.name} 蕴藏 ${row.holdKg} ≠ 复算 ${h}`);
        if (!near(row.extKg, e, 1e-9)) rowBad.push(`${p.name}·${c.name} 可采 ${row.extKg} ≠ 复算 ${e}`);
        if (!near(row.units, h / mt.unitKg, 1e-12)) rowBad.push(`${p.name}·${c.name} 单位换算不符`);
        if (!near(row.extUnits, e / mt.unitKg, 1e-12)) rowBad.push(`${p.name}·${c.name} 可采单位换算不符`);
      }
      if (!near(m.holdKg, sH, 1e-12)) rowBad.push(`${p.name} Σ行蕴藏 ${sH} ≠ 总账 ${m.holdKg}`);
      if (!near(m.extKg, sE, 1e-12)) rowBad.push(`${p.name} Σ行可采 ${sE} ≠ 总账 ${m.extKg}`);
      if (m.rows.length + m.zero.length !== cats.length) rowBad.push(`${p.name} 行 + 零量 ≠ ${cats.length} 类`);
      const orderIdx = m.rows.map((r) => cats.findIndex((c) => c.id === r.id));
      if (!orderIdx.every((v, j) => v >= 0 && (j === 0 || v > orderIdx[j - 1]))) rowBad.push(`${p.name} 行序 ≠ 物资表序`);
    }
    check("★ 两本账逐颗逐类独立复算通过（配方 × 构成 × 质量 → 元素 kg → 归户 → 取率）",
      ledBad.length === 0,
      ledBad.slice(0, 3).join(" | ") || `${pd19.length} 颗 × ${cats.length} 类 · 蕴藏 / 可采全部吻合`);
    check("★ 守恒：Σ蕴藏 ≡ 行星质量（整数百分比 + 归一化配方 → 机器精度）",
      consBad.length === 0,
      consBad.slice(0, 3).join(" | ") || `全 ${pd19.length} 颗 · 最大相对偏差 ${maxCons.toExponential(2)}`);
    check("★ 归户账目自洽：有量类成行 · 零量清单互斥 · 行序 = 物资表序 · 行和 = 总账",
      rowBad.length === 0,
      rowBad.slice(0, 3).join(" | ") || `${pd19.length} 颗：类目无重叠、无遗漏`);

    /* ⑨ 两本账是「真差额」：岩壳 / 深部参与的类目必须严格小于，且全表可采 ≤ 蕴藏 */
    let nGap = 0; const gapBad = [];
    for (const m of pm) for (const r of m.rows) {
      if (!(r.extKg <= r.holdKg * (1 + 1e-9))) gapBad.push(`${m.name}·${r.label} 可采 > 蕴藏`);
      else if (r.extKg < r.holdKg * 0.9995) nGap++;
    }
    check("★ 两本账真差额：全星系已有类目出现「可采 < 蕴藏」（折减不是摆设）",
      nGap >= 1 && gapBad.length === 0,
      gapBad.slice(0, 3).join(" | ") || `${nGap} 个类目被折减（岩壳 / 深部参与即严格小于）`);

    /* ⑩ 资源页真点击：选行数最多的行星 → 标签栏点「资源」→ 页面逐行与快照对账 */
    const tgt = pm.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    await page.evaluate((nm) => {
      const w = window.__game.planetWorldPos(nm);
      window.__game.holdTarget(true);
      window.__game.setTarget(w.x, w.y, w.z);
      window.__game.zoomTo(46);
    }, tgt.name);
    await sleep(600);
    const tpPos = await page.evaluate((nm) => window.__game.planetScreenPos(nm), tgt.name);
    await page.mouse.click(tpPos.x, tpPos.y);
    await sleep(350);
    const resTab = await page.evaluate(() => ({
      sel: window.__game.getState().selectedPlanet,
      pan: window.__game.fsm().machines["面板"].state,
      labels: [...document.querySelectorAll("#p-tabs .p-tab:not(.hidden)")].map((b) => b.textContent)
    }));
    const wantLabels = c0.home === tgt.name ? "行星|资源|文明" : "行星|资源";
    check("★（资源页）真点中行星 → 标签栏在、默认停在行星页",
      resTab.sel === tgt.name && resTab.pan === "planet" && resTab.labels.join("|") === wantLabels,
      `选中 ${resTab.sel}（${tgt.rows.length} 行 / ${tgt.zero.length} 零）· 标签 ${resTab.labels.join(" / ")}`);

    await page.click('#p-tabs .p-tab[data-tab="res"]');   /* 真实点击 */
    await sleep(300);
    const resView = await page.evaluate(() => {
      const on = document.querySelector("#p-tabs .p-tab.on");
      return {
        pan: window.__game.fsm().machines["面板"].state,
        on: on ? on.getAttribute("data-tab") : null,
        resShown: !document.getElementById("p-res").classList.contains("hidden"),
        rowsHidden: document.getElementById("p-rows").classList.contains("hidden"),
        civHidden: document.getElementById("p-civ").classList.contains("hidden"),
        text: document.getElementById("p-res").textContent
      };
    });
    check("★ 点「资源」标签 → 资源页显示、行星页让位（机器 = DOM 同步）",
      resView.pan === "res" && resView.on === "res" && resView.resShown && resView.rowsHidden && resView.civHidden,
      `机器=${resView.pan} · 高亮=${resView.on} · 资源页${resView.resShown ? "显示" : "隐藏"} · 行星页${resView.rowsHidden ? "让位" : "未让位"}`);

    /* 验证侧复刻显示口径（与 matUnits 同规则）：≥100 取整千分位 / ≥10 一位 / ≥1 两位 / 其余两位有效数字 */
    const vUnits = (kg) => {
      const v = kg / mt.unitKg;
      if (!(v > 0)) return "0";
      if (v >= 100) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      if (v >= 10) return v.toFixed(1);
      if (v >= 1) return v.toFixed(2);
      return v.toPrecision(2);
    };
    const uiRows = await page.evaluate((want) => {
      const got = {};
      for (const el of document.querySelectorAll("#p-res .p-row")) {
        got[el.querySelector(".k").textContent] = el.querySelector(".v").textContent;
      }
      return want.map((w) => ({ label: w.label, want: w.disp, got: got[w.label] === undefined ? null : got[w.label] }));
    }, tgt.rows.map((r) => ({ label: r.label, disp: vUnits(r.extKg) + (r.extKg < r.holdKg * 0.9995 ? " / " + vUnits(r.holdKg) : "") })));
    const uiBad = uiRows.filter((r) => r.got !== r.want);
    check("★ 资源页逐行对账：每个类目的「可采 / 蕴藏」两数与快照同源（含折减对）",
      uiBad.length === 0 && resView.text.includes("单位物资") && resView.text.includes("工程等级 L0") &&
      (tgt.zero.length === 0 || resView.text.includes("零量：" + tgt.zero.join(" · "))) &&
      resView.text.includes("可采只增不减"),
      uiBad.length ? "行不符：" + uiBad.slice(0, 2).map((r) => `${r.label} 页 ${r.got} ≠ 期望 ${r.want}`).join(" | ")
        : `${tgt.rows.length} 行逐一对上 · 零量 ${tgt.zero.length} 类成行 · 口径注脚齐全`);
    await shot(page, "n18-panel-res.png");

    /* 锚点行（10-14 实测冻结）：V 氢 380,885 / 386,011 · V 惰性气体 133,806 · III 铁 3.86 / 259。
     * 这组数从「构成 × 质量 × 配方 × 取率」一路乘出来 —— 谁动了标度 / 配方 / 构成模型，它先响。 */
    const anom = pm.find((m) => / V$/.test(m.name)) || {};
    const lead = pm.find((m) => /III$/.test(m.name)) || {};
    const aRow = (m, label) => (m.rows || []).find((r) => r.label === label) || {};
    const aDisp = (r) => r.holdKg === undefined ? "—" :
      vUnits(r.extKg) + (r.extKg < r.holdKg * 0.9995 ? " / " + vUnits(r.holdKg) : "");
    check("★ 锚点（实测冻结）：V 氢 380,885 / 386,011 · V 惰性气体 133,806 · III 铁 3.86 / 259",
      aDisp(aRow(anom, "氢 H")) === "380,885 / 386,011" &&
      aDisp(aRow(anom, "惰性气体")) === "133,806" &&
      aDisp(aRow(lead, "铁 Fe")) === "3.86 / 259",
      `V：氢 ${aDisp(aRow(anom, "氢 H"))} · 惰性气体 ${aDisp(aRow(anom, "惰性气体"))} · III：铁 ${aDisp(aRow(lead, "铁 Fe"))}`);

    /* 收尾：取消选中（资源页自动回落行星页），进入 15 星型扫描 */
    await page.evaluate(() => { window.__game.holdTarget(false); window.__game.clearSelection(); });
    await sleep(250);

    /* ⑪ 15 星型全扫：构成标签随温度变（挥发分六相）—— 每个真实标签都必须能记账。
     * 这一步把「配方表覆盖不全」变成硬红灯：新标签漏配 = 这里的 unmatched 非空。 */
    const sweep19 = await page.evaluate(() => {
      const g = window.__game;
      const out = { bad: [], labels: {}, maxCons: 0, planets: 0 };
      for (const id of g.starTypeIds()) {
        if (!g.setStarType(id)) { out.bad.push(id + " 切换失败"); continue; }
        const ps = g.planetData(), ms = g.planetMaterials();
        out.planets += ps.length;
        for (let i = 0; i < ps.length; i++) {
          const m = ms[i], massKg = ps[i].mE * 5.9722e24;
          for (const c of ps[i].comp) out.labels[c[0]] = (out.labels[c[0]] || 0) + 1;
          if (m.unmatched.length) out.bad.push(id + "·" + ps[i].name + " 标签无配方：" + m.unmatched.join("/"));
          const rel = Math.abs(m.holdKg - massKg) / massKg;
          if (rel > out.maxCons) out.maxCons = rel;
          if (rel > 1e-12) out.bad.push(id + "·" + ps[i].name + " 守恒偏差 " + rel.toExponential(2));
        }
      }
      g.setStarType("M");
      return out;
    });
    const sweepLabels = Object.keys(sweep19.labels);
    check("★ 15 星型全扫：构成标签闭包 —— 每个真实出现的标签都能记账（零 RNG 重算不越界）",
      sweep19.bad.length === 0,
      sweep19.bad.slice(0, 3).join(" | ") ||
        `${sweep19.planets} 颗（15 星型）· ${sweepLabels.length} 个标签全有配方：` + sweepLabels.join(" / "));
    check("★ 全扫期间守恒不破（每一步 Σ蕴藏 ≡ 质量，偏差 < 1e-12）",
      sweep19.maxCons < 1e-12, `最大相对偏差 ${sweep19.maxCons.toExponential(2)}`);

    /* ⑫ 往返与重载确定性：切回 M 型账本逐字节复原；整页刷新后再验一次 */
    const back19 = await page.evaluate(() => ({
      st: window.__game.getState(),
      pm: window.__game.planetMaterials()
    }));
    check("★ 扫描后切回 M 型：账本与扫描前逐字节相同（确定性往返）",
      JSON.stringify(back19.pm) === JSON.stringify(pm),
      JSON.stringify(back19.pm) === JSON.stringify(pm) ? `${pd19.length} 颗账本原样复原` : "账本漂移");
    check("★ 复原锚点（884 抽 / 0.374455 / 薄曙 / M）",
      back19.st.rngDraws === 884 && back19.st.starRoll === 0.374455 &&
      back19.st.starId === "M" && back19.st.system === "薄曙",
      `${back19.st.rngDraws} 抽 · roll=${back19.st.starRoll} · 「${back19.st.system}」${back19.st.starId}`);

    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 15000 });
    const pmReload = await page.evaluate(() => window.__game.planetMaterials());
    check("★ 账本重载确定性：整页刷新后逐字节相同（账是世界的函数，不是一次性抽签）",
      JSON.stringify(pmReload) === JSON.stringify(pm),
      `${pmReload.length} 颗 · ${JSON.stringify(pmReload) === JSON.stringify(pm) ? "逐字节一致" : "漂移"}`);

    /* ---- 20. ★ 聚焦镜头（v0.10 新增）：相机第三态 focus ---- */
    console.log("\n[20] ★ 聚焦镜头：双击贴近 + 操作精度 + 聚焦 HUD");
    /* 立场：v0.10 把「聚焦」从一次推距升级成相机的**第三态** —— 三档距离
     * （free 92 / follow size×7+6 / focus size×3.6）只写在 applyCamera 一处。
     * 本节验八件事：进得去（双击 → focus，距离对、minR 放宽、HUD 现身）、
     * 贴得近（行星占视口高一半以上）、读得动（距地表读数随缩放变）、
     * 变得精（聚焦态滚轮一步 < 全景一步的 60%）、**跟得住**（v0.12.2：
     * 镜头随星球一起运动 —— 自转冻结、对准的面不转走；行星钉在画面中心
     * 随轨道一起飞）；退出即恢复）、退得回（Esc → follow、
     * 双击空白 → free，两次退出 minR 都复原）、换得动（拉远后双击换目标）。
     * 页面此时刚 reload 过（[19] 末尾），从干净状态开始。 */
    /* focusDistance 独立复算。注意 getState() 的 size 是两位小数快照、而游戏内用全精度，
     * 所以对账用 ±0.02 容差（0.005 的舍入 × 3.6 ≈ 0.018），不用全等。 */
    const fc = (size) => Math.min(Math.max(size * 3.6, 1.6), 9.4);
    const tgt20 = await page.evaluate(() => {
      const st = window.__game.getState();
      const pl = st.planets[1] || st.planets[0];
      return { name: pl.name, size: pl.size, pos: window.__game.planetScreenPos(pl.name) };
    });
    /* ---- 地形生成器（v0.11）：全景档低分辨率 + 凹凸；聚焦时升级并隐藏选中标记 ---- */
    const ter0 = await page.evaluate(() => window.__game.terrain());
    const solids = ter0.filter((t) => t.solid);
    check("★ 固态行星走地形生成器（全景档 768px 贴图 + 凹凸图；气态不建地形）",
      solids.length >= 3 && solids.every((t) => t.texW === 768 && t.hasBump && !!t.profile) &&
        ter0.filter((t) => !t.solid).every((t) => t.profile === null && !t.hasBump),
      `${solids.length} 颗固态 · 贴图 ${solids[0] && solids[0].texW}px · bump=${solids.every((t) => t.hasBump)}`);
    check("★ 地形画像 = 物理的读数（坑密度随大气下降；起伏被大气与重力磨平）",
      solids.every((t) => t.relief > 0.2 && t.relief < 1.6 && t.craters >= 0) &&
        solids.some((t) => t.atmo > 0.5 && t.craters <= 6),
      solids.map((t) => `${t.name.split(" ")[1]}:${t.profile}/坑${t.craters}/伏${t.relief}`).join(" · "));
    /* 高程场独立复算：有海的世界海平面恰在 0.5（水面覆盖 = 挥发分丰度） */
    const seaPlanet = ter0.find((t) => t.sea);
    const hf = await page.evaluate((n) => window.__game.heightField(n, 256), seaPlanet.name);
    check("★ 高程场复算：有海世界的水面覆盖 = 挥发分丰度（海平面重标定在 0.5）",
      Math.abs(hf.hist.slice(0, 5).reduce((a, b) => a + b, 0) - Math.min(0.95, Math.max(0.05, seaPlanet.water * 1.15))) < 0.06,
      `「${seaPlanet.name}」水 ${seaPlanet.water.toFixed(2)} → 低半场覆盖 ${hf.hist.slice(0, 5).reduce((a, b) => a + b, 0).toFixed(3)}`);

    await page.mouse.dblclick(tgt20.pos.x, tgt20.pos.y);
    await sleep(2200);                       /* 等半径与 target 都收敛（聚焦档 target lerp 5.5） */

    const fo1 = await page.evaluate(() => ({
      cs: window.__game.cameraState(),
      hudHidden: document.getElementById("focus-hud").classList.contains("hidden")
    }));
    check("★ 双击行星 → 聚焦（相机第三态 focus，目标 = G.focusPlanet）",
      fo1.cs.mode === "focus" && fo1.cs.focus === tgt20.name,
      `mode=${fo1.cs.mode} · 目标「${fo1.cs.focus}」`);
    check("★ 聚焦距离 = 行星半径 × 3.6（clamp 1.6~9.4，与行星大小解耦）",
      Math.abs(fo1.cs.goal - fc(tgt20.size)) <= 0.02,
      `size=${tgt20.size} → goal=${fo1.cs.goal}（复算 ${fc(tgt20.size).toFixed(2)}）`);
    check("★ 聚焦档放宽 orbit.minR（否则 16 的底线会把推距钳死、贴不上去）",
      fo1.cs.minR < 1.5 && Math.abs(fo1.cs.minR - fo1.cs.goal * 0.25) < 0.05,
      `minR=${fo1.cs.minR.toFixed(3)} ≈ goal×0.25`);
    check("★ 聚焦 HUD 现身", !fo1.hudHidden);

    /* 聚焦的沉浸约定（v0.11 起）：选中标记退场；v0.12 起表面表示换轨 ——
     * 固态行星改看立方球连续地表（44-focus-surface.js），贴图升级路径退役。 */
    const foT = await page.evaluate((nm) => ({
      sel: window.__game.selectionFx(),
      ter: window.__game.terrain(nm)[0],
      cs: window.__game.focusSurface(nm)
    }), tgt20.name);
    check("★ 聚焦时选中标记退场（括号的作用是全景里指认目标，聚焦时已无意义）",
      foT.sel.planet && foT.sel.planet.visible === false && foT.sel.planet.opacity === 0,
      `行星括号 visible=${foT.sel.planet && foT.sel.planet.visible} · opacity=${foT.sel.planet && foT.sel.planet.opacity}`);
    check("★ 聚焦档表面表示（v0.12）：固态行星走立方球连续地表（贴图不再升级到 2048px）",
      foT.cs.solid
        ? (foT.cs.built && foT.cs.active === true && foT.cs.meshVisible === false && foT.ter.hi === false)
        : (!foT.cs.built && foT.cs.meshVisible === true && foT.ter.hi === false),
      `「${tgt20.name}」solid=${foT.cs.solid} built=${foT.cs.built} active=${foT.cs.active} hi=${foT.ter.hi}`);
    await shot(page, "n20-focus-surface.png");

    /* ★ v0.12.2：聚焦时的两条运动约定 ——
     * ① 自转冻结：对准的面不转走（frozen=true 时 rotY 零变化）；
     * ② **镜头随星球一起运动**：星球继续公转（在轨道上走），镜头跟随 ——
     *    行星被钉在画面中心（偏移 ≤ 15px），而 target 随星球位移了一段
     *    （画面里在动的是背景：轨道线 / 其他行星 / 晨昏线缓移 —— 世界是活的，
     *    不是「世界定格」）。对照是下一条「退出聚焦必须恢复自转」——
     *    若星球本来就不动，那边会拆穿假阳性。 */
    const mv1 = await page.evaluate((nm) => {
      const g = window.__game;
      const sp = g.planetScreenPos(nm), cs = g.cameraState();
      return {
        rotY: g.focusSurface(nm).meshRotY, frozen: g.focusSurface(nm).frozen,
        ang: g.planetAngle(nm),
        dx: +(sp.x - window.innerWidth / 2).toFixed(1), dy: +(sp.y - window.innerHeight / 2).toFixed(1),
        t: { x: cs.target.x, y: cs.target.y, z: cs.target.z }
      };
    }, tgt20.name);
    await sleep(1600);
    const mv2 = await page.evaluate((nm) => {
      const g = window.__game;
      const sp = g.planetScreenPos(nm), cs = g.cameraState();
      return {
        rotY: g.focusSurface(nm).meshRotY,
        ang: g.planetAngle(nm),
        dx: +(sp.x - window.innerWidth / 2).toFixed(1), dy: +(sp.y - window.innerHeight / 2).toFixed(1),
        t: { x: cs.target.x, y: cs.target.y, z: cs.target.z }
      };
    }, tgt20.name);
    check("★ 聚焦时自转冻结（1.6s 内相位零变化 —— 玩家对准的面不会自己转走）",
      mv1.frozen === true && Math.abs(mv2.rotY - mv1.rotY) < 1e-9,
      `frozen=${mv1.frozen} · rotY ${mv1.rotY} → ${mv2.rotY}`);
    const fTravel = Math.hypot(mv2.t.x - mv1.t.x, mv2.t.y - mv1.t.y, mv2.t.z - mv1.t.z);
    check("★ 镜头随星球一起运动（公转在推进 · 行星钉在画面中心 —— 动的是镜头和背景）",
      Math.abs(mv2.ang - mv1.ang) > 1e-4 && fTravel > 0.5 &&
        Math.hypot(mv1.dx, mv1.dy) < 15 && Math.hypot(mv2.dx, mv2.dy) < 15,
      `angle ${mv1.ang} → ${mv2.ang} · target 随星球位移 ${fTravel.toFixed(2)} · 屏幕偏移 (${mv1.dx},${mv1.dy}) → (${mv2.dx},${mv2.dy})`);

    /* 「镜头内基本全是星球」—— 真投影量取：行星屏幕直径 / 视口高 ≥ 50% */
    const proj = await page.evaluate((nm) => {
      const g = window.__game;
      const cam = g.debugRefs().camera;
      const W = window.innerWidth, H = window.innerHeight;
      const toS = (v3) => { const v = v3.clone().project(cam); return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H }; };
      const wp = g.planetWorldPos(nm);
      const size = g.getState().planets.find((p) => p.name === nm).size;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
      const c = toS(new THREE.Vector3(wp.x, wp.y, wp.z));
      const e = toS(new THREE.Vector3(wp.x, wp.y, wp.z).addScaledVector(right, size));
      return { frac: +(Math.hypot(e.x - c.x, e.y - c.y) * 2 / H).toFixed(3), cx: Math.round(c.x), cy: Math.round(c.y) };
    }, tgt20.name);
    check("★ 行星占视口高一半以上（「镜头内基本全是星球」的机器判据）",
      proj.frac >= 0.5, `屏幕直径/视口高 = ${proj.frac} · 行星居中 (${proj.cx},${proj.cy})`);
    await shot(page, "n19-focus-hud.png");

    /* 读数 = 推导量：滚轮拉远 → 距地表读数跟着变大，且与 cameraState().surface 同源 */
    const s0 = await page.evaluate(() => ({
      surface: window.__game.cameraState().surface,
      dist: document.getElementById("fh-dist").textContent
    }));
    await page.mouse.move(720, 450);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 600); await sleep(120); }
    await sleep(700);
    const s1 = await page.evaluate(() => ({
      surface: window.__game.cameraState().surface,
      dist: document.getElementById("fh-dist").textContent
    }));
    check("★ HUD 读数随缩放实时更新（距地表 = (半径−行星半径)/行星半径，推导量不另存）",
      s1.surface > s0.surface + 0.3 && s1.dist.includes(s1.surface.toFixed(1)),
      `${s0.dist} → ${s1.dist}（surface ${s0.surface} → ${s1.surface}）`);

    /* 精度：聚焦态滚轮一步的相对变化（乘性，与半径基数无关；负值 = 拉近） */
    const relStep = async () => {
      await page.mouse.move(720, 450);
      const r0 = await page.evaluate(() => window.__game.cameraState().radius);
      await page.mouse.wheel(0, -120);
      const r1 = await page.evaluate(() => window.__game.cameraState().radius);
      return Math.abs((r1 - r0) / r0);
    };
    const relFocus = await relStep();

    /* Esc → 回落中距离跟随：同目标、follow 档距离、HUD 隐藏、minR 复原 */
    await page.keyboard.press("Escape");
    await sleep(900);
    const fo2 = await page.evaluate(() => ({
      cs: window.__game.cameraState(),
      hudHidden: document.getElementById("focus-hud").classList.contains("hidden")
    }));
    check("★ Esc → 回落中距离跟随（同目标、follow 档距离、HUD 隐藏、minR 复原）",
      fo2.cs.mode === "follow" && fo2.cs.focus === tgt20.name &&
      Math.abs(fo2.cs.goal - Math.min(Math.max(tgt20.size * 7 + 6, 16), 60)) <= 0.02 &&
      fo2.hudHidden && fo2.cs.minR === 16,
      `mode=${fo2.cs.mode} · goal=${fo2.cs.goal} · minR=${fo2.cs.minR} · HUD${fo2.hudHidden ? "已隐藏" : "仍在"}`);
    const backSel = await page.evaluate(() => window.__game.selectionFx());
    check("★ 退出聚焦 → 选中标记回归（呼吸淡入重新接管）",
      backSel.planet && backSel.planet.visible === true && backSel.planet.opacity > 0.2,
      `visible=${backSel.planet && backSel.planet.visible} · opacity=${backSel.planet && backSel.planet.opacity}`);

    /* ★ v0.12.2 配套：退出聚焦 → 自转恢复（冻结只是暂停累加、不改写相位 ——
     * 恢复是「从冻结点续走」，不是「跳回本该在的地方」，所以进出都无跳变；
     * 公转从未冻结、一直在推进，不需要「恢复」）。 */
    const rotC = await page.evaluate((nm) => window.__game.focusSurface(nm).meshRotY, tgt20.name);
    await sleep(800);
    const rotD = await page.evaluate((nm) => window.__game.focusSurface(nm).meshRotY, tgt20.name);
    check("★ 退出聚焦 → 自转恢复（相位继续演进；若星球从不自转，这条会拆穿上一条）",
      Math.abs(rotD - rotC) > 1e-4,
      `rotY ${rotC} → ${rotD}`);

    /* 双击空白 → 回全景；顺带测全景态滚轮一步，与聚焦态比精度 */
    const empty20 = await findEmptyPoint(page);
    await page.mouse.dblclick(empty20.x, empty20.y);
    await sleep(1200);
    const fo3 = await page.evaluate(() => window.__game.cameraState());
    const relFree = await relStep();
    check("★ 双击空白 → 回全景（free：goal 92、目标清空、minR 复原不泄漏）",
      fo3.mode === "free" && fo3.focus === null && fo3.goal === 92 && fo3.minR === 16,
      `mode=${fo3.mode} · goal=${fo3.goal} · minR=${fo3.minR}`);
    check("★ 操作精度提高：聚焦态滚轮一步 < 全景态的 60%（灵敏度 ×0.32）",
      relFocus < relFree * 0.6,
      `聚焦 ${relFocus.toFixed(4)} vs 全景 ${relFree.toFixed(4)}（${(relFocus / relFree * 100).toFixed(0)}%）`);

    /* 幂等换目标：聚焦态下其他行星已出画（贴近 = 沉浸观察）—— 先拉远到看得见，再双击 */
    const pos20 = await page.evaluate((n) => window.__game.planetScreenPos(n), tgt20.name);
    await page.mouse.dblclick(pos20.x, pos20.y);
    await sleep(2200);
    await page.evaluate(() => window.__game.zoomTo(140));
    await sleep(1500);
    const cand20 = await page.evaluate(() => {
      const g = window.__game;
      const W = window.innerWidth, H = window.innerHeight;
      const cur = g.cameraState().focus;
      const list = g.getState().planets.map((p) => {
        const sp = g.planetScreenPos(p.name);
        return { name: p.name, x: Math.round(sp.x), y: Math.round(sp.y) };
      }).filter((p) => p.name !== cur && p.x > 220 && p.x < W - 400 && p.y > 140 && p.y < H - 140);
      return list[0] || null;
    });
    check("★ 拉远后屏内出现可换目标的行星（聚焦 = 沉浸观察，换目标本就要先拉远）",
      !!cand20, cand20 ? `候选「${cand20.name}」` : "无候选");
    if (cand20) {
      await page.mouse.dblclick(cand20.x, cand20.y);
      await sleep(2200);
      const fo4 = await page.evaluate((nm) => {
        const g = window.__game;
        return {
          cs: g.cameraState(),
          size: g.getState().planets.find((p) => p.name === nm).size
        };
      }, cand20.name);
      const goal4 = fc(fo4.size);
      check("★ focus 态换目标幂等：仍聚焦、目标与距离换成新行星",
        fo4.cs.mode === "focus" && fo4.cs.focus === cand20.name && Math.abs(fo4.cs.goal - goal4) <= 0.02,
        `「${fo4.cs.focus}」· goal=${fo4.cs.goal}（复算 ${goal4.toFixed(2)}）`);
    }

    /* 收尾：复位相机与选中（结构层从一个平常状态开始） */
    await page.evaluate(() => { window.__game.clearSelection(); window.__game.unfocus(); });
    await sleep(900);

    /* ---- 21. ★ 结构层：对象注册表 + 状态机（v0.7 新增；v0.9 起五张表 / 四台机器） ---- */
    console.log("\n[21] ★ 结构层：对象注册表 + 状态机");
    /* 本节的立场：v0.7 把「一张表 + 一个索引」和「一台状态机」做成了两个原语。
     * 原语自己的正确性必须可证 —— 否则对象一多，坏的守卫比没有守卫更贵。
     * 所以这里三件事：① 表干净 ② 体检器**真能**抓到坏数据（自检探针）
     * ③ 全程没有非法状态转移（拦住的是「谁都没设计过的组合」）。 */
    const reg = await page.evaluate(() => window.__game.registries());
    const tStar = reg.tables.find((t) => t.kind === "恒星类型");
    const tPlanet = reg.tables.find((t) => t.kind === "行星类型");
    const tSpecies = reg.tables.find((t) => t.kind === "物种");
    const tMat = reg.tables.find((t) => t.kind === "物资");
    const tCiv = reg.tables.find((t) => t.kind === "文明");
    const tTer = reg.tables.find((t) => t.kind === "地形画像");
    check("★ 六张对象表在册（恒星 15 · 行星 16 · 物种 1 · 物资 14 · 文明 1 · 地形画像 9）",
      reg.tables.length === 6 && !!tStar && !!tPlanet && !!tSpecies && !!tMat && !!tCiv && !!tTer &&
      tStar.size === 15 && tPlanet.size === 16 && tSpecies.size === 1 && tMat.size === 14 && tCiv.size === 1 && tTer.size === 9,
      reg.tables.map((t) => t.kind + "×" + t.size).join(" · ") || "无表");
    check("★ 全部注册表体检无问题（重复 id / 缺必填字段 / 数值越界 / 枚举出界）",
      reg.problems.length === 0,
      reg.problems.slice(0, 3).join(" | ") || `${reg.tables.length} 张表 · 0 条问题`);

    const idsApi = await page.evaluate(() => ({
      star: window.__game.starTypeIds(),
      planet: window.__game.planetTypeIds(),
      species: window.__game.speciesIds(),
      mat: window.__game.materialsTable().categories.map((c) => c.id),
      civ: window.__game.civInfo().map((c) => c.id),
      ter: window.__game.registries().tables.find((t) => t.kind === "地形画像").ids
    }));
    const sameIds = tStar && tPlanet && tSpecies && tMat && tCiv && tTer &&
      JSON.stringify(tStar.ids) === JSON.stringify(idsApi.star) &&
      JSON.stringify(tPlanet.ids) === JSON.stringify(idsApi.planet) &&
      JSON.stringify(tSpecies.ids) === JSON.stringify(idsApi.species) &&
      JSON.stringify(tMat.ids) === JSON.stringify(idsApi.mat) &&
      JSON.stringify(tCiv.ids) === JSON.stringify(idsApi.civ) &&
      JSON.stringify(tTer.ids) === JSON.stringify(idsApi.ter);
    check("★ 注册表的 id 与游戏内数据同源（恒星 / 行星 / 物种 / 物资 / 文明 / 地形画像，不能悄悄丢/换序）", sameIds,
      `恒星 ${tStar ? tStar.ids.length + " 型" : "?"} · 行星 ${tPlanet ? tPlanet.ids.length + " 型" : "?"} · 物种 ${tSpecies ? tSpecies.ids.join("/") : "?"} · 物资 ${tMat ? tMat.ids.length + " 类" : "?"} · 文明 ${tCiv ? tCiv.ids.join("/") : "?"} · 地形 ${tTer ? tTer.ids.length + " 画像" : "?"}`);

    /* ★ 体检器自检：往册里塞一份坏数据，看问题报不报得出来。
     * 「坏了却没人发现的守卫等于没有」—— 这条断言查的是**守卫本身**。
     * 期望值写死 3 条（重复 id / 缺必填 / 无键各一）：改体检器逻辑时必须有意改这里。 */
    const st = reg.selfTest || [];
    check("★ 体检器自检：人造的重复 id / 缺字段 / 无键条目全被抓到（守卫不是摆设）",
      st.length === 3 && st.some((m) => /重复/.test(m)) && st.some((m) => /缺必填字段/.test(m)) && st.some((m) => /为空/.test(m)),
      st.length + " 条： " + st.slice(0, 4).join(" | "));

    /* ★ 探针：真发一个表外事件，必须被拒、且状态不动。
     * probe 会把计数器原样还回去，所以不会污染下面的「全程零非法转移」。 */
    const probes = await page.evaluate(() => ({
      sel: window.__game.fsmProbe("选择", "selfDestruct"),
      cam: window.__game.fsmProbe("相机", "warp"),
      ovl: window.__game.fsmProbe("覆盖层", "close"),    /* 书合着时的 close = 表外 */
      pan: window.__game.fsmProbe("面板", "navAway")     /* 标签页没有「跳走」这个转移 */
    }));
    check("★ 表外事件全部被拦（被拒 + 状态不动）",
      probes.sel && probes.cam && probes.ovl && probes.pan &&
      [probes.sel, probes.cam, probes.ovl, probes.pan].every((p) => p.accepted === false && p.blocked === true),
      `选择:${probes.sel && probes.sel.from}→${probes.sel && probes.sel.to} · ` +
      `相机:${probes.cam && probes.cam.from}→${probes.cam && probes.cam.to} · ` +
      `覆盖层:${probes.ovl && probes.ovl.from}→${probes.ovl && probes.ovl.to} · ` +
      `面板:${probes.pan && probes.pan.from}→${probes.pan && probes.pan.to}`);

    /* ★ 投影对账：机器状态 = G 里的字段 = DOM。
     * 驱动一遍交互，每一步都拍三层快照 —— 任何「各说各话」都会在这里现形。 */
    const seq = await page.evaluate(() => {
      const g = window.__game, out = [];
      const snap = (tag) => {
        const m = g.fsm().machines, s = g.getState();
        out.push({
          tag, sel: m["选择"].state, cam: m["相机"].state, ovl: m["覆盖层"].state, pan: m["面板"].state,
          selPlanet: s.selectedPlanet, focus: s.focus, guideOpen: g.guideOpen(),
          civShown: !document.getElementById("p-civ").classList.contains("hidden"),
          resShown: !document.getElementById("p-res").classList.contains("hidden"),
          tabsShown: !document.getElementById("p-tabs").classList.contains("hidden"),
          wantTabs: s.selectedPlanet !== null
        });
      };
      g.clearSelection();
      snap("点空白");
      const nm = g.getState().planets[1].name;
      g.selectPlanetByName(nm);
      snap("选中行星");
      g.focusPlanetByName(nm);
      snap("聚焦同颗");
      g.unfocus();
      snap("回全景");
      g.clearSelection();
      snap("再点空白");
      return out;
    });
    const pn = seq[1].selPlanet;
    const projOk =
      seq[0].sel === "none" && seq[0].selPlanet === null && seq[0].focus === null && seq[0].cam === "free" &&
      seq[1].sel === "planet" && pn !== null && seq[1].focus === null && seq[1].cam === "free" &&
      seq[2].sel === "planet" && seq[2].cam === "focus" && seq[2].focus === pn &&
      seq[3].sel === "planet" && seq[3].cam === "free" && seq[3].focus === null && seq[3].selPlanet === pn &&
      seq[4].sel === "none" && seq[4].selPlanet === null && seq[4].cam === "free" &&
      seq.every((x) => x.ovl === (x.guideOpen ? "guide" : "none")) &&
      /* 面板机器同样只认「行星页」——且 DOM 与它一致：标签栏在所有行星上出现、文明 / 资源页熄灭 */
      seq.every((x) => x.pan === "planet" && x.civShown === false && x.resShown === false && x.tabsShown === x.wantTabs);
    check("★ 机器状态 = G 字段 = DOM（四台机器逐帧一致）", projOk,
      seq.map((x) => `${x.tag}[${x.sel}/${x.cam}/${x.ovl}/${x.pan}]`).join(" → "));

    /* 覆盖层：真点按钮开、真点 × 关，两边都对得上 */
    await page.click("#guide-btn");
    const ov1 = await page.evaluate(() => ({
      st: window.__game.fsm().machines["覆盖层"].state,
      open: window.__game.guideOpen(),
      hidden: document.getElementById("guide").classList.contains("hidden")
    }));
    await page.click("#guide-close");
    const ov2 = await page.evaluate(() => ({
      st: window.__game.fsm().machines["覆盖层"].state,
      open: window.__game.guideOpen(),
      hidden: document.getElementById("guide").classList.contains("hidden")
    }));
    check("★ 覆盖层机器驱动真点击（开 → guide / 关 → none，DOM 跟着走）",
      ov1.st === "guide" && ov1.open === true && ov1.hidden === false &&
      ov2.st === "none" && ov2.open === false && ov2.hidden === true,
      `开:${ov1.st}/${ov1.hidden ? "hidden" : "显示"} 关:${ov2.st}/${ov2.hidden ? "hidden" : "显示"}`);

    /* 书合着时按 Esc / ←→：键盘归场景，覆盖层机器不该有任何动静 */
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await sleep(200);
    const ovlKey = await page.evaluate(() => window.__game.fsm().machines["覆盖层"]);
    check("★ 书合着时 Esc / ←→ 不触碰覆盖层机器（键盘路由闸门有效）",
      ovlKey.state === "none" && ovlKey.illegal === 0,
      `state=${ovlKey.state} 非法=${ovlKey.illegal}`);

    /* ★ 全程零非法转移：上面所有真点击 / 真按键 / API 调用串起来的巡览，
     * 一次都没踩到「设计之外」的组合。这条是本节的核心判据。 */
    const fsmAll = await page.evaluate(() => window.__game.fsm());
    check("★ 四台机器在册（选择 / 相机 / 覆盖层 / 面板）",
      Object.keys(fsmAll.machines).length === 4 && !!fsmAll.machines["面板"],
      Object.keys(fsmAll.machines).join(" / "));
    check("★ 全程零非法状态转移（用户能做出的操作全在设计之内）", fsmAll.illegal === 0,
      Object.keys(fsmAll.machines).map((k) => k + "=" + fsmAll.machines[k].state).join(" · ") + " · 非法=" + fsmAll.illegal);
    console.log("  ℹ " + (await page.evaluate(() => window.__game.fsmBrief())));

    /* ---- 22. ★ 聚焦地表（v0.12 新增）：立方球连续地表 ---- */
    console.log("\n[22] ★ 聚焦地表：连续场 + 片元调色（聚焦档的表面表示）");
    /* 立场：v0.12 把 demo（demos/cube-sphere）验证过的 C 路线搬进主工程 ——
     * 聚焦档不再看贴图，而是看**连续场构建的立方球表面**；非聚焦维持贴图。
     * 本节验六件事：进得去（聚焦固态 → 立方球亮、贴图网格隐）、结构对
     * （6 面 × 64² 格，顶点/三角形数机器复算）、物理同源（水面覆盖 =
     * 挥发分丰度）、确定性（重建签名一致 + 零 RNG）、退得回（Esc → 网格归位）、
     * 气态不参与（没有固体表面）· 云层与贴图口径同源。 */
    await page.evaluate(() => { window.__game.clearSelection(); window.__game.unfocus(); });
    await sleep(500);
    const fsProbe = await page.evaluate(() => {
      const g = window.__game;
      const W = window.innerWidth, H = window.innerHeight;
      const onScreen = (t) => {
        const sp = g.planetScreenPos(t.name);
        return sp.x > 220 && sp.x < W - 400 && sp.y > 140 && sp.y < H - 140;
      };
      const ter = g.terrain();
      const solid = ter.filter((t) => t.solid);
      const target = (solid.filter((t) => t.sea && onScreen(t))[0]
        || solid.filter((t) => onScreen(t))[0] || solid[0]);
      return { target: target.name, gas: (ter.find((t) => !t.solid) || null) };
    });
    /* 目标可能在屏外/被面板压住 —— 先拉到全景再定位 */
    await page.evaluate((n) => {
      const sp = window.__game.planetScreenPos(n);
      const W = window.innerWidth, H = window.innerHeight;
      if (!(sp.x > 220 && sp.x < W - 400 && sp.y > 140 && sp.y < H - 140)) window.__game.zoomTo(140);
    }, fsProbe.target);
    await sleep(1300);
    const fsPos = await page.evaluate((n) => {
      const sp = window.__game.planetScreenPos(n);
      return { x: Math.round(sp.x), y: Math.round(sp.y) };
    }, fsProbe.target);
    await page.mouse.dblclick(fsPos.x, fsPos.y);
    await sleep(1800);

    const fsA = await page.evaluate((n) => window.__game.focusSurface(n), fsProbe.target);
    check("★ 聚焦固态行星 → 立方球连续地表登场（贴图网格退场）",
      fsA.solid && fsA.built && fsA.active === true && fsA.meshVisible === false,
      `「${fsProbe.target}」built=${fsA.built} active=${fsA.active} meshVisible=${fsA.meshVisible} · 构建 ${fsA.ms}ms`);
    check("★ 网格结构：6 面 × 64² 格（顶点/三角形数机器复算）",
      fsA.N === 64 && fsA.verts === 6 * 65 * 65 && fsA.tris === 12 * 64 * 64,
      `N=${fsA.N} · ${fsA.verts} 顶点 · ${fsA.tris} 三角形`);
    const expCover = Math.min(0.95, Math.max(0.05, fsA.water * 1.15));
    check("★ 物理同源：海平面重标定 0.5 且水面覆盖 = 挥发分丰度（与贴图管线同一保证）",
      fsA.sea === 0.5 ? Math.abs(fsA.seaFrac - expCover) < 0.06
        : (fsA.sea === -1 && fsA.seaFrac === 0),
      `「${fsProbe.target}」水 ${fsA.water.toFixed(3)} → 期望覆盖 ${expCover.toFixed(3)} · 实测 ${fsA.seaFrac} · 海平面 ${fsA.sea}`);
    check("★ 云层与贴图口径同源（planetCloudy：大气 ≥ 0.40 的岩质行星才有云壳）",
      fsA.cloudy === !!fsA.cloud && (!fsA.cloud || (fsA.cloud.cover > 0.30 && fsA.cloud.cover < 0.85)),
      fsA.cloud ? `cover=${fsA.cloud.cover} opacity=${fsA.cloud.opacity}` : `cloudy=${fsA.cloudy} · 无云壳`);
    await shot(page, "n22-focus-surface.png");

    /* 确定性：拆除重建，签名必须一致；且整段不碰主随机流 */
    const fsRR0 = await page.evaluate(() => window.__game.getState().rngDraws);
    const fsB = await page.evaluate((n) => window.__game.rebuildFocusSurface(n), fsProbe.target);
    const fsRR1 = await page.evaluate(() => window.__game.getState().rngDraws);
    check("★ 确定性：重建两次高程签名一致（同一种子 → 同一颗星球）",
      fsA.sig === fsB.sig && fsA.seaFrac === fsB.seaFrac && fsB.built,
      `sig ${fsA.sig} = ${fsB.sig} · 覆盖 ${fsA.seaFrac} = ${fsB.seaFrac}`);
    check("★ 零 RNG：聚焦地表的构建/重建不碰主随机流（rngDraws 一格不动）",
      fsRR0 === fsRR1, `${fsRR0} → ${fsRR1}`);

    /* 拉近看地表细节（聚焦档存在的意义）后拍一张 */
    await page.mouse.move(560, 420);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -140); await sleep(140); }
    await sleep(600);
    await shot(page, "n22b-focus-close.png");

    /* 退得回：Esc → follow，立方球退场、贴图网格归位 */
    await page.keyboard.press("Escape");
    await sleep(900);
    const fsC = await page.evaluate((n) => window.__game.focusSurface(n), fsProbe.target);
    check("★ 退出聚焦（Esc → follow）→ 连续地表退场、贴图网格归位",
      !fsC.active && fsC.meshVisible === true,
      `active=${fsC.active} meshVisible=${fsC.meshVisible}`);

    /* 气态行星不参与（没有固体表面） */
    await page.evaluate(() => { window.__game.unfocus(); window.__game.clearSelection(); window.__game.zoomTo(140); });
    await sleep(1400);
    const gasPick = await page.evaluate(() => {
      const g = window.__game;
      const W = window.innerWidth, H = window.innerHeight;
      const t = g.terrain().find((x) => !x.solid);
      if (!t) return null;
      const sp = g.planetScreenPos(t.name);
      return { name: t.name, x: Math.round(sp.x), y: Math.round(sp.y), ok: sp.x > 220 && sp.x < W - 400 && sp.y > 140 && sp.y < H - 140 };
    });
    if (gasPick && gasPick.ok) {
      await page.mouse.dblclick(gasPick.x, gasPick.y);
      await sleep(1600);
      const fsG = await page.evaluate((n) => window.__game.focusSurface(n), gasPick.name);
      check("★ 气态行星不建连续地表（没有固体表面；聚焦仍看贴图）",
        !fsG.solid && !fsG.built && fsG.active === false && fsG.meshVisible === true,
        `「${gasPick.name}」built=${fsG.built} meshVisible=${fsG.meshVisible}`);
      await page.keyboard.press("Escape");
      await sleep(500);
    } else {
      check("★ 气态行星不建连续地表（本星系气态行星不在屏内，跳过实聚焦）", false,
        gasPick ? "不在安全区" : "无气态行星");
    }
    /* 云层的正面用例：带大气的固态行星「建面」后云壳必在（覆盖随大气变）。
     * 走 rebuildFocusSurface 直接构建 —— 不必把它转到屏幕前聚焦。 */
    const cloudBuild = await page.evaluate(() => {
      const g = window.__game;
      const t = g.terrain().filter((x) => x.solid && x.atmo >= 0.40 && x.tempSurf > 150 && x.tempSurf < 700)[0];
      if (!t) return null;
      const f = g.rebuildFocusSurface(t.name);
      return { name: t.name, atmo: f.atmo, cloudy: f.cloudy, cloud: f.cloud };
    });
    const expCloudCover = cloudBuild
      ? Math.min(0.82, Math.max(0.54, 0.82 - 0.22 * Math.min(1, Math.max(0, cloudBuild.atmo))))
      : 0;
    check("★ 云层的正面用例：带大气的固态行星建面后云壳登场（覆盖随大气变）",
      !!cloudBuild && cloudBuild.cloudy === true && !!cloudBuild.cloud &&
        Math.abs(cloudBuild.cloud.cover - expCloudCover) < 0.02,
      cloudBuild ? `「${cloudBuild.name}」大气 ${cloudBuild.atmo.toFixed(2)} → 期望 cover ${expCloudCover.toFixed(3)} · 实测 ${cloudBuild.cloud && cloudBuild.cloud.cover}`
        : "本星系无「带大气的固态行星」（世界变了？）");

    /* ★ v0.12.3：云图案 = 烘焙贴图（1024×512 · linear/mipmap 预过滤）——
     * 替代逐像素 3D 噪声：修「云边锯齿」（噪声采样走样），并省掉每像素 ~48 次哈希。 */
    check("★ 云图案是烘焙贴图（预过滤 —— 云边不再有逐像素噪声的走样毛刺）",
      !!cloudBuild && !!cloudBuild.cloud &&
        cloudBuild.cloud.texW === 1024 && cloudBuild.cloud.texH === 512,
      cloudBuild && cloudBuild.cloud
        ? `贴图 ${cloudBuild.cloud.texW}×${cloudBuild.cloud.texH} · 生成 ${cloudBuild.cloud.texMs}ms（一次性）`
        : "（无云壳）");

    await page.evaluate(() => { window.__game.unfocus(); window.__game.clearSelection(); });
    await sleep(400);

    /* ---- 23. ★ 聚落系统（v0.13 · 实验性）：连续场选址 + 点击放置 ---- */
    console.log("\n[23] ★ 聚落系统：连续场选址 + 点击放置（实验性）");
    /* 立场：DESIGN.md §5 的实验性落地 —— 聚焦档在星球表面放置聚落。
     * 本节验六件事（全部机器判据）：
     *   ① B 键进入选址模式（键盘链路）+ 光标在屏
     *   ② 硬闸门 = 连续场纯函数（海面 / 极冠被拒，合格点通过并给评分）
     *   ③ 点击放置（UI 全链路）+ 不叠城闸门
     *   ④ 城市贴地（站心 = 连续场表面点；投影回屏幕 ≈ 点击点 —— 契约⑦）
     *   ⑤ 重建地表后城市自愈（数据是唯一真值源、几何是派生）
     *   ⑥ 退出聚焦 → 点位标记仍挂全景网格（DESIGN §5.4 方案 A）
     * 试验场选「有海行星」—— 海面闸门需要它。 */
    const sp23 = await page.evaluate(() => {
      const t = window.__game.terrain().filter((x) => x.solid && x.sea)[0];
      return t ? t.name : null;
    });
    check("★ 选一颗有海固态行星作试验场（海面闸门需要「海」）", !!sp23, sp23 || "（世界变了？）");
    await page.evaluate((n) => window.__game.focusPlanetByName(n), sp23);
    await sleep(2400);

    /* ① B 键 → 选址模式 */
    await page.keyboard.press("b");
    await page.mouse.move(640, 420);
    await sleep(400);
    const sm1 = await page.evaluate((n) => window.__game.settlements(n), sp23);
    check("★ B 键进入选址模式（光标在屏 —— 可建/不可建预览就位）",
      sm1 && sm1.mode === true && sm1.cursorVisible === true,
      `mode=${sm1 && sm1.mode} · cursorVisible=${sm1 && sm1.cursorVisible}`);

    /* ② 硬闸门：海面 / 极冠 / 可建点 */
    const gate23 = await page.evaluate((n) => {
      const G = window.__game;
      const out = { sea: null, polar: null, good: null, goodDir: null };
      for (let a = 0; a < 90 && !out.sea; a++) {
        const lat = -1 + a * 0.023, lon = a * 2.1;
        const d = [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
        const c = G.siteCheck(n, d);
        if (c && c.h < 0.48) out.sea = { gate: c.gate, ok: c.ok, h: c.h };
      }
      /* 极冠闸门用「无海行星」测 —— 有海行星的极区可能是海（海门会先拦截，
       * 遮蔽极冠）。薄曙 I 在 [22] 建过面（_cs 缓存仍在）。 */
      const pol = G.siteCheck("薄曙 I", [0, 1, 0]);
      out.polar = { gate: pol.gate, ok: pol.ok, name: "薄曙 I" };
      for (let a = 0; a < 400 && !out.good; a++) {
        const lat = -1.1 + (a % 22) * 0.10, lon = Math.floor(a / 22) * 0.7;
        const d = [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
        const c = G.siteCheck(n, d);
        if (c && c.ok) { out.good = { score: c.score, parts: c.parts.length }; out.goodDir = d; }
      }
      return out;
    }, sp23);
    check("★ 硬闸门 = 连续场纯函数（海面 / 极冠被拒；合格点通过并给评分）",
      !!gate23.sea && gate23.sea.gate === "海面" && gate23.sea.ok === false &&
        !!gate23.polar && gate23.polar.gate === "极冠" && gate23.polar.ok === false &&
        !!gate23.good && gate23.good.score > 0 && gate23.good.parts === 4,
      `海点 h=${gate23.sea && gate23.sea.h} →「${gate23.sea && gate23.sea.gate}」· 极 →「${gate23.polar && gate23.polar.gate}」· 好点 ${gate23.good && gate23.good.score} 分（${gate23.good && gate23.good.parts} 项）`);

    /* ③ 点击放置（UI 全链路）：找屏内可建点 → 点击 → count+1 */
    const ui23 = await page.evaluate((n) => {
      const G = window.__game;
      for (let a = 0; a < 400; a++) {
        const lat = -1.05 + (a % 21) * 0.10, lon = Math.floor(a / 21) * 0.75 + 0.3;
        const d = [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
        const c = G.siteCheck(n, d);
        if (!c || !c.ok) continue;
        const s = G.siteScreen(n, d);
        /* front：只取真正可见的点（视界圆以内 —— 背面/掠射带的投影也在屏内，但点不着） */
        if (!s || s.front !== true || !(s.x > 340 && s.x < 940 && s.y > 200 && s.y < 600)) continue;
        /* ★ 往返自检：从该屏幕坐标反投影必须回到同一方向、且落点也可建 ——
         * 这一关把「球缘掠射带」的贴边点滤掉（投影在屏内但点击会先命中边缘） */
        const pb = G.siteProbe(n, s.x, s.y);
        if (!pb || !pb.dir || !pb.ok) continue;
        const dot = Math.abs(d[0] * pb.dir[0] + d[1] * pb.dir[1] + d[2] * pb.dir[2]);
        if (Math.acos(Math.min(1, dot)) > 0.01) continue;
        return { dir: d, x: Math.round(s.x), y: Math.round(s.y) };
      }
      return null;
    }, sp23);
    let clickOk = false, after1 = null;
    if (ui23) {
      const c0 = await page.evaluate((n) => window.__game.settlements(n).count, sp23);
      await page.mouse.move(ui23.x, ui23.y);
      await sleep(250);
      await page.mouse.click(ui23.x, ui23.y);
      await sleep(450);
      after1 = await page.evaluate((n) => window.__game.settlements(n), sp23);
      clickOk = !!after1 && after1.count === c0 + 1;
    }
    check("★ 点击地表放置聚落（UI 全链路：B 模式 → 光标 → 点击 → 城市落地）",
      clickOk, ui23
        ? `点 (${ui23.x},${ui23.y}) → 聚落 ${after1 && after1.count} 个（${after1 && after1.list.map((c) => "#" + c.n + " " + c.score + " 分").join(" · ")}）`
        : "无屏内可建点");

    const dup23 = ui23
      ? await page.evaluate(([n, d]) => window.__game.placeAt(n, d), [sp23, ui23.dir])
      : null;
    check("★ 不叠城闸门：同址再放被拒（离已有聚落太近）",
      !!dup23 && dup23.ok === false && (dup23.gate || "").indexOf("太近") >= 0,
      dup23 ? `gate=${dup23.gate}` : "（无）");

    /* ④ 城市贴地：站心投影回屏幕 ≈ 点击点（契约⑦）—— 用世界坐标独立投影 */
    let gluePx = 999;
    if (ui23 && clickOk) {
      gluePx = await page.evaluate(([n, x, y]) => {
        const G = window.__game;
        const cw = G.cityWorld(n, G.settlements(n).count - 1);
        const cam = G.debugRefs().camera;
        const v = new THREE.Vector3(cw.world.x, cw.world.y, cw.world.z).project(cam);
        const sx = (v.x * 0.5 + 0.5) * window.innerWidth, sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
        return Math.hypot(sx - x, sy - y);
      }, [sp23, ui23.x, ui23.y]);
    }
    check("★ 城市贴在连续场表面上（站心投影回屏幕 ≈ 点击点 —— worldToLocal 唯一转换点）",
      gluePx < 12, `偏差 ${gluePx.toFixed(1)}px${ui23 ? `（点击 (${ui23.x},${ui23.y})）` : ""}`);

    /* ⑤ 重建自愈：数据是唯一真值源 */
    const rb23a = await page.evaluate((n) => ({ s: window.__game.settlements(n), w: window.__game.cityWorld(n, 0) }), sp23);
    await page.evaluate((n) => window.__game.rebuildFocusSurface(n), sp23);
    await sleep(400);
    const rb23b = await page.evaluate((n) => ({ s: window.__game.settlements(n), w: window.__game.cityWorld(n, 0) }), sp23);
    const dLoc = Math.hypot(
      rb23b.w.local.x - rb23a.w.local.x,
      rb23b.w.local.y - rb23a.w.local.y,
      rb23b.w.local.z - rb23a.w.local.z
    );
    check("★ 重建地表后城市自愈（数量不变 · 站心逐位一致 —— 数据是真值源、几何是派生）",
      rb23b.s.count === rb23a.s.count && dLoc < 1e-4 &&
        rb23b.s.list.every((c) => c.mesh && c.marker),
      `count ${rb23a.s.count} → ${rb23b.s.count} · 站心偏差 ${dLoc.toFixed(6)}`);

    /* ⑥ 退出聚焦 → 点位标记仍挂全景网格 */
    await page.keyboard.press("Escape");
    await sleep(900);
    const fin23 = await page.evaluate((n) => window.__game.settlements(n), sp23);
    check("★ 全景档退化为点位标记（聚焦几何随立方球退场，标记挂贴图网格）",
      !!fin23 && fin23.mode === false && fin23.count >= 1 && fin23.list.every((c) => c.marker === true),
      `count=${fin23 && fin23.count} · markers=${fin23 && fin23.list.map((c) => c.marker).join(",")} · mode=${fin23 && fin23.mode}`);

    await page.evaluate(() => { window.__game.unfocus(); window.__game.clearSelection(); });
    await sleep(400);

    /* ---- 24. 零报错 ---- */
    console.log("\n[24] 控制台");
    check("全程零 console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");
  } finally {
    await browser.close();
    srv.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n========== ${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) {
    failed.forEach((f) => console.log("  ✗ " + f.name + (f.detail ? " —— " + f.detail : "")));
    process.exit(1);
  }
})().catch((e) => { console.error("验证脚本异常:", e); process.exit(1); });
