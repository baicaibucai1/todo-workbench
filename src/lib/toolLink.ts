/**
 * 工具联动的投递登记处。
 *
 * 每个工具在自己的 iframe 里，彼此看不见对方 —— A 想给 B 东西，只能把东西
 * 交给宿主、由宿主转过去。这个模块就是那份"谁能收到消息"的名单。
 *
 * ------------------------------------------------------------------
 * 为什么是 Map<id, Set<poster>> 而不是 Map<id, poster>
 * ------------------------------------------------------------------
 * 同一个工具在界面上确实只应该有一个实例。但**重建是会发生的**：
 * 切工具时旧桥 detach、新桥 attach，两者在同一个事件循环里交错并不罕见
 * （StrictMode 下更是每次都这样）。用单值存储，新桥注册会把旧桥覆盖掉，
 * 而旧桥的 detach 又会把新桥的注册再删一遍 —— 结果是一个"谁都没注册"的
 * 空状态，表现为"工具明明开着，却收不到任何东西"。
 * Set 让注册与注销互不影响：各删各的那一个。
 *
 * ------------------------------------------------------------------
 * 为什么不做订阅/发布
 * ------------------------------------------------------------------
 * 见 toolBridge 文件头那段：事件总线的致命伤是"没人听的时候消息就丢了，
 * 而且丢得悄无声息"。这里只提供定向投递，收不到就明确返回 false，
 * 调用方据此告诉用户"它没在运行"。
 */

type Poster = (msg: unknown) => void;

/** 每个工具 id 到一组投递函数的映射 */
const posters = new Map<string, Set<Poster>>();

/** 登记一个工具的投递函数 */
export function registerToolPoster(toolId: string, post: Poster): void {
  let set = posters.get(toolId);
  if (!set) {
    set = new Set();
    posters.set(toolId, set);
  }
  set.add(post);
}

/** 注销（工具被卸载或重新挂载时） */
export function unregisterToolPoster(toolId: string, post: Poster): void {
  const set = posters.get(toolId);
  if (!set) return;
  set.delete(post);
  if (set.size === 0) posters.delete(toolId);
}

/**
 * 这个工具此刻有没有接收端。
 *
 * 注意它回答的是"有没有 iframe 挂着"，不是"用户能不能打开它" ——
 * 后者由登记表的 enabled 决定，两者是正交的（详见 toolStore 文件头的三种状态）。
 */
export function isToolRunning(toolId: string): boolean {
  const set = posters.get(toolId);
  return !!set && set.size > 0;
}

/**
 * 给某个工具投递一条消息。返回是否真的投出去了。
 *
 * 返回值的意义：调用方要能区分"对方收到了"和"这里压根没人在听"。
 * 后者必须由界面说出来，否则用户看到的是"点了没反应"。
 */
export function postToTool(toolId: string, msg: unknown): boolean {
  const set = posters.get(toolId);
  if (!set || set.size === 0) return false;
  for (const post of set) post(msg);
  return true;
}

/** 供测试用：清空登记表 */
export function __resetToolLink(): void {
  posters.clear();
}
