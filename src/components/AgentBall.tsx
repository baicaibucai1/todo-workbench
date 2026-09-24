/**
 * AI 助手的入口：一颗能拖动的悬浮球。
 *
 * ------------------------------------------------------------------
 * 为什么入口只剩这颗球
 * ------------------------------------------------------------------
 * 助手是**随手要用**的东西：看到一条待办想让它排个期、写工具写到一半想问问
 * 参数怎么写。而"侧栏 → 点 AI 助手 → 说完 → 再点回来"这条路，在真的用起来
 * 之后明显太长 —— 尤其是它现在会浮在界面上，不再需要用户离开当前这一屏。
 *
 * 于是 2026-09-23 先把入口搬到了这颗球上；同一天用户又要求把侧栏里的那一项
 * **整个去掉** —— 两个入口做同一件事的时候，用户先得猜哪个才是"真的"，
 * 高亮态还得分神去跟窗口的开合。现在球是**唯一**入口：侧栏里没有「AI 助手」，
 * 也不该再加回来（e2e 里有一条"侧栏里没有助手入口"的断言盯着这件事）。
 *
 * 拖动是必须的，不是装饰：球固定待在一个角上的话，它迟早会压住某块
 * 你正要看的内容（紧急区就在右下角）。**落点存 settings、松手才落库** ——
 * 拖动过程中每移一像素写一次库，是拿磁盘 I/O 换一个没人看得见的中间态。
 *
 * ------------------------------------------------------------------
 * 拖动与点击怎么区分
 * ------------------------------------------------------------------
 * 用手指或鼠标按住再松开，总会有几像素的抖动。判"位移必须为 0 才算点击"
 * 的话，十次里有三次点不开窗口 —— 而这正是那种"用户以为自己没点中"
 * 却没法复现的毛病。所以位移小于 DRAG_SLOP 一律算点击（见 lib/agent/ball.ts）。
 *
 * ------------------------------------------------------------------
 * 松手要贴边
 * ------------------------------------------------------------------
 * 拖动过程中球**跟着手指走**（不然没有"跟手"的感觉），松手那一刻才吸附到
 * 最近的边（2026-09-24 用户要求"小球必须贴边"）。中间的这段滑动用 CSS
 * 过渡补上松手后的位移，否则球会瞬移过去，看着像掉帧。
 * ⚠️ 过渡只在**没在拖**的时候开 —— 开着过渡拖动的话，球会一路追着光标跑，
 *    手感像延迟半秒的远程桌面。
 *
 * 选择器：`data-agent-ball` / `-open` / `-busy` / `-dragging`（自动化验证用）。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bot, Loader2, X } from "lucide-react";
import { useStore } from "../store";
import * as runtime from "../lib/agent/runtime";
import {
  BALL_SIZE,
  DRAG_SLOP,
  clampBallPos,
  formatBallPos,
  resolveBallPos,
  snapBallPos,
  type BallPos,
} from "../lib/agent/ball";
import { SETTINGS } from "../lib/settings";

/** 当前视口尺寸。抽出来是因为它每次都要现算 —— 绝不能缓存 */
function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

export default function AgentBall() {
  const agentOpen = useStore((s) => s.agentOpen);
  const toggleAgent = useStore((s) => s.toggleAgent);
  const saveSettings = useStore((s) => s.saveSettings);
  const rawPos = useStore((s) => s.settings[SETTINGS.agentBallPos]);

  // 它在不在干活必须能从球上看出来：窗口关掉之后它是唯一的指示，
  // 而"助手在后台跑着"和"助手什么都没做"对用户是两种完全不同的等待
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);

  const [pos, setPos] = useState<BallPos>(() => resolveBallPos(rawPos, viewport()));
  const [dragging, setDragging] = useState(false);
  /** 按下时的落点，用来算"这是点击还是拖动" */
  const down = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  /**
   * 设置里那个值变了就重算落点。
   *
   * ⚠️ 不能写成"每次渲染都重算"：拖动过程中我们自己就是这个值的来源，
   * 松手落库 → settings 一变 → 球被弹回旧位置，表现是"拖动完全没反应"。
   * 只跟着 rawPos 走，落库值与内存值一致时不会产生跳动。
   */
  useEffect(() => {
    setPos(resolveBallPos(rawPos, viewport()));
  }, [rawPos]);

  // 窗口变小（比如从外接屏拔下来的笔记本）时把球夹回视口内 ——
  // 少了这一步，球会停在屏幕外，用户看到的是"助手不见了"。
  // 顺手连吸附一起做：变小之后原来靠边的那个边可能已经不是最近的边了
  useEffect(() => {
    const onResize = () => setPos((p) => snapBallPos(p, viewport()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // 只接主键：右键/中键按在球上不该把它拖走（那是别处的菜单手势）
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    down.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = down.current;
    if (!d) return;
    setPos(clampBallPos({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }, viewport()));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = down.current;
    down.current = null;
    setDragging(false);
    if (!d) return;

    const moved = Math.hypot(e.clientX - d.px, e.clientY - d.py);
    if (moved < DRAG_SLOP) {
      // 没挪动 = 点击：开关窗口。**不写库** —— 点一下也算"改过位置"
      // 的话，用户永远等不到"我没有动过它"的默认落点
      toggleAgent();
      return;
    }
    // 拖的过程中不吸附（球要跟手），松手才吸到最近的边
    const landed = snapBallPos({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }, viewport());
    setPos(landed);
    void saveSettings({ [SETTINGS.agentBallPos]: formatBallPos(landed) });
  };

  /** 拖动中途被系统打断（来电、切窗口）也要把 dragging 放掉，否则球会卡在"按住"的样子 */
  const onPointerCancel = () => {
    down.current = null;
    setDragging(false);
  };

  return (
    <button
      data-agent-ball=""
      data-agent-ball-open={agentOpen ? "1" : "0"}
      data-agent-ball-busy={state.busy ? "1" : "0"}
      data-agent-ball-dragging={dragging ? "1" : "0"}
      style={{ left: pos.x, top: pos.y, width: BALL_SIZE, height: BALL_SIZE }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => {
        // 键盘用户也要能开：球是可聚焦的按钮，Enter/Space 走同一条路
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleAgent();
        }
      }}
      title={agentOpen ? "收起 AI 助手（Esc）" : "打开 AI 助手（可以拖到顺手的位置）"}
      aria-label={agentOpen ? "收起 AI 助手" : "打开 AI 助手"}
      className={`fixed z-50 grid touch-none place-items-center rounded-full shadow-[0_4px_16px_rgba(0,0,0,0.22)] transition-colors ${
        dragging ? "cursor-grabbing" : "cursor-grab transition-[left,top] duration-200 ease-out"
      } ${
        agentOpen
          ? "border border-line bg-panel text-fg-2 hover:bg-hover"
          : "bg-accent text-white hover:opacity-90"
      }`}
    >
      {agentOpen ? <X size={18} /> : <Bot size={20} />}
      {/* 忙着的时候套一圈转动的弧，用户切走去干别的也能看见它在干活 */}
      {state.busy && (
        <span
          data-agent-ball-spin=""
          className="pointer-events-none absolute inset-0 grid place-items-center"
        >
          <Loader2 size={BALL_SIZE - 4} className="animate-spin text-white/45" />
        </span>
      )}
    </button>
  );
}
