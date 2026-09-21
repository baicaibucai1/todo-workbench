/**
 * 工单附件验证（浏览器 demo）。
 *
 * 关注点（每一条都对应一个真实会出错的环节）：
 *   1) 贴网址后**真的下载并落库**了 —— 不是只在界面上加了一行
 *   2) 落进去的图**被浏览器真的解码了**（naturalWidth > 0）。
 *      只看 DOM 里有 <img> 就会把"src 写错"误判成成功。
 *   3) 类型由**真实内容**决定：同源拿 .json 会走"不是媒体 → 存链接"这一支
 *   4) 同一份内容重复添加不会占两份空间（内容寻址去重）
 *   5) 文件没了要能看出来（换了机器 / 手动清过目录），并且**给得出补救的路**
 *   6) 刷新后还在（IndexedDB 持久化）
 *
 * 为什么要用同源壁纸做测试素材：浏览器 demo 只能硬扛 CORS，
 * 跨域图片在这里下不下来（那是浏览器限制，不是代码问题）。
 * 用同源地址才能把"下载 → 指纹 → 落库 → 渲染"整条链路真的跑一遍。
 *
 * 依赖 QQbot 里已装的 playwright + 本机 Edge。
 * 前置：`node node_modules/vite/bin/vite.js` 在跑（http://localhost:1420/）。
 *
 * 用法：node tests/attachments.mjs [--url http://localhost:1420/] [--fresh]
 */

import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SHOT_DIR = "C:/AI_Production/Tools/.workbuddy/tools/out";
const ASSET_DIR = "public/wallpapers";

const argv = process.argv.slice(2);
const ui = argv.indexOf("--url");
const BASE = ui !== -1 ? argv[ui + 1] : "http://localhost:1420/";
const FRESH = argv.includes("--fresh");

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

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

/* ------------------------------ 小工具 ------------------------------ */

const panel = () => page.locator("[data-attach-panel]").first();
const items = () => page.locator("[data-attach-item]");
const msg = () => page.locator("[data-attach-msg]").first();
const msgTone = () => page.locator("[data-attach-msg]").first().getAttribute("data-attach-msg");

/** 把网址贴进附件输入框并回车 */
async function paste(url) {
  const input = page.locator("[data-attach-input]");
  await input.fill(url);
  await input.press("Enter");
  await page.waitForTimeout(900);
}

/** 附件区里已落库的图片是否真的解码了 */
const decodedImages = () =>
  page.evaluate(() => {
    const imgs = [...document.querySelectorAll("[data-attach-grid='image'] img")];
    return {
      total: imgs.length,
      decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
      widths: imgs.map((i) => i.naturalWidth),
    };
  });

/** 浏览器 demo 的"仓库"里实际存了几个文件 */
const repoFiles = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("todo-workbench:attachments", 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("files")) {
            req.result.createObjectStore("files", { keyPath: "relPath" });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("files")) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction("files", "readonly");
          const all = tx.objectStore("files").getAll();
          all.onsuccess = () => {
            const rows = all.result ?? [];
            db.close();
            resolve(rows.map((r) => ({ relPath: r.relPath, size: r.blob?.size ?? 0, mime: r.mime })));
          };
          all.onerror = () => {
            db.close();
            resolve([]);
          };
        };
        req.onerror = () => resolve([]);
      }),
  );

/** 清空仓库（模拟"文件被弄丢了"） */
const wipeRepo = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("todo-workbench:attachments", 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("files", "readwrite");
          tx.objectStore("files").clear();
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
        };
      }),
  );

async function openFirstOrder() {
  await page.locator('aside [data-nav="all"]').click();
  await page.waitForTimeout(600);
  const row = page.locator("[data-order-id]").first();
  await row.locator("[data-order-title]").first().click();
  await page.waitForTimeout(400);
  return row.getAttribute("data-order-id");
}

/* ------------------------------ 开场 ------------------------------ */

console.log("\n0. 打开待办 → 选一张工单");
await page.goto(BASE, { waitUntil: "load" });
if (FRESH) {
  // 演示库是 localStorage 快照，不清干净的话上一次跑的附件会留在里面，
  // 断言"第一次添加"之类的东西就不可靠了
  await page.evaluate(() => {
    localStorage.removeItem("todo-workbench:demo-db");
    return new Promise((r) => {
      const req = indexedDB.deleteDatabase("todo-workbench:attachments");
      req.onsuccess = req.onerror = req.onblocked = () => r(true);
    });
  });
  await page.reload({ waitUntil: "load" });
}
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);

const orderId = await openFirstOrder();
info("选中的工单", orderId);
check("工单详情里出现了附件区", (await panel().count()) === 1);
check("初始没有附件", (await items().count()) === 0, String(await items().count()));

/* ------------------------------ 1. 非法输入 ------------------------------ */

console.log("\n1. 非法网址要被挡下来，并且说清楚原因");

await paste("这不是网址");
check("非网址给出错误提示", (await msgTone()) === "err", String(await msgTone()));
const badMsg = (await msg().innerText()).trim();
info("提示文案", badMsg);
check("提示说明了是网址格式问题", badMsg.includes("网址"), badMsg);

await paste("file:///C:/Windows/win.ini");
check("非 http 协议被拒", (await msgTone()) === "err", String(await msgTone()));
const protoMsg = (await msg().innerText()).trim();
info("协议拦截文案", protoMsg);
check("协议拦截说明了只支持 http/https", protoMsg.includes("http"), protoMsg);

check("非法输入没有往仓库里写任何东西", (await repoFiles()).length === 0,
  JSON.stringify(await repoFiles()));
await page.locator("[data-attach-msg] button").first().click(); // 关掉提示
await page.waitForTimeout(200);

/* ------------------------------ 2. 下载图片 ------------------------------ */

console.log("\n2. 贴一个图片网址 → 下载进本地仓库");

const IMG_URL = `${BASE}wallpapers/20260918.jpg`;
await paste(IMG_URL);

check("提示为成功", (await msgTone()) === "ok", String(await msgTone()));
info("提示文案", (await msg().innerText()).trim());
check("附件区多了一张图", (await items().count()) === 1, String(await items().count()));
check("它的类型是 image", (await items().first().getAttribute("data-attach-kind")) === "image");

const first = await decodedImages();
info("图片解码情况", first);
check("图片在界面上真的解码出来了（不是 src 写错的空图）",
  first.decoded === 1 && first.broken === 0, JSON.stringify(first));
check("解码出来的宽度与源图一致（1920）", first.widths[0] === 1920, String(first.widths[0]));

const filesAfterImg = await repoFiles();
info("仓库里的文件", filesAfterImg);
check("文件真的落进了仓库", filesAfterImg.length === 1, JSON.stringify(filesAfterImg));
check("落库的 mime 是 image/jpeg", filesAfterImg[0]?.mime === "image/jpeg",
  String(filesAfterImg[0]?.mime));
check("落库文件名带内容指纹前缀（内容寻址）",
  /^\d{4}-\d{2}\/[0-9a-f]{8}-/.test(filesAfterImg[0]?.relPath ?? ""),
  String(filesAfterImg[0]?.relPath));

/* ------------------------------ 3. 去重 ------------------------------ */

console.log("\n3. 同一张图再贴一次 → 不占第二份空间");

await paste(IMG_URL);
check("提示里说明了内容已存在",
  (await msg().innerText()).includes("已经有") || (await msg().innerText()).includes("没有重复"),
  (await msg().innerText()).trim());
check("列表里多了一条记录（两次添加是两次行为）",
  (await items().count()) === 2, String(await items().count()));
check("但仓库里仍然只有一份文件（内容寻址去重）",
  (await repoFiles()).length === 1, JSON.stringify(await repoFiles()));

/* ------------------------------ 4. 非媒体 → 存链接 ------------------------------ */

console.log("\n4. 贴一个非图片/视频的地址 → 按约定改存链接，本地不留副本");

await paste(`${BASE}wallpapers/index.json`);
check("提示降级为「已存成链接」这一档", (await msgTone()) === "warn", String(await msgTone()));
const linkMsg = (await msg().innerText()).trim();
info("降级文案", linkMsg);
check("说明了为什么没存本地", /json|非媒体/.test(linkMsg), linkMsg);

const linkRows = page.locator("[data-attach-grid='link'] [data-attach-item]");
check("链接区出现一条", (await linkRows.count()) === 1, String(await linkRows.count()));
check("它的类型是 link", (await linkRows.first().getAttribute("data-attach-kind")) === "link");
check("链接显示了站点名",
  (await linkRows.first().innerText()).includes("localhost"),
  (await linkRows.first().innerText()).trim());
check("仓库里没有多出文件（降级时把下下来的临时文件删掉了）",
  (await repoFiles()).length === 1, JSON.stringify(await repoFiles()));

/* ------------------------------ 5. 灯箱 ------------------------------ */

console.log("\n5. 点图看大图，Esc 关掉");

await page.locator("[data-attach-grid='image'] [data-attach-item]").first().locator("button").first().click();
await page.waitForTimeout(400);
check("灯箱打开了", (await page.locator("[data-attach-lightbox]").count()) === 1);
const big = await page.evaluate(() => {
  const img = document.querySelector("[data-attach-lightbox] img");
  return img ? { complete: img.complete, w: img.naturalWidth } : null;
});
info("灯箱里的图", big);
check("灯箱里的图也是解码成功的", !!big && big.w > 0, JSON.stringify(big));
await page.screenshot({ path: `${SHOT_DIR}/52-attach-lightbox.png` });

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Esc 能关掉灯箱", (await page.locator("[data-attach-lightbox]").count()) === 0);

/* ------------------------------ 6. 从本机选文件 ------------------------------ */

console.log("\n6. 从本机选一个文件复制进仓库");

const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
await page.locator("[data-attach-files]").click();
const chooser = await chooserPromise;
await chooser.setFiles(`${ASSET_DIR}/20260914.jpg`);
await page.waitForTimeout(1400);

check("提示为成功", (await msgTone()) === "ok", String(await msgTone()));
info("提示文案", (await msg().innerText()).trim());
check("列表里多了一条", (await items().count()) === 4, String(await items().count()));
const afterLocal = await repoFiles();
info("仓库文件数", afterLocal.length);
check("本机文件被复制进了仓库", afterLocal.length === 2, JSON.stringify(afterLocal.map((f) => f.relPath)));
check("文件名来自本机文件", afterLocal.some((f) => f.relPath.includes("20260914")),
  JSON.stringify(afterLocal.map((f) => f.relPath)));
const decoded2 = await decodedImages();
// 3 张图：同一个网址贴了两次（两条记录、同一份文件）+ 本机选的一个
check("三张图都能解码", decoded2.decoded === 3 && decoded2.broken === 0, JSON.stringify(decoded2));

/* ------------------------------ 7. 工单行上的角标 ------------------------------ */

console.log("\n7. 列表行上能看到这张工单带着附件");

const badge = page.locator(`[data-order-id="${orderId}"] [data-order-attach-count]`);
check("工单行出现了附件角标", (await badge.count()) === 1, String(await badge.count()));
info("角标数字", await badge.getAttribute("data-order-attach-count"));
check("角标数字与附件数一致",
  (await badge.getAttribute("data-order-attach-count")) === "4",
  String(await badge.getAttribute("data-order-attach-count")));

/* ------------------------------ 8. 刷新后还在 ------------------------------ */

console.log("\n8. 刷新后附件仍在（IndexedDB 持久化）");

await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);
await openFirstOrder();

check("刷新后附件区仍有 4 条", (await items().count()) === 4, String(await items().count()));
const afterReload = await decodedImages();
info("刷新后解码情况", afterReload);
check("刷新后图片依然能解码", afterReload.decoded === 3 && afterReload.broken === 0,
  JSON.stringify(afterReload));
check("刷新后链接类也还在",
  (await page.locator("[data-attach-grid='link'] [data-attach-item]").count()) === 1);

await page.screenshot({ path: `${SHOT_DIR}/51-attach-panel.png` });

/* ------------------------------ 9. 文件缺失与补救 ------------------------------ */

console.log("\n9. 文件被弄丢 → 要看得出来，并且给得出补救的路");

await wipeRepo();
await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(900);
await openFirstOrder();

const missing = page.locator("[data-attach-missing]");
// 3 张图全都缺文件（其中两张共用同一份物理文件，但记录是两条）
check("缺失的文件被标出来了", (await missing.count()) === 3, String(await missing.count()));
check("缺失时给的是「重新下载」而不是死路",
  (await missing.first().locator("[data-attach-retry]").count()) === 1);

// 本机导入的那张没有来源网址，补不回来 —— 这时候不该给一个点了必然失败的按钮
const retryButtons = page.locator("[data-attach-retry]");
info("可补救的条数", await retryButtons.count());
check("只有有来源网址的才给「重新下载」", (await retryButtons.count()) === 2,
  String(await retryButtons.count()));
check("链接类不受影响（它本来就不依赖本地文件）",
  (await page.locator("[data-attach-grid='link'] [data-attach-item]").count()) === 1);

await page.locator("[data-attach-retry]").first().click();
await page.waitForTimeout(1800);
const recovered = await repoFiles();
info("重下之后的仓库", recovered.map((f) => f.relPath));
check("「重新下载」把文件补回来了", recovered.length >= 1, JSON.stringify(recovered));

// 这张图有两条记录共用同一份文件（内容寻址）。补回来一个，
// 另一条也必须跟着好 —— 否则用户会觉得"补了没用"。
// 这条是修 useRepoUrl 的依赖之前真实踩到的坑：只依赖 relPath 的话，
// 补回来的路径和原来一模一样，effect 不重跑，另一条会一直挂着"文件缺失"。
info("补回来后仍缺失的条数", await missing.count());
check("共用同一份文件的另一条也一起好了", (await missing.count()) === 1,
  String(await missing.count()));
check("剩下的那条正是没有来源、补不回来的那张",
  (await missing.first().locator("[data-attach-retry]").count()) === 0);

/* ------------------------------ 10. 删除 ------------------------------ */

console.log("\n10. 移除附件与文件回收");

const perKind = await page.evaluate(() => ({
  image: document.querySelectorAll("[data-attach-grid='image'] [data-attach-item]").length,
  video: document.querySelectorAll("[data-attach-grid='video'] [data-attach-item]").length,
  link: document.querySelectorAll("[data-attach-grid='link'] [data-attach-item]").length,
}));
info("各类型条数", perKind);

const removeOne = async (selector) => {
  const el = page.locator(selector).first();
  await el.hover();
  await el.locator("[data-attach-remove]").first().click();
  await page.waitForTimeout(800);
};

// 先删那条没有来源的（它的文件在第 9 步已经丢了，删除时不能因为文件不存在而报错）
let before = await items().count();
await removeOne("[data-attach-missing]");
check("删一条文件已经不在的附件不会出错", (await items().count()) === before - 1,
  `${before} → ${await items().count()}`);

// 剩下两条图共用同一份文件。删掉一条时**文件必须留着**（另一条还在用）。
before = await items().count();
await removeOne("[data-attach-grid='image'] [data-attach-item]");
check("又少了一条", (await items().count()) === before - 1,
  `${before} → ${await items().count()}`);
let filesNow = await repoFiles();
info("删掉两条引用中的一条后", filesNow.map((f) => f.relPath));
check("仍有引用时文件不被删掉（内容寻址最容易踩的坑）",
  filesNow.length === 1 && filesNow[0].relPath.includes("20260918"),
  JSON.stringify(filesNow.map((f) => f.relPath)));

// 删掉最后一条引用 → 文件这时候才可以被回收
await removeOne("[data-attach-grid='image'] [data-attach-item]");
check("图片都删完了", (await page.locator("[data-attach-grid='image'] [data-attach-item]").count()) === 0);
filesNow = await repoFiles();
info("引用归零之后的仓库", filesNow.map((f) => f.relPath));
check("引用归零后文件被真的回收（不留孤儿文件）", filesNow.length === 0,
  JSON.stringify(filesNow.map((f) => f.relPath)));

// 删掉链接类
await removeOne("[data-attach-grid='link'] [data-attach-item]");
check("链接类也能删掉",
  (await page.locator("[data-attach-grid='link'] [data-attach-item]").count()) === 0);
check("全删完之后回到空态", (await items().count()) === 0, String(await items().count()));
check("空态给出了引导文字",
  (await panel().innerText()).includes("图片和视频会下载到本地仓库"),
  (await panel().innerText()).slice(0, 60));

/* ------------------------------ 收尾 ------------------------------ */

console.log("\n11. 控制台");
check("全程无控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

fs.mkdirSync(SHOT_DIR, { recursive: true });
await browser.close();

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
