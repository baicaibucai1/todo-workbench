/**
 * 沙箱 —— 把候选的 HTML **真跑一遍**，看它是不是活着。
 *
 * ============================ 为什么要真跑 ============================
 *
 * 静态检查能看出"引了 CDN"、"越权碰宿主"，但看不出"脚本一进来就抛错"、
 * "打开就是白屏"、"点第一个按钮就崩" —— 而这三类正是机器写的代码最常犯的。
 * 只扫源码就放行，等于把"装上去打不开"这件事留给用户去发现。
 *
 * ============================ 影子桥 ============================
 *
 * 试跑时宿主照样接它的桥接请求，但**不落库**：
 *
 *   · row.*    记账，返回空结果 / 合成主键（不会在试跑时弄脏真数据）
 *   · kv.*     只写内存 Map
 *   · gallery.* 记账，返回合成的一条（不真往图库塞东西）
 *   · 能力门与生产**完全一致**：没申请 gallery 却调 gallery.put，
 *     在沙箱里一样被拒 —— 这样助手当场就能看见，而不是等用户打开才发现。
 *
 * 记下来的调用统计还会回到验证器做**对账**：它调了 row.* 却没声明表，
 * 那是"装上去功能就是坏的"，必须拦下。
 *
 * ============================ 隔离 ============================
 *
 * iframe 只给 `allow-scripts`，**不给 `allow-same-origin`**：
 * 沙箱跑的是尚未安装、也没人看过一眼的代码，让它拿到宿主的源
 * （进而摸到 localStorage、父页面 DOM）是不可接受的。
 * postMessage 不受这条限制，桥接照常工作。
 *
 * 代价是它的源是 `null`，远程请求会比生产环境更容易撞上 CORS。
 * 这类报错在验证器里被判成**警告**而不是错误 —— 沙箱的隔离不能变成
 * "本来能用的工具被误杀"。
 */

import { HOST_SOURCE, TOOL_SOURCE, buildContext } from "../toolBridge";
import { isEnabled } from "../extensions/registry";
import { validateToolSchema } from "../toolSchema";
import { toolTable } from "../tools";
import type { ToolInjectSpec } from "../extensions/types";
import type { SandboxReport } from "./verifier";

/** 沙箱消息的来源标记（与桥接的 TOOL_SOURCE / HOST_SOURCE 分开，互不串台） */
export const SANDBOX_SOURCE = "workbench-sandbox";

/** 探针脚本里要替换的令牌占位符 */
const TOKEN = "__WB_SANDBOX_TOKEN__";

/**
 * 探针：为了让"它跑起来了没有、有没有报错"这件事**从外面**能看见。
 *
 * 必须注入而不是从外面监听：iframe 是隔离源，宿主读不到里面的 window，
 * 也收不到它的 console —— 唯一能进出的通道是它自己 postMessage 出来。
 */
const PROBE = [
  "(function(){",
  'var TOKEN="' + TOKEN + '";',
  "var post=function(m){try{m.source='workbench-sandbox';m.token=TOKEN;parent.postMessage(m,'*');}catch(e){}};",
  "var note=function(kind,text){var s=String(text).slice(0,300);post({type:'sandbox:log',level:kind,text:s});};",
  "window.addEventListener('error',function(e){note('error',(e.message||'运行时错误')+(e.lineno?' @行'+e.lineno:''));});",
  "window.addEventListener('unhandledrejection',function(e){",
  "  var r=e.reason;note('error','未处理的 Promise 拒绝：'+((r&&r.message)?r.message:r));});",
  "var ce=console.error;console.error=function(){",
  "  note('error','console.error：'+Array.prototype.slice.call(arguments).map(String).join(' '));",
  "  try{ce.apply(console,arguments);}catch(e){}};",
  "var cw=console.warn;console.warn=function(){",
  "  note('warn','console.warn：'+Array.prototype.slice.call(arguments).map(String).join(' '));",
  "  try{cw.apply(console,arguments);}catch(e){}};",
  "post({type:'sandbox:hello'});",
  "var sent=false;",
  "function measure(){",
  "  if(sent)return;sent=true;",
  "  var b=document.body;",
  "  var nodes=b?b.querySelectorAll('*').length:0;",
  "  var text=0;",
  "  if(b){text=(b.innerText||b.textContent||'').trim().length;}",
  "  post({type:'sandbox:done',nodes:nodes,textLen:text});",
  "}",
  // load 之后再等一会儿：很多工具是先渲染骨架、再填内容
  "window.addEventListener('load',function(){setTimeout(measure,300);});",
  // 兜底：load 一直不来（脚本卡住、资源挂在半路）也要量一次，不能干等
  "setTimeout(measure,2000);",
  "})();",
].join("\n");

/**
 * 把探针塞进候选源码。
 *
 * 位置尽量靠前（紧跟 <head> 或 <html>）：错误钩子装晚了，
 * 头部脚本里抛的错就抓不到 —— 而那正是"一打开就白屏"的高发区。
 */
export function injectProbe(html: string, token: string): string {
  const script = `<script>${PROBE.split(TOKEN).join(token)}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  return script + html;
}

/** 默认试跑时长：够等首屏渲染，又不至于让用户干等 */
export const RUN_MS = 4000;

/**
 * 这个环境能不能真跑沙箱。
 *
 * jsdom（单测环境）里有 iframe 元素，但**不执行 iframe 里的脚本** ——
 * 探针永远不说话，跑下去只会白等一个超时。所以显式排除它。
 */
export function sandboxAvailable(): boolean {
  if (typeof document === "undefined" || typeof HTMLIFrameElement === "undefined") return false;
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return false;
  return true;
}

export interface SandboxInput {
  /** 工具 id。非法 id 不影响试跑（桥接退回一个安全前缀），它另由静态体检拦下 */
  id: string;
  html: string;
  schema?: unknown;
  capabilities?: string[];
  injects?: ToolInjectSpec[];
  /** 当前设置（能力门要用） */
  settings?: Record<string, string>;
  /** 试跑时长上限，默认 RUN_MS */
  timeoutMs?: number;
}

/** 桥接在沙箱里的记账：合成主键从这里发号，方便工具自己拼出可复现的 id */
let sandboxSeq = 0;

export async function runSandbox(input: SandboxInput): Promise<SandboxReport> {
  const empty = (reason: string): SandboxReport => ({
    ran: false,
    reason,
    errors: [],
    warnings: [],
    rendered: false,
    ops: {},
    opErrors: [],
  });

  if (!sandboxAvailable()) return empty("当前环境不能运行 iframe 沙箱（没有可执行的沙箱）");
  if (!input.html.trim()) return empty("源码是空的");

  const settings = input.settings ?? {};
  const caps = new Set((input.capabilities ?? []).map(String));
  const safeId = /^[a-z][a-z0-9-]{1,31}$/.test(input.id.trim()) ? input.id.trim() : "sandbox";
  const schema = validateToolSchema(safeId, input.schema);
  const tables = (schema?.tables ?? []).map((t) => t.name);
  const kv = new Map<string, string>();

  const report: SandboxReport = {
    ran: false,
    errors: [],
    warnings: [],
    rendered: false,
    ops: {},
    opErrors: [],
  };

  const token = `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const frame = document.createElement("iframe");
  // 隔离源：不给 allow-same-origin（理由见文件头）
  frame.setAttribute("sandbox", "allow-scripts allow-downloads allow-forms allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.title = "工具沙箱";
  // 移出视口但**保持渲染**：display:none 会让一部分布局/定时器行为与真机不同，
  // 而试跑的意义就在于尽量接近"用户真的打开它"
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:900px;height:640px;border:0;opacity:0;pointer-events:none;";
  frame.srcdoc = injectProbe(input.html, token);

  const post = (msg: Record<string, unknown>) => {
    try {
      frame.contentWindow?.postMessage(msg, "*");
    } catch {
      // 窗口已经没了（超时后清理）：这一条消息丢了就算了
    }
  };

  const reply = (id: unknown, ok: boolean, data: unknown) => {
    const base = { source: HOST_SOURCE, type: "tool:response", id };
    post(ok ? { ...base, ok: true, data } : { ...base, ok: false, error: data });
  };

  const count = (op: string) => {
    report.ops[op] = (report.ops[op] ?? 0) + 1;
  };

  /** 影子实现：记账 + 合成返回，一律不碰真实数据 */
  const handle = (op: string, payload: Record<string, unknown>, id: unknown) => {
    count(op);

    if (op === "info") {
      const ctx = buildContext(safeId, settings);
      // 声明优先：沙箱里的工具还没进注册表，能力门只能按这份声明算
      ctx.gallery = caps.has("gallery") && isEnabled(settings, "gallery");
      if (input.injects?.length) {
        ctx.inject = { kind: input.injects[0].kind, taskId: "__sandbox__" };
      }
      reply(id, true, ctx);
      return;
    }

    if (op === "schema.info") {
      reply(id, true, {
        tables: (schema?.tables ?? []).map((t) => ({
          name: t.name,
          full: toolTable(safeId, t.name),
          columns: t.columns.map((c) => `${c.name}:${c.type}${c.pk ? "(主键)" : ""}`),
        })),
      });
      return;
    }

    /* ---- kv：内存 ---- */
    if (op === "kv.get") {
      reply(id, true, { key: payload.key ?? null, value: kv.get(String(payload.key ?? "")) ?? null });
      return;
    }
    if (op === "kv.set") {
      kv.set(String(payload.key ?? ""), String(payload.value ?? ""));
      reply(id, true, { ok: true });
      return;
    }
    if (op === "kv.all") {
      reply(id, true, Object.fromEntries(kv.entries()));
      return;
    }
    if (op === "kv.del") {
      kv.delete(String(payload.key ?? ""));
      reply(id, true, { ok: true });
      return;
    }

    /* ---- row：记账，不落库 ---- */
    if (op.startsWith("row.")) {
      const bare = String(payload.table ?? "");
      if (tables.length === 0) {
        const msg = "这个工具没有声明任何数据表（manifest 里缺 schema），row.* 用不了";
        report.opErrors.push(`${op}: ${msg}`);
        reply(id, false, msg);
        return;
      }
      if (bare && !tables.includes(bare)) {
        const msg = `没有声明过「${bare}」这张表。可用的是：${tables.join("、")}`;
        report.opErrors.push(`${op}: ${msg}`);
        reply(id, false, msg);
        return;
      }
      if (op === "row.select") reply(id, true, []);
      else if (op === "row.count") reply(id, true, { table: bare, count: 0 });
      else if (op === "row.insert") reply(id, true, { id: `sandbox-${++sandboxSeq}` });
      else reply(id, true, { ok: true, changes: 1 });
      return;
    }

    /* ---- gallery：与生产同一道门，通过则给合成结果 ---- */
    if (op.startsWith("gallery.")) {
      const state = !caps.has("gallery") ? "not-granted" : isEnabled(settings, "gallery") ? "on" : "unavailable";
      if (state !== "on") {
        const msg =
          state === "not-granted"
            ? "这个扩展没有申请 gallery 能力"
            : "gallery 能力当前不可用（提供它的模块没有启用）";
        report.opErrors.push(`${op}: ${msg}`);
        reply(id, false, msg);
        return;
      }
      const item = {
        id: `sandbox-g${++sandboxSeq}`,
        kind: "image",
        title: "沙箱占位（试跑没有真的存图）",
        createdAt: new Date().toISOString(),
      };
      reply(id, true, op === "gallery.list" ? [item] : item);
      return;
    }

    /* ---- task：注入组件读当前那条待办。沙箱里给一条合成的 ---- */
    if (op === "task.get") {
      if (!caps.has("task")) {
        const msg = "这个扩展没有申请 task 能力";
        report.opErrors.push(`${op}: ${msg}`);
        reply(id, false, msg);
        return;
      }
      reply(id, true, {
        id: "__sandbox__",
        title: "沙箱里的示例待办",
        done: false,
        important: false,
        myDay: false,
        note: "",
        dueAt: null,
      });
      return;
    }

    /* ---- tools.*：沙箱里没有别的工具 ---- */
    if (op === "tools.list") {
      reply(id, true, []);
      return;
    }
    if (op === "tools.open" || op === "tools.send") {
      reply(id, true, { ok: true, note: "沙箱里没有别的工具可联动" });
      return;
    }

    const msg = `不支持的操作：${op}`;
    report.opErrors.push(msg);
    reply(id, false, msg);
  };

  interface SandboxMsg {
    source?: string;
    token?: string;
    type?: string;
    level?: string;
    text?: string;
    nodes?: number;
    textLen?: number;
  }

  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data as SandboxMsg | undefined;
    if (!m || typeof m !== "object") return;

    if (m.source === SANDBOX_SOURCE) {
      if (m.token !== token) return; // 别的沙箱实例的残留消息
      if (m.type === "sandbox:log") {
        if (m.level === "warn") report.warnings.push(String(m.text ?? ""));
        else report.errors.push(String(m.text ?? ""));
        return;
      }
      if (m.type === "sandbox:done") {
        report.rendered = Number(m.nodes ?? 0) > 0 || Number(m.textLen ?? 0) > 0;
        finish(true);
        return;
      }
      if (m.type === "sandbox:hello") {
        report.ran = true;
        // 探针活着 = 脚本真的执行了。此刻把上下文推过去，
        // 工具收到 tool:context 之后才会开始请求数据
        pushContext();
        return;
      }
      return;
    }

    // 桥接请求
    const req = m as unknown as {
      source?: string;
      type?: string;
      id?: unknown;
      op?: string;
      payload?: Record<string, unknown>;
    };
    if (req.source !== TOOL_SOURCE || req.type !== "tool:request") return;
    try {
      handle(String(req.op ?? ""), req.payload ?? {}, req.id);
    } catch (err) {
      reply(req.id, false, err instanceof Error ? err.message : String(err));
    }
  };

  function pushContext() {
    const ctx = buildContext(safeId, settings);
    ctx.gallery = caps.has("gallery") && isEnabled(settings, "gallery");
    if (input.injects?.length) {
      ctx.inject = { kind: input.injects[0].kind, taskId: "__sandbox__" };
    }
    post({ source: HOST_SOURCE, type: "tool:context", data: ctx });
  }

  let settled = false;
  let resolveReport: (r: SandboxReport) => void = () => {};
  const done = new Promise<SandboxReport>((res) => {
    resolveReport = res;
  });
  const startedAt = Date.now();

  function finish(byProbe: boolean) {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    window.removeEventListener("message", onMessage);
    // 探针没说话说明脚本根本没执行 —— 那不是"通过"，是"没验证到"
    if (!byProbe && !report.ran) {
      report.ran = false;
      report.reason = "试跑超时：脚本一直没有执行完（或根本没启动）";
    } else {
      report.ran = true;
    }
    report.elapsedMs = Date.now() - startedAt;
    try {
      frame.remove();
    } catch {
      // 已经不在 DOM 里
    }
    resolveReport(report);
  }

  const timer = window.setTimeout(() => finish(false), Math.max(500, input.timeoutMs ?? RUN_MS));

  window.addEventListener("message", onMessage);
  document.body.appendChild(frame);
  // srcdoc 的 load 事件在部分浏览器里不触发（隔离源下的已知差异），
  // 所以上下文的下发主要由探针的 sandbox:hello 触发，这里只做兜底
  frame.addEventListener("load", () => pushContext());

  return done;
}
