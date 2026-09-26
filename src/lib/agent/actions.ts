/**
 * 助手动作的执行层。
 *
 * ------------------------------------------------------------------
 * 这一层是"权限"真正落地的地方
 * ------------------------------------------------------------------
 * protocol.ts 只描述"有哪些动作"，真正动手全在这里。所以三件必须做到：
 *
 *   1. **每个动作先过权限门。** 门在 AGENT_TOOLS 的 permission 字段上声明，
 *      这里统一读它 —— 而不是每个 handler 自己记得判一次（漏判一次的后果
 *      是"助手在用户关掉权限之后仍然写了他的文件系统"）。
 *   2. **每个动作都回一句能给用户看的话。** 失败时回给模型的就是它唯一能
 *      转述的东西，写得含糊（"执行失败"）用户就只能猜。所以错误文案一律
 *      写清"为什么 + 怎么办"。
 *   3. **不静默。** 会改数据、改文件、改 manifest 的动作，执行前把参数
 *      原样留在动作卡上（ActionCard 会展示），执行后报告**具体结果**
 *      （装到哪个路径、建了哪几条、真 id 是什么）—— "它说它做了"和
 *      "它真做了"必须能被区分开。
 *
 * ------------------------------------------------------------------
 * 与宿主（store）的关系
 * ------------------------------------------------------------------
 * 装完工具要重扫注册表、建完日程要刷新界面、打开工具要切视图 —— 这三件事
 * 都属于 store 的职责，而 lib/ 层**不允许 import store**（见各模块的依赖方向）。
 * 所以它们做成 AgentHost 由 UI 注入：这一层保持可单测（Node 里给个假的 host 就行），
 * 依赖方向也不破。
 */

import * as repo from "../repo";
import * as workspace from "./workspace";
import { listTools, toolTable } from "../tools";
import {
  canInstallTools,
  installFromHtml,
  readInstalledManifest,
  reinstallBundledTool,
  toolDir,
  uninstallTool,
  writeToolSchema,
} from "../toolStore";
import { toolData } from "./toolData";
import { callTool } from "./toolRuntime";
import { validateToolSchema } from "../toolSchema";
import { localInputToIso } from "../datetime";
import { parseDisabledTools, SETTINGS } from "../settings";
import { skillById, SKILLS, refreshSkills as skillStore } from "./skills";
import { AGENT_TOOLS, isAskTool, toolSpec } from "./protocol";
import { normalizeInjects } from "../extensions/types";
import { runSandbox } from "./sandbox";
import {
  formatProblems,
  normalizeHtml,
  resolveTicket,
  staticProblems,
  verify,
  type ToolCandidate,
} from "./verifier";
import type { AgentAction, AgentPermissions } from "./types";
import type { Task } from "../../types";

/** 宿主侧的三件事。由 UI 注入，见文件头 */
export interface AgentHost {
  /** 数据变了，刷新界面 */
  refresh: () => Promise<void>;
  /** 工具目录变了，重扫注册表 */
  reloadTools: () => Promise<void>;
  /** 打开一个工具给用户看。返回错误说明，null 表示成功 */
  openTool: (id: string) => string | null;
}

export interface ActionContext {
  permissions: AgentPermissions;
  host: AgentHost;
  /**
   * 当前设置。惰性取，因为**能力门要按此刻的设置判断** ——
   * 用户在设置里打开图库的同一秒，沙箱就该按"图库开着"来试跑。
   * 选填：单测里给不了，取不到就按空设置（能力一律不可用）处理。
   */
  settings?: () => Record<string, string>;
}

/** 一个动作的结果。action 给界面，content 是回给模型的原始结果 */
export interface Outcome {
  action: AgentAction;
  content: string;
}

/* ------------------------------------------------------------------ */
/* 参数读取：一律带类型检查，错就说清哪里错                              */
/* ------------------------------------------------------------------ */

function str(args: Record<string, unknown>, key: string, required = false): string {
  const v = args[key];
  if (typeof v === "string") return v.trim();
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`缺少参数 ${key}`);
    return "";
  }
  throw new Error(`参数 ${key} 应该是字符串，收到的是 ${typeof v}`);
}

function bool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  // 模型偶尔给字符串 "true"/"1"。收下，但只认这两个明确的值
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`参数 ${key} 应该是布尔值，收到的是 ${JSON.stringify(v)}`);
}

/**
 * 读一个字符串数组（capabilities 之类）。
 *
 * 也接受"单个字符串"：模型不总是记得包一层数组，而为一个空壳格式问题
 * 让用户白等一轮不值得。收下它，但只认字符串元素 —— 别的类型丢掉，
 * 反正宿主那边还有一道白名单。
 */
function strList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  const raw = Array.isArray(v) ? v : [v];
  return raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

/**
 * 这次调用**给没给**这个字段 —— 和"字段的值是什么"是两件事。
 *
 * str() 把空串与缺省一视同仁（它服务的是"必填/选填"那种校验），但修改类动作
 * 必须要区分：`{ "due_date": "" }` 是"把日期清掉"，而压根没提 due_date 是
 * "别动它"。混起来的症状是"我只让它改个标题，结果这个任务的到期日没了"。
 */
function has(args: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined;
}

/**
 * 把 items 参数归一成数组。
 *
 * 也接受"单条"的写法（模型不总是记得包一层数组，尤其走文本通道时），
 * 而硬报"必须是数组"会让用户白等一轮。收下它，但**不改语义**：一条就是一条。
 */
function toItems(raw: unknown, key: string): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : raw && typeof raw === "object"
      ? [raw as Record<string, unknown>]
      : [];
  if (!items.length) throw new Error(`${key} 是空的，没有要处理的内容`);
  return items;
}

/** 一组 id（去空、去重） */
function idList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    const one = typeof raw === "string" ? raw.trim() : "";
    return one ? [one] : [];
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const HM_RE = /^\d{1,2}:\d{2}$/;

/** 本地日期校验：格式对 + 真的存在（2 月 30 号这种要挡住） */
function checkDate(v: string, key: string): string {
  if (!v) return "";
  if (!DATE_RE.test(v)) {
    throw new Error(`${key} 要用本地日期格式 YYYY-MM-DD，收到的是「${v}」`);
  }
  const d = new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`${key} 不是一个真实存在的日期：${v}`);
  const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (back !== v) throw new Error(`${key} 不是一个真实存在的日期：${v}`);
  return v;
}

/**
 * 本地时刻 → 存库用的 ISO。
 *
 * 库里统一存 `toISOString()` 的结果（与 DateTimePicker 一致），
 * 因为读的一方用的是 `new Date(...)`，两种写法它都认；
 * 但**写入方必须统一**，否则同一条数据在两个界面上显示的时间会不一样 ——
 * 而这正是"提醒到点了却没响"最可能的成因。
 */
function checkTime(v: string, key: string): string {
  if (!v) return "";
  if (!LOCAL_TIME_RE.test(v)) {
    throw new Error(`${key} 要用本地时刻格式 YYYY-MM-DDTHH:mm，收到的是「${v}」`);
  }
  const iso = localInputToIso(v);
  if (!iso) throw new Error(`${key} 不是一个有效的时刻：${v}`);
  return iso;
}

/* ------------------------------------------------------------------ */
/* 权限                                                                */
/* ------------------------------------------------------------------ */

/**
 * 权限门的**唯一实现**。
 *
 * 关掉时的文案必须能让用户自己解决：说清是哪一项、去哪里打开。
 * 只回"没有权限"的话，模型只能把它原样转述，用户看到一个死胡同。
 */
function gate(specName: string, ctx: ActionContext): void {
  const spec = toolSpec(specName);
  if (!spec?.permission) return;
  if (ctx.permissions[spec.permission]) return;

  const where = "设置 → AI 助手 → 权限";
  const label: Record<keyof AgentPermissions, string> = {
    writeTools: "写工具（往工具目录里装东西）",
    schedules: "建日程（往待办里写东西）",
    database: "绑数据表（改写工具的 manifest）",
  };
  throw new Error(
    `用户关掉了「${label[spec.permission]}」这项权限，所以这个动作没有执行。` +
      `需要的话请让用户去「${where}」打开，然后再让我做一次。`,
  );
}

/* ------------------------------------------------------------------ */
/* 源码从哪来                                                          */
/* ------------------------------------------------------------------ */

/**
 * 这一次的 HTML 源码。三个来源，从显式到兜底：
 *   1. `args.html` —— 模型直接给（短文件可以，长文件别走这条）
 *   2. `args.html_file` —— **工作区里的文件**，长文件的正路（分段 write_file 写进去）
 *   3. 正文里的 ```html 代码块 —— 由 withHtmlFallback 事先填进 args.html
 *
 * ------------------------------------------------------------------
 * 为什么第 2 条值得单独做一条路
 * ------------------------------------------------------------------
 * 一次回复的输出有长度上限。一份几千行的工具 HTML 一回复写不完，模型写到
 * 一半被掐断 —— 那个代码块是不闭合的，宿主拿不到任何源码，只能回一句
 * 「没有拿到源码」；模型以为是自己写错了，原样再来一遍，又断在同一个地方。
 * 2026-09-26 真机上就卡在这个循环里（install_tool 报「文件是空的」）。
 *
 * 分段写进工作区之后按路径取，模型**任何一步都不需要一次吐出整份源码**，
 * 这个死循环就断了。
 */
async function resolveSourceHtml(
  args: Record<string, unknown>,
  settings: Record<string, string>,
): Promise<{ ok: true; html: string } | { ok: false; message: string }> {
  const inline = typeof args.html === "string" ? args.html : "";
  if (inline.trim()) return { ok: true, html: inline };

  const file = typeof args.html_file === "string" ? args.html_file.trim() : "";
  if (!file) return { ok: false, message: "" }; // 调用方自己给那句"怎么做才对"

  const bad = workspace.checkRelPath(file);
  if (bad) return { ok: false, message: `html_file「${file}」不能用：${bad}` };

  const r = await workspace.readWorkspaceFile(settings, file);
  if (!r.ok) {
    return {
      ok: false,
      message:
        `工作区里读不到「${file}」：${r.message}。先用 write_file 把它写进去` +
        `（太长就分段：第一段正常写，之后每段带 append: true），写完再来这一步`,
    };
  }
  if (!r.content.trim()) {
    return { ok: false, message: `工作区里的「${file}」是空的 —— 文件还没写完，接着用 write_file 带 append: true 补完再来` };
  }
  return { ok: true, html: r.content };
}

/**
 * 当场把一份候选验一遍（静态 + 沙箱），返回过没过与完整报告。
 *
 * ------------------------------------------------------------------
 * 什么时候会用到它
 * ------------------------------------------------------------------
 * install_tool 带的源码与票上那份对不上时。这个局面在真机上很常见：
 * 模型在 install 那一步**又把整份源码贴了一遍**（它总觉得得给点什么），
 * 而重贴一遍几乎必然与验过的那份有出入 —— 结尾多个空行、schema 键顺序变了、
 * 或者它顺手改了一句。
 *
 * 以前的做法是直接拒绝，于是它只能重跑一轮；而重跑一轮它还是会再贴一遍，
 * 于是又对不上（2026-09-26 真跑：分段写完、沙箱通过，最后一步就卡死在这）。
 *
 * 现在改成"**那就当场再验一遍**"：过了就装新的这一份（它此刻的意图），
 * 不过就照旧拒绝并把问题列出来。通行证这道门并没有被绕过去 ——
 * 没有票、票不存在、票过期、id 对不上，一律照旧拒绝；
 * 这里做的是**把验证补做一次**，装上去的东西仍然是当场验过的。
 */
async function verifyNow(
  c: ToolCandidate,
  settings: Record<string, string>,
): Promise<{ ok: true } | { ok: false; detail: string; ran: boolean }> {
  const pre = staticProblems(c).filter((p) => p.level === "error");
  if (pre.length) return { ok: false, ran: false, detail: formatProblems(staticProblems(c)) };

  const report = await runSandbox({
    id: c.id,
    html: c.html,
    ...(c.schema ? { schema: c.schema } : {}),
    capabilities: c.capabilities ?? [],
    injects: c.injects ?? [],
    settings,
  });
  const v = verify(c, report);
  if (!v.ok) return { ok: false, ran: !!report.ran, detail: formatProblems(v.problems) };

  /*
   * 沙箱没真跑起来时，这次"补验"其实只过了静态体检 —— 那不算验过。
   *
   * 这不是洁癖：模型在 install 这一步贴出来的源码**可能正是被长度掐断的那
   * 一份**（半截的 HTML 照样能通过静态体检），这时候放行等于把坏文件装上去。
   * 判定权交给"有没有真的跑起来"，环境说了算，不由我们放宽。
   */
  if (!report.ran) {
    return {
      ok: false,
      ran: false,
      detail: "当前环境跑不了 iframe 沙箱，所以这一步只能做静态体检 —— 那不足以判定这份新源码是好的。",
    };
  }
  return { ok: true };
}

/**
 * 「没有拿到源码」那一句。
 *
 * 关键在**不能只说"缺参数"**：一句「缺少参数 html」会让模型以为是自己参数名
 * 写错了，于是它去改参数名、改缩进、把 JSON 重排一遍 —— 真正的解法却是换一条
 * 通道。所以这句话里必须把它能走的三条路都点名。
 *
 * （"你写到一半被掐断"那一种是另一回事，由 runtime 的 UNCLOSED_NOTE 说 ——
 *  那边拿得到正文全文，才判得出代码块有没有闭合。）
 */
function missingSourceHint(): string {
  return (
    "没有拿到源码：这一条里既没有 html 参数、也没有 html_file、正文里也没有 ```html 代码块。" +
    "三条路选一条 —— ① 源码不长：另起一个 ```html 代码块把**整份**源码贴出来（别只贴片段，" +
    "也别写成 ```html 之外的语言标记）；② 源码长、一次写不完：先 write_file 分段写进工作区" +
    "（第一段正常写，之后每段带 append: true），再调 sandbox_run 只给 html_file 指过去；" +
    "③ id / name / schema / capabilities 仍然放在参数里。"
  );
}

/* ------------------------------------------------------------------ */
/* 分发                                                                */
/* ------------------------------------------------------------------ */

/**
 * 执行一个动作。
 *
 * **任何异常都转成 ok:false 的动作卡**，不往外抛：一个动作失败不该
 * 中断整轮对话 —— 用户还等着看助手怎么解释。抛出只留给"程序出错"，
 * 而那种情况下 runtime 会兜住。
 */
export async function runAction(
  name: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<Outcome> {
  const spec = toolSpec(name);
  if (!spec) {
    const msg = `不认识的动作「${name}」`;
    return { action: { tool: name, args, ok: false, summary: msg, error: msg }, content: msg };
  }

  /*
   * "让助手停下来问用户"的那两个动作不该走到这里 —— 它们要 await 一个真人，
   * 由 runtime 处理（见 protocol.ts 的 ASK_TOOLS）。留这个守卫是为了让将来
   * 误用它的人看到一句能懂的话，而不是 HANDLERS[name] 抛出的 TypeError。
   */
  if (isAskTool(name)) {
    const msg = `「${spec.label}」需要在界面上问用户，必须在对话流程里用，不能直接执行。`;
    return { action: { tool: name, args, ok: false, summary: msg, error: msg }, content: msg };
  }

  try {
    gate(name, ctx);
    const out = await HANDLERS[name](args, ctx);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: { tool: name, args, ok: false, summary: `${spec.label}失败：${msg}`, error: msg },
      content: `执行失败：${msg}`,
    };
  }
}

type Handler = (args: Record<string, unknown>, ctx: ActionContext) => Promise<Outcome>;

const HANDLERS: Record<string, Handler> = {
  /* ------------------------------- 技能 ------------------------------- */

  async read_skill(args) {
    const id = str(args, "id", true);
    const skill = skillById(id);
    if (!skill) {
      const msg = `没有「${id}」这个技能。可用的：${SKILLS.map((s) => s.id).join("、")}`;
      return { action: { tool: "read_skill", args, ok: false, summary: msg, error: msg }, content: msg };
    }
    return {
      action: {
        tool: "read_skill",
        args,
        ok: true,
        summary: `已取回《${skill.title}》`,
        detail: skill.body,
      },
      // 全文原样回给模型 —— 这就是"按需取全文"的全部实现
      content: skill.body,
    };
  },

  /*
   * ------------------------------------------------------------------
   * 助手自己写技能
   * ------------------------------------------------------------------
   * 为什么要这道门拦"每条规则要有后果"：常驻索引每一轮都要消耗注意力，
   * 一条只写"要注意格式"的规则等于占了位置却什么也没说。
   * 让它在写的时候就补上"违反了会怎样"，这条规则才算成立 ——
   * 而"写了但没用"是最难察觉的一类浪费。
   */
  async add_skill(args) {
    const id = str(args, "id", true);
    const title = str(args, "title", true);
    const summary = str(args, "summary", true);
    const body = str(args, "body", true);
    const rawRules = Array.isArray(args.rules) ? args.rules : [];
    const rules = rawRules
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim())
      .filter(Boolean);

    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
      const msg = "技能 id 只能用小写字母、数字和连字符（2–32 字符，字母开头）";
      return { action: { tool: "add_skill", args, ok: false, summary: msg, error: msg }, content: msg };
    }
    // 内置那几份是代码，助手无权覆盖（覆盖了等于把"怎么写工具"的标准改了）
    if (SKILLS.some((s) => s.id === id)) {
      const msg = `「${id}」是内置技能，改不了。换一个 id，或者写一条新规矩`;
      return { action: { tool: "add_skill", args, ok: false, summary: msg, error: msg }, content: msg };
    }
    if (!rules.length) {
      const msg = "至少要有一条 rules —— 空规则占着常驻索引却什么也没说";
      return { action: { tool: "add_skill", args, ok: false, summary: msg, error: msg }, content: msg };
    }

    await repo.upsertAgentSkill({ id, title, summary, rules, body });
    await skillStore();
    const msg = `已记下《${title}》（${rules.length} 条规则，以后每轮都会带上）`;
    return {
      action: { tool: "add_skill", args, ok: true, summary: msg, detail: rules.map((r) => `· ${r}`).join("\n") },
      content: `${msg}。要改它就用同一个 id 再写一次；不要了就调 delete_skill。`,
    };
  },

  async delete_skill(args) {
    const id = str(args, "id", true);
    if (SKILLS.some((s) => s.id === id)) {
      const msg = `「${id}」是内置技能，删不掉（那是写工具的标准，删了你会开始写出装不上的工具）`;
      return { action: { tool: "delete_skill", args, ok: false, summary: msg, error: msg }, content: msg };
    }
    const ok = await repo.deleteAgentSkill(id);
    if (!ok) {
      const msg = `没有 id 为「${id}」的技能（可能已经删过了）`;
      return { action: { tool: "delete_skill", args, ok: false, summary: msg, error: msg }, content: msg };
    }
    await skillStore();
    const msg = `已删掉技能「${id}」`;
    return { action: { tool: "delete_skill", args, ok: true, summary: msg }, content: msg };
  },

  /* ------------------------- 操作已装的工具 ------------------------- */

  async call_tool(args) {
    const toolId = str(args, "tool_id", true);
    const command = str(args, "command", true);
    const params = (args.params ?? {}) as Record<string, unknown>;
    const r = await callTool(toolId, command, params);
    const name = listTools().find((t) => t.id === toolId)?.name ?? toolId;
    if (!r.ok) {
      return {
        action: { tool: "call_tool", args, ok: false, summary: `${name}：${r.message}`, error: r.message },
        content: r.message ?? "工具没有执行这条命令",
      };
    }
    const detail = r.data === undefined ? "" : JSON.stringify(r.data, null, 1);
    return {
      action: {
        tool: "call_tool",
        args,
        ok: true,
        summary: `已让${name}执行「${command}」`,
        detail,
      },
      content: `「${name}」执行了「${command}」${detail ? `，返回：${detail}` : "（没有返回值）"}。`,
    };
  },

  async uninstall_tool(args, ctx) {
    const id = str(args, "id", true);
    const tool = listTools().find((t) => t.id === id);
    if (!tool) {
      const msg = `没有 id 为「${id}」的工具。先用 list_tools 看看都有什么`;
      return { action: { tool: "uninstall_tool", args, ok: false, summary: msg, error: msg }, content: msg };
    }
    try {
      const msg = await uninstallTool(tool);
      await ctx.host.reloadTools();
      return {
        action: { tool: "uninstall_tool", args, ok: true, summary: `已卸载「${tool.name}」`, detail: msg },
        content: `已卸载「${tool.name}」。${msg}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { action: { tool: "uninstall_tool", args, ok: false, summary: msg, error: msg }, content: msg };
    }
  },

  async reinstall_tool(args, ctx) {
    const id = str(args, "id", true);
    try {
      await reinstallBundledTool(id);
      await ctx.host.reloadTools();
      const msg = `已把「${id}」恢复成出厂版本`;
      return { action: { tool: "reinstall_tool", args, ok: true, summary: msg }, content: msg };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { action: { tool: "reinstall_tool", args, ok: false, summary: msg, error: msg }, content: msg };
    }
  },

  async tool_data(args) {
    const toolId = str(args, "tool_id", true);
    const table = str(args, "table", true);
    const op = str(args, "op", true) as "select" | "count" | "insert" | "delete";
    if (!["select", "count", "insert", "delete"].includes(op)) {
      const msg = `op 只能是 select / count / insert / delete，收到的是「${op}」`;
      return { action: { tool: "tool_data", args, ok: false, summary: msg, error: msg }, content: msg };
    }
    const tool = listTools().find((t) => t.id === toolId);
    if (!tool) {
      const msg = `没有 id 为「${toolId}」的工具`;
      return { action: { tool: "tool_data", args, ok: false, summary: msg, error: msg }, content: msg };
    }

    const r = await toolData(tool, table, op, {
      values: (args.values ?? {}) as Record<string, unknown>,
      id: str(args, "id"),
      limit: Number(args.limit) || 0,
    });
    if (!r.ok) {
      return {
        action: { tool: "tool_data", args, ok: false, summary: r.message ?? "失败", error: r.message },
        content: r.message ?? "失败",
      };
    }
    const head = op === "count" ? `共 ${r.count} 条` : op === "select" ? `读到 ${r.count} 行` : `已写入/删除 ${r.affected} 行`;
    const detail =
      op === "select" && r.rows
        ? JSON.stringify(r.rows.slice(0, 20), null, 1)
        : "";
    return {
      action: { tool: "tool_data", args, ok: true, summary: `${tool.name} · ${table}：${head}`, detail },
      content: op === "select" && r.rows ? `${head}：\n${JSON.stringify(r.rows)}` : head,
    };
  },

  /* ---------------------------- 工作区（文件） ---------------------------- */

  async write_file(args, ctx) {
    const path = str(args, "path", true);
    const content = str(args, "content", true);
    const overwrite = bool(args, "overwrite");
    const append = bool(args, "append");
    const summary = str(args, "summary");
    const settings = ctx.settings?.() ?? {};

    const r = await workspace.writeWorkspaceFile(settings, path, content, overwrite, append);
    if (!r.ok) {
      return {
        action: { tool: "write_file", args, ok: false, summary: `没写成：${r.message}`, error: r.message },
        content: `没写成：${r.message}`,
      };
    }
    const name = path.split("/").pop() || path;
    const verb = append ? "已接着写" : "已写";
    const msg = summary ? `${verb}《${summary}》→ ${name}` : `${verb} ${name}`;
    return {
      action: {
        tool: "write_file",
        args,
        ok: true,
        summary: msg,
        detail: `${r.path}\n本次 ${content.length} 字符，文件共 ${r.total} 字符`,
      },
      content: [
        `${msg}。完整路径：${r.path}，文件现有 ${r.total} 字符。`,
        append
          ? "这是追加的那一段。文件没写完就**继续写下一段**（还是 append: true）；写完了再去 sandbox_run / 安装。"
          : "",
        "告诉用户可以在「工作区」里打开它，别把整份内容再贴一遍。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },

  async read_file(args, ctx) {
    const path = str(args, "path", true);
    const settings = ctx.settings?.() ?? {};
    const r = await workspace.readWorkspaceFile(settings, path);
    if (!r.ok) {
      return {
        action: { tool: "read_file", args, ok: false, summary: r.message, error: r.message },
        content: r.message,
      };
    }
    return {
      action: {
        tool: "read_file",
        args,
        ok: true,
        summary: `已读回 ${path}（${r.content.length} 字符）`,
        detail: r.content.slice(0, 4000),
      },
      content: r.content,
    };
  },

  async list_files(_args, ctx) {
    const settings = ctx.settings?.() ?? {};
    const { root, files } = await workspace.listWorkspace(settings);
    if (!root) {
      return {
        action: {
          tool: "list_files",
          args: _args,
          ok: false,
          summary: "这里没有工作区",
          error: workspace.NO_WORKSPACE_MSG,
        },
        content: workspace.NO_WORKSPACE_MSG,
      };
    }
    const lines = files.length
      ? files.map((f) => `· ${f.path}${f.isDir ? "/" : `（${f.size ?? 0} 字节）`}`).join("\n")
      : "（还是空的，你还没写过东西）";
    return {
      action: {
        tool: "list_files",
        args: _args,
        ok: true,
        summary: `工作区里有 ${files.length} 个条目`,
        detail: lines,
      },
      content: `工作区：${root}\n${lines}`,
    };
  },

  async delete_file(args, ctx) {
    const path = str(args, "path", true);
    const settings = ctx.settings?.() ?? {};
    const r = await workspace.deleteWorkspaceFile(settings, path);
    if (!r.ok) {
      return {
        action: { tool: "delete_file", args, ok: false, summary: r.message, error: r.message },
        content: r.message,
      };
    }
    const msg = `已删掉工作区里的 ${path}`;
    return { action: { tool: "delete_file", args, ok: true, summary: msg }, content: msg };
  },

  /* ------------------------------- 工具 ------------------------------- */

  async list_tools(_args) {
    const tools = listTools();
    const disabled = await disabledSet();
    const rows = tools.map((t) => ({
      id: t.id,
      name: t.name,
      version: t.version,
      source: t.source ?? "user",
      enabled: !disabled.has(t.id),
      has_schema: !!t.schema,
      tables: t.schema?.tables.map((x) => x.name) ?? [],
      description: t.description ?? "",
    }));
    return {
      action: {
        tool: "list_tools",
        args: {},
        ok: true,
        summary: `这台工作台上有 ${rows.length} 个工具`,
        detail: rows
          .map(
            (r) =>
              `${r.id} · ${r.name} v${r.version} · ${r.source === "bundled" ? "内置" : "自己导入"}` +
              `${r.enabled ? "" : "（已停用）"}${r.has_schema ? ` · 表：${r.tables.join("、")}` : ""}`,
          )
          .join("\n"),
      },
      content: JSON.stringify({ tools: rows }, null, 1),
    };
  },

  async read_tool(args) {
    const id = str(args, "id", true);
    const withHtml = bool(args, "include_html");
    const tool = listTools().find((t) => t.id === id);
    if (!tool) {
      const ids = listTools().map((t) => t.id);
      const msg = `没有 id 为「${id}」的工具。现有的：${ids.join("、") || "（一个都没有）"}`;
      return { action: { tool: "read_tool", args, ok: false, summary: msg, error: msg }, content: msg };
    }

    const manifest = {
      id: tool.id,
      name: tool.name,
      version: tool.version,
      description: tool.description ?? "",
      icon: tool.icon ?? "package",
      entry: tool.entry,
      dbVersion: tool.dbVersion,
      author: tool.author ?? "",
      source: tool.source ?? "user",
      schema: tool.schema ?? null,
    };

    let html = "";
    let htmlNote = "";
    if (withHtml) {
      if (!canInstallTools()) {
        htmlNote = "（浏览器演示模式读不到工具文件的正文）";
      } else {
        try {
          const fs = await import("@tauri-apps/plugin-fs");
          const { join } = await import("@tauri-apps/api/path");
          const file = await join(await toolDir(id), tool.entry);
          html = await fs.readTextFile(file);
        } catch (err) {
          htmlNote = `（读不到入口文件：${err instanceof Error ? err.message : String(err)}）`;
        }
      }
    }

    return {
      action: {
        tool: "read_tool",
        args,
        ok: true,
        summary: `读到「${tool.name}」${withHtml && html ? `，源码 ${html.length} 字符` : ""}`,
        detail: JSON.stringify(manifest, null, 2),
      },
      content: [
        "```json",
        JSON.stringify(manifest, null, 2),
        "```",
        html ? `\n入口 ${tool.entry} 的源码：\n\n\`\`\`html\n${html}\n\`\`\`` : htmlNote,
      ].join("\n"),
    };
  },

  /*
   * 沙箱试跑。
   *
   * 它是 install_tool 的**前置动作**，也是"验证通过才准提交"那道门的唯一发票口。
   * 这里刻意不做权限门：试跑不写任何东西（不落盘、不落库），
   * 把它挡在权限后面只会让"先看看行不行"这条最安全的路也走不通。
   */
  async sandbox_run(args, ctx) {
    const id = str(args, "id", true);
    /*
     * 源码拿不到时，报错要能照着做。
     *
     * 一句「缺少参数 html」会让模型以为是自己参数写错了，于是它去改参数名、
     * 改缩进、把 JSON 重排一遍 —— 而真正的解法是**换一条通道**
     * （```html 代码块，或者 write_file 分段 + html_file）。
     * 2026-09-24 真跑那次耗在第一轮，2026-09-26 那次耗在"它被长度掐断、
     * 却以为自己写完了"，两条都是同一类：它不知道该换路。
     */
    const src = await resolveSourceHtml(args, ctx.settings?.() ?? {});
    if (!src.ok) {
      const msg = src.message || "没有拿到源码";
      return {
        action: { tool: "sandbox_run", args, ok: false, summary: msg, error: msg },
        content: src.message ? msg : missingSourceHint(),
      };
    }
    const html = src.html;
    const name = str(args, "name");
    const capabilities = strList(args, "capabilities");
    const injects = normalizeInjects(args.injects);
    // schema 原样留着（不在这先校验）：验证器要拿"有没有声明"跟源码里的
    // row.* 调用对账，提前判成非法反而会漏掉那条一致性检查
    const candidate: ToolCandidate = {
      id,
      name,
      html,
      ...(has(args, "schema") ? { schema: args.schema } : {}),
      capabilities,
      injects,
    };

    // 静态体检先过：源码里引了 CDN、越权碰宿主这类问题**不必**跑起来就知道，
    // 让模型先改完再跑，省一轮等待（沙箱有超时，跑一次要好几秒）
    const pre = staticProblems(candidate).filter((p) => p.level === "error");
    if (pre.length) {
      const detail = formatProblems(staticProblems(candidate));
      const msg = `静态体检没过（${pre.length} 项），所以没有试跑，也没有发通行证`;
      return {
        action: {
          tool: "sandbox_run",
          args,
          ok: false,
          summary: msg,
          error: msg,
          detail,
        },
        content: [
          msg + "：",
          detail,
          "照着每一条改完源码，**重新调一次 sandbox_run**（参数里的源码要和你接下来要装的那份一字不差）。",
        ].join("\n"),
      };
    }

    const report = await runSandbox({
      id,
      html,
      ...(has(args, "schema") ? { schema: args.schema } : {}),
      capabilities,
      injects,
      settings: ctx.settings?.() ?? {},
    });
    const verdict = verify(candidate, report);

    const detail = [
      `试跑：${report.ran ? `${report.elapsedMs ?? 0} ms` : `没有跑起来（${report.reason ?? ""}）`}`,
      `渲染：${report.rendered ? "有可见内容" : "空白"}`,
      `桥接调用：${Object.keys(report.ops).length ? Object.entries(report.ops).map(([k, v]) => `${k}×${v}`).join("、") : "（没有）"}`,
      ...(verdict.problems.length ? ["", formatProblems(verdict.problems)] : []),
      ...(verdict.ticket ? ["", `通行证：${verdict.ticket}`, "把它原样带进 install_tool 的 ticket 参数。"] : []),
    ].join("\n");

    if (!verdict.ok || !verdict.ticket) {
      const blocking = verdict.problems.filter((p) => p.level === "error");
      const msg = `沙箱没通过（${blocking.length} 项问题），没有发通行证`;
      return {
        action: { tool: "sandbox_run", args, ok: false, summary: msg, error: msg, detail },
        content: [msg + "。完整报告：", detail, "改完源码重新调 sandbox_run，通过了才有票装。"].join("\n"),
      };
    }

    return {
      action: {
        tool: "sandbox_run",
        args,
        ok: true,
        summary: `沙箱通过${report.ran ? "" : "（仅静态：这个环境跑不了 iframe）"}：${name || id}`,
        detail,
      },
      content: [
        "沙箱通过，已发通行证。接下来调 install_tool，参数：",
        `  id: ${id}`,
        `  name: ${name || id}`,
        `  ticket: ${verdict.ticket}`,
        has(args, "schema") ? "  schema: 与本次试跑完全一致" : "",
        capabilities.length ? `  capabilities: ${JSON.stringify(capabilities)}` : "",
        injects.length ? `  injects: ${JSON.stringify(injects)}` : "",
        "  html: **可以不写** —— 省略时装的正是这一次验过的那份（推荐）；" +
          "要写就必须与本次试跑那份一字不差，差一个字节票就作废。",
        report.ran ? "" : "⚠️ 这个环境没有可执行的 iframe，只过了静态体检；装好之后请提醒用户打开看一眼。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },

  async install_tool(args, ctx) {
    const id = str(args, "id", true);
    const name = str(args, "name", true);
    /*
     * html **刻意不设为必填**：省略时装的会是 sandbox_run 那次验过的那份，
     * 这比让模型把整份源码再抄一遍更可靠（抄一遍就可能对不上票）。
     *
     * 但 html_file 是**显式指定**，指定了就必须读到 —— 它都指名了要装哪个文件，
     * 读不到还默默装"验过的那份"，那是替它换了个东西装上去，比报错坏得多。
     */
    const src = await resolveSourceHtml(args, ctx.settings?.() ?? {});
    if (!src.ok && src.message) {
      const msg = `没有装：${src.message}`;
      return {
        action: { tool: "install_tool", args, ok: false, summary: msg, error: src.message },
        content: msg,
      };
    }
    const html = src.ok ? src.html : "";
    const overwrite = bool(args, "overwrite");
    const capabilities = strList(args, "capabilities");
    const injects = normalizeInjects(args.injects);

    /*
     * 通行证门。**放在最前面**：没验过就装等于把"装上去打不开"留给用户去发现。
     *
     * 这道门不写在提示词里的原因与另外几道确认门一样 —— 提示词只是概率，
     * 上下文一长模型就会跳过；而"没验过的代码落到用户磁盘上"这件事
     * 不该靠概率。票绑着源码指纹，所以它也不接受"验一份、装另一份"。
     */
    const candidate: ToolCandidate = {
      id,
      name,
      html,
      ...(has(args, "schema") ? { schema: args.schema } : {}),
      capabilities,
      injects,
    };
    const gateResult = resolveTicket(str(args, "ticket"), candidate);
    const gateMsg = gateResult.ok ? "" : gateResult.message;

    /*
     * 源码（或 schema / 能力 / 注入）与票对不上时，**当场把新的这份再验一遍**。
     *
     * 直接拒绝是可证的、但它会制造一个死循环：模型在 install 这一步几乎总是
     * 重贴一遍源码，重贴就必然与验过的那份有出入，于是每轮都卡在同一句报错上
     * （2026-09-26 真跑：卡在最后一步）。补做一次验证既保住了
     * "装的一定是验过的"这条底线，也让这一步能往前走。
     *
     * 补验失败时**不**悄悄改装票里那份 —— 那等于替它换了个东西装上去。
     * 如实报出来，让它自己决定：改完重跑，或者去掉 html 装验过的那份。
     */
    let reverifyNote = "";
    let chosen: ToolCandidate | null = gateResult.ok ? gateResult.candidate : null;
    if (!gateResult.ok && gateResult.code === "TICKET_MISMATCH" && html.trim()) {
      const re = await verifyNow(candidate, ctx.settings?.() ?? {});
      if (re.ok) {
        chosen = { ...candidate, html: normalizeHtml(candidate.html ?? "") };
        reverifyNote =
          "（你这次给的源码与通行证上那份不同，我按**新的这份**当场重新验了一遍，" +
          "通过了才装。以后这一步可以不给 html —— 那装的就是验过的那一份。）";
      } else {
        const msg = re.ran
          ? `没有装：${gateMsg}；按新的这份重新验了一遍，没通过`
          : `没有装：${gateMsg}；这一步想当场补验，但当前环境跑不了沙箱，所以没有放行`;
        return {
          action: {
            tool: "install_tool",
            args,
            ok: false,
            summary: msg,
            error: msg,
            detail: re.detail,
          },
          content: [
            msg + "。" + (re.ran ? "问题如下：" : re.detail),
            re.ran ? re.detail : "",
            "两条路：① 照着上面改完源码，重新 sandbox_run 拿新票再装；" +
              "② 这一步**不给 html**（也不给 html_file），那装的就是上一次验过的那一份 —— 这是最省事的一条。",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
    }

    if (!chosen) {
      const msg = `没有装：${gateMsg}`;
      return {
        action: {
          tool: "install_tool",
          args,
          ok: false,
          summary: msg,
          error: gateMsg,
          detail:
            "流程是：写源码 → sandbox_run（拿 ticket）→ install_tool（带上 ticket）。" +
            "装的就是 sandbox_run 验过的那一份，所以 install_tool 里可以不写 html。",
        },
        content:
          msg + "。请先调 sandbox_run 把这份源码验一遍（源码另起 ```html 代码块），" +
          "拿到 ticket 后再调 install_tool（带上 ticket 即可，不必再写一遍源码）。",
      };
    }
    const { html: htmlToInstall, schema: schemaFromTicket, capabilities: capsFromTicket, injects: injectsFromTicket } =
      chosen;

    // 图标：不在白名单里就退回 package，并且**在结果里说明**。
    // 不报错的原因：图标是装饰，为一个装饰让整件事失败不值得；
    // 但要说明，否则用户会以为自己看到的图标是自己选的。
    const ICON_OK = new Set([
      "sun", "star", "calendar", "inbox", "home", "package", "crop", "receipt",
      "image", "calculator", "file", "list", "settings", "boxes", "sparkles",
      "video", "hash", "notebook-pen", "bot",
    ]);
    const rawIcon = str(args, "icon");
    const icon = ICON_OK.has(rawIcon) ? rawIcon : "package";
    const iconNote = rawIcon && !ICON_OK.has(rawIcon) ? `（图标「${rawIcon}」不在可选清单里，已用默认图标）` : "";

    // schema 自己先校验一遍：installFromHtml 内部是**静默丢掉**不合法的 schema
    // （对界面导入来说那是对的取舍），但助手这条路上，静默丢掉意味着
    // "它以为绑好了表、其实没有" —— 那必须报出来。
    // 注意取的是**票里那份**：没传 html 时，schema / capabilities / injects 都以
    // 试跑那次为准，否则会出现"按 A 建的索引、装的却是 B"
    const schemaRaw = has(args, "schema") ? args.schema : schemaFromTicket;
    let schema: ReturnType<typeof validateToolSchema> = null;
    if (schemaRaw !== undefined && schemaRaw !== null) {
      schema = validateToolSchema(id, schemaRaw);
      if (!schema) {
        throw new Error(
          "schema 没通过校验，所以没有安装（规则：表名/列名只能用小写字母数字下划线、首字母必须是字母；" +
            "每张表恰好一个 pk:true 的列；类型只有 text/integer/real；" +
            "indexes 的列必须是本表声明过的列）。请 read_skill 取 data-binding 的全文，改好再来。",
        );
      }
    }

    if (!canInstallTools()) {
      // 浏览器演示模式：**不假装成功**。把源码留在动作卡上让用户能复制走，
      // 并说清"去哪儿装"——这是这个环境里唯一诚实的做法。
      return {
        action: {
          tool: "install_tool",
          args,
          ok: false,
          summary: `浏览器演示模式装不了工具（要写文件系统）：「${name}」的源码已生成，可复制后到桌面版导入`,
          error: "浏览器演示模式无法写入工具目录，请在桌面版里安装",
          detail: "在桌面版：设置 → 工具 → 导入 HTML 单文件，把这份源码存成 .html 选进去即可。",
        },
        content:
          "环境限制：当前是浏览器演示模式，没有可写的文件系统，所以工具没有安装。" +
          "请告诉用户：这份工具的源码已经生成好了，可以点动作卡上的「复制源码」，" +
          "然后在桌面版的「设置 → 工具 → 导入 HTML 单文件」里装进去。",
      };
    }

    const { manifest, replaced } = await installFromHtml({
      id,
      name,
      html: htmlToInstall,
      description: str(args, "description") || undefined,
      icon,
      schema: schema ?? undefined,
      capabilities: capsFromTicket,
      injects: injectsFromTicket,
      author: "AI 助手",
      overwrite,
    });

    // 重扫注册表：不重扫的话侧边栏里看不到它，用户会以为没装上
    await ctx.host.reloadTools();

    const dir = await toolDir(manifest.id).catch(() => `tools/${manifest.id}`);
    const tableNames = manifest.schema?.tables.map((t) => toolTable(manifest.id, t.name)) ?? [];

    return {
      action: {
        tool: "install_tool",
        args,
        ok: true,
        summary: `${replaced ? "已更新" : "已安装"}「${manifest.name}」${iconNote}`,
        detail: [
          `id：${manifest.id}`,
          `目录：${dir}`,
          `图标：${manifest.icon}`,
          `说明：${manifest.description ?? "（无）"}`,
          tableNames.length
            ? `数据表（打开这个工具时自动建好）：\n${tableNames.map((t) => `  · ${t}`).join("\n")}`
            : "数据表：没有声明（这个工具不存自己的数据）",
          manifest.capabilities?.length ? `能力：${manifest.capabilities.join("、")}` : "",
          manifest.injects?.length
            ? `注入位置：${manifest.injects.map((s) => s.label || s.kind).join("、")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      content: [
        reverifyNote,
        `${replaced ? "已更新" : "已安装"}工具 ${manifest.id}（${manifest.name}）。`,
        `目录：${dir}`,
        tableNames.length
          ? `它会用自己的私有表：${tableNames.join("、")}。这些表在这个工具**第一次被打开时**由宿主建好。`
          : "它没有声明私有表。",
        manifest.injects?.length
          ? `它还嵌进了宿主界面（${manifest.injects.map((s) => s.kind).join("、")}）：` +
            "打开任意一条待办的详情就能看到它。"
          : "",
        "可以再调 open_tool 把它打开给用户看。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },

  async open_tool(args, ctx) {
    const id = str(args, "id", true);
    const err = ctx.host.openTool(id);
    if (err) {
      return {
        action: { tool: "open_tool", args, ok: false, summary: `打不开「${id}」：${err}`, error: err },
        content: `打不开：${err}`,
      };
    }
    const name = listTools().find((t) => t.id === id)?.name ?? id;
    return {
      action: { tool: "open_tool", args, ok: true, summary: `已在工作台里打开「${name}」` },
      content: `已打开 ${id}。它现在显示在工作台右侧的工具区里。`,
    };
  },

  /* ----------------------------- 数据表绑定 ----------------------------- */

  async bind_database(args, ctx) {
    const toolId = str(args, "tool_id", true);
    const tool = listTools().find((t) => t.id === toolId);
    if (!tool) {
      const ids = listTools().map((t) => t.id);
      const msg = `没有 id 为「${toolId}」的工具。现有的：${ids.join("、") || "（一个都没有）"}`;
      return { action: { tool: "bind_database", args, ok: false, summary: msg, error: msg }, content: msg };
    }

    /*
     * 内置工具不能这么改 —— 这不是"不建议"，是**改了也没用**：
     * Rust 侧启动时会按 manifest.version 把安装包里的新版覆盖到用户数据区
     * （见 src-tauri/src/lib.rs 的 sync_builtin_tools）。用户（或助手）
     * 手工改的 schema 会在下次升级时**静默消失**，而那时数据表已经建了一半。
     *
     * 所以直接拒绝，并给出正确的做法：复制成一个新 id 的自有工具。
     */
    if (tool.source === "bundled") {
      const msg =
        `「${tool.name}」是内置工具，不能改它的 manifest —— 升级时会被安装包里的版本覆盖，` +
        `你绑的表会静默消失。正确做法是用 install_tool 以一个新的 id 复制一份出来再改。`;
      return { action: { tool: "bind_database", args, ok: false, summary: msg, error: msg }, content: msg };
    }

    const schemaRaw = args.schema;
    const schema = validateToolSchema(toolId, schemaRaw);
    if (!schema) {
      throw new Error(
        "schema 没通过校验（规则：表名/列名只能用小写字母数字下划线、首字母必须是字母；" +
          "每张表恰好一个 pk:true 的列；类型只有 text/integer/real；" +
          "indexes 的列必须是本表声明过的列）。请 read_skill 取 data-binding 的全文改好再来。",
      );
    }

    // 磁盘上的那份才是要改的：注册表里的可能是扫描时的快照
    const before = await readInstalledManifest(toolId);
    if (!before) {
      const msg = `工具目录里读不到「${toolId}」的 manifest.json（它可能被手工删过），改不了。`;
      return { action: { tool: "bind_database", args, ok: false, summary: msg, error: msg }, content: msg };
    }

    const next = await writeToolSchema(toolId, schema);
    await ctx.host.reloadTools();

    const tables = schema.tables.map((t) => ({
      bare: t.name,
      full: toolTable(toolId, t.name),
      columns: t.columns.map((c) => `${c.name}:${c.type}${c.pk ? "(主键)" : ""}`),
    }));
    const had = !!before.schema;
    const reason = str(args, "reason");

    return {
      action: {
        tool: "bind_database",
        args,
        ok: true,
        summary: `已给「${tool.name}」绑定 ${tables.length} 张表`,
        detail: [
          reason ? `原因：${reason}` : "",
          `dbVersion：${before.dbVersion} → ${next.dbVersion}`,
          ...tables.map((t) => `· ${t.full}（${t.columns.join(", ")}）`),
          had
            ? "⚠️ 这个工具原来就有表。改结构**不会**自动给已存在的表加列 —— 要让新结构生效，" +
              "需要在「设置 → 数据库」里清理这个工具的命名空间（会丢数据），打开工具后表会按新声明重建。"
            : "打开这个工具时，宿主会按新声明把表建好，然后它的 row.* 就能用了。",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      content: [
        `已把 schema 写进 tools/${toolId}/manifest.json（dbVersion ${before.dbVersion} → ${next.dbVersion}）。`,
        `表：${tables.map((t) => `${t.full}(${t.columns.join(", ")})`).join("；")}`,
        had
          ? "注意：原来已有表，新加的列不会自动生效 —— 要告诉用户可以去「设置 → 数据库」清理该工具的数据让表重建（会丢数据），或者手工确认。"
          : "这些表会在该工具第一次被打开时建好，之后它的 row.* 就能用了。",
      ].join("\n"),
    };
  },

  /* ------------------------------- 日程 ------------------------------- */

  async list_lists() {
    const [lists, counts] = await Promise.all([repo.fetchLists(), repo.fetchCounts()]);
    const rows = lists.map((l) => ({
      name: l.name,
      id: l.id,
      open: counts.byList[l.id] ?? 0,
    }));
    return {
      action: {
        tool: "list_lists",
        args: {},
        ok: true,
        summary: `有 ${rows.length} 个清单`,
        detail: rows.map((r) => `${r.name} · 未完成 ${r.open} 条`).join("\n"),
      },
      content: JSON.stringify({ lists: rows }, null, 1),
    };
  },

  async list_schedules(args) {
    const range = str(args, "range") || "today";
    if (!["today", "week", "overdue", "all"].includes(range)) {
      throw new Error(`range 只能是 today / week / overdue / all，收到的是「${range}」`);
    }
    const rawLimit = args.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
        : 30;

    const [tasks, lists, steps, counts] = await Promise.all([
      repo.fetchTasks({ view: "all", includeDone: false }),
      repo.fetchLists(),
      repo.fetchAllSteps(),
      repo.fetchCounts(),
    ]);
    const listName = new Map(lists.map((l) => [l.id, l.name]));
    const today = repo.today();
    const weekEnd = repo.addDays(today, 7);

    const picked = tasks
      .filter((t) => {
        if (range === "all") return true;
        const due = t.dueDate ?? "";
        if (range === "today") return due === today || t.myDay || t.repeat === "daily";
        if (range === "overdue") return !!due && due < today;
        return !!due && due >= today && due <= weekEnd;
      })
      // 有日期的排前面、日期早的排前面；没日期的排在后面
      .sort((a, b) => (a.dueDate ?? "9999") .localeCompare(b.dueDate ?? "9999"))
      .slice(0, limit);

    const rows = picked.map((t) => ({
      id: t.id,
      title: t.title,
      list: listName.get(t.listId) ?? "",
      due_date: t.dueDate,
      remind_at: t.remindAt,
      important: t.important,
      my_day: t.myDay,
      repeat: t.repeat,
      // ⚠️ 子任务的 id 必须带上：update_steps 靠它定位到具体某一条，
      // 而这个 id 是 uuid —— 用户看不见、模型也猜不出来。
      steps: (steps[t.id] ?? []).map((s) => ({
        id: s.id,
        title: s.title,
        done: s.done,
        due_at: s.dueAt,
      })),
    }));

    return {
      action: {
        tool: "list_schedules",
        args,
        ok: true,
        summary:
          range === "today"
            ? `今天有 ${rows.length} 条（含我的一天与每日任务）`
            : `取到 ${rows.length} 条（${range}）`,
        detail: rows
          .map(
            (r) =>
              `· ${r.title}${r.due_date ? ` — ${r.due_date}` : ""}` +
              `${r.remind_at ? ` 提醒 ${r.remind_at}` : ""}${r.list ? `（${r.list}）` : ""}`,
          )
          .join("\n") || "（没有）",
      },
      content: JSON.stringify(
        {
          today,
          total_open: counts.all,
          range,
          items: rows,
          timezone_note: "due_date 是本地日期；remind_at 是时刻（存的是 UTC ISO，展示时按本地时间换算）",
        },
        null,
        1,
      ),
    };
  },

  async create_schedules(args, ctx) {
    // "单条也收"的宽容写法见 toItems 的说明
    const items = toItems(args.items, "items");

    const lists = await repo.fetchLists();
    const byName = new Map(lists.map((l) => [l.name.trim().toLowerCase(), l]));

    const created: Array<{ id: string; title: string; list: string; due: string; remind: string }> = [];
    const madeLists: string[] = [];

    for (const item of items) {
      const title = str(item, "title", true);
      const listName = str(item, "list");

      // 清单：按名字找；没给就用第一个；一个清单都没有就建一个
      let list = listName ? byName.get(listName.toLowerCase()) : undefined;
      if (!list && !listName) list = lists[0];
      if (!list) {
        const name = listName || "个人";
        list = await repo.createList(name);
        lists.push(list);
        byName.set(list.name.trim().toLowerCase(), list);
        madeLists.push(list.name);
      }

      const dueDate = checkDate(str(item, "due_date"), "due_date") || null;

      // 时刻：due_time 是"那天的几点"，remind_at 是完整时刻。两者都给时以 remind_at 为准
      const dueTime = str(item, "due_time");
      let remindAt = checkTime(str(item, "remind_at"), "remind_at") || null;
      if (!remindAt && dueTime) {
        if (!HM_RE.test(dueTime)) {
          throw new Error(`due_time 要用 HH:mm（如 15:00），收到的是「${dueTime}」`);
        }
        if (!dueDate) throw new Error(`给了 due_time 就必须同时给 due_date（「${title}」少了日期）`);
        const hhmm = dueTime.length === 4 ? `0${dueTime}` : dueTime;
        remindAt = localInputToIso(`${dueDate}T${hhmm}`);
      }

      const task = await repo.createTask({
        listId: list.id,
        title,
        note: str(item, "note") || undefined,
        important: bool(item, "important"),
        myDay: bool(item, "my_day"),
        dueDate,
        repeat: item.repeat === "daily" ? "daily" : "none",
      });

      // createTask 不接受提醒时刻（它在界面上是后补的一步），这里补一次
      if (remindAt) await repo.updateTask(task.id, { remindAt });

      // 子任务
      const rawSteps = item.steps;
      const steps = Array.isArray(rawSteps) ? (rawSteps as Array<Record<string, unknown>>) : [];
      for (const s of steps) {
        const st = await repo.createStep(task.id, str(s, "title", true));
        const dueAt = checkTime(str(s, "due_at"), "due_at");
        if (dueAt) await repo.updateStep(st.id, { dueAt });
      }

      created.push({
        id: task.id,
        title,
        list: list.name,
        due: dueDate ?? "",
        remind: remindAt ?? "",
      });
    }

    await ctx.host.refresh();

    return {
      action: {
        tool: "create_schedules",
        args,
        ok: true,
        summary: `已建 ${created.length} 条日程${madeLists.length ? `，并新建清单「${madeLists.join("、")}」` : ""}`,
        detail: created
          .map(
            (c) =>
              `· ${c.title}${c.due ? ` — ${c.due}` : "（没定日期）"}` +
              `${c.remind ? ` 提醒 ${c.remind}` : ""}（${c.list}）`,
          )
          .join("\n"),
      },
      content: [
        `已建 ${created.length} 条待办${madeLists.length ? `，并新建了清单：${madeLists.join("、")}` : ""}。`,
        JSON.stringify({ created }, null, 1),
        "提醒是应用内的：到点后打开工作台会弹提醒卡片（桌面版可选系统通知）。",
      ].join("\n"),
    };
  },

  /* ----------------------------- 改 / 删 ----------------------------- */

  async update_schedules(args, ctx) {
    const items = toItems(args.items, "items");
    const lists = await repo.fetchLists();
    const byName = new Map(lists.map((l) => [l.name.trim().toLowerCase(), l]));
    const madeLists: string[] = [];
    const results: Array<{ id: string; title: string; fields: string[] }> = [];

    for (const item of items) {
      const id = str(item, "id", true);
      const before = await repo.fetchTaskById(id);
      if (!before) {
        // 猜 id 是模型最容易犯的错，所以这句要说清"怎么重新拿到"
        throw new Error(
          `找不到 id 为「${id}」的待办（它可能已经被删了）。` +
            `请先 list_schedules 重新取一次 id，不要凭记忆写。`,
        );
      }

      const patch: Partial<Task> = {};
      const fields: string[] = [];

      if (has(item, "title")) {
        const title = str(item, "title");
        // 没有标题的待办在列表里就是一行空白 —— 这不是"清空"，是坏数据
        if (!title) throw new Error(`「${before.title}」的新标题是空的。待办必须有标题。`);
        patch.title = title;
        fields.push(`标题 → ${title}`);
      }
      if (has(item, "note")) {
        patch.note = str(item, "note"); // 备注允许清成空串
        fields.push(patch.note ? "改了备注" : "清掉备注");
      }

      if (has(item, "list")) {
        const name = str(item, "list");
        if (!name) throw new Error(`「${before.title}」要改到哪个清单？list 给的是空串。`);
        let list = byName.get(name.toLowerCase());
        if (!list) {
          list = await repo.createList(name);
          lists.push(list);
          byName.set(list.name.trim().toLowerCase(), list);
          madeLists.push(list.name);
        }
        patch.listId = list.id;
        fields.push(`清单 → ${list.name}`);
      }

      if (has(item, "due_date")) {
        const due = checkDate(str(item, "due_date"), "due_date");
        patch.dueDate = due || null; // 空串 = 去掉日期
        fields.push(due ? `日期 → ${due}` : "去掉日期");
      }

      if (has(item, "remind_at")) {
        const remind = checkTime(str(item, "remind_at"), "remind_at");
        patch.remindAt = remind || null;
        fields.push(remind ? "改了提醒" : "去掉提醒");
      }

      if (has(item, "due_time")) {
        const dueTime = str(item, "due_time");
        if (!dueTime) {
          // due_time 本来就是"那天的几点"，空串按"去掉提醒"理解
          patch.remindAt = null;
          fields.push("去掉提醒");
        } else {
          if (!HM_RE.test(dueTime)) {
            throw new Error(`due_time 要用 HH:mm（如 15:00），收到的是「${dueTime}」`);
          }
          // 日期以这次给的为准，这次没给就沿用原来那个 ——
          // "把那个会改到三点"是很常见的说法，不该逼模型先念一遍日期
          const day = patch.dueDate ?? before.dueDate;
          if (!day) {
            throw new Error(`「${before.title}」还没有日期，只给 due_time 定不了提醒 —— 请同时给 due_date。`);
          }
          const hhmm = dueTime.length === 4 ? `0${dueTime}` : dueTime;
          patch.remindAt = localInputToIso(`${day}T${hhmm}`);
          fields.push(`提醒 → ${day} ${hhmm}`);
        }
      }

      if (has(item, "important")) {
        patch.important = bool(item, "important");
        fields.push(patch.important ? "标记重要" : "取消重要");
      }
      if (has(item, "my_day")) {
        patch.myDay = bool(item, "my_day");
        fields.push(patch.myDay ? "加入我的一天" : "移出我的一天");
      }
      if (has(item, "repeat")) {
        const r = item.repeat === "daily" ? "daily" : "none";
        patch.repeat = r;
        // 从"每天"改回"不重复"时清掉完成日期，否则这行会带个没人用的残留值
        if (r === "none") patch.repeatDoneOn = null;
        fields.push(r === "daily" ? "改成每天" : "去掉重复");
      }
      if (has(item, "done")) {
        const done = bool(item, "done");
        patch.done = done;
        // 每日任务勾上只代表"今天做完了"，记日期（与 store.toggleDone 同一条规则）
        const repeat = patch.repeat ?? before.repeat;
        if (repeat === "daily") patch.repeatDoneOn = done ? repo.today() : null;
        fields.push(done ? "已完成" : "取消完成");
      }

      if (!fields.length) {
        throw new Error(
          `「${before.title}」这条一个要改的字段都没给。至少给一个（title / due_date / done / …）。`,
        );
      }

      await repo.updateTask(id, patch);
      results.push({ id, title: patch.title ?? before.title, fields });
    }

    await ctx.host.refresh();

    return {
      action: {
        tool: "update_schedules",
        args,
        ok: true,
        summary: `已改 ${results.length} 条${madeLists.length ? `，并新建清单「${madeLists.join("、")}」` : ""}`,
        detail: results.map((r) => `· ${r.title}：${r.fields.join("、")}`).join("\n"),
      },
      content: [
        `已改动 ${results.length} 条待办${madeLists.length ? `，并新建了清单：${madeLists.join("、")}` : ""}。`,
        JSON.stringify({ updated: results }, null, 1),
      ].join("\n"),
    };
  },

  async delete_schedules(args, ctx) {
    const ids = idList(args.ids);
    if (!ids.length) throw new Error("ids 是空的，没有要删的待办。");

    const gone: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const t = await repo.fetchTaskById(id);
      if (!t) {
        missing.push(id);
        continue;
      }
      // 任务软删、子任务与关联硬删（见 repo.deleteTask 的说明）
      await repo.deleteTask(id);
      gone.push(t.title);
    }

    if (!gone.length) {
      throw new Error(`这些 id 一个都没找到：${missing.join("、")}。请用 list_schedules 重新取一次 id。`);
    }
    await ctx.host.refresh();

    return {
      action: {
        tool: "delete_schedules",
        args,
        ok: true,
        summary: `已删 ${gone.length} 条${missing.length ? `（另有 ${missing.length} 个 id 没找到）` : ""}`,
        detail: [
          ...gone.map((t) => `· ${t}`),
          missing.length ? `没找到、因此没动它们：${missing.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      content: [
        `已删除 ${gone.length} 条待办（连同子任务）：${gone.join("、")}。`,
        missing.length ? `这些 id 没找到，没有动它们：${missing.join("、")}` : "",
        "界面上没有撤销入口，所以删掉就是真的没了。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },

  async update_steps(args, ctx) {
    const items = toItems(args.items, "items");

    // 一次把子任务全读进来建索引：逐条查库的话，改 10 步就是 10 次查询
    const all = await repo.fetchAllSteps();
    const byId = new Map<string, { id: string; taskId: string; title: string }>();
    for (const list of Object.values(all)) {
      for (const s of list) byId.set(s.id, s);
    }

    const lines: string[] = [];
    const failed: string[] = [];

    for (const item of items) {
      const op = str(item, "op", true);

      if (op === "add") {
        const taskId = str(item, "task_id", true);
        const task = await repo.fetchTaskById(taskId);
        if (!task) {
          failed.push(`加子任务失败：找不到待办「${taskId}」`);
          continue;
        }
        const title = str(item, "title", true);
        const step = await repo.createStep(taskId, title);
        const rawDue = str(item, "due_at");
        const dueAt = rawDue ? checkTime(rawDue, "due_at") : "";
        if (dueAt) await repo.updateStep(step.id, { dueAt });
        lines.push(`给「${task.title}」加了一步：${title}${rawDue ? `（${rawDue}）` : ""}`);
        continue;
      }

      const stepId = str(item, "step_id", true);
      const step = byId.get(stepId);
      if (!step) {
        failed.push(`${op} 失败：找不到子任务「${stepId}」（请先用 list_schedules 取到带 id 的子任务列表）`);
        continue;
      }

      if (op === "delete") {
        await repo.deleteStep(stepId);
        lines.push(`删掉子任务：${step.title}`);
        continue;
      }

      if (op === "done") {
        const v = bool(item, "done");
        await repo.updateStep(stepId, { done: v });
        lines.push(`子任务「${step.title}」${v ? "已勾上" : "取消勾选"}`);
        continue;
      }

      if (op === "update") {
        const patch: Partial<{ title: string; dueAt: string | null; done: boolean }> = {};
        const marks: string[] = [];
        if (has(item, "title")) {
          const t = str(item, "title");
          if (!t) throw new Error("子任务的新标题是空的。");
          patch.title = t;
          marks.push("标题");
        }
        if (has(item, "due_at")) {
          const raw = str(item, "due_at");
          patch.dueAt = raw ? checkTime(raw, "due_at") : null;
          marks.push(raw ? `时刻 → ${raw}` : "去掉时刻");
        }
        if (has(item, "done")) {
          patch.done = bool(item, "done");
          marks.push(patch.done ? "已完成" : "取消完成");
        }
        if (!marks.length) {
          failed.push(`改「${step.title}」失败：没给要改的字段`);
          continue;
        }
        await repo.updateStep(stepId, patch);
        lines.push(`改子任务「${step.title}」：${marks.join("、")}`);
        continue;
      }

      failed.push(`不认识的 op「${op}」`);
    }

    if (!lines.length) throw new Error(`一条都没改成：${failed.join("；")}`);
    await ctx.host.refresh();

    return {
      action: {
        tool: "update_steps",
        args,
        ok: true,
        summary: `已改 ${lines.length} 项子任务${failed.length ? `，${failed.length} 项没成` : ""}`,
        detail: [...lines.map((l) => `· ${l}`), ...failed.map((f) => `✗ ${f}`)].join("\n"),
      },
      content: [
        `子任务改动：${lines.join("；")}。`,
        failed.length ? `这些没成：${failed.join("；")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};

/* ------------------------------------------------------------------ */
/* 强制确认                                                            */
/* ------------------------------------------------------------------ */

/**
 * "这次调用要不要用户先点一下头"。
 *
 * ------------------------------------------------------------------
 * 为什么确认门在**宿主**这一侧，而不是靠提示词叮嘱模型
 * ------------------------------------------------------------------
 * 提示词能提高"它记得先问"的概率，但那是**概率**。而删除是不可逆的 ——
 * 用户要的是"不管模型怎么想，删我的东西之前我都得点一下"。
 * 所以这里是一道硬门：模型直接调 delete_schedules 也会被 runtime 拦住
 * （见 runtime.execute 的调用点），它想绕也绕不过去。
 *
 * ------------------------------------------------------------------
 * 为什么它要做成 async 并看得见库
 * ------------------------------------------------------------------
 * 确认卡上必须写清"要删的是哪几条"。只写"要删掉 3 条吗"等于让用户盲签 ——
 * 而那个 id 是 uuid，他自己也没法核对。所以这里查一次库把标题带出来。
 *
 * 返回 null 表示可以直接做。**注意**：这里只负责"问什么"，
 * "问完之后要不要记住这次许可"由 runtime 管（它才知道这一轮的边界）。
 */
export interface ConfirmRequest {
  question: string;
  detail: string;
  /** 用户点头后，本轮里这些动作不再重复问 */
  affects: string[];
  danger: boolean;
}

/**
 * 一次改几条以上算"批量"。
 *
 * 3 条以内用户心里有数（"就这三件事"），4 条以上他就只能靠信任了 ——
 * 而信任这种东西，在改完之后发现不对时是最先碎的。
 */
const BATCH_CONFIRM_AT = 4;

export async function describeConfirm(
  name: string,
  args: Record<string, unknown>,
): Promise<ConfirmRequest | null> {
  /*
   * 卸载工具。
   *
   * 目录一删，用户自己改过的那份源码也一起没了 —— 所以必须问。
   * 卡上**写出工具名**（不是 id）：id 是英文的短串，看不出是哪个工具，
   * 而"同意卸掉 pomodoro"和"同意卸掉一个叫 pomodoro 的东西"是两回事。
   */
  if (name === "uninstall_tool") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return null;
    const t = listTools().find((x) => x.id === id);
    const label = t ? `「${t.name}」` : `「${id}」`;
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    return {
      question: `要卸掉工具 ${label} 吗？`,
      detail: [
        t ? "" : `（没找到 id 为 ${id} 的工具 —— 它可能是已经卸过了）`,
        "卸载会删掉这个工具的目录，你自己改过的源码也一起没了。",
        "它存的数据会留着，重新装回来还能接着用。",
        "只是想更新它就别卸 —— install_tool 带 overwrite 是原地的。",
        reason ? `助手说明的原因：${reason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      affects: ["uninstall_tool"],
      danger: true,
    };
  }

  /*
   * 删工作区里的文件。
   *
   * 与 delete_schedules 同源的理由：文件不在回收站里，删了就是没了，
   * 而助手"整理一下"的手感很容易滑到删掉用户还没看的稿子。
   * 卡上要写出**文件名**（不是"一个文件"）—— 让用户盲签一个名字
   * 是最容易出事的一类确认。
   */
  if (name === "delete_file") {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) return null;
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    return {
      question: `要删掉工作区里的「${path}」吗？`,
      detail: ["删了就找不回来了（工作区没有回收站）。", reason ? `助手说明的原因：${reason}` : ""]
        .filter(Boolean)
        .join("\n"),
      affects: ["delete_file"],
      danger: true,
    };
  }

  if (name === "delete_schedules") {
    const ids = idList(args.ids);
    // 空 ids 会在执行时报错，不必先弹一张确认卡
    if (!ids.length) return null;
    const titles: string[] = [];
    for (const id of ids.slice(0, 10)) {
      const t = await repo.fetchTaskById(id);
      if (t) titles.push(t.title);
    }
    const reason = str(args, "reason");
    return {
      question: `要删掉这 ${ids.length} 条待办吗？`,
      detail: [
        titles.length
          ? titles.map((t) => `· ${t}`).join("\n") + (ids.length > titles.length ? `\n· …共 ${ids.length} 条` : "")
          : ids.map((i) => `· ${i}`).join("\n"),
        "",
        "删了连同子任务一起消失，工作台里没有撤销入口。",
        reason ? `助手说明的原因：${reason}` : "",
      ]
        .filter((x) => x !== null)
        .join("\n")
        .trim(),
      affects: ["delete_schedules"],
      danger: true,
    };
  }

  /*
   * 子任务：删一定要问。
   *
   * 注意这里**不能**写成「没有删除项就 return null」—— 那会把下面的
   * 批量检查一起短路掉（一次改 8 条子任务、一条都不删，同样值得问一次）。
   * 所以只在真的有删除项时才返回，否则落到后面的批量门。
   */
  if (name === "update_steps") {
    const items = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
    const dels = items.filter((i) => i && typeof i === "object" && i.op === "delete");
    if (dels.length) {
      const all = await repo.fetchAllSteps();
      const byId = new Map<string, string>();
      for (const list of Object.values(all)) for (const s of list) byId.set(s.id, s.title);

      const names = dels.map((d) => {
        const id = typeof d.step_id === "string" ? d.step_id.trim() : "";
        return byId.get(id) ?? id ?? "(未知子任务)";
      });
      return {
        question: `要删掉这 ${dels.length} 个子任务吗？`,
        detail: [names.map((n) => `· ${n}`).join("\n"), "", "删掉就没了，工作台里没有撤销入口。"].join("\n"),
        affects: ["update_steps"],
        danger: true,
      };
    }
  }

  /*
   * 批量改动：一次动 4 条以上就要先问。
   *
   * 为什么是"改"也要问：改一条改错了，用户一眼就能看出来并改回去；
   * 一次改 12 条，改错了他要**一条条找回来** —— 那些改动分散在不同清单、
   * 不同日期里，事后根本拼不回原样。所以"批量"这个词本身就是风险信号，
   * 跟"删除"一样值得拦一下。
   *
   * 阈值取 4 而不是 10：3 条以内用户心里有数（"就这三件事"），
   * 4 条以上他就只能靠信任了。而确认一次的成本很低。
   */
  if (name === "update_schedules" || name === "update_steps") {
    const items = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
    if (items.length < BATCH_CONFIRM_AT) return null;

    // 子任务索引只建一次 —— 放在循环里的话，改 10 条就是 10 次全表读取
    const stepTitles = new Map<string, string>();
    const parts: string[] = [];
    for (const it of items.slice(0, 10)) {
      if (!it || typeof it !== "object") continue;
      const id = typeof it.id === "string" ? it.id.trim() : "";
      const stepId = typeof it.step_id === "string" ? it.step_id.trim() : "";
      if (id) {
        const t = await repo.fetchTaskById(id);
        parts.push(`· ${t ? t.title : id}`);
      } else if (stepId) {
        if (!stepTitles.size) {
          for (const list of Object.values(await repo.fetchAllSteps())) {
            for (const s of list) stepTitles.set(s.id, s.title);
          }
        }
        parts.push(`· 子任务：${stepTitles.get(stepId) ?? stepId}`);
      }
    }

    return {
      question: `要一次改这 ${items.length} 条吗？`,
      detail: [
        parts.join("\n") + (items.length > parts.length ? `\n· …共 ${items.length} 条` : ""),
        "",
        "一次改这么多，改错了得一条条找回来（工作台里没有撤销入口）。",
      ].join("\n"),
      affects: [name],
      danger: true,
    };
  }

  if (name === "install_tool") {
    const ow = args.overwrite === true || args.overwrite === "true" || args.overwrite === 1;
    if (!ow) return null;
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const existing = id ? listTools().find((t) => t.id === id) : undefined;
    // 没有同名工具时，"覆盖"不成立（等于新装），不必打扰
    if (!existing) return null;
    return {
      question: `要用新的覆盖工具「${existing.name}」吗？`,
      detail: [
        `现在装着的是 ${existing.name} v${existing.version}（${existing.source === "bundled" ? "内置" : "自己导入"}）。`,
        "覆盖会把它整份换掉 —— 如果你手工改过那个工具，那些改动会一起消失。",
      ].join("\n"),
      affects: ["install_tool"],
      danger: true,
    };
  }

  return null;
}

/** 当前被停用的工具 id */
async function disabledSet(): Promise<Set<string>> {
  const settings = await repo.getAllSettings();
  return parseDisabledTools(settings[SETTINGS.toolsDisabled]);
}

/** 动作的中文名（动作卡标题用）。动作表里查不到就给原名 */
export function actionLabel(name: string): string {
  return AGENT_TOOLS.find((t) => t.name === name)?.label ?? name;
}
