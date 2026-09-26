/**
 * AI 生成工具的浏览器验证（tools/ai-gen）。
 *
 * 这个工具有一个特殊性：它的功能全都依赖外部 API，而测试环境里**没有可用的 API Key**。
 * 所以这里不靠"真跑一次生成"来证明它对，而是分三层取证：
 *
 *   1. 请求体构造 —— 用 Playwright 拦截请求，把工具真实发出的 JSON 捞出来逐字段核对。
 *      这是最容易错的地方（Agnes 明确要求 response_format 放 extra_body、轮询路径
 *      在站点根而不在 /v1 下），而它恰好不需要密钥就能验。
 *   2. 结果渲染 —— 拦截后喂回符合官方文档形状的响应，看界面是否真的出图 / 出片 / 出字。
 *      包括视频的"排队 → 进度 → 完成"三段式。
 *   3. 真实连通性 —— 最后打一次真网络（错的密钥），确认地址拼对了、跨域通了、
 *      错误码映射生效。没有这一层，"拦截下的全绿"说明不了线上可用。
 *
 * 另外验证「配置写进本机数据库」这个承诺：保存 → 重载页面 → 配置还在，
 * 并且直接去 localStorage 快照里核对 core_tool_kv 那行的 tool_id 是 ai-gen。
 *
 * 依赖 QQbot 项目里已安装的 playwright，与本机 Edge。
 * 前置：dev server 已在 http://localhost:1420/ 运行。
 *
 * 用法：node tests/ai-gen.mjs [--url http://localhost:1420/]
 */

import { createRequire } from "node:module";
import { makePng } from "./png.mjs";
import { enableModule } from "./_enable-module.mjs";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";

const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
fs.mkdirSync(SHOT_DIR, { recursive: true });

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function info(label, v) {
  console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

/* ------------------------------------------------------------------
 * 造一张真 PNG。测试里需要一个能被浏览器真正解码的图片文件，
 * 所以用 zlib 手写（和 scripts/gen-icons.mjs 一个路子：本环境不指望装图像库）。
 * ------------------------------------------------------------------ */
const PNG = makePng(800, 600, [90, 140, 220]);
/* 阿里云那条单独用另一张：**必须和 Agnes 的字节不同**。
   出图会自动存档，而自动存档是按内容哈希去重的 —— 两条路径出同一张图的话，
   第二次会命中去重、条目数不变。那是正确行为，但会把"新增了一条"的断言
   变成假红，看着像自动存档没生效。 */
const PNG_ALI = makePng(800, 600, [220, 120, 60]);

/* ------------------------------------------------------------------ */

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1520, height: 960 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (n) => page.screenshot({ path: `${SHOT_DIR}/${n}.png` });

async function openTool(id, settle = 1500) {
  await page.goto(`${BASE}?tool=${id}`, { waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(settle);
  const el = page.locator(`iframe[data-tool-frame="${id}"]`);
  if ((await el.count()) === 0) return null;
  await el.waitFor({ state: "attached" });
  await page.waitForTimeout(1000);
  return page.frames().find((f) => new RegExp(`/tools/${id}/`).test(f.url())) ?? null;
}

/** 读一个可能是 input / select / 普通元素的值 */
const readVal = (frame, id) =>
  frame.evaluate((i) => {
    const e = document.getElementById(i);
    if (!e) return "MISSING";
    const v =
      e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" ? e.value : e.textContent;
    return String(v ?? "").trim();
  }, id);

/* ================================================================== */
console.log("\n0. 先启用图库（它是选装模块，工具存图要靠它）");

// 这个套件验的正是"工具的产物能不能落进图库"，而图库 v18 起默认不带 ——
// 不开它，第 1 节的「从图库打开」入口就会整个消失，后面的断言全红在
// "入口不见了"上，看上去像工具坏了。
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(800);
await enableModule(page, "gallery");

console.log("\n1. 图片裁剪工具：Image Studio 已置入工具槽，并可连通图库");

const fc = await openTool("image-crop");
check("iframe 指向 image-crop 入口", !!fc, fc ? fc.url() : "未找到 iframe");

if (fc) {
  const title = await fc.title();
  info("工具标题", title);
  check("工具页是完整版 Image Studio（不是之前的精简重写版）", /Image Studio/.test(title), title);

  // 未载图时的空态：三个导出类按钮都该是禁用的
  const before = await fc.evaluate(() => ({
    chip: document.getElementById("fileChip").className,
    // 只数图片磁贴：队尾还有一块常驻的「＋加入」磁贴，它也是 #thumbList 的直接子元素
    thumbs: document.querySelectorAll("#thumbList .thumb:not(.add)").length,
    dl: document.getElementById("btnDownload").disabled,
    batch: document.getElementById("btnBatch2").disabled,
    preview: document.getElementById("btnPreview").disabled,
    outW: document.getElementById("outW").textContent.trim(),
    saveGallery: document.getElementById("btnSaveToGallery").disabled,
    // 图库入口的显隐 = 宿主有没有推来 gallery 标记。这是「工具与宿主分开升级」
    // 那条设计的可观测面：本机宿主支持，所以这里应该出现
    openGalleryHidden: document.getElementById("btnOpenFromGallery").hidden,
    hostState: document.getElementById("hostState").textContent.trim(),
  }));
  info("载图前", before);
  check("未载图时导出/批量/预览都禁用", before.dl && before.batch && before.preview);
  check("未载图时缩略图为空", before.thumbs === 0, `thumbs=${before.thumbs}`);
  check("未载图时输出尺寸是占位符", before.outW === "—", before.outW);
  check("未载图时「存进图库」禁用", before.saveGallery);
  check("宿主支持图库 → 「从图库打开」入口可见", before.openGalleryHidden === false);
  check("状态条上显示已连工作台", before.hostState === "已连工作台", before.hostState);

  // 图库选择器：能打开、能读到条目
  await fc.evaluate(() => document.getElementById("btnOpenFromGallery").click());
  await page.waitForTimeout(1200);
  const picker = await fc.evaluate(() => ({
    on: document.getElementById("galleryMask").classList.contains("on"),
    count: document.getElementById("galleryCount").textContent.trim(),
    hint: document.getElementById("galleryHint").textContent.trim(),
  }));
  info("图库选择器", picker);
  check("图库选择器能打开", picker.on);
  check("选择器里读到了条目数", /项|读取失败/.test(picker.count), picker.count);
  check("未选中时「导入」是禁用的", picker.hint.includes("已选 0"), picker.hint);
  await fc.evaluate(() => closeGalleryPicker());

  // 载两张：一张才能看出"框出来了"，两张才能验批量的启用条件
  await fc.locator("#fileInput").setInputFiles([
    { name: "probe-a.png", mimeType: "image/png", buffer: PNG },
    { name: "probe-b.png", mimeType: "image/png", buffer: makePng(600, 600, [220, 140, 90]) },
  ]);
  await page.waitForTimeout(2000);

  const after = await fc.evaluate(() => ({
    chip: document.getElementById("fileChip").className,
    chipText: document.getElementById("fileChip").textContent.trim(),
    thumbs: document.querySelectorAll("#thumbList .thumb:not(.add)").length,
    dl: document.getElementById("btnDownload").disabled,
    batch: document.getElementById("btnBatch2").disabled,
    preview: document.getElementById("btnPreview").disabled,
    infoW: document.getElementById("infoW").textContent.trim(),
    infoH: document.getElementById("infoH").textContent.trim(),
    outW: document.getElementById("outW").textContent.trim(),
    outH: document.getElementById("outH").textContent.trim(),
    outEst: document.getElementById("outEst").textContent.trim(),
    listHint: document.getElementById("listHint").textContent.trim(),
    saveGallery: document.getElementById("btnSaveToGallery").disabled,
  }));
  info("载图后", after);
  check("载图后文件条不再是空态", !after.chip.includes("empty"), after.chip);
  check("缩略图列表里有 2 张", after.thumbs === 2, `thumbs=${after.thumbs}`);
  check("原图尺寸被读出（800×600）", after.infoW === "800" && after.infoH === "600", `${after.infoW} / ${after.infoH}`);
  check("输出尺寸算出来了（默认放大 10%）", /^\d+$/.test(after.outW) && /^\d+$/.test(after.outH), `${after.outW}×${after.outH}`);
  check("预估体积有值", after.outEst.length > 0, after.outEst);
  check("导出与预览已启用", !after.dl && !after.preview);
  check("两张时批量导出可用", !after.batch);
  check("列表提示跟上（2 张）", after.listHint.includes("2"), after.listHint);
  check("载图后「存进图库」可用", !after.saveGallery);

  const canvasOk = await fc.evaluate(() => {
    const c = document.getElementById("stageCanvas");
    return { w: c.width, h: c.height, hasLayer: !!document.getElementById("cropLayer") };
  });
  info("画布", canvasOk);
  check("舞台画布已按图片尺寸初始化", canvasOk.w > 0 && canvasOk.h > 0);

  await shot("16-crop-tool");
}

/* ================================================================== */
console.log("\n2. AI 生成：配置写进本机数据库，重载后还在");

const FAKE_KEY = "sk-mock-not-a-real-key-0000";
let f = await openTool("ai-gen");

check("iframe 指向 ai-gen 入口", !!f, f ? f.url() : "未找到 iframe");
if (!f) {
  console.log("\n无法继续：AI 生成工具没打开");
  await browser.close();
  process.exit(1);
}

const bindState = await f.evaluate(() => document.body.dataset.bindState);
check("已通过宿主通道连上数据库", bindState === "bound", `bindState=${bindState}`);

await f.locator("#btnCfg").click();
await page.waitForTimeout(400);
check("配置面板能打开", !(await f.locator("#cfgModal").isHidden()));

// 服务商能力徽章 —— 界面读的是描述符，不是写死的
const badges = await f.locator("[data-prov='agnes'] .cap-badges .b").allInnerTexts();
info("Agnes 能力徽章", badges.join(" / "));
check("Agnes 声明了 对话/生图/生视频 三项能力", badges.length === 3 && badges.every((b) => !b.includes("✗")), badges.join(","));

const provIds = await f.locator("[data-prov]").evaluateAll((els) => els.map((e) => e.dataset.prov));
info("预置服务商", provIds.join(", "));
check("预置了不止一家服务商（可扩展性的证据）", provIds.length >= 2, provIds.join(","));

await f.locator("#cfgBase").fill("https://apihub.agnes-ai.com/v1");
await f.locator("#cfgKey").fill(FAKE_KEY);
await f.locator("#cfgModelImage").fill("agnes-image-2.5-flash");
await f.locator("#cfgModelVideo").fill("agnes-video-2.5-flash");
await f.locator("#cfgModelChat").fill("agnes-3.0-flash");
await f.locator("#btnSave").click();
await page.waitForTimeout(900);

const savedState = await f.evaluate(() => document.body.dataset.configState);
check("保存后状态为 saved（说明宿主确认写库成功）", savedState === "saved", `configState=${savedState}`);
await shot("17-ai-config");
await f.locator("#btnCfgClose").click();
await page.waitForTimeout(300);

// 直接去数据库快照里核对 —— 不只看界面说"已保存"
const kvRow = await page.evaluate(() => {
  const snap = JSON.parse(localStorage.getItem("todo-workbench:demo-db") || '{"tables":[]}');
  const t = (snap.tables || []).find(([n]) => n === "core_tool_kv");
  if (!t) return null;
  return t[1].map((r) => ({ tool_id: r.tool_id, key: r.key, value: String(r.value).slice(0, 40) }));
});
info("core_tool_kv 里的行", kvRow);
check("数据库里出现了 ai-gen 的配置行", !!kvRow && kvRow.some((r) => r.tool_id === "ai-gen" && r.key === "config"), JSON.stringify(kvRow));

// 重新打开整个页面：内存库从快照重建，配置必须还能读回来
f = await openTool("ai-gen", 1800);
const keyBack = await readVal(f, "cfgKey");
const stateBack = await f.evaluate(() => document.body.dataset.configState);
info("重载后读回", { stateBack, keyPrefix: keyBack.slice(0, 12) });
check("重载后配置状态是 loaded", stateBack === "loaded", String(stateBack));
check("重载后 API Key 读回来了", keyBack === FAKE_KEY, `读回 ${keyBack.length} 字符`);

await f.locator("#btnCfg").click();
await page.waitForTimeout(300);
const baseBack = await readVal(f, "cfgBase");
check("重载后 Base URL 读回来了", baseBack === "https://apihub.agnes-ai.com/v1", baseBack);
await f.locator("#btnCfgClose").click();
await page.waitForTimeout(200);

/* ================================================================== */
console.log("\n3. 服务商切换：界面由能力描述符驱动，不是写死的分支");

await f.selectOption("#provSel", "openai-compatible");
await page.waitForTimeout(600);
const compat = await f.evaluate(() => ({
  prov: document.body.dataset.provider,
  videoDisabled: document.querySelector("#tabs .tab[data-tab='video']").disabled,
  videoSub: document.querySelector("#tabs .tab[data-tab='video'] .sub").textContent,
  imgSizes: [...document.querySelectorAll("#imgSize option")].map((o) => o.value),
  ratioHidden: document.getElementById("fieldImgRatio").hidden,
  tab: document.body.dataset.activeTab,
}));
info("切到通用 OpenAI 兼容后", compat);
check("已切到通用服务商", compat.prov === "openai-compatible", compat.prov);
check("没有视频能力 → 生视频页签自动置灰", compat.videoDisabled === true);
check("置灰原因写在页签上", compat.videoSub.includes("不支持"), compat.videoSub);
check("尺寸选项换成了像素尺寸（描述符里的 sizes）", compat.imgSizes.includes("1024x1024"), compat.imgSizes.join(","));
check("没有画幅概念 → 画幅字段隐藏", compat.ratioHidden === true);
await shot("21-ai-openai-compat");

await f.selectOption("#provSel", "agnes");
await page.waitForTimeout(600);
const agnesBack = await f.evaluate(() => ({
  videoDisabled: document.querySelector("#tabs .tab[data-tab='video']").disabled,
  imgSizes: [...document.querySelectorAll("#imgSize option")].map((o) => o.value),
  ratioHidden: document.getElementById("fieldImgRatio").hidden,
}));
check("切回 Agnes 后生视频页签恢复", agnesBack.videoDisabled === false);
check("切回 Agnes 后尺寸档位恢复 1K/2K/3K/4K", agnesBack.imgSizes.join(",") === "1K,2K,3K,4K", agnesBack.imgSizes.join(","));
check("切回 Agnes 后画幅字段重新出现", agnesBack.ratioHidden === false);

// 先把 provider 换回可用的状态并保存，后面几节要用
await f.locator("#btnCfg").click();
await page.waitForTimeout(300);
await f.locator("#cfgBase").fill("https://apihub.agnes-ai.com/v1");
await f.locator("#cfgKey").fill(FAKE_KEY);
await f.locator("#btnSave").click();
await page.waitForTimeout(700);
await f.locator("#btnCfgClose").click();
await page.waitForTimeout(200);

/* ================================================================== */
console.log("\n4. 生图：请求体逐字段核对 + 结果渲染（拦截真实请求）");

const captured = { image: null, video: null, poll: [], chat: null };

await page.route("**/v1/images/generations", async (route) => {
  captured.image = JSON.parse(route.request().postData() || "{}");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      created: 1786900000,
      data: [
        { url: "http://localhost:1420/mock/out-1.png" },
        { url: "http://localhost:1420/mock/out-2.png" },
      ],
    }),
  });
});
await page.route("**/mock/out-*.png", (route) =>
  route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
);

await f.locator("#imgPrompt").fill("一个白色背景下的蓝色马克杯，柔和顶光，45 度俯拍");
await f.locator("#imgModel").fill("agnes-image-2.5-flash");
await f.selectOption("#imgSize", "2K");
await f.selectOption("#imgRatio", "16:9");
await f.selectOption("#imgN", "2");
await f.locator("#btnGenImg").click();
await page.waitForTimeout(2200);

info("实际发出的请求体", captured.image);
check("生图请求打到了 /v1/images/generations", !!captured.image, "没截到请求");
if (captured.image) {
  check("带上 model", captured.image.model === "agnes-image-2.5-flash", String(captured.image.model));
  check("带上 prompt", String(captured.image.prompt).includes("马克杯"));
  check("带上张数 n=2", Number(captured.image.n) === 2, String(captured.image.n));
  check("带上分辨率档 2K", captured.image.size === "2K", String(captured.image.size));
  check("带上画幅 16:9", captured.image.ratio === "16:9", String(captured.image.ratio));
  // 官方文档明确要求这个字段必须在 extra_body 里，放顶层会被拒
  check(
    "response_format 放在 extra_body 里（官方明确的坑）",
    captured.image.extra_body && captured.image.extra_body.response_format === "url",
    JSON.stringify(captured.image.extra_body),
  );
  check("纯文生图时不带 image 字段", captured.image.extra_body.image === undefined);
}

const imgOut = await f.evaluate(() => ({
  cards: document.querySelectorAll("#imgResults .shot").length,
  imgs: document.querySelectorAll("#imgResults .shot img").length,
  count: document.body.dataset.imageCount,
  hist: document.querySelectorAll("#imgHist .hrow").length,
  label: document.getElementById("imgOutLabel").textContent,
}));
info("生图结果", imgOut);
check("界面出了 2 张结果卡", imgOut.cards === 2, `cards=${imgOut.cards}`);
check("结果图真的被浏览器解码了（img 元素在）", imgOut.imgs === 2, `imgs=${imgOut.imgs}`);
check("结果计数写进 dataset（供自动化核对）", imgOut.count === "2", String(imgOut.count));
check("生成历史里出现一条", imgOut.hist >= 1, `hist=${imgOut.hist}`);
await shot("18-ai-image");

/* ---- 图生图：参考图要以 Data URI 出现在 extra_body.image 里 ---- */
console.log("\n  图生图：参考图随请求带上");
await f.locator("#filePick").setInputFiles({ name: "ref.png", mimeType: "image/png", buffer: PNG });
await page.waitForTimeout(900);
const refState = await f.evaluate(() => ({
  refs: document.querySelectorAll("#refList .ref").length,
  count: document.body.dataset.refCount,
  hint: document.getElementById("refHint").textContent,
}));
info("参考图", { refs: refState.refs, hint: refState.hint.slice(0, 50) });
check("参考图缩略图出现了", refState.refs === 1, `refs=${refState.refs}`);
check("参考图计数写进 dataset", refState.count === "1", String(refState.count));
check("提示文案说明已进入图生图", refState.hint.includes("图生图"), refState.hint.slice(0, 60));

captured.image = null;
await f.locator("#btnGenImg").click();
await page.waitForTimeout(2000);
const refBody = captured.image;
info("带参考图时的 extra_body.image[0] 前缀", refBody && refBody.extra_body.image ? String(refBody.extra_body.image[0]).slice(0, 32) : "(无)");
check(
  "参考图以 Data URI 放进 extra_body.image",
  !!refBody && Array.isArray(refBody.extra_body.image) && String(refBody.extra_body.image[0]).startsWith("data:image/png;base64,"),
  refBody ? JSON.stringify(refBody.extra_body).slice(0, 120) : "没截到",
);

// 清掉参考图，避免影响后面的视频测试
await f.locator("#refList .ref .del").first().click();
await page.waitForTimeout(400);
check("参考图可以移除", (await f.evaluate(() => document.body.dataset.refCount)) === "0");

/* ================================================================== */
console.log("\n4b. 阿里云百炼：异步提交 → 轮询 → 出图 → 存进图库");

const ali = { create: null, headers: null, old: null, polls: 0 };

await page.route("**/api/v1/services/aigc/image-generation/generation", async (route) => {
  ali.create = JSON.parse(route.request().postData() || "{}");
  ali.headers = route.request().headers();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    // 只回 task_id —— 异步提交拿到图是不符合这家的模型的
    body: JSON.stringify({ output: { task_id: "task_ali_mock", task_status: "PENDING" } }),
  });
});
await page.route("**/api/v1/services/aigc/text2image/image-synthesis", async (route) => {
  ali.old = JSON.parse(route.request().postData() || "{}");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ output: { task_id: "task_ali_old", task_status: "PENDING" } }),
  });
});
await page.route("**/api/v1/tasks/task_ali_mock", async (route) => {
  ali.polls++;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      output: ali.polls >= 2
        ? {
            task_id: "task_ali_mock",
            task_status: "SUCCEEDED",
            // 图片地址藏在 choices[].message.content[].image，层级很深
            choices: [{ message: { role: "assistant", content: [{ image: "http://localhost:1420/mock/ali-1.png" }] } }],
          }
        : { task_id: "task_ali_mock", task_status: "RUNNING" },
    }),
  });
});
await page.route("**/mock/ali-*.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG_ALI }));

await f.selectOption("#provSel", "aliyun");
await page.waitForTimeout(700);
// 张数是用户的选择，换服务商不该被重置 —— 这里显式归位到 1，
// 好让下面的"预估 = 单价 × 1"这一行断言读起来不绕
await f.selectOption("#imgN", "1");
await f.locator("#imgN").dispatchEvent("change");
await page.waitForTimeout(300);

const aliUi = await f.evaluate(() => ({
  prov: document.body.dataset.provider,
  model: document.getElementById("imgModel").value.trim(),
  tiers: document.querySelectorAll("#modelsImage option").length,
  price: document.getElementById("imgPrice").textContent.trim(),
  cost: document.getElementById("imgCostHint").textContent.trim(),
  tierPrice: document.body.dataset.tierPrice,
  sizes: [...document.querySelectorAll("#imgSize option")].map((o) => o.value),
  ratioHidden: document.getElementById("fieldImgRatio").hidden,
  videoDisabled: document.querySelector("#tabs .tab[data-tab='video']").disabled,
  refBtnDisabled: document.getElementById("btnRefFromGallery").disabled,
}));
info("阿里云默认档", aliUi);
check("切到阿里云后模型落在主力档 wan2.6-t2i（没有把 Agnes 的模型名带过来）",
  aliUi.model === "wan2.6-t2i", aliUi.model);
check("全部档位都可读（万相 + 千问图像 + Z-Image 三族）", aliUi.tiers === 21, String(aliUi.tiers));
check("单价标出来了（0.20 元/张）", /0\.20 元\/张/.test(aliUi.price), aliUi.price);
check("描述上限一并标出", /描述上限 2100 字/.test(aliUi.price), aliUi.price);
check("按钮下方是预估花费而不是静态说明", /预估 0\.20 元/.test(aliUi.cost), aliUi.cost);
check("「失败不计费」跟着预估走（不然用户不敢按）", /失败不计费/.test(aliUi.cost), aliUi.cost);
check("单价写进 dataset 供自动化核对", aliUi.tierPrice === "0.2", String(aliUi.tierPrice));
check("2.6 档给的是宽高自由的像素尺寸", aliUi.sizes.includes("1280*1280") && aliUi.sizes.includes("1968*843"),
  aliUi.sizes.join(","));
check("万相没有画幅概念 → 画幅栏隐藏", aliUi.ratioHidden === true, String(aliUi.ratioHidden));
check("这次没接视频 → 生视频页签置灰", aliUi.videoDisabled === true, String(aliUi.videoDisabled));
// 官方表里 wan2.6-t2i 的"编辑"是支持的，所以它能带参考图 ——
// 不能再按"名字里有没有 image"来判断能不能带图（Z-Image 名字里也有 image 却一张不收）
check("主力档支持参考图 → 「从图库选」可用", aliUi.refBtnDisabled === false, String(aliUi.refBtnDisabled));

// 换档：价格必须跟着模型走，否则标了等于没标
await f.locator("#imgModel").fill("wan2.0-t2i-turbo");
await f.locator("#imgModel").dispatchEvent("input");
await page.waitForTimeout(500);
const cheap = await f.evaluate(() => ({
  price: document.getElementById("imgPrice").textContent.trim(),
  cost: document.getElementById("imgCostHint").textContent.trim(),
  limit: document.getElementById("imgPrice").textContent.includes("800"),
}));
info("换到最便宜档", cheap);
check("最便宜档单价是 0.04 元/张", /0\.04 元\/张/.test(cheap.price), cheap.price);
check("2.0 档的描述上限收紧到 800 字", cheap.limit, cheap.price);
check("预估花费跟着降到 0.04", /预估 0\.04 元/.test(cheap.cost), cheap.cost);

await f.selectOption("#imgN", "3");
await page.waitForTimeout(300);
const cost3 = await f.evaluate(() => document.getElementById("imgCostHint").textContent.trim());
info("3 张时的预估", cost3);
check("预估按张数相乘（0.04 × 3 = 0.12）", /预估 0\.12 元/.test(cost3), cost3);

// 带 image 的档才能从图库取参考图
await f.locator("#imgModel").fill("wan2.6-image");
await f.locator("#imgModel").dispatchEvent("input");
await page.waitForTimeout(500);
const refOk = await f.evaluate(() => ({
  disabled: document.getElementById("btnRefFromGallery").disabled,
  max: Number(document.getElementById("btnRefFromGallery").dataset.max || -1),
}));
info("切到带参考图的档", refOk);
check("带 image 的档放开「从图库选」", refOk.disabled === false, String(refOk.disabled));
check("参考图上限是 3", refOk.max === 3, String(refOk.max));

/* ---- 从本机加参考图：这条**曾经断过**，而且是静默的 ----
   原来这个入口读的是 provider 级的 p.image.maxRef（阿里云恒为 0），
   而不是按模型算的 maxRefsFor(model)（这一档是 3）。于是阿里云下本地图
   会被静默丢弃：界面上写着「已加 0 / 3」，「＋」也在，塞图进去却什么都没发生，
   零报错。旁边的「从图库选」走的是正确路径 —— 表现成「图库能加、本机加不了」。
   全套 172 项当时没抓住它，因为「从本机加」只在 Agnes 下测过（那边 maxRef=4，
   两条路径答案恰好相同）。所以这里必须在**另一家服务商**下再验一遍。 */
await f.locator("#filePick").setInputFiles({ name: "ali-1.png", mimeType: "image/png", buffer: PNG_ALI });
await page.waitForTimeout(1200);
const localAdd = await f.evaluate(() => ({
  count: document.body.dataset.refCount,
  thumbs: document.querySelectorAll("#refList .ref").length,
}));
info("阿里云下从本机加一张", localAdd);
check("从本机加参考图在阿里云下也生效（曾经的静默丢弃）", localAdd.count === "1", `count=${localAdd.count}`);
check("缩略图渲染出来了", localAdd.thumbs === 1, `thumbs=${localAdd.thumbs}`);

// 超上限时要说清原因，而不是给一句「最多 0 张」
await f.locator("#imgModel").fill("z-image-turbo");
await f.locator("#imgModel").dispatchEvent("input");
await page.waitForTimeout(700);
await f.locator("#filePick").setInputFiles({ name: "no.png", mimeType: "image/png", buffer: PNG });
await page.waitForTimeout(1000);
const noRef = await f.evaluate(() => ({
  count: document.body.dataset.refCount,
  toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "),
}));
info("不收图的档位塞图", noRef);
check("不收图的档位仍然拦下本地图", noRef.count === "0", `count=${noRef.count}`);
check("提示说清是「这一档不支持参考图」", /不支持参考图/.test(noRef.toast), noRef.toast);

await f.locator("#imgModel").fill("wan2.6-t2i");
await f.locator("#imgModel").dispatchEvent("input");
await page.waitForTimeout(500);

/* ---- 真的跑一次异步生图 ---- */
await f.locator("#imgModel").fill("wan2.6-t2i");
await f.locator("#imgModel").dispatchEvent("input");
await f.selectOption("#imgN", "1");
await f.locator("#imgSize").selectOption("1280*1280");
await f.locator("#imgPrompt").fill("白色背景下的蓝色马克杯，柔和顶光");
await page.waitForTimeout(400);
// 出图前的基线：自动留档是"出完图自己多一条"，没有基线就证不出"多"
const galBeforeGen = await page.evaluate(async () => {
  const g = await import("/src/lib/gallery.ts");
  return (await g.fetchGallery()).length;
});
await f.locator("#btnGenImg").click();
await page.waitForTimeout(7000);

info("提交的请求体", ali.create);
check("打到了 2.6 的新建图路径 /image-generation/generation", !!ali.create, "没截到提交请求");
if (ali.create) {
  check("异步头 X-DashScope-Async: enable（缺了会被拒同步调用）",
    ali.headers && ali.headers["x-dashscope-async"] === "enable",
    ali.headers ? String(ali.headers["x-dashscope-async"]) : "没截到头");
  check("prompt 放在 input.messages[0].content[0].text",
    ali.create.input.messages[0].content[0].text.includes("马克杯"),
    JSON.stringify(ali.create.input).slice(0, 160));
  check("n 与 size 在 parameters 里", ali.create.parameters.n === 1 && ali.create.parameters.size === "1280*1280",
    JSON.stringify(ali.create.parameters));
  check("显式关掉水印（商用出图必须关）", ali.create.parameters.watermark === false);
  check("显式声明 prompt_extend", ali.create.parameters.prompt_extend === true);
}
check("轮询确实发生了（至少 2 次：先 RUNNING 后 SUCCEEDED）", ali.polls >= 2, String(ali.polls));

const aliOut = await f.evaluate(() => ({
  taskId: document.body.dataset.taskId,
  cards: document.querySelectorAll("#imgResults .shot").length,
  imgs: document.querySelectorAll("#imgResults .shot img").length,
  galleryBtns: document.querySelectorAll("#imgResults [data-act='togallery']").length,
}));
info("阿里云出图结果", aliOut);
check("task_id 写到 DOM 上（用户能拿去控制台查）", aliOut.taskId === "task_ali_mock", String(aliOut.taskId));
check("出图后渲染出结果卡", aliOut.cards === 1, String(aliOut.cards));
check("结果图真的解码了", aliOut.imgs === 1, `imgs=${aliOut.imgs}`);
check("每张结果都带「存进图库」", aliOut.galleryBtns === 1, String(aliOut.galleryBtns));
await shot("19-ai-aliyun");

/* ---- 自动留档：出图后**不点任何按钮**，图库也该多一份 ----
   这是"工具的产出默认留一份"在 AI 生成里的落点：万相给的是 24 小时就失效的
   OSS 链接，不存就真的没了。 */
const autoGal = await page.evaluate(async () => {
  const g = await import("/src/lib/gallery.ts");
  const all = await g.fetchGallery();
  const last = all[0];
  return { n: all.length, origin: last && last.origin, prompt: last && last.prompt, hasRel: !!(last && last.relPath) };
});
info("出图后（未点任何按钮）", { before: galBeforeGen, after: autoGal });
check("出图后自动留了一份进图库", autoGal.n === galBeforeGen + 1, `${galBeforeGen} → ${autoGal.n}`);
check("来源被宿主盖成 ai-gen（工具说了不算）", autoGal.origin === "ai-gen", String(autoGal.origin));
check("提示词一起存进去了（图库里能按提示词搜）", String(autoGal.prompt).includes("马克杯"), String(autoGal.prompt));
check("文件真的落进仓库", autoGal.hasRel, String(autoGal.hasRel));
const autoBtn = await f.evaluate(() => {
  const b = document.querySelector("#imgResults [data-act='togallery']");
  return { text: b && b.textContent.trim(), disabled: b && b.disabled,
    saved: b && b.classList.contains("saved"), title: b && b.title };
});
info("自动留档后的按钮", autoBtn);
// v0.4.0 起按钮是图标态：已存 = 勾图标（saved class）+ title「已存图库」+ 禁用
check("已自动存过 → 按钮变已存态并禁用（防重复存）",
  autoBtn.saved === true && autoBtn.disabled === true && autoBtn.title === "已存图库",
  JSON.stringify(autoBtn));

/* ---- 关掉开关：手动「存进图库」回到原来那条路 ---- */
await f.locator("#btnCfg").click();
await page.waitForTimeout(400);
check("配置里有「自动留档」开关且默认开",
  (await f.locator("#cfgAutoGallery").isChecked()) === true);
await f.locator("#cfgAutoGallery").uncheck();
await f.locator("#btnCfgClose").click();
await page.waitForTimeout(400);
const galBeforeManual = await page.evaluate(async () => {
  const g = await import("/src/lib/gallery.ts");
  return (await g.fetchGallery()).length;
});
await f.locator("#btnGenImg").click();
await page.waitForTimeout(7000);
const galAfterOff = await page.evaluate(async () => {
  const g = await import("/src/lib/gallery.ts");
  return (await g.fetchGallery()).length;
});
check("关掉开关后出图不再自动存", galAfterOff === galBeforeManual,
  `${galBeforeManual} → ${galAfterOff}`);
const manualBtn = await f.evaluate(() => {
  const b = document.querySelector("#imgResults [data-act='togallery']");
  return { found: !!b, text: b && b.textContent.trim(), disabled: b && b.disabled };
});
info("关掉自动留档后出图", manualBtn);
check("这回「存进图库」按钮是可用的", manualBtn.found && manualBtn.disabled === false, JSON.stringify(manualBtn));
await f.locator("#imgResults [data-act='togallery']").first().click();
await page.waitForTimeout(2500);
const afterManual = await page.evaluate(async () => {
  const g = await import("/src/lib/gallery.ts");
  return (await g.fetchGallery()).length;
});
check("手动点「存进图库」照样多一条", afterManual === galBeforeManual + 1,
  `${galBeforeManual} → ${afterManual}`);
// 复原：这个开关是持久化的，留在"关"上会污染后面的轮次
await f.locator("#btnCfg").click();
await page.waitForTimeout(300);
await f.locator("#cfgAutoGallery").check();
await f.locator("#btnCfgClose").click();
await page.waitForTimeout(300);

/* ---- 继续编辑：生成的图像继续投入生成（v0.4.0） ----
 * 这是"迭代"的入口：结果图放回参考图 + 描述还原成生成时的那句，
 * 用户改两句再点生成，就是在原图基础上改，而不是从零碰运气。 */
console.log("\n4c. 继续编辑：结果放回参考图");
const reuse1 = await f.evaluate(() => {
  const r = window.S.results.find((x) => x.status === "done" && (x.url || x.b64));
  return {
    hasBtn: !!document.querySelector("#imgResults [data-act='reuse']"),
    resultPrompt: r && r.prompt,
    refsBefore: window.S.refs.length,
  };
});
check("每张结果带「继续编辑」按钮", reuse1.hasBtn);
check("结果记住了生成时的描述（还原的原料）", !!reuse1.resultPrompt,
  String(reuse1.resultPrompt).slice(0, 60));
// 4b 结束时停在 wan2.6-t2i（纯文生图，参考图上限 0）——工具在这档上会明确拒绝，
// 这正是后面"不支持参考图"分支要验的行为。这里先换到带参考图的那档再验主线。
await f.locator("#imgModel").fill("wan2.6-image");
await f.locator("#imgModel").dispatchEvent("input");
await page.waitForTimeout(400);
await f.locator("#imgResults [data-act='reuse']").first().click();
await page.waitForTimeout(400);
const reuse2 = await f.evaluate(() => ({
  refs: window.S.refs.length,
  prompt: document.getElementById("imgPrompt").value,
  refCount: document.body.dataset.refCount,
}));
check("点继续编辑 → 结果图放回参考图", reuse2.refs === reuse1.refsBefore + 1,
  JSON.stringify(reuse2));
check("描述还原成生成时用的那句", reuse2.prompt === reuse1.resultPrompt,
  JSON.stringify({ got: reuse2.prompt, want: reuse1.resultPrompt }));
await f.locator("#imgResults [data-act='reuse']").first().click();
await page.waitForTimeout(300);
const reuse3 = await f.evaluate(() => window.S.refs.length);
check("再点一次不会重复塞同一张", reuse3 === reuse2.refs, String(reuse3));

// 模型换成不支持参考图的那档：明确报错，而不是把图默默塞进去
await f.locator("#imgModel").fill("wan2.5-t2i-preview");
await f.locator("#imgModel").dispatchEvent("input");
await page.waitForTimeout(400);
const reuse4 = await f.evaluate(() => {
  const before = window.S.refs.length;
  const model = document.getElementById("imgModel").value;
  const r = window.S.results.find((x) => x.status === "done");
  window.reuseForEdit(r);
  return { before, after: window.S.refs.length, model,
    rUrl: r && !!r.url, rB64: r && !!r.b64 };
});
info("不支持参考图分支", reuse4);
check("不支持参考图的模型上点继续编辑 → 参考图保持不变", reuse4.after === reuse4.before,
  JSON.stringify(reuse4));
/* ---- 阿里云不止万相：千问图像 / Z-Image 走的是同步的 multimodal 接口 ----
 * 这是"模型不止一个"最容易踩的坑：它们和万相不是同一条路径，
 * 拿万相那套（异步提交 + 轮询）去打千问，会直接 400。 */
console.log("\n4d. 阿里云多族模型：千问图像 / Z-Image（同步路径）");

const multi = { qwen: null, qwenHeaders: null, zimage: null, edit: null };
await page.route("**/api/v1/services/aigc/multimodal-generation/generation", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  const m = String(body.model || "");
  if (m.indexOf("z-image") === 0) multi.zimage = body;
  else if (m.indexOf("qwen-image-edit") === 0) multi.edit = body;
  else { multi.qwen = body; multi.qwenHeaders = route.request().headers(); }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      output: {
        choices: [{
          message: {
            role: "assistant",
            content: [{ image: "http://localhost:1420/mock/multi-1.png" }],
          },
        }],
      },
    }),
  });
});
await page.route("**/mock/multi-*.png", (route) =>
  route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

const fillModel = async (id) => {
  await f.locator("#imgModel").fill(id);
  await f.locator("#imgModel").dispatchEvent("input");
  await page.waitForTimeout(400);
};

/* --- 千问图像 3.0：同步一次回图 --- */
await fillModel("qwen-image-3.0");
const qUi = await f.evaluate(() => ({
  nOpts: [...document.querySelectorAll("#imgN option")].map((o) => o.value),
  sizes: [...document.querySelectorAll("#imgSize option")].map((o) => o.value),
  price: document.getElementById("imgPrice").textContent.trim(),
  refHint: document.getElementById("refHint").textContent.trim(),
}));
info("千问 3.0 档", qUi);
check("千问 3.0 一次最多 6 张（张数选项跟着模型走）",
  qUi.nOpts.join(",") === "1,2,3,4,5,6", qUi.nOpts.join(","));
check("千问档给的是它自己的分辨率", qUi.sizes.includes("2048*2048"), qUi.sizes.join(","));
check("描述上限跟着模型走（千问是 4000）", /4000/.test(qUi.price), qUi.price);
// 不改写提示词：后面"老路径用 input.prompt"那节还要用原来那句做断言
await f.locator("#btnGenImg").click();
await page.waitForTimeout(2000);
const qOut = await f.evaluate(() => document.querySelectorAll("#imgResults .shot img").length);
check("千问档走 multimodal 同步路径并直接出图",
  !!multi.qwen && qOut >= 1, `body=${!!multi.qwen} imgs=${qOut}`);
check("用 messages 而不是老代的 input.prompt",
  !!multi.qwen && !!multi.qwen.input.messages && multi.qwen.input.prompt === undefined,
  JSON.stringify(multi.qwen && multi.qwen.input).slice(0, 120));
check("同步请求不带异步头（不是提交任务那套）",
  !!multi.qwenHeaders && multi.qwenHeaders["x-dashscope-async"] === undefined,
  String(multi.qwenHeaders && multi.qwenHeaders["x-dashscope-async"]));

/* --- Z-Image：一次一张，且不认 watermark --- */
await fillModel("z-image-turbo");
const zUi = await f.evaluate(() => ({
  nDisabled: document.getElementById("imgN").disabled,
  price: document.getElementById("imgPrice").textContent.trim(),
  refHint: document.getElementById("refHint").textContent.trim(),
}));
info("Z-Image 档", zUi);
check("Z-Image 一次只能 1 张 → 张数控件锁掉", zUi.nDisabled === true, String(zUi.nDisabled));
check("Z-Image 描述上限 800 字符", /800/.test(zUi.price), zUi.price);
check("Z-Image 不支持参考图 → 提示说清楚", /不支持参考图/.test(zUi.refHint), zUi.refHint);
await f.locator("#btnGenImg").click();
await page.waitForTimeout(2000);
check("Z-Image 请求里 n=1（多要一张就是 400）",
  !!multi.zimage && multi.zimage.parameters.n === 1, JSON.stringify(multi.zimage && multi.zimage.parameters));
check("Z-Image 请求不带它不认的 watermark",
  !!multi.zimage && multi.zimage.parameters.watermark === undefined,
  JSON.stringify(multi.zimage && multi.zimage.parameters));

/* --- 只做图生图 / 编辑的档：没图就该拦下来 --- */
await fillModel("qwen-image-edit-plus");
await f.evaluate(() => { window.S.refs = []; window.renderRefs(); });
const editHint = await f.evaluate(() => document.getElementById("refHint").textContent.trim());
check("编辑档的提示写明必须放图", /必须/.test(editHint), editHint);
await f.locator("#btnGenImg").click();
await page.waitForTimeout(1200);
const editBlocked = await f.evaluate(() => ({
  sent: !!window.S.busy.image,
  toast: [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent).join(" | "),
}));
check("没图时点生成被拦下（不会白花一次调用）", multi.edit === null, String(multi.edit));
check("拦下的同时说清原因", /只做图生图/.test(editBlocked.toast), editBlocked.toast);

// 还原模型，后面老路径那一节要用万相 2.5
await fillModel("wan2.5-t2i-preview");

// 还原参考图状态，别污染后面的老路径小节
await f.evaluate(() => { window.S.refs = []; window.renderRefs(); });
await page.waitForTimeout(200);

/* ---- 2.5 及以下走老路径：input.prompt + text2image ---- */
await f.locator("#imgModel").fill("wan2.5-t2i-preview");
await f.locator("#imgModel").dispatchEvent("input");
await page.waitForTimeout(400);
await f.locator("#btnGenImg").click();
await page.waitForTimeout(4000);
info("老路径请求体", ali.old);
check("2.5 档打到老的 /text2image/image-synthesis", !!ali.old, "没截到老路径请求");
if (ali.old) {
  check("老路径用 input.prompt（不是 messages）",
    String(ali.old.input.prompt).includes("马克杯"), JSON.stringify(ali.old.input).slice(0, 120));
  check("老路径没有 messages 字段", ali.old.input.messages === undefined);
}
// 老任务不会完成（没给它配轮询），确认界面把它标成失败而不是干等
await f.evaluate(() => {
  const b = document.getElementById("btnStopImg");
  if (b && !b.hidden) b.click();
});
await page.waitForTimeout(500);

// 还原：后面的视频/对话测试要用 Agnes
await f.selectOption("#provSel", "agnes");
await page.waitForTimeout(600);
const backToAgnes = await f.evaluate(() => ({
  prov: document.body.dataset.provider,
  model: document.getElementById("imgModel").value.trim(),
}));
check("切回 Agnes 后模型跟着切回去", backToAgnes.prov === "agnes" && backToAgnes.model.startsWith("agnes"),
  JSON.stringify(backToAgnes));

/* ================================================================== */
console.log("\n5. 生视频：提交 → 轮询 → 完成（拦截真实请求）");

let pollCount = 0;
await page.route("**/v1/videos", async (route) => {
  captured.video = JSON.parse(route.request().postData() || "{}");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: "task_MOCK01",
      task_id: "task_MOCK01",
      video_id: "video_MOCK01",
      object: "video",
      model: captured.video.model,
      status: "queued",
      progress: 0,
      created_at: 1786900000,
      seconds: captured.video.seconds,
      size: captured.video.size,
    }),
  });
});
await page.route("**/agnesapi**", async (route) => {
  pollCount++;
  captured.poll.push(route.request().url());
  const done = pollCount >= 2;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: "task_MOCK01",
      task_id: "task_MOCK01",
      video_id: "video_MOCK01",
      object: "video",
      model: "agnes-video-2.5-flash",
      status: done ? "completed" : "in_progress",
      progress: done ? 100 : 45,
      seconds: "5",
      size: "720P",
      metadata: done ? { url: "http://localhost:1420/mock/out.mp4" } : null,
      error: null,
    }),
  });
});
await page.route("**/mock/out.mp4", (route) =>
  route.fulfill({ status: 200, contentType: "video/mp4", body: PNG }),
);

await f.locator(".tab[data-tab='video']").click();
await page.waitForTimeout(500);
check("视频页签可切换", (await f.evaluate(() => document.body.dataset.activeTab)) === "video");

// mode 切换要能带出对应的专属字段
await f.selectOption("#vidMode", "keyframe");
await page.waitForTimeout(400);
const kf = await f.evaluate(() => ({
  keyframeShown: !document.getElementById("vidKeyframe").hidden,
  refHidden: document.getElementById("vidReference").hidden,
}));
check("keyframe 模式露出首尾帧输入", kf.keyframeShown && kf.refHidden, JSON.stringify(kf));

// keyframe 模式不给图 —— 应该在本地就被拦下，不该发出请求
await f.locator("#vidPrompt").fill("测试拦截：没有首帧不该发请求");
await f.locator("#btnGenVid").click();
await page.waitForTimeout(800);
check("keyframe 缺首尾帧时不发请求（本地校验拦截）", captured.video === null, JSON.stringify(captured.video).slice(0, 80));

await f.selectOption("#vidMode", "reference");
await page.waitForTimeout(400);
const rf = await f.evaluate(() => ({
  refShown: !document.getElementById("vidReference").hidden,
  keyframeHidden: document.getElementById("vidKeyframe").hidden,
  hint: document.getElementById("vidRefHint").textContent,
}));
check("reference 模式露出参考素材输入", rf.refShown && rf.keyframeHidden, JSON.stringify(rf));
check("参考素材提示里写了上限（5 张）", rf.hint.includes("5"), rf.hint.slice(0, 60));

await f.selectOption("#vidMode", "text");
await page.waitForTimeout(300);
await f.locator("#vidPrompt").fill("雨后的未来城市街道，霓虹倒映在地面，一辆银色跑车缓慢驶过");
await f.locator("#vidModel").fill("agnes-video-2.5-flash");
await f.selectOption("#vidSeconds", "5");
await f.selectOption("#vidRatio", "16:9");
await f.locator("#btnGenVid").click();
await page.waitForTimeout(7500);

info("实际发出的建任务请求体", captured.video);
if (captured.video) {
  check("建任务请求 model 正确", captured.video.model === "agnes-video-2.5-flash", String(captured.video.model));
  check("mode=text", captured.video.mode === "text", String(captured.video.mode));
  check("seconds 是字符串 \"5\"（文档要求字符串）", captured.video.seconds === "5", JSON.stringify(captured.video.seconds));
  check("size=720P（Flash 只支持 720P）", captured.video.size === "720P", String(captured.video.size));
  check("aspect_ratio=16:9", captured.video.aspect_ratio === "16:9", String(captured.video.aspect_ratio));
  check("text 模式不带媒体字段", !captured.video.first_frame && !captured.video.images, JSON.stringify(captured.video).slice(0, 120));
}

info("轮询地址", captured.poll[0] || "(无)");
check("轮询打到了站点根的 /agnesapi", !!captured.poll.length && captured.poll[0].includes("/agnesapi"), captured.poll[0] || "");
check(
  "轮询带上 video_id 与 model_name（非 text 模式必需）",
  !!captured.poll.length && captured.poll[0].includes("video_id=video_MOCK01") && captured.poll[0].includes("model_name=agnes-video-2.5-flash"),
  captured.poll[0] || "",
);
check("轮询发生了至少 2 次（先 in_progress 后 completed）", pollCount >= 2, `pollCount=${pollCount}`);

const vidOut = await f.evaluate(() => ({
  cards: document.querySelectorAll("#vidResults .vcard").length,
  videos: document.querySelectorAll("#vidResults video").length,
  src: document.querySelector("#vidResults video")?.getAttribute("src") || "",
  tags: [...document.querySelectorAll("#vidResults .tag")].map((e) => e.textContent),
  videoId: document.querySelector("#vidResults .mono")?.textContent || "",
  hist: document.querySelectorAll("#vidHist .hrow").length,
}));
info("视频结果", vidOut);
check("出现 1 张任务卡", vidOut.cards === 1, `cards=${vidOut.cards}`);
check("任务卡上显示 video_id", vidOut.videoId.includes("video_MOCK01"), vidOut.videoId);
check("完成后渲染出 video 元素", vidOut.videos === 1, `videos=${vidOut.videos}`);
check("video 的 src 用的是 metadata.url", vidOut.src === "http://localhost:1420/mock/out.mp4", vidOut.src);
check("状态标变成已完成", vidOut.tags.some((t) => t.includes("已完成")), vidOut.tags.join(","));
// 一个任务只该在历史里留一条：提交时记一条，完成后改那一条，而不是再插一条
check("出片历史里只记一条（同一任务不重复）", vidOut.hist === 1, `hist=${vidOut.hist}`);
await shot("19-ai-video");

/* ================================================================== */
console.log("\n5b. MiniMax 视频：异步任务式（提交只回 task_id，轮询 /api/v1/tasks/{id}）");

await f.selectOption("#provSel", "minimax");
await page.waitForTimeout(600);

const mmUI = await f.evaluate(() => ({
  active: document.body.dataset.activeTab,
  tabs: [...document.querySelectorAll("#tabs .tab")].map((t) => ({
    k: t.dataset.tab, disabled: t.disabled,
    sub: t.querySelector(".sub") ? t.querySelector(".sub").textContent : "",
  })),
  model: document.getElementById("vidModel").value.trim(),
  sizes: [...document.querySelectorAll("#vidSize option")].map((o) => o.value),
  ratio: document.getElementById("vidRatio").value,
  seconds: document.getElementById("vidSeconds").value,
  modes: [...document.querySelectorAll("#vidMode option")].map((o) => o.value),
}));
info("MiniMax 页面状态", mmUI);
check(
  "只声明视频的服务商：生图 / 对话页签置灰并注明原因",
  mmUI.tabs.filter((t) => t.disabled).map((t) => t.k).sort().join(",") === "chat,image" &&
    mmUI.tabs.every((t) => !t.disabled || t.sub.includes("不支持")),
  JSON.stringify(mmUI.tabs),
);
check("当前页签自动落到视频", mmUI.active === "video", mmUI.active);
check("模型框自动填入 MiniMax/MiniMax-H3", mmUI.model === "MiniMax/MiniMax-H3", mmUI.model);
check("分辨率档位是 768P / 1080P", mmUI.sizes.join(",") === "768P,1080P", mmUI.sizes.join(","));
check("画幅保留 16:9", mmUI.ratio === "16:9", mmUI.ratio);
check("时长保留 5 秒", mmUI.seconds === "5", mmUI.seconds);
// 这家只做纯文生视频：给它首尾帧/参考图的入口等于给一个点了必失败的按钮
check("只有 text 一种模式", mmUI.modes.join(",") === "text", mmUI.modes.join(","));

// 上一节 Agnes 的任务卡还留在列表里，先清掉再提交 ——
// 否则等下数「1 张卡」会数到上一家的，断言就在骗自己
await f.locator("#btnClearVid").click();
await page.waitForTimeout(300);
check("清空后列表是空的",
  (await f.evaluate(() => document.querySelectorAll("#vidResults .vcard").length)) === 0);

let mmPoll = 0;
let mmCreateHeaders = null;
let mmPollHeaders = null;
await page.route("**/api/v1/services/aigc/video-generation/video-synthesis", async (route) => {
  captured.minimaxCreate = JSON.parse(route.request().postData() || "{}");
  mmCreateHeaders = route.request().headers();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ output: { task_id: "mm-task-01", task_status: "PENDING" }, request_id: "r-1" }),
  });
});
await page.route("**/api/v1/tasks/*", async (route) => {
  mmPoll++;
  captured.minimaxPoll = route.request().url();
  mmPollHeaders = route.request().headers();
  const done = mmPoll >= 2;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      output: {
        task_id: "mm-task-01",
        task_status: done ? "SUCCEEDED" : "RUNNING",
        video_url: done ? "http://localhost:1420/mock/mm.mp4" : "",
      },
      usage: done ? { duration: 5 } : null,
    }),
  });
});
await page.route("**/mock/mm.mp4", (route) =>
  route.fulfill({ status: 200, contentType: "video/mp4", body: PNG }),
);

await f.locator("#vidPrompt").fill("女舰长独自站在巨大观景窗前，最后一支舰队正在跃迁离去");
await f.locator("#btnGenVid").click();
await page.waitForTimeout(13000);

info("MiniMax 建任务请求体", captured.minimaxCreate);
info("MiniMax 轮询地址", captured.minimaxPoll || "(无)");
const mCreate = captured.minimaxCreate || {};
check("建任务请求已发出", !!captured.minimaxCreate, String(captured.minimaxCreate).slice(0, 80));
check(
  "带 X-DashScope-Async: enable（不带就没有 task_id）",
  !!mmCreateHeaders && mmCreateHeaders["x-dashscope-async"] === "enable",
  mmCreateHeaders ? mmCreateHeaders["x-dashscope-async"] : "(未抓到请求头)",
);
check("model 是 MiniMax/MiniMax-H3", mCreate.model === "MiniMax/MiniMax-H3", String(mCreate.model));
check(
  "prompt 在 input.prompt 下面（不在顶层）",
  !!(mCreate.input && mCreate.input.prompt),
  JSON.stringify(mCreate.input || {}),
);
check(
  "parameters 用的是 resolution / ratio / duration（数字）",
  mCreate.parameters && mCreate.parameters.resolution === "768P" &&
    mCreate.parameters.ratio === "16:9" && mCreate.parameters.duration === 5,
  JSON.stringify(mCreate.parameters || {}),
);
check(
  "轮询打的是 /api/v1/tasks/{task_id}，不是 video_id 查询串",
  /\/api\/v1\/tasks\/mm-task-01$/.test(captured.minimaxPoll || ""),
  captured.minimaxPoll || "(无)",
);
check("轮询至少发生 2 次（先 RUNNING 后 SUCCEEDED）", mmPoll >= 2, `mmPoll=${mmPoll}`);
/* ⚠️ 提交要带异步头，轮询**绝不能**带 —— 实测带上会被判成异步调用直接 403
   （current user api does not support asynchronous calls），成片永远取不回来。
   这两个方向相反，只验一边等于没验。 */
check("提交带 X-DashScope-Async: enable",
  mmCreateHeaders && mmCreateHeaders["x-dashscope-async"] === "enable",
  mmCreateHeaders ? String(mmCreateHeaders["x-dashscope-async"]) : "(无请求)");
check("轮询不带 X-DashScope-Async（带了会被 403 拒掉）",
  !!mmPollHeaders && !mmPollHeaders["x-dashscope-async"],
  mmPollHeaders ? String(mmPollHeaders["x-dashscope-async"]) : "(无请求)");
check("轮询仍带鉴权头", !!mmPollHeaders && /^Bearer /.test(mmPollHeaders.authorization || ""),
  mmPollHeaders ? (mmPollHeaders.authorization || "").slice(0, 20) : "(无请求)");

const mmOut = await f.evaluate(() => ({
  cards: document.querySelectorAll("#vidResults .vcard").length,
  videos: document.querySelectorAll("#vidResults video").length,
  src: document.querySelector("#vidResults video") ? document.querySelector("#vidResults video").getAttribute("src") : "",
  kvLabel: document.querySelector("#vidResults .kv .k") ? document.querySelector("#vidResults .kv .k").textContent : "",
  kvVal: document.querySelector("#vidResults .mono") ? document.querySelector("#vidResults .mono").textContent : "",
  tags: [...document.querySelectorAll("#vidResults .tag")].map((e) => e.textContent),
}));
info("MiniMax 结果卡", mmOut);
check("出现 1 张任务卡", mmOut.cards === 1, `cards=${mmOut.cards}`);
// 任务式接口没有 video_id：卡上要显示 task_id，而不是留一个永远的「—」
check("任务句柄显示成 task_id 而不是空的 video_id",
  mmOut.kvLabel === "task_id" && mmOut.kvVal === "mm-task-01",
  `${mmOut.kvLabel}=${mmOut.kvVal}`);
check("完成后渲染出 video 元素", mmOut.videos === 1, `videos=${mmOut.videos}`);
check("成片地址取 output.video_url", mmOut.src === "http://localhost:1420/mock/mm.mp4", mmOut.src);
check("状态标变成已完成", mmOut.tags.some((t) => t.includes("已完成")), mmOut.tags.join(","));
await shot("19b-ai-video-minimax");

/*
 * 连接测试的路径必须按服务商走。
 * 默认那一条是 OpenAI 兼容网关的 /models，但这个中转站上它是 404 ——
 * 不声明 probe 的话「测试连接」会报一个假的"连不上"，把人引去查一个没坏的 Key。
 * 所以这里钉两件事：打的是 /api/v1/models，且**没有**去打那条会 404 的根路径。
 */
const probeHits = { api: 0, root: 0 };
const onProbeApi = async (route) => {
  probeHits.api++;
  await route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ success: true, output: { total: 517, models: [] } }),
  });
};
const onProbeRoot = async (route) => {
  probeHits.root++;
  await route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' });
};
await page.route("**/api/v1/models", onProbeApi);
await page.route("https://maas.qianwenaiapi.com/models", onProbeRoot);

await f.locator("#btnCfg").click();
await page.waitForTimeout(400);
await f.locator("#btnTest").click();
await page.waitForTimeout(2500);
const mmTest = await f.locator("#testOut").innerText();
info("MiniMax 连接测试", mmTest.replace(/\s+/g, " ").slice(0, 120));
check("连接测试打的是 /api/v1/models", probeHits.api === 1, `api=${probeHits.api} root=${probeHits.root}`);
check("没有去打会 404 的站点根 /models", probeHits.root === 0, `root=${probeHits.root}`);
check("读的是这家的返回形状（output.total 而不是 data[]）",
  /517/.test(mmTest) && /连通/.test(mmTest), mmTest.slice(0, 120));
await shot("19c-mm-probe");
await f.locator("#btnCfgClose").click();
await page.unroute("**/api/v1/models", onProbeApi);
await page.unroute("https://maas.qianwenaiapi.com/models", onProbeRoot);

// 还原：第 6 节的对话要用 Agnes（MiniMax 没声明对话能力）
await f.selectOption("#provSel", "agnes");
await page.waitForTimeout(600);

/* ================================================================== */
console.log("\n6. 对话：非流式与流式各一次（拦截真实请求）");

await f.locator(".tab[data-tab='chat']").click();
await page.waitForTimeout(400);

await page.route("**/v1/chat/completions", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  captured.chat = body;
  if (body.stream) {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        'data: {"choices":[{"delta":{"content":"流"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"式"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"可用"}}]}\n\n' +
        "data: [DONE]\n\n",
    });
  } else {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "非流式回复-OK" } }] }),
    });
  }
});

// 先关流式
await f.locator("#chatStream").uncheck();
await f.locator("#chatInput").fill("只回四个字");
await f.locator("#btnSend").click();
await page.waitForTimeout(1800);
let chatOut = await f.evaluate(() => ({
  msgs: document.querySelectorAll("#msgs .msg").length,
  last: [...document.querySelectorAll("#msgs .msg .txt")].pop()?.textContent || "",
  count: document.body.dataset.msgCount,
}));
info("非流式", chatOut);
check("非流式：一问一答两条消息", chatOut.msgs === 2, `msgs=${chatOut.msgs}`);
check("非流式：回复内容渲染出来了", chatOut.last.includes("非流式回复-OK"), chatOut.last);
check("非流式请求 stream=false", captured.chat && captured.chat.stream === false, JSON.stringify(captured.chat?.stream));

// 再开流式
await f.locator("#chatStream").check();
await f.locator("#chatInput").fill("流式试试");
await f.locator("#btnSend").click();
await page.waitForTimeout(2000);
chatOut = await f.evaluate(() => ({
  msgs: document.querySelectorAll("#msgs .msg").length,
  last: [...document.querySelectorAll("#msgs .msg .txt")].pop()?.textContent || "",
}));
info("流式", chatOut);
check("流式请求 stream=true", captured.chat && captured.chat.stream === true, JSON.stringify(captured.chat?.stream));
check("流式：三段 delta 被拼成完整回复", chatOut.last === "流式可用", `实际「${chatOut.last}」`);
check("流式：消息总数变成 4 条", chatOut.msgs === 4, `msgs=${chatOut.msgs}`);

const sysSent = await f.evaluate(async () => {
  document.getElementById("chatSystem").value = "你是测试用助手";
  return document.getElementById("chatSystem").value;
});
info("系统提示", sysSent);
check("系统提示输入框可用", sysSent === "你是测试用助手");
await shot("20-ai-chat");

/* ================================================================== */
console.log("\n7. 真实连通性：错密钥必须得到 401（打真网络，验证地址与跨域）");

// 撤掉生图的拦截，让请求真的打出去
await page.unroute("**/v1/images/generations");

await f.locator(".tab[data-tab='image']").click();
await f.locator("#imgPrompt").fill("连通性探测：这个请求应该被拒绝");
await f.locator("#btnGenImg").click();

// 错误提示是限时消失的（7 秒），不能"等一会儿再来看它还在不在" ——
// 那样测的是 toast 的存活时长，不是它有没有出现。用 waitFor 逮住它出现的瞬间。
let toastShown = true;
try {
  await f.locator(".toast.err").first().waitFor({ state: "visible", timeout: 15000 });
} catch {
  toastShown = false;
}
check("错误以可见提示呈现，不是静默失败", toastShown);

await page.waitForTimeout(3000);
const realErr = await f.evaluate(() => document.body.dataset.lastError || "");
info("真实返回的错误", realErr.slice(0, 200));
check("真网络请求拿到了 401（说明地址拼对了、跨域通了、错误映射生效）", realErr.includes("401"), realErr.slice(0, 160));

// 「测试连接」也打真网络
await f.locator("#btnCfg").click();
await page.waitForTimeout(300);
await f.locator("#btnTest").click();
await page.waitForTimeout(9000);
const testOut = await f.locator("#testOut").innerText();
info("连接测试输出", testOut.replace(/\s+/g, " ").slice(0, 140));
check("连接测试也给出了 401 结论", testOut.includes("401"), testOut.slice(0, 120));
await f.locator("#btnCfgClose").click();

/* ==================================================================
 * 8. 模型选择器
 *
 * 2026-09-21 把「裸 ID 输入框 + 浏览器原生 datalist」换成了组合框 + 自绘面板。
 * 自定义控件最容易坏在这三处，这一节就盯这三处：
 *   · 点开面板时把当前模型的完整 ID 当成搜索词 → 21 档被滤成它自己那一行
 *   · 从面板点选绕开 refreshImageFields → 尺寸档 / 张数上限还停在上一个模型
 *   · 浮层被左栏的 overflow 裁掉，或压在配置弹窗底下点不着
 * ================================================================== */
console.log("\n8. 模型选择器：展开 / 过滤 / 点选 / 键盘 / 浮层层级");

await f.locator('.tab[data-tab="image"]').click();
await f.selectOption("#provSel", "aliyun");
await page.waitForTimeout(900);

/* --- 点开：该列全部档位，而不是只剩当前那一行 --- */
await f.locator("#imgModel").click();
await page.waitForTimeout(500);
const mp0 = await f.evaluate(() => ({
  open: document.body.dataset.mpOpen,
  items: document.querySelectorAll("#mpList .mp-item").length,
  tiers: document.querySelectorAll("#modelsImage option").length,
  first: (document.querySelector("#mpList .mp-item .mp-name") || {}).textContent || "",
  price: (document.querySelector("#mpList .mp-item .mp-price") || {}).textContent || "",
  tags: document.querySelectorAll("#mpList .mp-item .mp-tag").length,
  selected: document.querySelectorAll('#mpList .mp-item[aria-selected="true"]').length,
}));
info("面板展开", mp0);
check("点开模型框就展开面板", mp0.open === "true", String(mp0.open));
check("面板列出全部档位（不是被当前 ID 滤成一行）",
  mp0.items === mp0.tiers && mp0.items > 5, `${mp0.items} / ${mp0.tiers}`);
check("每项都带中文名，不是只有 ID", /[\u4e00-\u9fa5]/.test(mp0.first), mp0.first);
check("有单价的档位把单价列在行内", /0\.20/.test(mp0.price), mp0.price);
check("能力标签跟着档位显示（张数 / 参考图 / 描述上限）", mp0.tags >= 3, String(mp0.tags));
check("当前档在列表里被标出来", mp0.selected === 1, String(mp0.selected));

/* --- 浮层：比左栏宽也不能被裁，且要在最上层 --- */
const mpGeo = await f.evaluate(() => {
  const pop = document.getElementById("mpPop").getBoundingClientRect();
  const col = document.querySelector(".col-form").getBoundingClientRect();
  const mid = document.elementFromPoint(pop.left + pop.width / 2, pop.top + 10);
  return { w: Math.round(pop.width), h: Math.round(pop.height),
           beyond: Math.round(pop.right - col.right),
           onTop: !!(mid && mid.closest("#mpPop")) };
});
info("面板几何", mpGeo);
check("面板比左栏宽也完整显示（fixed 定位，不被 overflow 裁）",
  mpGeo.w >= 330 && mpGeo.h > 200 && mpGeo.beyond > 0, JSON.stringify(mpGeo));
check("面板确实在最上层（elementFromPoint 落在它身上）", mpGeo.onTop === true, String(mpGeo.onTop));

/* --- 输入即过滤 --- */
await f.locator("#imgModel").fill("turbo");
await page.waitForTimeout(450);
const mpF = await f.evaluate(() => ({
  items: [...document.querySelectorAll("#mpList .mp-item")].map((x) => x.dataset.id),
  now: document.getElementById("mpNowImage").textContent.trim(),
}));
info("过滤 turbo", mpF);
check("输入即过滤（只剩含 turbo 的档）",
  mpF.items.length > 0 && mpF.items.every((x) => x.includes("turbo")), mpF.items.join(","));
check("搜索期间不在 label 上误报「自定义 ID」", mpF.now !== "自定义 ID", mpF.now);

/* --- 点选：必须走和手输同一条 refresh 路径 --- */
await f.locator("#imgModel").fill("");
await page.waitForTimeout(300);
await f.locator('#mpList .mp-item[data-id="z-image-turbo"]').click();
await page.waitForTimeout(700);
const mpPick = await f.evaluate(() => ({
  value: document.getElementById("imgModel").value,
  open: document.body.dataset.mpOpen,
  now: document.getElementById("mpNowImage").textContent.trim(),
  nDisabled: document.getElementById("imgN").disabled,
  sizes: [...document.querySelectorAll("#imgSize option")].map((o) => o.value),
  price: document.getElementById("imgPrice").textContent.trim(),
}));
info("点选 z-image-turbo", mpPick);
check("点选写回输入框", mpPick.value === "z-image-turbo", mpPick.value);
check("选完面板收起", mpPick.open === "false", String(mpPick.open));
check("label 上换成中文名而不是 ID", /Z-Image/.test(mpPick.now) && !/^z-image-turbo$/.test(mpPick.now), mpPick.now);
check("尺寸档跟着换成这一档自己的（真的走了 refresh）",
  mpPick.sizes.includes("1024*1024"), mpPick.sizes.slice(0, 3).join(","));
check("一次只能出一张 → 张数控件锁掉", mpPick.nDisabled === true, String(mpPick.nDisabled));
check("价格条同步（Z-Image 描述上限 800）", mpPick.price.includes("800"), mpPick.price);

/* --- 键盘 --- */
await f.locator("#imgModel").click();
await page.waitForTimeout(400);
await f.locator("#imgModel").fill("qwen-image-3");
await page.waitForTimeout(450);
await f.locator("#imgModel").press("ArrowDown");
await f.locator("#imgModel").press("ArrowDown");
await f.locator("#imgModel").press("Enter");
await page.waitForTimeout(600);
const mpK = await f.evaluate(() => ({
  value: document.getElementById("imgModel").value,
  open: document.body.dataset.mpOpen,
}));
info("键盘选档", mpK);
check("↑↓ + Enter 能选到高亮那一档",
  mpK.value.startsWith("qwen-image-3"), mpK.value);
check("键盘选完也收起面板", mpK.open === "false", String(mpK.open));

/* --- 配置弹窗里的同款控件 + 层级 + Esc 只关一层 --- */
await f.locator("#btnCfg").click();
await page.waitForTimeout(400);
await f.locator('.mp[data-mp="cfgImage"] .mp-btn').click();
await page.waitForTimeout(500);
const cfgPop = await f.evaluate(() => {
  const pop = document.getElementById("mpPop").getBoundingClientRect();
  const mid = document.elementFromPoint(pop.left + pop.width / 2, pop.top + 10);
  return { open: document.body.dataset.mpOpen,
           onTop: !!(mid && mid.closest("#mpPop")),
           items: document.querySelectorAll("#mpList .mp-item").length,
           head: document.getElementById("mpHead").textContent };
});
info("配置弹窗里的面板", cfgPop);
check("配置弹窗里点 ▾ 也能开面板", cfgPop.open === "true" && cfgPop.items > 0, JSON.stringify(cfgPop));
check("面板盖在配置弹窗之上（否则点不着）", cfgPop.onTop === true, String(cfgPop.onTop));
check("面板标题分得清「默认生图」和生图页", cfgPop.head.includes("默认"), cfgPop.head);

await f.locator('.mp[data-mp="cfgImage"] input').press("Escape");
await page.waitForTimeout(400);
const mpEsc = await f.evaluate(() => ({
  open: document.body.dataset.mpOpen,
  cfg: document.body.dataset.cfgOpen,
}));
info("Esc 之后", mpEsc);
check("Esc 先关面板", mpEsc.open === "false", String(mpEsc.open));
check("Esc 不会连带把配置弹窗一起关掉", mpEsc.cfg === "true", String(mpEsc.cfg));

/* --- 面板开着时切服务商：清单要跟着换一家 --- */
await f.locator('.mp[data-mp="cfgImage"] .mp-btn').click();
await page.waitForTimeout(400);
await f.locator("#provSel").selectOption("agnes");
await page.waitForTimeout(800);
const mpSw = await f.evaluate(() => ({
  open: document.body.dataset.mpOpen,
  prov: document.getElementById("mpProv").textContent,
  items: [...document.querySelectorAll("#mpList .mp-item")].map((x) => x.dataset.id),
}));
info("切服务商后的面板", mpSw);
check("面板开着切服务商时清单跟着换（不停在上一家）",
  mpSw.prov.includes("Agnes") && mpSw.items.every((x) => x.startsWith("agnes-")),
  JSON.stringify(mpSw));

await f.locator("#btnCfgClose").click();
await page.waitForTimeout(300);

/* ================================================================== */
console.log("\n8b. 停止轮询要结算历史，别把英文状态词漏到界面上");
{
  const labels = await f.evaluate(() => HISTORY_LABEL);
  info("历史状态词表", labels);
  check("stopped 有中文标签（不能直接显示 \"stopped\"）", labels.stopped === "已停止", String(labels.stopped));
  check("四个常用状态都有标签",
    ["queued", "completed", "failed", "stopped"].every((k) => !!labels[k]),
    JSON.stringify(labels));

  /* 停止轮询原来只写 job.pollError、不碰历史 —— 那条历史会永远停在「排队中」，
     而任务其实已经在服务端跑起来并计费了。生图那条路取消时是会 updateHistory 的，
     两边不一致，视频这条路是漏的。 */
  check("有统一的停止收尾函数（会结算历史）",
    await f.evaluate(() => typeof stopVideoPolling === "function" &&
      /updateHistory/.test(stopVideoPolling.toString())));
  check("停止轮询的三个出口都走它（手动/超时）",
    await f.evaluate(() => {
      const src = pollVideo.toString();
      return (src.match(/stopVideoPolling\(/g) || []).length >= 3 &&
        /status: "stopped"/.test(stopVideoPolling.toString());
    }));
}

/* ================================================================== */
console.log("\n9. 控制台");
const realErrors = errors.filter(
  (e) => !/401|Failed to load resource/i.test(e),
);
if (errors.length !== realErrors.length) {
  info("已被忽略的预期错误", `${errors.length - realErrors.length} 条（401 / 资源加载）`);
}
check("全程无意外 console 错误 / pageerror", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));

await browser.close();

console.log(`\n====================================================`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
console.log(`====================================================`);
if (failures.length) {
  failures.forEach((x) => console.log(`  - ${x}`));
  process.exit(1);
}
