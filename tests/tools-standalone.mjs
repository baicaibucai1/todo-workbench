/**
 * 「脱离工作台也是 web 工具」的回归。
 *
 * 验的是每一份工具 HTML **单独打开**时还算不算一个能用的网页：
 *   1. 一路 0 报错（pageerror / console.error）
 *   2. document.body.dataset.bindState 落到 standalone
 *   3. 界面上明说了"独立运行"，并且说清了数据存在哪
 *   4. 宿主专属的控件（图床 / 交给别的工具 / 表结构）全部**看不见** ——
 *      不是"禁用"，禁用在这儿解释不通（没有可升级的工作台）
 *   5. 核心动作真的能落地：写一条能存住、刷新后还在
 *
 * 打开方式是 file://（等于双击），这也是代码注释里承诺的那条活法。
 * 顺带也走一遍 http:// —— 工具挂到静态服务器上时同一个期望应该成立。
 *
 * ⚠️ 数据落到 localStorage 上（key 前缀 wbtool:<id>:）。
 * 每个用例开头会清掉自己那一段，所以跑完不留垃圾。
 *
 * 用法：node tests/tools-standalone.mjs
 */

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_TOOLS } from "./tool-registry.mjs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = path.join(ROOT, "docs", "screenshots", "logo.png");

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
const info = (label, v) => console.log(`    · ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

/* ---------------- 一个够用的静态服务器（给 http:// 那一趟） ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = url.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(path.normalize(ROOT))) { res.writeHead(403).end(); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

/* ---------------- 采集界面事实 ---------------- */
function snapshot() {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const hostOnly = [...document.querySelectorAll("[data-host-only]")].map((el) => ({
      id: el.id || "",
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 24),
      visible: vis(el),
    }));

    // 界面上提到"独立 / 宿主 / 工作台"的可见文字
    const hints = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 90) continue;
      if (/独立|未连|已连|工作台|宿主/.test(t) && vis(el)) hints.push(t);
    }
    return {
      bindState: document.body.dataset.bindState,
      hostOnly,
      hostOnlyVisible: hostOnly.filter((h) => h.visible),
      hints,
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    };
  });
}

/** 打开一个工具并等状态落定（1200ms 兜底之后） */
async function openStandalone(id, scheme) {
  const url = scheme === "http"
    ? `${BASE}tools/${id}/index.html`
    : `file:///${ROOT.replace(/\\/g, "/")}/tools/${id}/index.html`;
  errors.length = 0;
  consoleErrors.length = 0;
  await page.goto(url, { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(2000);   // 越过 1200ms 的分类超时
  return snapshot();
}

/** 独立运行的四条通用期望 */
async function expectCommon(id, label, scheme, minHostOnly = 1) {
  const s = await openStandalone(id, scheme);
  const tag = `${label} [${scheme}]`;

  check(`${tag}：bindState 落到 standalone`, s.bindState === "standalone", String(s.bindState));
  check(`${tag}：0 个 pageerror`, errors.length === 0, errors.slice(0, 2).join(" | "));
  check(`${tag}：0 条 console.error`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  check(`${tag}：界面上说明了"独立运行"`, s.hints.some((h) => /独立(运行|打开)/.test(h)),
    JSON.stringify(s.hints));
  // 这条是给「宿主专属控件一个都没露出来」兜底用的：一个都没标的话那条断言是空的
  check(`${tag}：标了 ${minHostOnly} 处以上 data-host-only`, s.hostOnly.length >= minHostOnly,
    String(s.hostOnly.length));
  check(`${tag}：宿主专属控件一个都没露出来`, s.hostOnlyVisible.length === 0,
    JSON.stringify(s.hostOnlyVisible));
  return s;
}

/** 清掉这个工具在浏览器本地留下的数据 */
async function wipeLocal(id) {
  await page.evaluate((tid) => {
    try {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("wbtool:" + tid + ":") === 0) kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* 没开就算了 */ }
  }, id);
}

/* ==================================================================
 * 1. 模板（scratchpad）—— 归零，它本来就是"照着抄"的那份
 * ================================================================== */
console.log("\n=== 1. 模板 scratchpad ===");
{
  await expectCommon("scratchpad", "模板", "file");
  await wipeLocal("scratchpad");
  await openStandalone("scratchpad", "file");

  await page.fill("#title", "独立运行测试");
  await page.fill("#body", "这条不该丢");
  await page.click("#add");
  await page.waitForTimeout(500);

  const afterAdd = await page.evaluate(() => ({
    cards: document.querySelectorAll(".note").length,
    text: document.getElementById("list").innerText,
    meta: document.getElementById("meta").textContent,
  }));
  check("模板：能写进一条", afterAdd.cards === 1, `cards=${afterAdd.cards}`);
  check("模板：列表里看得见", afterAdd.text.includes("独立运行测试"), afterAdd.text.slice(0, 60));
  check("模板：副标题说清了数据存在浏览器里", /浏览器|localStorage/.test(afterAdd.meta), afterAdd.meta);

  await openStandalone("scratchpad", "file");
  const afterReload = await page.evaluate(() => ({
    cards: document.querySelectorAll(".note").length,
    text: document.getElementById("list").innerText,
  }));
  check("模板：刷新后还在（真的落盘了）", afterReload.cards === 1 && afterReload.text.includes("独立运行测试"),
    `cards=${afterReload.cards}`);

  await page.click('.note button[data-act="del"]');
  await page.waitForTimeout(400);
  const afterDel = await page.evaluate(() => document.querySelectorAll(".note").length);
  check("模板：删除也生效", afterDel === 0, String(afterDel));
  await wipeLocal("scratchpad");

  await expectCommon("scratchpad", "模板", "http");
}

/* ==================================================================
 * 2. 便签（notes）
 * ================================================================== */
console.log("\n=== 2. 便签 notes ===");
{
  // 便签唯一的宿主专属控件在编辑器里（「从图床挑」），静态 DOM 上没有，
  // 所以这里放宽到 0，改在下面开一次编辑器单独验。
  await expectCommon("notes", "便签", "file", 0);
  await wipeLocal("notes");
  await openStandalone("notes", "file");

  await page.click("#new");
  await page.waitForTimeout(600);
  const afterNew = await page.evaluate(() => ({
    cards: document.querySelectorAll("#grid .card").length,
    meta: document.getElementById("meta").textContent,
    emptyHidden: document.getElementById("empty").hidden,
    gallery: (() => {
      const b = document.getElementById("e-gallery");
      if (!b) return "missing";
      const r = b.getBoundingClientRect();
      return r.width > 0 && getComputedStyle(b).display !== "none" ? "visible" : "hidden";
    })(),
  }));
  check("便签：点「新建」能建出一张卡", afterNew.cards === 1, `cards=${afterNew.cards}`);
  check("便签：空态让位", afterNew.emptyHidden === true, String(afterNew.emptyHidden));
  check("便签：编辑器里的「从图床挑」不可见", afterNew.gallery === "hidden", afterNew.gallery);

  await openStandalone("notes", "file");
  const afterReload = await page.evaluate(() => document.querySelectorAll("#grid .card").length);
  check("便签：刷新后那张卡还在", afterReload === 1, String(afterReload));
  const meta = await page.evaluate(() => document.getElementById("meta").textContent);
  check("便签：副标题说清了数据存在浏览器里", /浏览器|本地/.test(meta), meta);
  await wipeLocal("notes");

  await expectCommon("notes", "便签", "http", 0);
}

/* ==================================================================
 * 3. 尺码表（size-chart）
 * ================================================================== */
console.log("\n=== 3. 尺码表 size-chart ===");
{
  await expectCommon("size-chart", "尺码表", "file");

  const before = await page.evaluate(() => document.getElementById("tableCountLabel").textContent);
  await page.click('button[title="增加行 (Ctrl+↓)"]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById("tableCountLabel").textContent);
  check("尺码表：能加一行（编辑器真的动起来）", /\d+ 行/.test(after) && after !== before,
    `${before} → ${after}`);

  await expectCommon("size-chart", "尺码表", "http");
}

/* ==================================================================
 * 4. 图片裁剪（image-crop）
 * ================================================================== */
console.log("\n=== 4. 图片裁剪 image-crop ===");
{
  const s = await expectCommon("image-crop", "图片裁剪", "file");
  check("图片裁剪：状态条写着「独立运行」",
    (await page.evaluate(() => document.getElementById("hostState")?.textContent)) === "独立运行",
    String(await page.evaluate(() => document.getElementById("hostState")?.textContent)));
  void s;

  // 真喂一张图进去 —— 这才叫"能用"
  const before = await page.evaluate(() => document.getElementById("listHint").textContent);
  await page.setInputFiles("#fileInput", SHOT);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    hint: document.getElementById("listHint").textContent,
    thumbs: document.querySelectorAll("#thumbList *").length,
  }));
  check("图片裁剪：能打开一张图（缩略图列表进了一条）", after.hint !== before && /1 张/.test(after.hint),
    `${before} → ${after.hint}`);
  check("图片裁剪：缩略图列表真的渲染出了东西", after.thumbs > 0, `thumbs=${after.thumbs}`);

  await expectCommon("image-crop", "图片裁剪", "http");
}

/* ==================================================================
 * 5. AI 生成（ai-gen）
 * ================================================================== */
console.log("\n=== 5. AI 生成 ai-gen ===");
{
  const s = await expectCommon("ai-gen", "AI 生成", "file");
  check("AI 生成：横幅明说了独立打开（配置只在内存）",
    s.hints.some((h) => /未连接宿主/.test(h) && /独立/.test(h)),
    JSON.stringify(s.hints));
  check("AI 生成：图床那一列的按钮不可见",
    (await page.evaluate(() => {
      const b = document.getElementById("btnRefFromImagebed");
      if (!b) return "missing";
      const r = b.getBoundingClientRect();
      return getComputedStyle(b).display === "none" || r.width === 0 ? "hidden" : "visible";
    })) === "hidden",
    String(await page.evaluate(() => document.getElementById("btnRefFromImagebed")?.getBoundingClientRect().width)));

  await expectCommon("ai-gen", "AI 生成", "http");
}

/* ==================================================================
 * 6. 异常单号登记（abnormal-ticket）
 *
 * 它跟上面几个的区别：那几个是"编辑器 / 生成器"，它是一份**登记台账**。
 * 界面分「登记」与「查看」两个页签，查看页是左右分栏（左列表 / 右详情+处理区）。
 * 所以这里验的重点是：
 *   · 一条记录能不能走完 登记 → 找到它 → 处理 → 删 这条闭环；
 *   · 分栏是不是真的分了（左右并排，不是堆着）；
 *   · 右栏的处理备注**边打边存**，刷新后还在；
 *   · 独立态下这些全都落 localStorage。
 * ================================================================== */
console.log("\n=== 6. 异常单号登记 abnormal-ticket ===");
{
  await expectCommon("abnormal-ticket", "异常单号", "file");
  await wipeLocal("abnormal-ticket");
  await openStandalone("abnormal-ticket", "file");

  /* ---------- 登记页 ---------- */
  const boot = await page.evaluate(() => ({
    createVisible: !document.getElementById("view-create").hidden,
    browseHidden: document.getElementById("view-browse").hidden,
  }));
  check("异常单：默认停在「登记」页", boot.createVisible && boot.browseHidden, JSON.stringify(boot));

  // 填订单号 + 描述（0.7.0 起描述选填，这里照填）。登记页字段对齐用户的台账：
  // 快递单号 / 快递公司 / 订单发货时间 / 情况 / 描述 —— 没有 YC- 自动编号了。
  await page.fill("#title", "来料尺寸超差");
  await page.fill("#orderSn", "261011-442394294633154");
  await page.waitForTimeout(250);

  /* 订单号格式提示（就在登记页验，因为登记完输入框会清空）。
     真·拼多多单号是 YYMMDD-数字，前 6 位 = 下单日期 —— 规则来自用户的 make-url.mjs。 */
  const snHint = await page.evaluate(() => {
    const el = document.getElementById("snHint");
    return { text: el ? el.textContent : "(没有)", cls: el ? el.className : "" };
  });
  check("异常单：订单号合形状时提示里给出下单日期",
    /下单日期/.test(snHint.text) && /2026/.test(snHint.text), snHint.text);
  check("异常单：合形状的提示走「正常」色（不是警告色）",
    /\bok\b/.test(snHint.cls) && !/\bbad\b/.test(snHint.cls), snHint.cls);

  await page.click("#add");
  await page.waitForTimeout(500);

  const stayed = await page.evaluate(() => ({
    on: !document.getElementById("view-create").hidden,
    cleared: document.getElementById("title").value === "",
  }));
  check("异常单：登记后留在登记页（现场录单是一条接一条）", stayed.on === true, String(stayed.on));
  check("异常单：登记后清空了内容输入框", stayed.cleared === true, String(stayed.cleared));

  /* ---------- 查看页：左右分栏 ---------- */
  await page.click("#tab-browse");
  await page.waitForTimeout(400);

  const split = await page.evaluate(() => {
    const left = document.querySelector("#view-browse .pane-left");
    const right = document.querySelector("#view-browse .pane-right");
    if (!left || !right) return { both: false };
    const lr = left.getBoundingClientRect();
    const rr = right.getBoundingClientRect();
    return {
      both: true,
      // 并排：两栏顶部齐平，且右栏确实在左栏右边（不是换行堆在下面）
      sideBySide: Math.abs(lr.top - rr.top) < 40 && rr.left >= lr.left + lr.width - 4,
      widths: [Math.round(lr.width), Math.round(rr.width)],
    };
  });
  check("异常单：查看页是左右分栏（右栏在左栏右边，不是堆在下面）",
    split.both === true && split.sideBySide === true, JSON.stringify(split));

  const list = await page.evaluate(() => ({
    cards: document.querySelectorAll(".ticket").length,
    code: (document.querySelector(".ticket .code") || {}).textContent || "",
    badge: (document.querySelector(".ticket .badge") || {}).textContent || "",
    stats: (document.getElementById("stats").textContent || "").replace(/\s+/g, " "),
    meta: document.getElementById("meta").textContent,
  }));
  check("异常单：列表里能看到刚登记的那条", list.cards === 1, `cards=${list.cards}`);
  check("异常单：第一行显示的是单号（快递单号没填就退到订单号）",
    list.code === "261011-442394294633154", list.code);
  check("异常单：新登记的默认是「待处理」（处理方式/结果都没填，派生的）", list.badge === "待处理", list.badge);
  check("异常单：统计条跟着动了", /待处理\s*1/.test(list.stats), list.stats);
  check("异常单：副标题说清了数据存在浏览器里", /浏览器|localStorage/.test(list.meta), list.meta);

  /* ---------- 右栏：详情 + 处理区 ---------- */
  const detail = await page.evaluate(() => ({
    code: (document.querySelector("#detail .d-code") || {}).textContent || "",
    title: (document.querySelector("#detail .d-title") || {}).textContent || "",
    hasNote: !!document.getElementById("d-note"),
    hasHandling: !!document.getElementById("d-handling"),
    hasResult: !!document.getElementById("d-result"),
    hasSettled: !!document.getElementById("d-settled"),
    hasAdvance: !!document.querySelector('#detail button[data-act="advance"]'),
    selCount: document.querySelectorAll('.ticket[aria-selected="true"]').length,
  }));
  check("异常单：右栏默认选中第一条并显示它的详情",
    detail.code === list.code && /来料尺寸超差/.test(detail.title), JSON.stringify(detail));
  check("异常单：左栏那一行被标成选中态", detail.selCount === 1, String(detail.selCount));
  check("异常单：右栏有处理区（处理情况输入框）", detail.hasNote === true, String(detail.hasNote));
  check("异常单：处理区有 处理方式 / 结果 / 已结账（台账那三列），没有「推进状态」按钮了",
    detail.hasHandling === true && detail.hasResult === true && detail.hasSettled === true &&
      detail.hasAdvance === false, JSON.stringify(detail));

  /* ---------- 表格页：整本台账铺开（0.8.4） ----------
   * 列序 = 推给 WPS 在线表格的 COLUMNS（lib/kwiki.ts），两边必须能一一对上；
   * 只读 —— 点一行回「查看」页那条的详情，改仍在详情里改。 */
  await page.click("#tab-table");
  await page.waitForTimeout(250);
  const tbl = await page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll("#tableHead th")).map((th) => th.textContent);
    const rows = document.querySelectorAll("#tableBody tr[data-id]");
    return {
      visible: !document.getElementById("view-table").hidden,
      heads: heads.join(","),
      cols: document.querySelectorAll("#tableCols col").length,
      count: rows.length,
      first: rows[0] ? (rows[0].innerText || "").replace(/\s+/g, " ").trim() : "",
    };
  });
  check("异常单：表格页能打开", tbl.visible === true, String(tbl.visible));
  check("异常单：表格 14 列，列序与 WPS 台账一致",
    tbl.cols === 14 && tbl.heads ===
      "订单号,快递单号,快递公司,发货时间,店铺,情况,详细描述,处理方式,结果,结账,当前状态,处理情况,登记时间,更新时间",
    tbl.heads);
  check("异常单：表格里能看到刚登记的那条",
    tbl.count === 1 && /261011-442394294633154/.test(tbl.first),
    `count=${tbl.count} first=${tbl.first}`);

  await page.click("#tableBody tr[data-id]");
  await page.waitForTimeout(250);
  const tblJump = await page.evaluate(() => ({
    browse: !document.getElementById("view-browse").hidden,
    code: (document.querySelector("#detail .d-code") || {}).textContent || "",
  }));
  check("异常单：点表格一行 → 跳回「查看」并选中它",
    tblJump.browse === true && tblJump.code === "261011-442394294633154", JSON.stringify(tblJump));

  /* ---------- 表格页的列配置（0.8.5）----------
     用户要能挑显示哪些列、按什么顺序摆；配置要落盘（刷新后还在）。
     这一节最后留一个「快递公司被隐藏」的状态，交给下面的刷新段落验证持久化。 */
  await page.click("#tab-table");
  await page.click("#colBtn");
  const colPanel = await page.evaluate(() => ({
    open: !document.getElementById("colPanel").hidden,
    rows: document.querySelectorAll("#colPanel .crow").length,
    boxes: document.querySelectorAll("#colPanel input[type=checkbox]").length,
  }));
  check("异常单：列配置面板能打开，14 列都在",
    colPanel.open === true && colPanel.rows === 14 && colPanel.boxes === 14, JSON.stringify(colPanel));

  await page.click('#colPanel input[data-col="courier"]');
  await page.waitForTimeout(250);
  const noCourier = await page.evaluate(() => ({
    heads: Array.from(document.querySelectorAll("#tableHead th")).map((t) => t.textContent),
    cols: document.querySelectorAll("#tableCols col").length,
    count: (document.getElementById("colCount") || {}).textContent,
    minW: document.querySelector("#view-table table.ledger").style.minWidth,
  }));
  check("异常单：取消一列 → 表头少一列、计数与整表最小宽度跟着变",
    noCourier.cols === 13 && noCourier.heads.indexOf("快递公司") < 0 &&
      noCourier.count === "13/14" && noCourier.minW === "1472px",
    JSON.stringify(noCourier));

  // 调序：把「店铺」往前挪一格（它前面是「发货时间」）
  await page.click('#colPanel button[data-act="up"][data-col="store"]');
  await page.waitForTimeout(250);
  const reordered = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#tableHead th")).map((t) => t.textContent).slice(0, 4));
  check("异常单：↑ 能把列往前挪（店铺 移到 发货时间 前面）",
    reordered[2] === "店铺" && reordered[3] === "发货时间", reordered.join(","));

  // 只留一列，再试图把最后一列也取消（应被拦住）
  const COL_KEYS = ["order_sn", "tracking_no", "courier", "shipped_at", "store", "category",
    "title", "handling", "result", "settled", "_status", "note", "created_at", "updated_at"];
  for (const k of COL_KEYS) {
    if (k === "order_sn") continue;
    const on = await page.evaluate((key) => {
      const el = document.querySelector(`#colPanel input[data-col="${key}"]`);
      return el ? el.checked : false;
    }, k);
    if (on) await page.click(`#colPanel input[data-col="${k}"]`);
  }
  const onlyOne = await page.evaluate(() => ({
    cols: document.querySelectorAll("#tableHead th").length,
    count: (document.getElementById("colCount") || {}).textContent,
  }));
  check("异常单：可以只留一列", onlyOne.cols === 1 && onlyOne.count === "1/14", JSON.stringify(onlyOne));

  await page.click('#colPanel input[data-col="order_sn"]');
  await page.waitForTimeout(200);
  check("异常单：不允许把最后一列也取消",
    (await page.evaluate(() => document.querySelectorAll("#tableHead th").length)) === 1);

  // 恢复默认 → 只隐藏「快递公司」，给刷新段落留一个可验证的状态
  await page.click('#colPanel button[data-act="reset"]');
  await page.waitForTimeout(200);
  await page.click('#colPanel input[data-col="courier"]');
  await page.waitForTimeout(200);
  await page.click("#tab-browse");
  await page.waitForTimeout(150);

  /* ---------- 订单号 + 呼起本地客户端 ----------
   * 这块的核心是**链接拼得对不对**：少一个参数、拼接顺序错了，
   * 客户端那边就是"什么都没发生"，而那是最难查的症状。
   * 所以断言拿的是按钮 title 里的整条 URL，逐字符比对。 */
  const client = await page.evaluate(() => {
    const btn = document.querySelector('#detail button[data-act="open-client"]');
    return {
      hasBtn: !!btn,
      title: btn ? btn.getAttribute("title") : "",
      detailText: document.getElementById("detail").innerText || "",
      cfgHint: (document.getElementById("cfgHint") || {}).textContent || "",
    };
  });
  check("异常单：详情里显示订单号", client.detailText.indexOf("261011-442394294633154") >= 0,
    String(client.detailText.indexOf("261011-442394294633154") >= 0));
  check("异常单：右栏给出「呼起客户端」按钮", client.hasBtn === true, String(client.hasBtn));
  check("异常单：呼起链接拼对了（协议 + OpeId + mallcsid + ordersn）",
    client.title === "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_355831479&ordersn=261011-442394294633154",
    client.title);
  /* ---------- 店铺表：8 个店铺，各配一个客服 ID ----------
   * 用户有 8 个店铺，每条单属于其中一个 —— 呼起必须用**那个店的** mallcsid。
   * 只留一个全局客服 ID 的话，每次呼起前都得手动切一次；切错了的链接照样把客户端
   * 弹起来、只是定位不到订单，界面上一点报错都没有。 */
  const stores = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#stores .store-row")];
    return {
      rows: rows.length,
      names: rows.map((r) => r.querySelector("input.name").value),
      firstCs: rows[0] ? rows[0].querySelector("input.cs").value : "",
      missing: rows.filter((r) => r.classList.contains("empty-cs")).length,
      options: [...document.querySelectorAll("#store option")].map((o) => o.value),
      hint: (document.getElementById("cfgHint") || {}).textContent || "",
    };
  });
  check("异常单：配置区是一张 8 个店铺的表（用户有 8 个店）",
    stores.rows === 8 && stores.names[0] === "拼多多5店", JSON.stringify(stores.names));
  check("异常单：第一个店铺是实测确认过的「拼多多5店」",
    stores.firstCs === "cs_355831479", stores.firstCs);
  check("异常单：还没填客服 ID 的店铺被标出来并被提示",
    stores.missing === 6 && /没绑的那几/.test(stores.hint), `${stores.missing} 行 / ${stores.hint}`);
  check("异常单：登记页有店铺下拉，选项和店铺表一致",
    stores.options.length === 8 && stores.options[0] === "拼多多5店", JSON.stringify(stores.options));
  check("异常单：登记时选的店铺记到了单子上（没选就是第一个）",
    client.detailText.indexOf("拼多多5店") >= 0, client.detailText.slice(0, 60));

  /* 列表行里也要能直接呼起 —— 用户要的是"每一个单号都能一键唤醒"，
     不用先选中再点右栏。点行里的「↗」不该改变右栏选中的那条。 */
  const rowWake = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ticket")];
    const withSn = rows.filter((r) => r.querySelector('button[data-act="open-client"]'));
    const btn = withSn[0] ? withSn[0].querySelector('button[data-act="open-client"]') : null;
    return {
      total: rows.length,
      withBtn: withSn.length,
      sn: btn ? btn.getAttribute("data-sn") : "",
      title: btn ? btn.getAttribute("title") : "",
      text: btn ? btn.textContent.trim() : "",
    };
  });
  check("异常单：有订单号的行里直接挂着「↗」呼起按钮",
    rowWake.total === 1 && rowWake.withBtn === 1 && rowWake.text === "↗", JSON.stringify(rowWake));
  check("异常单：行里的「↗」带的单号就是这一条的",
    rowWake.sn === "261011-442394294633154", rowWake.sn);
  check("异常单：行里「↗」的 title 说清了会打开哪一单",
    rowWake.title.indexOf("261011-442394294633154") >= 0, rowWake.title);

  // 点行里的「↗」→ 不改右栏选中（扫单时不该打乱正在处理的那条）。
  //
  // ⚠️ 点这个按钮会走 openClient()：它造一个 <a href="pddim:…"> 再 .click()，
  // 也就是**真的去拉系统里的拼多多商家版**。测试不该真拉，而且 headless 下
  // 那一次外部协议跳转会让之后所有 Playwright 坐标点击失灵（报"成功"但事件不到）。
  // 所以把 <a>.click 临时换成空操作 —— 事件链照走（能验"不改选中"），系统不被惊动。
  const beforeSel = await page.evaluate(() =>
    (document.querySelector('.ticket[aria-selected="true"] .code') || {}).textContent || "");
  await page.evaluate(() => {
    window.__realAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { /* 测试桩：不真跳协议 */ };
  });
  await page.click('.ticket button[data-act="open-client"]');
  await page.waitForTimeout(500);
  const wakeRan = await page.evaluate(() => {
    const t = document.querySelector(".toast, #toast");
    return t ? t.textContent : "";
  });
  await page.evaluate(() => { HTMLAnchorElement.prototype.click = window.__realAnchorClick; });
  check("异常单：点行里「↗」确实走到呼起那一步（给了提示）", /呼起/.test(wakeRan), wakeRan);
  const afterSel = await page.evaluate(() => ({
    sel: (document.querySelector('.ticket[aria-selected="true"] .code') || {}).textContent || "",
    selCount: document.querySelectorAll('.ticket[aria-selected="true"]').length,
  }));
  check("异常单：点行里「↗」不改右栏选中的那条",
    afterSel.sel === beforeSel && afterSel.selCount === 1, JSON.stringify({ beforeSel, ...afterSel }));

  /* ---------- 右栏也给出这条单号的说明 ---------- */
  const detailSnHint = await page.evaluate(() => {
    const el = document.querySelector("#detail .snhint");
    return el ? el.textContent : "(没有)";
  });
  check("异常单：右栏也给出了这条单号的说明", /下单日期/.test(detailSnHint), detailSnHint);

  /* ---------- 换店铺：没配客服 ID 的店不能假装能呼起 ----------
     用户有 8 个店，一开始只有 1 个填了客服 ID —— 选了别的店时必须**说清为什么**
     呼不起来，而不是给一个能点但什么都不发生的按钮。 */
  await page.selectOption("#d-store", "店铺 3");
  await page.waitForTimeout(800);
  const noCs = await page.evaluate(() => {
    const wake = document.querySelector(".ticket button.wake");
    return {
      hasOpen: !!document.querySelector('#detail button[data-act="open-client"]'),
      note: (document.querySelector("#detail .cfg-note") || {}).textContent || "",
      rowStore: wake ? wake.getAttribute("data-store") : "",
      rowTip: wake ? wake.getAttribute("title") : "",
    };
  });
  check("异常单：换成没配客服 ID 的店铺后，呼起按钮禁用并说明原因",
    noCs.hasOpen === false && /还没绑客服 ID/.test(noCs.note), JSON.stringify(noCs));
  check("异常单：行里的「↗」跟着这条单的店铺走，提示也换了",
    noCs.rowStore === "店铺 3" && /客服 ID/.test(noCs.rowTip), JSON.stringify(noCs.rowTip));

  // 换回店铺 1 —— 走右栏那个店铺下拉（登记时选错了就靠它改）
  await page.selectOption("#d-store", "拼多多5店");
  await page.waitForTimeout(800);
  const backTo1 = await page.evaluate(() => {
    const btn = document.querySelector('#detail button[data-act="open-client"]');
    return {
      url: btn ? btn.getAttribute("title") : "(禁用)",
      store: (document.getElementById("d-store") || {}).value || "",
    };
  });
  check("异常单：右栏换店铺后链接跟着换、快捷行的店铺也改过来了",
    backTo1.url === "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_355831479&ordersn=261011-442394294633154" &&
      backTo1.store === "拼多多5店", JSON.stringify(backTo1));

  /* ---------- 设置页：店铺与客服 ID 是独立的一页 ----------
     用户要的：别把这些挤在登记页里，单独一页，而且要能"传一条链接绑到某个店铺"。 */
  await page.click("#tab-settings");
  await page.waitForTimeout(500);
  const setPage = await page.evaluate(() => ({
    tabs: ["create", "browse", "settings"].filter((n) => document.getElementById("tab-" + n)).length,
    shown: ["create", "browse", "settings"].filter((n) => !document.getElementById("view-" + n).hidden),
    hasBind: !!document.getElementById("bindLink") && !!document.getElementById("bindDo"),
    bindOpts: [...document.querySelectorAll("#bindStore option")].length,
    storeRows: [...document.querySelectorAll("#stores .store-row")].length,
  }));
  check("异常单：店铺与客服 ID 搬到了独立的「设置」页（三个页签，只显示这一页）",
    setPage.tabs === 3 && setPage.shown.length === 1 && setPage.shown[0] === "settings" &&
      setPage.hasBind === true, JSON.stringify(setPage));
  check("异常单：设置页的店铺表和「绑到」下拉都在", 
    setPage.storeRows === 8 && setPage.bindOpts === 8, JSON.stringify(setPage));

  /* ---------- 传一条链接，绑到指定店铺 ---------- */
  const BIND_URL = "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_800000123&ordersn=261011-362765391472941";
  await page.fill("#bindLink", BIND_URL);
  await page.waitForTimeout(500);
  const bindRead = await page.evaluate(() => ({
    hint: (document.getElementById("bindHint") || {}).textContent || "",
    cls: (document.getElementById("bindHint") || {}).className || "",
  }));
  check("异常单：设置页粘一条链接能认出客服 ID（订单号明说用不上）",
    /cs_800000123/.test(bindRead.hint) && /用不上/.test(bindRead.hint) && /\bok\b/.test(bindRead.cls),
    bindRead.hint);

  await page.selectOption("#bindStore", "店铺 3");
  await page.click("#bindDo");
  await page.waitForTimeout(700);
  const bound = await page.evaluate(() => ({
    msg: (document.getElementById("bindMsg") || {}).textContent || "",
    cs: (document.querySelectorAll("#stores .store-row input.cs")[2] || {}).value || "",
    opts: (document.querySelectorAll("#bindStore option")[2] || {}).textContent || "",
  }));
  check("异常单：绑定把客服 ID 写进那个店铺并保存",
    bound.cs === "cs_800000123" && /绑上了/.test(bound.msg), JSON.stringify(bound));
  check("异常单：绑完「绑到」下拉里那个店也显示出了客服 ID",
    /cs_800000123/.test(bound.opts), bound.opts);

  // 再来一条同 ID 的链接（同一个店换一张订单）—— 应该认出它已经属于店铺 3
  await page.fill("#bindLink", BIND_URL + "&z=1");
  await page.waitForTimeout(500);
  const bindAgain = await page.evaluate(() => (document.getElementById("bindStore") || {}).value || "");
  check("异常单：同一个客服 ID 再来一条，自动把「绑到」指到已有的那个店",
    bindAgain === "店铺 3", bindAgain);

  await page.fill("#bindLink", "https://example.com/x");
  await page.waitForTimeout(400);
  const bindBad = await page.evaluate(() => ({
    hint: (document.getElementById("bindHint") || {}).textContent || "",
    cls: (document.getElementById("bindHint") || {}).className || "",
  }));
  check("异常单：设置页粘的不是 pddim 链接时也说清形状",
    /mallcsid/.test(bindBad.hint) && /\bbad\b/.test(bindBad.cls), JSON.stringify(bindBad));

  // 在"绑店铺"这页粘裸订单号 —— 指错地方了，要说明白而不是只报"错"
  await page.fill("#bindLink", "261011-597950502412841");
  await page.waitForTimeout(400);
  const bareBind = await page.evaluate(() => (document.getElementById("bindHint") || {}).textContent || "");
  check("异常单：设置页粘裸订单号时说清「绑店铺要的是链接，登记去另一页」",
    /订单号，不是唤醒链接/.test(bareBind) && /登记/.test(bareBind), bareBind);

  /* ---------- 改店铺名 / 改客服 ID ----------
     改名要**带着已登记的单子一起走**：单子上记的是店铺名，不跟过去那些单子就会
     变成"店铺不在表里了"、静悄悄地呼不起来，而用户只是把「拼多多5店」改成了真名字。 */
  await page.fill("#stores .store-row:first-child input.name", "拾野");
  await page.fill("#stores .store-row:first-child input.cs", "cs_999999999");
  await page.click("#saveCfg");
  await page.waitForTimeout(1000);
  const saved = await page.evaluate(() => ({
    toast: (document.getElementById("toast") || {}).textContent || "",
    first: (document.querySelector("#stores .store-row input.name") || {}).value,
  }));
  check("异常单：保存店铺表时报告了改名影响了几条单子",
    saved.first === "拾野" && /换到新名字/.test(saved.toast), saved.toast);

  /* ---------- 粘 ERP 链接（粘在**订单号框**里） ----------
   * ★ 客服 ID 是 ERP 生成的，用户没法凭空知道 —— 所以正门是"把 ERP 给的那条
   * 链接粘进来"，从里面抠 mallcsid / ordersn，而不是让人去填一个看不出所以然的 ID。
   * 0.6.1 起**订单号框一处通吃**：粘单号、粘整条链接都认（链接里那两个参数
   * 顺手把店铺也认出来），登记页不再另放一个「ERP 链接」框 —— 少一个框，
   * 也少一次"我这串东西该粘哪个框"的犹豫。
   * 三条路径都要验：认得出来（表里已有）、不认识（填进空行）、粘错了。
   * ⚠️ Playwright 的 fill 不触发 paste，得手动派发（真实粘贴才有那个事件）。 */
  await page.click("#tab-create");
  await page.waitForTimeout(400);
  const pasteSn = async (text) => {
    await page.fill("#orderSn", text);
    await page.evaluate(() => {
      document.getElementById("orderSn").dispatchEvent(new Event("paste", { bubbles: true }));
    });
  };
  const ERP1 = "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_999999999&ordersn=261011-648659679643144";
  await pasteSn(ERP1);
  await page.waitForTimeout(900);
  const hitKnown = await page.evaluate(() => ({
    toast: (document.getElementById("toast") || {}).textContent || "",
    sn: document.getElementById("orderSn").value,
    store: document.getElementById("store").value,
    cls: (document.getElementById("snHint") || {}).className || "",
  }));
  check("异常单：粘已知店铺的 ERP 链接，订单号抠出来、店铺也一起认出来",
    hitKnown.sn === "261011-648659679643144" && hitKnown.store === "拾野" && /\bok\b/.test(hitKnown.cls),
    JSON.stringify(hitKnown));
  check("异常单：认出来了要说一声（认出的是哪个店）",
    /认出来了/.test(hitKnown.toast) && /拾野/.test(hitKnown.toast), hitKnown.toast);

  const ERP2 = "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_800000007&ordersn=261011-362765391472941";
  await pasteSn(ERP2);
  await page.waitForTimeout(900);
  const hitNew = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#stores .store-row")];
    return {
      toast: (document.getElementById("toast") || {}).textContent || "",
      store: document.getElementById("store").value,
      filled: rows.map((r) => r.querySelector("input.cs").value).filter(Boolean),
      count: rows.length,
    };
  });
  check("异常单：陌生的客服 ID 填进一个空行（不新建、也不动已经绑好的那几个）",
    hitNew.count === 8 && hitNew.filled.length === 4 && hitNew.filled.indexOf("cs_800000007") >= 0,
    JSON.stringify(hitNew));
  check("异常单：认出陌生的 ID 之后说明白了它记到了哪个店",
    /记到了/.test(hitNew.toast) && /cs_800000007/.test(hitNew.toast), hitNew.toast);

  await pasteSn("先填个别的");
  await pasteSn(ERP2);
  await page.waitForTimeout(900);
  const again = await page.evaluate(() => ({
    toast: (document.getElementById("toast") || {}).textContent || "",
    filled: [...document.querySelectorAll("#stores .store-row input.cs")].map((i) => i.value).filter(Boolean).length,
  }));
  check("异常单：同一个客服 ID 再粘一次是「认出」，不会又加一个店",
    /店铺「/.test(again.toast) && again.filled === 4, JSON.stringify(again));

  // 粘一条网址：既不是单号也不是 pddim 链接 —— 订单号框要说"这串定位不到"
  await pasteSn("https://example.com/abc");
  await page.waitForTimeout(500);
  const bad = await page.evaluate(() => ({
    hint: (document.getElementById("snHint") || {}).textContent || "",
    cls: (document.getElementById("snHint") || {}).className || "",
  }));
  check("异常单：粘进来一条网址（不是单号也不是链接）时说清这一串定位不到",
    /格式存疑/.test(bad.hint) && /\bbad\b/.test(bad.cls), JSON.stringify(bad));

  // ★ 钉住这个决定：登记页不该再有单独的「ERP 链接」框（粘链接收进订单号框了）
  const noErpBox = await page.evaluate(() => ({
    hasErp: !!document.getElementById("erpLink"),
    ph: (document.getElementById("orderSn") || {}).placeholder || "",
  }));
  check("异常单：登记页没有单独的「ERP 链接」框了（订单号框一处通吃）",
    noErpBox.hasErp === false && /ERP/.test(noErpBox.ph), JSON.stringify(noErpBox));

  /* ---------- 订单号粘得"脏"一点也要认 ----------
     现实里单号很少是干净的：从聊天 / 表格 / ERP 复制常带全角连字符（－）、
     长短破折号（—–）、看不见的空白（\u00A0 / \u200B）。这些会让形状判定 False，
     界面上只显示一句"格式存疑" —— 而单号其实是对的，用户只会觉得工具在骗他。
     另外整条链接被粘进订单号框也要能把 ordersn 抠出来。 */
  const normCases = [
    ["全角连字符", "261011－597950502412841"],
    ["短破折号", "261011–597950502412841"],
    ["空格 + 看不见的空白", " 261011\u00A0-\u200B597950502412841 "],
    // 整条链接也要能把 ordersn 抠出来。★ 客服 ID 用**表里已有**的那个：
    // 陌生的 ID 会被顺手记进一个空行（认店铺的副作用），后面的计数断言就对不上了。
    ["整条唤醒链接", "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_999999999&ordersn=261011-597950502412841"],
  ];
  for (const [label, raw] of normCases) {
    await page.fill("#orderSn", raw);
    await page.evaluate(() => {
      document.getElementById("orderSn").dispatchEvent(new Event("paste", { bubbles: true }));
    });
    await page.waitForTimeout(150);
    const got = await page.evaluate(() => ({
      v: document.getElementById("orderSn").value,
      cls: (document.getElementById("snHint") || {}).className || "",
    }));
    check(`异常单：订单号粘得脏一点也认（${label}）`,
      got.v === "261011-597950502412841" && /\bok\b/.test(got.cls), JSON.stringify({ label, ...got }));
  }

  // 店铺表的「客服 ID」框里直接粘整条链接，也要当场抠出来（店铺表在设置页）
  await page.click("#tab-settings");
  await page.waitForTimeout(400);
  await page.fill("#stores .store-row:nth-child(3) input.cs",
    "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_777777777&ordersn=261011-103945367091884");
  await page.evaluate(() => {
    const inp = document.querySelectorAll("#stores .store-row input.cs")[2];
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const csPasted = await page.evaluate(() => document.querySelectorAll("#stores .store-row input.cs")[2].value);
  check("异常单：店铺表的「客服 ID」框里粘整条链接也会抠出 cs_…",
    csPasted === "cs_777777777", csPasted);

  await page.click("#tab-browse");
  await page.waitForTimeout(500);
  const cfg2 = await page.evaluate(() => {
    const btn = document.querySelector('#detail button[data-act="open-client"]');
    return {
      title: btn ? btn.getAttribute("title") : "(禁用)",
      picker: (document.getElementById("d-store") || {}).value || "",
    };
  });
  check("异常单：改客服 ID 后链接跟着变",
    cfg2.title === "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_999999999&ordersn=261011-442394294633154",
    cfg2.title);
  check("异常单：改了店铺名，单子上那条也跟着改了（改名传播，店铺显示在快捷行）",
    cfg2.picker === "拾野", `picker=${cfg2.picker}`);

  // 处理备注边打边存
  await page.fill("#d-note", "已通知供应商，等回料复检");
  await page.waitForTimeout(1300);
  const savedTip = await page.evaluate(() => (document.getElementById("d-saved") || {}).textContent || "");
  check("异常单：处理情况自动保存了", /已保存/.test(savedTip), savedTip);

  /* ---------- 刷新：靠 localStorage 落住 ---------- */
  await openStandalone("abnormal-ticket", "file");
  await page.click("#tab-browse");
  await page.waitForTimeout(400);
  const afterReload = await page.evaluate(() => ({
    cards: document.querySelectorAll(".ticket").length,
    code: (document.querySelector(".ticket .code") || {}).textContent || "",
    note: (document.getElementById("d-note") || {}).value || "",
    hasOrderSn: (document.getElementById("detail").innerText || "").indexOf("261011-442394294633154") >= 0,
    badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
    settled: document.getElementById("d-settled") ? document.getElementById("d-settled").checked : null,
    handling: document.getElementById("d-handling") ? document.getElementById("d-handling").value : "",
    cfg: (document.querySelector("#stores .store-row:first-child input.name") || {}).value || "",
    cs: (document.querySelector("#stores .store-row:first-child input.cs") || {}).value || "",
    storeRows: document.querySelectorAll("#stores .store-row").length,
  }));
  check("异常单：刷新后单号还在（真的落盘了）",
    afterReload.cards === 1 && afterReload.code === list.code,
    `${afterReload.cards} 张 / ${afterReload.code}`);
  check("异常单：处理情况也还在（备注真的落盘了）",
    /已通知供应商/.test(afterReload.note), afterReload.note.slice(0, 24));
  check("异常单：还没补处理信息的行，刷新后状态就是「待处理」（派生初值稳定）",
    afterReload.handling === "" && afterReload.badge === "待处理" && afterReload.settled === false,
    JSON.stringify({ handling: afterReload.handling, badge: afterReload.badge, settled: afterReload.settled }));
  check("异常单：订单号刷新后也还在（是存进表里的，不是内存）",
    afterReload.hasOrderSn === true, String(afterReload.hasOrderSn));
  check("异常单：改过的店铺表刷新后还在（独立态落 localStorage）",
    afterReload.cfg === "拾野" && afterReload.cs === "cs_999999999" && afterReload.storeRows === 8,
    `${afterReload.storeRows} 行 / ${afterReload.cfg} / ${afterReload.cs}`);

  // 列配置也落盘了：隐藏的「快递公司」刷新后仍然隐藏。
  // ★ 读配置在 loadCfg 末尾，而独立态要等宿主握手超时才落定 —— 用轮询等它，别死等固定毫秒
  await page.click("#tab-table");
  await page
    .waitForFunction(() => {
      const el = document.getElementById("colCount");
      return el && el.textContent === "13/14";
    }, null, { timeout: 8000 })
    .catch(() => {});
  const afterReloadCols = await page.evaluate(() => ({
    heads: Array.from(document.querySelectorAll("#tableHead th")).map((t) => t.textContent),
    count: (document.getElementById("colCount") || {}).textContent,
  }));
  check("异常单：刷新后列配置还在（隐藏的列仍然隐藏）",
    afterReloadCols.heads.length === 13 && afterReloadCols.heads.indexOf("快递公司") < 0 &&
      afterReloadCols.count === "13/14", JSON.stringify(afterReloadCols));

  // 收尾恢复默认，后面的段落按 14 列走
  await page.click("#colBtn");
  await page.click('#colPanel button[data-act="reset"]');
  await page.waitForTimeout(200);
  await page.click("#tab-browse");
  await page.waitForTimeout(150);

  /* ---------- 状态由处理字段派生（0.7.0）----------
     台账的工作流就是：登记时啥都没填 → 待处理；补了处理方式 → 处理中；
     补了结果 → 已关闭。状态不再是一个要人另维护的按钮。 */
  await page.selectOption("#d-handling", "平台申诉");
  await page.waitForTimeout(900);
  const s1 = await page.evaluate(() => (document.querySelector("#detail .d-head .badge") || {}).textContent);
  check("异常单：补了处理方式 → 状态派生为「处理中」", s1 === "处理中", String(s1));

  await page.selectOption("#d-result", "开仓中转");
  await page.waitForTimeout(900);
  const s2 = await page.evaluate(() => {
    const item = document.querySelector(".ticket");
    return {
      badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
      listStruck: item ? item.className.indexOf("s-done") >= 0 : false,
      settled: document.getElementById("d-settled") ? document.getElementById("d-settled").checked : null,
      noteKept: (document.getElementById("d-note") || {}).value || "",
    };
  });
  check("异常单：补了结果 → 「已关闭」", s2.badge === "已关闭", s2.badge);
  check("异常单：左栏那一行也跟着变成关闭样式", s2.listStruck === true, String(s2.listStruck));
  check("异常单：处理情况没有在重建右栏时弄丢", /已通知供应商/.test(s2.noteKept), s2.noteKept.slice(0, 24));

  // 勾上「已结账」（台账的最后一列）—— 一改就落库
  await page.click("#d-settled");
  await page.waitForTimeout(900);
  const settledNow = await page.evaluate(() => (document.getElementById("d-settled") || {}).checked);
  check("异常单：勾上「已结账」后重建的右栏还保持着勾选", settledNow === true, String(settledNow));

  /* ---------- 处理进度要真的落库：整页刷新一遍再读 ---------- */
  await openStandalone("abnormal-ticket", "file");
  await page.click("#tab-browse");
  await page.waitForTimeout(400);
  const procReload = await page.evaluate(() => ({
    badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
    handling: document.getElementById("d-handling") ? document.getElementById("d-handling").value : "",
    settled: document.getElementById("d-settled") ? document.getElementById("d-settled").checked : null,
    struck: ((document.querySelector(".ticket") || {}).className || "").includes("s-done"),
    noteKept: (document.getElementById("d-note") || {}).value || "",
  }));
  check("异常单：处理方式 / 结果 / 已结账 刷新后还在（处理进度落的是库，不是界面）",
    procReload.handling === "平台申诉" && procReload.badge === "已关闭" &&
      procReload.settled === true && procReload.struck === true,
    JSON.stringify(procReload));
  check("异常单：处理进度落库也没弄丢处理情况", /已通知供应商/.test(procReload.noteKept),
    procReload.noteKept.slice(0, 24));

  /* ---------- 搜索：筛掉的是显示，不是数据 ---------- */
  await page.fill("#search", "这个关键词不存在");
  await page.waitForTimeout(300);
  const none = await page.evaluate(() => document.querySelectorAll(".ticket").length);
  check("异常单：搜不到时列表空着", none === 0, String(none));
  await page.fill("#search", "");
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => document.querySelectorAll(".ticket").length);
  check("异常单：清掉搜索又回来了（数据没被筛掉）", back === 1, String(back));

  /* ---------- 删除（右栏） ---------- */
  await page.click('#detail button[data-act="del"]');
  await page.waitForTimeout(500);
  const afterDel = await page.evaluate(() => ({
    cards: document.querySelectorAll(".ticket").length,
    detailText: document.getElementById("detail").textContent || "",
  }));
  check("异常单：删除也生效", afterDel.cards === 0, String(afterDel.cards));
  check("异常单：删掉后右栏回到空态（不挂着刚删的那条）",
    /从左边挑一条|还没有登记过/.test(afterDel.detailText), afterDel.detailText.slice(0, 30));

  /* ---------- 没填订单号 → 呼起按钮该禁用 ----------
     不要给一个"能点、但点了什么都不发生"的按钮 —— 那比藏起来更难猜。
     0.7.0 起只有快递单号也能登记（台账里就有缺订单号的行），所以走快递单号进来。 */
  await page.click("#tab-create");
  await page.fill("#trackingNo", "7770011122233");
  await page.fill("#title", "没订单号、只有快递单号的异常");
  await page.click("#add");
  await page.waitForTimeout(400);
  await page.click("#tab-browse");
  await page.waitForTimeout(300);
  await page.click(".ticket");               // 第一行 = 最新那条（列表按登记时间倒序）
  await page.waitForTimeout(300);
  const noSn = await page.evaluate(() => {
    const open = document.querySelector('#detail button[data-act="open-client"]');
    const any = document.querySelector("#detail .client-row button");
    return { hasOpen: !!open, disabled: any ? any.disabled : null, text: any ? any.textContent.trim() : "" };
  });
  check("异常单：没填订单号时「呼起客户端」是禁用的",
    noSn.hasOpen === false && noSn.disabled === true, JSON.stringify(noSn));

  /* ---------- 格式存疑的单号 ----------
     用户桌面 pdd-launcher 里真有一条「订单-格式存疑-6055793709660380.url」：
     一长串纯数字，不是 YYMMDD-数字 那个形状。客户端会弹起来、但定位不到那张单 ——
     最难的正是这种"看着成功了其实没有"，所以：
       ① 输入时就给警告  ② 行里的「↗」照给（点了会弹，只是可能定位不到）
  */
  await page.click("#tab-create");
  await page.fill("#title", "格式存疑的单号");
  await page.fill("#orderSn", "6055793709660380");
  await page.waitForTimeout(250);
  const weirdHint = await page.evaluate(() => {
    const el = document.getElementById("snHint");
    return { text: el ? el.textContent : "", cls: el ? el.className : "" };
  });
  check("异常单：单号不合形状时提示说「格式存疑」", /格式存疑/.test(weirdHint.text), weirdHint.text);
  check("异常单：不合形状的提示走警告色", /\bbad\b/.test(weirdHint.cls), weirdHint.cls);

  await page.click("#add");
  await page.waitForTimeout(450);
  const weirdAfterAdd = await page.evaluate(() => ({
    hint: (document.getElementById("snHint") || {}).textContent || "",
    snCleared: (document.getElementById("orderSn") || {}).value === "",
  }));
  check("异常单：登记后格式提示跟着清掉",
    weirdAfterAdd.hint === "" && weirdAfterAdd.snCleared === true, JSON.stringify(weirdAfterAdd));

  await page.click("#tab-browse");
  await page.waitForTimeout(400);
  // 选中有问题的那条，顺便看右栏的提示
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ticket")];
    const hit = rows.find((r) => r.querySelector('button[data-act="open-client"][data-sn="6055793709660380"]'));
    if (hit) hit.click();
  });
  await page.waitForTimeout(400);
  const weirdRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ticket")];
    const hit = rows.find((r) => r.querySelector('button[data-act="open-client"][data-sn="6055793709660380"]'));
    return {
      hasBtn: !!hit,
      title: hit ? hit.querySelector("button").getAttribute("title") : "",
      detailBad: !!document.querySelector("#detail .snhint.bad"),
    };
  });
  check("异常单：格式存疑的那条照样有「↗」（客户端会弹，只是可能定位不到）",
    weirdRow.hasBtn === true, JSON.stringify(weirdRow));
  check("异常单：那条的按钮 title 里提醒了格式问题",
    /格式存疑|定位不到/.test(weirdRow.title), weirdRow.title);
  check("异常单：选中它时右栏也给警告（不是只在登记页说）",
    weirdRow.detailBad === true, String(weirdRow.detailBad));

  /* ---------- 走一遍 ERP 链接的完整登记 ----------
     放在最后：这一步会多一条记录，前面的计数断言不该被它影响。 */
  await page.click("#tab-create");
  await page.waitForTimeout(400);
  await pasteSn("pddim:sendmsg/?OpeId=open_order&mallcsid=cs_999999999&ordersn=261011-109827858042143");
  await page.waitForTimeout(800);
  const beforeAdd = await page.evaluate(() => ({
    sn: document.getElementById("orderSn").value,
    store: document.getElementById("store").value,
  }));
  await page.fill("#title", "ERP 链接流进来的一条");
  await page.click("#add");
  await page.waitForTimeout(800);
  const afterAdd = await page.evaluate(() => ({
    snCleared: document.getElementById("orderSn").value === "",
    hintCleared: (document.getElementById("snHint") || {}).textContent === "",
    storeKept: document.getElementById("store").value,
  }));
  check("异常单：从 ERP 链接一路登记下来，店铺留着、订单号框清掉（下一条是另一条单）",
    beforeAdd.sn === "261011-109827858042143" && beforeAdd.store === "拾野" &&
      afterAdd.snCleared && afterAdd.hintCleared && afterAdd.storeKept === "拾野",
    JSON.stringify({ beforeAdd, afterAdd }));

  /* ---------- 0.6.0：快递单号 / 情况选项可配置 / 重复单号检测 / 店铺·情况筛选 ----------
     都是用户点名要的：
       · 登记的主线是「哪个店、哪一单、哪个包裹」——所以要快递单号；
       · 情况（异常类型）会随业务变，得能在设置里加，不能写死在代码里；
       · 同一个订单号录第二遍多半是手滑 —— 要当场拦一下，还能跳到那条去看；
       · 8 个店的单子混在一个列表里，要能按店铺（和情况）筛。
     放在最后：这段会再登记 2 条单，前面的计数断言不该被影响。 */

  // ① 四组下拉选项：出厂默认（情况那组抄的就是用户台账）+ 设置页的四个编辑框
  const SIT7 = ["平台自动退款", "退件标注", "未揽收拦截", "途中拦截", "运单未达", "退件中转（空包）", "缺少物流"];
  const sitBoot = await page.evaluate(() => ({
    opts: [...document.querySelectorAll("#category option")].map((o) => o.value),
    couriers: [...document.querySelectorAll("#courier option")].map((o) => o.value),
    box: (document.getElementById("optSituations") || {}).value || "",
    boxes: ["optCouriers", "optSituations", "optHandlings", "optResults"].filter((id) => document.getElementById(id)).length,
    hasTrack: !!document.getElementById("trackingNo"),
  }));
  check("异常单：情况选项出厂默认 = 台账里那 7 种（开头还有个「待选」）",
    JSON.stringify(sitBoot.opts) === JSON.stringify([""].concat(SIT7)), sitBoot.opts.join("/"));
  check("异常单：快递公司下拉出厂默认 申通/中通/圆通（同样带「待选」）",
    JSON.stringify(sitBoot.couriers) === JSON.stringify(["", "申通", "中通", "圆通"]), sitBoot.couriers.join("/"));
  check("异常单：设置页有四个选项编辑框（快递公司/情况/处理方式/结果）",
    sitBoot.boxes === 4 && sitBoot.box === SIT7.join("\n"), JSON.stringify(sitBoot));
  check("异常单：登记表单有「快递单号」这一格", sitBoot.hasTrack === true, String(sitBoot.hasTrack));

  // ② 改情况选项 → 保存 → 登记下拉立刻更新 → 刷新后还在
  await page.click("#tab-settings");
  await page.waitForTimeout(400);
  await page.fill("#optSituations", "缺货\n发错\n客户要求\n其他");
  await page.click("#saveOpts");
  await page.waitForTimeout(600);
  const sitSaved = await page.evaluate(() => ({
    opts: [...document.querySelectorAll("#category option")].map((o) => o.value),
    toast: (document.getElementById("toast") || {}).textContent || "",
  }));
  check("异常单：保存后登记下拉立刻换成新选项（「待选」还在最前面）",
    JSON.stringify(sitSaved.opts) === JSON.stringify(["", "缺货", "发错", "客户要求", "其他"]),
    sitSaved.opts.join("/"));
  check("异常单：保存完说清四组各存了几个", /情况 4 个/.test(sitSaved.toast), sitSaved.toast);

  await openStandalone("abnormal-ticket", "file");
  await page.click("#tab-settings");
  await page.waitForTimeout(400);
  const sitReload = await page.evaluate(() => ({
    box: (document.getElementById("optSituations") || {}).value || "",
    opts: [...document.querySelectorAll("#category option")].map((o) => o.value),
  }));
  check("异常单：情况选项刷新后还在（独立态落 localStorage）",
    sitReload.box === "缺货\n发错\n客户要求\n其他" &&
      JSON.stringify(sitReload.opts) === JSON.stringify(["", "缺货", "发错", "客户要求", "其他"]),
    JSON.stringify(sitReload));

  // ③ 快递单号 + 快递公司 + 发货时间：登记一条（店选六店、情况选发错、快递单号带空格要清掉）
  await page.click("#tab-create");
  await page.waitForTimeout(400);
  await page.fill("#title", "0.6.0 冒烟：包裹丢了");
  await page.fill("#orderSn", "261011-777000777000777");
  await page.fill("#trackingNo", "SF 9988776655 ");
  await page.evaluate(() => document.getElementById("trackingNo").blur());
  await page.waitForTimeout(200);
  const tracked = await page.evaluate(() => document.getElementById("trackingNo").value);
  check("异常单：快递单号里的空格失焦时被清掉", tracked === "SF9988776655", tracked);
  await page.selectOption("#store", "拼多多6店");
  await page.selectOption("#courier", "中通");
  await page.fill("#shipped", "2026-10-01");
  await page.selectOption("#category", "发错");
  await page.click("#add");
  await page.waitForTimeout(800);

  await page.click("#tab-browse");
  await page.waitForTimeout(500);
  const trackedDetail = await page.evaluate(() => {
    const dts = [...document.querySelectorAll("#detail .kv dt")].map((d) => d.textContent);
    const dd = [...document.querySelectorAll("#detail .kv dd")].map((d) => d.textContent);
    const row = document.querySelector('.ticket[aria-selected="true"]');
    return {
      dts, dd,
      sn: dd[0], track: dd[1], courier: dd[2], shipped: dd[3], cat: dd[4],
      store: (document.getElementById("d-store") || {}).value || "",
      tag: row ? (row.querySelector(".store-tag") || {}).textContent || "" : "",
      cTag: row ? (row.querySelector(".courier-tag") || {}).textContent || "" : "",
      catTag: row ? (row.querySelector(".cat-tag") || {}).textContent || "" : "",
    };
  });
  check("异常单：详情 kv 顺序 = 订单号→快递单号→快递公司→登记时间→情况→录入时间（对齐台账；店铺在快捷行，不重复摆）",
    trackedDetail.dts.join("/") === "订单号/快递单号/快递公司/登记时间/情况/录入时间/最近更新" &&
      trackedDetail.sn === "261011-777000777000777" && trackedDetail.store === "拼多多6店" &&
      trackedDetail.track === "SF9988776655" && trackedDetail.courier === "中通" &&
      trackedDetail.shipped === "2026-10-01" && trackedDetail.cat === "发错",
    JSON.stringify(trackedDetail));
  check("异常单：列表行里挂着 店铺 / 快递公司 / 情况 三个小标签",
    trackedDetail.tag === "拼多多6店" && trackedDetail.cTag === "中通" && trackedDetail.catTag === "发错",
    JSON.stringify(trackedDetail));

  // ④ 重复单号：实时提示 + 第一次点「登记」被拦 + 再点一次才录
  await page.click("#tab-create");
  await page.waitForTimeout(400);
  await page.fill("#orderSn", "261011-777000777000777");
  await page.waitForTimeout(350);
  const dupHint = await page.evaluate(() => (document.getElementById("snHint") || {}).innerHTML || "");
  check("异常单：同一个订单号再输一遍，当场提示已登记过（带「去看那条」）",
    /已经登记过/.test(dupHint) && /去看那条/.test(dupHint), dupHint.slice(0, 90));

  await page.fill("#title", "0.6.0 冒烟：重复的不该随手录");
  const countBefore = await page.evaluate(() => document.querySelectorAll("#list .ticket").length);
  await page.click("#add");
  await page.waitForTimeout(400);
  const blocked = await page.evaluate(() => ({
    n: document.querySelectorAll("#list .ticket").length,
    toast: (document.getElementById("toast") || {}).textContent || "",
    hint: (document.getElementById("snHint") || {}).innerHTML || "",
  }));
  check("异常单：第一次点「登记」被拦下（没多出记录，toast 说清）",
    blocked.n === countBefore && /已经登记过/.test(blocked.toast), JSON.stringify({ before: countBefore, ...blocked, hint: undefined }));
  check("异常单：拦下后提示条里多一句「再点一次」", /再点一次/.test(blocked.hint), blocked.hint.slice(0, 120));

  await page.click("#add");
  await page.waitForTimeout(800);
  const forced = await page.evaluate(() => ({
    n: document.querySelectorAll("#list .ticket").length,
    toast: (document.getElementById("toast") || {}).textContent || "",
  }));
  check("异常单：再点一次才真录进去（确实要录两条的通道留着）",
    forced.n === countBefore + 1 && /已登记/.test(forced.toast), JSON.stringify(forced));

  // ⑤ 「去看那条」：用**真实点击**回归（失焦重绘会换掉 <a>，坐标点击就落空了 —— 踩过）
  await page.fill("#orderSn", "261011-777000777000777");
  await page.waitForTimeout(350);
  const jumpId = await page.evaluate(() =>
    (document.querySelector('#snHint a[data-act="jump-dup"]') || {}).getAttribute
      ? document.querySelector('#snHint a[data-act="jump-dup"]').getAttribute("data-id")
      : "");
  await page.click('#snHint a[data-act="jump-dup"]');
  await page.waitForTimeout(600);
  const jumped = await page.evaluate(() => ({
    browseVisible: !document.getElementById("view-browse").hidden,
    selCount: document.querySelectorAll('.ticket[aria-selected="true"]').length,
    selId: (document.querySelector('.ticket[aria-selected="true"]') || {}).getAttribute
      ? document.querySelector('.ticket[aria-selected="true"]').getAttribute("data-id") : "",
  }));
  check("异常单：真实点击「去看那条」能跳到查看页并选中那条",
    jumped.browseVisible === true && jumped.selCount === 1 && jumped.selId === jumpId,
    JSON.stringify({ jumpId, ...jumped }));

  // ⑥ 筛选：店铺 / 情况（选项 = 配置 ∪ 单子上实际出现过的）
  const filterOpts = await page.evaluate(() => ({
    stores: [...document.querySelectorAll("#storeFilter option")].map((o) => o.value),
    cats: [...document.querySelectorAll("#catFilter option")].map((o) => o.value),
  }));
  check("异常单：店铺筛选列出店铺表里的店（还有「全部店铺」）",
    filterOpts.stores[0] === "" && filterOpts.stores.indexOf("拾野") >= 0 &&
      filterOpts.stores.indexOf("拼多多6店") >= 0,
    filterOpts.stores.join("/"));
  check("异常单：情况筛选含配置里的新选项（客户要求 没人用过也在）",
    filterOpts.cats[0] === "" && filterOpts.cats.indexOf("客户要求") >= 0 &&
      filterOpts.cats.indexOf("发错") >= 0,
    filterOpts.cats.join("/"));

  async function filterCounts() {
    return page.evaluate(() => ({
      n: document.querySelectorAll("#list .ticket").length,
      tags: [...document.querySelectorAll("#list .ticket .store-tag")].map((t) => t.textContent),
    }));
  }
  await page.selectOption("#catFilter", "发错");
  await page.waitForTimeout(350);
  const byCat = await filterCounts();
  check("异常单：按情况筛选只留发错那两条", byCat.n === 2, JSON.stringify(byCat));
  await page.selectOption("#catFilter", "客户要求");
  await page.waitForTimeout(350);
  const byNone = await filterCounts();
  check("异常单：筛一个没人用过的选项 → 空列表（不是全量）", byNone.n === 0, String(byNone.n));

  await page.selectOption("#catFilter", "");
  await page.selectOption("#storeFilter", "拼多多6店");
  await page.waitForTimeout(350);
  const byStore = await filterCounts();
  check("异常单：按店铺筛选只留那个店的单（行内标签全是它）",
    byStore.n === 2 && byStore.tags.length === 2 && byStore.tags.every((t) => t === "拼多多6店"),
    JSON.stringify(byStore));
  await page.selectOption("#storeFilter", "");
  await page.waitForTimeout(350);

  /* ---------- 0.6.1：登记界面理顺（去掉单独的「ERP 链接」框、字段加标签） ----------
     用户点了两件事：登记页那个专门的「ERP 链接」框去掉；登记界面整体理顺。
     ★ 标签为什么是硬要求：填了值之后 placeholder 就没了，8 个字段排在一起时
     只能靠位置去猜"这格是什么" —— 那最容易填错，所以标签得一直看得见。 */
  await page.click("#tab-create");
  await page.waitForTimeout(400);
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll("#create-card .f > :first-child")].map((s) => s.textContent.trim()));
  check("异常单：登记页字段 = 台账有的那些（店铺/订单号/快递单号/快递公司/登记时间/情况/描述），旧字段不再摆出来",
    JSON.stringify(labels) === JSON.stringify(["店铺", "订单号", "快递单号", "快递公司", "登记时间", "情况", "详细描述"]),
    labels.join("/"));

  await page.fill("#orderSn", "261011-597950502412841");
  const labelAfter = await page.evaluate(() => {
    const lab = document.getElementById("orderSn").closest("label.f");
    return lab ? lab.querySelector("span").textContent.trim() : "(没有标签)";
  });
  check("异常单：填了值之后字段标签还在（说明不靠 placeholder 撑着）",
    labelAfter === "订单号", labelAfter);

  /* ---------- 0.9.0：登记页自适应宽度 + 灰色的「待选」 ----------
     用户提的三件事：① 卡片不许写死宽度，窗口多宽就多宽；② 「（没选）」改「待选」、灰字；
     ③ 「订单发货时间」改名「登记时间」；④ 界面太单调（分组 + 卡片头 + 今日条数）。
     ① 的判据必须量**两个视口下的实际宽度**：只查 CSS 里有没有 max-width 会被别的规则骗过。 */
  const widths = [];
  for (const w of [1024, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    widths.push(await page.evaluate(() => Math.round(document.getElementById("create-card").getBoundingClientRect().width)));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);
  check("异常单：登记卡片跟着窗口宽度走（1024→1440 宽出 ≥380px，不是写死的 880）",
    widths[1] - widths[0] >= 380 && widths[0] > 900,
    JSON.stringify(widths));

  await page.selectOption("#courier", "");   // 前面登记时选过「中通」，卡片不清空 —— 先归零再看空态
  await page.waitForTimeout(200);
  const selState = await page.evaluate(() => {
    const c = document.getElementById("courier");
    const cat = document.getElementById("category");
    // --dim 的实际 rgb：借一个临时节点问浏览器，别把颜色值抄进断言（改主题就假红）
    const probe = document.createElement("span");
    probe.style.color = "var(--dim)";
    document.body.appendChild(probe);
    const dimRgb = getComputedStyle(probe).color;
    probe.remove();
    return {
      text: c.options[0].textContent.trim(),
      empty: c.classList.contains("is-empty"),
      // 情况那格前面选过值 —— 它**不能**跟着灰（灰只属于空的那格）
      catFilledNotGray: !cat.classList.contains("is-empty") && cat.value !== "",
      color: getComputedStyle(c).color,
      dimRgb,
    };
  });
  check("异常单：空下拉写的是「待选」、整个控件变灰；已填的那格不跟着灰",
    selState.text === "待选" && selState.empty && selState.catFilledNotGray &&
      selState.color === selState.dimRgb,
    JSON.stringify(selState));

  await page.selectOption("#courier", "中通");
  await page.waitForTimeout(200);
  const selAfter = await page.evaluate(() => ({
    empty: document.getElementById("courier").classList.contains("is-empty"),
    today: (document.getElementById("todayTip") || {}).textContent || "",
  }));
  check("异常单：选完值就不灰了（灰只表示「这格还空着」）",
    selAfter.empty === false, JSON.stringify(selAfter));
  check("异常单：卡片右上角有「今日 N 条」",
    /今日/.test(selAfter.today), selAfter.today);
  await page.selectOption("#courier", "");

  const actions = await page.evaluate(() => {
    const b = document.getElementById("add").getBoundingClientRect();
    const h = document.getElementById("formHint").getBoundingClientRect();
    const sub = (document.querySelector("#create-card .cardsub") || {}).textContent || "";
    return { gap: Math.round(Math.abs(b.top - h.top)), hint: (document.getElementById("formHint") || {}).textContent || "", sub };
  });
  check("异常单：「登记」按钮和那句说明并排，卡片头讲清去哪补处理信息",
    actions.gap < 24 && /处理方式/.test(actions.sub) && /查看/.test(actions.sub), JSON.stringify(actions));

  /* ---------- 0.9.1：日期选择器自己画 ----------
     用户截图里的弹窗是浏览器原生 input[type=date] 的 —— 字体/圆角/选中色
     都不跟主题走，换月还只有一对上下箭头。判据不能只看"有没有日历"：
     ① 输入框已经不是 type=date；② 面板出现在视口里；③ 点日期真能改值；
     ④ 月份标题能进「年月」视图；⑤ 手敲 8 位数字回车能规范化。 */
  await page.fill("#shipped", "2026-10-17");
  await page.click("#dpBtn");
  await page.waitForTimeout(250);
  const dpOpen = await page.evaluate(() => {
    const dp = document.getElementById("dp");
    const r = dp.getBoundingClientRect();
    const selEl = dp.querySelector(".dp-day.is-sel");
    return {
      hidden: dp.hidden,
      type: document.getElementById("shipped").type,
      title: document.getElementById("dpTitle").textContent.replace(/\s+/g, " ").trim(),
      week: [...dp.querySelectorAll(".dp-week span")].map((x) => x.textContent).join(""),
      sel: selEl ? selEl.dataset.d : "",
      dayCount: dp.querySelectorAll(".dp-day").length,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    };
  });
  check("异常单：日期弹窗换成了自绘面板（不再用 input[type=date]，面板在视口内、固定 42 格）",
    dpOpen.hidden === false && dpOpen.type === "text" && dpOpen.inView && dpOpen.dayCount === 42,
    JSON.stringify(dpOpen));
  check("异常单：日历标题写「2026 年 10 月」、周一开始、17 号是选中态",
    /2026\s*年\s*10\s*月/.test(dpOpen.title) && dpOpen.week === "一二三四五六日" &&
      dpOpen.sel === "2026-10-17",
    JSON.stringify(dpOpen));

  await page.click('#dp .dp-day[data-d="2026-10-05"]');
  await page.waitForTimeout(200);
  const dpPick = await page.evaluate(() => ({
    v: document.getElementById("shipped").value,
    hidden: document.getElementById("dp").hidden,
  }));
  check("异常单：点日历里的 5 号 → 输入框变 2026-10-05，面板自动收起",
    dpPick.v === "2026-10-05" && dpPick.hidden === true, JSON.stringify(dpPick));

  await page.click("#dpBtn");
  await page.waitForTimeout(150);
  await page.click("#dpTitle");
  await page.waitForTimeout(150);
  const dpMonths = await page.evaluate(() => ({
    n: document.querySelectorAll("#dp .dp-mon").length,
    daysHidden: document.getElementById("dpDays").hidden,
    title: document.getElementById("dpTitle").textContent.replace(/\s+/g, " ").trim(),
    mode: document.getElementById("dp").dataset.mode,
    selMonth: (document.querySelector("#dp .dp-mon.is-sel") || {}).textContent || "",
  }));
  check("异常单：点月份标题进「年月」视图（标题只剩年份、12 个月、当前月高亮）",
    dpMonths.n === 12 && dpMonths.daysHidden === true && dpMonths.mode === "month" &&
      /^2026\s*年$/.test(dpMonths.title) && dpMonths.selMonth.trim() === "10 月",
    JSON.stringify(dpMonths));

  await page.click('#dp .dp-mon[data-m="3"]');
  await page.waitForTimeout(200);
  const dpMar = await page.evaluate(() => {
    const first = document.querySelector("#dp .dp-day");
    return {
      title: document.getElementById("dpTitle").textContent.replace(/\s+/g, " ").trim(),
      first: first ? first.dataset.d : "",
      daysHidden: document.getElementById("dpDays").hidden,
      monthsHidden: document.getElementById("dpMonths").hidden,
      hasOut: !!document.querySelector("#dp .dp-day.is-out"),
    };
  });
  check("异常单：选了 3 月 → 日视图从 2026-02-23（周一）起排，前后月用淡色补格",
    /2026\s*年\s*3\s*月/.test(dpMar.title) && dpMar.first === "2026-02-23" &&
      dpMar.daysHidden === false && dpMar.monthsHidden === true && dpMar.hasOut === true,
    JSON.stringify(dpMar));

  await page.click('#dp .dp-day[data-d="2026-03-10"]');
  await page.waitForTimeout(150);

  await page.click("#dpBtn");
  await page.click('#dp .dp-link[data-quick="0"]');
  await page.waitForTimeout(120);
  const d0 = new Date();
  const ymd = (x) => x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  const quickToday = await page.evaluate(() => document.getElementById("shipped").value);
  await page.click("#dpBtn");
  await page.click('#dp .dp-link[data-quick="-1"]');
  await page.waitForTimeout(120);
  const quickYest = await page.evaluate(() => document.getElementById("shipped").value);
  check("异常单：「今天 / 昨天」一键落值（补录最常用的两个入口）",
    quickToday === ymd(d0) && quickYest === ymd(new Date(d0.getTime() - 864e5)),
    JSON.stringify({ quickToday, quickYest }));

  await page.fill("#shipped", "20261009");
  await page.press("#shipped", "Enter");
  await page.waitForTimeout(120);
  const dpNorm = await page.evaluate(() => document.getElementById("shipped").value);
  check("异常单：手敲 8 位数字回车就规范成 2026-10-09", dpNorm === "2026-10-09", dpNorm);

  await page.fill("#shipped", "2026-02-31");
  await page.press("#shipped", "Enter");
  await page.waitForTimeout(120);
  const dpBad = await page.evaluate(() => ({
    v: document.getElementById("shipped").value,
    bad: document.getElementById("shipped").classList.contains("is-bad"),
  }));
  check("异常单：不存在的日期（2 月 31 日）退回上一个合法值并标红",
    dpBad.v === "2026-10-09" && dpBad.bad === true, JSON.stringify(dpBad));

  await page.fill("#shipped", "2026-10-17");
  await page.press("#shipped", "ArrowDown");
  await page.waitForTimeout(150);
  await page.press("#shipped", "ArrowRight");
  await page.waitForTimeout(150);
  const dpKey = await page.evaluate(() => ({
    v: document.getElementById("shipped").value,
    open: !document.getElementById("dp").hidden,
  }));
  check("异常单：↓ 开日历、→ 挪一天并同步到输入框（不用鼠标也能选）",
    dpKey.v === "2026-10-18" && dpKey.open === true, JSON.stringify(dpKey));
  await page.press("#shipped", "Escape");
  await page.waitForTimeout(120);
  const dpEsc = await page.evaluate(() => document.getElementById("dp").hidden);
  check("异常单：Esc 收起日历", dpEsc === true, String(dpEsc));
  await page.fill("#shipped", "2026-10-01");   // 还原给后面的登记节用


  /* ---------- 0.7.0：两个单号都空要拦下 ----------
     台账上每条至少挂着快递单号或订单号之一 —— 全空的基本是误触。 */
  const emptyBefore = await page.evaluate(() => document.querySelectorAll("#list .ticket").length);
  await page.fill("#orderSn", "");       // 上一步的标签断言把订单号框填过了，先清干净
  await page.fill("#trackingNo", "");
  await page.click("#add");
  await page.waitForTimeout(400);
  const emptyBlocked = await page.evaluate(() => ({
    n: document.querySelectorAll("#list .ticket").length,
    toast: (document.getElementById("toast") || {}).textContent || "",
  }));
  check("异常单：订单号、快递单号都空时「登记」被拦下",
    emptyBlocked.n === emptyBefore && /至少填一个/.test(emptyBlocked.toast),
    JSON.stringify(emptyBlocked));

  /* ---------- 列表行：长单号（22 字符带连字符）不许折成两行 ----------
     用户反馈：一条 `261011-597950502412841` 在列表里被折成两行、行被撑高。
     根因是单号里的连字符 —— 浏览器默认会在 `-` 之后断行，不是宽度不够那么简单。
     修法：单号 nowrap（外加省略号兜底），并把状态标签挪到第二行给它让出整行。 */
  await page.fill("#orderSn", "261011-597950502412841");     // 0.7.0：code 框没了，订单号本身就是那串长号
  await page.fill("#title", "长编号一行回归");
  await page.click("#add");
  await page.waitForTimeout(800);
  await page.click("#tab-browse");
  await page.waitForTimeout(500);
  const longRow = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".ticket")].find((x) => {
      const c = x.querySelector(".code");
      return c && c.textContent.trim() === "261011-597950502412841";
    });
    if (!t) return { found: false };
    const c = t.querySelector(".code");
    const badge = t.querySelector(".badge");
    return {
      found: true,
      codeH: Math.round(c.getBoundingClientRect().height),
      l1H: Math.round(t.querySelector(".l1").getBoundingClientRect().height),
      badge: badge ? badge.textContent : "(没有)",
      badgeInTitle: !!(badge && badge.parentElement && badge.parentElement.className === "title"),
    };
  });
  check("异常单：长编号（22 字符带连字符）在列表里占一整行，不会折成两行",
    longRow.found === true && longRow.codeH < 26, JSON.stringify(longRow));
  check("异常单：状态标签挪到了第二行（给单号让出整行）",
    longRow.badge === "待处理" && longRow.badgeInTitle === true, JSON.stringify(longRow));

  /* ---------- 0.8.0：流程状态（名称 + 时间的步骤轨迹） ----------
     状态 = 最后一步的名称；一条流程都没记时仍走派生（0.7.0 的老规矩，
     所以 add() 不自动种流程 —— 种了就永远压住派生状态）。走一遍：
     空手记一步被拦 → 记两步徽标跟随 → 删步 → 全删光徽标回退派生。 */
  await page.click("#tab-create");
  await page.waitForTimeout(300);
  await page.fill("#orderSn", "261012-800000000000001");
  await page.fill("#title", "流程状态回归");
  await page.click("#add");
  await page.waitForTimeout(800);
  await page.click("#tab-browse");
  await page.waitForTimeout(400);
  // 选中是记忆式的：重复检测段「跳转」过别的单子，selectedId 还停在它身上 ——
  // 显式点中刚登记的这条再开始断言
  const demoId = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".ticket")].find(
      (r) => (r.querySelector(".code") || {}).textContent === "261012-800000000000001",
    );
    return row ? row.getAttribute("data-id") : "";
  });
  if (!demoId) throw new Error("示例单没登记上（列表里找不到 261012-800000000000001）");
  await page.click(`.ticket[data-id="${demoId}"]`);
  await page.waitForTimeout(400);
  const flowStart = await page.evaluate(() => ({
    code: (document.querySelector('.ticket[aria-selected="true"] .code') || {}).textContent || "",
    badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
    steps: document.querySelectorAll("#detail .flow-step").length,
    empty: ((document.querySelector("#detail .flow-empty") || {}).textContent || "").length > 0,
  }));
  check("异常单：没记过流程时徽标仍走派生（待处理），流程不自动种",
    flowStart.code === "261012-800000000000001" && flowStart.badge === "待处理" &&
      flowStart.steps === 0 && flowStart.empty === true, JSON.stringify(flowStart));

  // 名称没选就点「记录一步」→ 拦下（名称必选，防止误记一步脏轨迹）
  await page.click('#detail button[data-act="flow-add"]');
  await page.waitForTimeout(400);
  const flowNoName = await page.evaluate(() => ({
    steps: document.querySelectorAll("#detail .flow-step").length,
    toast: (document.getElementById("toast") || {}).textContent || "",
  }));
  check("异常单：流程名称没选时「记录一步」被拦下",
    flowNoName.steps === 0 && /先选一步名称/.test(flowNoName.toast), JSON.stringify(flowNoName));

  // 记第一步：选「已联系快递」，时刻默认现在
  await page.selectOption("#flowName", "已联系快递");
  await page.click('#detail button[data-act="flow-add"]');
  await page.waitForTimeout(500);
  const step1 = await page.evaluate(() => ({
    n: document.querySelectorAll("#detail .flow-step").length,
    cur: ((document.querySelector("#detail .flow-step.cur .flow-name") || {}).textContent || "").trim(),
    time: ((document.querySelector("#detail .flow-step.cur .flow-time") || {}).textContent || "").trim(),
    badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
    rowBadge: (document.querySelector(".ticket[aria-selected=\"true\"] .badge") || {}).textContent || "",
  }));
  check("异常单：记一步后流程列表出现这一步（标「当前」），头顶徽标跟着走",
    step1.n === 1 && step1.cur === "已联系快递 · 当前" && step1.badge === "已联系快递",
    JSON.stringify(step1));
  check("异常单：每一步都带时间，列表行的徽标同步",
    step1.time.length > 0 && step1.rowBadge === "已联系快递", JSON.stringify(step1));

  // 再记一步：状态推进
  await page.selectOption("#flowName", "平台申诉中");
  await page.click('#detail button[data-act="flow-add"]');
  await page.waitForTimeout(500);
  const step2 = await page.evaluate(() => ({
    n: document.querySelectorAll("#detail .flow-step").length,
    cur: ((document.querySelector("#detail .flow-step.cur .flow-name") || {}).textContent || "").trim(),
    badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
  }));
  check("异常单：再记一步，当前状态推进到平台申诉中",
    step2.n === 2 && step2.cur === "平台申诉中 · 当前" && step2.badge === "平台申诉中", JSON.stringify(step2));

  // 删步：先删掉第一步（轨迹剩最后一步、状态不变），再删光（徽标回退派生）
  await page.click('#detail .flow-del[data-idx="0"]');
  await page.waitForTimeout(500);
  const stepDel1 = await page.evaluate(() => ({
    n: document.querySelectorAll("#detail .flow-step").length,
    cur: ((document.querySelector("#detail .flow-step.cur .flow-name") || {}).textContent || "").trim(),
  }));
  check("异常单：删掉前面的步，剩下的仍是轨迹，状态不跟着变",
    stepDel1.n === 1 && stepDel1.cur === "平台申诉中 · 当前", JSON.stringify(stepDel1));
  await page.click('#detail .flow-del[data-idx="0"]');
  await page.waitForTimeout(500);
  const stepDel2 = await page.evaluate(() => ({
    n: document.querySelectorAll("#detail .flow-step").length,
    empty: ((document.querySelector("#detail .flow-empty") || {}).textContent || "").length > 0,
    badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
  }));
  check("异常单：流程全删掉后徽标回退到派生状态（待处理）",
    stepDel2.n === 0 && stepDel2.empty === true && stepDel2.badge === "待处理", JSON.stringify(stepDel2));

  /* ---------- 0.8.2：流程的收尾步固定是「完结」 ----------
     它不是普通一步而是终点：下拉里恒在最后一项（不跟配置走），记上就封口 ——
     录入行收起、不能再加步；要继续先删掉它。 */
  await page.selectOption("#flowName", "平台申诉中");
  await page.click('#detail button[data-act="flow-add"]');
  await page.waitForTimeout(400);
  const finOpts = await page.evaluate(() => {
    const o = [...document.querySelectorAll("#flowName option")].map((x) => x.value).filter(Boolean);
    return { last: o[o.length - 1], hasResolved: o.indexOf("已解决") >= 0 };
  });
  check("异常单：「完结」恒在流程下拉的最后一项，旧的「已解决」不再摆出来",
    finOpts.last === "完结" && finOpts.hasResolved === false, JSON.stringify(finOpts));

  await page.selectOption("#flowName", "完结");
  await page.click('#detail button[data-act="flow-add"]');
  await page.waitForTimeout(500);
  const fin = await page.evaluate(() => {
    const row = document.querySelector('.ticket[aria-selected="true"]');
    return {
      n: document.querySelectorAll("#detail .flow-step").length,
      cur: ((document.querySelector("#detail .flow-step.cur .flow-name") || {}).textContent || "").trim(),
      fin: document.querySelectorAll("#detail .flow-step.fin").length,
      badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
      closed: !!document.querySelector("#detail .flow-closed"),
      noInput: !document.getElementById("flowName"),
      struck: row ? row.className.indexOf("s-done") >= 0 : false,
    };
  });
  check("异常单：记上「完结」= 收尾（标「收尾」、状态=完结、归进已关闭）",
    fin.n === 2 && fin.cur === "完结 · 收尾" && fin.fin === 1 && fin.badge === "完结" &&
      fin.struck === true, JSON.stringify(fin));
  check("异常单：完结后录入行收起（不许再往封口的单子上加步）",
    fin.closed === true && fin.noInput === true, JSON.stringify(fin));

  // 删掉「完结」→ 开口，录入行回来、状态退回上一步
  await page.click('#detail .flow-del[data-idx="1"]');
  await page.waitForTimeout(500);
  const reopen = await page.evaluate(() => ({
    n: document.querySelectorAll("#detail .flow-step").length,
    cur: ((document.querySelector("#detail .flow-step.cur .flow-name") || {}).textContent || "").trim(),
    badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
    hasInput: !!document.getElementById("flowName"),
    closed: !!document.querySelector("#detail .flow-closed"),
  }));
  check("异常单：删掉「完结」后重新开口（录入行回来、状态退回平台申诉中）",
    reopen.n === 1 && reopen.cur === "平台申诉中 · 当前" && reopen.badge === "平台申诉中" &&
      reopen.hasInput === true && reopen.closed === false, JSON.stringify(reopen));
  await page.click('#detail .flow-del[data-idx="0"]');
  await page.waitForTimeout(400);

  /* ---------- 0.8.0：提醒块只在宿主里出现 ----------
     设定提醒 = 向工作台订一条带来源标记的待办（task.remind）。
     独立打开没有宿主可订 —— 整块藏掉（data-host-only），不是灰着解释。 */
  const remindBlk = await page.evaluate(() => {
    const sect = document.querySelector("#detail .sect[data-host-only]");
    if (!sect) return { present: false };
    return {
      present: true,
      display: getComputedStyle(sect).display,
      hasSet: !!sect.querySelector('[data-act="remind-set"]'),
      hint: ((sect.querySelector("#remindHint") || {}).textContent || "").slice(0, 50),
    };
  });
  check("异常单：提醒块在独立打开时整个藏掉（display:none，不是灰着）",
    remindBlk.present === true && remindBlk.display === "none" && remindBlk.hasSet === true,
    JSON.stringify(remindBlk));

  await wipeLocal("abnormal-ticket");

  await expectCommon("abnormal-ticket", "异常单号", "http");
}

/* ==================================================================
 * 7. 深浅色：独立打开时跟系统走
 *
 * 独立态没有宿主推主题，只能看 prefers-color-scheme。这里强制两种配色
 * 各开一遍，然后**按面积**算底色到底翻没翻过来 ——
 * 「半深半浅」这种事看截图很容易漏（尤其是边框、分隔线这种细东西），
 * 按面积算百分比反而抓得准。
 *
 * 判据是两头的占比，不是具体色值：色值会随设计变，占比不会。
 * ================================================================== */
console.log("\n=== 7. 深浅色（独立打开跟系统走）===");

// THEME_TOOLS 从 tests/tool-registry.mjs 来 —— 加内置工具时那里会由
// `npm run tool:new` 一并补上，`npm run tool:audit` 再拿它与 tools/ 对账。
// 写在这里时它是一份手抄清单，漏一个工具就等于那个工具的深浅色没人盯。

/**
 * 按面积统计页面上不透明底色的明暗占比。
 * bright 里只收**大块**（>4000px²）的亮色元素：小面积的亮色是合法的，
 * 比如尺码表里那个"成品颜色预览"的小方块 —— 它显示的是用户给表格选的
 * 颜色（数据），不是界面底色，本来就不该跟着主题变暗。
 */
function colorStats() {
  return page.evaluate(() => {
    const lum = (s) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)/.exec(s || "");
      if (!m) return null;
      const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (a < 0.5) return null;               // 半透明的（蒙层、阴影）不算
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
    };
    let light = 0;
    let dark = 0;
    let total = 0;
    let n = 0;
    const bright = [];
    for (const el of document.querySelectorAll("*")) {
      if (++n > 6000) break;
      const L = lum(getComputedStyle(el).backgroundColor);
      if (L === null) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, r.width * r.height);
      total += area;
      if (L > 0.6) {
        light += area;
        if (area > 4000) bright.push(`${el.id || el.className || el.tagName.toLowerCase()}(${Math.round(area)})`);
      } else if (L < 0.3) {
        dark += area;
      }
    }
    const bs = getComputedStyle(document.body);
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      lightPct: total ? light / total : 0,
      darkPct: total ? dark / total : 0,
      bodyBg: bs.backgroundColor,
      bodyTextLum: lum(bs.color),
      bright: bright.slice(0, 4),
    };
  });
}

for (const [id, label] of THEME_TOOLS) {
  await page.emulateMedia({ colorScheme: "light" });
  await openStandalone(id, "file");
  const lt = await colorStats();
  check(`${label} [浅色]：界面是浅的`, lt.lightPct >= 0.9, `浅色面积 ${(lt.lightPct * 100).toFixed(1)}%`);
  check(`${label} [浅色]：html[data-theme] 没落成 dark`, lt.theme !== "dark", String(lt.theme));

  await page.emulateMedia({ colorScheme: "dark" });
  await openStandalone(id, "file");
  const dk = await colorStats();
  check(`${label} [深色]：html[data-theme] 落到 dark`, dk.theme === "dark", String(dk.theme));
  check(`${label} [深色]：底色翻过来了（深色面积 ≥90%）`, dk.darkPct >= 0.9,
    `深色面积 ${(dk.darkPct * 100).toFixed(1)}%`);
  check(`${label} [深色]：没有大块漏白的元素`, dk.bright.length === 0, JSON.stringify(dk.bright));
  check(`${label} [深色]：正文色也跟着变浅`, (dk.bodyTextLum || 0) > 0.5, `亮度 ${dk.bodyTextLum}`);
  info(`${label} 底色`, `${lt.bodyBg} → ${dk.bodyBg}`);
}
await page.emulateMedia({ colorScheme: "light" });

/* ---------------- 汇总 ---------------- */
await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n${"=".repeat(56)}`);
if (failed) {
  console.log(`独立运行体检：${passed} 通过 / ${failed} 失败`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`独立运行体检：${passed} 项全部通过`);
