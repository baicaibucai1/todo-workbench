/**
 * 面板宽度把手：左右两侧共用，保证手感与视觉一致。
 *
 * 之前右侧面板其实已经能拖，但把手是一条 5px 的**透明**线 ——
 * 不 hover 就完全看不见，用户只会以为"这个面板宽度是死的"。
 * 所以它现在有三重提示：
 *   1. 常驻一条极淡的竖线，让边界可被看见；
 *   2. hover 变蓝并浮出中间的抓握条；
 *   3. 拖动时显示当前宽度，松手即隐。
 */

import type { DragWidthApi } from "../lib/useDragWidth";

const ACCENT = "#378add";

export default function ResizeHandle({
  api,
  side,
  resizerKey,
  label,
}: {
  api: DragWidthApi;
  /** 把手贴在面板的哪一侧 */
  side: "left" | "right";
  /** 自动化用的标识：detail / sidebar */
  resizerKey: "detail" | "sidebar";
  label: string;
}) {
  const { width, dragging, onResizeStart, nudge, reset } = api;
  // 面板贴右边时，左方向键是"变宽"；贴左边时相反
  const widenKey = side === "left" ? "ArrowLeft" : "ArrowRight";
  const narrowKey = side === "left" ? "ArrowRight" : "ArrowLeft";

  return (
    <div
      onPointerDown={onResizeStart}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        if (e.key === widenKey) {
          e.preventDefault();
          nudge(16);
        } else if (e.key === narrowKey) {
          e.preventDefault();
          nudge(-16);
        } else if (e.key === "Enter") {
          e.preventDefault();
          reset();
        }
      }}
      data-resizer={resizerKey}
      data-detail-resizer={resizerKey === "detail" ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      title={`拖动调整宽度（双击复位，当前 ${width}px）`}
      className={`group absolute inset-y-0 z-20 w-2 cursor-col-resize outline-none ${
        side === "left" ? "left-0" : "right-0"
      }`}
    >
      {/* 边界线：常驻极淡，hover / 拖动时点亮 */}
      <span
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors ${
          dragging ? "" : "bg-line/60 group-hover:bg-transparent"
        }`}
        style={dragging ? { background: ACCENT } : undefined}
      />
      {/* 抓握条：只在 hover / 拖动时出现，负责"这里可以拖"的第一眼提示 */}
      <span
        className={`pointer-events-none absolute top-1/2 left-1/2 h-8 w-[4px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity ${
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        style={{ background: ACCENT }}
      />
      {/* 拖动时的宽度读数。溢出把手显示，不能让 8px 的命中区把它裁掉 */}
      {dragging && (
        <span
          data-resizer-readout=""
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-[#378add] px-1.5 py-0.5 text-[10px] leading-none text-white shadow"
        >
          {width} px
        </span>
      )}
    </div>
  );
}
