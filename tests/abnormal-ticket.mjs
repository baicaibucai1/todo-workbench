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

/* ---------------- 假宿主 ---------------- */
const store = [];          // 台账行
const kv = {};             // 工具 kv
const ops = [];            // 收到的 op 流水
const args = [];           // 每个 op 的参数（要看推送第一步是不是 dryRun）

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
    case "row.select":
      reply(win, m.id, true, { rows: store.slice() });
      return;
    case "row.insert": {
      const row = Object.assign({ id: newId(), created_at: new Date().toISOString() }, p.row || {});
      store.push(row);
      reply(win, m.id, true, { row });
      return;
    }
    case "row.update": {
      const row = store.find((r) => r.id === p.id) || null;
      if (row) Object.assign(row, p.patch || {});
      reply(win, m.id, true, { row });
      return;
    }
    case "row.delete": {
      const i = store.findIndex((r) => r.id === p.id);
      if (i >= 0) store.splice(i, 1);
      reply(win, m.id, true, { ok: true });
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
      // 增量口径：新增 1 行、改 2 个格，表上还有 1 行本地没有（留着不动）
      reply(win, m.id, true, {
        count: store.length,
        appended: 0,
        added: 1,
        changed: 2,
        orphanRows: 1,
        dryRun: p.dryRun === true,
      });
      return;
    case "wps.mcpPull":
      // 与 toolBridge.ts 的 mcpPull 回包同形：{ header, adds:[{key,store,status}], updates:[{…,changes}] }
      reply(win, m.id, true, {
        header: ["订单号", "快递单号"],
        adds: [{ key: "261020-111111111111", store: "拼5", status: "待处理" }],
        updates: [{ key: "6931234567890123456", store: "拼5", status: "处理中", changes: ["情况"] }],
      });
      return;
    case "wps.mcpApply":
      reply(win, m.id, true, { added: 1, updated: 0 });
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
win.addEventListener("message", (e) => host(win, e));
win.addEventListener("error", (e) => errors.push("window.error: " + (e.message || e)));

await sleep(120);
win.postMessage({ source: "workbench-host", type: "tool:context", data: { theme: "light", gallery: false } }, "*");
await sleep(200);

console.log("1. 页面起得来");
check("没有未捕获报错", errors.length === 0, errors.join(" | "));
check("连上了宿主（bindState=bound）", doc.body.dataset.bindState === "bound", doc.body.dataset.bindState);
check("状态点写着「已连工作台」", (doc.getElementById("hostState")?.textContent || "").includes("已连工作台"));

console.log("\n2. 四个页签切得动");
for (const [tab, view] of [["browse", "view-browse"], ["table", "view-table"], ["settings", "view-settings"], ["create", "view-create"]]) {
  doc.getElementById("tab-" + tab).click();
  await sleep(30);
  const v = doc.getElementById(view);
  const others = ["view-create", "view-browse", "view-table", "view-settings"].filter((x) => x !== view);
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
  check("主栏分区顺序是 基本信息 → 提醒（处理区已移除）",
    sects.length === 2 && /^基本信息/.test(sects[0]) && sects[1] === "跟进提醒", sects.join(" / "));
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
  check("记一步按钮是整行宽的大按钮",
    (btn3?.getAttribute("style") || "").replace(/\s/g, "").includes("width:100%"),
    btn3?.getAttribute("style"));
  check("流程栏顶有红色大字倒计时（还有 …）",
    /还有/.test(doc.querySelector("#flowPane .cd")?.textContent || ""),
    doc.querySelector("#flowPane .cd")?.textContent);
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
  /* 日期模式回归：详情页的登记时间还是纯日期，点日期即收
     （登记页已经没有手填的日期框了 —— 登记时间就是当下） */
  doc.getElementById("tab-browse").click();
  await sleep(60);
  doc.getElementById("btnBaseToggle").click();     // 解锁基本信息才能点日期框
  await sleep(60);
  const fd = doc.getElementById("dDate");
  fd.onfocus.call(fd);
  await sleep(30);
  check("日期模式：时刻行隐藏、日期快捷键在",
    doc.getElementById("dpTime").hidden === true && doc.getElementById("dpFootDate").hidden === false);
  doc.querySelector("#dpGrid [data-day]").click();
  await sleep(30);
  check("点日期 → 只写 YYYY-MM-DD 并收起",
    /^\d{4}-\d{2}-\d{2}$/.test(fd.value) && doc.getElementById("dp").hidden === true, fd.value);

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

  // 手选一个时刻 → 登记，提醒就按手选的
  fr.value = "2030-01-02 09:30";
  doc.getElementById("fOrder").value = "250102-7777";
  doc.getElementById("fTrack").value = "SF0000000001";
  doc.getElementById("fTitle").value = "手选提醒时刻这条";
  doc.getElementById("btnAdd").click();
  await sleep(250);
  const rx = store[store.length - 1];
  check("手选时刻后能登记", rx && rx.title === "手选提醒时刻这条", JSON.stringify(rx && rx.order_sn));
  check("登记时间自动 = 今天（不是手填的）", rx.shipped_at === td, rx && rx.shipped_at);
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

console.log("\n7. 推送会改表 → 先摆出来，确认了才写");
doc.getElementById("wpsPush").click();
await sleep(200);
const push1 = args.filter((a) => a.op === "wps.mcpPush");
check("推送第一步是 dryRun（只看不写）", push1.length === 1 && push1[0].payload.dryRun === true,
  JSON.stringify(push1.map((a) => a.payload)));
check("弹出了确认屏", doc.getElementById("wpsPushPreview").hidden === false);
check("确认屏说清了新增 1 行",
  /新增 1 行/.test(doc.getElementById("wpsPushText").textContent || ""),
  (doc.getElementById("wpsPushText").textContent || "").slice(0, 140));
check("确认屏说清了改 2 个格",
  /改 2 个格/.test(doc.getElementById("wpsPushText").textContent || ""));
check("确认屏说明了表上多出来的行留着不动",
  /留着不动|留着没动/.test(doc.getElementById("wpsPushText").textContent || ""));
check("没确认前没有真写", args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true).length === 0);
doc.getElementById("wpsPushGo").click();
await sleep(200);
const push2 = args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true);
check("确认后才真推", push2.length === 1, JSON.stringify(args.filter((a) => a.op === "wps.mcpPush").map((a) => a.payload)));
check("推送结果有回显（说清写了几行几格）",
  /已推送/.test(doc.getElementById("wpsMsg").textContent || "") &&
  /新增 1 行/.test(doc.getElementById("wpsMsg").textContent || ""),
  doc.getElementById("wpsMsg").textContent);

console.log("\n7b. 右上角按钮同样走两步确认");
doc.getElementById("hdrPush").click();
await sleep(200);
check("右上角按钮的第一步也是 dryRun",
  args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun === true).length >= 1);
check("又弹出了确认屏", doc.getElementById("wpsPushPreview").hidden === false);
doc.getElementById("wpsPushCancel").click();
await sleep(60);
check("取消后表上一格没动（没有第二次真写）",
  args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true).length === 1,
  String(args.filter((a) => a.op === "wps.mcpPush" && a.payload.dryRun !== true).length));

doc.getElementById("wpsPull").click();
await sleep(250);
check("拉取走了 wps.mcpPull", ops.includes("wps.mcpPull"));
check("拉取后弹出了确认写库", doc.getElementById("wpsPreview").hidden === false);
check("预览里写清了「新增 1 条、更新 1 条」",
  /新增 1 条、更新 1 条/.test(doc.getElementById("wpsPreviewText").textContent || ""),
  (doc.getElementById("wpsPreviewText").textContent || "").slice(0, 80));
doc.getElementById("wpsApply").click();
await sleep(200);
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

console.log("\n====================================================");
console.log(`    通过 ${pass} / 失败 ${fail}`);
if (failures.length) {
  console.log("    失败项：");
  for (const f of failures) console.log("      · " + f);
}
console.log("====================================================");
dom.window.close();
process.exit(fail ? 1 : 0);
