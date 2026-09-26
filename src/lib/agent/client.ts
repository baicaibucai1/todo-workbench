/**
 * 和模型说话的那一层：一次请求、流式读回。
 *
 * ------------------------------------------------------------------
 * 为什么是 fetch 而不是走 Rust
 * ------------------------------------------------------------------
 * 桌面上有很多"前端发不出去的请求"最后都挪到了 Rust（WebDAV 的 PROPFIND、
 * OneDrive 的授权码回调）—— 但对话接口**不在这一列**：
 *
 *   · 这些服务商都给 CORS 头（工作台里的「AI 生成」工具一直在浏览器里直连，
 *     已经跑了几十个版本），所以没有绕的必要；
 *   · 加一条 Rust 命令意味着改依赖、整树重编（见 attachments.rs 顶部那条教训），
 *     换来的只是"少一次跨源检查"；
 *   · 更重要的是它对**浏览器演示模式**可用 —— 用户可以先在网页里试通了
 *     再决定要不要真去申请 Key。
 *
 * 万一某家网关不给 CORS 头，报错会被映射成一句说得清的话（见下面 catch 里
 * 对 TypeError 的处理），而不是一个没有上下文的 "Failed to fetch"。
 *
 * ------------------------------------------------------------------
 * 流式的三个坑
 * ------------------------------------------------------------------
 *  1. SSE 的分片**不按行切**：一个 chunk 可能在半个 JSON 中间断开，
 *     所以要留一个 buffer，只处理以空行结尾的完整事件。
 *  2. tool_calls 是**增量拼接**的：第一个分片给 id 和函数名，后面的分片
 *     只给 arguments 的字符串片段。按 index 累积，否则参数永远解析不出来。
 *  3. 有些网关**收了 stream:true 却返回一整个 JSON**（不是 SSE）。
 *     所以还要留一条兜底：整段读回来，看着像 JSON 就按非流式解析。
 *     少了这条，那家网关上的表现是"永远不出字"。
 */

import {
  agentProvider,
  buildChatBody,
  chatEndpoint,
  chatHeaders,
  describeHttpError,
  parseChatResponse,
  parseDeltaText,
  parseDeltaToolCalls,
  type RawToolCall,
} from "./providers";

/** 发给模型的消息（OpenAI 形状，只用到这几种字段） */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 发起工具调用时带 */
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** role="tool" 时指回哪一个调用 */
  tool_call_id?: string;
}

export interface ChatOptions {
  messages: WireMessage[];
  /** 原生工具定义。空数组或不给表示这次不带 */
  tools: Array<Record<string, unknown>>;
  /** 每收到一段文本就回调一次（UI 的打字机效果） */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /**
   * 准备重试时回调一次。
   *
   * **上层必须在这里把已经打出来的字清掉** —— 一次 chat 是"要么完整回来、
   * 要么一句都没算数"，重试是整个请求重发；若 UI 不回滚，用户会看到半句话
   * 后面接着一个完整的重述。
   */
  onRetry?: (info: { attempt: number; max: number; waitMs: number; reason: string }) => void;
}

export interface ChatResult {
  /** 这一轮模型说出来的话（没有工具调用时就是最终答复） */
  text: string;
  /** 这一轮模型想做的事 */
  toolCalls: RawToolCall[];
  /**
   * 这一轮的话**被长度截断了**（流式分片里的 finish_reason === "length"）。
   *
   * 为什么要把这个状态带出来：截断的表现是"它写了一半就没了"，
   * 而模型自己**不知道**自己被截断了 —— 它以为那份 HTML 写完了，
   * 于是下一步信心十足地调 install_tool，宿主却只拿到一个空参数。
   * 不告诉它，它会在原地重试同一件事，越试越糊涂。
   */
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* 重试：网络会断，这是常态不是意外                                    */
/* ------------------------------------------------------------------ */

/**
 * 除首次之外最多再试几次。3 次 ≈ 2.4s / 4.8s（含抖动共 ~8s），
 * 够覆盖"抽了一下"，又不至于让用户对着转圈干等半分钟。
 */
const RETRY_MAX = 3;
/** 退避基数，按 2 的幂放大 */
const RETRY_BASE_MS = 800;
/** 退避上限：再长就是在浪费用户的耐心 */
const RETRY_CEIL_MS = 8000;
/**
 * 多久一个字节都没收到就算断流。
 *
 * 写工具的回合里模型可能先想很久（连之前许可证那几步也要几十秒），
 * 所以给到 60 秒；低于这个值会把慢模型误杀。
 */
const IDLE_MS = 60_000;

/** 值得再试一次的 HTTP 状态：都是"你没错，服务端/链路这会儿不行" */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/** 连不上 / 链路中途断 —— 属于"再试一次可能就好了" */
export class AgentNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNetworkError";
  }
}

/** 流读到一半断了（含空闲超时）—— 同样值一次重试 */
export class AgentStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStreamError";
  }
}

/**
 * `read()` 迟迟不返回时的哨兵值。用 Symbol 而不是字符串，
 * 是为了跟 ReadableStreamReadResult 在类型上也不可能撞。
 */
const INCOMPLETE_WAIT_TIMEOUT = Symbol("idle-timeout");

export class AgentHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 服务端让等多久再来（429 的 Retry-After），没有就是 undefined */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
}

/** 这个错值不值得再试一次（导出是为了让上层/测试能复用同一套判定） */
export function isRetryableError(err: unknown): boolean {
  if (isAbort(err)) return false;
  if (err instanceof AgentNetworkError || err instanceof AgentStreamError) return true;
  if (err instanceof AgentHttpError) return RETRYABLE_STATUS.has(err.status);
  // 兜底：有些 fetch 实现的底层错误会以普通 Error 冒上来，
  // 只认那些明确指向"链路断了"的说法，别把配置错误也当成网络抖动去重发。
  const msg = err instanceof Error ? err.message : "";
  return /network error|failed to fetch|terminated|socket hang up|econnreset|etimedout|unexpected eof/i.test(
    msg,
  );
}

/**
 * 一次对话请求：失败会自动重试几次，全部失败抛带人话的 Error。
 *
 * 为什么要重试：对话接口是**长连接 + 流式**，比普通请求更容易撞上
 * 链路抖动；而用户这一轮的上下文（前面说过的条件、已经读过的技能）
 * 值钱得很 —— 一句"network error"让他整个重说一遍是最差的体验。
 *
 * 重试的边界（**认错比多试更重要**）：
 *   · 用户在 ＝ 立刻投，不重试（人家已经不想等了）
 *   · 401/403/400 之类 —— 是配置错/请求错，重发一百次也是同一个结果
 *   · 5xx / 429 / 读流中断 —— 再试一次很可能就成了
 * 每次重试都会先调 `onRetry`，让上层把已经打出来的字回滚掉。
 */
export async function chat(
  cfg: { provider: string; baseUrl: string; apiKey: string; model: string },
  o: ChatOptions,
): Promise<ChatResult> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (attempt > 0) {
      const waitMs = waitBefore(attempt, lastErr);
      o.onRetry?.({
        attempt,
        max: RETRY_MAX,
        waitMs,
        reason: lastErr instanceof Error ? lastErr.message : String(lastErr ?? ""),
      });
      await sleep(waitMs, o.signal);
    }
    if (o.signal?.aborted) throw abortError();

    try {
      return await chatOnce(cfg, o);
    } catch (err) {
      if (isAbort(err)) throw err;
      lastErr = err;
      if (!isRetryableError(err) || attempt === RETRY_MAX) {
        throw finishError(err, attempt);
      }
    }
  }
  /* 不可达：循环要么 return，要么 throw —— 这里只是为了让 TS 认账 */
  throw finishError(lastErr, RETRY_MAX);
}

/** 重试耗尽后抛的那句话：带上"试过几次"，否则用户以为我们一次没试 */
function finishError(err: unknown, tries: number): Error {
  if (tries <= 0 || isAbort(err)) return err instanceof Error ? err : new Error(String(err));
  const e = err instanceof Error ? err : new Error(String(err));
  const tail = `（已经自动重试 ${tries} 次，还是没通）`;
  if (e.message.includes("已经自动重试")) return e;
  e.message = `${e.message}${tail}`;
  return e;
}

/** 第 attempt 次重试要等多久：指数退避 + 抖动；429 服服务端给的等待 */
function waitBefore(attempt: number, lastErr: unknown): number {
  if (lastErr instanceof AgentHttpError && lastErr.retryAfterMs) {
    return Math.min(lastErr.retryAfterMs, RETRY_CEIL_MS);
  }
  const base = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CEIL_MS);
  // 抖动：几个人同时抖动时别对齐撞回去
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

/** 能被 AbortSignal 立刻打断的 sleep —— 用户在等的每一毫秒都算他的 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException("已停止", "AbortError");
}

/** 一次对话请求（不含重试）。成功返回文本 + 工具调用，失败抛错 */
async function chatOnce(
  cfg: { provider: string; baseUrl: string; apiKey: string; model: string },
  o: ChatOptions,
): Promise<ChatResult> {
  const endpoint = chatEndpoint(cfg);
  if (!endpoint) throw new Error("还没有填接口地址（Base URL），去「设置 → AI 助手」里补上");
  const provider = agentProvider(cfg.provider);
  const useTools = provider.nativeTools && o.tools.length > 0;

  const body = buildChatBody(cfg, {
    messages: o.messages,
    stream: true,
    tools: useTools ? o.tools : null,
  });

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: chatHeaders(cfg),
      body: JSON.stringify(body),
      signal: o.signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    // fetch 的 TypeError 几乎只有两种成因：网络不通，或者跨源被拦。
    // 用专门的错误类型，重试逻辑才认得出它"值得再试"。
    throw new AgentNetworkError(
      `连不上 ${endpoint}。可能的原因：网络不通、地址写错，或者这家接口不给跨源访问（CORS）。` +
        `原始错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AgentHttpError(
      describeHttpError(res.status, text),
      res.status,
      readRetryAfter(res.headers.get("retry-after")),
    );
  }

  const ctype = res.headers.get("content-type") ?? "";
  // 收了 stream:true 却回 JSON 的网关就走这条路
  if (!res.body || ctype.includes("application/json")) {
    const json = await res.json().catch(() => null);
    if (!json) throw new AgentNetworkError("接口返回的内容读不出来（连接可能在中途断了）");
    const parsed = parseChatResponse(json);
    if (parsed.text && o.onDelta) o.onDelta(parsed.text);
    // 非流式那一路也要看一眼结束原因：它同样可能被 max_tokens 掐断
    const reason = (json as { choices?: Array<{ finish_reason?: unknown }> })?.choices?.[0]?.finish_reason;
    return { ...parsed, truncated: reason === "length" };
  }

  return readStream(res, o);
}

/** Retry-After 可能是秒数，也可能是 HTTP 日期。读不出来就返回 undefined */
function readRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const sec = Number(raw.trim());
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const delta = at - Date.now();
  return delta > 0 ? Math.min(delta, RETRY_CEIL_MS) : undefined;
}

async function readStream(res: Response, o: ChatOptions): Promise<ChatResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  /**
   * 空闲计时器：每调用一次就重新计时。
   * 用 Promise.race 而不是给整个流式加超时 —— 后者会把"模型真的在慢慢写"
   * 当成故障，前者只在**什么都没来**时才判定断流。
   */
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const idleSignal = (): Promise<typeof INCOMPLETE_WAIT_TIMEOUT> =>
    new Promise((resolve) => {
      idleTimer = setTimeout(() => resolve(INCOMPLETE_WAIT_TIMEOUT), IDLE_MS);
    });
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  let buffer = "";
  let text = "";
  let sawSse = false;
  let sawDone = false;
  let truncated = false;
  /**
   * tool_calls 的累积表，按 index 归档。
   * index 是流里的**调用序号**（第 0 个、第 1 个），不是数组下标 ——
   * 一个回合里模型可能同时发起好几个调用，它们的分片会交错到来。
   */
  const calls = new Map<number, RawToolCall>();

  const handleEvent = (payload: string) => {
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // 半个 JSON 或心跳注释：丢掉，下一轮就会补全
    }

    /*
     * 结束原因。`length` = 撞到了 max_tokens，话没说完就被掐断。
     * 这个信号只藏在最后一个分片里，而它是"写了一半"那类故障的**唯一**线索 ——
     * 不读它，宿主只能看到"参数里没有 html"，然后一遍遍重试同一件事。
     */
    const reason = (json as { choices?: Array<{ finish_reason?: unknown }> })?.choices?.[0]?.finish_reason;
    if (reason === "length") truncated = true;

    const deltaText = parseDeltaText(json);
    if (deltaText) {
      text += deltaText;
      o.onDelta?.(deltaText);
    }

    for (const d of parseDeltaToolCalls(json)) {
      const cur = calls.get(d.index) ?? { id: "", name: "", args: "" };
      if (d.id && !cur.id) cur.id = d.id;
      if (d.name) {
        // 三种厂商习惯都要能接住：
        //   只给一次完整名（OpenAI 官方）
        //   每片都给完整名（部分网关）
        //   每片给名字的片段（少数）
        if (!cur.name) cur.name = d.name;
        else if (d.name.startsWith(cur.name)) cur.name = d.name;
        else if (!cur.name.endsWith(d.name)) cur.name += d.name;
      }
      cur.args += d.args ?? "";
      calls.set(d.index, cur);
    }
  };

  while (true) {
    let read: ReadableStreamReadResult<Uint8Array> | typeof INCOMPLETE_WAIT_TIMEOUT;
    try {
      read = await Promise.race([reader.read(), idleSignal()]);
    } catch (err) {
      if (isAbort(err)) throw err;
      // 读到一半连接没了：这一轮的产出是不完整的，**不能**当成正常结果返回，
      // 否则模型会拿着一段没头没尾的输出继续往下走。
      throw new AgentStreamError(
        `读到一半连接断了：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (read === INCOMPLETE_WAIT_TIMEOUT) {
      throw new AgentStreamError(`连续 ${Math.round(IDLE_MS / 1000)} 秒没有收到任何内容，链路可能已经断了`);
    }
    clearIdle();
    const { done, value } = read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 事件以空行分隔；只处理完整的事件，剩下的留在 buffer 里
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        sawSse = true;
      handleEvent(trimmed.slice(5).trim());
      }
    }
  }

  // 收尾：最后一段可能没有以空行结束
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      sawSse = true;
      handleEvent(trimmed.slice(5).trim());
    }
  }

  clearIdle();

  if (!sawSse) {
    // 全程一个 SSE 事件都没有。两种成因要分开：
    //   · buffer 是空的 —— 服务端什么都没来得及给就把连接掐了（典型断流，值得重试）
    //   · buffer 有内容但不是 SSE —— 整段当 JSON 再试一次
    if (!buffer.trim()) {
      throw new AgentStreamError("接口连一个字节都没给就把连接关了（多半是链路断在用行里）");
    }
    try {
      const parsed = parseChatResponse(JSON.parse(buffer || "{}"));
      if (!parsed.text && !parsed.toolCalls.length) {
        throw new Error("接口返回的内容看不懂");
      }
      if (parsed.text) o.onDelta?.(parsed.text);
      return { ...parsed, truncated };
    } catch {
      throw new Error(
        "接口返回的内容既不是 SSE 流也不是 JSON。确认这个地址是不是 OpenAI 风格的 /chat/completions",
      );
    }
  }

  // 收到了 SSE 事件，但既没有 [DONE]、又没有文本也没有调用 ——
  // 这也是被掐断的样子（正常结束前至少会有一句 `[DONE]`）。
  if (!sawDone && !text.trim() && calls.size === 0) {
    throw new AgentStreamError("这一轮的输出被掐断了（没收到结束标记，也没有任何内容）");
  }

  return {
    text,
    truncated,
    toolCalls: [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, args: c.args })),
  };
}

function isAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    ((err as { name?: string }).name === "AbortError" ||
      (err as { name?: string }).name === "TimeoutError")
  );
}

export function isAbortError(err: unknown): boolean {
  return isAbort(err);
}
