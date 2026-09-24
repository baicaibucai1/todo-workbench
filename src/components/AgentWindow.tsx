/**
 * AI 助手的窗口。
 *
 * ------------------------------------------------------------------
 * 窗口居中，但**不铺满、也不加全屏遮罩**
 * ------------------------------------------------------------------
 * 初版是"和待办平级的一个视图"。改成浮层（2026-09-23 用户要求悬浮球 +
 * 点击开窗）之后，最容易顺手做成"模态对话框"—— 一层黑遮罩盖住整个应用。
 * 但助手要干的活是慢活：写一份 30 KB 的工具源码、装进去、再回来告诉你结果。
 * 遮罩意味着那段时间里用户什么都不能干，只能干等。
 *
 * ------------------------------------------------------------------
 * 位置：默认回到上次那一处，首次才落到左下
 * ------------------------------------------------------------------
 * 位置改过两版：先是靠右停靠，同一天改到**正中**（"AI 框应该显示在中间"）。
 * 2026-09-24 又改了一次 —— "默认应该是上次关闭的位置，第一次打开则在左下方"。
 * 理由是站得住的：窗口**盖在主界面上**，它压住哪一块取决于当时正在看什么，
 * 这个位置只能由用户决定；每次都回到正中，把它挪开就等于白挪一次。
 *
 * 于是窗口头部成了拖动把手（几何与"为什么下界不许是 0"见 windowGeom.ts），
 * 落点存 `agent.windowPos`，**松手才落库**。
 *
 * 但"不铺满、不加全屏遮罩"这条从**第一版到现在都没动过**：窗口比视口小一圈，
 * 四边都露着主界面，它干活的时候照样能翻待办、看紧急区。
 * 这也是把窗口做成"可以不管它"而不是"必须回应它"的原因 ——
 * Esc、球、头部 × 三个口子都能收起来，收起来不打断正在跑的那一轮。
 *
 * ------------------------------------------------------------------
 * 右侧那一栏是历史对话
 * ------------------------------------------------------------------
 * 它回答的是"我上次说到哪儿了"。旧的「新对话」是**清空**语义 ——
 * 按下去会抹掉上一段，于是用户不敢按（见 runtime.newChat 的说明）。
 * 现在是多会话：新建只是新开一段，旧的留在这一栏里，两段之间点一下就切。
 *
 * 选择器：`data-agent-window` / `data-agent-chats` / `data-agent-chat` /
 * `-chat-active` / `-chat-new` / `-chat-delete` / `-chat-confirm` /
 * `data-agent-window-drag`（拖动把手） / `-dragging`。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, History, Plus, Trash2 } from "lucide-react";
import { useStore } from "../store";
import AgentView from "./AgentView";
import * as runtime from "../lib/agent/runtime";
import { SETTINGS } from "../lib/settings";
import {
  WINDOW_DRAG_SLOP,
  clampWindowPos,
  defaultWindowPos,
  estimateWindowSize,
  formatWindowPos,
  resolveWindowPos,
  type WindowPos,
  type WindowSize,
} from "../lib/agent/windowGeom";

/** 当前视口尺寸。抽出来是因为它每次都要现算 —— 绝不能缓存 */
function viewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

export default function AgentWindow() {
  const agentOpen = useStore((s) => s.agentOpen);
  const closeAgent = useStore((s) => s.closeAgent);
  const saveSettings = useStore((s) => s.saveSettings);
  const rawWinPos = useStore((s) => s.settings[SETTINGS.agentWindowPos]);

  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<WindowSize>(() => estimateWindowSize(viewport()));
  const [pos, setPos] = useState<WindowPos>(() => defaultWindowPos(viewport(), estimateWindowSize(viewport())));
  const [dragging, setDragging] = useState(false);

  /*
   * 挂载（以及视口变化）之后换成**真实**尺寸。
   *
   * 用 useLayoutEffect 而不是 useEffect：估算值和真实值不一样的话，
   * 用 effect 会先画一帧在错位置上的窗口 —— 表现为打开瞬间闪一下。
   */
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = { w: el.offsetWidth, h: el.offsetHeight };
    setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
  }, []);

  useLayoutEffect(measure, [measure, agentOpen]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  /** 设置里的值或窗口尺寸变了，就把落点重算一遍（含"夹回视口"） */
  useEffect(() => {
    setPos(resolveWindowPos(rawWinPos, viewport(), size));
  }, [rawWinPos, size]);

  /**
   * 头部拖动。
   *
   * 只在 `data-agent-window-drag` 区域里起手，并且**排除按钮与输入框** ——
   * 否则点「新对话」或 × 会被当成一次 0 位移的拖动，按钮还得靠
   * "位移小于 slop 就不算拖动"兜住。两道都设才稳：把手标定 +
   * 交互元素豁免。
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.closest("[data-agent-window-drag]")) return;
    if (target.closest("button, input, textarea, select, a, [role='button']")) return;
    // 到这儿就确定是一次拖动起手了：挡掉默认行为，免得托标题栏顺手刷蓝一片正文
    e.preventDefault();

    const start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      // 超过 slop 才算真的在拖 —— 手抖的那几像素不该让窗口跟着跳
      if (!moved && Math.hypot(ev.clientX - start.px, ev.clientY - start.py) < WINDOW_DRAG_SLOP) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        // 拖动时别让光标把正文刷成蓝底
        document.body.classList.add("select-none");
      }
      setPos(clampWindowPos({ x: start.x + (ev.clientX - start.px), y: start.y + (ev.clientY - start.py) }, viewport(), size));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("select-none");
      setDragging(false);
      if (!moved) return;
      const landed = clampWindowPos(
        { x: start.x + (ev.clientX - start.px), y: start.y + (ev.clientY - start.py) },
        viewport(),
        size,
      );
      setPos(landed);
      void saveSettings({ [SETTINGS.agentWindowPos]: formatWindowPos(landed) });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Esc 收起窗口。只在开着的时候挂监听 —— 常挂着一个全局 keydown
  // 迟早会跟别处的 Esc（弹窗、编辑器）抢事件
  useEffect(() => {
    if (!agentOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAgent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentOpen, closeAgent]);

  if (!agentOpen) return null;

  return (
    <div
      ref={ref}
      data-agent-window="open"
      data-agent-window-dragging={dragging ? "1" : "0"}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      className={`fixed z-40 flex h-[calc(100vh_-_24px)] max-h-[820px] w-[min(1000px,78vw)] overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_8px_32px_rgba(0,0,0,0.28)] ${
        dragging ? "select-none" : ""
      }`}
    >
      {/* 左边：对话本身。窗口内部只管布局，对话的所有逻辑仍在 AgentView 里 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <AgentView onClose={closeAgent} />
      </div>
      <ChatHistory />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 右侧：历史对话                                                      */
/* ------------------------------------------------------------------ */

function ChatHistory() {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);
  /** 哪一项正在等第二次点击（删除是破坏性的，必须两段式） */
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // 换一段之后把确认态放掉：不然那一项的"确认删除？"会一直挂在那儿，
  // 下次回来随手一点就把对话删了
  useEffect(() => setConfirmId(null), [state.currentChatId]);

  return (
    <aside
      data-agent-chats=""
      className="flex w-[236px] shrink-0 flex-col border-l border-line bg-surface"
    >
      {/*
        这条也是拖动把手：窗口顶上一整条都能抓。按钮（那个「+」）由
        AgentWindow 的 pointerdown 豁免掉，点它不会拖着窗口走。
      */}
      <div
        data-agent-window-drag=""
        className="flex shrink-0 cursor-grab items-center gap-1.5 border-b border-line px-3 py-2.5 active:cursor-grabbing"
      >
        <History size={14} className="shrink-0 text-fg-dim" />
        <span className="text-[12.5px] font-medium text-fg">历史对话</span>
        <span className="text-[11px] text-fg-dim">{state.chats.length}</span>
        <div className="flex-1" />
        <button
          data-agent-chat-new=""
          onClick={() => void runtime.newChat()}
          title="开一段新对话（旧的会留在这一栏里）"
          className="grid size-6 place-items-center rounded-md text-fg-dim hover:bg-hover hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {state.chats.map((c) => {
          const active = c.id === state.currentChatId;
          const confirming = confirmId === c.id;
          return (
            <div
              key={c.id}
              data-agent-chat={c.id}
              data-agent-chat-active={active ? "1" : "0"}
              className={`group relative mb-1.5 rounded-lg border px-2.5 py-2 transition-colors ${
                active
                  ? "border-accent/40 bg-accent/8"
                  : "border-transparent hover:border-line hover:bg-card"
              }`}
            >
              <button
                onClick={() => void runtime.switchChat(c.id)}
                data-agent-chat-open=""
                className="block w-full text-left"
              >
                <span
                  className={`block truncate pr-5 text-[12.5px] ${active ? "font-medium text-fg" : "text-fg-2"}`}
                >
                  {c.title || "新对话"}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-fg-dim">
                  {c.preview || "还没有内容"}
                </span>
                <span className="mt-1 block text-[10.5px] text-fg-dim">
                  {chatTime(c.updatedAt)} · {c.messageCount} 条
                </span>
              </button>

              {/*
                删除按钮：当前这段常显，别的项悬停才出现。
                为什么要给当前项常显 —— 触屏和"懒得把鼠标挪过去"的时候，
                藏起来的按钮等于不存在；而这一段正是用户最可能想删的
                （刚开了一段不想要的）。
              */}
              <button
                data-agent-chat-delete={c.id}
                data-agent-chat-confirm={confirming ? "1" : "0"}
                onClick={() => {
                  if (confirming) {
                    setConfirmId(null);
                    void runtime.deleteChat(c.id);
                  } else {
                    setConfirmId(c.id);
                  }
                }}
                title={confirming ? "再点一次就删掉这一段" : "删掉这段对话"}
                className={`absolute top-1.5 right-1.5 grid size-5 place-items-center rounded transition-opacity ${
                  confirming
                    ? "bg-danger-soft text-danger opacity-100"
                    : "text-fg-dim hover:bg-hover hover:text-danger"
                } ${active || confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              >
                {confirming ? <Check size={12} /> : <Trash2 size={12} />}
              </button>
            </div>
          );
        })}
      </div>

      <p className="shrink-0 border-t border-line px-3 py-2 text-[10.5px] leading-relaxed text-fg-dim">
        历史上的每一段都留着。点「+」新开一段，不会动到旧的那些。
      </p>
    </aside>
  );
}

/**
 * 会话列表里的时间。
 *
 * 刻意**没有复用** syncClient 的 relativeTime：那个的口径是同步场景
 * （"还没同步过"、"7 天前"），而这里更关心"这是不是同一天的谈话" ——
 * 隔了一天就该说"昨天"，而不是"N 小时前"。两边都是十来行的纯函数，
 * 硬抽公共实现只会把差异挤进参数里（"空值显示什么"、"第几天换口径"），
 * 那不是在复用，是把两件事绑在一起。
 */
function chatTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;

  const d = new Date(t);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `${Math.floor(min / 60)} 小时前`;

  const yesterday = new Date(now - 86_400_000);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return "昨天";

  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
