/**
 * 面板宽度的"可拖 + 持久化"逻辑，左右两侧共用。
 *
 * 之所以要抽出来：侧边栏（把手在右缘，往右拖变宽）和右侧详情面板
 * （把手在左缘，往左拖变宽）方向正好相反，各写一遍必然漂移 ——
 * 一侧修了边界、另一侧没修，是最难发现的那类 bug。
 *
 * 只在**松手时**落库：拖一次会触发上百次 pointermove，
 * 每次都写设置就是上百次数据库写，而中间值对用户毫无意义。
 */

import { useCallback, useRef, useState } from "react";

export type DragEdge = "left" | "right";

export interface UseDragWidthOptions {
  /** 已夹到边界内的持久值（来自设置表） */
  storedWidth: number;
  min: number;
  max: number;
  /** 默认值，双击把手复位用 */
  defaultWidth: number;
  /** 把手在面板的哪一侧。left = 面板贴窗口右边（往左拖变宽），right = 面板贴左边 */
  edge: DragEdge;
  /** 松手/键盘调整后落库 */
  onCommit: (width: number) => void;
}

export interface DragWidthApi {
  width: number;
  dragging: boolean;
  /** 绑到把手的 onPointerDown */
  onResizeStart: (e: React.PointerEvent) => void;
  /** 键盘微调（把手聚焦后按方向键），delta 为正 = 变宽 */
  nudge: (delta: number) => void;
  /** 双击复位到默认宽度 */
  reset: () => void;
}

export function useDragWidth(o: UseDragWidthOptions): DragWidthApi {
  const { storedWidth, min, max, defaultWidth, edge, onCommit } = o;

  // 拖拽期间用本地值接管，松手才落库
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? storedWidth;

  // 事件回调里要读"当前拖到多宽"。用 ref 而不是在 setState 的更新函数里
  // 顺带落库：更新函数必须是纯的，StrictMode 下会被调用两次，会写两遍。
  const widthRef = useRef(width);
  widthRef.current = width;

  const clamp = useCallback(
    (n: number) => Math.min(max, Math.max(min, Math.round(n))),
    [min, max],
  );

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      // 只接左键：右键/中键不该触发拖动
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);

      // 面板在右边时，光标左移才是变宽；面板在左边时相反
      const dir = edge === "left" ? -1 : 1;

      const move = (ev: PointerEvent) => {
        const next = clamp(startWidth + (ev.clientX - startX) * dir);
        widthRef.current = next;
        setDragWidth(next);
      };
      const up = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        onCommit(widthRef.current);
        setDragWidth(null);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [clamp, edge, onCommit],
  );

  const nudge = useCallback(
    (delta: number) => {
      const next = clamp((dragWidth ?? storedWidth) + delta);
      setDragWidth(next);
      onCommit(next);
    },
    [clamp, dragWidth, storedWidth, onCommit],
  );

  const reset = useCallback(() => {
    setDragWidth(null);
    onCommit(defaultWidth);
  }, [defaultWidth, onCommit]);

  return { width, dragging: dragWidth !== null, onResizeStart, nudge, reset };
}
