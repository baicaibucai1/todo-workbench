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

  // 只填内容与订单号，单号留空 —— 该自动生成 YC-<当日>-<三位序号>
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
    codeHint: document.getElementById("codeHint").textContent,
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
  check("异常单：单号按格式自动生成", /^YC-\d{8}-\d{3}$/.test(list.code), list.code);
  check("异常单：新登记的默认是「待处理」", list.badge === "待处理", list.badge);
  check("异常单：统计条跟着动了", /待处理\s*1/.test(list.stats), list.stats);
  check("异常单：副标题说清了数据存在浏览器里", /浏览器|localStorage/.test(list.meta), list.meta);

  /* ---------- 右栏：详情 + 处理区 ---------- */
  const detail = await page.evaluate(() => ({
    code: (document.querySelector("#detail .d-code") || {}).textContent || "",
    title: (document.querySelector("#detail .d-title") || {}).textContent || "",
    hasNote: !!document.getElementById("d-note"),
    act: (document.querySelector('#detail button[data-act="advance"]') || {}).textContent || "",
    selCount: document.querySelectorAll('.ticket[aria-selected="true"]').length,
  }));
  check("异常单：右栏默认选中第一条并显示它的详情",
    detail.code === list.code && /来料尺寸超差/.test(detail.title), JSON.stringify(detail));
  check("异常单：左栏那一行被标成选中态", detail.selCount === 1, String(detail.selCount));
  check("异常单：右栏有处理区（处理情况输入框）", detail.hasNote === true, String(detail.hasNote));
  check("异常单：处理按钮文字跟着状态走", detail.act === "开始处理", detail.act);

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
      kv: (document.querySelectorAll("#detail .kv dd")[1] || {}).textContent || "",
    };
  });
  check("异常单：右栏换店铺后链接跟着换、kv 里的店铺也改过来了",
    backTo1.url === "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_355831479&ordersn=261011-442394294633154" &&
      backTo1.kv === "拼多多5店", JSON.stringify(backTo1));

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

  /* ---------- 粘 ERP 链接 ----------
   * ★ 客服 ID 是 ERP 生成的，用户没法凭空知道 —— 所以正门是"把 ERP 给的那条
   * 链接粘进来"，从里面抠 mallcsid / ordersn，而不是让人去填一个看不出所以然的 ID。
   * 三条路径都要验：认得出来（表里已有）、不认识（填进空行）、粘错了。 */
  await page.click("#tab-create");
  await page.waitForTimeout(400);
  const ERP1 = "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_999999999&ordersn=261011-648659679643144";
  await page.fill("#erpLink", ERP1);
  await page.waitForTimeout(800);
  const hitKnown = await page.evaluate(() => ({
    hint: (document.getElementById("erpHint") || {}).textContent || "",
    cls: (document.getElementById("erpHint") || {}).className || "",
    sn: document.getElementById("orderSn").value,
    store: document.getElementById("store").value,
  }));
  check("异常单：粘已知店铺的 ERP 链接，订单号和店铺一起认出来",
    hitKnown.sn === "261011-648659679643144" && hitKnown.store === "拾野" && /\bok\b/.test(hitKnown.cls),
    JSON.stringify(hitKnown));

  const ERP2 = "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_800000007&ordersn=261011-362765391472941";
  await page.fill("#erpLink", ERP2);
  await page.waitForTimeout(900);
  const hitNew = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#stores .store-row")];
    return {
      hint: (document.getElementById("erpHint") || {}).textContent || "",
      store: document.getElementById("store").value,
      filled: rows.map((r) => r.querySelector("input.cs").value).filter(Boolean),
      count: rows.length,
    };
  });
  check("异常单：陌生的客服 ID 填进一个空行（不新建、也不动已经绑好的那几个）",
    hitNew.count === 8 && hitNew.filled.length === 4 && hitNew.filled.indexOf("cs_800000007") >= 0,
    JSON.stringify(hitNew));
  check("异常单：认出陌生的 ID 之后说明白了它记到了哪个店",
    /记到了/.test(hitNew.hint) && /cs_800000007/.test(hitNew.hint), hitNew.hint);

  await page.fill("#erpLink", "先填个别的");
  await page.fill("#erpLink", ERP2);
  await page.waitForTimeout(800);
  const again = await page.evaluate(() => ({
    hint: (document.getElementById("erpHint") || {}).textContent || "",
    filled: [...document.querySelectorAll("#stores .store-row input.cs")].map((i) => i.value).filter(Boolean).length,
  }));
  check("异常单：同一个客服 ID 再粘一次是「认出」，不会又加一个店",
    /店铺「/.test(again.hint) && again.filled === 4, JSON.stringify(again));

  await page.fill("#erpLink", "https://example.com/abc");
  await page.waitForTimeout(500);
  const bad = await page.evaluate(() => ({
    hint: (document.getElementById("erpHint") || {}).textContent || "",
    cls: (document.getElementById("erpHint") || {}).className || "",
  }));
  check("异常单：粘的不是 pddim 链接时，说清正确的形状",
    /pddim:sendmsg/.test(bad.hint) && /\bbad\b/.test(bad.cls), JSON.stringify(bad));

  /* ---------- 订单号粘得"脏"一点也要认 ----------
     现实里单号很少是干净的：从聊天 / 表格 / ERP 复制常带全角连字符（－）、
     长短破折号（—–）、看不见的空白（\u00A0 / \u200B）。这些会让形状判定 False，
     界面上只显示一句"格式存疑" —— 而单号其实是对的，用户只会觉得工具在骗他。
     另外整条链接被粘进订单号框也要能把 ordersn 抠出来。 */
  const normCases = [
    ["全角连字符", "261011－597950502412841"],
    ["短破折号", "261011–597950502412841"],
    ["空格 + 看不见的空白", " 261011\u00A0-\u200B597950502412841 "],
    ["整条唤醒链接", "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_355831479&ordersn=261011-597950502412841"],
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

  // 裸订单号粘到「ERP 链接」框：它**有用**，别只回一句"不对"
  await page.fill("#orderSn", "");
  await page.fill("#erpLink", "261011-597950502412841");
  await page.waitForTimeout(400);
  const bareSn = await page.evaluate(() => ({
    hint: (document.getElementById("erpHint") || {}).textContent || "",
    sn: document.getElementById("orderSn").value,
  }));
  check("异常单：把裸订单号粘到「ERP 链接」框，会填进订单号框并说清这框要什么",
    bareSn.sn === "261011-597950502412841" && /订单号，不是唤醒链接/.test(bareSn.hint),
    JSON.stringify(bareSn));
  await page.fill("#erpLink", "");

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
      kv: (document.querySelectorAll("#detail .kv dd")[1] || {}).textContent || "",
      picker: (document.getElementById("d-store") || {}).value || "",
    };
  });
  check("异常单：改客服 ID 后链接跟着变",
    cfg2.title === "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_999999999&ordersn=261011-442394294633154",
    cfg2.title);
  check("异常单：改了店铺名，单子上那条也跟着改了（改名传播）",
    cfg2.kv === "拾野" && cfg2.picker === "拾野", `kv=${cfg2.kv} picker=${cfg2.picker}`);

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
    cfg: (document.querySelector("#stores .store-row:first-child input.name") || {}).value || "",
    cs: (document.querySelector("#stores .store-row:first-child input.cs") || {}).value || "",
    storeRows: document.querySelectorAll("#stores .store-row").length,
  }));
  check("异常单：刷新后单号还在（真的落盘了）",
    afterReload.cards === 1 && afterReload.code === list.code,
    `${afterReload.cards} 张 / ${afterReload.code}`);
  check("异常单：处理情况也还在（备注真的落盘了）",
    /已通知供应商/.test(afterReload.note), afterReload.note.slice(0, 24));
  check("异常单：订单号刷新后也还在（是存进表里的，不是内存）",
    afterReload.hasOrderSn === true, String(afterReload.hasOrderSn));
  check("异常单：改过的店铺表刷新后还在（独立态落 localStorage）",
    afterReload.cfg === "拾野" && afterReload.cs === "cs_999999999" && afterReload.storeRows === 8,
    `${afterReload.storeRows} 行 / ${afterReload.cfg} / ${afterReload.cs}`);

  /* ---------- 状态推进（在右栏处理区点） ---------- */
  await page.click('#detail button[data-act="advance"]');
  await page.waitForTimeout(500);
  const s1 = await page.evaluate(() => (document.querySelector("#detail .d-head .badge") || {}).textContent);
  check("异常单：右栏推进到「处理中」", s1 === "处理中", String(s1));

  await page.click('#detail button[data-act="advance"]');
  await page.waitForTimeout(500);
  const s2 = await page.evaluate(() => {
    const item = document.querySelector(".ticket");
    const btn = document.querySelector('#detail button[data-act="advance"]');
    return {
      badge: (document.querySelector("#detail .d-head .badge") || {}).textContent || "",
      listStruck: item ? item.className.indexOf("s-done") >= 0 : false,
      act: (btn || {}).textContent || "",
      noteKept: (document.getElementById("d-note") || {}).value || "",
    };
  });
  check("异常单：再推进到「已关闭」", s2.badge === "已关闭", s2.badge);
  check("异常单：左栏那一行也跟着变成关闭样式", s2.listStruck === true, String(s2.listStruck));
  check("异常单：关闭后按钮变成「重新打开」", s2.act === "重新打开", s2.act);
  check("异常单：推进状态没有把处理情况弄丢", /已通知供应商/.test(s2.noteKept), s2.noteKept.slice(0, 24));

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
     不要给一个"能点、但点了什么都不发生"的按钮 —— 那比藏起来更难查。 */
  await page.click("#tab-create");
  await page.fill("#title", "没订单号的异常");
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
  await page.fill("#erpLink", "pddim:sendmsg/?OpeId=open_order&mallcsid=cs_999999999&ordersn=261011-109827858042143");
  await page.waitForTimeout(800);
  const beforeAdd = await page.evaluate(() => ({
    sn: document.getElementById("orderSn").value,
    store: document.getElementById("store").value,
  }));
  await page.fill("#title", "ERP 链接流进来的一条");
  await page.click("#add");
  await page.waitForTimeout(800);
  const afterAdd = await page.evaluate(() => ({
    linkCleared: document.getElementById("erpLink").value === "",
    hintCleared: (document.getElementById("erpHint") || {}).textContent === "",
    storeKept: document.getElementById("store").value,
  }));
  check("异常单：从 ERP 链接一路登记下来，店铺留着、链接框清掉（下一条是另一条链接）",
    beforeAdd.sn === "261011-109827858042143" && beforeAdd.store === "拾野" &&
      afterAdd.linkCleared && afterAdd.hintCleared && afterAdd.storeKept === "拾野",
    JSON.stringify({ beforeAdd, afterAdd }));

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

const THEME_TOOLS = [
  ["image-crop", "图片裁剪"],
  ["size-chart", "尺码表"],
  ["scratchpad", "模板"],
  ["notes", "便签"],
  ["ai-gen", "AI 生成"],
  ["abnormal-ticket", "异常单号"],
];

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
