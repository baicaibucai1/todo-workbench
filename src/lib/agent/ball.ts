/**
 * 助手悬浮球的落点计算。
 *
 * ------------------------------------------------------------------
 * 为什么这段几何要单独成文件
 * ------------------------------------------------------------------
 * 它只有几行，但三个容易写错的地方最后都表现为同一个症状 ——
 * **"球不见了"**，而且没有任何报错可查：
 *
 *   ① 默认落点不能写死像素。不同屏幕的右下角不是同一个坐标，写死一个
 *      `x: 1800` 在 1366 的笔记本上就是屏幕外。
 *   ② 拖动后存下来的坐标必须**夹回当前视口**。把球拖到最右边的人，
 *      换台小屏打开时那个 x 已经在视口外，球就渲染到看不见的地方去了 ——
 *      而用户只会觉得"助手没了"。
 *   ③ 左上角已经有一个常驻的「显示侧边栏」悬浮钮（侧栏收起时出现，
 *      见 App.tsx）。所以默认落点选**右下角**，从位置上避开它。
 *
 * 把它单独放一个模块而不是写进组件里，是为了让"落点算得对不对"
 * 与 React 的渲染、指针事件无关 —— 测试可以直接喂一组视口尺寸进去。
 */

import { parseBallPos } from "../settings";

/** 球的直径（px）。48 是能一眼看见、又不至于挡住内容的大小 */
export const BALL_SIZE = 48;

/** 默认落点离视口右下角留多少（px） */
export const BALL_GAP = 20;

/** 拖动时离视口边缘至少留这么多，免得贴着边点不中 */
const EDGE = 8;

/**
 * 按下到松手的位移小于这个值就算**点击**。
 *
 * 不能判"位移为 0"：手在鼠标上总有抖动，真机上全按 0 判的话，
 * 十次有三次点不开窗口 —— 而这正是那种"用户会以为自己没点中"
 * 却最难复现的毛病。
 */
export const DRAG_SLOP = 4;

export interface BallViewport {
  w: number;
  h: number;
}

export interface BallPos {
  x: number;
  y: number;
}

/** 默认落点：右下角 */
export function defaultBallPos(vp: BallViewport): BallPos {
  return {
    x: Math.max(EDGE, vp.w - BALL_SIZE - BALL_GAP),
    y: Math.max(EDGE, vp.h - BALL_SIZE - BALL_GAP),
  };
}

/**
 * 把任意坐标夹进视口。
 *
 * 视口比球还小时（极端窄的窗口）不能算出负数，否则球会被渲染到左上角之外 ——
 * 所以上下界都过一遍 max(EDGE, …)。
 */
export function clampBallPos(pos: BallPos, vp: BallViewport): BallPos {
  const maxX = Math.max(EDGE, vp.w - BALL_SIZE - EDGE);
  const maxY = Math.max(EDGE, vp.h - BALL_SIZE - EDGE);
  return {
    x: Math.min(maxX, Math.max(EDGE, Math.round(pos.x))),
    y: Math.min(maxY, Math.max(EDGE, Math.round(pos.y))),
  };
}

/** 落库用的字符串形式（见 SETTINGS.agentBallPos） */
export function formatBallPos(pos: BallPos): string {
  return `${Math.round(pos.x)},${Math.round(pos.y)}`;
}

/**
 * 把坐标**吸附到最近的一条边**。
 *
 * ------------------------------------------------------------------
 * 为什么球必须贴边（2026-09-24 用户要求）
 * ------------------------------------------------------------------
 * 球可以拖到任意位置，随之而来的问题是：它很容易停在屏幕中间某块
 * 你正要看的内容上。一个能随手乱放的球，最后一定会挡住点什么 ——
 * 而用户每次都得先把它挪开才能看那块内容，等于这个"方便"的东西
 * 反倒成了路上唯一的石头。
 *
 * 所以松手时把它吸到**最近的那条边**：
 *
 *   · 只有离得最近的那一个轴被吸附，另一个轴保持原样 ——
 *     把球扔到屏幕上半部、横向偏左，它应该停在"上边偏左"，
 *     而不是被拽到左上角去。改两个轴的话，用户会觉得没拖准。
 *   · 边距用 BALL_GAP，跟默认落点一致。吸附完的右下角正好是默认值，
 *     "我没动过它"和"我把它拖回了右下角"是同一个坐标。
 *   · 这也是 `resolveBallPos` 要走一遍 snapping 的原因 —— 老版本存下来的
 *     坐标可能停在屏幕中间，读出来就得顺手理到边上，否则用户重启之后
 *     发现球还在挡着他要看的东西。
 */
export function snapBallPos(pos: BallPos, vp: BallViewport): BallPos {
  const p = clampBallPos(pos, vp);
  const gaps = {
    left: p.x - EDGE,
    right: vp.w - BALL_SIZE - p.x - EDGE,
    top: p.y - EDGE,
    bottom: vp.h - BALL_SIZE - p.y - EDGE,
  };
  const nearest = (Object.keys(gaps) as Array<keyof typeof gaps>).reduce((a, b) =>
    gaps[b] < gaps[a] ? b : a,
  );
  if (nearest === "left") return clampBallPos({ x: BALL_GAP, y: p.y }, vp);
  if (nearest === "right") return clampBallPos({ x: vp.w - BALL_SIZE - BALL_GAP, y: p.y }, vp);
  if (nearest === "top") return clampBallPos({ x: p.x, y: BALL_GAP }, vp);
  return clampBallPos({ x: p.x, y: vp.h - BALL_SIZE - BALL_GAP }, vp);
}

/**
 * 从设置里读到的字符串 → 当前视口下的可用落点。
 *
 * 没设过、值被手改坏、或者算出来的位置已经在视口外，都会回落到默认落点 ——
 * 这三种情况对用户是同一件事："我没动过它，它就在右下角"。
 */
export function resolveBallPos(raw: string | undefined, vp: BallViewport): BallPos {
  const parsed = parseBallPos(raw);
  return snapBallPos(parsed ?? defaultBallPos(vp), vp);
}
