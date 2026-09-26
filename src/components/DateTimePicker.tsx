/**
 * 自绘的日期 / 日期时间选择器。
 *
 * 为什么不用 `<input type="date">` / `datetime-local`：那个弹层是浏览器自带的，
 * 长相完全不归我们管 —— 在 WebView2 里弹出来的是一块原生日历，配色、字号、
 * 间距都跟工作台对不上（连月份标题的字重都是系统默认），而且它只认英文月份
 * 的排布习惯。更麻烦的是它的宽度、层级、定位都不受控，想让它跟右侧详情面板
 * 对齐都做不到。
 *
 * ## 两条硬约束（改这个文件前先读）
 *
 * 1. **保底输入框必须留着，而且必须是可编辑的 `<input>`**。
 *    e2e 是直接往里 `fill("2026-09-01T09:00")` 的，括选择器
 *    `[data-reminder-input]` / `[data-order-due-input]`。换成只读按钮或纯自绘
 *    面板，这套契约立刻就断。所以这里的做法是"输入框照旧、旁边挂一个选择器"，
 *    而不是"用一个自绘控件取代输入框"。
 * 2. **浮层必须 portal 到 body，并用 position: fixed**。
 *    详情面板是 `overflow-hidden`，里面还有一层 `overflow-y-auto` 的滚动区，
 *    芯片卡片自己也是 `overflow-hidden` —— 就地渲染的浮层会被三层裁切
 *    （底部被切、横向被切、滚动时错位）。所以位置在打开那一刻用
 *    getBoundingClientRect 算出来，再 fixed 定位。
 *
 * ## 日期串的两种形态（别混）
 *
 * - 只要日期：`"YYYY-MM-DD"` —— 就是 `core_tasks.due_date` 存的东西，
 *   语义是"哪一天"，**没有时区概念**。绝不能拿 `new Date("2026-09-01")` 去解析，
 *   那会按 UTC 当午夜，在东八区退回到 8 月 31 号。
 * - 要日期时间：ISO 串 —— 存**绝对时刻**。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from "lucide-react";

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

const ACCENT = "var(--color-primary)";

/** 本地今天，YYYY-MM-DD */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" → 本地 Date（不要用 new Date(str)，那是 UTC） */
function parseDateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO 或本地串 → 本地 Date */
function parseAny(s: string): Date | null {
  if (!s) return null;
  // "2026-09-01T09:00" 这种没有时区的串，new Date 会按本地解析（要的就是这个）
  const d = new Date(s.includes("T") || s.includes(" ") ? s.replace(" ", "T") : `${s}T00:00`);
  if (!Number.isNaN(d.getTime())) return d;
  const d2 = new Date(s);
  return Number.isNaN(d2.getTime()) ? null : d2;
}

function toDateOnlyString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalInputString(d: Date): string {
  return `${toDateOnlyString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(d: Date): string {
  return d.toISOString();
}

export type DateTimePickerProps = {
  /** 当前值：date 模式是 "YYYY-MM-DD"，datetime 模式是 ISO 串 */
  value: string | null;
  onChange: (v: string | null) => void;
  /** "date" 只要哪一天；"datetime" 要精确到分 */
  mode: "date" | "datetime";
  /** 输入框上要挂的 data-* 契约（e2e 依赖，别删） */
  inputAttrs?: Record<string, string>;
  /** 快捷档位。datetime 用得多（"30 分钟后"），date 模式给"今天/明天" */
  presets?: Array<{ label: string; at: () => string | null }>;
  /** 面板靠哪边对齐 */
  align?: "left" | "right";
  /** 输入框的额外 class（各处的内边距、宽度不一样） */
  inputClassName?: string;
  onOpenChange?: (open: boolean) => void;
};

export default function DateTimePicker({
  value,
  onChange,
  mode,
  inputAttrs,
  presets,
  align = "left",
  inputClassName,
  onOpenChange,
}: DateTimePickerProps) {
  /** 输入框里正在显示的文字。允许它和 value 暂时不一致（用户打一半） */
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  /** 面板里正在看的是哪个月（与选中值解耦：翻月不该改值） */
  const [view, setView] = useState(() => new Date());
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * 光标是否还在输入框里。
   *
   * 有它才能两手都硬：既要「打字时值跟着走」（下面 commitText 逐次解析），
   * 又不能「把用户正在敲的字回灌掉」。少了这个开关，每落一次库都会从 value
   * 生成标准串写回输入框 —— 用户敲到 "2026-09-01T09:0" 的瞬间就被替换成
   * 上一次的完整值，光标还跳到末尾，等于边打字边被橡皮擦擦掉。
   */
  const editingRef = useRef(false);

  /** 外部 value 变了就同步到输入框（日期行被快捷按钮改掉、撤销等） */
  useEffect(() => {
    if (editingRef.current) return; // 正在打字，别回灌
    if (mode === "date") {
      setText(value ?? "");
    } else {
      const d = value ? new Date(value) : null;
      setText(d && !Number.isNaN(d.getTime()) ? toLocalInputString(d) : "");
    }
  }, [value, mode]);

  /** 打开时把视图挪到当前值所在的月份 */
  useEffect(() => {
    if (!open) return;
    const d = value ? parseAny(mode === "date" ? `${value}T00:00` : value) : null;
    setView(d ?? new Date());
  }, [open, value, mode]);

  /** 定位：算完再画，避免先出现在左上角再弹过去 */
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const calc = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      const W = 268;
      // 高度**量**出来，不写死：date 模式没有时刻行、datetime 有，
      // 而且不知哪天又加一行 —— 估错的后果是面板底边戳出窗口。
      const H = panelRef.current?.offsetHeight ?? (mode === "datetime" ? 400 : 330);
      // 右边放不下就往左靠，别让它溢出窗口
      let left = align === "right" ? a.right - W : a.left;
      left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
      // 下面放不下就翻到上面；上下都放不下时贴着视野内
      const below = a.bottom + 6;
      const fitsBelow = below + H <= window.innerHeight - 8;
      const top = fitsBelow ? below : Math.max(8, Math.min(a.top - H - 6, window.innerHeight - H - 8));
      setPos({ top, left });
    };
    calc();
    // 面板首帧还没量到高度（pos 为 null 时不渲染），量到后再校一次
    const raf = requestAnimationFrame(calc);
    // 窗口尺寸变了要重算；滚动则直接关掉 —— 跟着滚会闪，关掉更利索
    const onResize = () => calc();
    const onScroll = () => setOpen(false);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, align, mode]);

  /** 点外面 / 按 Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  /** 输入框里的字 → 值。只有解析得出来才往外写，免得用户打一半就被写成空 */
  const commitText = (raw: string) => {
    if (raw.trim() === "") {
      onChange(null);
      return;
    }
    const d = parseAny(raw);
    if (!d) return; // 认不出来就先不动 value，等他把字打完
    onChange(mode === "date" ? toDateOnlyString(d) : toIso(d));
  };

  const selected = value ? (mode === "date" ? parseDateOnly(value) : parseAny(value)) : null;
  const todayStr = localToday();

  const applyDay = (d: Date) => {
    if (mode === "date") {
      onChange(toDateOnlyString(d));
      setOpen(false);
    } else {
      // 保留已选时刻；没选过就给个 09:00 —— 比 00:00 更像"人设的时间"
      const base = selected ?? new Date();
      const hasTime = !!selected;
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      next.setHours(hasTime ? base.getHours() : 9, hasTime ? base.getMinutes() : 0, 0, 0);
      onChange(toIso(next));
    }
  };

  const applyTime = (h: number, mi: number) => {
    const base = selected ?? new Date();
    const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, 0, 0);
    onChange(toIso(next));
  };

  return (
    <div ref={anchorRef} className="relative min-w-0">
      <div className="flex items-center gap-1">
        <input
          {...(inputAttrs ?? {})}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            commitText(e.target.value);
          }}
          onFocus={() => {
            // 只标"正在输入"，**不**顺手弹日历：用户点进来往往就是想直接打字，
            // 一个面板糊上来反而挡路（而且会盖住下方内容）。日历由右侧按钮开。
            editingRef.current = true;
          }}
          onBlur={() => {
            // 失焦时补一次同步：把用户打的松散写法（"2026/9/1 9:00"）规整成标准串
            editingRef.current = false;
            const d = value ? (mode === "date" ? parseDateOnly(value) : parseAny(value)) : null;
            if (mode === "date") {
              setText(value ?? "");
            } else {
              setText(d ? toLocalInputString(d) : "");
            }
          }}
          placeholder={mode === "date" ? "年/月/日" : "年/月/日 时:分"}
          className={
            inputClassName ??
            "min-w-0 flex-1 rounded px-1.5 py-0.5 text-[12.5px] text-fg-3 outline-none hover:bg-hover focus:bg-hover"
          }
        />
        <button
          type="button"
          data-dtp-toggle=""
          onClick={() => setOpen(!open)}
          title="打开日历"
          className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover"
        >
          {mode === "date" ? <CalendarDays size={13} /> : <Clock size={13} />}
        </button>
      </div>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            data-dtp-panel=""
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: 268,
              // 首帧还没量到位置：先画在视野外（要能测到真实高度，所以不能 display:none），
              // 下一帧 calc() 量完高度再挪进来。这样不会出现"先闪一下再跳位"。
              visibility: pos ? "visible" : "hidden",
            }}
            className="fixed z-50 animate-slide-down rounded-lg border border-line bg-card p-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
          >
            {/* 月份导航 */}
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                data-dtp-prev=""
                onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
                className="grid size-6 place-items-center rounded text-fg-3 hover:bg-hover"
              >
                <ChevronLeft size={14} />
              </button>
              <div className="flex items-center gap-2">
                <span data-dtp-title="" className="text-[13px] font-medium text-fg">
                  {view.getFullYear()}年{pad(view.getMonth() + 1)}月
                </span>
                {/* ↑↓ 翻月：原生控件里就是这个手势，保留下来 */}
                <div className="flex gap-0.5">
                  <button
                    type="button"
                    onClick={() => setView(new Date(view.getFullYear() - 1, view.getMonth(), 1))}
                    className="grid size-5 place-items-center rounded text-fg-dim hover:bg-hover"
                    title="上一年"
                  >
                    <ChevronLeft size={11} className="-rotate-90" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setView(new Date(view.getFullYear() + 1, view.getMonth(), 1))}
                    className="grid size-5 place-items-center rounded text-fg-dim hover:bg-hover"
                    title="下一年"
                  >
                    <ChevronRight size={11} className="-rotate-90" />
                  </button>
                </div>
              </div>
              <button
                type="button"
                data-dtp-next=""
                onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
                className="grid size-6 place-items-center rounded text-fg-3 hover:bg-hover"
              >
                <ChevronRight size={14} />
              </button>
            </div>

            {/* 星期表头：周一开头，跟中文习惯一致 */}
            <div className="grid grid-cols-7 gap-0.5">
              {WEEK_LABELS.map((w) => (
                <div key={w} className="grid h-6 place-items-center text-[11px] text-fg-dim">
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {buildGrid(view).map((cell) => {
                const isSel = selected && toDateOnlyString(cell.date) === toDateOnlyString(selected);
                const isToday = toDateOnlyString(cell.date) === todayStr;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    data-dtp-day={toDateOnlyString(cell.date)}
                    onClick={() => applyDay(cell.date)}
                    className={`grid h-7 place-items-center rounded text-[12.5px] transition-colors ${
                      isSel
                        ? "text-white"
                        : cell.outside
                          ? "text-fg-dim/50 hover:bg-hover"
                          : "text-fg-2 hover:bg-hover"
                    }`}
                    style={isSel ? { background: ACCENT } : undefined}
                  >
                    <span
                      className={
                        !isSel && isToday
                          ? "grid size-5 place-items-center rounded-full ring-1 ring-line"
                          : undefined
                      }
                    >
                      {cell.date.getDate()}
                    </span>
                  </button>
                );
              })}
            </div>

            {mode === "datetime" && (
              <div className="mt-2 border-t border-line pt-2">
                <div className="mb-1.5 text-[11px] text-fg-dim">时刻</div>
                <div className="flex items-center gap-1.5">
                  <TimeSelect
                    dataAttr="data-dtp-hour"
                    value={selected ? selected.getHours() : 9}
                    max={23}
                    onChange={(h) => applyTime(h, selected ? selected.getMinutes() : 0)}
                  />
                  <span className="text-fg-dim">:</span>
                  <TimeSelect
                    dataAttr="data-dtp-minute"
                    value={selected ? selected.getMinutes() : 0}
                    max={59}
                    step={1}
                    onChange={(mi) => applyTime(selected ? selected.getHours() : 9, mi)}
                  />
                  <div className="ml-auto flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        const d = new Date();
                        onChange(toIso(d));
                        setView(d);
                      }}
                      className="rounded px-1.5 py-1 text-[11.5px] text-fg-3 hover:bg-hover"
                    >
                      此刻
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!selected) return;
                        const d = new Date(selected);
                        d.setMinutes(0, 0, 0);
                        onChange(toIso(d));
                      }}
                      className="rounded px-1.5 py-1 text-[11.5px] text-fg-3 hover:bg-hover"
                    >
                      整点
                    </button>
                  </div>
                </div>
              </div>
            )}

            {presets && presets.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 border-t border-line pt-2">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    data-dtp-preset={p.label}
                    onClick={() => {
                      onChange(p.at());
                      setOpen(false);
                    }}
                    className="rounded border border-line px-1.5 py-1 text-[11.5px] text-fg-3 hover:bg-hover"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
              <button
                type="button"
                data-dtp-clear=""
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="rounded px-1.5 py-1 text-[11.5px] text-fg-dim hover:bg-hover"
              >
                清除
              </button>
              <button
                type="button"
                data-dtp-today=""
                onClick={() => {
                  applyDay(new Date());
                  if (mode === "date") setOpen(false);
                }}
                className="flex items-center gap-0.5 rounded px-1.5 py-1 text-[11.5px]"
                style={{ color: ACCENT }}
              >
                今天
                <X size={0} className="hidden" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 时 / 分下拉。整点那栏是数字，不是圆点，好认。 */
function TimeSelect({
  value,
  max,
  step = 1,
  onChange,
  dataAttr,
}: {
  value: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  dataAttr: string;
}) {
  const opts: number[] = [];
  for (let i = 0; i <= max; i += step) opts.push(i);
  // 当前值不在档位里时补进去，否则 select 会默默落到第一项 ——
  // 用户只是点开看一眼，值就被改掉了。
  if (!opts.includes(value)) {
    opts.push(value);
    opts.sort((a, b) => a - b);
  }
  return (
    <select
      {...{ [dataAttr]: "" }}
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded border border-line bg-card px-1.5 py-1 text-[12.5px] text-fg-2 outline-none hover:bg-hover"
    >
      {opts.map((n) => (
        <option key={n} value={n}>
          {pad(n)}
        </option>
      ))}
    </select>
  );
}

type Cell = { key: string; date: Date; outside: boolean };

/** 6 行 × 7 列，含上/下月补白 —— 行数固定，切换月份时面板不会跳高度 */
function buildGrid(view: Date): Cell[] {
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  // getDay(): 0=周日 … 6=周六 → 换算成"周一开头"的列号
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - lead);

  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      key: toDateOnlyString(d),
      date: d,
      outside: d.getMonth() !== view.getMonth(),
    });
  }
  return cells;
}

export { localToday as dtpToday, toLocalInputString as dtpToLocalInput };