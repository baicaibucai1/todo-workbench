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
 * 所以给一条通道：助手发一个**命令**，宿主转交给正在打开的那个工具，
 * 工具干完把结果回来。
 *
 * ------------------------------------------------------------------
 * 三条边界（同样是物理的，不是提示词）
 * ------------------------------------------------------------------
 *  1. **工具必须自己声明过这个命令**（manifest.commands）。
 *     没声明就不发 —— 否则助手可以对任何工具发任何字符串，
 *     而"工具听不听得懂"变成一件只有运行时才知道的事。
 *  2. **只能发给当前打开的工具**。为此去后台偷偷起一个 iframe
 *     是另一回事（不可见、不可控），不做。
 *  3. **有超时**。工具没回应就说没回应，不能让助手那一轮一直挂着。
 *
 * ------------------------------------------------------------------
 * 协议（工具作者那一侧，写在 tool-authoring 技能里）
 * ------------------------------------------------------------------
 *   宿主 → iframe : { source:"workbench-host", type:"tool:command", id, name, params }
 *   iframe → 宿主 : { source:"workbench-tool", type:"tool:command:result", id, ok, data?, error? }
 *
 * `source` 两个值与 toolBridge 用的是同一对常量 —— 工具只需多监听一个
 * type，不用另学一套。
 */

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

/** 某个工具现在开着吗 */
export function isToolLive(toolId: string): boolean {
  return live.has(toolId);
}

/** 它声明了哪些命令（没开就返回空数组） */
export function liveCommands(toolId: string): string[] {
  return live.get(toolId)?.commands ?? [];
}

/** 等待一条回执的最长时间 */
const REPLY_MS = 8000;

export interface CallResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

/**
 * 给一个**已经打开**的工具发命令，等它回话。
 *
 * `message` 是可以直接回给模型的话 —— 尤其"它没打开"这种，
 * 要告诉它下一步该做什么（先 open_tool），而不是干巴巴一句失败。
 */
export async function callTool(
  toolId: string,
  command: string,
  params: Record<string, unknown> = {},
): Promise<CallResult> {
  const entry = live.get(toolId);
  if (!entry) {
    return {
      ok: false,
      message: `「${toolId}」现在没有打开。先调 open_tool 把它打开，再发命令 —— 这条通道只发给正在运行的那个实例`,
    };
  }
  if (!entry.commands.includes(command)) {
    return {
      ok: false,
      message: `「${toolId}」没有声明命令「${command}」。它声明过的：${entry.commands.join("、") || "（一个都没有）"}`,
    };
  }
  const win = entry.frame()?.contentWindow;
  if (!win) {
    return { ok: false, message: `「${toolId}」的 iframe 还没准备好，稍后再试一次` };
  }

  const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<CallResult>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string; id?: string } | null;
      if (!m || m.source !== "workbench-tool") return;
      if (m.type !== "tool:command:result" || m.id !== id) return;
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
        message: `等了 ${Math.round(REPLY_MS / 1000)} 秒，「${toolId}」也没有回应「${command}」。它可能没监听 tool:command，或者正在忙`,
      });
    }, REPLY_MS);
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
