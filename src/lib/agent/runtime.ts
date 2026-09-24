/**
 * 助手的运行时：把"一句话"变成"一串动作 + 一段答复"。
 *
 * ------------------------------------------------------------------
 * 为什么状态放在模块里，而不是 React 组件里
 * ------------------------------------------------------------------
 * 一轮对话可能持续十几秒（模型思考 → 写 30 KB 的 HTML → 装工具 → 再说话）。
 * 如果状态挂在组件上，用户在等待时切到「我的一天」看一眼，组件卸载，
 * 这一轮就断了 —— 而那时工具可能**已经写进磁盘**了：状态没了、动作卡没了，
 * 用户回来只看到一句"有什么可以帮你"，完全不知道刚才发生了什么。
 *
 * 所以状态是模块级的（一个极简的订阅式 store），组件只是它的一个视图。
 * 这也是这个应用里工具区那套「保持状态」的同一条思路：**别让界面切换
 * 打断正在进行的工作**。
 *
 * ------------------------------------------------------------------
 * 一轮对话的结构
 * ------------------------------------------------------------------
 *   用户说话
 *     → 模型（可能要求执行若干动作）
 *     → 宿主执行、把结果**原样回灌**给模型
 *     → 模型看到结果，再决定是继续动手还是给出答复
 *     → 最多 6 步，然后强制收尾
 *
 * 回灌是关键：没有它，模型只能"猜"自己刚做的事成了没有。有了它，
 * 它能在工具装失败时自己改一版 —— 这才是"能干活"和"看起来能干活"的区别。
 *
 * 6 步的上限是防死循环：模型偶尔会陷入"再确认一次"的循环
 * （尤其被权限挡住而它没读懂错误时）。上限到了就如实告诉用户，
 * 而不是继续烧 token。
 */

import * as repo from "../repo";
import { listTools } from "../tools";
import { parseDisabledTools, readAgentConfig, parseAgentPermissions, withDefaults, SETTINGS } from "../settings";
import { isTauri } from "../db";
import { runAction, describeConfirm, type AgentHost, type Outcome } from "./actions";
import { chat, isAbortError, type WireMessage } from "./client";
import {
  actionsFromToolCalls,
  actionProtocolBlock,
  extractActions,
  isAskTool,
  toolCallsForEcho,
  toolsForModel,
  toolSpec,
  withHtmlFallback,
} from "./protocol";
import { skillPromptBlock } from "./skills";
import { agentConfigProblems, agentProvider } from "./providers";
import type {
  AgentAction,
  AgentAsk,
  AgentAskOption,
  AgentChatSummary,
  AgentMessage,
  AgentState,
} from "./types";

/** 一轮里最多执行多少步（模型回合数），见文件头 */
const MAX_STEPS = 6;

/** 带进上下文的历史条数。够用且不会让请求体越来越大 */
const HISTORY_LIMIT = 40;

/**
 * 参数是"修好之后"才解析出来时，附在动作结果前面的一句提醒。
 *
 * 为什么要提醒：模型**看不到自己发出的那个字符串**，它以为自己给的是合法
 * JSON。不告诉它，它每次都会用同一种坏写法（现实里就是每次都少转义换行）。
 */
const REPAIRED_NOTE =
  "（提醒：你这次给的参数不是合法 JSON，宿主已自动修复并按修复结果执行。下次请把大段内容放进独立的代码块，不要塞进参数里。）";

/* ------------------------------------------------------------------ */
/* 极简订阅式状态                                                       */
/* ------------------------------------------------------------------ */

let state: AgentState = {
  messages: [],
  chats: [],
  currentChatId: "",
  busy: false,
  streaming: "",
  phase: "",
  ask: null,
  error: "",
  loaded: false,
};

const listeners = new Set<() => void>();

/** 换掉引用再通知 —— useSyncExternalStore 靠引用变化判断要不要重渲染 */
function emit(patch: Partial<AgentState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): AgentState {
  return state;
}

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

/**
 * 消息序号。
 *
 * 用 `max(现在, 上一条+1)` 而不是纯 Date.now()：同一毫秒内连写两条
 * （助手消息 + 紧随其后的动作结果）在真机上是会发生的，纯时间戳会让
 * 顺序变成随机的 —— 而对话记录顺序错了，读起来就是前言不搭后语。
 *
 * ⚠️ 这个计数器是**跨会话**单调的（初值取整张表的最大 seq）。切到很久
 * 以前那段对话时，如果只按当前消息取 max，下一条新消息的 seq 会插到
 * 老消息中间去（见 repo.maxAgentSeq）。
 */
let seqCounter = 0;
function nextSeq(): number {
  seqCounter = Math.max(Date.now(), seqCounter + 1);
  return seqCounter;
}

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 自动标题的长度上限。够在历史列表那一行里认出是哪一段，又不至于折行 */
const AUTO_TITLE_MAX = 18;

/** 历史列表的顺序：最近动过的在最前（与 repo.fetchAgentChats 的 ORDER BY 同源） */
function sortChats(chats: AgentChatSummary[]): AgentChatSummary[] {
  return [...chats].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
}

async function push(msg: Omit<AgentMessage, "seq" | "createdAt">): Promise<AgentMessage> {
  const full: AgentMessage = { ...msg, seq: nextSeq(), createdAt: new Date().toISOString() };
  // 先落库再进内存：反过来的话，进程在写库前被打断，界面上的记录就成了幻觉
  await repo.appendAgentMessage({ ...full, chatId: state.currentChatId });
  // 这一段有动静了：顶到历史列表最前，并**就地**更新它的条数与摘要。
  // 就地更新而不是重读一遍库（一次两查），是为了让"刚发完"和"刷新之后"
  // 显示的文字完全一致 —— 所以摘要走 repo 导出的同一个 chatPreview。
  const chats = state.chats.map((c) =>
    c.id === state.currentChatId
      ? {
          ...c,
          updatedAt: full.createdAt,
          messageCount: c.messageCount + 1,
          preview: repo.chatPreview(full.role, full.content),
        }
      : c,
  );
  await repo.touchAgentChat(state.currentChatId, full.createdAt);
  emit({ messages: [...state.messages, full], chats: sortChats(chats) });
  return full;
}

/** 新建一段对话。库里写完才返回 —— 顺序反了的话，它可能是一个不存在的会话 */
async function createChat(title = ""): Promise<AgentChatSummary> {
  const now = new Date().toISOString();
  const chat = { id: uid(), title, createdAt: now, updatedAt: now };
  await repo.createAgentChat(chat);
  return { ...chat, messageCount: 0, preview: "" };
}

/**
 * 正在进行的载入。
 *
 * 为什么必须有它：ensureLoaded 会被**并发**调用 —— React 严格模式下同一个
 * effect 会跑两次（见 main.tsx 的 StrictMode），以后多一个入口也是一样。
 * 而"库里一段对话都没有就先建一段"这句话在并发下会各建一段，
 * 结果是用户的历史列表里凭空多出几个一模一样的空对话（2026-09-23 实测：
 * 库里 3 段，界面上只显示 2 段 —— 那段多出来的连显示的机会都没有）。
 *
 * 修法是复用同一趟载入：第一个调用发起，其余的都等它。
 */
let loading: Promise<void> | null = null;

export async function ensureLoaded(): Promise<void> {
  if (state.loaded) return;
  if (loading) return loading;
  loading = (async () => {
    let chats = await repo.fetchAgentChats();
    if (!chats.length) {
      // 全新库（或刚被清空）：先给一段空的。
      // 少了这一步，用户打开助手看到的是"一段对话都没有"，还得先点一次
      // 「新对话」才能说第一句话 —— 那是完全多余的一步。
      chats = [await createChat()];
    }
    const settings = await repo.getAllSettings();
    const want = settings[SETTINGS.agentCurrentChat] ?? "";
    // 上次那段可能已经被删了，那就退到最近动过的那段
    const current = chats.find((c) => c.id === want) ?? chats[0];
    const rows = await repo.fetchAgentMessages(current.id);
    seqCounter = Math.max(seqCounter, await repo.maxAgentSeq());
    emit({ chats, currentChatId: current.id, messages: rows, loaded: true });
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** 仅供测试与"重新读一遍库"用 */
export function __resetRuntime(): void {
  state = {
    messages: [],
    chats: [],
    currentChatId: "",
    busy: false,
    streaming: "",
    phase: "",
    ask: null,
    error: "",
    loaded: false,
  };
  seqCounter = 0;
  // 正在进行的那趟载入也要作废：不复位的话它会在重置之后把旧数据 emit 回来
  loading = null;
  // 挂起的问题同理：它正 await 着，置空之后那一轮会自然收尾（见 answerAsk 的说明）
  pending = null;
  for (const l of listeners) l();
}

/* ------------------------------------------------------------------ */
/* system prompt                                                       */
/* ------------------------------------------------------------------ */

export interface SystemContext {
  now: Date;
  permissions: { writeTools: boolean; schedules: boolean; database: boolean };
  tools: Array<{ id: string; name: string; hasSchema: boolean }>;
  lists: string[];
  desktop: boolean;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 当前本地时间的人话 + 机器可读两种写法都要给（模型算日期全靠它） */
function nowBlock(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const local = `${date}T${time}`;
  return [
    `当前本地时间：${date} ${time}（${WEEK[now.getDay()]}）`,
    `机器可读：\`${local}\`（这个串就是本地墙上时间，不是 UTC）`,
    `今天 = ${date}；昨天 = ${localInputToIsoShift(now, -1)}；明天 = ${localInputToIsoShift(now, 1)}`,
  ].join("\n");
}

function localInputToIsoShift(now: Date, days: number): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 组装 system prompt。
 *
 * 写成导出函数（而不是藏在 send 里）是为了能被测试直接断言 ——
 * "权限被关掉时这段会不会说不允许"是这一层最容易写错、
 * 也最要紧的一件事。
 */
export function buildSystemPrompt(c: SystemContext): string {
  const p = c.permissions;
  const allow: string[] = [];
  const deny: string[] = [];
  const row = (on: boolean, yes: string, no: string) => (on ? allow.push(yes) : deny.push(no));
  row(p.writeTools, "写工具：往工具目录里安装 / 更新单 HTML 工具", "写工具（用户关掉了，不要尝试，如实告诉他去设置里打开）");
  row(p.schedules, "建日程：往待办里写条目与子任务", "建日程（用户关掉了，不要尝试，如实告诉他去设置里打开）");
  row(p.database, "绑数据表：改写一个工具的 manifest 里的表声明", "绑数据表（用户关掉了，不要尝试，如实告诉他去设置里打开）");

  const toolList = c.tools.length
    ? c.tools.map((t) => `${t.id}（${t.name}${t.hasSchema ? "，有数据表" : ""}）`).join("、")
    : "（还没有装任何工具）";

  return [
    "# 你是谁",
    "",
    "你是「待办工作台」里内置的 AI 助手。这个工作台是一个只跑在用户本机上的",
    "Windows 桌面应用（Tauri + SQLite，数据不出本机）。你要做的事情有三类：",
    "",
    "1. **对话**：回答用户关于这个工作台、关于他手头事情的问题。说人话，别绕。",
    "2. **按标准写工具**：用户想要一个小工具（记账、算料、生成某类图…）时，",
    "   你按单 HTML 工具的标准把它**写出来并装进工作台**，它会出现在侧边栏里。",
    "3. **建日程**：把用户说的\"明天下午三点提醒我\"变成工作台里真的会提醒的待办；",
    "   需要几步才能做完的，拆成子任务。",
    "",
    "另外你还能给工具绑定数据表（让工具能存自己的记录）。",
    "",
    "# 现在的处境",
    "",
    nowBlock(c.now),
    `运行环境：${c.desktop ? "桌面版（能读写本机文件）" : "浏览器演示模式（**没有可写的文件系统**，装工具 / 改 manifest 都做不到，遇到这类请求要如实说明）"}`,
    `工作台里已有的工具：${toolList}`,
    `现在的清单：${c.lists.length ? c.lists.join("、") : "（还没有清单，建日程时会自动建一个）"}`,
    "",
    "## 你现在被允许做的事",
    "",
    ...(allow.length ? allow.map((a) => `- ✅ ${a}`) : ["- （没有：用户把三项权限都关掉了）"]),
    ...(deny.length ? deny.map((d) => `- ⛔ ${d}`) : []),
    "",
    "权限被关掉时**不要试图绕过去**，也不要说「已为你完成」：直接告诉用户是哪一项、",
    "去「设置 → AI 助手 → 权限」打开，然后请他再让你做一次。",
    "",
    "# 怎么做事",
    "",
    "- **先说清再动手，还是先动手**：用户的要求明确（\"做一个记录加班时长的工具\"）",
    "  就直接做；含糊或有多种做法（\"帮我管理一下客户\"）时先问一句最关键的问题，",
    "  不要凭空替他决定一堆细节。最多问一轮，别把对话变成问卷。",
    "- **一次只做被要求的事**。不要顺手改别的工具、不要顺手建别的任务。",
    "- **不许假装**。没执行成功就说没成功，并给出原因；不确定就说不确定。",
    "  用户看不到你的内部过程，他只能靠你说的话判断，所以这句话值千金。",
    "- **动作不要写给用户看**。执行动作时会有一个 JSON 代码块，那是给程序看的；",
    "  正文里只说人话：做了什么、结果如何、需要他确认什么。",
    "- 时间一律按**本地时间**算，写法见技能 schedule。",
    "- 回答用简体中文，简洁、具体。别用\"好的，我将为您…\"这种开场白堆字数。",
    "",
    "## 什么时候停下来问用户",
    "",
    "你有两个动作可以停下来问：`ask_user_choice`（他在几个做法里挑一个）和",
    "`confirm_action`（你要做一件不可逆或影响面大的事，先拿许可）。",
    "",
    "**该问的**：",
    "",
    "- 有几种合理做法、而选错要返工的时候（工具做成表格还是日历、清单要不要新建）。",
    "- 要删东西、要覆盖已有的东西、要一次性改一大批的时候 —— 用 confirm_action。",
    "- 用户的要求里有没说清的关键信息，而你猜错代价很大的时候。",
    "",
    "**不该问的**：",
    "",
    "- 他自己就能一眼看出来的事（\"要不要用红色？\"—— 做出来给他看，不满意再改）。",
    "- 你已经能合理决定的琐事（命名、排序、措辞）。问这些是在浪费他一轮等待。",
    "- 同一件事问第二次。**问过一次就按他的回答做**，他跳过了就自己定一个，",
    "  并在回复里说明你替他定了什么。",
    "",
    "删除与覆盖不需要你主动问 —— 宿主会在你动手之前自动拦一次。你直接调就行，",
    "用户点了确认你才会真的执行。**他被拦下之后不要换个写法重试**：那不是绕过，",
    "是让他连点取消。要改就按他说的改。",
    "",
    "# 这个工作台的结构（提到它们时不要说错）",
    "",
    "- **待办**：一件事，有到期日（哪一天）与提醒（几点），可拆子任务。",
    "- **流程任务**：带单号、沿自定义过程态往前走、每步可能有时效的单子。",
    "  它属于另一个领域，**你不能创建**它 —— 用户要建请用界面上的入口，并跟他说明。",
    "- **工具**：可插拔的单页应用，装在工具目录里，跑在 iframe 里，",
    "  只能通过 postMessage 向宿主请求数据（碰不到核心表）。",
    "- **图库**：所有图片/视频的共同落点。",
    "",
    skillPromptBlock(),
    "",
    actionProtocolBlock(),
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 停下来问用户                                                        */
/* ------------------------------------------------------------------ */

/**
 * 用户对一个挂起问题的回答。
 *
 * 「跳过」和「被中止」是两件不同的事，别混：跳过是**用户给的回答**
 * （"你看着办"），而 cancelled 是**这一轮被叫停了**（他点了停止、或者切了
 * 会话）—— 后者必须让整轮停下来，不能接着动手。
 */
export interface AskAnswer {
  /** 选项的 value；自由打字是 "__text__"；跳过是 "__skip__"；中止是 "__cancel__" */
  value: string;
  /** 用户看到的那个标签（落进动作卡） */
  label: string;
  /** 自由打字的原文（没有就是空串） */
  text: string;
  cancelled: boolean;
}

/** 正在等回答的那个问题。同一时刻只可能有一个 —— 一轮对话是串行的 */
let pending: { id: string; resolve: (a: AskAnswer) => void } | null = null;

/**
 * 确认卡的按钮。
 *
 * value 用 `yes` / `no` 而不是中文：模型要拿它做判断（"他到底同意了没有"），
 * 而中文标签是给人看的、将来会改（"确认"改成"就这么办"），
 * 让模型的判断挂在会漂的字上，迟早出问题。
 */
const CONFIRM_OPTIONS: AgentAskOption[] = [
  { value: "yes", label: "确认" },
  { value: "no", label: "取消" },
];

/**
 * 把问题摆到界面上，然后**在这里等**。
 *
 * 这是整个模块里唯一一处 await 真人。三件事必须做对：
 *
 *   1. **abort 要能立刻解开它。** 用户点了停止、或者切了会话（settle 会
 *      abort），这一轮就得走 —— 卡在这儿的话 busy 永远是 true、输入框
 *      永远禁用，用户除了重启应用没别的办法。
 *   2. **同一个问题不能被回答两次。** answerAsk 会先把 pending 摘下来再
 *      resolve，所以第二次点击只会得到"当前没有待回答的问题"。
 *   3. **答完要把状态清掉**，否则界面上的卡片会一直挂在那儿。
 */
async function askOnce(req: Omit<AgentAsk, "id">, signal: AbortSignal): Promise<AskAnswer> {
  if (signal.aborted) throw new DOMException("已停止", "AbortError");

  const id = uid();
  emit({ ask: { ...req, id }, phase: req.kind === "confirm" ? "等你点头…" : "等你的选择…" });

  let onAbort: (() => void) | null = null;
  const ans = await new Promise<AskAnswer>((resolve) => {
    pending = { id, resolve };
    onAbort = () => resolve({ value: "__cancel__", label: "（没有回答）", text: "", cancelled: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (onAbort) signal.removeEventListener("abort", onAbort);

  pending = null;
  emit({ ask: null });
  if (ans.cancelled) throw new DOMException("已停止", "AbortError");
  return ans;
}

/**
 * 界面调用它：用户点了一个选项 / 打了字。
 *
 * 返回 false 表示"当前没有待回答的问题"（连点了两下，或者问题已经被停止
 * 按钮解开了）—— 界面据此收卡片，而不是干等着。
 */
export function answerAsk(value: string, label: string, text = ""): boolean {
  if (!pending) return false;
  const { resolve } = pending;
  pending = null;
  resolve({ value, label, text, cancelled: false });
  return true;
}

/** 现在是不是卡在等用户（测试与界面用） */
export function hasPendingAsk(): boolean {
  return !!pending;
}

function argStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 选项：label 必须有，value 缺省就拿 label（模型经常只给 label） */
function readOptions(raw: unknown): AgentAskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentAskOption[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const label = argStr(o.label) || argStr(o.value);
    if (!label) continue;
    const value = argStr(o.value) || label;
    // 重复的 value 会让界面上的按钮撞在一起（选择器也靠它），直接跳过
    if (out.some((x) => x.value === value)) continue;
    out.push({ value, label, note: argStr(o.note) || undefined });
    // 六项以上就成了一面墙，用户反而挑不出来。多出来的自己忽略，不给模型报错
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 读 confirm_action 的 affects：只管**已知的、真会动手的**动作名。
 *
 * 模型可能写错名字，也可能把 ask 动作写进去（那没有意义）。这里静默过滤 ——
 * 为一个错名字让整次确认失败不值得，而过滤掉最坏的后果只是"多问一次"。
 */
function readAffects(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const n = v.trim();
    if (!n || out.includes(n)) continue;
    if (!toolSpec(n) || isAskTool(n)) continue;
    out.push(n);
  }
  return out;
}

/**
 * 执行 ask_user_choice / confirm_action。
 *
 * 它返回的不是"我做了件事"，而是"我问了、你答了"——动作卡上记的是**答案**，
 * 这样翻历史时能看到"当时它问过什么、用户选了什么"，而不是一片空白
 * （挂起状态本身不落库，见 AgentAsk 的说明）。
 */
async function runAskTool(
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  granted: Set<string>,
): Promise<{ action: AgentAction; content: string }> {
  if (name === "ask_user_choice") {
    const question = argStr(args.question) || "你想用哪一种？";
    const options = readOptions(args.options);
    if (!options.length) {
      const msg =
        "ask_user_choice 至少要给一个选项（options 是空的，或者每项都没有 label）。" +
        "没有选项就没法让用户点 —— 请补上 label 再调一次。";
      return { action: { tool: name, args, ok: false, summary: msg, error: msg }, content: msg };
    }
    const ans = await askOnce(
      {
        kind: "choice",
        source: "model",
        question,
        detail: argStr(args.detail),
        options,
        allowText: args.allow_text !== false,
        danger: false,
      },
      signal,
    );

    const picked = options.find((o) => o.value === ans.value);
    const skipped = ans.value === "__skip__";
    const summary = skipped
      ? "你没有回答（跳过），让它自己看着办"
      : picked
        ? `你选了「${picked.label}」`
        : `你回复了：${ans.text || ans.label}`;
    return {
      action: {
        tool: name,
        args,
        ok: !skipped,
        summary,
        detail: [question, options.map((o) => `· ${o.label}（${o.value}）`).join("\n")].join("\n\n"),
      },
      content: skipped
        ? "用户没有选（他跳过了这个问题，意思多半是\"你看着办\"）。" +
          "请按你认为最合理的方式继续，并在回复里说明你替他定了什么。**不要再问同一个问题。**"
        : picked
          ? `用户的选择：${picked.label}（value=${picked.value}）` +
            (ans.text ? `\n他补充说：${ans.text}` : "") +
            "\n请按这个继续，不要再问同一个问题。"
          : `用户没有点选项，而是自己说：「${ans.text}」。请按他这句继续。`,
    };
  }

  /* ---- confirm_action：模型主动来拿许可 ---- */
  const question = argStr(args.question) || "可以这么做吗？";
  const affects = readAffects(args.affects);
  // 默认按破坏性处理：忘了标 danger 的后果是"按钮不够醒目"，反过来的后果更糟
  const danger = args.danger !== false;

  const ans = await askOnce(
    {
      kind: "confirm",
      source: "model",
      question,
      detail: argStr(args.detail),
      options: CONFIRM_OPTIONS,
      allowText: true,
      danger,
    },
    signal,
  );

  const yes = ans.value === "yes";
  const skipped = ans.value === "__skip__";
  // 拿到许可就把 affects 记进本轮免检集合；用户拒绝时**明确撤掉**它 ——
  // 否则"他先拒绝、模型换个理由再调一次"会变成静默放行
  for (const a of affects) {
    if (yes) granted.add(a);
    else granted.delete(a);
  }

  return {
    action: {
      tool: name,
      args,
      ok: yes,
      summary: yes ? "你确认了" : skipped ? "你没有回答（跳过）" : ans.text ? "你提出了别的做法" : "你取消了",
      detail: [question, argStr(args.detail), affects.length ? `覆盖的动作：${affects.join("、")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    },
    content: yes
      ? `用户**确认了**${affects.length ? `（接下来可以做：${affects.join("、")}）` : ""}。可以继续。`
      : ans.text
        ? `用户没有确认，而是说：「${ans.text}」。**不要**按原计划动手 —— 按他说的调整。`
        : skipped
          ? "用户没有回答这次确认（他跳过了）。**不要**当作已同意：请停下来，把你要做什么再说清一点，或者干脆先不做。"
          : "用户取消了，所以**不要执行**这件事，也不要换个方式偷偷做。可以问他要怎么改。",
  };
}

/* ------------------------------------------------------------------ */
/* 一轮对话                                                            */
/* ------------------------------------------------------------------ */

let controller: AbortController | null = null;

/** 用户在等的时候点「停止」 */
export function abort(): void {
  controller?.abort();
}

export async function send(text: string, host: AgentHost): Promise<void> {
  const input = text.trim();
  if (!input || state.busy) return;

  await ensureLoaded();

  const settings = withDefaults(await repo.getAllSettings());
  const cfg = readAgentConfig(settings);
  const permissions = parseAgentPermissions(settings);
  const problems = agentConfigProblems(cfg);
  if (problems.length) {
    // 没配好就停在门口，而且把"缺什么、去哪里补"一次说全
    emit({
      error: `${problems.join("；")}。在「设置 → AI 助手」里配好之后再说话。`,
    });
    return;
  }

  await push({ id: uid(), role: "user", content: input, actions: [], error: "" });
  // 这一段还没有名字的话，就用这句话开头几个字当标题（见 autoTitle 的说明）
  await autoTitle(input);

  controller = new AbortController();
  emit({ busy: true, streaming: "", phase: "正在思考…", error: "", ask: null });

  const wire: WireMessage[] = await buildWire(permissions);
  const allowed = (name: string): boolean => {
    const spec = toolSpec(name);
    if (!spec?.permission) return true;
    return permissions[spec.permission];
  };
  const tools = toolsForModel((s) => allowed(s.name));

  /**
   * 本轮已经拿到用户许可的动作（见 confirm_action 的 affects、以及
   * execute 里的强制确认门）。**生命周期就是这一轮** —— 下一轮重新问。
   *
   * 为什么按"动作名"记账而不是按"具体参数"：用户点那张卡的瞬间想的是
   * "行，你删吧"，不是"我同意删这三个 uuid"。按参数记账会让
   * "他说行、模型重发一次参数略有不同的调用"变成再问一遍 —— 那是
   * 用户最烦的那种确认。
   */
  const granted = new Set<string>();
  const collected: AgentAction[] = [];
  let finalText = "";

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      emit({
        phase: step === 0 ? "正在思考…" : "正在继续…",
        streaming: "",
      });

      const res = await chat(cfg, {
        messages: wire,
        tools,
        signal: controller.signal,
        onDelta: (t) => emit({ streaming: state.streaming + t }),
      });

      /* ---- 通道一：原生工具调用 ---- */
      if (res.toolCalls.length) {
        const parsed = actionsFromToolCalls(res.toolCalls);
        const calls = parsed.actions.map((a) => ({
          id: a.id,
          name: a.name,
          args: withHtmlFallback(a.name, a.args, res.text ?? ""),
          note: a.repaired ? REPAIRED_NOTE : "",
        }));

        // 助手的这一轮回复必须进上下文（含 tool_calls），否则下面那些 role=tool
        // 的结果没有配对的调用 —— 接口会直接报错。
        //
        // ⚠️ 但**不能把原始参数串原样回灌**：那是模型直接发来的字符串，可能不是
        // 合法 JSON（一整份 HTML 里少转义一个换行就够了）。服务端会校验我们带回去
        // 的这条 assistant 消息，一个坏 JSON 让**整次请求** 400
        // （"Assistant tool call xxx.arguments must be valid JSON"），而用户看到的
        // 只是"助手报了个看不懂的接口错误"。所以用 toolCallsForEcho 重新序列化；
        // 解析不出来的调用整个不回灌（它本来也没执行，没有结果要配对）。
        const echo = toolCallsForEcho(res.toolCalls, parsed.actions);
        if (echo.length) {
          wire.push({ role: "assistant", content: res.text || "", tool_calls: echo });
        } else if (res.text) {
          wire.push({ role: "assistant", content: res.text });
        }

        // 顺序要紧：tool 结果必须**紧跟**它的调用，中间不能插 user 消息 ——
        // 严格的服务端会判成"这个 tool 消息没有对应的调用"。
        wire.push(...(await execute(calls, { asTool: true }, permissions, host, collected, controller.signal, granted)));

        if (parsed.errors.length) {
          wire.push({
            role: "user",
            content: `（系统提示：你上面有 ${parsed.errors.length} 个调用我看不懂 —— ${parsed.errors.join("；")}。请修正后重试。）`,
          });
        }
        continue;
      }

      /* ---- 通道二：文本里的动作代码块 ---- */
      const text = res.text ?? "";
      const parsed = extractActions(text);
      const blockCalls = parsed.actions.map((a) => ({
        id: "",
        name: a.name,
        args: withHtmlFallback(a.name, a.args, text),
        note: a.repaired ? REPAIRED_NOTE : "",
      }));

      if (blockCalls.length) {
        wire.push({ role: "assistant", content: parsed.cleanText });
        wire.push(
          ...(await execute(blockCalls, { asTool: false }, permissions, host, collected, controller.signal, granted)),
        );
        if (parsed.errors.length) {
          wire.push({
            role: "user",
            content: `（系统提示：另外有几段我读不出来 —— ${parsed.errors.join("；")}。修好格式再来，或者直接说人话。）`,
          });
        }
        continue;
      }

      if (parsed.errors.length) {
        // 想调动作但格式坏了：回灌一次，让它改（只给一轮机会，避免死循环）
        wire.push({ role: "assistant", content: parsed.cleanText || text });
        wire.push({
          role: "user",
          content:
            `（系统提示：你写的那段我看不出要做什么 —— ${parsed.errors.join("；")}。` +
            `要么用正确的动作格式重写，要么直接用文字回答。）`,
        });
        if (step >= 2) {
          finalText = parsed.cleanText || text;
          break;
        }
        continue;
      }

      // 纯文本：这就是这一轮的答复
      finalText = parsed.cleanText || text;
      break;
    }

    if (!finalText && collected.length) {
      // 动作都做完了但模型没来得及说话：给一句兜底，别让用户看到空白气泡
      finalText = "";
    }
    if (!finalText && !collected.length && !state.error) {
      finalText = "（模型没有返回内容。可以重说一遍，或者换一个模型试试。）";
    }
  } catch (err) {
    if (isAbortError(err)) {
      finalText = finalText || "（已停止）";
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ error: msg });
      finalText = finalText || "";
      await push({
        id: uid(),
        role: "assistant",
        content: finalText,
        actions: collected,
        error: msg,
      });
      emit({ busy: false, streaming: "", phase: "" });
      controller = null;
      return;
    }
  } finally {
    if (state.busy) {
      // 正常收尾：把这一轮的答复与动作一起落库
      if (finalText || collected.length) {
        await push({
          id: uid(),
          role: "assistant",
          content: finalText,
          actions: collected,
          error: "",
        });
      }
      controller = null;
      emit({ busy: false, streaming: "", phase: "" });
    }
  }
}

/**
 * 执行一批动作，返回要回灌进上下文的消息。
 *
 * ------------------------------------------------------------------
 * 这里是"助手能不能动手"的唯一闸口
 * ------------------------------------------------------------------
 * 一个调用进来要过三道关，顺序不能换：
 *
 *   1. **问人类的动作**（ask_user_choice / confirm_action）不在这里执行，
 *      走 runAskTool —— 它要 await 一个真人，卡住整轮循环。
 *   2. **强制确认门**：删除/覆盖这类不可逆动作，不管模型有没有自觉
 *      先问一句，都得先过用户这一关（describeConfirm）。本轮已许可的
 *      记在 granted 里，不再重复问。
 *   3. **权限门**：runAction 内部（gate）挡的是"用户关掉的那类权限"。
 *
 * 第 2 道门为什么必须在这里：**放在模型那边就只是概率**。提示词写得再狠，
 * 模型也可能忘了先问就直接调 delete_schedules。而删除是不可逆的，
 * 用户要的是"不管它怎么想，删我之前都得点一下"。
 */
async function execute(
  calls: Array<{ id: string; name: string; args: Record<string, unknown>; note?: string }>,
  mode: { asTool: boolean },
  permissions: { writeTools: boolean; schedules: boolean; database: boolean },
  host: AgentHost,
  collected: AgentAction[],
  signal: AbortSignal,
  granted: Set<string>,
): Promise<WireMessage[]> {
  const results: Array<{ id: string; content: string }> = [];

  for (const call of calls) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");

    /* ---- 1. 停下来问用户 ---- */
    if (isAskTool(call.name)) {
      emit({ phase: `正在${toolSpec(call.name)?.label ?? call.name}…` });
      const asked = await runAskTool(call.name, call.args, signal, granted);
      collected.push(asked.action);
      results.push({ id: call.id, content: call.note ? `${call.note}\n${asked.content}` : asked.content });
      continue;
    }

    /* ---- 2. 强制确认门 ---- */
    const need = await describeConfirm(call.name, call.args);
    if (need && !granted.has(call.name)) {
      const label = toolSpec(call.name)?.label ?? call.name;
      emit({ phase: `${label}需要你确认…` });

      const ans = await askOnce(
        {
          kind: "confirm",
          // 这张卡不是模型主动发的，是宿主拦下来的 —— 标出来是为了让界面
          // （和将来读历史的人）分清"它问的"和"系统挡的"，后者更该被当回事
          source: "host",
          question: need.question,
          detail: need.detail,
          options: CONFIRM_OPTIONS,
          allowText: true,
          danger: need.danger,
        },
        signal,
      );

      const yes = ans.value === "yes";
      for (const a of need.affects) {
        if (yes) granted.add(a);
        else granted.delete(a);
      }

      if (!yes) {
        /*
         * 被拦下来之后**必须给模型一句能接上的话**，不能只是静默跳过。
         * 否则模型看到"我调了 delete_schedules、没有回音"，最常见的反应是
         * 再调一次 —— 那就变成每轮弹一张确认卡，用户连点取消到手酸。
         * 明确说"用户不同意，别再试"，这个循环才会真的停下来。
         */
        const why = ans.text
          ? `用户没有同意，而是说：「${ans.text}」。`
          : ans.value === "__skip__"
            ? "用户没有回答这次确认。这**不算同意**。"
            : "用户取消了这次操作。";
        collected.push({
          tool: call.name,
          args: call.args,
          ok: false,
          summary: ans.text ? "你提出了别的做法" : ans.value === "__skip__" ? "你没有回答（已拦下）" : "你取消了",
          detail: need.question,
        });
        results.push({
          id: call.id,
          content:
            `${why}\n\n**不要重试同一个动作**，也不要换个写法绕过去。` +
            (ans.text ? "按他说的调整，或者问他要什么。" : "可以说明你原本想做什么，问他要不要换个做法。"),
        });
        continue;
      }
    }

    /* ---- 3. 真动手 ---- */
    const label = toolSpec(call.name)?.label ?? call.name;
    emit({ phase: `正在${label}…` });
    const outcome: Outcome = await runAction(call.name, call.args, { permissions, host });
    collected.push(outcome.action);
    // note 是给模型看的（"你的参数我修过"），放最前面，免得被结果正文淹掉
    results.push({ id: call.id, content: call.note ? `${call.note}\n${outcome.content}` : outcome.content });
  }

  if (mode.asTool) {
    return results.map((r) => ({
      role: "tool" as const,
      tool_call_id: r.id,
      content: r.content,
    }));
  }
  // 文本通道没有 tool_call_id，只能用 user 消息回灌 —— 必须明确标注
  // "这是执行结果不是新指令"，否则模型会把它当成用户又说了句话
  return [
    {
      role: "user",
      content:
        "（系统提示：这是刚才那些动作的**执行结果**，不是新指令。请据此继续：成功就说清楚结果，失败就按原因修正或如实告知。）\n" +
        results.map((r, i) => `${i + 1}. ${r.content}`).join("\n"),
    },
  ];
}

/** 组装这一轮的上下文：system + 最近的历史 */
async function buildWire(
  permissions: { writeTools: boolean; schedules: boolean; database: boolean },
): Promise<WireMessage[]> {
  const [lists, settings] = await Promise.all([repo.fetchLists(), repo.getAllSettings()]);
  const disabled = parseDisabledTools(settings[SETTINGS.toolsDisabled]);

  const system = buildSystemPrompt({
    now: new Date(),
    permissions,
    tools: listTools()
      .filter((t) => !disabled.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, hasSchema: !!t.schema })),
    lists: lists.map((l) => l.name),
    desktop: isTauri(),
  });

  const history = state.messages.slice(-HISTORY_LIMIT).map<WireMessage>((m) => {
    if (m.role === "user") return { role: "user", content: m.content };
    // 助手消息带上"它当时做过什么"：不带的话，模型会以为自己上一次没说清楚，
    // 于是把同一件事再做一遍（真的会装出第二个工具）
    const acts = m.actions.length
      ? `\n（这一轮你执行过：${m.actions
          .map((a) => `${a.tool} → ${a.ok ? "成功" : `失败：${a.error ?? ""}`}`)
          .join("；")}）`
      : "";
    const err = m.error ? `\n（当时失败了：${m.error}）` : "";
    return { role: "assistant", content: `${m.content}${acts}${err}` };
  });

  return [{ role: "system", content: system }, ...history];
}

/* ------------------------------------------------------------------ */
/* 多会话：新建 / 切换 / 改名 / 删除                                    */
/* ------------------------------------------------------------------ */

/**
 * 等正在跑的那一轮收干净，再改"当前是哪一段"。
 *
 * 少了这一步，切会话之后模型返回的结果会落到**新的**那一段里 ——
 * 那是最糟的一种串台：用户以为自己只是翻了个旧对话，回来发现
 * 里面多了一段不属于它的话，而且讲的是刚才那件事。
 */
async function settle(): Promise<void> {
  if (!state.busy) return;
  abort();
  // 给 abort 一点时间把这一轮收干净（它要落一条"已停止"）
  await new Promise((r) => setTimeout(r, 120));
}

/**
 * 开一段新对话。
 *
 * ⚠️ 它**不再清空**任何东西。旧版就是这个语义，也正是这一版要拆开的原因：
 * 「新对话」按下去会不会抹掉上一段，用户没法确定 —— 于是干脆不敢按。
 * 现在旧的留在右侧历史里随时能翻回去，它才变成一个可以随手按的按钮。
 * 真删在 clearAllChats（设置 → AI 助手，两段式确认）。
 *
 * 返回新会话的 id（旧版返回"清掉了几条"，见 Settings 的调用点）。
 */
export async function newChat(): Promise<string> {
  await settle();
  const chat = await createChat();
  await repo.setSetting(SETTINGS.agentCurrentChat, chat.id);
  emit({
    chats: [chat, ...state.chats],
    currentChatId: chat.id,
    messages: [],
    streaming: "",
    phase: "",
    error: "",
  });
  return chat.id;
}

/** 切到另一段对话 */
export async function switchChat(id: string): Promise<void> {
  if (id === state.currentChatId) return;
  // 已经不在列表里（比如刚被删）就什么都不做，别切到一个不存在的会话上
  if (!state.chats.some((c) => c.id === id)) return;
  await settle();
  const rows = await repo.fetchAgentMessages(id);
  await repo.setSetting(SETTINGS.agentCurrentChat, id);
  emit({ currentChatId: id, messages: rows, streaming: "", phase: "", error: "" });
}

/** 改标题。界面里那条"点着改"的路也走这里 */
export async function renameChat(id: string, title: string): Promise<void> {
  const t = title.replace(/\s+/g, " ").trim().slice(0, 40);
  await repo.renameAgentChat(id, t);
  emit({ chats: state.chats.map((c) => (c.id === id ? { ...c, title: t } : c)) });
}

/**
 * 删一段对话（连同它的消息）。返回删掉了几条消息。
 *
 * 删掉的正好是当前这段时顺位切到最近动过的那段；一段都不剩就新建一段 ——
 * 不能让界面停在"没有当前会话"的状态上（那时输入框无处可写）。
 */
export async function deleteChat(id: string): Promise<number> {
  if (id === state.currentChatId) await settle();
  const n = await repo.deleteAgentChat(id);
  let chats = await repo.fetchAgentChats();
  if (!chats.length) chats = [await createChat()];

  if (state.currentChatId !== id) {
    // 删的是别人（列表里另一段）：只更新列表
    emit({ chats });
    return n;
  }

  const next = chats[0];
  const rows = await repo.fetchAgentMessages(next.id);
  await repo.setSetting(SETTINGS.agentCurrentChat, next.id);
  emit({
    chats,
    currentChatId: next.id,
    messages: rows,
    streaming: "",
    phase: "",
    error: "",
  });
  return n;
}

/**
 * 清空**全部**历史（设置 → AI 助手那个两段式按钮）。返回删掉了几条消息。
 *
 * 与「新对话」严格分开：这里是真删数据，入口只有设置里那一个。
 * 清完留一段空的 —— 否则历史列表空着、也没有会话可写。
 */
export async function clearAllChats(): Promise<number> {
  await settle();
  const n = await repo.clearAgentMessages();
  const chat = await createChat();
  await repo.setSetting(SETTINGS.agentCurrentChat, chat.id);
  emit({
    chats: [chat],
    currentChatId: chat.id,
    messages: [],
    streaming: "",
    phase: "",
    error: "",
  });
  return n;
}

/**
 * 用第一句话给这段对话起个标题。
 *
 * 只在一段**还没有标题**时做一次：每说一句就改一次的话，历史列表里那一行
 * 会一直跳，用户根本来不及用它定位。用户手改过的标题同样不会被覆盖
 * （改完 title 非空，这里直接返回）。
 */
async function autoTitle(firstText: string): Promise<void> {
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  if (!chat || chat.title) return;
  const title = firstText.replace(/\s+/g, " ").trim().slice(0, AUTO_TITLE_MAX);
  if (!title) return;
  await repo.renameAgentChat(chat.id, title);
  emit({ chats: state.chats.map((c) => (c.id === chat.id ? { ...c, title } : c)) });
}

/** 当前使用的服务商显示名（界面顶部用） */
export function providerLabelFor(id: string): string {
  return agentProvider(id).name;
}
