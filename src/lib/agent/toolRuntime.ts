/**
 * 助手 → 工具的指令通道。
 *
 * ------------------------------------------------------------------
 * 它在解决什么
 * ------------------------------------------------------------------
 * "让番茄钟开始一个 25 分钟的专注"、"让那个计数器清零" —— 这类要求
 * 的对象不是数据，是**工具本身在干的事**。助手不该为了它去改工具的
 * 私有表（那只是改了显示的数字，工具自己的状态机并不知道），
 * 也不该重写一个工具（用户要的是"去按一下那个按钮"）。
 *
 * 所以给一条通道：助手发一个**命令**，宿主转交给工具，工具干完把结果回来。
 *
 * ------------------------------------------------------------------
 * 三条边界（同样是物理的，不是提示词）
 * ------------------------------------------------------------------
 *  1. **工具必须自己声明过这个动作**（manifest.actions，老式 manifest 是
 *     manifest.commands）。没声明就不发 —— 否则助手可以对任何工具发任何
 *     字符串，而"工具听不听得懂"变成一件只有运行时才知道的事。
 *  2. **优先发给正在打开的那个实例**。用户看得见它在动，才是"驱动工具"
 *     该有的样子。
 *  3. **没打开时，只有工具自己声明了 headless，宿主才会为它起一个隐藏实例**
 *     （见 toolHeadless.ts）。默认不起 —— 为此去后台偷偷开一个 iframe
 *     是另一回事（不可见、不可控），这条门必须由工具作者亲手打开。
 *  4. **有超时**。工具没回应就说没回应，不能让助手那一轮一直挂着。
 *
 * ------------------------------------------------------------------
 * 协议（工具作者那一侧，写在 tool-authoring 技能里）
 * ------------------------------------------------------------------
 *   宿主 → iframe : { source:"workbench-host", type:"tool:command", id, name, params }
 *   iframe → 宿主 : { source:"workbench-tool", type:"tool:command:result", id, ok, data?, error? }
 *   iframe → 宿主 : { source:"workbench-tool", type:"tool:hello" }            （可选，先报到）
 *
 * `source` 两个值与 toolBridge 用的是同一对常量 —— 工具只需多监听一个
 * type，不用另学一套。
 */

import { getTool } from "../tools";

/** 当前挂着的工具实例登记表。key 是工具 id */
const live = new Map<
  string,
  {
    toolId: string;
    frame: () => HTMLIFrameElement | null;
    commands: string[];
  }
>();

/** 工具挂上来时登记（由 ToolHost 调） */
export function registerLiveTool(
  toolId: string,
  frame: () => HTMLIFrameElement | null,
  commands: string[],
): void {
  live.set(toolId, { toolId, frame, commands });
}

export function unregisterLiveTool(toolId: string): void {
  live.delete(toolId);
}

/** 等待一条回执的最长时间 */
const REPLY_MS = 8000;

export interface CallResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

export interface CallOptions {
  /**
   * 允许宿主在工具没打开时为它起一个隐藏实例吗。
   *
   * 只有**工具自己在 manifest 里声明了 headless** 才会被传成 true ——
   * 这道门在宿主侧（actions.runToolAction），工具说了不算第二次。
   */
  headless?: boolean;
  /**
   * 隐藏实例用的设置（能力门要看）。
   *
   * 由宿主传进来：这一层不该自己去读库，而"图库现在开没开"必须按**此刻**
   * 的设置判断 —— 用户在设置里打开图库之后，下一条命令就该能用上它。
   */
  settings?: () => Record<string, string>;
}

/**
 * 给一个工具发命令，等它回话。
 *
 * `message` 是可以直接回给模型的话 —— 尤其"它没打开"这种，
 * 要告诉它下一步该做什么（先 open_tool），而不是干巴巴一句失败。
 */
export async function callTool(
  toolId: string,
  command: string,
  params: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<CallResult> {
  const entry = live.get(toolId);
  if (entry) {
    if (!entry.commands.includes(command)) {
      return {
        ok: false,
        message: `「${toolId}」没有声明动作「${command}」。它声明过的：${entry.commands.join("、") || "（一个都没有）"}`,
      };
    }
    const frame = entry.frame();
    if (!frame?.contentWindow) {
      return { ok: false, message: `「${toolId}」的 iframe 还没准备好，稍后再试一次` };
    }
    return sendCommandToFrame(frame, toolId, command, params, REPLY_MS);
  }

  const tool = getTool(toolId);
  if (!tool) {
    return {
      ok: false,
      message: `这台工作台上没有 id 为「${toolId}」的工具。先用 list_tools 看看都装了什么`,
    };
  }
  if (!(tool.actions ?? []).some((a) => a.name === command) && !(tool.commands ?? []).includes(command)) {
    const names = (tool.actions ?? []).map((a) => a.name);
    return {
      ok: false,
      message: `「${toolId}」没有声明动作「${command}」。它声明过的：${names.join("、") || "（一个都没有）"}`,
    };
  }

  if (!opts.headless || tool.headless !== true) {
    return {
      ok: false,
      message:
        `「${toolId}」现在没有打开。先调 open_tool 把它打开，再发命令 —— ` +
        `它没声明 headless，所以宿主不会为它在后台偷偷起一个实例`,
    };
  }

  // 隐藏实例那条路单独一个模块：它要建 iframe、接桥、等加载，
  // 而这里只想表达"什么时候该起、什么时候不起"。
  const { runHeadless } = await import("./toolHeadless");
  return runHeadless(tool, command, params, REPLY_MS, opts.settings);
}

/**
 * 往一个 iframe 发命令并等它的回执。
 *
 * 抽出来是因为**正在打开的实例**和**隐藏实例**用的是同一段等待逻辑，
 * 而这段逻辑最容易写错的地方是"忘了清理监听器" —— 写两份就一定会漏一份，
 * 漏的后果是每调一次泄漏一个 message 监听。
 */
export function sendCommandToFrame(
  frame: HTMLIFrameElement,
  toolId: string,
  command: string,
  params: Record<string, unknown>,
  replyMs: number,
): Promise<CallResult> {
  const win = frame.contentWindow;
  if (!win) {
    return Promise.resolve({ ok: false, message: `「${toolId}」的 iframe 还没准备好，稍后再试一次` });
  }

  const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<CallResult>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string; id?: string } | null;
      if (!m || m.source !== "workbench-tool") return;
      if (m.type !== "tool:command:result" || m.id !== id) return;
      // 只认这个 iframe 自己发的回执：同页面里还有别的工具在跑，
      // 不校验来源的话它们能替它回答（也能伪造一个"成功了"）
      if (e.source !== win) return;
      cleanup();
      const r = e.data as { ok?: boolean; data?: unknown; error?: string };
      if (r.ok === false) {
        resolve({ ok: false, message: r.error || "工具说这条命令没执行成功" });
        return;
      }
      resolve({ ok: true, data: r.data });
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        message: `等了 ${Math.round(replyMs / 1000)} 秒，「${toolId}」也没有回应「${command}」。它可能没监听 tool:command，或者正在忙`,
      });
    }, replyMs);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };

    window.addEventListener("message", onMessage);
    win.postMessage(
      { source: "workbench-host", type: "tool:command", id, name: command, params },
      "*",
    );
  });
}
