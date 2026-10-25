/**
 * 「异常单号登记」整本重写后的行为回归（jsdom + 假宿主，不连网、不开真应用）。
 *
 * 为什么要有这一套：`node --check` 只能证明语法对，`tool:audit` 只能证明登记点齐，
 * 两个都证明不了「页面起得来、四个页签切得动、登记一条能落库、分享链接绑得上」。
 * 而这个文件 2026-10-19 整本重写过一次 —— 重写最容易丢的就是这类"跑起来才知道"的东西
 * （上一版有、重写时漏掉、静态检查一条都不会报）。
 *
 * 所以这里用 jsdom 真的把 index.html 跑起来，测试自己冒充宿主回包。
 * 假宿主的回包形状**必须与 src/lib/toolBridge.ts 一致**（尤其 wps.mcpPull 的
 * { header, adds, updates }），否则这里绿了、真接线时照样对不上。
 *
 * 重点防的回潮（每一条都对应一段注释，改代码前先看那段）：
 *   · 16/19 位纯数字的订单号**必须能登记** —— 用户自己库里就是这种号，
 *     形状检查只能提示、不能拦（拦了就是"工具不让我录"）；
 *   · 同一订单号第二次点才放行（手滑 90%，但补发后又出问题是真要录）；
 *   · 对账与写库只在宿主（Rust），工具页不许自己算；
 *   · 写库后靠宿主的 kwiki:pulled 事件重画。
 *
 * 用法：npm run ticket:test
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "tools/abnormal-ticket/index.html"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log("  PASS  " + name); return; }
  fail++;
  failures.push(name + (extra ? " — " + extra : ""));
  console.log("  FAIL  " + name + (extra ? "  → " + extra : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等界面真的变过来 —— 记一步流程要 cancel + book + update + load 好几个来回，
    固定 sleep 很容易在"还没重画"的时候点到旧 DOM（旧闭包里的 flow 会把新加的步覆盖掉）。 */
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(30);
  }
  return false;
}

/** 模拟用户选文件。
 *
 *  ★ 必须连「input.value = "" 会**就地清空** FileList」一起模拟 —— Chromium 就是
 *  这么干的（无头 Chrome 实测：先抓 `input.files` 的引用再清空，拿到的 length 是 0；
 *  先搬进真数组再清，才是完整的两张）。而 jsdom 里 `files` 是咱们自己塞的普通数组，
 *  清 value 根本碰不到它 —— 于是「选完图静默无反应」这种 bug 在测试里永远看不见。
 *  这里让 getter 返回同一个列表对象、value 的 setter 把它清空，就跟真浏览器一致了。 */
function pickFiles(doc, win, inputId, files) {
  const el = doc.getElementById(inputId);
  if (!el) throw new Error("找不到文件框 " + inputId);
  const list = [];
  files.forEach((f, i) => { list[i] = f; });
  list.length = files.length;
  Object.defineProperty(el, "files", { configurable: true, get: () => list });
  Object.defineProperty(el, "value", {
    configurable: true,
    get: () => "",
    set: (v) => {
      if (v) return;
      for (let i = 0; i < list.length; i++) delete list[i];
      list.length = 0;                 // 就地清空：外部抓着的引用也一起变空
    },
  });
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
  return el;
}

/* ---------------- 假宿主 ---------------- */
const store = [];          // 台账行
const pushLog = [];        // 推送记录（工具只会 insert / select 它）
const imgStore = [];       // 订单附图关联（工具只会 insert / select / delete）
const gallery = [];        // 假图床：gallery.put 往里放，gallery.get 从里取

/* 一条 v1.11.0 之前存下的附图：宿主那时生成缩略图是坏的（把跨源的图直接画到
   canvas 上 → 画布被污染 → toDataURL 抛 SecurityError → 上层 catch 掉回空串），
   于是 thumb 存成了空串，界面上就是格子里的「无预览」。启动时工具该自己补回来
   （见 index.html 的 healThumbs）。 */
imgStore.push({
  id: "legacy-img-1", ticket_id: "legacy-ticket-1", gallery_id: "g-legacy",
  thumb: "", name: "旧图.png", step_uid: "", sort: 0, created_at: "2026-10-01 09:00",
});
gallery.push({
  id: "g-legacy", title: "旧图", kind: "image", thumb: "",
  dataUrl: "data:image/jpeg;base64,OLDORIGINAL",
});
/** 只算测试里当场挂上去的关联：预置那条 legacy 是给"补缩略图"用的，
    不计进"这时有几条关联"这类计数 */
const liveImgs = () => imgStore.filter((r) => r.id !== "legacy-img-1");
let pushLogDeletes = 0;    // 断言「只增不删」：这里必须一直是 0
let pushFail = "";         // 非空 = 下一次推送直接失败（测失败也留痕）
const kv = {};             // 工具 kv
const ops = [];            // 收到的 op 流水
const args = [];           // 每个 op 的参数（要看推送第一步是不是 dryRun）
let shellFail = null;      // 模拟旧宿主（不认识 shell.open）或系统唤不起来

// 预置店铺表：其中一个挂着客服 ID 987654 —— ERP 链接里就写这个，
// 好验证「粘链接 → 店铺自动认出来」这条路。
kv["stores"] = JSON.stringify([
  { name: "拼5", mallcsid: "987654" },
  { name: "拼多多5店", mallcsid: "" },
]);

function reply(win, id, ok, data, error) {
  win.postMessage(
    { source: "workbench-host", type: "tool:response", id, ok, data, error },
    "*",
  );
}
function newId() {
  return "t" + (store.length + 1) + "-" + Math.random().toString(36).slice(2, 8);
}

function host(win, e) {
  const m = e.data;
  if (!m || m.source !== "workbench-tool" || m.type !== "tool:request") return;
  ops.push(m.op);
  const p = m.payload || {};
  args.push({ op: m.op, payload: p });
  switch (m.op) {
    case "row.select": {
      // 三张表：台账 store / 推送记录 pushLog / 附图关联 imgStore。
      // 真宿主单次最多给 200 行，工具会按 total 翻页 —— 这里也照做（offset + total）
      let rows = p.table === "push_log" ? pushLog.slice()
        : p.table === "ticket_images" ? imgStore.slice()
        : store.slice();
      if (p.table === "push_log") {
        if (p.where && p.where.push_result) {
          rows = rows.filter((r) => r.push_result === p.where.push_result);
        }
        rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      }
      if (p.table === "ticket_images") {
        rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      }
      const total = rows.length;
      const offset = Math.max(0, Number(p.offset) || 0);
      if (offset) rows = rows.slice(offset);
      if (p.limit) rows = rows.slice(0, p.limit);
      reply(win, m.id, true, { rows, total });
      return;
    }
    case "row.count": {
      let rows = p.table === "push_log" ? pushLog : p.table === "ticket_images" ? imgStore : store;
      if (p.where) {
        rows = rows.filter((r) => Object.keys(p.where).every((k) => String(r[k]) === String(p.where[k])));
      }
      reply(win, m.id, true, { count: rows.length });
      return;
    }
    case "row.insert": {
      const target = p.table === "push_log" ? pushLog : p.table === "ticket_images" ? imgStore : store;
      const row = Object.assign({ id: newId(), created_at: new Date().toISOString() }, p.row || {});
      target.push(row);
      reply(win, m.id, true, { row });
      return;
    }
    case "row.update": {
      // 必须按 p.table 分派：只查台账的话，探列 / 补缩略图这类对附图表的更新
      // 会"成功但没改到"，测试绿着、真机上什么事都没发生
      const arr = p.table === "push_log" ? pushLog : p.table === "ticket_images" ? imgStore : store;
      const row = arr.find((r) => r.id === p.id) || null;
      if (row) Object.assign(row, p.patch || {});
      reply(win, m.id, true, { row });
      return;
    }
    case "row.delete": {
      if (p.table === "push_log") pushLogDeletes++;
      const arr = p.table === "push_log" ? pushLog : p.table === "ticket_images" ? imgStore : store;
      const i = arr.findIndex((r) => r.id === p.id);
      if (i >= 0) arr.splice(i, 1);
      reply(win, m.id, true, { ok: true });
      return;
    }
    /* ---- 图床（工具只碰 gallery.put / get） ---- */
    case "gallery.put": {
      const id = "g" + (gallery.length + 1);
      const item = {
        id,
        title: p.title || "",
        kind: "image",
        /* ★ 照真宿主现在的样子回空串：它那边生成缩略图要跨源画布导出，
           会抛 SecurityError 被 catch 掉。工具必须自己能出缩略图 —— 这里要是
           回一段假的 data URL，就把「无预览」这个 bug 又盖住了。 */
        thumb: "",
        dataUrl: p.dataUrl || "",        // gallery.get 要用（真宿主回原图字节）
      };
      gallery.push(item);
      reply(win, m.id, true, item);
      return;
    }
    case "gallery.get": {
      const it = gallery.find((g) => g.id === p.id) || null;
      if (!it) { reply(win, m.id, false, null, "这条记录不在图床里（可能已被删除）"); return; }
      reply(win, m.id, true, {
        id: it.id, title: it.title, kind: "image",
        dataUrl: it.dataUrl || it.thumb, mime: "image/jpeg", width: 800, height: 600,
      });
      return;
    }
    case "kv.get":
      reply(win, m.id, true, { value: kv[p.key] ?? null });
      return;
    case "kv.set":
      kv[p.key] = p.value;
      reply(win, m.id, true, { ok: true });
      return;
    case "task.remind":
      reply(win, m.id, true, { taskId: "task-1" });
      return;
    case "wps.mcpLink":
      reply(win, m.id, true, {
        file: {
          id: "575451541893",
          name: "测试异常单.ksheet",
          linkId: "ca1BaaQrrGVT",
          permission: "readWrite",
          owner: "大苏打",
        },
      });
      return;
    case "wps.mcpPush":
      if (pushFail) { reply(win, m.id, false, null, pushFail); return; }
      // 增量口径：新增 1 行、改 2 个格，表上还有 1 行本地没有（默认留着不动）
      // force：那一行会被清空 → removed=1
      // ★ diffs 是 v1.14.0 加的逐格明细（宿主 Rust 的 plan_diff 算的）：
      //   确认框要把"表上原值 → 本机值"摊开，只报数字没人敢点。
      reply(win, m.id, true, {
        count: store.length,
        appended: 0,
        added: 1,
        changed: 2,
        orphanRows: 1,
        removed: p.force === true ? 1 : 0,
        dryRun: p.dryRun === true,
        diffs: [
          {
            key: "6931234567890123456",
            row: 3,
            fields: [
              { label: "快递单号", from: "SF0001", to: "SF9999" },
              { label: "情况", from: "表上写的", to: "本机写的" },
            ],
          },
        ],
      });
      return;
    case "wps.mcpPull":
      // 与 toolBridge.ts 的 mcpPull 回包同形：
      //   { header, adds:[{key,store,status}], updates:[{…,changes,diffs:[{col,label,from,to}]}] }
      // ★ diffs 是 v1.14.0 加的字段级明细：真宿主会给，假宿主不给就等于
      //   确认框里永远是空的 —— 那种"测试绿、真机没内容"最坑。
      reply(win, m.id, true, {
        header: ["订单号", "快递单号"],
        adds: [{ key: "261020-111111111111", store: "拼5", status: "待处理" }],
        updates: [{
          key: "6931234567890123456", store: "拼5", status: "处理中",
          changes: ["情况"],
          diffs: [{ col: "category", label: "情况", from: "表上写的", to: "本机写的" }],
        }],
      });
      return;
    case "wps.mcpApply":
      reply(win, m.id, true, { added: 1, updated: 0 });
      return;
    /* ---- 唤起客户端（宿主侧 ShellExecute，工具只递链接） ---- */
    case "shell.open":
      if (shellFail) { reply(win, m.id, false, null, shellFail); return; }
      reply(win, m.id, true, { url: p.url });
      return;
    default:
      reply(win, m.id, false, null, "假宿主不认识这个 op: " + m.op);
  }
}

/* ---------------- 起页面 ---------------- */
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.message || e)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(HTML, {
  url: "http://localhost/abnormal-ticket/index.html",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const win = dom.window;
const doc = win.document;

/* 画布 / 图片：jsdom 没有 canvas，而工具现在**自己**压 320 缩略图（不再靠宿主回传）。
   给个最小实现，让这条真实路径也跑起来 —— 不然 canCanvas() 是 false、缩略图恒为空，
   「无预览」就会被当成正常。 */
win.HTMLCanvasElement.prototype.getContext = function () {
  return { fillStyle: "", fillRect() {}, drawImage() {} };
};
win.HTMLCanvasElement.prototype.toDataURL = function (type) {
  return "data:" + (type || "image/png") + ";base64,TOOLTHUMB";
};
win.Image = function () {
  const self = this;
  this.naturalWidth = 800;
  this.naturalHeight = 600;
  this.onload = null;
  this.onerror = null;
  let src = "";
  Object.defineProperty(this, "src", {
    get() { return src; },
    set(v) { src = v; win.setTimeout(function () { if (self.onload) self.onload(); }, 0); },
  });
};
win.addEventListener("message", (e) => host(win, e));
win.addEventListener("error", (e) => errors.push("window.error: " + (e.message || e)));

await sleep(120);
// gallery: true —— 附图区靠它在页面上显形（body[data-gallery="on"]）
win.postMessage({ source: "workbench-host", type: "tool:context", data: { theme: "light", gallery: true } }, "*");
await sleep(200);

console.log("1. 页面起得来");
check("没有未捕获报错", errors.length === 0, errors.join(" | "));
check("连上了宿主（bindState=bound）", doc.body.dataset.bindState === "bound", doc.body.dataset.bindState);
check("状态点写着「已连工作台」", (doc.getElementById("hostState")?.textContent || "").includes("已连工作台"));

/* 老行（宿主当年生成缩略图失败 → thumb 存成空串）在启动时该自己补回来。
   不补的话，那几格永远写着「无预览」，用户只能删了重挂。 */
await waitFor(() => !!imgStore.find((r) => r.id === "legacy-img-1")?.thumb, 4000);
const healedThumb = imgStore.find((r) => r.id === "legacy-img-1")?.thumb || "";
check("没有缩略图的老行会在启动时自己补上", /^data:image\//.test(healedThumb), healedThumb.slice(0, 40));

console.log("\n2. 五个页签切得动");
for (const [tab, view] of [["browse", "view-browse"], ["table", "view-table"], ["log", "view-log"], ["settings", "view-settings"], ["create", "view-create"]]) {
  doc.getElementById("tab-" + tab).click();
  await sleep(30);
  const v = doc.getElementById(view);
  const others = ["view-create", "view-browse", "view-table", "view-log", "view-settings"].filter((x) => x !== view);
  check(
    `点「${tab}」→ ${view} 显示、其余隐藏`,
    !v.hidden && others.every((o) => doc.getElementById(o).hidden === true),
    "hidden=" + v.hidden,
  );
}

console.log("\n3. 登记一条（ERP 链接识别 + 19 位纯数字不拦）");
doc.getElementById("tab-create").click();
await sleep(30);
check("订单号在最上面那条大横条里", !!doc.querySelector(".bigbar > #fOrder"),
  doc.getElementById("fOrder") ? doc.getElementById("fOrder").parentNode.className : "没有 fOrder");
check("店铺是胶囊选项（不是下拉）", doc.getElementById("fStore").querySelectorAll(".pill").length > 0,
  String(doc.getElementById("fStore").querySelectorAll(".pill").length));
check("快递公司 / 情况也是胶囊", doc.getElementById("fCourier").querySelectorAll(".pill").length > 0 &&
  doc.getElementById("fCategory").querySelectorAll(".pill").length > 0);
check("标签上画了图标", doc.querySelectorAll(".lbl svg.ico").length >= 4,
  String(doc.querySelectorAll(".lbl svg.ico").length));

// 胶囊：点一下选中，再点一下取消
{
  const courier = doc.getElementById("fCourier");
  const p0 = courier.querySelectorAll(".pill")[0];
  const v0 = p0.getAttribute("data-v");
  p0.click();
  await sleep(20);
  check("点胶囊选中了", courier.getAttribute("data-value") === v0 && p0.classList.contains("on"),
    courier.getAttribute("data-value"));
  p0.click();
  await sleep(20);
  check("再点一次取消（选错了不用翻设置页）", courier.getAttribute("data-value") === "",
    JSON.stringify(courier.getAttribute("data-value")));
  p0.click();
  await sleep(20);
}

const fOrder = doc.getElementById("fOrder");
fOrder.value = "https://mobile.pdd.com/?mallcsid=987654&ordersn=6931234567890123456";
fOrder.dispatchEvent(new win.Event("paste", { bubbles: true }));   // 粘贴要等浏览器先写值 → 走 setTimeout
await sleep(120);
check("整条 ERP 链接被拆成订单号", doc.getElementById("fOrder").value === "6931234567890123456",
  doc.getElementById("fOrder").value);
check("链接里的客服 ID 反查出了店铺（不用手选）", doc.getElementById("fStore").getAttribute("data-value") === "拼5",
  doc.getElementById("fStore").getAttribute("data-value"));
// ★ 用户库里真实存在的就是 16/19 位纯数字，不是 YYMMDD-数字 —— 形状存疑只许提示，不许拦
const hint1 = doc.getElementById("addMsg").textContent || "";
check("形状存疑只提示（提示条有字）", /格式存疑|定位不到/.test(hint1), hint1.slice(0, 90));

doc.getElementById("fTrack").value = "YT9988776655";
doc.getElementById("fTitle").value = "包裹破损，客户要求赔偿";
doc.getElementById("btnAdd").click();
await sleep(200);
check("19 位纯数字照样登记进去了（没被形状拦住）", store.length === 1, JSON.stringify(store.length));
check("订单号原样存（19 位没被吃）", store[0]?.order_sn === "6931234567890123456", store[0]?.order_sn);
check("快递单号存上了", store[0]?.tracking_no === "YT9988776655", store[0]?.tracking_no);

console.log("\n4. 重复登记：第一下拦、第二下放行");
doc.getElementById("fOrder").value = "6931234567890123456";
doc.getElementById("fTrack").value = "YT1111111111";
doc.getElementById("btnAdd").click();
await sleep(150);
check("第一次点：没落库", store.length === 1, String(store.length));
const addMsg = doc.getElementById("addMsg").textContent || "";
check("第一次点：给了重复提示", /已经登记过/.test(addMsg), addMsg.slice(0, 90));
check("提示里有「再点一次」的出路", /再点一次/.test(addMsg), addMsg.slice(0, 140));

doc.getElementById("btnAdd").click();
await sleep(200);
check("第二次点：确实放行（补发后又出问题这种）", store.length === 2, String(store.length));

console.log("\n5. 查看 / 表格页能看到这条");
doc.getElementById("tab-browse").click();
await sleep(80);
check("列表里有这条", (doc.getElementById("list").textContent || "").includes("6931234567890123456"));
doc.getElementById("tab-table").click();
await sleep(80);
const body = doc.getElementById("tableBody");
check("表格渲染出行", body.querySelectorAll("tr").length >= 1, String(body.querySelectorAll("tr").length));
check("表格里能搜到这条单号", (body.textContent || "").includes("6931234567890123456"));
check("表头 15 列（台账 14 列 + 赔款数）", doc.getElementById("tableHead").querySelectorAll("th").length === 15,
  String(doc.getElementById("tableHead").querySelectorAll("th").length));
/* 时间列一律到分钟：老数据的 ISO（带 T/Z、还是 UTC）也要转成本地写法 */
{
  const heads = Array.from(doc.getElementById("tableHead").querySelectorAll("th")).map((th) => th.textContent.trim());
  const cells = Array.from(body.querySelectorAll("tr")[0].querySelectorAll("td")).map((td) => td.textContent.trim());
  const at = (name) => cells[heads.indexOf(name)] || "";
  check("表格「登记时间」精确到分钟", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at("登记时间")), at("登记时间"));
  check("表格「登记时刻」到分钟、不带 T/Z", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at("登记时刻")), at("登记时刻"));
}

console.log("\n5b. 查看页能补全 / 改信息（默认锁着，点「编辑」才开）");
doc.getElementById("tab-browse").click();
await sleep(80);
doc.querySelector('#list .ticket[data-id="' + store[0].id + '"]').click();
await sleep(80);
check("详情里有订单号框", !!doc.getElementById("dOrder"));
check("订单号预填的是这条的原值", doc.getElementById("dOrder").value === "6931234567890123456",
  doc.getElementById("dOrder").value);
check("快递单号也预填了", doc.getElementById("dTrack").value === "YT9988776655",
  doc.getElementById("dTrack").value);
/* 锁态下这三格只摆值：有值 = 一个只读标签，没值 = 灰字「未填」。
   （这条单的「情况」本来就没填 —— 正好覆盖"未填"这一支） */
check("锁态的快递公司 / 店铺 / 情况都给出了可见的值",
  ["dCourier", "dStore", "dCategory"].every((id) => {
    const el = doc.getElementById(id);
    return el.querySelectorAll(".pill.ro").length === 1 || /未填/.test(el.textContent || "");
  }), ["dCourier", "dStore", "dCategory"].map((id) => id + "=" +
    (doc.getElementById(id).textContent || "").trim()).join(" | "));
check("没填的那格显示「未填」（不是一片空框）",
  /未填/.test(doc.getElementById("dCategory").textContent || ""),
  doc.getElementById("dCategory").textContent);
check("店铺胶囊高亮在这条的店铺上",
  doc.getElementById("dStore").getAttribute("data-value") === "拼5" &&
  !!doc.getElementById("dStore").querySelector(".pill.on"),
  doc.getElementById("dStore").getAttribute("data-value"));

/* ★ 默认锁着：不让顺手改单号（单号一改，推给 WPS 的表也跟着变） */
check("基本信息默认锁着", doc.getElementById("dOrder").disabled === true);
check("锁态只摆已选值，不铺所有选项",
  doc.getElementById("dCourier").querySelectorAll("button.pill").length === 0
  && doc.getElementById("dCourier").querySelectorAll(".pill.ro").length === 1,
  "button=" + doc.getElementById("dCourier").querySelectorAll("button.pill").length
  + " 只读标签=" + doc.getElementById("dCourier").querySelectorAll(".pill.ro").length);
check("锁态标签就是这条的值", /^申通|^顺丰|^中通|^圆通|^韵达|^邮政|^京东/.test(
  (doc.getElementById("dCourier").textContent || "").trim()),
  doc.getElementById("dCourier").textContent);
check("锁着时不给保存按钮", !doc.getElementById("btnEdit"));
check("标题上挂着「编辑」按钮", /编辑/.test(doc.getElementById("btnBaseToggle").textContent || ""),
  doc.getElementById("btnBaseToggle").textContent);
check("锁着时有句说明", /锁着/.test(doc.querySelector("#sectBase .basehint")?.textContent || ""),
  doc.querySelector("#sectBase .basehint")?.textContent);
{
  const beforeUpd = args.filter((a) => a.op === "row.update").length;
  const keep = doc.getElementById("dCourier").getAttribute("data-value");
  doc.querySelector("#dCourier .pill").click();
  await sleep(20);
  check("锁态点那个只读标签不生效", args.filter((a) => a.op === "row.update").length === beforeUpd
    && doc.getElementById("dCourier").getAttribute("data-value") === keep,
    "点完还是 " + doc.getElementById("dCourier").getAttribute("data-value") + "（原 " + keep + "）");
}

doc.getElementById("btnBaseToggle").click();
await sleep(80);
check("点「编辑」解锁了", doc.getElementById("dOrder").disabled === false);
check("解锁后选项才铺出来", doc.getElementById("dCourier").querySelectorAll("button.pill").length >= 3,
  "选项数=" + doc.getElementById("dCourier").querySelectorAll("button.pill").length);
check("解锁后胶囊能点", Array.from(doc.getElementById("dCourier").querySelectorAll(".pill"))
  .every((b) => b.disabled === false));
check("解锁后才有保存 / 撤掉", !!doc.getElementById("btnEdit") && !!doc.getElementById("btnEditUndo"));
check("标题变成「编辑中」", /编辑中/.test(doc.querySelector("#sectBase h3").textContent || ""),
  doc.querySelector("#sectBase h3").textContent);

{ // 补全：快递公司换一个（登记页那次选的会带过来，所以挑个跟当前值不同的）；描述改一句
  const dCourier = doc.getElementById("dCourier");
  const cur = dCourier.getAttribute("data-value") || "";
  const pills = Array.from(dCourier.querySelectorAll(".pill"));
  const target = pills.find((b) => b.getAttribute("data-v") !== cur) || pills[0];
  const pick = target.getAttribute("data-v");
  target.click();
  await sleep(20);
  check("胶囊跟着点了换（不是取消了）", dCourier.getAttribute("data-value") === pick,
    dCourier.getAttribute("data-value"));
  doc.getElementById("dTitle").value = "客户确认破损，走赔付";
  const before = args.filter((a) => a.op === "row.update").length;
  doc.getElementById("btnEdit").click();
  await sleep(220);
  check("保存走了 row.update", args.filter((a) => a.op === "row.update").length === before + 1,
    String(args.filter((a) => a.op === "row.update").length));
  const up = args.filter((a) => a.op === "row.update").pop();
  check("补全的快递公司写进去了", up.payload.patch.courier === pick,
    JSON.stringify(up.payload.patch));
  check("改过的描述写进去了", up.payload.patch.title === "客户确认破损，走赔付");
  check("订单号 / 快递单号原样带上（没被清空）",
    up.payload.patch.order_sn === "6931234567890123456" && up.payload.patch.tracking_no === "YT9988776655",
    JSON.stringify(up.payload.patch));
  check("库里那条真的变了", store.find((r) => r.id === up.payload.id)?.courier === pick,
    String(store.find((r) => r.id === up.payload.id)?.courier));
  check("重画后框里是改后的值", doc.getElementById("dTitle").value === "客户确认破损，走赔付",
    doc.getElementById("dTitle").value);
  check("改完给了回显", /已保存/.test(doc.getElementById("editMsg").textContent || ""),
    doc.getElementById("editMsg").textContent);
  /* ★ 存完自动回锁 —— 别让输入框一直敞着 */
  check("保存后自动回锁", doc.getElementById("dOrder").disabled === true);
  check("回锁后保存按钮收起来了", !doc.getElementById("btnEdit"));
}

{ // 解锁改了不想要 → 「撤掉改动」回去，库不能动
  const beforeUpd = args.filter((a) => a.op === "row.update").length;
  doc.getElementById("btnBaseToggle").click();
  await sleep(80);
  doc.getElementById("dTitle").value = "这是临时写的，不该落库";
  doc.getElementById("btnEditUndo").click();
  await sleep(120);
  check("撤掉改动没写库", args.filter((a) => a.op === "row.update").length === beforeUpd,
    String(args.filter((a) => a.op === "row.update").length));
  check("撤掉后框里回到原值", doc.getElementById("dTitle").value === "客户确认破损，走赔付",
    doc.getElementById("dTitle").value);
  check("撤掉后也回锁", doc.getElementById("dOrder").disabled === true);
}

{ // 换一条单子：解锁态不能跟着过去
  const items = doc.querySelectorAll("#list .ticket");
  doc.getElementById("btnBaseToggle").click();
  await sleep(80);
  check("（前置）当前这条解锁着", doc.getElementById("dOrder").disabled === false);
  /* 点「另一条」：不能按下标取 —— 排序生效后 items[1] 可能正是当前这条 */
  const other = [...items].find((x) => x.getAttribute("data-id") !== store[0].id);
  if (other) { other.click(); await sleep(120); }
  else { doc.getElementById("btnBaseToggle").click(); await sleep(120); }
  check("切到别的单子自动回锁", doc.getElementById("dOrder").disabled === true);
}

console.log("\n5c. 提醒按流程派发（登记后默认 N 小时）");
{
  /* ① 登记那一刻就订上了 —— 不用用户再去点一次「设提醒」 */
  const r0 = store[0];
  const created = new Date(r0.created_at).getTime();
  const at0 = new Date(r0.remind_at).getTime();
  check("登记后就写了提醒时刻（自动派发）", !!r0.remind_at, JSON.stringify(r0.remind_at));
  check("默认是登记后 24 小时", Math.abs(at0 - (created + 24 * 3600000)) < 60000,
    ((at0 - created) / 3600000).toFixed(2) + " 小时");
  const booked = args.filter((a) => a.op === "task.remind" && a.payload.action !== "cancel");
  check("提醒落到了宿主待办（task.remind）", booked.length >= 1, String(booked.length));
  check("待办标题带单号", /异常单跟进/.test(booked[0]?.payload.title || ""), booked[0]?.payload.title);
  check("备注说清了为什么是这个时刻", /登记后 24 小时|流程停在/.test(booked[0]?.payload.note || ""),
    booked[0]?.payload.note);
  check("待办 id 记回了本地行", !!r0.remind_task, JSON.stringify(r0.remind_task));

  /* ② 详情页顺序：基本信息 → 提醒（「处理」区已移除 —— 处理是流程的一部分，状态由流程派生）；
       流程**单开右栏一栏**（时间线竖着长，单独占一列） */
  doc.getElementById("tab-browse").click();
  await sleep(60);
  doc.querySelector('#list .ticket[data-id="' + store[0].id + '"]').click();
  await sleep(80);
  const sects = Array.from(doc.querySelectorAll("#detail .sect > h3")).map((h) => h.textContent.trim());
  check("主栏分区顺序是 基本信息 → 整单图片 → 提醒（处理区已移除）",
    sects.length === 3 && /^基本信息/.test(sects[0]) && /^整单图片/.test(sects[1]) && sects[2] === "跟进提醒",
    sects.join(" / "));
  check("处理区不再渲染（处理方式/结果/结账都没有）",
    doc.getElementById("dHandling") === null && doc.getElementById("dResult") === null &&
    doc.getElementById("dSettled") === null && doc.getElementById("btnProc") === null);
  check("流程状态在右栏单独一张卡",
    /流程状态/.test(doc.querySelector("#flowPane h2")?.textContent || ""),
    doc.querySelector("#flowPane h2")?.textContent);
  check("流程栏不再混在主栏里",
    doc.querySelectorAll("#flowPane .tlitem").length === 0 &&
    doc.querySelectorAll("#detail[data-delflow]").length === 0);
  const why0 = doc.querySelector("#detail .remindbox .why")?.textContent || "";
  check("提醒区说清了是按流程派发", /按流程派发/.test(why0), why0.slice(0, 120));

  /* ③ 间隔改 1 小时 + 记一步流程 → 提醒顺延（旧待办撤掉，按新基准重订） */
  doc.getElementById("tab-settings").click();
  await sleep(60);
  doc.getElementById("optRemindHours").value = "1";
  doc.getElementById("saveRemind").click();
  await sleep(120);
  check("间隔存进了宿主 kv", kv["remindHours"] === "1", String(kv["remindHours"]));

  doc.getElementById("tab-browse").click();
  await sleep(60);
  doc.querySelector('#list .ticket[data-id="' + store[0].id + '"]').click();
  await sleep(60);
  const cancelsBefore = args.filter((a) => a.op === "task.remind" && a.payload.action === "cancel").length;
  doc.getElementById("dFlow").value = "已联系快递";
  doc.getElementById("btnFlow").click();
  await waitFor(() => doc.querySelectorAll("#flowPane .tlitem").length === 1);
  await sleep(60);
  check("流程时间线：单步就点亮（cur）",
    doc.querySelector("#flowPane .tlitem")?.classList.contains("cur") === true);
  /* 「记一步」按钮在描述框下面（DOM 顺序），且是整行宽的大按钮 */
  const note3 = doc.getElementById("dFlowNote"), btn3 = doc.getElementById("btnFlow");
  check("记一步按钮在描述框下面",
    !!(note3 && btn3 && (btn3.compareDocumentPosition(note3) & 2)), // 2 = PRECEDING：描述框在按钮前面
    "note=" + !!note3 + " btn=" + !!btn3);
  check("记一步是整行宽的大按钮（包在 .flowform 动作面板里，宽度由样式给）",
    !!btn3 && !!btn3.closest(".flowform") &&
    /\.flowform\s*>\s*\.primary\s*\{[^}]*width:\s*100%/.test(doc.querySelector("style").textContent),
    "form=" + !!btn3?.closest(".flowform"));
  check("流程栏顶有大字倒计时（还有 …，未逾期不标红）",
    /还有/.test(doc.querySelector("#flowPane .cd")?.textContent || "") &&
    !doc.querySelector("#flowPane .cd")?.classList.contains("late"),
    doc.querySelector("#flowPane .cd")?.className + " / " + doc.querySelector("#flowPane .cd")?.textContent);
  /* 逾期才标红：工具只在「逾期」时给大字挂 .late —— 正常态是正文色。
     这里查样式（运行态的逾期要改库再 load，属于下一节的事），
     上面那条已经验过"没逾期时不带 late"。 */
  const cdCss = doc.querySelector("style").textContent;
  check("倒计时：正常态正文色、逾期才用危险色",
    /\.cd\s*\{[^}]*color:\s*var\(--fg\)/.test(cdCss) &&
    /\.cd\.late\s*\{[^}]*color:\s*var\(--danger\)/.test(cdCss),
    (cdCss.match(/\.cd\s*\{[^}]*\}/) || [""])[0].slice(0, 60));
  const r1 = store.find((x) => x.id === r0.id);
  const at1 = new Date(r1.remind_at).getTime();
  check("记一步流程 → 提醒按新基准重算（1 小时）",
    Math.abs(at1 - (Date.now() + 3600000)) < 90000,
    ((at1 - Date.now()) / 3600000).toFixed(2) + " 小时");
  check("换时刻 = 先撤旧待办",
    args.filter((a) => a.op === "task.remind" && a.payload.action === "cancel").length > cancelsBefore);
  check("流程步里存了机器可读时刻 at", /"at":"\d{4}-\d\d-\d\dT/.test(r1.flow), r1.flow.slice(0, 110));
  const lastBook = args.filter((a) => a.op === "task.remind" && a.payload.action !== "cancel").pop();
  check("备注改成「流程停在…」", /流程停在「已联系快递」/.test(lastBook?.payload.note || ""),
    lastBook?.payload.note);

  /* ③½ 没选阶段就点「记一步」→ 当场提示，不静默吞掉（记录丢失的真凶就是这个静默返回） */
  doc.getElementById("dFlow").value = "";
  doc.getElementById("dFlowNote").value = "只有记录、没选阶段";
  doc.getElementById("toast").innerHTML = "";   // 清场：别让上一条 toast 的 2.6s 定时器干扰计数
  doc.getElementById("btnFlow").click();
  await sleep(60);
  check("没选阶段就记一步 → 当场提示而不是静默吞掉",
    /先选一个阶段/.test(doc.getElementById("toast").textContent || ""),
    doc.getElementById("toast").textContent);
  check("这条记录没有被存进 flow", !/"d":"只有记录/.test(store.find((x) => x.id === r0.id).flow));

  /* ④ 记到「完结」→ 提醒自动撤掉；这一步带上记录（记录=这一步的正文） */
  doc.getElementById("dFlow").value = "完结";
  doc.getElementById("dFlowNote").value = "客户同意补发，赠品已补寄并签收，双方无异议";
  doc.getElementById("btnFlow").click();
  await waitFor(() => /已完结/.test(doc.querySelector("#detail .remindbox")?.textContent || ""));
  await sleep(60);
  const r2 = store.find((x) => x.id === r0.id);
  check("记录跟着这一步存进了 flow", /"d":"客户同意补发/.test(r2.flow) && !/"by":/.test(r2.flow),
    r2.flow.slice(0, 200));
  /* 结构：进度标题（阶段名）→ 标题下灰色小字描述 → 时刻 */
  const topItem = doc.querySelector("#flowPane .tlitem");
  check("进度标题是阶段名", /完结/.test(topItem?.querySelector(".nm")?.textContent || ""),
    topItem?.textContent.slice(0, 80));
  check("记录以灰色小字显示在标题下", /客户同意补发/.test(topItem?.querySelector(".ds")?.textContent || ""));
  check("meta 行没有处理人", topItem?.querySelector(".by") === null &&
    /"by"/.test(r2.flow) === false);
  check("完结后倒计时消失", doc.querySelector("#flowPane .cd") === null);
  check("完结后提醒时刻清空", r2.remind_at === "", JSON.stringify(r2.remind_at));
  check("完结后待办 id 也清空", r2.remind_task === "", JSON.stringify(r2.remind_task));
  const box2 = doc.querySelector("#detail .remindbox")?.textContent || "";
  check("详情页说「已完结，提醒撤了」", /已完结/.test(box2), box2.slice(0, 90));

  /* ④½ 时间线读法：最新一步在最上面 + 收起 / 展开 */
  const tlItems = [...doc.querySelectorAll("#flowPane .tlitem")];
  check("时间线最新一步排在最上面", /完结/.test(tlItems[0]?.textContent || "") &&
    !/完结/.test(tlItems[1]?.textContent || ""), tlItems.map((x) => x.textContent.slice(0, 20)).join(" | "));
  check("完结步的点亮成绿色（done）",
    tlItems[0]?.classList.contains("done") === true);
  doc.getElementById("btnFlowFold").click();
  await sleep(60);
  check("收起后时间线藏了、提示还剩一句",
    doc.querySelectorAll("#flowPane .tlitem").length === 0 &&
    /已收起 2 步/.test(doc.getElementById("flowPane").textContent));
  doc.getElementById("btnFlowFold").click();
  await sleep(60);
  check("展开又回来了", doc.querySelectorAll("#flowPane .tlitem").length === 2);

  /* ⑤ 删掉完结步 → 重新派发；再试「不用提醒 / 恢复提醒」 */
  await waitFor(() => doc.querySelectorAll("#flowPane [data-delflow]").length >= 2);
  const delBtns = doc.querySelectorAll("#flowPane [data-delflow]");
  delBtns[0].click();     // 时间线最新一步在最上面 —— 第一颗删的就是「完结」
  await sleep(80);
  doc.getElementById("dlgYes").click();   // 现在删流程步要先按一下「删除」（自绘确认框）
  await waitFor(() => !!store.find((x) => x.id === r0.id).remind_at);
  await sleep(60);
  const r3 = store.find((x) => x.id === r0.id);
  check("删掉完结步 → 提醒又派上了", !!r3.remind_at, JSON.stringify(r3.remind_at));
  check("重新派发后倒计时又出现", /还有/.test(doc.querySelector("#flowPane .cd")?.textContent || ""),
    doc.querySelector("#flowPane .cd")?.textContent);
  doc.getElementById("btnUnRemind").click();
  await waitFor(() => store.find((x) => x.id === r0.id).remind_at === "");
  await sleep(60);
  const r4 = store.find((x) => x.id === r0.id);
  check("「不用提醒」清掉了时刻", r4.remind_at === "", JSON.stringify(r4.remind_at));
  check("关掉名单存进了 kv", /remindOff/.test(Object.keys(kv).join(",")) &&
    String(kv["remindOff"]).includes(r0.id), String(kv["remindOff"]).slice(0, 80));
  doc.getElementById("btnRemindOn").click();
  await waitFor(() => !!store.find((x) => x.id === r0.id).remind_task);
  await sleep(60);
  const r5 = store.find((x) => x.id === r0.id);
  check("「恢复提醒」又订回来了", !!r5.remind_at && !!r5.remind_task,
    JSON.stringify({ at: r5.remind_at, task: r5.remind_task }));

  /* ⑤½ 提醒时刻选择器：自绘面板（日期 + 时/分），替代原生 datetime-local 弹层 */
  const dr = doc.getElementById("dRemind");
  check("提醒时刻输入框存在且只读（点开面板选）", !!dr && dr.readOnly === true);
  dr.onfocus.call(dr);
  await sleep(30);
  check("时刻模式：时刻行出现、日期快捷键换成 此刻/清除",
    doc.getElementById("dpTime").hidden === false &&
    doc.getElementById("dpFootDate").hidden === true &&
    doc.getElementById("dpFootTime").hidden === false);
  doc.querySelector("#dpGrid [data-day]").click();
  await sleep(30);
  check("点日期 → 写回 YYYY-MM-DD HH:MM 且面板不关（还能调时分）",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dr.value) && doc.getElementById("dp").hidden === false,
    dr.value);
  doc.getElementById("dpHour").value = "8";
  doc.getElementById("dpHour").oninput();
  await sleep(20);
  check("改小时 → 输入框实时跟着变", / 08:/.test(dr.value), dr.value);
  doc.querySelector("[data-tquick='now']").click();
  await sleep(30);
  check("「此刻」写回当前时刻并收起",
    doc.getElementById("dp").hidden === true && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dr.value),
    dr.value);
  /* 时刻模式回归：详情页的「登记时间」也精确到分钟 —— 点日期只换日期、留时刻，
     面板留着继续调；「此刻」一键落当前时刻并收起。 */
  doc.getElementById("tab-browse").click();
  await sleep(60);
  doc.getElementById("btnBaseToggle").click();     // 解锁基本信息才能点日期框
  await sleep(60);
  const fd = doc.getElementById("dDate");
  check("详情页登记时间具体到分钟",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(fd.value), fd.value);
  fd.onfocus.call(fd);
  await sleep(30);
  check("时刻模式：时刻行在、日期快捷键收起",
    doc.getElementById("dpTime").hidden === false && doc.getElementById("dpFootDate").hidden === true);
  doc.querySelector("#dpGrid [data-day]").click();
  await sleep(30);
  check("点日期只换日期、时刻留着、面板不收",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(fd.value) && doc.getElementById("dp").hidden === false, fd.value);
  doc.querySelector("[data-tquick='now']").click();
  await sleep(30);
  check("「此刻」写回当前时刻并收起",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(fd.value) && doc.getElementById("dp").hidden === true, fd.value);
  /* 只改了输入框、没有点「保存修改」—— 库里那条不受影响，后面的段落照常跑 */

  // 后面的段落还要用 24 小时的口径（推送等无关，但别把设置留在 1）
  doc.getElementById("tab-settings").click();
  await sleep(40);
  doc.getElementById("optRemindHours").value = "24";
  doc.getElementById("saveRemind").click();
  await sleep(120);
}

console.log("\n5c2. 登记时间自动 / 提醒时间可改可清");
{
  doc.getElementById("tab-create").click();
  await sleep(60);
  check("登记页不再有手填的登记时间框", doc.getElementById("fDate") === null);
  const fr = doc.getElementById("fRemindAt");
  check("有提醒时间框且只读（点开自绘面板）", !!fr && fr.readOnly === true);
  const pre = fr.value || "";
  const preT = new Date(pre.replace(" ", "T")).getTime();
  check("提醒时间默认预填 现在 + 24 小时",
    Math.abs(preT - (Date.now() + 24 * 3600000)) < 180000,
    pre + "（" + ((preT - Date.now()) / 3600000).toFixed(2) + " 小时）");

  const nd = new Date();
  const td = nd.getFullYear() + "-" + String(nd.getMonth() + 1).padStart(2, "0") + "-" + String(nd.getDate()).padStart(2, "0");
  const tdm = td + " " + String(nd.getHours()).padStart(2, "0") + ":" + String(nd.getMinutes()).padStart(2, "0");

  // 手选一个时刻 → 登记，提醒就按手选的
  fr.value = "2030-01-02 09:30";
  doc.getElementById("fOrder").value = "250102-7777";
  doc.getElementById("fTrack").value = "SF0000000001";
  doc.getElementById("fTitle").value = "手选提醒时刻这条";
  doc.getElementById("btnAdd").click();
  await sleep(250);
  const rx = store[store.length - 1];
  check("手选时刻后能登记", rx && rx.title === "手选提醒时刻这条", JSON.stringify(rx && rx.order_sn));
  const shipOk = rx && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rx.shipped_at);
  const shipNear = shipOk && Math.abs(new Date(rx.shipped_at.replace(" ", "T")).getTime() - Date.now()) < 180000;
  check("登记时间自动 = 今天、精确到分钟", shipOk && rx.shipped_at.slice(0, 10) === td && shipNear,
    (rx && rx.shipped_at) + "（应为 " + tdm + " 左右）");
  check("登记时刻也存成分钟写法（不是 ISO 的 T/Z）",
    rx && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rx.created_at), rx && rx.created_at);
  check("提醒就订在手选的时刻",
    Math.abs(new Date(rx.remind_at).getTime() - new Date("2030-01-02T09:30:00").getTime()) < 60000,
    rx && rx.remind_at);

  // 走面板的「清除」清空提醒 → 登记，提醒交回流程派发
  const fr2 = doc.getElementById("fRemindAt");
  fr2.onfocus.call(fr2);
  await sleep(30);
  doc.querySelector("[data-tquick='clear']").click();
  await sleep(30);
  check("「清除」把提醒框清空了", fr2.value === "");
  doc.getElementById("fOrder").value = "250103-8888";
  doc.getElementById("fTrack").value = "SF0000000002";
  doc.getElementById("btnAdd").click();
  await sleep(250);
  const rc = store[store.length - 1];
  check("清空提醒 → 交回流程派发（登记 + 24 小时）",
    Math.abs(new Date(rc.remind_at).getTime() - (Date.now() + 24 * 3600000)) < 180000,
    ((new Date(rc.remind_at).getTime() - Date.now()) / 3600000).toFixed(2) + " 小时");
  check("登记完提醒框重新预填（下一条又是默认）", (doc.getElementById("fRemindAt").value || "") !== "");
}

console.log("\n5c3. 赔款数：详情能填、表格能显示");
{
  doc.getElementById("tab-browse").click();
  await sleep(60);
  doc.querySelector('#list .ticket[data-id="' + store[0].id + '"]').click();
  await sleep(60);
  doc.getElementById("btnBaseToggle").click();
  await sleep(60);
  check("详情基本信息里有赔款数（非必填）", !!doc.getElementById("dIndemnity"));
  doc.getElementById("dIndemnity").value = "86.5";
  doc.getElementById("btnEdit").click();
  await sleep(220);
  check("赔款数存进了库", store.find((r) => r.id === store[0].id)?.indemnity === "86.5",
    store.find((r) => r.id === store[0].id)?.indemnity);
  doc.getElementById("tab-table").click();
  await sleep(60);
  const ths = [...doc.querySelectorAll("#tableHead th")].map((t) => t.textContent.trim());
  check("表格有赔款数列", ths.includes("赔款数"), ths.join(" / "));
  check("表格行里显示赔款数", /86\.5/.test(doc.getElementById("tableBody").textContent || ""));
  doc.getElementById("colBtn").click();
  await sleep(60);
  const boxes = [...doc.querySelectorAll("#colPanel [data-col]")].map((b) => b.getAttribute("data-col"));
  check("列面板里 15 列都能勾（含赔款数）", boxes.length === 15 && boxes.indexOf("indemnity") >= 0,
    boxes.join(","));
  /* 对齐：全局 `input { width:100% }` 会把复选框撑成一整行再压缩 —— 勾选框跟着
     列名长短横跳、行高也被 padding 撑得不齐。这里钉死 14px 方块 + 列名占中间。 */
  const cb0 = doc.querySelector('#colPanel [data-col="order_sn"]');
  const cbCss = win.getComputedStyle(cb0);
  check("勾选框是 14px 方块、不参与伸缩", cbCss.width === "14px" && /^0 0 /.test(cbCss.flex),
    cbCss.width + " / " + cbCss.flex);
  check("勾选框不带输入框的内边距 / 边框圆角",
    (cbCss.padding === "0px" || cbCss.padding === "0px 0px") && (cbCss.margin === "0px" || cbCss.margin === "0px 0px"),
    cbCss.padding + " / " + cbCss.margin);
  const cn0 = doc.querySelector("#colPanel label .cn");
  check("列名占中间一格（flex-grow:1，箭头才钉得住右边）",
    !!cn0 && win.getComputedStyle(cn0).flexGrow === "1");
  doc.getElementById("colSave").click();
  await sleep(60);
}

console.log("\n5c4. 列表与表格：筛选 + 排序（同一套值）");
{
  doc.getElementById("tab-browse").click();
  await sleep(60);
  const fc = doc.getElementById("fltCourier");
  check("左栏有快递公司 / 情况筛选", !!fc && !!doc.getElementById("fltCategory"));
  check("有排序下拉（4 种）", [...doc.getElementById("sortBy").options].length === 4,
    String(doc.getElementById("sortBy").options.length));
  const courierOpt = [...fc.options].map((o) => o.value).filter(Boolean)[0] || "";
  fc.value = courierOpt;
  fc.onchange.call(fc);
  await sleep(60);
  const expect = store.filter((r) => (r.courier || "") === courierOpt).length;
  check("按快递公司筛出对应条数",
    doc.querySelectorAll("#list .ticket").length === expect,
    doc.querySelectorAll("#list .ticket").length + " vs " + expect);
  doc.getElementById("tab-table").click();
  await sleep(60);
  check("表格页的筛选跟着变（两处共享一个值）",
    doc.getElementById("tfltCourier").value === courierOpt, doc.getElementById("tfltCourier").value);
  check("表格也筛出同样的条数",
    doc.getElementById("tableBody").querySelectorAll("tr").length === expect,
    doc.getElementById("tableBody").querySelectorAll("tr").length + " vs " + expect);

  // 清筛选 → 两边都恢复
  const tc = doc.getElementById("tfltCourier");
  tc.value = "";
  tc.onchange.call(tc);
  await sleep(60);
  check("清掉筛选两边都恢复", doc.getElementById("fltCourier").value === "" &&
    doc.querySelectorAll("#list .ticket").length === store.length,
    doc.querySelectorAll("#list .ticket").length + " vs " + store.length);

  // 排序：登记时间旧在前 → 首条是最早登记的那条
  const sb = doc.getElementById("sortBy");
  sb.value = "created:asc";
  sb.onchange.call(sb);
  await sleep(60);
  const firstId = doc.querySelector("#list .ticket")?.getAttribute("data-id");
  check("按登记时间旧在前 → 首条是最早那条", firstId === store[0].id, firstId + " vs " + store[0].id);
  check("排序选择记进了 localStorage",
    /created:asc/.test(win.localStorage.getItem("wbtool:abnormal-ticket:sort") || ""),
    win.localStorage.getItem("wbtool:abnormal-ticket:sort"));
  // 提醒时间排序：手选 2030 年那条在「晚在前」时排第一
  sb.value = "remind:desc";
  sb.onchange.call(sb);
  await sleep(60);
  const manual = store.find((r) => r.order_sn === "250102-7777");
  const firstRemind = doc.querySelector("#list .ticket")?.getAttribute("data-id");
  check("按提醒时间晚在前 → 手选 2030 的那条排最前", firstRemind === manual.id,
    firstRemind + " vs " + manual.id);
  // 收尾：回到默认排序，别影响后面的断言
  sb.value = "created:desc";
  sb.onchange.call(sb);
  await sleep(60);
}

console.log("\n5d. 布局：分栏能拖、列宽按权重");
{
  doc.getElementById("tab-browse").click();
  await sleep(80);
  const gut = doc.getElementById("splitGutter");
  check("左右分栏之间有拖杆", !!gut);
  const split = gut && gut.parentElement;
  const left = gut && gut.previousElementSibling;
  check("拖杆夹在列表和详情之间", !!split && !!left
    && split.classList.contains("split") && left.classList.contains("left"));
  const before = split.style.getPropertyValue("--listw");
  const mev = (type, x) => new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: 200 });
  gut.dispatchEvent(mev("mousedown", 300));
  // jsdom 里 getBoundingClientRect 全是 0 —— 拖到 500 会撞上「右边留 420」的上限，
  // 所以这里只断言拖杆真的接住了事件并回写了宽度
  win.dispatchEvent(mev("mousemove", 500));
  const after = split.style.getPropertyValue("--listw");
  check("拖动改写了列表宽度", after !== before && /px$/.test(after), before + " → " + after);
  win.dispatchEvent(mev("mouseup", 500));
  check("松手后宽度记下来了", /px$/.test(win.localStorage.getItem("wbtool:abnormal-ticket:listw") || ""),
    String(win.localStorage.getItem("wbtool:abnormal-ticket:listw")));
  check("松手后没把光标锁死", doc.body.style.cursor === "");

  doc.getElementById("tab-table").click();
  await sleep(80);
  const ths = Array.from(doc.querySelectorAll("#tableHead th"));
  check("表头各列都带建议宽度", ths.length > 0 && ths.every((th) => /width:/.test(th.getAttribute("style") || "")),
    ths.map((th) => th.getAttribute("style")).join(" | ").slice(0, 120));
  const w = ths.map((th) => parseFloat(/([\d.]+)%/.exec(th.getAttribute("style") || "")?.[1] || "0"));
  const sum = w.reduce((a, b) => a + b, 0);
  check("列宽百分比加起来是 100", Math.abs(sum - 100) < 0.5, String(sum));
}

console.log("\n6. 绑定在线表格（分享链路）");
doc.getElementById("tab-settings").click();
await sleep(60);
doc.getElementById("wpsLink").value = "https://www.kdocs.cn/l/ca1BaaQrrGVT";
doc.getElementById("wpsBind").click();
await sleep(200);
check("认出了表名", (doc.getElementById("wpsTitle").textContent || "").includes("测试异常单"),
  doc.getElementById("wpsTitle").textContent);
check("显示出了创建人", (doc.getElementById("wpsOwner").textContent || "").includes("大苏打"),
  doc.getElementById("wpsOwner").textContent);
check("绑定信息块露出来了", doc.getElementById("wpsBound").hidden === false);
check("绑定写进了宿主 kv（wps.sheet）", !!kv["wps.sheet"], Object.keys(kv).join(","));
check("创建人也一起存下来了",
  /"owner":"大苏打"/.test(String(kv["wps.sheet"] || "")), String(kv["wps.sheet"]).slice(0, 120));
check("绑定后推/拉按钮解禁",
  doc.getElementById("wpsPush").disabled === false && doc.getElementById("wpsPull").disabled === false);

/* v1.14.0：绑上之后立刻对一次账（启动那条路同理，只是要等 boot）——
   只读不写，差异用页头那个小按钮标出来，不弹窗抢人。 */
check("绑定后自动读了一遍云表（不是等用户点拉取）",
  ops.filter((o) => o === "wps.mcpPull").length >= 1,
  String(ops.filter((o) => o === "wps.mcpPull").length));
{
  const rb = doc.getElementById("reconBtn");
  check("有差异时页头标出「云端有 N 处不同」",
    rb && rb.hidden === false && /云端有 \d+ 处不同/.test(rb.textContent || ""),
    rb ? rb.textContent + " / hidden=" + rb.hidden : "没有这个按钮");
  check("自动对账只读不写（没弹确认框、也没 apply）",
    !doc.querySelector(".dlgm") && !ops.includes("wps.mcpApply"),
    (doc.querySelector(".dlgm") ? "弹窗了" : "") + " apply=" + ops.includes("wps.mcpApply"));
}
doc.getElementById("tab-table").click();
await sleep(60);
check("表格页也有推 / 拉（跟着数据走，不用回设置页）",
  doc.getElementById("tblPush") && doc.getElementById("tblPull") &&
  doc.getElementById("tblPush").disabled === false,
  doc.getElementById("tblPush") ? String(doc.getElementById("tblPush").disabled) : "没有这个按钮");
check("右上角钉了推送按钮（哪个页签都在）",
  !!doc.getElementById("hdrPush") && doc.getElementById("hdrPush").disabled === false,
  doc.getElementById("hdrPush") ? String(doc.getElementById("hdrPush").disabled) : "没有这个按钮");
doc.getElementById("tab-settings").click();
await sleep(60);

console.log("\n7. 推送：先弹窗确认，确定才写（默认只推增量）");
doc.getElementById("wpsPush").click();
await sleep(250);
const push1 = args.filter((a) => a.op === "wps.mcpPush");
check("推送第一步是 dryRun（只看不写）", push1.length === 1 && push1[0].payload.dryRun === true,
  JSON.stringify(push1.map((a) => a.payload)));
check("默认推送不带 force（只推增量）", push1[0].payload.force !== true,
  JSON.stringify(push1[0].payload));
const dlg1 = doc.querySelector(".dlgm");
check("点推送弹出了确认框（不再是设置页里那块预览）", !!dlg1);
check("确认框说清了新增 1 行", /新增 1 行/.test(dlg1 ? dlg1.textContent : ""),
  (dlg1 ? dlg1.textContent : "").slice(0, 140));
check("确认框说清了改 2 个格", /改 2 个格/.test(dlg1 ? dlg1.textContent : ""));
check("确认框说明了表上多出来的行留着不动", /留着不动/.test(dlg1 ? dlg1.textContent : ""));
/* v1.14.0：光说「改 2 个格」不够 —— 那两格可能是他手填的，得看见旧值 */
check("确认框摊到逐格：单号 + 表第几行 + 表上值 → 本机值",
  /6931234567890123456/.test(dlg1?.textContent || "") &&
  /表第 3 行/.test(dlg1?.textContent || "") &&
  /快递单号/.test(dlg1?.textContent || "") &&
  /SF0001/.test(dlg1?.textContent || "") &&
  /SF9999/.test(dlg1?.textContent || ""),
  (dlg1?.textContent || "").slice(0, 200));
check("旧值有新有旧两个都要在（改前能对照）",
  /表上写的/.test(dlg1?.textContent || "") && /本机写的/.test(dlg1?.textContent || ""));
check("确认按钮是主色（不是删除那种红）", !!doc.querySelector(".dlgm #dlgYes.primary"));
check("没确认前没有真写", args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true).length === 0);
doc.getElementById("dlgYes").click();
await sleep(300);
const push2 = args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true);
check("点确认后才真推", push2.length === 1,
  JSON.stringify(args.filter((a) => a.op === "wps.mcpPush").map((a) => a.payload)));
check("真推也是非强制的", push2[0].payload.force !== true, JSON.stringify(push2[0].payload));
check("确认框收起来了", !doc.querySelector(".dlgm"));
check("推送结果有回显（说清写了几行几格）",
  /已推送/.test(doc.getElementById("wpsMsg").textContent || "") &&
  /新增 1 行/.test(doc.getElementById("wpsMsg").textContent || ""),
  doc.getElementById("wpsMsg").textContent);

console.log("\n7b. 右上角那个按钮也弹窗（以前只往设置页写消息，看着像没反应）");
doc.getElementById("tab-table").click();          // 换个页签点，证明弹窗不依赖设置页
await sleep(80);
doc.getElementById("hdrPush").click();
await sleep(250);
check("右上角按钮的第一步也是 dryRun",
  args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun === true).length >= 2);
check("在表格页也弹出了确认框", !!doc.querySelector(".dlgm"));
doc.getElementById("dlgNo").click();
await sleep(80);
check("取消后表上一格没动（没有第二次真写）",
  args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true).length === 1,
  String(args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true).length));
check("取消也给了回执", /已取消/.test(doc.getElementById("wpsMsg").textContent || ""));

console.log("\n7c. 强制推送：连表上多出来的行一起清空");
doc.getElementById("tab-settings").click();
await sleep(80);
const beforeForce = args.filter((a) => a.op === "wps.mcpPush").length;
doc.getElementById("wpsPushForce").click();
await sleep(250);
const dry3 = args.filter((a) => a.op === "wps.mcpPush")[beforeForce];
check("强制推送的 dryRun 带 force: true",
  dry3 && dry3.payload.dryRun === true && dry3.payload.force === true,
  JSON.stringify(dry3 && dry3.payload));
const dlg3 = doc.querySelector(".dlgm");
check("弹出了强制推送的确认框", !!dlg3);
check("确认框写明会清空 1 行", /清空 1 行/.test(dlg3 ? dlg3.textContent : ""),
  (dlg3 ? dlg3.textContent : "").slice(0, 160));
check("确认框提醒清空了找不回来", /没法从表上找回/.test(dlg3 ? dlg3.textContent : ""));
check("强制推送的确认按钮是危险样式", !!doc.querySelector(".dlgm #dlgYes.danger"));
check("强制推送同样没确认前不写",
  args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true).length === 1);
doc.getElementById("dlgYes").click();
await sleep(300);
const real3 = args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true);
check("确认后真推且带 force", real3.length === 2 && real3[1].payload.force === true,
  JSON.stringify(real3.map((a) => a.payload)));
check("结果里说清了清空 1 行", /清空 1 行/.test(doc.getElementById("wpsMsg").textContent || ""),
  doc.getElementById("wpsMsg").textContent);

console.log("\n7d. 推送记录：本机库里的只增不删流水");
check("三次操作都记了（成功 / 取消 / 强制成功）", pushLog.length === 3,
  pushLog.map((r) => r.push_result + "/" + r.push_kind).join(", "));
check("成功那条记了新增 1 行、改 2 格、本地单数",
  pushLog[0] && pushLog[0].push_result === "ok" && Number(pushLog[0].added) === 1 &&
  Number(pushLog[0].changed) === 2 && Number(pushLog[0].ticket_count) === store.length,
  JSON.stringify(pushLog[0]));
check("取消也留了一条（不是静默吞掉）", pushLog[1] && pushLog[1].push_result === "skip",
  String(pushLog[1] && pushLog[1].push_result));
check("强制推送单独标 force、记了清空 1 行",
  pushLog[2] && pushLog[2].push_kind === "force" && Number(pushLog[2].removed) === 1,
  JSON.stringify(pushLog[2]));
check("记录里写了绑定的表名", (pushLog[0].target || "").includes("测试异常单"), pushLog[0].target);
check("时间是本地到秒（不是 ISO）", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(pushLog[0].logged_at),
  pushLog[0].logged_at);
check("只增不删：一次 delete 都没有", pushLogDeletes === 0, String(pushLogDeletes));

doc.getElementById("tab-log").click();
await sleep(250);
check("记录页签切得过去", doc.getElementById("view-log").hidden === false);
check("表格里 3 条记录", doc.querySelectorAll("#logBody tr").length === 3,
  String(doc.querySelectorAll("#logBody tr").length));
check("最新在最上面（强制推送那条）",
  (doc.querySelector("#logBody tr")?.textContent || "").includes("强制"));
check("顶部汇总：累计 3 次 · 成功 2 · 失败 0",
  /累计 3 次 · 成功 2 · 失败 0/.test(doc.getElementById("logStats").textContent || ""),
  doc.getElementById("logStats").textContent);
check("结果标签说人话（成功 / 取消都在）",
  /成功/.test(doc.getElementById("logBody").textContent || "") &&
  /取消/.test(doc.getElementById("logBody").textContent || ""));
check("时间列到秒", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(doc.getElementById("logBody").textContent || ""));
check("页面没有删除记录的入口（只增不删）",
  !doc.querySelector("#view-log button#logClear") &&
  !/清空记录|删除记录/.test(doc.getElementById("view-log").textContent || ""));
check("不到一页时不显示「加载更早」", doc.getElementById("logMoreWrap").hidden === true);

{
  const lf = doc.getElementById("logFlt");
  lf.value = "fail";
  lf.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(250);
  check("筛「只看失败」→ 空态（这 3 条里没有失败）",
    /这个筛选下没有记录/.test(doc.getElementById("logBody").textContent || ""),
    (doc.getElementById("logBody").textContent || "").slice(0, 60));
  lf.value = "all";
  lf.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(250);
  check("筛回全部又是 3 条", doc.querySelectorAll("#logBody tr").length === 3,
    String(doc.querySelectorAll("#logBody tr").length));
}

console.log("\n7e. 推送失败也要留痕（只看到红字、不知道断在哪一步等于没记）");
pushFail = "MCP 会话已过期，请重新授权";
doc.getElementById("tab-settings").click();
await sleep(80);
doc.getElementById("wpsPush").click();
await sleep(300);
check("核对失败也写了一条（fail）", pushLog.length === 4 && pushLog[3].push_result === "fail",
  pushLog.map((r) => r.push_result).join(","));
check("失败原因原话记下来了", /会话已过期/.test(pushLog[3].message || ""), pushLog[3].message);
check("失败那条的数字全 0（一格没写）",
  Number(pushLog[3].added) === 0 && Number(pushLog[3].changed) === 0 && Number(pushLog[3].removed) === 0,
  JSON.stringify(pushLog[3]));
pushFail = "";

doc.getElementById("tab-log").click();
await sleep(250);
check("记录页现在 4 条", doc.querySelectorAll("#logBody tr").length === 4,
  String(doc.querySelectorAll("#logBody tr").length));
{
  const lf2 = doc.getElementById("logFlt");
  lf2.value = "fail";
  lf2.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(250);
  check("「只看失败」正好 1 条", doc.querySelectorAll("#logBody tr").length === 1,
    String(doc.querySelectorAll("#logBody tr").length));
  check("顶部汇总仍是全表：累计 4 次 · 成功 2 · 失败 1",
    /累计 4 次 · 成功 2 · 失败 1/.test(doc.getElementById("logStats").textContent || ""),
    doc.getElementById("logStats").textContent);
  lf2.value = "all";
  lf2.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(200);
}
doc.getElementById("tab-settings").click();
await sleep(100);

doc.getElementById("wpsPull").click();
await sleep(250);
check("拉取走了 wps.mcpPull", ops.includes("wps.mcpPull"));
/* v1.14.0：确认从"设置页里一块预览"改成弹窗，且要摊到字段级（表上 → 本机）。
   弹窗是自绘的（WebView2 里 confirm 不一定弹），所以认 .dlgm/.dlist 而不是原生对话框。 */
const reconDlg = doc.querySelector(".dlgm");
check("拉取后弹出了差异确认框", !!reconDlg);
const reconText = reconDlg ? reconDlg.textContent || "" : "";
check("确认框按单号摆出「会新增 1 条 / 改 1 条」",
  /会新增 1\s*条/.test(reconText) && /值不同\s*→\s*改 1\s*条/.test(reconText),
  reconText.slice(0, 120));
check("明细摊到字段级：情况 表上写的 → 本机写的",
  /情况/.test(reconText) && /表上写的/.test(reconText) && /本机写的/.test(reconText),
  reconText.slice(0, 160));
reconDlg.querySelector("#dlgYes").click();
await sleep(250);
check("确认走 wps.mcpApply", ops.includes("wps.mcpApply"));
// 宿主 applyPull 之后会推 kwiki:pulled，工具靠它重画（对账与写库都在宿主）
win.postMessage({ source: "workbench-host", type: "tool:event", event: "kwiki:pulled" }, "*");
await sleep(200);
check("收到 kwiki:pulled 后列表重画了（row.select 又调了一次）",
  ops.filter((o) => o === "row.select").length >= 2,
  String(ops.filter((o) => o === "row.select").length));
check("全程没有新报错", errors.length === 0, errors.join(" | "));

console.log("\n8. 独立打开也还是个能用的网页（不连宿主）");
{
  const vc2 = new VirtualConsole();
  const errs2 = [];
  vc2.on("jsdomError", (e) => errs2.push(String(e.message || e)));
  vc2.on("error", (...a) => errs2.push(a.join(" ")));
  const d2 = new JSDOM(HTML, {
    url: "http://localhost/abnormal-ticket/standalone.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc2,
  });
  const w2 = d2.window;
  await sleep(1500);                       // 1.2 秒等不到 tool:context → 自己判独立运行
  check("1.2 秒后落到 standalone", w2.document.body.dataset.bindState === "standalone",
    w2.document.body.dataset.bindState);
  const d2doc = w2.document;
  d2doc.getElementById("fOrder").value = "261019-1234567890123";
  d2doc.getElementById("fTrack").value = "YT0000000000";
  d2doc.getElementById("btnAdd").click();
  await sleep(200);
  const saved = w2.localStorage.getItem("wbtool:abnormal-ticket:rows") || "";
  check("登记一条落进 localStorage（独立态唯一的数据处）", saved.includes("261019-1234567890123"),
    saved.slice(0, 120));
  d2doc.getElementById("tab-log").click();
  await sleep(150);
  check("独立运行也能打开记录页（空态，不报错）",
    d2doc.getElementById("view-log").hidden === false &&
    /还没有推送记录/.test(d2doc.getElementById("logBody").textContent || ""),
    d2doc.getElementById("logBody").textContent);
  check("独立运行也没有未捕获报错", errs2.length === 0, errs2.join(" | "));
  d2.window.close();
}

console.log("\n10. 删除要按确定键（自绘确认框，不靠 window.confirm）");
{
  doc.getElementById("tab-browse").click();
  await sleep(60);

  /* 先挑出一条「留着不删」的带流程单 —— 整条删除要避开它，否则后面没东西可测 */
  let withFlow = null, flowN = 0;
  for (const r of store) {
    try {
      const f = JSON.parse(r.flow || "[]");
      if (f.length >= 1) { withFlow = r; flowN = f.length; break; }
    } catch (e) { /* 坏数据跳过 */ }
  }
  const total0 = store.length;
  const target = store.find((r) => r.id !== (withFlow && withFlow.id)) || store[0];
  doc.querySelector('#list .ticket[data-id="' + target.id + '"]').click();
  await sleep(100);

  doc.getElementById("btnDel").click();
  await sleep(80);
  check("点「删除」先弹确认框，不直接删",
    !!doc.querySelector(".dlgm") && store.length === total0,
    (doc.querySelector(".dlgm") ? "有框 " : "没框 ") + store.length + " vs " + total0);
  check("确认框里写清删的是哪条单",
    (doc.querySelector(".dlgm")?.textContent || "").indexOf(target.order_sn || target.tracking_no) >= 0,
    doc.querySelector(".dlgm")?.textContent);

  doc.getElementById("dlgNo").click();
  await sleep(60);
  check("点「取消」→ 框收起、记录还在",
    !doc.querySelector(".dlgm") && store.length === total0,
    store.length + " vs " + total0);

  /* ESC 等同于取消 */
  doc.getElementById("btnDel").click();
  await sleep(60);
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(60);
  check("按 ESC 也取消",
    !doc.querySelector(".dlgm") && store.length === total0,
    (doc.querySelector(".dlgm") ? "框还在" : "框收了") + " / " + store.length);

  /* 点遮罩 = 取消 */
  doc.getElementById("btnDel").click();
  await sleep(60);
  const m = doc.querySelector(".dlgm");
  m.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  check("点遮罩也取消", !doc.querySelector(".dlgm") && store.length === total0);

  /* 真删 */
  doc.getElementById("btnDel").click();
  await sleep(60);
  doc.getElementById("dlgYes").click();
  await sleep(300);
  check("点「删除」才真的删掉",
    store.length === total0 - 1 && !store.find((r) => r.id === target.id),
    store.length + " vs " + (total0 - 1));

  /* 流程步的「删」同样要问一句 */
  if (withFlow) {
    doc.querySelector('#list .ticket[data-id="' + withFlow.id + '"]').click();
    await sleep(120);
    const d0 = doc.querySelector("[data-delflow]");
    check("详情里能看到流程步的「删」", !!d0);
    d0.click();
    await sleep(80);
    check("删流程步也先弹确认框", !!doc.querySelector(".dlgm"));
    doc.getElementById("dlgNo").click();
    await sleep(100);
    const n1 = JSON.parse(store.find((r) => r.id === withFlow.id).flow).length;
    check("取消 → 流程步一步没少", n1 === flowN, n1 + " vs " + flowN);

    doc.querySelector("[data-delflow]").click();
    await sleep(80);
    doc.getElementById("dlgYes").click();
    await sleep(350);
    const n2 = JSON.parse(store.find((r) => r.id === withFlow.id).flow || "[]").length;
    check("确定 → 流程真的少一步", n2 === flowN - 1, n2 + " vs " + flowN);
  } else {
    check("有带流程的单子可测", false, "没找到 flow 非空的记录");
  }
}

console.log("\n9. 旧版工作台（表里没 indemnity 列）→ 赔款数降级、其余照常");
{
  const vc3 = new VirtualConsole();
  const errs3 = [];
  vc3.on("jsdomError", (e) => errs3.push(String(e.message || e)));
  vc3.on("error", (...a) => errs3.push(a.join(" ")));
  const d3 = new JSDOM(HTML, {
    url: "http://localhost/abnormal-ticket/oldhost.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc3,
  });
  const w3 = d3.window;

  // 假宿主：凡带 indemnity 的 update 一律当「no such column」拒掉 —— 旧版宿主的样子
  const store3 = [];
  const ops3 = [];
  const kv3 = {};
  const reply3 = (id, ok, data, error) =>
    w3.postMessage({ source: "workbench-host", type: "tool:response", id, ok, data, error }, "*");
  w3.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.source !== "workbench-tool" || m.type !== "tool:request") return;
    const p = m.payload || {};
    ops3.push({ op: m.op, payload: p });
    switch (m.op) {
      case "row.select": return reply3(m.id, true, { rows: store3.slice() });
      case "row.insert": {
        const row = Object.assign({ id: "old-" + store3.length, created_at: new Date().toISOString() }, p.row || {});
        store3.push(row);
        return reply3(m.id, true, { row });
      }
      case "row.update": {
        if (p.patch && "indemnity" in p.patch) return reply3(m.id, false, null, "no such column: indemnity");
        const row = store3.find((r) => r.id === p.id) || null;
        if (row) Object.assign(row, p.patch || {});
        return reply3(m.id, true, { row });
      }
      case "kv.get": return reply3(m.id, true, { value: kv3[p.key] ?? null });
      case "kv.set": kv3[p.key] = p.value; return reply3(m.id, true, { ok: true });
      case "task.remind": return reply3(m.id, true, { taskId: "old-task" });
      default: return reply3(m.id, true, {});
    }
  });
  w3.postMessage({ source: "workbench-host", type: "tool:context", data: { theme: "light", gallery: false } }, "*");
  await sleep(400);
  const d3doc = w3.document;
  check("旧宿主：状态照常连上", d3doc.body.dataset.bindState === "bound", d3doc.body.dataset.bindState);

  // 登记：insert 不该带这一列（带了会整条插不进去）
  d3doc.getElementById("tab-create").click();
  await sleep(60);
  d3doc.getElementById("fOrder").value = "261020-5555";
  d3doc.getElementById("btnAdd").click();
  await sleep(250);
  check("旧宿主：登记照样成功", store3.length === 1, String(store3.length));
  const ins3 = ops3.find((o) => o.op === "row.insert");
  check("旧宿主：insert 的 row 里没有 indemnity", ins3 && !("indemnity" in (ins3.payload.row || {})),
    JSON.stringify(ins3 && ins3.payload.row));

  // 详情：赔款数输入禁用并说明
  d3doc.getElementById("tab-browse").click();
  await sleep(60);
  d3doc.querySelector("#list .ticket").click();
  await sleep(80);
  check("旧宿主：赔款数输入被禁用并说明原因",
    d3doc.getElementById("dIndemnity")?.disabled === true &&
    /升级后可用/.test(d3doc.getElementById("dIndemnity")?.placeholder || ""),
    d3doc.getElementById("dIndemnity")?.placeholder);

  // 解锁保存：patch 也不该带
  d3doc.getElementById("btnBaseToggle").click();
  await sleep(80);
  check("旧宿主：解锁后赔款数仍是禁用的", d3doc.getElementById("dIndemnity").disabled === true);
  d3doc.getElementById("dTitle").value = "旧宿主改一句";
  const updBefore = ops3.filter((o) => o.op === "row.update").length;
  d3doc.getElementById("btnEdit").click();
  await sleep(250);
  const upd3 = ops3.filter((o) => o.op === "row.update").pop();
  check("旧宿主：保存成功且 patch 不碰 indemnity",
    ops3.filter((o) => o.op === "row.update").length === updBefore + 1 &&
    !("indemnity" in (upd3.payload.patch || {})),
    JSON.stringify(upd3 && upd3.payload.patch));
  check("旧宿主：保存真的落库了", store3[0].title === "旧宿主改一句", store3[0].title);
  check("旧宿主：全程无未捕获报错", errs3.length === 0, errs3.join(" | "));
  d3.window.close();
}

console.log("\n11. 订单附图：字节进图床，工具只记关联");
{
  const before = store.length;
  const gBefore = gallery.length;
  doc.getElementById("tab-create").click();
  await sleep(60);

  doc.getElementById("fOrder").value = "261022-777777777777";
  doc.getElementById("fOrder").dispatchEvent(new win.Event("input", { bubbles: true }));

  /* 两张图：jsdom 没有 canvas，readImageFile 会退回"原样交上去"这条路
     —— 正好覆盖"压不了也不能把图丢了"那个分支 */
  const f1 = new win.File([new Uint8Array([137, 80, 78, 71])], "破损.png", { type: "image/png" });
  const f2 = new win.File([new Uint8Array([137, 80, 78, 71])], "面单.png", { type: "image/png" });
  pickFiles(doc, win, "fImgFile", [f1, f2]);
  await waitFor(() => doc.querySelectorAll("#fImgDrop .imgcell").length === 2);
  check("登记页选两张 → 出现两个待传格",
    doc.querySelectorAll("#fImgDrop .imgcell").length === 2,
    String(doc.querySelectorAll("#fImgDrop .imgcell").length));
  check("待传格点开看的是手里那份原图（还没进图床）",
    !!doc.querySelector("#fImgDrop .imgcell[data-pv]"));

  doc.getElementById("btnAdd").click();
  await waitFor(() => liveImgs().length === 2 && store.length === before + 1, 5000);
  check("登记成功、两张图都挂上",
    store.length === before + 1 && liveImgs().length === 2,
    store.length + " 单 / " + liveImgs().length + " 图");
  check("两张图都进了图床", gallery.length === gBefore + 2, String(gallery.length - gBefore));
  check("图床里的标题带单号（翻图床时认得出来）",
    /异常单 261022-777777777777 附图/.test(gallery[gBefore]?.title || ""),
    gallery[gBefore]?.title);
  check("工具表里只有关联 + 缩略图，没有原图字节",
    imgStore.every((r) => /^data:image\//.test(r.thumb || "") && r.gallery_id && r.thumb.length < 200),
    JSON.stringify(imgStore.map((r) => ({ g: r.gallery_id, t: (r.thumb || "").length }))));
  check("登记完待传区清空（下一单不会把这批图再挂一次）",
    doc.querySelectorAll("#fImgDrop .imgcell").length === 0);

  /* 详情页：独立一块「图片」，不受基本信息那把锁影响 */
  doc.getElementById("tab-browse").click();
  await sleep(80);
  const row = store.find((r) => r.order_sn === "261022-777777777777");
  doc.querySelector('#list .ticket[data-id="' + row.id + '"]').click();
  await sleep(100);
  check("详情页图片区有 2 格，标题写了张数",
    doc.querySelectorAll("#dImgDrop .imgcell").length === 2 &&
    /2 张/.test(doc.querySelector("#sectImgs h3")?.textContent || ""),
    doc.querySelector("#sectImgs h3")?.textContent);
  check("锁态下也能加图（加图不算改单号）",
    doc.getElementById("sectBase").classList.contains("locked") &&
    !!doc.getElementById("btnImgPick"));

  /* 点缩略图 → 整屏看原图（原图回图床取） */
  doc.querySelector("#dImgDrop .imgcell").click();
  await waitFor(() => doc.getElementById("vw").hidden === false);
  await sleep(60);
  check("点缩略图打开整屏看图", doc.getElementById("vw").hidden === false);
  check("大图是从图床取的",
    /^data:image\//.test(doc.getElementById("vwImg").getAttribute("src") || ""),
    doc.getElementById("vwImg").getAttribute("src"));
  doc.getElementById("vw").click();
  check("点一下遮罩就关", doc.getElementById("vw").hidden === true);

  /* ESC 也能关（和点遮罩两条路都留着 —— 有人习惯键盘） */
  doc.querySelector("#dImgDrop .imgcell").click();
  await waitFor(() => doc.getElementById("vw").hidden === false);
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(40);
  check("ESC 也能关掉看图", doc.getElementById("vw").hidden === true);

  /* × 去掉一张：要问一句，且只解除关联（图床那条不动） */
  doc.querySelector("#dImgDrop .imgcell .del").click();
  await sleep(80);
  check("去掉一张也要先确认", !!doc.querySelector(".dlgm"), doc.querySelector(".dlgm") ? "有框" : "没框");
  check("确认框说明「只解除关联，原图还在」",
    /图床里那张原图还在/.test(doc.querySelector(".dlgm")?.textContent || ""));
  const gNow = gallery.length;
  doc.getElementById("dlgYes").click();
  await waitFor(() => liveImgs().length === 1);
  check("去掉后只剩 1 条关联", liveImgs().length === 1, String(liveImgs().length));
  check("图床里那张图没被删", gallery.length === gNow, gallery.length + " vs " + gNow);

  /* 删整条单子 → 它的图片关联一起清掉（别留孤儿行） */
  doc.getElementById("btnDel").click();
  await sleep(80);
  check("删整条时告诉用户图只解除关联",
    /图只解除关联/.test(doc.querySelector(".dlgm")?.textContent || ""),
    doc.querySelector(".dlgm")?.textContent?.slice(0, 80));
  doc.getElementById("dlgYes").click();
  await waitFor(() => !store.find((r) => r.id === row.id));
  check("单子删了、它的图片关联也清了",
    liveImgs().length === 0 && !store.find((r) => r.id === row.id),
    liveImgs().length + " 条残留");
}

console.log("\n11b. 剪贴板里的图：Ctrl+V 直接进图片区");
{
  /** 造一个真粘贴事件。jsdom 既没有 ClipboardEvent 也不给 clipboardData，
      只能自己挂上 —— 工具读的就是 items / files / types 这几个字段。
      返回值 = dispatchEvent 的结果：false 表示工具 preventDefault 收下了。
      另外：剪贴板里"既有文字又有图"是常态（从 Excel / Word 复制单元格就是），
      withText 用来覆盖那条"别抢文本粘贴"的分支。 */
  function pasteImgs(files, opt) {
    const o = opt || {};
    const ev = new win.Event("paste", { bubbles: true, cancelable: true });
    const items = files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f }));
    Object.defineProperty(ev, "clipboardData", {
      configurable: true,
      value: {
        items,
        files,
        types: o.withText ? ["text/plain", "Files"] : ["Files"],
        // ★ 工具判"是不是在粘文字"看的是 getData 的真实内容，不是 types 里有没有这一项；
        //   withText 只模拟"带这个类型"，text 才是真有字（空串 = 截图工具的占位）
        getData: (t) => (o.withText && t === "text/plain" ? (o.text || "") : ""),
      },
    });
    if (o.focus) o.focus.focus();
    return (o.target || doc.body).dispatchEvent(ev);
  }
  const mkPng = (name) => new win.File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

  /* ① 登记页：粘贴 = 跟点「添加图片」选一样，先排成待传格 */
  doc.getElementById("tab-create").click();
  await sleep(60);
  const beforeN = store.length, gBefore = gallery.length;
  doc.getElementById("fOrder").value = "261022-999999999999";
  doc.getElementById("fOrder").dispatchEvent(new win.Event("input", { bubbles: true }));
  const taken = pasteImgs([mkPng("截图1.png"), mkPng("截图2.png")]);
  await waitFor(() => doc.querySelectorAll("#fImgDrop .imgcell").length === 2);
  check("登记页粘贴两张 → 出现两个待传格",
    doc.querySelectorAll("#fImgDrop .imgcell").length === 2,
    String(doc.querySelectorAll("#fImgDrop .imgcell").length));
  check("粘贴事件被接管（不让浏览器再往页面里塞）", taken === false);
  check("待传区写着「待传 2 张」（不静默）",
    /待传 2 张/.test(doc.getElementById("fImgMsg").textContent || ""),
    doc.getElementById("fImgMsg").textContent);
  check("toast 说清是从剪贴板来的",
    /粘入 2 张/.test(doc.getElementById("toast").textContent || ""),
    doc.getElementById("toast").textContent);

  doc.getElementById("btnAdd").click();
  await waitFor(() => store.length === beforeN + 1 && liveImgs().length === 2, 6000);
  check("粘来的图跟选的一样：登记时进图床",
    store.length === beforeN + 1 && gallery.length === gBefore + 2,
    (store.length - beforeN) + " 单 / " + (gallery.length - gBefore) + " 图");
  const pastedRow = store.find((r) => r.order_sn === "261022-999999999999");

  /* ② 查看页：粘贴直接挂到当前这条单，不用先点「添加」 */
  doc.getElementById("tab-browse").click();
  await sleep(80);
  doc.querySelector('#list .ticket[data-id="' + pastedRow.id + '"]').click();
  await sleep(140);
  const iBefore = imgStore.length;
  pasteImgs([mkPng("聊天截图.png")]);
  await waitFor(() => imgStore.length === iBefore + 1, 6000);
  check("查看页粘贴 → 直接挂到当前单",
    imgStore.length === iBefore + 1,
    String(imgStore.length - iBefore));
  await waitFor(() => doc.querySelectorAll("#dImgDrop .imgcell").length === 3);
  check("详情页立刻多出一格（不用再点添加）",
    doc.querySelectorAll("#dImgDrop .imgcell").length === 3,
    String(doc.querySelectorAll("#dImgDrop .imgcell").length));

  /* ②b 光标在「记一步」的描述框里粘 → 进这一步的待传区（跟选图等效），不直接挂整单图 */
  const noteEl = doc.getElementById("dFlowNote");
  const pBefore = doc.querySelectorAll("#dFlowPick .imgcell").length;
  noteEl.focus();
  pasteImgs([mkPng("步骤截图.png")]);
  await waitFor(() => doc.querySelectorAll("#dFlowPick .imgcell").length === pBefore + 1);
  check("光标在「记一步」描述框里粘 → 进这一步的待传区",
    doc.querySelectorAll("#dFlowPick .imgcell").length === pBefore + 1,
    String(doc.querySelectorAll("#dFlowPick .imgcell").length));
  check("没顺手挂成整单图", imgStore.length === iBefore + 1, String(imgStore.length - iBefore));

  /* ③ 单行框（订单号）里粘带文字的剪贴板：让给浏览器，别把单元格截图存成图 */
  doc.getElementById("tab-create").click();
  await sleep(60);
  const nBefore = doc.querySelectorAll("#fImgDrop .imgcell").length;
  const notTaken = pasteImgs([mkPng("单元格.png")], {
    withText: true, text: "261022-123456789012", focus: doc.getElementById("fOrder"),
  });
  await sleep(120);
  check("单行框里粘带文字的剪贴板 → 文本优先，不抢",
    notTaken === true && doc.querySelectorAll("#fImgDrop .imgcell").length === nBefore,
    notTaken === true ? "没 preventDefault" : "被抢了");

  /* ④ 描述框（textarea）里粘图：必须收下 —— 这是最常走的路径。
     顺带覆盖"截图工具带一个空 text/plain 占位"那个坑：types 里有 text/plain、
     但 getData 是空串，不能因此把图让给浏览器（那正是"按了没反应"的来源）。 */
  const taken2 = pasteImgs([mkPng("描述框截图.png")], {
    withText: true, text: "", focus: doc.getElementById("fTitle"),
  });
  await waitFor(() => doc.querySelectorAll("#fImgDrop .imgcell").length === nBefore + 1);
  check("描述框里粘图 → 收下（空 text/plain 不算文字）",
    taken2 === false && doc.querySelectorAll("#fImgDrop .imgcell").length === nBefore + 1,
    (taken2 === false ? "收下了" : "被让掉了") + " / " + doc.querySelectorAll("#fImgDrop .imgcell").length);
  doc.querySelector("#fImgDrop .imgcell .del").click();     // 收尾：别把这批留给下一段建的单
  await sleep(60);
  check("待传区清得干净（不带给下一单）",
    doc.querySelectorAll("#fImgDrop .imgcell").length === 0,
    String(doc.querySelectorAll("#fImgDrop .imgcell").length));

  /* ⑤ 别的页签（表格）粘图：说清该去哪儿，而不是静默什么都不发生 */
  doc.getElementById("tab-table").click();
  await sleep(80);
  const imgN = imgStore.length;
  pasteImgs([mkPng("表格页.png")]);
  await sleep(120);
  check("表格页粘图 → 给提示、不入库",
    imgStore.length === imgN && /先切到/.test(doc.getElementById("toast").textContent || ""),
    doc.getElementById("toast").textContent);
  doc.getElementById("tab-create").click();
  await sleep(60);
}

console.log("\n12. 状态进度也能附图（v1.10.0：图挂在某一步上）");
{
  const before = store.length;
  const gBefore = gallery.length;
  const iBefore = imgStore.length;
  doc.getElementById("tab-create").click();
  await sleep(60);
  doc.getElementById("fOrder").value = "261022-888888888888";
  doc.getElementById("fOrder").dispatchEvent(new win.Event("input", { bubbles: true }));
  doc.getElementById("btnAdd").click();
  await waitFor(() => store.length === before + 1, 3000);
  const row = store.find((r) => r.order_sn === "261022-888888888888");

  doc.getElementById("tab-browse").click();
  await sleep(80);
  doc.querySelector('#list .ticket[data-id="' + row.id + '"]').click();
  await sleep(140);

  const sel = doc.getElementById("dFlow");
  check("记一步的表单里有阶段下拉", !!sel);
  sel.value = "已联系快递";     // 跟第 7 节同一套阶段名（选项来自默认流程）

  /* 先在「记一步」的表单里选两张图 —— 这一步提交前不该进图床 */
  const g1 = new win.File([new Uint8Array([137, 80, 78, 71])], "补发单.png", { type: "image/png" });
  const g2 = new win.File([new Uint8Array([137, 80, 78, 71])], "聊天记录.png", { type: "image/png" });
  pickFiles(doc, win, "dFlowFile", [g1, g2]);
  await waitFor(() => doc.querySelectorAll("#dFlowPick .imgcell").length === 2);
  check("记一步之前能先选图，两张都排成待传格",
    doc.querySelectorAll("#dFlowPick .imgcell").length === 2 &&
    imgStore.length === iBefore,
    doc.querySelectorAll("#dFlowPick .imgcell").length + " 格 / " + (imgStore.length - iBefore) + " 条关联");

  doc.getElementById("dFlowNote").value = "已补发，单号发在聊天里";
  doc.getElementById("btnFlow").click();
  await waitFor(() => imgStore.length === iBefore + 2, 6000);

  const flow = JSON.parse(row.flow || "[]");
  const sid = flow[0] && flow[0].u;
  check("记一步时给这一步生成了稳定 id（u）", flow.length === 1 && !!sid, JSON.stringify(flow));
  const mine = imgStore.filter((r) => r.ticket_id === row.id);
  check("两张图都挂在这一步上（step_uid = 那一步的 u）",
    mine.length === 2 && mine.every((r) => r.step_uid === sid),
    JSON.stringify(mine.map((r) => r.step_uid)) + " vs " + sid);
  check("图床里也存下了这两张", gallery.length === gBefore + 2, String(gallery.length - gBefore));
  check("图床标题带上单号和阶段名（翻图床时认得出）",
    /异常单 261022-888888888888 附图 · /.test(gallery[gBefore]?.title || ""),
    gallery[gBefore]?.title);

  /* 时间线：这一步下面直接排着它的缩略图；整单「图片」区不混进来 */
  check("时间线上这一步下面排着两张缩略图",
    doc.querySelectorAll("#flowTl .tlpic .imgcell").length === 2,
    String(doc.querySelectorAll("#flowTl .tlpic .imgcell").length));
  /* 格子要真出图 —— 宿主回的 thumb 是空串，缩略图得是工具自己压的那张，
     否则格子里就写着「无预览」 */
  const tlCells = doc.querySelectorAll("#flowTl .tlpic .imgcell");
  check("步骤图格子里是真图，不是「无预览」",
    !tlCells[0]?.querySelector(".noimg") &&
    /^data:image\//.test(tlCells[0]?.querySelector("img")?.getAttribute("src") || ""),
    (tlCells[0]?.textContent || "").slice(0, 20) + " / " +
      (tlCells[0]?.querySelector("img")?.getAttribute("src") || "").slice(0, 30));
  check("整单「图片」区不混步骤图",
    doc.querySelectorAll("#dImgDrop .imgcell").length === 0,
    String(doc.querySelectorAll("#dImgDrop .imgcell").length));
  check("「图片」区注明另有几张记在流程步骤上",
    /另有 2 张记在流程步骤上/.test(doc.querySelector("#sectImgs")?.textContent || ""),
    doc.querySelector("#sectImgs")?.textContent?.slice(0, 80));

  /* 历史步骤补图：不用"编辑这一步"，点时刻旁边的「+图」就行 */
  const addBtn = doc.querySelector('#flowTl [data-stepimg="0"]');
  check("每一步的时刻旁边都有「+图」", !!addBtn);
  addBtn.click();
  const g3 = new win.File([new Uint8Array([137, 80, 78, 71])], "后来找到的.png", { type: "image/png" });
  pickFiles(doc, win, "dStepFile", [g3]);  await waitFor(() => imgStore.length === iBefore + 3, 6000);
  check("历史步骤能补图，挂的还是原来那一步",
    imgStore.filter((r) => r.ticket_id === row.id).length === 3 &&
    imgStore.filter((r) => r.ticket_id === row.id).every((r) => r.step_uid === sid),
    JSON.stringify(imgStore.filter((r) => r.ticket_id === row.id).map((r) => r.step_uid)));

  /* 删掉这一步：名下图的关联一起清（原图留在图床） */
  doc.querySelector('#flowTl [data-delflow="0"]').click();
  await sleep(100);
  check("删步骤的确认框说明它的图只解除关联",
    /3 张图只解除关联/.test(doc.querySelector(".dlgm")?.textContent || ""),
    doc.querySelector(".dlgm")?.textContent?.slice(0, 90));
  const gKeep = gallery.length;
  doc.getElementById("dlgYes").click();
  await waitFor(() => imgStore.filter((r) => r.ticket_id === row.id).length === 0, 5000);
  check("删掉这一步 → 它名下的图关联也清了",
    imgStore.filter((r) => r.ticket_id === row.id).length === 0,
    String(imgStore.filter((r) => r.ticket_id === row.id).length));
  check("图床里的原图一张没删", gallery.length === gKeep, gallery.length + " vs " + gKeep);

  /* 详情页右上「添加」走的是另一个文件框（dImgFile）—— 和登记页 / 记一步是各自独立的
     一段 onchange，都得单独验一遍「选完真的会动」（同一个坑曾四处都在：清 value 把
     FileList 一起清了，选完图静默无反应） */
  const g4 = new win.File([new Uint8Array([137, 80, 78, 71])], "补拍的面单.png", { type: "image/png" });
  const wholeBefore = imgStore.length;
  pickFiles(doc, win, "dImgFile", [g4]);
  await waitFor(() => imgStore.length === wholeBefore + 1, 6000);
  check("详情页「添加」选一张 → 真的存进图床并挂上了", imgStore.length === wholeBefore + 1,
    imgStore.length + " vs " + wholeBefore);
  check("这张是**整单图**（没有 step_uid）",
    !imgStore[imgStore.length - 1]?.step_uid,
    String(imgStore[imgStore.length - 1]?.step_uid));
  check("选完立刻出现在「图片」区",
    doc.querySelectorAll("#dImgDrop .imgcell").length === 1,
    String(doc.querySelectorAll("#dImgDrop .imgcell").length));
  /* 左栏列表给带图的单子挂一个「N 图」标签 —— 不点开也能知道哪条有照片 */
  const picTag = doc.querySelector("#list .ticket.on .tag.pic");
  check("左栏列表标了「N 图」（含步骤图一起算）",
    !!picTag && /^\d+ 图$/.test(picTag.textContent.trim()),
    picTag ? picTag.textContent.trim() : "没有");

  /* 老流程（v1.10.0 之前的步骤没有 u）：load 时静默补上 —— 不补的话图挂不住 */
  store.push({
    id: "legacy-flow-1", order_sn: "261022-999999999999", tracking_no: "",
    courier: "", shipped_at: "2026-10-20 09:00", store: "拼5", title: "",
    category: "", handling: "", result: "", settled: "", note: "",
    flow: JSON.stringify([{ n: "待处理", t: "2026/10/20 09:00:00", at: "2026-10-20T01:00:00.000Z" }]),
    remind_at: "", remind_task: "", created_at: "2026-10-20 09:00", updated_at: "2026-10-20 09:00",
  });
  doc.getElementById("tab-create").click();
  await sleep(60);
  doc.getElementById("fOrder").value = "261022-111122223333";
  doc.getElementById("btnAdd").click();
  await waitFor(() => {
    const lr = store.find((r) => r.id === "legacy-flow-1");
    try { return !!JSON.parse(lr.flow)[0].u; } catch (e) { return false; }
  }, 3000);
  const lf = JSON.parse(store.find((r) => r.id === "legacy-flow-1").flow);
  check("老流程步骤 load 时静默补上 u（界面上的图才有地方挂）",
    !!lf[0].u && lf[0].n === "待处理", JSON.stringify(lf));
}

console.log("\n12b. 呼起客户端交给宿主（自己跳 pddim: 会把整页换成「已阻止此内容」）");
{
  /* v1.12.1 里这一下是 `location.href = "pddim:..."`。工具在 sandbox iframe 里，
     Chromium 拦自定义协议导航时会把**整个 iframe** 换成错误页 ——
     唤不起来，页面上还没提交的东西也一起没了。现在必须走 shell.open。 */
  doc.getElementById("tab-browse").click();
  await sleep(100);
  const callRow = store.find((r) => r.store === "拼5" && r.order_sn);
  doc.querySelector('#list .ticket[data-id="' + callRow.id + '"]').click();
  await sleep(150);

  const beforeCall = args.filter((a) => a.op === "shell.open").length;
  doc.getElementById("btnCall").click();
  await waitFor(() => args.filter((a) => a.op === "shell.open").length > beforeCall, 3000);
  const callReq = args.filter((a) => a.op === "shell.open").pop();
  check("点「呼起客户端」→ 发 shell.open 给宿主", !!callReq, JSON.stringify(args.slice(-3)));
  check("链接是 pddim:sendmsg，客服 ID 与订单号都对",
    !!callReq &&
      callReq.payload.url.indexOf("pddim:sendmsg/?") === 0 &&
      callReq.payload.url.indexOf("mallcsid=987654") > 0 &&
      callReq.payload.url.indexOf("ordersn=" + encodeURIComponent(callRow.order_sn)) > 0,
    callReq && callReq.payload.url);
  check("页面原地不动（没把 iframe 导航走）",
    doc.getElementById("btnCall") !== null &&
      win.location.href === "http://localhost/abnormal-ticket/index.html",
    win.location.href);
  check("toast 说清已经交给系统",
    /已交给系统唤起客户端/.test(doc.getElementById("toast").textContent || ""),
    doc.getElementById("toast").textContent);

  /* 旧宿主（兜底回「不支持的操作：shell.open」）：要给一句人能看懂的 */
  shellFail = "不支持的操作：shell.open";
  doc.getElementById("btnCall").click();
  await waitFor(() => /升级到 0\.3\.0/.test(doc.getElementById("toast").textContent || ""), 3000);
  check("旧宿主 → 提示升级到 0.3.0（不静默、也不甩原文）",
    /升级到 0\.3\.0/.test(doc.getElementById("toast").textContent || ""),
    doc.getElementById("toast").textContent);
  shellFail = null;
}

console.log("\n13. 默认窗口宽度下三栏并排（流程栏在右侧，不掉到底部）");
{
  /* jsdom 不做布局，只能量样式表本身：这三条就是"默认 1120×760（工具区约 840）
     打开时流程栏还在右边"的全部依据，改了它们页面就会掉回上下排。 */
  const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
  check("流程栏是比例宽（clamp 230–320），不是写死 320",
    /\.paneFlow\s*\{[^}]*flex:\s*0 0 clamp\(230px,\s*27%,\s*320px\)/.test(css));
  check("上下排的断点收在 800（原来 1180 会在默认宽度就把流程栏甩到下面）",
    /@media \(max-width: 800px\)\s*\{\s*\.panes\s*\{\s*flex-direction: column/.test(css));
  const i1180 = css.indexOf("@media (max-width: 1180px)");
  const i960 = css.indexOf("@media (max-width: 960px)");
  const i800 = css.indexOf("@media (max-width: 800px)");
  const blk1180 = i1180 >= 0 && i960 > i1180 ? css.slice(i1180, i960) : "";
  const blk960 = i960 >= 0 && i800 > i960 ? css.slice(i960, i800) : "";
  check("1180 / 960 两条断点只收窄列表，不换行",
    !!blk1180 && !!blk960 &&
    !/flex-direction: column/.test(blk1180) && !/flex-direction: column/.test(blk960));
  check("窄下来的列表宽度取 min(拖出来的宽度, 百分比) —— 拖动仍然作数",
    /\.split > \.left\s*\{[^}]*min\(var\(--listw, 320px\),\s*24%\)/.test(css));
}
console.log("\n13b. 状态配色：逾期红 / 待办黄 / 办完绿，且可在设置里改（v1.14.0）");
{
  /* 用户 2026-10-25 的原话：「逾期的和将近的将以红色显示，完成显示绿色，待办显示黄色」。
     颜色统一走元素的 --tc，徽章和列表左色条同一个源 —— 两处分开算过就会有一天对不上。 */
  const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
  check("徽章与左色条共用一个色源 --tc",
    /\.badge\.t\s*\{[^}]*var\(--tc/.test(css) && /\.ticket\.t\s*\{[^}]*var\(--tc/.test(css));

  // ① 造一条提醒时刻已经过去的单 → 逾期
  doc.getElementById("tab-create").click();
  await sleep(60);
  doc.getElementById("fRemindAt").value = "2020-01-01 09:00";
  doc.getElementById("fOrder").value = "250101-0000";
  doc.getElementById("fTrack").value = "SF0000000000";
  doc.getElementById("fTitle").value = "过期那条";
  doc.getElementById("btnAdd").click();
  await sleep(250);
  const lateRow = store[store.length - 1];
  const lateEl = doc.querySelector('#list .ticket[data-id="' + lateRow.id + '"]');
  check("逾期的单：列表左色条是红（--danger）",
    !!lateEl && /--danger/.test(lateEl.getAttribute("style") || ""),
    lateEl ? lateEl.getAttribute("style") : "列表里没有这条");
  check("逾期的单：徽章也走同一色源（不是各写各的）",
    !!lateEl && lateEl.querySelector(".badge")?.classList.contains("t") === true);

  // ② 再登记一条（默认 24 小时）→ 待办黄
  doc.getElementById("tab-create").click();
  await sleep(60);
  doc.getElementById("fRemindAt").value = "";
  doc.getElementById("fOrder").value = "250101-0001";
  doc.getElementById("fTrack").value = "SF0000000001";
  doc.getElementById("fTitle").value = "待办那条";
  doc.getElementById("btnAdd").click();
  await sleep(250);
  const todoRow = store[store.length - 1];
  const todoEl = doc.querySelector('#list .ticket[data-id="' + todoRow.id + '"]');
  check("待处理的单：是黄（--warn）",
    !!todoEl && /--warn/.test(todoEl.getAttribute("style") || ""),
    todoEl ? todoEl.getAttribute("style") : "列表里没有这条");

  // ③ 记一步「完结」→ 绿
  doc.getElementById("tab-browse").click();
  await sleep(60);
  doc.querySelector('#list .ticket[data-id="' + todoRow.id + '"]').click();
  await sleep(80);
  doc.getElementById("dFlow").value = "完结";
  doc.getElementById("btnFlow").click();
  await sleep(250);
  const doneEl = doc.querySelector('#list .ticket[data-id="' + todoRow.id + '"]');
  check("办完（完结）的单：变绿（--ok）",
    !!doneEl && /--ok/.test(doneEl.getAttribute("style") || ""),
    doneEl ? doneEl.getAttribute("style") : "列表里没有这条");

  // ④ 设置里给「待处理」挑个紫 → 列表里待处理的跟着变（"下拉选项允许设定颜色"）
  doc.getElementById("tab-settings").click();
  await sleep(80);
  const ed = doc.getElementById("optEditor");
  const groups = ed ? ed.querySelectorAll(".ogroup") : [];
  check("设置页把颜色和选项合成一块（三组）", groups.length === 3, String(groups.length));
  const flowGrp = ed && ed.querySelector('.ogroup[data-kind="status"]');
  const flowNames = flowGrp ? [...flowGrp.querySelectorAll(".oname")] : [];
  check("流程组里「完结」是锁定的最后一项",
    flowNames.some((i) => i.value === "完结" && i.disabled),
    flowNames.map((i) => i.value + (i.disabled ? "（锁）" : "")).join("/"));
  const sysRow = [...(flowGrp ? flowGrp.querySelectorAll(".orow") : [])]
    .find((r) => r.querySelector(".oname")?.value === "待处理");
  check("系统算出来的「待处理」也在一行里（只能配色）",
    !!sysRow && sysRow.querySelector(".oname").disabled === true);
  sysRow.querySelector(".osw").click();
  await sleep(80);
  const pal = doc.querySelector(".palpop");
  check("点色块弹出调色板（只给预设色，不收任意字符串）",
    !!pal && pal.querySelectorAll("[data-pv]").length >= 4,
    pal ? String(pal.querySelectorAll("[data-pv]").length) : "没弹出来");
  pal.querySelector('[data-pv="var(--violet)"]').click();
  await sleep(200);
  check("配色存进了宿主 kv", /--violet/.test(kv["colors"] || ""), kv["colors"]);
  check("选完调色板自己收起来", !doc.querySelector(".palpop"));
  doc.getElementById("tab-create").click();
  await sleep(60);
  doc.getElementById("fRemindAt").value = "";
  doc.getElementById("fOrder").value = "250101-0002";
  doc.getElementById("fTrack").value = "SF0000000002";
  doc.getElementById("fTitle").value = "配了紫色的待办";
  doc.getElementById("btnAdd").click();
  await sleep(250);
  const purpleRow = store[store.length - 1];
  const purpleEl = doc.querySelector('#list .ticket[data-id="' + purpleRow.id + '"]');
  check("配过色的状态：列表跟着用配置色",
    !!purpleEl && /--violet/.test(purpleEl.getAttribute("style") || ""),
    purpleEl ? purpleEl.getAttribute("style") : "列表里没有这条");

  // ⑤ 改名 / 删项：kv 里的列表和颜色都得跟着走（颜色键是「kind:名称」，
  //    不搬的话改个名就白配一次）
  doc.getElementById("tab-settings").click();
  await sleep(80);
  const sitRow = doc.querySelector('.ogroup[data-kind="situation"] .orow');
  const sitOld = sitRow.querySelector(".oname").value;
  sitRow.querySelector(".osw").click();
  await sleep(60);
  doc.querySelector('.palpop [data-pv="var(--ok)"]').click();
  await sleep(150);
  const sitInp = doc.querySelector('.ogroup[data-kind="situation"] .orow .oname');
  sitInp.value = sitOld + "X";
  sitInp.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(200);
  const sitKv = JSON.parse(kv["optSituations"] || "[]");
  check("改名后 kv 里的列表跟着变", sitKv.indexOf(sitOld + "X") >= 0, kv["optSituations"]);
  check("改名时颜色跟着搬（不然白配一次）",
    (kv["colors"] || "").indexOf("situation:" + sitOld + "X") >= 0, kv["colors"]);
  const delRow = doc.querySelector('.ogroup[data-kind="situation"] .orow');
  const delName = delRow.querySelector(".oname").value;
  delRow.querySelector(".odel").click();
  await sleep(200);
  const sitKv2 = JSON.parse(kv["optSituations"] || "[]");
  check("删项：kv 列表少一项、颜色也一起清掉",
    sitKv2.indexOf(delName) < 0 && (kv["colors"] || "").indexOf("situation:" + delName) < 0,
    delName);

  // 把配色改回去，别影响后面的段落
  const sysRow2 = [...doc.querySelectorAll('.ogroup[data-kind="status"] .orow')]
    .find((r) => r.querySelector(".oname")?.value === "待处理");
  sysRow2.querySelector(".osw").click();
  await sleep(60);
  doc.querySelector('.palpop [data-pv=""]').click();
  await sleep(150);
}

console.log("\n13c. 列配置面板：窄窗口下不再只剩一列箭头（v1.14.0）");
{
  /* 2026-10-25 的截图：面板只有 117px 宽，列名和勾选框全被裁到窗口外 ——
     根因是 `position:absolute; right:0` 往左溢出，被 main{overflow:auto} 裁掉。
     改成 fixed + 定宽 + JS 钳制位置后，列名必须还在面板里。 */
  const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
  /* ★ 断言前先去掉注释：这段注释里为了讲清原委写了 `main{overflow:auto}`，
     里面带花括号 —— 拿 `[^}]*` 一路扫过去会在那儿断掉，误判成"规则没写"。 */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
  check("列面板是 fixed 定位（不再被滚动容器裁）",
    /\.colpanel\s*\{[^}]*position:\s*fixed/.test(cssCode));
  check("列面板定宽 248（列名/勾选框/箭头三段不互相挤）",
    /\.colpanel\s*\{[^}]*[^-]width:\s*248px/.test(cssCode));
  check("列名那一格允许省略号，但不再被压成 0 宽",
    /\.colpanel \.cn\s*\{[^}]*flex:\s*1 1 auto/.test(cssCode) && /\.colpanel \.cn\s*\{[^}]*min-width:\s*0/.test(cssCode));

  doc.getElementById("tab-table").click();
  await sleep(80);
  doc.getElementById("colBtn").click();
  await sleep(100);
  const panel = doc.getElementById("colPanel");
  check("点「列」打开面板", panel.hidden === false);
  check("面板里 15 个列名都在（不是只剩箭头）",
    panel.querySelectorAll("label .cn").length >= 15 &&
    /订单号/.test(panel.textContent) && /快递单号/.test(panel.textContent),
    String(panel.querySelectorAll("label .cn").length));
  check("每行有勾选框 + 上移/下移两个按钮",
    panel.querySelectorAll('input[type="checkbox"]').length >= 15 &&
    panel.querySelectorAll("[data-up]").length >= 15 &&
    panel.querySelectorAll("[data-dn]").length >= 15);
  check("面板打开后有屏幕坐标（由 openColPanel 算，不靠 CSS 的 right:0）",
    /px/.test(panel.style.left || "") && /px/.test(panel.style.top || ""),
    (panel.style.left || "") + "," + (panel.style.top || ""));
  panel.hidden = true;
}

console.log("\n13d. 布局 / 缩放：高度靠 flex 撑，窄窗口有档位（v1.16.0）");
{
  /* 用户要求"缩放、窗口调整不能崩"。这里能断言的只有结构约束 ——
     真正好看与否要看真机，但这些是最容易悄悄坏掉的那几条：
       · 高度不许写 calc(100vh - N)（N 是对工具栏行数的假设）
       · 页签窄了要能滚，不能把按钮压扁
       · 确认框要能在矮窗口里滚，按钮不能被顶出视口
       · 600 以下表单字段单列 */
  const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

  /* 只认"页面主容器"：浮层（列面板 / 确认框）本来就该按视口夹住，那是另一回事 */
  check("表格页 / 记录页的高度不再写死（没有 calc(100vh - N)，也没有内联 max-height）",
    !/class="tblscroll"[^>]*style=/.test(HTML) &&
    !/\.tblscroll\s*\{[^}]*max-height:\s*calc/.test(cssCode));
  check("表格页是 flex 列，表格那格吃掉剩余高度",
    /#view-table\s*\{[^}]*display:\s*flex/.test(cssCode) &&
    /#view-table\s*\{[^}]*flex-direction:\s*column/.test(cssCode) &&
    /#view-table > \.tblscroll\s*\{[^}]*flex:\s*1 1 auto/.test(cssCode));
  check("推送记录卡也是 flex 列（表头贴卡片顶、表自己滚）",
    /#view-log > \.card\s*\{[^}]*display:\s*flex/.test(cssCode));
  check("页签窄了横着滚，不换行也不压扁",
    /\.tabs\s*\{[^}]*overflow-x:\s*auto/.test(cssCode) &&
    /\.tabs button\s*\{[^}]*flex:\s*0 0 auto/.test(cssCode));
  check("窄窗口收起页头的次要信息（标题和推送按钮留住）",
    /@media \(max-width: 780px\)[\s\S]*?header \.meta\s*\{[^}]*display:\s*none/.test(cssCode));
  check("确认框在矮窗口里正文自己滚（按钮不会被顶出视口）",
    /\.dlg\s*\{[^}]*max-height:\s*calc\(100vh - 48px\)/.test(cssCode) &&
    /\.dlg-b\s*\{[^}]*overflow:\s*auto/.test(cssCode));
  check("600px 以下表单字段一律单列",
    /@media \(max-width: 600px\)[\s\S]*?\.grid24 > \*\s*\{[^}]*grid-column:\s*span 24/.test(cssCode));
  check("流程栏只在还并排的那一段收窄（821–960）",
    /@media \(min-width: 821px\) and \(max-width: 960px\)[\s\S]*?\.paneFlow\s*\{[^}]*flex:\s*0 0 204px/.test(cssCode));

  doc.getElementById("tab-browse").click();
  await sleep(80);
  const firstRow = doc.querySelector("#list .ticket");
  firstRow.click();
  await sleep(120);
  const snbig = doc.querySelector("#detail .snbig");
  check("详情页头的单号是独立一格（长单号省略，不折行把按钮挤下去）",
    !!snbig && !!snbig.textContent.trim(), snbig ? snbig.textContent : "没有 .snbig");
}

console.log("\n13e. 选项自己的颜色，在登记页 / 筛选 / 查看页都得看得见（v1.17.0）");
{
  /* 用户的原话：「这些选项没有对应颜色啊」—— 设置里配过的色原来只出现在列表的小标签上，
     登记页那排胶囊、筛选下拉、查看页的锁态标签全是中性灰，等于白配一次。 */
  const couriers = Array.from(new Set(store.map((r) => (r.courier || "").trim()).filter(Boolean)));
  const cn = couriers[0] || "中通";

  doc.getElementById("tab-settings").click();
  await sleep(80);
  const cRow = [...doc.querySelectorAll('.ogroup[data-kind="courier"] .orow')]
    .find((r) => r.querySelector(".oname")?.value === cn);
  check("快递公司组里能找到 " + cn, !!cRow);
  cRow.querySelector(".osw").click();
  await sleep(60);
  const pal2 = doc.querySelector(".palpop");
  check("色块还能弹出调色板（和上一版同一个组件）", !!pal2);
  pal2.querySelector('[data-pv="var(--violet)"]').click();
  await sleep(180);

  doc.getElementById("tab-create").click();
  await sleep(80);
  const cpill = doc.querySelector('#fCourier .pill[data-v="' + cn + '"]');
  check("登记页的快递胶囊带上了配置色（--tc）",
    !!cpill && cpill.classList.contains("c") && /--violet/.test(cpill.getAttribute("style") || ""),
    cpill ? cpill.getAttribute("style") : "没有这个胶囊");

  cpill.click();
  await sleep(80);
  const onPill = doc.querySelector('#fCourier .pill[data-v="' + cn + '"]');
  check("选中之后是它自己的紫，不再统一变蓝",
    !!onPill && onPill.classList.contains("on") && onPill.classList.contains("c")
    && /--violet/.test(onPill.getAttribute("style") || ""),
    onPill ? onPill.className + " / " + onPill.getAttribute("style") : "点完没找到");

  /* 筛选下拉：展开的列表里每一项也带自己的色（option 的 inline color），
     选中的那个值把下拉自身的字染成同色 —— 一眼看出现在筛的是什么 */
  const fs = doc.getElementById("fltCourier");
  check("筛选下拉的选项里带着颜色",
    new RegExp('value="' + cn + '" style="color:var\\(--violet\\)"').test(fs.innerHTML),
    fs.innerHTML.slice(0, 120));
  fs.value = cn;
  fs.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(150);
  check("选中的筛选项，下拉自身也是那个色（不是满格亮色，只有字）",
    /--violet/.test(fs.getAttribute("style") || ""), fs.getAttribute("style") || "没上色");

  // 查看页：锁态那一个胶囊也要带色 —— 锁只表示不能改，不表示看不出是什么
  doc.getElementById("tab-browse").click();
  await sleep(120);
  const hit = store.find((r) => (r.courier || "").trim() === cn);
  if (hit) {
    doc.querySelector('#list .ticket[data-id="' + hit.id + '"]').click();
    await sleep(150);
    const ro = doc.querySelector("#dCourier .pill.ro");
    check("查看页锁态的胶囊也是配置色",
      !!ro && ro.classList.contains("c") && /--violet/.test(ro.getAttribute("style") || ""),
      ro ? ro.className + " / " + ro.getAttribute("style") : "没有锁态胶囊");
  }

  // 收拾干净：筛选项清空、颜色改回默认（后面的段落别被这个紫影响）
  fs.value = "";
  fs.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(120);
  check("清空筛选后下拉的字回到默认色", !fs.style.color, fs.style.color);
  doc.getElementById("tab-settings").click();
  await sleep(80);
  const cRow2 = [...doc.querySelectorAll('.ogroup[data-kind="courier"] .orow')]
    .find((r) => r.querySelector(".oname")?.value === cn);
  cRow2.querySelector(".osw").click();
  await sleep(60);
  doc.querySelector('.palpop [data-pv=""]').click();
  await sleep(150);
}

console.log("\n14. 缩略图这条链路（宿主回空串时工具自己出图）");
{
  /* 图床里那张是工具自己压的：宿主 gallery.put 现在回的就是空 thumb */
  const mine = imgStore.filter((r) => r.ticket_id === "legacy-ticket-1");
  check("预置的老行已被补上缩略图", mine.length === 1 && /^data:image\//.test(mine[0].thumb || ""),
    JSON.stringify(mine.map((r) => (r.thumb || "").slice(0, 24))));
  check("缩略图不是原图（长度可控，不把原图字节塞进表）",
    (mine[0]?.thumb || "").length < 200, String((mine[0]?.thumb || "").length));
}

console.log("\n====================================================");
console.log(`    通过 ${pass} / 失败 ${fail}`);
if (failures.length) {
  console.log("    失败项：");
  for (const f of failures) console.log("      · " + f);
}
console.log("====================================================");
dom.window.close();
process.exit(fail ? 1 : 0);
