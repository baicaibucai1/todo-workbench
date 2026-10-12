/**
 * 左侧栏里那批「类目」有哪些、默认怎么排、顺序怎么改。
 *
 * ============================ 为什么做成可配置 ============================
 *
 * 侧栏上半那一竖列混着三种来源：注册表给的智能视图、启用的工具、用户自建的
 * 清单。原来的顺序是**各来源各自排**——视图按注册表写死的次序、工具按安装
 * 次序、清单按建表时的 sort_order。于是"我每天先看流程任务，顺手把便签提到
 * 视图下面"这种事做不到：写死的顺序等于替所有人决定先看什么。
 *
 * ============================ 谁不参与 ============================
 *
 * ① **「位置」类入口（图床 / 工作区）不在这条线里**。它们属于"这个程序里还有
 *    什么地方可去"，不是"看哪些任务"，所以固定贴在侧栏最底部、与「设置」挨着
 *    （2026-09-22 的取舍，tests/browser.mjs 里有一条断言盯着这个顺序）。
 * ② **「新建列表」是动作不是类目**，也不参与 —— 它跟在最后一个清单行后面。
 *
 * ============================ 存的是"稀疏覆盖"，不是完整快照 ============================
 *
 * 工具和清单的 id 是**运行时才有的**（装个工具、建个清单就多一个 key），
 * 所以不能把"完整顺序"当成配置存起来 —— 那份配置第二天就少了新加的那一项，
 * 而用户从没动过设置，界面却自己变了。
 *
 * 所以存下来的只是**用户明确表过态的那部分**：解析顺序 = 存的顺序（滤掉已经
 * 不在的）→ 剩下的按「跟着同类」补进去（新清单跟在最后一个清单后面，而不是
 * 甩到侧栏最底下、跑到「图床」下面去）。用户从没排过（存的是空）时，
 * 结果就等于默认顺序，也就是这个功能上线前的样子。
 *
 * ============================ 稳定键 ============================
 *
 * `nav:<id>` / `tool:<id>` / `list:<id>`。
 * 带前缀是因为不同来源可能撞 id（清单 id 和视图 id 都是普通字符串），
 * 前缀让它们在同一个数组里互不干扰，也顺手当成了"这是什么类型的行"的判据。
 *
 * 这里只有**顺序与键**，不包含行怎么渲染、图标怎么选 —— 那属于 Sidebar。
 */

export type SidebarItemKind = "nav" | "tool" | "list";

/** 键前缀 → 类型。只认这三种前缀，别的（坏数据、旧版本残留）一律不当数 */
export function sidebarKind(key: string): SidebarItemKind | null {
  const k = key.slice(0, key.indexOf(":"));
  return k === "nav" || k === "tool" || k === "list" ? k : null;
}

/** 设置页里给每类行配的说明文字 */
export const SIDEBAR_KIND_LABEL: Record<SidebarItemKind, string> = {
  nav: "智能视图",
  tool: "工具",
  list: "清单",
};

/**
 * 解析存下来的顺序。
 *
 * 存的是 JSON 数组字符串，可能被手改过、也可能是旧版本残留，
 * 所以只挑"看着像键"的字符串留下，其余丢掉 —— 具体的过滤与补位在
 * resolveSidebarOrder 里做，那里才知道当前有哪些项。
 */
export function parseSidebarOrder(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "");
    if (Array.isArray(v)) {
      return v.filter((x): x is string => typeof x === "string" && sidebarKind(x) !== null);
    }
  } catch {
    // 解析不了就当没配过，走默认
  }
  return [];
}

/**
 * 组的先后次序 —— **固定的界面结构，不是用户偏好**。
 *
 * 侧栏从上到下就是「智能视图 → 工具 → 清单」三段，段之间画一条分隔线。
 * 用户能改的是**段内**的先后（哪个视图第一、哪个清单在前），
 * 而不是把清单搬进工具段中间 —— 那会让三段变成一锅粥，
 * 而「这一项属于哪一类」是它自己的属性，本来就不该由排序决定。
 */
export const SIDEBAR_GROUPS: readonly SidebarItemKind[] = ["nav", "tool", "list"];

/**
 * 算出**这次渲染真正要用的顺序**。
 *
 * @param stored 设置里存的（可能为空 = 用户从没排过）
 * @param live   当前实际存在的键，按"默认顺序"给（视图 → 工具 → 清单）
 *
 * 按 SIDEBAR_GROUPS 一段一段拼，每段内两条规则：
 *   1. 存的顺序里、现在还活着的，照原样排前面（已经不在的直接跳过 ——
 *      停用的工具、删掉的清单，它的位置留着没意义）；
 *   2. 存里没提到的（新装的工具、新建的清单、新开的模块），补在**本段末尾**。
 *
 * 于是结果天然是「视图段 → 工具段 → 清单段」，段与段不会互相穿插。
 */
export function resolveSidebarOrder(stored: string[], live: string[]): string[] {
  const liveSet = new Set(live);
  const out: string[] = [];
  for (const kind of SIDEBAR_GROUPS) {
    for (const k of stored) {
      if (sidebarKind(k) === kind && liveSet.has(k) && !out.includes(k)) out.push(k);
    }
    for (const k of live) {
      if (sidebarKind(k) === kind && !out.includes(k)) out.push(k);
    }
  }
  return out;
}

/** 逐项过滤（去掉重复与坏键）但不补位 —— 落库用这个，别把"默认顺序"写死进设置 */
export function formatSidebarOrder(order: string[]): string {
  const clean = order.filter(
    (k, i) => sidebarKind(k) !== null && order.indexOf(k) === i,
  );
  return JSON.stringify(clean);
}

/** 上移（-1）/ 下移（+1）；到头了返回原数组，让调用方能直接拿结果落库 */
export function moveSidebarItem(order: string[], key: string, delta: number): string[] {
  const from = order.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * 拖拽落位：把 fromKey 插到 toKey 所在的位置。
 *
 * 用"插到目标位置"而不是"两两交换"，是因为拖三格其实就是连续交换三次，
 * 中间每一次都落库的话会写三条设置、侧栏也会跟着抖三下。
 * （与 detailSections 的同名函数同一个理由。）
 */
export function placeSidebarItem(
  order: string[],
  fromKey: string,
  toKey: string,
): string[] {
  const from = order.indexOf(fromKey);
  const to = order.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, fromKey);
  return next;
}
