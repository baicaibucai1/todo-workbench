/**
 * 工作台里的工具装载验证。
 *
 * 目的：确认工具不是"理论上能嵌"，而是真的在工作台网页里被加载并可用。
 * 覆盖两层：
 *   宿主层 —— 侧边栏出现工具项、点开后 ToolHost 头部与 iframe 正确
 *   工具层 —— 在 iframe 内部走一遍尺码生成器的核心操作
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge（与 Tauri 的 WebView2 同源）。
 * 前置：`npm run dev`（或 node node_modules/vite/bin/vite.js）已在跑。
 *
 * 用法：node tests/tool-browser.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

const TOOL_ID = "size-chart";
const TOOL_NAME = "尺码表生成器";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

// 宿主与 iframe 的控制台错误都会冒到这里，一并收集
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

console.log("\n1. 工作台加载");
await page.goto(BASE, { waitUntil: "load" });
// store.init() 是异步的：先建库再扫工具，需要等「正在初始化」过去
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);

check("标题正确", (await page.title()) === "待办工作台", await page.title());
check("侧边栏已挂载", (await page.locator("aside").count()) > 0);
check("初始无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log("\n2. 工具已注册到侧边栏");
// 工具区可能被折叠，展开它
const toolRow = page.locator("aside button").filter({ hasText: TOOL_NAME }).first();
if ((await toolRow.count()) === 0 || !(await toolRow.isVisible().catch(() => false))) {
  const expand = page.locator('aside button[title="工具"]').first();
  if ((await expand.count()) > 0) {
    await expand.click();
    await page.waitForTimeout(400);
  }
}
const toolCount = await page.locator("aside button").count();
info("侧边栏按钮总数", toolCount);
check(`侧边栏出现「${TOOL_NAME}」`, (await toolRow.count()) > 0);
check("图片裁剪工具仍在（未破坏已有工具）", (await page.locator("aside button").filter({ hasText: "图片裁剪" }).count()) > 0);

console.log("\n3. 点开工具，宿主容器正确");
await toolRow.click();
await page.waitForTimeout(1200);

const headerText = (await page.locator("header").last().textContent().catch(() => "")) || "";
info("工具头部", headerText.trim().replace(/\s+/g, " "));
check("头部显示工具名", headerText.includes(TOOL_NAME), headerText.slice(0, 80));
check("头部显示版本号", /v\d+\.\d+\.\d+/.test(headerText), headerText.slice(0, 80));
check("头部标明当前模式", headerText.includes("浏览器模式") || headerText.includes("已加载本地工具"));

const iframe = page.locator("iframe");
check("渲染出 iframe", (await iframe.count()) === 1, `count=${await iframe.count()}`);
const iframeSrc = (await iframe.getAttribute("src").catch(() => null)) || "";
info("iframe src", iframeSrc);
check("iframe 指向工具入口", iframeSrc.includes(`/tools/${TOOL_ID}/`), iframeSrc);
check("iframe 未被沙箱拦死（保留 scripts + same-origin）",
  ((await iframe.getAttribute("sandbox")) || "").includes("allow-scripts"));
check("未回落到契约占位视图",
  !(await page.locator("text=工具接入契约").count()));

console.log("\n4. iframe 内部真的加载出了工具界面");
const frame = page.frameLocator("iframe");
await frame.locator("#sidePanel").waitFor({ timeout: 15000 }).catch(() => {});
const frameTitle = await page.evaluate(() => {
  const f = document.querySelector("iframe");
  return f && f.contentDocument ? f.contentDocument.title : null;
});
info("iframe 内文档标题", frameTitle);
check("iframe 内是自己的文档（尺码表生成器）",
  !!frameTitle && frameTitle.includes("尺码表生成器"), String(frameTitle));

const frameState = () =>
  page.evaluate(() => {
    const f = document.querySelector("iframe");
    const d = f && f.contentDocument;
    if (!d) return null;
    const q = (s) => d.querySelector(s);
    return {
      rows: d.querySelectorAll("#editBody tr").length,
      cols: d.querySelectorAll("#editHeaderRow th").length,
      themes: d.querySelectorAll("#themeBar > *").length,
      fonts: d.querySelectorAll("#fontBar > *").length,
      swatches: d.querySelectorAll("#colorGrid > *").length,
      previewLen: (q("#previewCanvas")?.innerHTML || "").length,
      emptyShown: (() => {
        const el = q("#previewEmptyState");
        return !!el && d.defaultView.getComputedStyle(el).display !== "none";
      })(),
      bg: d.defaultView.getComputedStyle(d.body).backgroundColor,
    };
  });

let st = await frameState();
info("iframe 初始状态", st);
check("工具的三栏骨架都在", !!st && (await frame.locator("#previewCanvas").count()) > 0);
check("主题/字体/颜色列表已渲染",
  !!st && st.themes >= 3 && st.fonts >= 3 && st.swatches >= 4,
  st ? `themes=${st.themes} fonts=${st.fonts} swatches=${st.swatches}` : "无法读取");
check("样式已生效（背景色非默认白）", !!st && st.bg !== "rgba(0, 0, 0, 0)" && st.bg !== "rgb(255, 255, 255)", st && st.bg);

console.log("\n5. 在 iframe 内操作工具");
await frame.locator("#previewEmptyState button").click();
await page.waitForTimeout(800);
st = await frameState();
info("载入示例数据后", { rows: st.rows, cols: st.cols, previewLen: st.previewLen, emptyShown: st.emptyShown });
check("载入示例数据生效", st.rows > 0 && st.cols > 0, `rows=${st.rows} cols=${st.cols}`);
check("实时预览已渲染", st.previewLen > 0);
check("空状态已隐藏", !st.emptyShown);

// 切主题
await frame.locator("#themeBar > *").nth(2).click();
await page.waitForTimeout(500);
st = await frameState();
check("切换主题后预览仍存活", st.previewLen > 0);

// 增行
const before = st.rows;
await frame.locator('button[title^="增加行"]').first().click();
await page.waitForTimeout(600);
st = await frameState();
check("iframe 内增行生效", st.rows === before + 1, `${before} → ${st.rows}`);

// 撤销/重做（顺带确认修好的历史逻辑在嵌环境里也正常）
await frame.locator('button[title^="撤销"]').first().click();
await page.waitForTimeout(500);
const afterUndo = (await frameState()).rows;
check("iframe 内撤销生效", afterUndo === before, `${before + 1} → ${afterUndo}`);
await frame.locator('button[title^="重做"]').first().click();
await page.waitForTimeout(500);
const afterRedo = (await frameState()).rows;
check("iframe 内重做生效", afterRedo === before + 1, `${afterUndo} → ${afterRedo}`);

console.log("\n5b. 图库：导出的图默认留一份");

/** 直接读宿主数据层，比在图库视图里数卡片稳（不依赖当前视图） */
const galleryRows = () =>
  page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    const all = await g.fetchGallery();
    return all.map((i) => ({ id: i.id, title: i.title, origin: i.origin, hash: i.hash }));
  });

const frameFlags = () =>
  page.evaluate(() => {
    const d = document.querySelector("iframe").contentDocument;
    if (!d) return null;
    const q = (s) => d.getElementById(s);
    return {
      galleryBtn: !q("btnChartToGallery").hidden,
      autoLine: !q("chkAutoGalleryLine").hidden,
      autoChecked: !!q("chkAutoGallery").checked,
      autoGallery: d.body.dataset.autoGallery ?? "",
      autoArchived: d.body.dataset.autoArchived ?? "",
    };
  });

/** 等工具自己打上"已自动存档"（只在 put 成功时才写） */
const waitArchived = () =>
  page
    .waitForFunction(
      () => {
        const d = document.querySelector("iframe").contentDocument;
        return !!d && d.body.dataset.autoArchived === "1";
      },
      null,
      { timeout: 25000 },
    )
    .catch(() => {});

let fl = await frameFlags();
info("工具内图库入口", fl);
check("宿主点亮了「存进图库」", !!fl && fl.galleryBtn);
check("「导出自动存图库」出现且默认开",
  !!fl && fl.autoLine && fl.autoChecked && fl.autoGallery === "true", JSON.stringify(fl));

const g0 = await galleryRows();
await frame.locator('button[title^="下载 PNG"]').click();
await waitArchived();
const g1 = await galleryRows();
const added = g1.filter((i) => !g0.some((b) => b.id === i.id));
info("导出后图库", { before: g0.length, after: g1.length });
check("只点了下载，图库就多了一条", added.length === 1, `${g0.length} → ${g1.length}`);
check("来源是宿主盖的 size-chart（工具自报不算）",
  added.length === 1 && added[0].origin === "size-chart", JSON.stringify(added));
check("标题用的是尺码表文件名",
  added.length === 1 && /^size-chart-.*\.png$/.test(added[0].title), added[0] && added[0].title);

// 同一份内容再导一次：自动存档带 dedupe，不该再堆一条
await page.evaluate(() => {
  const d = document.querySelector("iframe").contentDocument;
  delete d.body.dataset.autoArchived;
});
await frame.locator('button[title^="下载 PNG"]').click();
await waitArchived();
const g2 = await galleryRows();
check("同样的图再导一次，不重复占条目", g2.length === g1.length, `${g1.length} → ${g2.length}`);

// 关掉开关 → 导出仍要成功，只是不再留档
await frame.locator("#chkAutoGallery").uncheck();
await page.waitForTimeout(700);
check("关掉后工具侧认为不该自动存档",
  (await page.evaluate(
    () => document.querySelector("iframe").contentDocument.defaultView.autoGalleryOn(),
  )) === false);
const g3 = await galleryRows();
await frame.locator('button[title^="下载 PNG"]').click();
await page.waitForTimeout(3500);
const g4 = await galleryRows();
check("关掉开关后不再自动留档", g4.length === g3.length, `${g3.length} → ${g4.length}`);

// 复原：这个偏好是写进库的，留在"关"上会让下一轮跑到这里时默认态变成关
await frame.locator("#chkAutoGallery").check();
await page.waitForTimeout(700);

console.log("\n6. 返回待办，工具状态不残留");
await page.locator("button").filter({ hasText: "返回待办" }).first().click();
await page.waitForTimeout(600);
check("已回到待办视图", (await page.locator("iframe").count()) === 0);

console.log("\n7. 直达链接 ?tool=<id>");
{
  const deep = new URL(BASE);
  deep.searchParams.set("tool", TOOL_ID);
  const p2 = await context.newPage();
  const errs2 = [];
  p2.on("pageerror", (e) => errs2.push(e.message));
  await p2.goto(deep.toString(), { waitUntil: "load" });
  await p2.waitForSelector("aside", { timeout: 20000 });
  await p2.waitForTimeout(1500);
  check("直达链接直接落在工具上", (await p2.locator("iframe").count()) === 1);
  const src = (await p2.locator("iframe").getAttribute("src").catch(() => "")) || "";
  check("直达链接指向正确的工具", src.includes(`/tools/${TOOL_ID}/`), src);

  // 非法的工具 id 不该把应用带崩，应安静地退回待办视图
  const bad = new URL(BASE);
  bad.searchParams.set("tool", "no-such-tool");
  await p2.goto(bad.toString(), { waitUntil: "load" });
  await p2.waitForSelector("aside", { timeout: 20000 });
  await p2.waitForTimeout(1200);
  check("非法 tool 参数退回待办视图", (await p2.locator("iframe").count()) === 0);
  check("非法 tool 参数无未捕获异常", errs2.length === 0, errs2.join(" | "));
  await p2.close();
}

console.log("\n8. 收尾");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 5).join(" | "));

const outDir = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(outDir, { recursive: true });
await toolRow.click().catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/workbench-size-chart.png` });
info("截图", `${outDir}/workbench-size-chart.png`);

await browser.close();

console.log(`\n========== 汇总: ${passed} 通过 / ${failed} 失败 ==========`);
if (failures.length) {
  console.log("失败项:");
  failures.forEach((f) => console.log(" - " + f));
}
process.exit(failed ? 1 : 0);
