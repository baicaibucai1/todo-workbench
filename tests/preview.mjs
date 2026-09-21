/**
 * 预览抓图 —— 把工作台的主要视图真实渲染出来，落成 shots/ 下的图片。
 *
 * 和 browser.mjs / todo-extras.mjs 的区别：那些是「断言脚本」，关注对不对；
 * 这个是「看效果」用的，关注长什么样。所以它只做三件事：
 *   1. 逐屏切换主要视图并截图
 *   2. 顺手收集控制台错误（有错就在结尾点名，避免截了一堆坏图还不知道）
 *   3. 核对每屏「确实切过去了」——防止某屏没切成功却截了上一屏的图
 *
 * 第 3 点比看起来重要：截图脚本最容易骗人的地方就是「截了一张很正常的图，
 * 但其实是别的界面」。所以工具屏会去 iframe 里读真实文本，
 * 顺便也能发现「退化成了契约说明页」这种静默失败。
 *
 * 前提：dev server 已在 localhost:1420 运行
 *   node node_modules/vite/bin/vite.js --port 1420
 *
 * 用法：
 *   node tests/preview.mjs              # 全部
 *   node tests/preview.mjs core         # 只抓待办视图与设置
 *   node tests/preview.mjs tool         # 只抓工具屏
 *   node tests/preview.mjs order        # 只抓工单/紧急区
 *   node tests/preview.mjs --w=1440     # 自定义视口宽度
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pngDataUrl } from "./png.mjs";

// 复用 QQbot 里已装的 playwright，避免重复下载浏览器
const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

// 用本机 Edge：与 Tauri 的 WebView2 同源，效果更贴近打包后的真实观感
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:1420/";
const OUT = path.resolve("shots");

const argv = process.argv.slice(2);
const widthArg = argv.find((a) => a.startsWith("--w="));
const VIEWPORT = { width: widthArg ? Number(widthArg.slice(4)) : 1180, height: 780 };
/** 是否先清掉浏览器演示库，让种子数据重新种一遍 */
const FRESH = argv.includes("--fresh");
const FILTER = argv.find((a) => !a.startsWith("--")) ?? "";

/**
 * 要抓的每一屏。
 *   kind=view    智能视图/清单：核对 h1 标题
 *   kind=gallery 图库：它没有 h1（头部是一行小标题 + 计数），单独核 data-gallery
 *   kind=tool    工具：核对 iframe 真的挂了且载入了内容
 *   kind=modal   弹层：核对面板出现且标题正确
 */
const SCREENS = [
  { nav: "myday", file: "01-myday.png", kind: "view", title: "我的一天" },
  { nav: "important", file: "02-important.png", kind: "view", title: "重要" },
  { nav: "planned", file: "03-planned.png", kind: "view", title: "计划内" },
  { nav: "all", file: "04-all.png", kind: "view", title: "全部" },
  { nav: "orders", file: "05-orders.png", kind: "view", title: "工单" },
  { nav: "special", file: "06-special.png", kind: "view", title: "特殊单号" },
  { nav: "gallery", file: "07-gallery.png", kind: "gallery", title: "图库" },
  { nav: "tool:image-crop", file: "11-tool-image-crop.png", kind: "tool", id: "image-crop", name: "图片裁剪" },
  { nav: "tool:size-chart", file: "12-tool-size-chart.png", kind: "tool", id: "size-chart", name: "尺码表生成器" },
  { nav: "tool:ai-gen", file: "13-tool-ai-gen.png", kind: "tool", id: "ai-gen", name: "AI 生成" },
  { nav: "settings", file: "20-settings.png", kind: "modal", title: "设置" },
];

/**
 * 分组过滤。
 *
 * 支持两种写法：具体的导航键片段（如 `tool:ai-gen`），
 * 或者语义分组名（core = 待办视图与设置，tool = 工具，order = 工单与紧急区）。
 * 只按下标片段过滤的话，想"只看待办那几屏"就得把 nav 名一个个列出来。
 */
const GROUPS = {
  core: ["view", "modal", "gallery"],
  tool: ["tool"],
  order: ["order"],
  bg: ["bg"],
};
const wantKinds = FILTER ? (GROUPS[FILTER] ?? null) : null;
const skip = (s) =>
  wantKinds
    ? !wantKinds.includes(s.kind)
    : FILTER
      ? !s.nav.includes(FILTER)
      : false;

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: VIEWPORT });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const problems = [];

console.log(`\n视口 ${VIEWPORT.width}x${VIEWPORT.height}  →  ${OUT}\n`);

await page.goto(BASE, { waitUntil: "networkidle" });

// 浏览器演示模式的数据存在 localStorage 里。想看"全新安装"的样子
// （种子数据 + 默认流程 + 特殊单号），就得先把它清掉再重载。
if (FRESH) {
  await page.evaluate(() => localStorage.removeItem("todo-workbench:demo-db"));
  await page.reload({ waitUntil: "networkidle" });
  console.log("已重置演示库，重新种入种子数据\n");
}

// MemoryDb 建表 + 种子数据是异步的，等侧边栏渲染出来再动
await page.locator("aside").first().waitFor({ timeout: 15000 });
await page.waitForTimeout(900);

/** 这一屏「确实切过去了」吗？返回 null 表示没问题，否则返回原因 */
async function verify(s) {
  if (s.kind === "view" || s.kind === "modal") {
    const h1 = page.locator("h1").first();
    if ((await h1.count()) === 0) return "页面上没有 h1";
    const got = (await h1.innerText()).trim();
    if (got !== s.title) return `期望标题「${s.title}」，实际「${got}」`;
    return null;
  }

  // 图库屏：它的头部不是 h1（一行图标 + 「图库」+ 计数），
  // 所以按 data-gallery 这个自有标记来判断，而不是硬凑一个标题选择器
  if (s.kind === "gallery") {
    const root = page.locator("[data-gallery]").first();
    if ((await root.count()) === 0) return "主区域没有 [data-gallery]（没切到图库）";
    const txt = (await root.innerText()).trim();
    if (!txt.includes("图库")) return `图库视图里没读到标题，实际开头：「${txt.slice(0, 40)}」`;
    return null;
  }

  // 工具屏：先看有没有退化到契约说明页（静默失败的主要形态）
  const body = await page.locator("body").innerText();
  if (body.includes("没能解析出")) return "退化成契约说明页（工具入口没解析出来）";

  const frame = page.locator(`[data-tool-frame="${s.id}"]`);
  if ((await frame.count()) === 0) return `没找到 iframe [data-tool-frame="${s.id}"]`;

  // 真正读一下 iframe 里的文字：能读到非空内容才算载入成功
  try {
    const inner = await page
      .frameLocator(`[data-tool-frame="${s.id}"]`)
      .locator("body")
      .innerText({ timeout: 5000 });
    if (!inner.trim()) return "iframe 已挂载但内容为空";
    return null;
  } catch (e) {
    return `iframe 内容读取失败：${String(e.message).split("\n")[0]}`;
  }
}

/*
 * 图库是"别人往里放东西"的地方，自己没有种子数据。
 * 不先放几张，抓出来的就是一个空面板 —— 看不出格子排布对不对、也看不出
 * 四种来源的徽标长什么样。这种截图等于没截。
 */
await page.evaluate(async (imgs) => {
  const g = await import("/src/lib/gallery.ts");
  for (const it of imgs) {
    await g.addToGallery({ dataUrl: it.url, title: it.title, origin: it.origin, prompt: it.prompt });
  }
  g.notifyGalleryChanged();
}, [
  { url: pngDataUrl(240, 180, [200, 70, 70]), title: "主图-红色款.jpg", origin: "manual" },
  { url: pngDataUrl(240, 180, [70, 110, 200]), title: "AI 出图 · 秋冬外套", origin: "ai-gen", prompt: "白色背景 商品 45 度" },
  { url: pngDataUrl(240, 180, [90, 170, 110]), title: "裁剪后的方图.png", origin: "image-crop" },
  { url: pngDataUrl(240, 180, [220, 180, 90]), title: "尺码表-淘宝-1080.png", origin: "size-chart" },
]);
await page.waitForTimeout(1000);

for (const s of SCREENS) {
  if (skip(s)) continue;

  const btn = page.locator(`aside [data-nav="${s.nav}"]`).first();
  if ((await btn.count()) === 0) {
    problems.push(`${s.file} — 侧边栏找不到 data-nav="${s.nav}"`);
    console.log(`  SKIP  ${s.file.padEnd(30)} 侧边栏无此项`);
    continue;
  }

  await btn.click();
  // 工具是 iframe，冷启动要跑一遍它自己的初始化，给足时间
  await page.waitForTimeout(s.kind === "tool" ? 2000 : 600);

  const bad = await verify(s);
  if (bad) problems.push(`${s.file} — ${bad}`);

  const file = path.join(OUT, s.file);
  await page.screenshot({ path: file });
  const size = (fs.statSync(file).size / 1024).toFixed(1);
  const label = s.kind === "tool" ? s.name : s.title;
  console.log(
    `  ${bad ? "WARN" : "OK  "}  ${s.file.padEnd(30)} ${size.padStart(7)} KB   ${label}${bad ? `   ← ${bad}` : ""}`,
  );

  // 设置是覆盖层，截完关掉，免得影响后面的屏
  if (s.kind === "modal") {
    const close = page.locator('[data-act="close-settings"]').first();
    if ((await close.count()) > 0) {
      await close.click();
      await page.waitForTimeout(400);
    } else {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }
}

// 详情面板：点开第一条待办，右侧抽屉是常驻展开的
if (!wantKinds || wantKinds.includes("view")) {
  // 必须先回到待办视图。这一段的上一屏很可能是工具或设置 ——
  // 那时主区域根本不是任务列表，列表行自然找不到（早先踩过）。
  await page.locator('aside [data-nav="all"]').first().click();
  await page.waitForTimeout(800);

  const row = page.locator("[data-task-id]").first();
  if ((await row.count()) > 0) {
    await row.click();
    await page.waitForTimeout(800);
    const mode = await page.locator("aside[data-detail-mode]").getAttribute("data-detail-mode");
    if (mode !== "task") problems.push(`30-task-detail.png — 详情面板处于「${mode}」模式`);
    const file = path.join(OUT, "30-task-detail.png");
    await page.screenshot({ path: file });
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(
      `  OK    ${"30-task-detail.png".padEnd(30)} ${size.padStart(7)} KB   待办详情（mode=${mode}）`,
    );
  } else {
    problems.push("30-task-detail.png — 没有可点击的待办行");
  }
}

/* ---------------- 工单与紧急区 ---------------- */
/*
 * 这几屏没法靠导航键点到：工单混在列表里、流程编辑器是弹层、紧急区在侧边栏底部。
 * 所以单独走一段交互式抓图，顺带核对每一步真的发生了
 * （比如"点开了工单详情"要能从 data-detail-mode 读出来，而不是靠截图猜）。
 */
if (!wantKinds || wantKinds.includes("order")) {
  const shot = async (name, label) => {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  OK    ${name.padEnd(30)} ${size.padStart(7)} KB   ${label}`);
  };

  // 只截某个元素。附件区在详情抽屉里，整页截图看不清它，
  // 而且它在滚动容器里 —— 元素截图能顺带把滚动进视野的那段取全。
  const shotFrom = async (locator, name, label) => {
    const file = path.join(OUT, name);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.screenshot({ path: file });
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  OK    ${name.padEnd(30)} ${size.padStart(7)} KB   ${label}`);
  };

  // 回到「全部」，工单与待办都在这儿
  await page.locator('aside [data-nav="all"]').first().click();
  await page.waitForTimeout(800);

  const orderCount = await page.locator("[data-order-id]").count();
  if (orderCount === 0) {
    problems.push("工单屏 — 「全部」视图里一行工单都没有（种子数据或混排渲染有问题）");
    console.log("  WARN  工单屏：列表里没有工单行");
  } else {
    await shot("40-mixed-list.png", `工单待办混排（${orderCount} 行工单）`);
  }

  // 新建工单：底部回车打开的是全参数表单（标题/单号/流程/过程态/日期/备注），
  // 而不是回车就建一张只有标题的半成品单
  await page.locator('aside [data-nav="orders"]').first().click();
  await page.waitForTimeout(700);
  await page.locator("[data-compose-input]").fill("1027 改码发货");
  await page.locator("[data-compose-submit]").click();
  await page.waitForTimeout(700);
  const ocForm = page.locator("[data-order-create]");
  if ((await ocForm.count()) === 0) {
    problems.push("07-order-create.png — 新建工单表单没打开");
  } else {
    await shot("07-order-create.png", "新建工单表单（全参数一次填完）");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  // 回「全部」继续后面的混排屏
  await page.locator('aside [data-nav="all"]').first().click();
  await page.waitForTimeout(700);

  // 右侧面板的调宽把手：真拖一下再截图，比"画了个把手"有说服力。
  // 看长备注 / 附件时最需要它，窄屏尤其
  const resizer = page.locator("[data-detail-resizer]");
  const panelEl = page.locator("aside[data-detail-mode]");
  if ((await resizer.count()) === 0) {
    problems.push("08-detail-wide.png — 找不到面板调宽把手");
    console.log("  WARN  面板调宽：把手上没有元素");
  } else {
    const before = Number(await panelEl.getAttribute("data-detail-width"));
    const rb = await resizer.boundingBox();
    if (!rb) {
      problems.push("08-detail-wide.png — 把手拿不到 boundingBox");
    } else {
      const y = rb.y + rb.height / 2;
      const x = rb.x + rb.width / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 170, y, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(500);
      const after = Number(await panelEl.getAttribute("data-detail-width"));
      if (after <= before) {
        problems.push(`08-detail-wide.png — 拖了但没变宽（${before} → ${after}）`);
      }
      await shot("08-detail-wide.png", `右侧面板可拖宽（${before} → ${after}）`);

      // 拖回去：往右狠拖会被夹到下限，后面的屏保持默认观感
      const rb2 = await resizer.boundingBox();
      await page.mouse.move(rb2.x + rb2.width / 2, rb2.y + rb2.height / 2);
      await page.mouse.down();
      await page.mouse.move(rb2.x + 500, rb2.y + rb2.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
  }

  // 紧急区：侧边栏底部
  const urgent = page.locator("[data-urgent-panel]");
  if ((await urgent.count()) === 0) {
    problems.push("41-urgent-panel.png — 侧边栏底部没有紧急区");
    console.log("  WARN  紧急区：侧边栏里找不到");
  } else {
    await urgent.screenshot({ path: path.join(OUT, "41-urgent-panel.png") });
    const size = (fs.statSync(path.join(OUT, "41-urgent-panel.png")).size / 1024).toFixed(1);
    const n = await page.locator("[data-urgent-item]").count();
    console.log(
      `  OK    ${"41-urgent-panel.png".padEnd(30)} ${size.padStart(7)} KB   紧急区（${n} 条）`,
    );
  }

  // 打开一张工单的详情
  if (orderCount > 0) {
    await page.locator("[data-order-id]").first().click();
    await page.waitForTimeout(800);
    const mode = await page.locator("aside[data-detail-mode]").getAttribute("data-detail-mode");
    if (mode !== "order") {
      problems.push(`42-order-detail.png — 点了工单行但详情面板处于「${mode}」模式`);
    }
    await shot("42-order-detail.png", `工单详情（mode=${mode}）`);

    // 附件区：先贴一个同源图片网址，抓"真的下载下来并渲染出来"的样子。
    // 用同源壁纸做素材：浏览器 demo 只能硬扛 CORS，跨域地址在这里下不下来。
    const attInput = page.locator("[data-attach-input]");
    if ((await attInput.count()) === 0) {
      problems.push("50-attachments.png — 工单详情里没有附件区");
    } else {
      await attInput.fill(`${BASE}wallpapers/20260917.jpg`);
      await attInput.press("Enter");
      await page.waitForTimeout(1400);
      await attInput.fill(`${BASE}wallpapers/index.json`);
      await attInput.press("Enter");
      await page.waitForTimeout(1200);

      const attShot = await page.locator("[data-attach-panel]").first();
      const attCount = await page.locator("[data-attach-item]").count();
      if (attCount < 2) problems.push(`50-attachments.png — 附件只加进来 ${attCount} 条`);
      await shotFrom(attShot, "50-attachments.png", `附件区（${attCount} 条：1 图 + 1 链接）`);

      // 灯箱：点图块的「查看大图」按钮。用 title 定位而不是 button 下标 ——
      // 每个图块里还有上移/下移/删除三个按钮，靠 .first() 撞运气不稳。
      const imgTile = page.locator("[data-attach-grid='image'] button[title^='查看大图']").first();
      if ((await imgTile.count()) > 0) {
        await imgTile.click();
        await page.waitForTimeout(700);
        await shot("52-attach-lightbox.png", "附件大图预览");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
    }

    // 推进过程态：验证"有过程态"这件事真的能操作
    const before = await page.locator("[data-order-id]").first().getAttribute("data-order-id");
    const adv = page.locator("[data-order-advance]").first();
    if ((await adv.count()) > 0) {
      await adv.click();
      await page.waitForTimeout(900);
      const logs = await page.locator("[data-wo-log]").count();
      if (logs < 2) problems.push(`43-order-advanced.png — 推进后流转记录只有 ${logs} 条`);
      await shot("43-order-advanced.png", `推进过程态后（流转记录 ${logs} 条，工单 ${before?.slice(0, 8)}）`);
    } else {
      problems.push("43-order-advanced.png — 找不到可推进的按钮");
    }
  }

  // 流程编辑器
  const flowBtn = page.locator("[data-edit-flows]").first();
  if ((await flowBtn.count()) > 0) {
    await flowBtn.click();
    await page.waitForTimeout(700);
    const open = await page.locator("[data-flow-editor]").count();
    if (!open) problems.push("44-flow-editor.png — 流程编辑器没打开");
    await shot("44-flow-editor.png", `流程编辑器（${open ? "已打开" : "未打开"}）`);
    await page.keyboard.press("Escape");
    await page.locator('[title="关闭"]').first().click().catch(() => {});
    await page.waitForTimeout(400);
  } else {
    problems.push("44-flow-editor.png — 找不到「编辑流程」入口");
  }
}

/* ---------------- 背景（壁纸） ---------------- */
/*
 * 壁纸屏也没法靠导航键点到：选项在设置的气泡里，效果要回待办区才看得到。
 * 所以同样走交互式抓图 —— 顺手确认"铺上去的图真的被解码了"，
 * 不然截图里是壁纸、实际是 CSS 渐变，肉眼根本分不出来。
 */
if (!wantKinds || wantKinds.includes("bg")) {
  const shot = async (name, label) => {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  OK    ${name.padEnd(30)} ${size.padStart(7)} KB   ${label}`);
  };

  await page.locator('aside [data-nav="settings"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-section="appearance"]').click();
  await page.waitForTimeout(700);

  const opts = page.locator("[data-bg-option]");
  const optCount = await opts.count();
  if (optCount < 2) {
    problems.push(`21-settings-background.png — 背景选项只有 ${optCount} 个（壁纸清单没读到？）`);
  }
  // 壁纸格子可能在设置内容区的折叠线以下，纯视口截图会截不到
  await opts.first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await shot("21-settings-background.png", `设置 · 待办背景（${optCount} 个选项）`);

  if (optCount >= 2) {
    await opts.nth(1).click();
    await page.waitForTimeout(600);
  }
  const close = page.locator('[data-act="close-settings"]').first();
  if ((await close.count()) > 0) await close.click();
  await page.waitForTimeout(500);

  await page.locator('aside [data-nav="myday"]').first().click();
  await page.waitForTimeout(800);

  const bgMode = await page.locator("[data-bg-mode]").first().getAttribute("data-bg-mode");
  if (bgMode !== "image") problems.push(`50-bg-wallpaper.png — 待办区没进壁纸模式（${bgMode}）`);

  const decoded = await page.evaluate(() => {
    const im = document.querySelector("[data-bg-image]");
    return im ? { complete: im.complete, w: im.naturalWidth } : null;
  });
  if (!decoded?.complete || !decoded.w) {
    problems.push(`50-bg-wallpaper.png — 背景图没解码成功（${JSON.stringify(decoded)}）`);
  }
  await shot("50-bg-wallpaper.png", `壁纸背景（mode=${bgMode}，图 ${decoded?.w ?? 0}px 宽）`);

  // 收尾把背景还原成「跟随视图」：不然最后一次截图之后的状态带着壁纸，
  // 下次跑别的屏时会先看到一张壁纸，容易误判成"默认就这样"
  await page.locator('aside [data-nav="settings"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-section="appearance"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-bg-option="auto"]').click();
  await page.waitForTimeout(500);
  const close2 = page.locator('[data-act="close-settings"]').first();
  if ((await close2.count()) > 0) await close2.click();
  await page.waitForTimeout(400);
}

/* ---------------- AI 生成 · 阿里云档位单价 与 图库联动 ---------------- */
/*
 * 这一段抓的是「价格有没有真的算出来」和「图库选择器长什么样」。
 * 光看代码不算数：价格是**按模型算**的（同一家下 0.04 到 0.54 差十几倍），
 * 一个 show/hide 的先后顺序错了就会把它冲掉 —— 所以必须看渲染出来的文字。
 */
if (!wantKinds || wantKinds.includes("tool")) {
  const shot = async (name, label) => {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  ${"OK".padEnd(4)}  ${name.padEnd(30)} ${size.padStart(7)} KB   ${label}`);
  };

  await page.locator('aside [data-nav="tool:ai-gen"]').first().click();
  await page.waitForTimeout(2400);

  const f = page.frames().find((x) => /\/tools\/ai-gen\//.test(x.url()));
  if (!f) {
    problems.push("14-ai-gen-aliyun.png — 没找到 ai-gen 的 iframe");
  } else {
    await f.selectOption("#provSel", "aliyun");
    await page.waitForTimeout(800);
    await f.fill("#imgModel", "wan2.6-t2i");
    await f.dispatchEvent("#imgModel", "input");
    await page.waitForTimeout(600);

    const aliyun = await f.evaluate(() => ({
      price: document.getElementById("imgPrice").textContent.trim(),
      cost: document.getElementById("imgCostHint").textContent.trim(),
      badge: document.body.dataset.tierPrice,
      models: document.querySelectorAll("#modelsImage option").length,
    }));
    console.log(`        单价行：${aliyun.price}`);
    console.log(`        预估花费：${aliyun.cost}`);
    console.log(`        档位数：${aliyun.models}`);
    if (!/元\/张/.test(aliyun.price)) problems.push(`14-ai-gen-aliyun.png — 单价行没算出价格：「${aliyun.price}」`);
    if (!/预估/.test(aliyun.cost)) problems.push(`14-ai-gen-aliyun.png — 生成按钮下方没有预估花费：「${aliyun.cost}」`);
    if (aliyun.models < 5) problems.push(`14-ai-gen-aliyun.png — 模型档位只有 ${aliyun.models} 个（档位表没读出来？）`);
    await shot("14-ai-gen-aliyun.png", `AI 生成 · 阿里云（${aliyun.cost}）`);

    // 换一个便宜档，价格要跟着变 —— 这是「按模型算价」的关键证据
    await f.fill("#imgModel", "wan2.0-t2i-turbo");
    await f.dispatchEvent("#imgModel", "input");
    await page.waitForTimeout(600);
    const cheap = await f.evaluate(() => document.getElementById("imgCostHint").textContent.trim());
    console.log(`        换成 0.04 元档后：${cheap}`);
    if (cheap === aliyun.cost) problems.push("14-ai-gen-aliyun.png — 换档位后预估花费没变（价格没跟着模型走）");

    // 图库选择器：先换到支持参考图的档（纯文生图档没有「从图库选」）
    // 图库的内容在开场时已经种好了，这里直接打开就是有东西的状态
    await f.fill("#imgModel", "wan2.6-image");
    await f.dispatchEvent("#imgModel", "input");
    await page.waitForTimeout(600);
    const gate = await f.evaluate(() => ({
      disabled: document.getElementById("btnRefFromGallery").disabled,
      title: document.getElementById("btnRefFromGallery").title,
    }));
    if (gate.disabled) {
      problems.push(`15-ai-gen-gallery-pick.png — 「从图库选」被禁用了：${gate.title}`);
    } else {
      await f.click("#btnRefFromGallery");
      await page.waitForTimeout(1600);
      const picked = await f.evaluate(() => ({
        on: document.getElementById("galleryMask").hidden === false,
        count: document.getElementById("galleryCount").textContent.trim(),
        tiles: document.querySelectorAll("#galleryBody .gitem").length,
      }));
      console.log(`        选择器：${picked.count}，${picked.tiles} 格`);
      if (!picked.on) problems.push("15-ai-gen-gallery-pick.png — 选择器没打开");
      await shot("15-ai-gen-gallery-pick.png", `AI 生成 · 从图库选参考图（${picked.count}，${picked.tiles} 格）`);
      await f.evaluate(() => window.closeGalleryPicker && window.closeGalleryPicker());
    }
    // 还原成默认服务商，免得后续别的脚本打开 ai-gen 时看到的是阿里云
    await f.selectOption("#provSel", "agnes").catch(() => {});
    await page.waitForTimeout(400);
  }
}

await browser.close();

console.log("");
if (errors.length) {
  console.log(`控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log(`  ! ${e}`);
}
if (problems.length) {
  console.log(`\n需要人工确认 ${problems.length} 处：`);
  for (const p of problems) console.log(`  ! ${p}`);
}
if (!errors.length && !problems.length) console.log("渲染干净：各屏都切到位，无控制台错误。");
console.log("");
process.exit(problems.length ? 1 : 0);
