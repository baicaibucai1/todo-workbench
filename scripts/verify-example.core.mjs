/**
 * 验 examples/kitchen-sink —— 用**宿主的真代码**把示例工具装一遍、建表、
 * 再用真桥把它的每个 op 跑一遍。不是读一遍文档，是照着跑。
 */
import path from "node:path";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", { value: dom.window.crypto, configurable: true });
}

const argv = process.argv.slice(2);
const opt = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const EXAMPLE = opt("dir", "examples/kitchen-sink");
const TOOLS_ROOT = opt("tools-root", "");
if (TOOLS_ROOT) process.env.TW_APPDATA = TOOLS_ROOT;

const db = await import("../src/lib/db.ts");
const repo = await import("../src/lib/repo.ts");
const settingsMod = await import("../src/lib/settings.ts");
const toolStore = await import("../src/lib/toolStore.ts");
const toolSchema = await import("../src/lib/toolSchema.ts");
const toolBridgeMod = await import("../src/lib/toolBridge.ts");
const registry = await import("../src/lib/extensions/registry.ts");

await db.initDb();
Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { value: {}, configurable: true });

const say = (...a) => console.log(...a);
const line = (c = "-") => say(c.repeat(66));
let failed = 0;
function check(name, cond, extra = "") {
  say(`  ${cond ? "✓" : "✗"} ${name}${extra ? " —— " + extra : ""}`);
  if (!cond) failed++;
}

line("=");
say("验证示例工具：" + EXAMPLE);
line("=");

/* ---------------- 1. 装 ---------------- */
const dir = path.resolve(EXAMPLE);
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

const inst = await toolStore.installFromHtml({
  html,
  id: mf.id,
  name: mf.name,
  description: mf.description,
  icon: mf.icon,
  schema: mf.schema,
  capabilities: mf.capabilities,
  injects: mf.injects,
  author: mf.author,
  overwrite: true,
});
say(`  装到：${path.join(process.env.TW_APPDATA || "", "tools", mf.id)}`);
check("installFromHtml 通过", !!inst.manifest.id, inst.manifest.id);
check("capabilities 保留", JSON.stringify(inst.manifest.capabilities) === JSON.stringify(mf.capabilities), JSON.stringify(inst.manifest.capabilities));
check("injects 三个都在", (inst.manifest.injects || []).length === 3, JSON.stringify(inst.manifest.injects));
check("schema 通过校验", !!inst.manifest.schema, JSON.stringify(inst.manifest.schema?.tables?.map((t) => t.name)));

const reread = await toolStore.readInstalledManifest(mf.id);
check("落盘的 manifest 能被读回", !!reread && reread.id === mf.id);
check("index.html 已落盘", fs.existsSync(path.join(process.env.TW_APPDATA || "", "tools", mf.id, "index.html")));

/* ---------------- 2. 建表 ---------------- */
const validated = toolSchema.validateToolSchema(mf.id, mf.schema);
const built = await toolSchema.ensureToolSchema(mf.id, mf.dbVersion, validated);
check("私有表建出来了", built.tables.length === 1, built.tables.map((t) => t.fullName).join(","));

/* ---------------- 3. 注入声明 ---------------- */
const entries = registry.injectsFor([inst.manifest], "detailSection");
check("detailSection 在注册表里可见", entries.length === 1, JSON.stringify(entries[0]?.spec));
const rowEntries = registry.injectsFor([inst.manifest], "rowAction");
check("rowAction 在注册表里可见", rowEntries.length === 1);
check("detailAction 在注册表里可见", registry.injectsFor([inst.manifest], "detailAction").length === 1);

/* ---------------- 4. 真桥跑 op ---------------- */
const sent = [];
const fakeWin = { postMessage: (m) => sent.push(m) };
let tables = built.tables;
let settingsObj = {};
let injectCtx = undefined;

const bridge = toolBridgeMod.createToolBridge(mf.id, () => ({ contentWindow: fakeWin }), {
  getTables: () => tables,
  getSettings: () => settingsObj,
  getInject: () => injectCtx,
  peers: () => [{ id: "other", name: "别的工具", icon: "package", version: "1.0.0", description: "", running: true, active: false }],
});
bridge.attach();

let seq = 0;
const pending = new Map();
function ask(op, payload) {
  const id = "q" + ++seq;
  const msg = { source: "workbench-tool", type: "tool:request", id, op, payload: payload || {} };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const ev = new dom.window.MessageEvent("message", { data: msg });
    Object.defineProperty(ev, "source", { value: fakeWin, configurable: true });
    dom.window.dispatchEvent(ev);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error("超时：" + op));
    }, 8000);
  });
}
dom.window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.type !== "tool:response") return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  p.resolve({ ok: m.ok, data: m.data, error: m.error });
});
// 桥回给工具的消息走 fakeWin.postMessage，一并转发成事件供上面监听
const origPost = fakeWin.postMessage;
fakeWin.postMessage = (m) => {
  origPost(m);
  const ev = new dom.window.MessageEvent("message", { data: m });
  Object.defineProperty(ev, "source", { value: fakeWin, configurable: true });
  dom.window.dispatchEvent(ev);
};

say("");
say("【每个 op 真跑一遍】");

const info = await ask("info", {});
check("info", info.ok && info.data.tablePrefix === "tool_kitchen_sink_", JSON.stringify(info.data && info.data.tablePrefix));
check("info 里 gallery=false（图库默认关）", info.data.gallery === false);

// 图库关着 → 应被拒，且原因是"没有申请/不可用"
const galleryOff = await ask("gallery.list", { limit: 5 });
check("图库没开 → 被拒且原因可读", galleryOff.ok === false, String(galleryOff.error));

// 打开图库模块 + 能力已申请 → 放行
settingsObj = { "ext.gallery.enabled": "1" };
const galleryOn = await ask("gallery.list", { limit: 5 });
check("打开图库模块后放行", galleryOn.ok === true, galleryOn.ok ? `items=${galleryOn.data.items.length}` : String(galleryOn.error));

// task.get：整页模式（无 inject）→ 应被拒
const taskNoCtx = await ask("task.get", {});
check("整页模式 task.get 被拒", taskNoCtx.ok === false, String(taskNoCtx.error));

// 建一条任务，挂上注入上下文
const list = await repo.fetchLists().catch(() => []);
const listId = (list[0] && list[0].id) || "l-demo";
let taskId = null;
try {
  const t = await repo.createTask({ listId, title: "示例用的待办", dueDate: "2026-10-01" });
  taskId = t.id;
} catch (e) {
  say("  ⚠️ 建任务失败：" + e.message);
}
injectCtx = taskId ? { kind: "detailSection", taskId } : undefined;
const got = await ask("task.get", {});
check("注入后 task.get 读到那一条", got.ok === true && got.data.title === "示例用的待办", got.ok ? JSON.stringify(got.data && got.data.title) : String(got.error));

// kv
const kvSet = await ask("kv.set", { key: "demo.note", value: "hello" });
check("kv.set", kvSet.ok === true);
const kvGet = await ask("kv.get", { key: "demo.note" });
check("kv.get 读回", kvGet.ok && kvGet.data.value === "hello", JSON.stringify(kvGet.data));
const kvBad = await ask("kv.set", { key: "bad key!", value: "x" });
check("kv 非法 key 被拒", kvBad.ok === false, String(kvBad.error));
const kvAll = await ask("kv.all", {});
check("kv.all", kvAll.ok && Object.keys(kvAll.data.entries).length >= 1);
const kvDel = await ask("kv.del", { key: "demo.note" });
check("kv.del", kvDel.ok === true);

// schema.info
const si = await ask("schema.info", {});
check("schema.info", si.ok && si.data.tables[0].pk === "id", si.ok ? JSON.stringify(si.data.tables[0]) : String(si.error));

// row.*
const ins = await ask("row.insert", {
  table: "notes",
  row: { id: "n-1", title: "第一条", body: "", tag: "demo", done: 0, created_at: new Date().toISOString() },
});
check("row.insert", ins.ok === true, ins.ok ? JSON.stringify(ins.data.id) : String(ins.error));
const insNoPk = await ask("row.insert", { table: "notes", row: { title: "没主键" } });
check("缺主键被拒", insNoPk.ok === false, String(insNoPk.error));
const badType = await ask("row.insert", {
  table: "notes",
  row: { id: "n-2", title: "x", done: "0" },
});
check("integer 列传字符串被拒", badType.ok === false, String(badType.error));
const sel = await ask("row.select", { table: "notes", orderBy: "created_at", orderDir: "desc", limit: 50 });
check("row.select", sel.ok && sel.data.rows.length === 1, sel.ok ? `rows=${sel.data.rows.length} total=${sel.data.total}` : String(sel.error));
const cnt = await ask("row.count", { table: "notes" });
check("row.count", cnt.ok && cnt.data.count === 1, JSON.stringify(cnt.data));
const upd = await ask("row.update", { table: "notes", id: "n-1", patch: { done: 1 } });
check("row.update", upd.ok && upd.data.row.done === 1, upd.ok ? JSON.stringify(upd.data.row) : String(upd.error));
const del = await ask("row.delete", { table: "notes", id: "n-1" });
check("row.delete", del.ok === true);
const unknownTable = await ask("row.select", { table: "core_tasks" });
check("没声明的表被拒", unknownTable.ok === false, String(unknownTable.error));

// tools.*
const tl = await ask("tools.list", {});
check("tools.list", tl.ok && Array.isArray(tl.data.tools), tl.ok ? `tools=${tl.data.tools.length}` : String(tl.error));
const tsend = await ask("tools.send", { tool: "not-here", event: "demo", data: {} });
check("tools.send 给没在跑的工具 → 明确报错", tsend.ok === false, String(tsend.error));
const tself = await ask("tools.open", { tool: mf.id, data: {} });
check("tools.open 拉起自己被拒", tself.ok === false, String(tself.error));

line();
say(failed === 0 ? `全部通过（${seq} 次调用）` : `有 ${failed} 项没通过（共 ${seq} 次调用）`);
line();
process.exit(failed === 0 ? 0 : 1);
