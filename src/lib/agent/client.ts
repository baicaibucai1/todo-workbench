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
}

export interface ChatResult {
  /** 这一轮模型说出来的话（没有工具调用时就是最终答复） */
  text: string;
  /** 这一轮模型想做的事 */
  toolCalls: RawToolCall[];
}

export class AgentHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
}

/** 一次对话请求。成功返回文本 + 工具调用；任何失败都抛带人话的 Error */
export async function chat(
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
    // fetch 的 TypeError 几乎只有两种成因：网络不通，或者跨源被拦
    throw new Error(
      `连不上 ${endpoint}。可能的原因：网络不通、地址写错，或者这家接口不给跨源访问（CORS）。` +
        `原始错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AgentHttpError(describeHttpError(res.status, text), res.status);
  }

  const ctype = res.headers.get("content-type") ?? "";
  // 收了 stream:true 却回 JSON 的网关就走这条路
  if (!res.body || ctype.includes("application/json")) {
    const json = await res.json().catch(() => null);
    if (!json) throw new Error("接口返回的内容读不出来（既不是 SSE 也不是 JSON）");
    const parsed = parseChatResponse(json);
    if (parsed.text && o.onDelta) o.onDelta(parsed.text);
    return parsed;
  }

  return readStream(res, o);
}

async function readStream(res: Response, o: ChatOptions): Promise<ChatResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawSse = false;
  /**
   * tool_calls 的累积表，按 index 归档。
   * index 是流里的**调用序号**（第 0 个、第 1 个），不是数组下标 ——
   * 一个回合里模型可能同时发起好几个调用，它们的分片会交错到来。
   */
  const calls = new Map<number, RawToolCall>();

  const handleEvent = (payload: string) => {
    if (payload === "[DONE]") return;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // 半个 JSON 或心跳注释：丢掉，下一轮就会补全
    }

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
    const { done, value } = await reader.read();
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

  if (!sawSse) {
    // 全程没见到 SSE 事件，但也不是 JSON 的 content-type ——
    // 把整段当成一个 JSON 再试一次，失败就明确报出来（"永远不出字"最难受）
    try {
      const parsed = parseChatResponse(JSON.parse(buffer || "{}"));
      if (!parsed.text && !parsed.toolCalls.length) {
        throw new Error("接口返回的内容看不懂");
      }
      if (parsed.text) o.onDelta?.(parsed.text);
      return parsed;
    } catch {
      throw new Error(
        "接口返回的内容既不是 SSE 流也不是 JSON。确认这个地址是不是 OpenAI 风格的 /chat/completions",
      );
    }
  }

  return {
    text,
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
