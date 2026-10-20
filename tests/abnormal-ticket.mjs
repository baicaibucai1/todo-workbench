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
check("店铺下拉有选项", doc.getElementById("fStore").options.length > 0);

const fOrder = doc.getElementById("fOrder");
fOrder.value = "https://mobile.pdd.com/?mallcsid=987654&ordersn=6931234567890123456";
fOrder.dispatchEvent(new win.Event("paste", { bubbles: true }));   // 粘贴要等浏览器先写值 → 走 setTimeout
await sleep(120);
check("整条 ERP 链接被拆成订单号", doc.getElementById("fOrder").value === "6931234567890123456",
  doc.getElementById("fOrder").value);
check("链接里的客服 ID 反查出了店铺（不用手选）", doc.getElementById("fStore").value === "拼5",
  doc.getElementById("fStore").value);
// ★ 用户库里真实存在的就是 16/19 位纯数字，不是 YYMMDD-数字 —— 形状存疑只许提示，不许拦
const hint1 = doc.getElementById("addMsg").textContent || "";
check("形状存疑只提示（提示条有字）", /格式存疑|定位不到/.test(hint1), hint1.slice(0, 90));

doc.getElementById("fTrack").value = "YT9988776655";
doc.getElementById("fTitle").value = "包裹破损，客户要求赔偿";
const fCourier = doc.getElementById("fCourier");
if (fCourier.options.length > 1) fCourier.value = fCourier.options[1].value;
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
check("表头 14 列", doc.getElementById("tableHead").querySelectorAll("th").length === 14,
  String(doc.getElementById("tableHead").querySelectorAll("th").length));

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

console.log("\n====================================================");
console.log(`    通过 ${pass} / 失败 ${fail}`);
if (failures.length) {
  console.log("    失败项：");
  for (const f of failures) console.log("      · " + f);
}
console.log("====================================================");
dom.window.close();
process.exit(fail ? 1 : 0);
