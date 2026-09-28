/**
 * 为一个**没被打开**的工具起一个隐藏实例，把命令发给它，拿到结果就回收。
 *
 * ------------------------------------------------------------------
 * 为什么这条路存在，以及为什么它默认是关的
 * ------------------------------------------------------------------
 * 助手要驱动一个工具，最自然的方式是驱动**用户看得见的那个实例** ——
 * 它能动、用户能确认。但很多时候工具根本没打开：用户只是说了句
 * "把随手记里那条备忘标成已完成"，为此先弹一个界面出来再点一下，
 * 是纯仪式感。
 *
 * 但"在后台偷偷起一个 iframe"本身是一件**不可见、不可控**的事：
 * 工具可能在里面弹窗、可能一直不响应、可能写一堆数据而用户毫无察觉。
 * 所以这条路不由助手决定、也不由宿主猜测，而是**工具作者在 manifest 里
 * 声明 headless** —— 那句话的意思是"我知道自己在没有界面的情况下也能
 * 正确干活"（不弹窗、不依赖用户点确认、不读 DOM 尺寸）。
 *
 * ------------------------------------------------------------------
 * 三条硬约束（物理的，不靠提示词）
 * ------------------------------------------------------------------
 *  1. **一次性**：一个实例只服务一条命令，拿到回执（或超时）立刻从 DOM 摘掉、
 *     桥也一起 detach。它不留下任何"还在跑的后台工具"。
 *  2. **有总预算**：加载有上限、等回执有上限。工具卡住不会让助手那一轮挂死。
 *  3. **实例是受限的**：它拿到的是和整页工具同一个桥（只能碰自己命名空间
 *     下的表），但**没有注入上下文**（task.get 拿不到东西）——
 *     隐藏实例不是挂在某条待办上的组件，给它一条待办的 id 是没有意义的。
 *
 * ------------------------------------------------------------------
 * 工具那一侧要做什么（写在 tool-authoring 技能里）
 * ------------------------------------------------------------------
 *   · 声明 `"headless": true`
 *   · **在解析阶段就挂上 message 监听**（内联 script 里直接 addEventListener）。
 *     等 DOMContentLoaded 之后才挂的话，宿主这边 iframe 的 load 已经触发、
 *     命令已经发出，那条消息会被丢进虚空 —— 不报错，也没人收到。
 */

import { resolveToolUrl } from "../tools";
import { ensureToolSchema, validateToolSchema, type ValidatedTable } from "../toolSchema";
import { createToolBridge } from "../toolBridge";
import { sendCommandToFrame, type CallResult } from "./toolRuntime";
import type { ToolManifest } from "../../types";

/** 等它加载完的最长时间。工具再大也不该让人等更久 */
const LOAD_MS = 15000;
/**
 * 加载完成之后再等一小会儿。
 *
 * 不是玄学：iframe 的 load 事件在主文档解析完成时触发，而工具那边的
 * 监听若是写在模块顶层、又被 `await` 之类推到微任务队列里，就可能比
 * load 晚一帧。120ms 足够它排到，又不会让每一条命令都显得慢。
 */
const SETTLE_MS = 120;

/** 与整页工具同一个沙箱策略（见 ToolHost）：不给顶层导航，允许脚本与同源读资源 */
const SANDBOX = "allow-scripts allow-same-origin allow-downloads allow-modals allow-forms allow-popups";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 起一个隐藏实例执行一条命令。
 *
 * `getSettings` 由调用方（宿主）给：能力门要按**此刻的设置**判断，
 * 而这一层读不到设置（它不该去读库）。给不了就按空设置处理 ——
 * 于是需要图库能力的命令会拿到宿主的拒绝原话，而不是静默失败。
 */
export async function runHeadless(
  tool: ToolManifest,
  command: string,
  params: Record<string, unknown>,
  replyMs: number,
  getSettings?: () => Record<string, string>,
): Promise<CallResult> {
  if (typeof document === "undefined") {
    return { ok: false, message: "当前环境没有 DOM，起不了隐藏实例（这条命令只能发给已打开的工具）" };
  }

  const url = await resolveToolUrl(tool);
  if (!url) {
    return {
      ok: false,
      message: `找不到「${tool.name}」的入口文件（manifest 里的 entry 指向的文件不存在）。先 open_tool 看看它是不是还装得完整`,
    };
  }

  // 私有表：整页工具是挂载时建的，隐藏实例没人替它建，所以自己来一次。
  // 建表失败**不终止** —— 多数命令不需要表，等它真去 row.* 时桥会照实报错。
  let tables: ValidatedTable[] = [];
  const schema = validateToolSchema(tool.id, tool.schema);
  if (schema) {
    try {
      tables = (await ensureToolSchema(tool.id, tool.dbVersion, schema)).tables;
    } catch {
      tables = [];
    }
  }

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", SANDBOX);
  frame.setAttribute("data-tool-headless", tool.id);
  frame.setAttribute("aria-hidden", "true");
  frame.title = `${tool.name}（后台执行）`;
  // 挪到视口外而不是 display:none：display:none 的 iframe 在部分 WebView 里
  // 会被节流甚至不执行脚本，而"命令发出去了没人回"是最难查的一种失效。
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  frame.src = url;

  const bridge = createToolBridge(tool.id, () => frame, {
    getTables: () => tables,
    ...(getSettings ? { getSettings } : {}),
  });

  try {
    bridge.attach();
    document.body.appendChild(frame);
    await waitReady(frame, LOAD_MS);
    await sleep(SETTLE_MS);
    return await sendCommandToFrame(frame, tool.id, command, params, replyMs);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    // 一次性实例：拿到结果就把它从世上抹掉，不留后台
    bridge.detach();
    frame.remove();
  }
}

/**
 * 等这个 iframe "可以收消息了"。
 *
 * 两个信号哪个先到都算：
 *   · `load` —— 主文档解析完成（多数工具在那时已经挂好监听）
 *   · `tool:hello` —— 工具自己报到（**推荐**，它明确表示"我准备好接命令了"）
 * 两个都没有就是加载超时，照实报错 —— 而不是硬发一条注定没人收的消息。
 */
function waitReady(frame: HTMLIFrameElement, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      frame.removeEventListener("load", onLoad);
      window.removeEventListener("message", onHello);
      err ? reject(err) : resolve();
    };
    const onLoad = () => finish();
    const onHello = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string } | null;
      if (m?.source !== "workbench-tool" || m.type !== "tool:hello") return;
      if (e.source !== frame.contentWindow) return;
      finish();
    };
    const timer = setTimeout(() => finish(new Error(`等了 ${Math.round(ms / 1000)} 秒，「${frame.getAttribute("data-tool-headless")}」也没有加载完`)), ms);
    frame.addEventListener("load", onLoad);
    window.addEventListener("message", onHello);
  });
}
