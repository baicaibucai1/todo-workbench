/**
 * 助手**窗口**的落点计算（悬浮球的那一套在 ball.ts）。
 *
 * ------------------------------------------------------------------
 * 为什么要记住位置，而不是每次都在正中
 * ------------------------------------------------------------------
 * 窗口一开始是居中的（2026-09-23），但"居中"和"我把它放哪儿"是两件事：
 * 每次打开都回到屏幕正中，意味着用户把它挪开等于白挪一次。而助手窗口是
 * **遮住主界面的** —— 它压住哪一块，取决于当时正在看什么。所以这个位置
 * 得由用户决定，并且记下来（2026-09-24 用户要求："默认应该是上次关闭的位置"）。
 *
 * 记多久？永久 —— 它跟"落点在右下还是左下"一样是习惯，不是临时状态。
 * 存在 core_settings 里而不是内存里，重启之后还在原地。
 *
 * ------------------------------------------------------------------
 * 首次打开为什么是左下方
 * ------------------------------------------------------------------
 * 用户定的默认值。它有两个额外好处：
 *
 *   ① **不压紧急区**。紧急区贴在右下角，窗口放左下就避开了它 ——
 *      这也是悬浮球默认在**右下**的原因被改写的那一处权衡：两者分居两角，
 *      谁也不挡谁。
 *   ② 左侧留着侧边栏，窗口左沿贴边时会压住侧边栏。所以留 WINDOW_GAP 的边距，
 *      而不是真的贴到 x=0 —— 侧栏被盖住的话，用户想切个视图得先把窗口挪开。
 *
 * ------------------------------------------------------------------
 * 尺寸为什么还有一份 estimate 副本
 * ------------------------------------------------------------------
 * 尺寸是 CSS 决定的（`w-[min(1000px,78vw)]` + `h-[calc(100vh_-_24px)]
 * max-h-[820px]`），而**首次**计算默认落点时元素还没量出来。
 * 于是这里照着 CSS 抄一份估算值，挂载后再用真实尺寸覆盖。
 * ⚠️ 改 AgentWindow 那两个类的时候，必须同步改 `estimateWindowSize`。
 */

export interface WindowSize {
  w: number;
  h: number;
}

export interface WindowPos {
  x: number;
  y: number;
}

export interface WindowViewport {
  w: number;
  h: number;
}

/** 离视口边缘留多少（px）。见上面 ②：不能贴死，否则压住侧边栏 */
export const WINDOW_GAP = 12;

/** 按下到松手的位移小于这个值就算**点击**（贴在另一个 Buttons 上的那一层） */
export const WINDOW_DRAG_SLOP = 4;

/**
 * 照 CSS 估一份尺寸。
 *
 * 只在"元素还没挂载"的那一次用到；挂载后 `AgentWindow` 会用
 * `offsetWidth / offsetHeight` 覆盖。⚠️ 与 AgentWindow 的 className 同步。
 */
export function estimateWindowSize(vp: WindowViewport): WindowSize {
  return {
    w: Math.min(1000, Math.round(vp.w * 0.78)),
    h: Math.min(Math.max(vp.h - 24, 240), 820),
  };
}

/** 首开默认：左下角 */
export function defaultWindowPos(vp: WindowViewport, size: WindowSize): WindowPos {
  return {
    x: WINDOW_GAP,
    y: Math.max(WINDOW_GAP, vp.h - WINDOW_GAP - size.h),
  };
}

/**
 * 把窗口夹进视口。
 *
 * ⚠️ 下界是 `WINDOW_GAP` 而不是 0：窗口的**拖动把手在它的头部**，
 * 一旦头部被顶到视口外，用户就再也拽不回来了（只能清空设置） ——
 * 那属于"把用户锁死在自己没法修的状态里"。
 * 上界用 `Math.max(WINDOW_GAP, …)`：窗口比视口还大的时候（窄屏），
 * `vp.w - size.w - GAP` 会算出负数，不夹一下窗口整个跑到左上角外面去。
 */
export function clampWindowPos(pos: WindowPos, vp: WindowViewport, size: WindowSize): WindowPos {
  const maxX = Math.max(WINDOW_GAP, vp.w - size.w - WINDOW_GAP);
  const maxY = Math.max(WINDOW_GAP, vp.h - size.h - WINDOW_GAP);
  return {
    x: Math.min(maxX, Math.max(WINDOW_GAP, Math.round(pos.x))),
    y: Math.min(maxY, Math.max(WINDOW_GAP, Math.round(pos.y))),
  };
}

/** 存库用的字符串形式（见 SETTINGS.agentWindowPos） */
export function formatWindowPos(pos: WindowPos): string {
  return `${Math.round(pos.x)},${Math.round(pos.y)}`;
}

/** 从设置里读到的字符串 → 当前视口下的可用落点 */
export function resolveWindowPos(
  raw: string | undefined,
  vp: WindowViewport,
  size: WindowSize,
): WindowPos {
  const m = /^(-?\d+),(-?\d+)$/.exec((raw ?? "").trim());
  const parsed = m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  const ok = parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y);
  return clampWindowPos(ok ? (parsed as WindowPos) : defaultWindowPos(vp, size), vp, size);
}
