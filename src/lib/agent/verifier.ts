/**
 * 工具/组件的**验证器** —— 「这份代码能不能装」这件事的唯一判据。
 *
 * ============================ 它为什么存在 ============================
 *
 * 在这之前，助手 `install_tool` 的把关只有三条：文件空不空、超不超过 8 MB、
 * 里面有没有 `<html>`。于是"助手写了 300 行 HTML，装上去一打开是白屏"
 * 是完全可能发生的 —— 而用户看到的只是侧边栏多了一个打不开的入口。
 *
 * 助手写的东西和人在界面上导入的东西有本质区别：**它是机器批量产出的，
 * 没有人会在落盘之前看它一眼**。所以这条路必须有机器这道关，而且这道关
 * 必须由宿主把着，不能交给提示词 —— 提示词只是概率，"记得先验一下"
 * 在上下文一长的时候就会被忘掉。
 *
 * ============================ 三段式 ============================
 *
 *   1. 静态体检（staticProblems）—— 纯读源码，不需要界面
 *   2. 沙箱试跑（lib/agent/sandbox.ts）—— 真跑一遍，看它是不是活着
 *   3. 通行证（ticket）—— 前两步都过了才发；install_tool 只认票
 *
 * 第 2 步在有些环境里跑不了（没有 iframe，例如 Node）。那时退化成
 * "只过第 1 步"并**在票上记一笔 ran:false** —— 这不是放宽标准，
 * 是如实标注"没试跑过"。标准本身（有错就不给票）不因环境而变。
 *
 * ============================ 为什么票绑指纹 ============================
 *
 * 一张"我说我验过了"的空话等于没有门槛。票绑的是 (id, html, schema,
 * capabilities, injects) 的指纹：**源码改一个字节，票立刻作废**。
 * 于是助手不可能"验一份、装另一份"，也不可能拿上一版的票蒙混。
 */

import { HTML_MAX_BYTES, checkToolId } from "../toolStore";
import { validateToolSchema } from "../toolSchema";
import type { ToolInjectSpec } from "../extensions/types";

export type ProblemLevel = "error" | "warn";

export interface Problem {
  level: ProblemLevel;
  /** 机器可读的代号，测试与界面都靠它，不靠中文文案 */
  code: string;
  message: string;
  /** 怎么改。给助手看的话必须能直接照着做 */
  hint?: string;
}

/** 一份待装的候选。形状与 install_tool / sandbox_run 的参数一致 */
export interface ToolCandidate {
  id: string;
  name?: string;
  html: string;
  schema?: unknown;
  capabilities?: string[];
  injects?: ToolInjectSpec[];
}

/** 沙箱试跑的结果（sandbox.ts 产出，这里只读它） */
export interface SandboxReport {
  /** 有没有真的跑起来。false 表示环境不支持或超时 */
  ran: boolean;
  reason?: string;
  /** 控制台报错与未捕获异常（已排除网络类误报） */
  errors: string[];
  warnings: string[];
  /** 有没有渲染出可见内容 */
  rendered: boolean;
  /** 桥接调用统计，如 { "row.insert": 3 } */
  ops: Record<string, number>;
  /** 桥接拒绝过的调用（说明工具在用自己没有的能力） */
  opErrors: string[];
  elapsedMs?: number;
}

export interface Verdict {
  ok: boolean;
  problems: Problem[];
  /** 通过了才有。它是 install_tool 的门票 */
  ticket?: string;
  /** 这张票是"真跑过"验出来的，还是只过了静态体检 */
  ran: boolean;
}

const err = (code: string, message: string, hint?: string): Problem => ({
  level: "error",
  code,
  message,
  hint,
});
const warn = (code: string, message: string, hint?: string): Problem => ({
  level: "warn",
  code,
  message,
  hint,
});

/* ------------------------------------------------------------------ */
/* 静态体检                                                            */
/* ------------------------------------------------------------------ */

/**
 * 会去外部取东西的标签属性。
 *
 * 判据不是"看起来像网址"，而是**这个属性会不会触发一次加载**：
 * `<a href="https://…">` 不写进来的原因就是它不会自动加载，
 * 用户点了才走，那是一次有意的跳转，不是"装完就缺一块"。
 */
const RESOURCE_RE =
  /<(script|link|img|iframe|source|video|audio|embed|object)\b[^>]*?\b(src|href)\s*=\s*["']([^"']*)["']/gi;

/** CSS 里取外部资源：url(...) 与 @import */
const CSS_URL_RE = /url\(\s*["']?(https?:)?\/\/|url\(\s*["']?https?:/i;
const CSS_IMPORT_RE = /@import\s+(url\()?\s*["']?(https?:)?\/\//i;

/** data: / blob: 是内联内容，不算外部引用 */
function isInlineUrl(u: string): boolean {
  const v = u.trim().toLowerCase();
  return v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("#");
}

/**
 * 越过 iframe 边界去碰宿主页面的写法。
 *
 * ⚠️ 不能一刀切禁 `parent.`：桥接协议本身就要 `parent.postMessage`，
 * 那是**唯一**的合法通道。所以要禁的是"碰宿主的对象"，不是"找宿主说话"。
 */
const ESCAPE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bparent\s*\.\s*(document|location|opener|localStorage|sessionStorage|history)\b/, what: "parent.document / parent.location 等" },
  { re: /\bparent\s*\.\s*parent\b/, what: "parent.parent" },
  { re: /\btop\s*\.\s*(document|location|opener|localStorage|sessionStorage|history)\b/, what: "top.document / top.location 等" },
  { re: /\bwindow\s*\.\s*(opener|top)\s*\.\s*(document|location)\b/, what: "window.opener / window.top 的文档" },
  { re: /\bframeElement\b/, what: "window.frameElement" },
];

/** 桥接调用的用法标记（用来和声明对账） */
const USES_ROW = /\brow\s*\.\s*(count|select|insert|update|delete)\b/;
const USES_GALLERY = /\bgallery\s*\.\s*(list|get|put)\b/;
const USES_TASK = /\btask\s*\.\s*get\b/;
/** 有没有处理宿主下发的上下文（注入组件靠它知道自己挂在哪条待办上） */
const USES_CONTEXT = /tool:context/;

export function staticProblems(c: ToolCandidate): Problem[] {
  const out: Problem[] = [];
  const id = (c.id ?? "").trim();
  const html = c.html ?? "";

  /* --- id --- */
  const idBad = checkToolId(id);
  if (idBad) out.push(err("BAD_ID", `id 不合法：${idBad}`, "id 只能用小写字母/数字/连字符，字母开头，2-32 位"));

  /* --- 体积与形态 --- */
  const bytes = new TextEncoder().encode(html).length;
  if (!html.trim()) out.push(err("EMPTY_HTML", "源码是空的"));
  else {
    if (bytes > HTML_MAX_BYTES) {
      out.push(
        err(
          "TOO_BIG",
          `源码 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过 ${Math.round(HTML_MAX_BYTES / 1024 / 1024)} MB 上限`,
          "把内联的模型/大图去掉，或改成分批加载",
        ),
      );
    }
    if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
      out.push(err("NOT_HTML", "这看起来不是 HTML（里面没有 <html> 也没有 <body>）"));
    }
  }

  /* --- 自包含 --- */
  const external: string[] = [];
  for (const m of html.matchAll(RESOURCE_RE)) {
    const url = (m[3] ?? "").trim();
    if (!url || isInlineUrl(url)) continue;
    external.push(`<${m[1].toLowerCase()} ${m[2].toLowerCase()}="${url.slice(0, 60)}">`);
  }
  if (CSS_URL_RE.test(html) || CSS_IMPORT_RE.test(html)) external.push("CSS 里的 url() / @import");
  if (external.length) {
    out.push(
      err(
        "NOT_SELF_CONTAINED",
        `引用了外部资源（${external.slice(0, 3).join("、")}${external.length > 3 ? " 等" : ""}）`,
        "工作台离线优先，桌面端经 asset 协议加载：CSS 与 JS 必须全部内联，图片用 data: URI",
      ),
    );
  }

  /* --- 越权 --- */
  for (const p of ESCAPE_PATTERNS) {
    if (p.re.test(html)) {
      out.push(
        err(
          "ESCAPES_IFRAME",
          `源码里有越过 iframe 边界碰宿主页面的写法（${p.what}）`,
          "要数据就用 postMessage 走桥接（parent.postMessage 是允许的），不要直接读宿主的 DOM/存储",
        ),
      );
      break;
    }
  }

  /* --- schema --- */
  const ownsId = id || "__pending__";
  const schema = c.schema === undefined || c.schema === null ? null : validateToolSchema(ownsId, c.schema);
  if (c.schema !== undefined && c.schema !== null && !schema) {
    out.push(
      err(
        "BAD_SCHEMA",
        "schema 没通过校验",
        "表名/列名只能用小写字母数字下划线、首字母必须是字母；每张表恰好一个 pk:true 的列；" +
          "类型只有 text/integer/real。规则全文见 read_skill 的 data-binding",
      ),
    );
  }

  /* --- 声明与用法对账 --- */
  const caps = new Set((c.capabilities ?? []).map((x) => String(x)));
  if (USES_ROW.test(html) && !schema) {
    out.push(
      err(
        "ROW_WITHOUT_SCHEMA",
        "源码在用 row.*，但没有声明任何数据表",
        "install_tool 时带上 schema；表结构怎么写见 read_skill 的 data-binding",
      ),
    );
  }
  if (USES_GALLERY.test(html) && !caps.has("gallery")) {
    out.push(
      err(
        "GALLERY_NOT_DECLARED",
        "源码在用 gallery.*，但没申请 gallery 能力",
        "install_tool / sandbox_run 的 capabilities 里加上 \"gallery\"",
      ),
    );
  }
  if (USES_TASK.test(html) && !caps.has("task")) {
    out.push(
      err(
        "TASK_NOT_DECLARED",
        "源码在用 task.get，但没申请 task 能力",
        "注入组件要读当前那条待办，capabilities 里得写上 \"task\"",
      ),
    );
  }
  if (schema && !USES_ROW.test(html)) {
    out.push(warn("SCHEMA_UNUSED", "声明了数据表，但源码里没看到 row.* 调用", "确认一下是不是忘了读写，还是真的只是预留"));
  }
  if (schema && !/try\s*\{|catch\s*\(/.test(html)) {
    out.push(warn("NO_TRY_CATCH", "源码里没有 try/catch，写数据失败时用户可能只看到静默失败"));
  }

  /* --- 注入组件 --- */
  const injects = c.injects ?? [];
  if (injects.length && !USES_CONTEXT.test(html)) {
    out.push(
      warn(
        "INJECT_NO_CONTEXT",
        "声明了注入位置，但源码里没有处理 tool:context",
        "注入组件靠 tool:context 拿到自己在哪条待办上（ctx.inject.taskId），不读它就成了每条待办上都一样的死面板",
      ),
    );
  }
  if (USES_TASK.test(html) && injects.length === 0) {
    out.push(warn("TASK_WITHOUT_INJECT", "用了 task.get 但没有声明注入位置", "task.get 只在注入组件里才有上下文，整页工具拿不到"));
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 沙箱报告判定                                                        */
/* ------------------------------------------------------------------ */

/** 网络类报错：沙箱是隔离源（origin: null），生产环境未必如此，降级为警告 */
const NETWORK_RE =
  /network|net::|failed to fetch|load resource|cors|access-control|blocked by|ERR_/i;

export function reportProblems(c: ToolCandidate, r: SandboxReport): Problem[] {
  const out: Problem[] = [];

  if (!r.ran) {
    out.push(
      warn(
        "NOT_RUN",
        `没能真的试跑：${r.reason ?? "环境不支持"}`,
        "静态体检仍然算通过；装好之后请提醒用户打开看一眼",
      ),
    );
    return out;
  }

  for (const e of r.errors) {
    const net = NETWORK_RE.test(e);
    out.push(
      net
        ? warn("SANDBOX_NETWORK", `试跑时的网络报错：${e}`, "沙箱是隔离源，装到桌面版后可能正常")
        : err("SANDBOX_ERROR", `试跑时报错：${e}`, "照着报错改源码，改完重新 sandbox_run 再装"),
    );
  }
  for (const w of r.warnings) out.push(warn("SANDBOX_WARN", `试跑时的警告：${w}`));

  if (!r.rendered) {
    out.push(
      err(
        "BLANK",
        "试跑结束界面还是空的（没有渲染出任何可见内容）",
        "检查脚本是不是一进来就抛错、或者要等某个异步结果才渲染 —— 那样用户打开就是白屏",
      ),
    );
  }
  for (const e of r.opErrors) {
    out.push(err("BRIDGE_REFUSED", `试跑时宿主拒绝了它的一次调用：${e}`, "它调用了没申请的能力、或者用了没声明的表"));
  }

  // 桥接调用与声明对账（有的错误在工具里被 catch 掉，只在 ops 里留痕）
  const caps = new Set((c.capabilities ?? []).map((x) => String(x)));
  const used = Object.keys(r.ops);
  if (used.some((o) => o.startsWith("gallery.")) && !caps.has("gallery")) {
    out.push(err("GALLERY_NOT_DECLARED", "试跑时它调了 gallery.*，但没申请这项能力"));
  }
  if (used.some((o) => o.startsWith("row.")) && c.schema === undefined) {
    out.push(err("ROW_WITHOUT_SCHEMA", "试跑时它调了 row.*，但没有声明数据表"));
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 指纹与通行证                                                        */
/* ------------------------------------------------------------------ */

/**
 * 候选的指纹。
 *
 * 用两个不同的 32 位散列拼起来（而不是一个）—— 单个 FNV 变体在几 KB 的
 * 文本上碰撞概率已经不小，而这里的后果是"验的和装的不是同一份"。
 * 长度也拼进去：它几乎不花钱，却能让绝大多数碰撞现形。
 */
/**
 * 键顺序不影响语义，所以指纹里先把键排好再序列化。
 *
 * 现实里模型最爱在 install_tool 里把 schema 重写一遍 —— 内容一字不差，
 * 但 `{name, columns}` 写成 `{columns, name}` 就会让 `JSON.stringify` 产出
 * 不同的字符串，指纹随之改变，于是"验过的票对不上"，它又得重跑一轮
 * （2026-09-26 真跑：分段写完、沙箱通过，最后一步卡在这）。
 */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = stable(o[k]);
        return acc;
      }, {});
  }
  return v;
}

export function fingerprint(c: ToolCandidate): string {
  const body = JSON.stringify({
    id: (c.id ?? "").trim(),
    html: normalizeHtml(c.html ?? ""),
    schema: stable(c.schema ?? null),
    capabilities: [...(c.capabilities ?? [])].map(String).sort(),
    injects: stable(c.injects ?? []),
  });
  return `${body.length.toString(36)}.${hash32(body, 2166136261)}.${hash32(body, 16777619)}`;
}

/**
 * 比指纹之前先把源码弄齐整。
 *
 * 为什么需要它：模型很难两次输出**一字不差**的同一份 HTML —— 重新生成一遍时
 * 结尾多一个换行、某处 `\r\n` 变成 `\n`，内容其实一模一样，指纹却变了，
 * 于是"验过的票对不上要装的那份"，助手卡在原地反复重跑（2026-09-24 真跑时
 * 就是这个原因没装上）。
 *
 * 只抹掉**不可能承载语义**的那几种差异：BOM、CRLF、首尾空白。
 * 身体里的任何一处内容改动依然会让票作废 —— 那是这道门存在的理由。
 */
export function normalizeHtml(html: string): string {
  return html.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
}

function hash32(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

interface TicketRecord {
  fp: string;
  at: number;
  ran: boolean;
  id: string;
  /** 签发时被验过的**那一份**候选（html 已规范化） */
  cand: ToolCandidate;
}

/** 通行证有效期：够写几版源码，又不至于让一张旧票一直活着 */
const TICKET_TTL_MS = 30 * 60 * 1000;

/**
 * 台账上限。票里存着整份源码，不设上限的话一位用户写几版大文件就能把内存吃住。
 * 满了按签发时间丢最旧的 —— 反正 TTL 只有 30 分钟，丢的是最不可能再用的那张。
 */
const TICKET_MAX = 24;

/**
 * 通行证台账。**刻意放在内存里**：它不是凭证，只是"这一轮里验过了"的记号。
 * 落库的话反而要设计清理策略，而重启一次助手本来就该重新验一次。
 */
let tickets = new Map<string, TicketRecord>();

/** 给测试用：清空台账（否则上一段用例发的票会漏到下一段） */
export function __resetTickets(): void {
  tickets = new Map();
}

export function issueTicket(c: ToolCandidate, ran: boolean): string {
  // 存进去的是规范化后的那一份：装的时候直接用它，于是"验的和装的"物理上就是同一份
  const cand: ToolCandidate = { ...c, html: normalizeHtml(c.html ?? "") };
  const fp = fingerprint(cand);
  const ticket = `v1.${fp}`;
  tickets.set(ticket, { fp, at: Date.now(), ran, id: (cand.id ?? "").trim(), cand });
  if (tickets.size > TICKET_MAX) {
    const oldest = [...tickets.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) tickets.delete(oldest[0]);
  }
  return ticket;
}

export type TicketCheck =
  | { ok: true; ran: boolean }
  | { ok: false; code: string; message: string };

/** 这张票现在还能不能用于装这份候选 */
export function checkTicket(ticket: string | undefined, c: ToolCandidate): TicketCheck {
  if (!ticket || typeof ticket !== "string" || !ticket.trim()) {
    return {
      ok: false,
      code: "NO_TICKET",
      message: "没有通行证：先调 sandbox_run 把这份源码验一遍，拿到票再来装",
    };
  }
  const rec = tickets.get(ticket.trim());
  if (!rec) {
    return {
      ok: false,
      code: "TICKET_UNKNOWN",
      message: "通行证不存在或已过期：重新跑一次 sandbox_run 再装",
    };
  }
  if (Date.now() - rec.at > TICKET_TTL_MS) {
    tickets.delete(ticket.trim());
    return { ok: false, code: "TICKET_EXPIRED", message: "通行证已过期：重新跑一次 sandbox_run 再装" };
  }
  if (rec.fp !== fingerprint(c)) {
    return {
      ok: false,
      code: "TICKET_MISMATCH",
      message: "通行证与这份源码对不上（验过之后源码又改了）：按当前这份重新跑 sandbox_run",
    };
  }
  return { ok: true, ran: rec.ran };
}

/**
 * 提交时把票**换成被验过的那一份源码**。
 *
 * 两条路：
 *   · 带了 html → 比指纹，对得上才放行（防"验一份、装另一份"）；
 *   · 没带 html → 直接用票里存的那一份。
 *
 * 第二条是 2026-09-24 真跑那次补上的：助手在 sandbox_run 和 install_tool 里
 * 各写一遍源码，几乎不可能一字不差（结尾多一个换行就够了），结果票永远对不上，
 * 它只能在原地反复重跑。既然票本来就代表"这份内容验过了"，那就让它直接装
 * **票里那份** —— 既省掉一次重抄，也从物理上保证"装的必然是验过的"。
 */
export function resolveTicket(
  ticket: string | undefined,
  c: ToolCandidate,
): { ok: true; ran: boolean; candidate: ToolCandidate } | { ok: false; code: string; message: string } {
  const raw = (ticket ?? "").trim();
  if (!raw) {
    return { ok: false, code: "NO_TICKET", message: "没有通行证：先调 sandbox_run 把这份源码验一遍，拿到票再来装" };
  }
  const rec = tickets.get(raw);
  if (!rec) {
    return { ok: false, code: "TICKET_UNKNOWN", message: "通行证不存在或已过期：重新跑一次 sandbox_run 再装" };
  }
  if (Date.now() - rec.at > TICKET_TTL_MS) {
    tickets.delete(raw);
    return { ok: false, code: "TICKET_EXPIRED", message: "通行证已过期：重新跑一次 sandbox_run 再装" };
  }
  const id = (c.id ?? "").trim();
  if (id && rec.id && id !== rec.id) {
    return {
      ok: false,
      code: "TICKET_MISMATCH",
      message: `通行证是给「${rec.id}」的，这次要装的是「${id}」：按这个 id 重新跑 sandbox_run`,
    };
  }

  // 没带源码 → 装的就是当时验过的那份
  if (!normalizeHtml(c.html ?? "")) return { ok: true, ran: rec.ran, candidate: rec.cand };

  if (fingerprint(c) !== rec.fp) {
    return {
      ok: false,
      code: "TICKET_MISMATCH",
      message: "通行证与这份源码对不上（验过之后源码又改了）：按当前这份重新跑 sandbox_run，或者干脆不传 html（那就装这一次验过的那份）",
    };
  }
  return { ok: true, ran: rec.ran, candidate: { ...c, html: normalizeHtml(c.html) } };
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

/**
 * 静态 + 试跑一起判。
 *
 * 只有 **没有 error** 才发票（warn 不挡路）。挡与不挡的界线很清楚：
 * error = "装上去一定是坏的"，warn = "可能不完美，但人看了能判断"。
 */
export function verify(c: ToolCandidate, report?: SandboxReport | null): Verdict {
  const problems = [...staticProblems(c)];
  if (report) problems.push(...reportProblems(c, report));

  const blocking = problems.filter((p) => p.level === "error");
  if (blocking.length) return { ok: false, problems, ran: !!report?.ran };

  return {
    ok: true,
    problems,
    ran: !!report?.ran,
    ticket: issueTicket(c, !!report?.ran),
  };
}

/** 把问题清单排成给模型看的文本（错误在前，警告在后） */
export function formatProblems(problems: Problem[]): string {
  const rank = (p: Problem) => (p.level === "error" ? 0 : 1);
  return [...problems]
    .sort((a, b) => rank(a) - rank(b))
    .map((p) => `${p.level === "error" ? "✗" : "·"} [${p.code}] ${p.message}${p.hint ? `\n    → ${p.hint}` : ""}`)
    .join("\n");
}
