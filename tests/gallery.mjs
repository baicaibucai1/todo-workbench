/**
 * 图库验证（浏览器 demo）。
 *
 * 关注点（每一条都对应一个真实会出错的环节）：
 *   1) 图库在侧边栏是个**独立视图**，点开时右侧详情面板要让位（不然会被压扁）
 *   2) 计数 / 筛选 / 搜索三条路都通，且筛选**看着像坏了**的两种情况：
 *      搜不到要给"没有符合条件的"而不是"图库还是空的"
 *   3) 卡片里的图**被浏览器真的解码了**（naturalWidth > 0）——
 *      只看 DOM 里有 <img> 会把"仓库路径写错"误判成成功
 *   4) 来源徽标按 creation 的 origin 显示，且**来源是宿主盖的章**，
 *      工具自报的不算（这里用数据层直接写，验的是展示）
 *   5) 同一份内容重复导入只占一份仓库空间（内容寻址去重）
 *   6) 刷新后还在（元数据走演示库快照，文件走 IndexedDB）
 *   7) 删除一条**不影响**别人还在用的那份文件（引用计数是跨表的）
 *
 * 依赖 QQbot 里已装的 playwright + 本机 Edge。
 * 前置：`node node_modules/vite/bin/vite.js` 在跑（http://localhost:1420/）。
 *
 * 用法：node tests/gallery.mjs [--url http://localhost:1420/] [--fresh]
 */

import { createRequire } from "node:module";
import { makePng } from "./png.mjs";

const require = createRequire("C:/AI_Production/QQbot/");
const { chromium } = require("playwright");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

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

const PNG_RED = "data:image/png;base64," + makePng(240, 180, [200, 60, 60]).toString("base64");
const PNG_BLUE = "data:image/png;base64," + makePng(320, 240, [60, 90, 200]).toString("base64");
/** 第 7 节要单独回收的那份内容。必须与红色那张**内容不同**：
 *  引用计数是按内容哈希算的，共用同一份字节的话，"删掉最后一条引用"
 *  根本不会发生（红色那张还在引用同一个哈希），测出来的结论就是错的。 */
const PNG_GREEN = "data:image/png;base64," + makePng(200, 200, [60, 170, 90]).toString("base64");
/** 同一个 content 用两次，验内容寻址去重 */
const DNAME = "同一个文件.png";
/** 第 10 节专用：必须是**全新内容**。绿色那张在第 7 节会被删干净
 *  （deleted=1 后 findGalleryByHash 就找不到了），拿它验 dedupe 会得出
 *  "去重没生效"的假结论。 */
const PNG_PURPLE = "data:image/png;base64," + makePng(160, 120, [140, 80, 180]).toString("base64");

/* ------------------------------ 开场 ------------------------------ */

const browser = await chromium.launch({ executablePath: EDGE });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

/** 直接走数据层造数据 —— 图库的写入入口有三个（界面导入 / 工具桥 / AI 存图），
 *  界面导入要弹系统文件框，e2e 里点不了；数据层是三条路的共同底座。
 *
 *  写完必须广播 GALLERY_CHANGED：这正是工具桥写入后做的事
 *  （toolBridge 的 gallery.put handler 末尾会调 notifyGalleryChanged）。
 *  少了它，图库界面根本不知道库变了 —— 那本身就是个真 bug 的形态。 */
const seed = () =>
  page.evaluate(
    async ({ red, blue, green, dname }) => {
      const g = await import("/src/lib/gallery.ts");
      const out = [];
      out.push(await g.addToGallery({ dataUrl: red, title: "红色主图.png", origin: "manual", note: "手导" }));
      out.push(
        await g.addToGallery({
          dataUrl: blue,
          title: "AI 出图 秋冬外套",
          origin: "ai-gen",
          prompt: "白色背景 商品 45 度",
          width: 320,
          height: 240,
        }),
      );
      // 同一个内容 + 同一个名字 → 仓库里应该只有一份
      const dupA = await g.addToGallery({ dataUrl: green, title: dname, origin: "image-crop" });
      const dupB = await g.addToGallery({ dataUrl: green, title: dname, origin: "size-chart" });
      // 一条视频：浏览器 demo 里就是一段假字节，验的是"类型按真实内容判"
      const vid = await g.addToGallery({
        dataUrl: "data:video/mp4;base64,AAAAIGZ0eXBpc29t",
        title: "商品视频.mp4",
        origin: "manual",
      });
      g.notifyGalleryChanged();
      return {
        ids: out.map((x) => x.id),
        dup: { a: dupA.relPath, b: dupB.relPath, hashA: dupA.hash, hashB: dupB.hash },
        video: { id: vid.id, kind: vid.kind, mime: vid.mime },
      };
    },
    { red: PNG_RED, blue: PNG_BLUE, green: PNG_GREEN, dname: DNAME },
  );

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
          const all = db.transaction("files", "readonly").objectStore("files").getAll();
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

const galleryRoot = () => page.locator("[data-gallery]").first();
const cards = () => page.locator("[data-gallery-card]");
const openGallery = async () => {
  await page.locator('aside [data-nav="gallery"]').first().click();
  await page.waitForTimeout(700);
};

/**
 * 等卡片数变成 n 再断言。
 *
 * 不用固定 sleep：图库的读取是异步的（尤其浏览器 demo 要开 IndexedDB 取 blob），
 * 而**固定等待要么慢要么偶发失败** —— 之前正是这里在"还在读"的窗口里数出 0 条。
 */
async function waitCards(n, timeout = 8000) {
  try {
    await page.waitForFunction(
      (want) => document.querySelectorAll("[data-gallery-card]").length === want,
      n,
      { timeout },
    );
    return true;
  } catch {
    return (await cards().count()) === n;
  }
}
const cardCountNow = () => cards().count();

console.log("\n0. 打开工作台");
await page.goto(BASE, { waitUntil: "load" });
if (FRESH) {
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

check("侧边栏有「图库」入口", (await page.locator('aside [data-nav="gallery"]').count()) === 1);

/* ------------------------------ 1. 空态 ------------------------------ */

console.log("\n1. 图库是独立视图，空态要说人话");

await openGallery();
check("主区域切到了图库", (await galleryRoot().count()) === 1);
check("图库不显示待办列表", (await page.locator("[data-task-id]").count()) === 0);
const emptyTxt = await page.locator("[data-gallery-empty]").first().innerText().catch(() => "");
info("空态文案", emptyTxt.replace(/\n+/g, " / "));
check("空图库给空态而不是一片空白", emptyTxt.length > 0);
check("空态指向了导入这条路", /导入/.test(emptyTxt), emptyTxt.slice(0, 60));

/* ------------------------------ 2. 造数据 ------------------------------ */

console.log("\n2. 写入：内容寻址 + 类型按真实内容判");

const made = await seed();
info("重复项路径", made.dup);
check("同内容 + 同名 → 仓库里是同一个文件", made.dup.a === made.dup.b, `${made.dup.a} vs ${made.dup.b}`);
check("同内容 + 同名 → 指纹一致", made.dup.hashA === made.dup.hashB);
check("视频按真实 mime 判成 video（不是按调用方说是什么）",
  made.video.kind === "video", `${made.video.kind} / ${made.video.mime}`);

const filesAfterSeed = await repoFiles();
info("仓库文件", filesAfterSeed.map((f) => f.relPath));
// 命名规则是 `<hash 前 8 位>-<名字>`，所以"同内容同名字"才合并成一个文件。
// 5 条记录里有一对正是这样（同一个文件.png），于是落成 4 个文件而不是 5 个。
check("5 条记录只落 4 个文件（同名同内容的那对被合并了）",
  filesAfterSeed.length === 4, String(filesAfterSeed.length));
check("同名同内容的那对确实只占一份",
  filesAfterSeed.filter((f) => f.relPath === made.dup.a).length === 1);

/* ------------------------------ 3. 网格与解码 ------------------------------ */

console.log("\n3. 网格渲染，图必须真的解码");

await openGallery();
// 造数据是在图库已经打开之后发生的，靠 GALLERY_CHANGED 通知它自己刷新 ——
// 等卡片真的出现，而不是等一个拍脑袋的毫秒数
check("写入后图库自己刷新出 5 条", await waitCards(5), String(await cardCountNow()));
check("顶部计数跟得上", (await page.locator("[data-gallery-count]").first().getAttribute("data-gallery-count")) === "5");

const decoded = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll("[data-gallery-card] img")];
  return {
    total: imgs.length,
    ok: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    widths: imgs.map((i) => i.naturalWidth),
  };
});
info("图片解码", decoded);
check("图片不是「文件缺失」占位", decoded.total >= 4, String(decoded.total));
check("每一张都真的解码了（不是 src 写错的破图）", decoded.broken === 0 && decoded.ok === decoded.total,
  JSON.stringify(decoded));
check("视频渲染成 <video> 而不是硬塞进 <img>",
  (await page.locator("[data-gallery-card] video").count()) === 1);

const origins = await page.locator("[data-gallery-origin]").evaluateAll((els) =>
  els.map((e) => `${e.dataset.galleryOrigin}:${e.textContent.trim()}`),
);
info("来源徽标", origins);
check("来源徽标带着 origin 标记（e2e 不靠中文文案）",
  origins.some((o) => o.startsWith("ai-gen:")), origins.join(","));
check("AI 生成的徽标是「AI 生成」", origins.some((o) => o === "ai-gen:AI 生成"), origins.join(","));

/* ------------------------------ 4. 筛选与搜索 ------------------------------ */

console.log("\n4. 筛选与搜索");

await page.locator('[data-gallery-filter="video"]').click();
check("筛到视频只剩 1 条", await waitCards(1), String(await cardCountNow()));

await page.locator('[data-gallery-filter="image"]').click();
check("筛到图片剩 4 条", await waitCards(4), String(await cardCountNow()));

await page.locator('[data-gallery-filter="all"]').click();
await waitCards(5);
await page.locator('[data-gallery-filter="origin-ai-gen"]').click();
check("按来源筛只剩 AI 那条", await waitCards(1), String(await cardCountNow()));
// 选过来源之后必须能选回「所有来源」，否则用户会陷在某个来源里出不来
await page.locator('[data-gallery-filter="origin-all"]').click();
check("「所有来源」能回到全量", await waitCards(5), String(await cardCountNow()));

const search = page.locator("[data-gallery-search]");
await search.fill("秋冬");
check("搜标题命中", await waitCards(1), String(await cardCountNow()));

await search.fill("白色背景");
check("搜提示词也命中（提示词是图库里最有用的一列）", await waitCards(1), String(await cardCountNow()));

await search.fill("不存在的词");
await waitCards(0);
const missTxt = await page.locator("[data-gallery-empty]").first().innerText().catch(() => "");
info("搜不到时的文案", missTxt.replace(/\n+/g, " / "));
check("搜不到说「没有符合条件的」而不是「图库还是空的」",
  /没有符合条件/.test(missTxt), missTxt.slice(0, 60));

await search.fill("");
check("清空搜索后恢复 5 条", await waitCards(5), String(await cardCountNow()));

/* ------------------------------ 5. 重命名 ------------------------------ */

console.log("\n5. 重命名要落库");

// ⚠️ 点开重命名之后，卡片里的标题 <p> 会变成一个 <input>，
// 于是 `hasText: "红色主图"` 再也匹配不到这张卡（hasText 看的是文本，
// 不看 input 的 value）—— 所以先取 id，之后一律按 id 定位。
const targetByText = cards().filter({ hasText: "红色主图" }).first();
const targetId = await targetByText.getAttribute("data-gallery-card");
const target = page.locator(`[data-gallery-card="${targetId}"]`);
await target.scrollIntoViewIfNeeded();
await target.hover();
await target.locator('button[title="重命名"]').click();
const editBox = target.locator("input");
await editBox.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
check("重命名输入框出现（点铅笔后就地变成输入框）", (await editBox.count()) === 1);
await editBox.fill("红色主图-改过");
await editBox.press("Enter");
await page.waitForTimeout(500);
const renamed = await page.evaluate(async (id) => {
  const g = await import("/src/lib/gallery.ts");
  return (await g.getGalleryItem(id))?.title;
}, targetId);
check("新标题写进了库", renamed === "红色主图-改过", String(renamed));
check("卡片上的文字也跟着变了",
  (await cards().filter({ hasText: "红色主图-改过" }).count()) === 1);

/* ------------------------------ 6. 灯箱 ------------------------------ */

console.log("\n6. 大图查看");

await cards().first().locator("button").first().click();
await page.waitForTimeout(600);
const lb = page.locator("[data-gallery-lightbox]");
check("灯箱打开", (await lb.count()) === 1);
const lbInfo = (await page.locator("[data-gallery-info]").first().innerText().catch(() => "")).replace(/\n+/g, " / ");
info("信息面板", lbInfo);
check("信息面板有内容（标题/来源/规格）", lbInfo.length > 10, lbInfo.slice(0, 60));
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Esc 关得掉", (await lb.count()) === 0);

/* ------------------------------ 7. 删除与引用计数 ------------------------------ */

console.log("\n7. 删除：不该把别人还在用的文件删掉");

const filesBefore = await repoFiles();
const dedupRel = made.dup.a;
const dupCard = cards().filter({ hasText: DNAME }).first();
check("同名的两条记录各有各的卡片", (await cards().filter({ hasText: DNAME }).count()) === 2);

await dupCard.hover();
await dupCard.locator("[data-gallery-remove]").click();
check("删掉一条后卡片只剩 4 张", await waitCards(4), String(await cardCountNow()));
await page.waitForTimeout(500);
const filesMid = await repoFiles();
check("另一条还在同名同内容地引用它 → 仓库文件保留",
  filesMid.some((f) => f.relPath === dedupRel), JSON.stringify(filesMid.map((f) => f.relPath)));
check("仓库文件数没变（没误删）", filesMid.length === filesBefore.length,
  `${filesBefore.length} → ${filesMid.length}`);

// 再把另一条也删掉：这时引用归零，文件才该被回收
const lastDup = cards().filter({ hasText: DNAME }).first();
await lastDup.hover();
await lastDup.locator("[data-gallery-remove]").click();
check("剩下 3 张卡片", await waitCards(3), String(await cardCountNow()));
await page.waitForTimeout(500);
const filesAfter = await repoFiles();
info("引用归零后仓库文件", filesAfter.map((f) => f.relPath));
check("最后一条引用被删掉后文件才被回收",
  !filesAfter.some((f) => f.relPath === dedupRel), JSON.stringify(filesAfter.map((f) => f.relPath)));

/* ------------------------------ 8. 持久化 ------------------------------ */

console.log("\n8. 刷新后还在");

await page.reload({ waitUntil: "load" });
await page.waitForSelector("aside", { timeout: 20000 });
await page.waitForTimeout(1000);
await openGallery();
check("刷新后图库还有 3 条", await waitCards(3), String(await cardCountNow()));
check("重命名保留了下来",
  (await cards().filter({ hasText: "红色主图-改过" }).count()) === 1);

/* --------------------- 9. 与图片裁剪工具双向往返 --------------------- */

console.log("\n9. 图库 ↔ 图片裁剪：取出来 → 改 → 存回去");

/** 打开一个工具并拿到它的 iframe 上下文（工具都跑在沙箱 iframe 里） */
async function openTool(id, settle = 1500) {
  await page.goto(`${BASE}?tool=${id}`, { waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(settle);
  const el = page.locator(`iframe[data-tool-frame="${id}"]`);
  if ((await el.count()) === 0) return null;
  await page.waitForTimeout(1200);
  return page.frames().find((f) => new RegExp(`/tools/${id}/`).test(f.url())) ?? null;
}

const fc = await openTool("image-crop");
check("图片裁剪能作为工具打开", !!fc, "没找到 iframe");
if (fc) {
  const gate = await fc.evaluate(() => ({
    openHidden: document.getElementById("btnOpenFromGallery").hidden,
    saveHidden: document.getElementById("btnSaveToGallery").hidden,
    saveDisabled: document.getElementById("btnSaveToGallery").disabled,
  }));
  info("裁剪工具的图库入口", gate);
  check("连上宿主 → 「从图库打开」可见", gate.openHidden === false);
  check("连上宿主 → 「存进图库」可见", gate.saveHidden === false);
  check("还没图时「存进图库」是禁用的（不写假按钮）", gate.saveDisabled === true);

  // 打开选择器，图库里现有的 3 条里应有 2 张图（另 1 条是视频）
  await fc.locator("#btnOpenFromGallery").click();
  await page.waitForTimeout(1600);
  const picker = await fc.evaluate(() => ({
    on: document.getElementById("galleryMask").classList.contains("on"),
    tiles: document.querySelectorAll("#galleryBody .gitem").length,
    count: document.getElementById("galleryCount").textContent.trim(),
    useDisabled: document.getElementById("btnGalleryUse").disabled,
  }));
  info("裁剪里的图库选择器", picker);
  check("选择器打开了", picker.on === true);
  // 选择器按 kind=image 取，视频不该出现在里面
  check("只列出图片，视频被挡在外面", picker.tiles === 2, String(picker.tiles));
  check("未选中时「导入」禁用", picker.useDisabled === true);

  await fc.locator("#galleryBody .gitem").first().click();
  await page.waitForTimeout(300);
  await fc.locator("#btnGalleryUse").click();
  await page.waitForTimeout(2500);

  const loaded = await fc.evaluate(() => ({
    // 只数图片磁贴：队尾还有一块常驻的「＋加入」磁贴，它也是 #thumbList 的直接子元素
    thumbs: document.querySelectorAll("#thumbList .thumb:not(.add)").length,
    addTile: document.querySelectorAll("#thumbList .thumb.add").length,
    dl: document.getElementById("btnDownload").disabled,
    saveDisabled: document.getElementById("btnSaveToGallery").disabled,
    maskOn: document.getElementById("galleryMask").classList.contains("on"),
  }));
  info("从图库导入后", loaded);
  check("图库里的图进了裁剪的列表", loaded.thumbs === 1, `thumbs=${loaded.thumbs}`);
  check("列表尾部常驻「＋加入」入口", loaded.addTile === 1, String(loaded.addTile));
  check("导入后导出可用", loaded.dl === false);
  check("有图了「存进图库」才放开", loaded.saveDisabled === false);
  check("导入后选择器自动关掉", loaded.maskOn === false);

  /* 自动留档：不用点「存进图库」，图库也该自己多一份。
     ⚠️ 直接调 archiveToGallery 而不点「导出」按钮：导出会走 showSaveFilePicker
     弹系统保存框，无头浏览器里它既不返回也不报错，整条导出链就悬在那儿 ——
     测出来的是"无头环境不支持文件选择器"，不是"自动留档没生效"。
     ⚠️ 断言的是工具自己打的标记（put 成功才写），而不是"条目数 +1"：
     同样的字节撞上已有内容时走去重分支、条目数不变，那是**正确行为**。 */
  const autoBefore = await page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    const all = await g.fetchGallery();
    return { n: all.length, hashes: all.map((i) => i.hash) };
  });
  const autoAfter = await fc.evaluate(async () => {
    // 一张跟图库里现有内容都不同的小图，确保走的是"新增"而不是去重分支
    const c = document.createElement("canvas");
    c.width = 37; c.height = 21;
    const g2 = c.getContext("2d");
    g2.fillStyle = "#1e7f5c"; g2.fillRect(0, 0, 37, 21);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await window.archiveToGallery(blob, "e2e-自动留档.png", 37, 21, "png");
    return {
      flag: document.body.dataset.autoArchived ?? "",
      autoSwitch: document.body.dataset.autoGallery ?? "",
    };
  });
  const autoRows = await page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    const all = await g.fetchGallery();
    return { n: all.length, topOrigin: all[0] && all[0].origin, topTitle: all[0] && all[0].title };
  });
  info("导出后自动留档", { autoBefore: autoBefore.n, autoAfter: autoAfter, autoRows });
  check("「导出自动存图库」默认开着", autoAfter.autoSwitch === "true", autoAfter.autoSwitch);
  check("工具的自动留档跑通了（put 成功才打标记）", autoAfter.flag === "1", `flag=${autoAfter.flag}`);
  check("自动留档真的进了一条", autoRows.n === autoBefore.n + 1, `${autoBefore.n} → ${autoRows.n}`);
  check("来源同样是宿主盖的 image-crop", autoRows.topOrigin === "image-crop", String(autoRows.topOrigin));

  // 存回去：来源该由宿主盖成 image-crop
  const before = await page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    return (await g.fetchGallery()).length;
  });
  await fc.locator("#btnSaveToGallery").click();
  await page.waitForTimeout(3000);
  const back = await page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    const all = await g.fetchGallery();
    return { n: all.length, origin: all[0] && all[0].origin, hasRel: !!(all[0] && all[0].relPath) };
  });
  info("存回图库", { before, after: back });
  check("存回去后图库多了一条", back.n === before + 1, `${before} → ${back.n}`);
  check("来源被宿主盖成 image-crop（工具说了不算）", back.origin === "image-crop", String(back.origin));
  check("存回去的图真的落进了文件仓库", back.hasRel, String(back.hasRel));

  // 回到图库视图，界面上要立刻看得到。
  // 条数不写死：上面多了一次"自动留档"，写死 4 会在每次改动后变成假红。
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("aside", { timeout: 20000 });
  await page.waitForTimeout(900);
  await openGallery();
  const expectCards = await page.evaluate(async () => {
    const g = await import("/src/lib/gallery.ts");
    return (await g.fetchGallery()).length;
  });
  check("回图库视图条数对得上", await waitCards(expectCards),
    `期望 ${expectCards}，实际 ${await cardCountNow()}`);
  check("新条目带着「图片裁剪」徽标",
    (await page.locator('[data-gallery-origin="image-crop"]').count()) >= 1,
    String(await page.locator('[data-gallery-origin="image-crop"]').count()));
}

/* --------------------- 10. dedupe：自动存档撞上已有内容 --------------------- */

console.log("\n10. 去重语义：自动存档交回已有那一条，手动保存照样新增");

const dedupeProbe = await page.evaluate(async (purple) => {
  const g = await import("/src/lib/gallery.ts");
  const n0 = (await g.fetchGallery()).length;
  // 第一次：全新内容，正常新增
  const first = await g.addToGallery({ dataUrl: purple, title: "紫色-首次.png", origin: "size-chart" });
  const n1 = (await g.fetchGallery()).length;
  // 第二次：同样字节 + dedupe —— 工具自动存档走的就是这条
  const auto = await g.addToGallery({ dataUrl: purple, title: "紫色-自动存档.png", origin: "size-chart", dedupe: true });
  const n2 = (await g.fetchGallery()).length;
  // 第三次：同样字节但**不带** dedupe —— 用户手动点「存进图库」，他要的就是再留一份
  const manual = await g.addToGallery({ dataUrl: purple, title: "紫色-手动再存.png", origin: "size-chart" });
  const n3 = (await g.fetchGallery()).length;
  g.notifyGalleryChanged();
  return {
    n0, n1, n2, n3,
    autoDup: auto.dup === true,
    autoIsFirst: auto.id === first.id,
    autoTitle: auto.title,
    manualDup: manual.dup === true,
    manualNew: manual.id !== first.id,
    sameFile: auto.relPath === first.relPath && manual.relPath === first.relPath,
    paths: { first: first.relPath, auto: auto.relPath, manual: manual.relPath },
    hashes: { first: first.hash, auto: auto.hash, manual: manual.hash },
  };
}, PNG_PURPLE);
info("dedupe 探针", dedupeProbe);
check("首次存入新增一条", dedupeProbe.n1 === dedupeProbe.n0 + 1, `${dedupeProbe.n0} → ${dedupeProbe.n1}`);
check("同样内容 + dedupe → 打上 dup 标记", dedupeProbe.autoDup, JSON.stringify(dedupeProbe));
check("交回的是**已有那一条**，不是新建", dedupeProbe.autoIsFirst && dedupeProbe.autoTitle === "紫色-首次.png", dedupeProbe.autoTitle);
check("dedupe 命中不新增条目", dedupeProbe.n2 === dedupeProbe.n1, `${dedupeProbe.n1} → ${dedupeProbe.n2}`);
check("手动保存不带 dedupe → 照样新增", dedupeProbe.manualNew && dedupeProbe.n3 === dedupeProbe.n2 + 1, `${dedupeProbe.n2} → ${dedupeProbe.n3}`);
check("手动保存不会被误标成重复", dedupeProbe.manualDup === false);
/* 注意：这里**不**断言三条共用同一个 relPath。仓库路径是 `<月>/<hash8>-<标题>`，
   带标题意味着"同内容不同标题"本来就是两个路径（手动再存一份时文件也存两份）。
   去重判的是 hash，不是路径 —— 断言路径相同只会得出一个错的结论。 */
check("三条记录的内容哈希相同（去重正是按它判的）",
  dedupeProbe.hashes.first === dedupeProbe.hashes.auto &&
    dedupeProbe.hashes.manual === dedupeProbe.hashes.first,
  JSON.stringify(dedupeProbe.hashes));
check("去重交回的那条连路径都沿用旧的",
  dedupeProbe.paths.auto === dedupeProbe.paths.first, JSON.stringify(dedupeProbe.paths));

/* ------------------------------ 收尾 ------------------------------ */

check("全程没有控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

console.log(`\n${"=".repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(52));
process.exit(failed ? 1 : 0);
