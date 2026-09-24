/**
 * AI 助手的对话界面 —— 它现在是**窗口的主体**（外壳见 AgentWindow.tsx）。
 *
 * ------------------------------------------------------------------
 * 为什么它的状态在模块里，而不是这个组件里
 * ------------------------------------------------------------------
 * 助手要干的活是慢活：写一份 30 KB 的工具源码、装进去、再回来跟你说结果。
 * 用户完全可以在这期间把窗口收起来（按 Esc、点球、点 ×）去看一眼待办 ——
 * 而那时工具可能**已经写进磁盘**了。状态如果挂在这个组件上，收起窗口
 * 就会卸载组件、把那一轮丢掉：动作卡没了、答复没了，回来只看到一句
 * "有什么可以帮你"，而磁盘上已经多了一个工具。
 *
 * 所以状态是模块级的（lib/agent/runtime.ts 的订阅式 store），这里只是它的
 * 一个视图。2026-09-23 助手从"和待办平级的视图"变成了"悬浮窗口"，这条理由
 * 没有变 —— 变的只是入口形态：一颗可以拖动的球（AgentBall.tsx），
 * 以及窗口右侧挂上了历史对话（AgentWindow.tsx）。
 *
 * ------------------------------------------------------------------
 * 这里没有任何"助手觉得自己做了"的东西
 * ------------------------------------------------------------------
 * 每条助手消息下面挂的是**动作卡**：动作名、成败、结果细节，展开能看参数、
 * 能复制它写出来的源码。这是这个界面最要紧的一部分 —— 一个只会说
 * "已为你完成"的助手和一个真干活的助手，区别必须能在界面上被看见。
 * 动作卡的数据来自 runtime 收集的真实执行结果，不是模型说的话。
 *
 * ------------------------------------------------------------------
 * 选择器约定
 * ------------------------------------------------------------------
 * 关键状态都写了 data-agent-*，自动化验证（tests/agent.mjs）靠它们定位。
 * 全部用 data-* 而不是文案匹配：文案会改，选择器不该跟着一起改。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Copy,
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Wrench,
  BookOpen,
  X,
} from "lucide-react";
import { useStore } from "../store";
import * as runtime from "../lib/agent/runtime";
import { SKILLS } from "../lib/agent/skills";
import { agentConfigProblems, agentProvider } from "../lib/agent/providers";
import { actionLabel } from "../lib/agent/actions";
import { parseAgentPermissions, readAgentConfig, withDefaults } from "../lib/settings";
import type { AgentAction, AgentAsk, AgentMessage } from "../lib/agent/types";

/** 空对话时摆在输入框上面的几句话。它们的价值是"让人知道这东西能干什么" */
const OPENERS = [
  "今天有什么安排？",
  "帮我做一个记录加班时长的工具",
  "明天下午三点提醒我给客户回电话",
];

/**
 * @param onClose 由窗口外壳传进来。有它才渲染右上角那个 ×——
 *   这样"收起窗口"这件事只有一个实现在上层，对话界面本身不需要知道
 *   自己是被窗口装着还是被别的东西装着。
 */
export default function AgentView({ onClose }: { onClose?: () => void }) {
  const { settings, refresh, reloadTools, openSettings } = useStore();
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);

  const [draft, setDraft] = useState("");
  const [skillsOpen, setSkillsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void runtime.ensureLoaded();
  }, []);

  // 新内容（含流式增量）都要把视口带到最下面，否则用户会以为它卡住了
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.streaming, state.phase]);

  const cfg = readAgentConfig(withDefaults(settings));
  const problems = agentConfigProblems(cfg);
  const configured = problems.length === 0;
  const provider = agentProvider(cfg.provider);

  /**
   * 权限关掉时必须能在**助手界面上**看见。
   *
   * 只在设置里有个开关是不够的：用户关掉之后，助手会一遍遍回"我没有权限"，
   * 而他会以为是助手坏了。这里常驻一个可点的提示，把"哪几项关了、去哪儿开"
   * 摆在它说话的地方。
   */
  const perms = parseAgentPermissions(withDefaults(settings));
  const offPerms = [
    !perms.writeTools && "写工具",
    !perms.schedules && "建日程",
    !perms.database && "绑数据表",
  ].filter((x): x is string => !!x);

  /**
   * 注入给动作层的宿主能力。
   *
   * 三个能力都来自 store —— 装完工具要重扫注册表、建完日程要刷新界面、
   * 打开工具要切视图，这些都属于 store 的职责，而 lib/ 层不允许 import store
   * （见 lib/agent/actions.ts 文件头），所以从这里注入。
   *
   * openTool 这里包了一层校验，而不是直接把 store.openTool 递过去：
   * store 的那个是 `(id) => void`，工具不存在/已停用时它只是把 activeToolId
   * 设成一个无意义的值（工具区会显示空白）。助手需要一个**能回话**的版本，
   * 否则它只能告诉用户"打开了"，而屏幕上是空的。
   */
  const host = useMemo(
    () => ({
      refresh,
      reloadTools,
      openTool: (id: string): string | null => {
        const s = useStore.getState();
        if (!s.tools.some((t) => t.id === id)) {
          return `没有 id 为「${id}」的工具（它可能已被卸载）`;
        }
        if (!s.enabledTools.some((t) => t.id === id)) {
          return `工具「${id}」已被停用，请先在「设置 → 工具」里启用它`;
        }
        s.openTool(id);
        return null;
      },
    }),
    [refresh, reloadTools],
  );

  const sendNow = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setDraft("");
    void runtime.send(t, host);
  };

  const hasContent = state.messages.length > 0;

  return (
    <div data-agent="" className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      {/*
        头部。它同时是**窗口的拖动把手** —— 抓这里能把整个窗口挪走，
        落点会被记住（见 AgentWindow / windowGeom.ts）。
        把手里的按钮与输入框由 AgentWindow 那边豁免，点它们不会拖窗口。
      */}
      <div
        data-agent-window-drag=""
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-line px-5 py-2.5 active:cursor-grabbing"
      >
        <span className="grid size-6 place-items-center rounded-md bg-accent/12 text-accent">
          <Bot size={15} />
        </span>
        <h1 className="text-[14px] font-medium text-fg">AI 助手</h1>
        <span
          data-agent-provider={cfg.provider}
          className="rounded-full bg-chip px-2 py-0.5 text-[11px] text-fg-3"
          title={configured ? `接口：${cfg.baseUrl || provider.defaultBase}` : "还没配好"}
        >
          {configured ? `${provider.name} · ${cfg.model}` : "未配置"}
        </span>
        {offPerms.length > 0 && (
          <button
            onClick={() => openSettings(true, "ai")}
            data-agent-perms-off={offPerms.join(",")}
            title={`已关闭：${offPerms.join("、")}。点它去打开`}
            className="flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] text-danger"
          >
            <ShieldAlert size={11} />
            {offPerms.length} 项权限已关
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setSkillsOpen(true)}
          data-agent-skills-open=""
          title="看看它按什么标准干活"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-3 hover:bg-hover"
        >
          <BookOpen size={14} />
          技能（{SKILLS.length}）
        </button>
        {hasContent && (
          /*
            「新对话」不再是**清空**了（2026-09-23 多会话改造）。
            旧版这颗按钮按下去会抹掉上一段，所以它需要一次两段式确认 ——
            而"要不要按"这件事用户每次都答不上来，按钮也就没人敢按。
            现在它只是新开一段，旧的留在右侧历史里，两段之间点一下就切，
            所以确认环节去掉了（真删在设置里，那里仍是两段式）。
          */
          <button
            onClick={() => void runtime.newChat()}
            data-agent-new=""
            title="开一段新对话 —— 这一段的记录会留在右侧的历史里"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-3 hover:bg-hover"
          >
            <MessageSquarePlus size={14} />
            新对话
          </button>
        )}
        <button
          onClick={() => openSettings(true, "ai")}
          data-agent-settings=""
          title="AI 助手设置"
          className="grid size-7 place-items-center rounded-md text-fg-dim hover:bg-hover"
        >
          <Settings2 size={15} />
        </button>
        {onClose && (
          <button
            onClick={onClose}
            data-agent-window-close=""
            title="收起窗口（Esc）—— 它手上那一轮不会停"
            className="grid size-7 place-items-center rounded-md text-fg-dim hover:bg-hover"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* 消息流 */}
      <div ref={scroller} data-agent-messages="" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-[720px]">
          {!configured && <ConfigGate problems={problems} onOpen={() => openSettings(true, "ai")} />}

          {configured && !hasContent && !state.busy && <Welcome onPick={sendNow} />}

          {state.messages.map((m) => (
            <MessageBubble key={m.id} msg={m} />
          ))}

          {/* 正在跑的那一段：流式文本 + 当前阶段 */}
          {state.busy && (
            <div data-agent-phase={state.phase} className="mb-4 flex gap-2.5">
              <Avatar />
              <div className="min-w-0 flex-1">
                {state.streaming ? (
                  <div className="rounded-xl border border-line bg-card px-3.5 py-2.5">
                    <RichText text={state.streaming} />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-line bg-card px-3.5 py-2.5 text-[12.5px] text-fg-dim">
                    <Loader2 size={13} className="animate-spin" />
                    {state.phase || "正在思考…"}
                  </div>
                )}
                {state.streaming && state.phase && (
                  <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-fg-dim">
                    <Loader2 size={11} className="animate-spin" />
                    {state.phase}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 整轮级失败：网络、密钥、限流。逐动作的失败在动作卡上 */}
          {state.error && !state.busy && (
            <div
              data-agent-error=""
              className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-danger">
                {state.error}
              </div>
            </div>
          )}
          <div className="h-1" />
        </div>
      </div>

      {/*
        挂起的问题卡。

        它**必须摆在输入区外面**：塞进消息流的话，用户往回翻两屏就看不见它了，
        而那一刻整轮对话正卡在这儿等他 —— 他会以为助手卡死了。
        放在输入框上面则相反：助手在手边等着，答案也就在手边。
      */}
      {state.ask && <AskCard ask={state.ask} />}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-line px-5 py-3">
        {/* 卡着问题的时候不让他发新话：send 会被 busy 挡掉，与其让他
            打完字才发现发不出去，不如一开始就把框说清楚。 */}
        {state.ask && (
          <p className="mb-1.5 px-1 text-[11px] text-fg-dim">
            助手正在上面等你回答 —— 答完它才会接着往下做。
          </p>
        )}
        <div className="mx-auto max-w-[720px]">
          <div className="flex items-end gap-2 rounded-xl border border-line bg-card px-2.5 py-2 focus-within:border-accent">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter 发送、Shift+Enter 换行 —— 输入多行内容（比如让它照一段格式写工具）时很需要后者
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!state.busy) sendNow(draft);
                }
              }}
              rows={Math.min(6, Math.max(1, draft.split("\n").length))}
              data-agent-input=""
              placeholder={configured ? "说点什么，或者让它做个工具…（Enter 发送，Shift+Enter 换行）" : "先在设置里配好接口地址和 Key"}
              className="max-h-[160px] min-w-0 flex-1 resize-none border-0 bg-transparent py-1 text-[13px] text-fg-2 outline-none placeholder:text-fg-dim"
            />
            {state.busy ? (
              <button
                onClick={() => runtime.abort()}
                data-agent-stop=""
                title="停止这一轮"
                className="grid size-7 shrink-0 place-items-center rounded-lg bg-danger-soft text-danger hover:opacity-80"
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                onClick={() => sendNow(draft)}
                disabled={!draft.trim() || !configured}
                data-agent-send=""
                title="发送"
                className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-white disabled:opacity-35"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-fg-dim">
            对话只存在本机（设置 → AI 助手 里可以清空）。它做的每一件事都会列在消息下面 ——
            装了什么工具、建了哪几条日程，都能对得上。
          </p>
        </div>
      </div>

      {skillsOpen && <SkillDrawer onClose={() => setSkillsOpen(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 停下来问你的那张卡                                                   */
/* ------------------------------------------------------------------ */

/**
 * 助手问你一句话时的回答区。
 *
 * ------------------------------------------------------------------
 * 这张卡是**一个 Promise 的界面**：runtime 那边正 await 着（见
 * runtime.askOnce），点任意一个按钮 = 解开它，那一轮接着往下跑。
 * ------------------------------------------------------------------
 *
 * 三处细节不是装饰：
 *
 *   1. **「跳过」不等于「同意」。** 确认卡上尤其要分清：用户点跳过时
 *      runtime 回给模型的是"这不算同意，别偷偷做"。所以确认卡里的
 *      取消按钮就是 value=no 的普通选项，语义明确。
 *   2. **换问题要清空打了一半的字。** 否则上一题打到一半的内容会跟着
 *      提交到下一题上 —— 那种串台用户只会觉得"它听错了"。
 *   3. **危险操作用醒目色**，并且按钮上写的是动作（"删除"），不是"确定"。
 *      顺手点过去和想清楚了再点是两件事。
 *
 * 选择器：`data-agent-ask` / `-kind` / `-source` / `-danger` /
 * `-question` / `-detail` / `-option`（带 value）/ `-text` / `-submit` /
 * `-skip` / `-cancel`。
 */
function AskCard({ ask }: { ask: AgentAsk }) {
  const [text, setText] = useState("");
  // 换了一个问题就把打了一半的字清掉：留着会串到下一个问题上
  useEffect(() => {
    setText("");
  }, [ask.id]);

  const confirm = ask.kind === "confirm";
  const fromHost = ask.source === "host";

  return (
    <div
      data-agent-ask=""
      data-agent-ask-kind={ask.kind}
      data-agent-ask-source={ask.source}
      data-agent-ask-danger={ask.danger ? "1" : "0"}
      className={
        "shrink-0 border-t px-5 py-3 " +
        (ask.danger ? "border-danger/30 bg-danger-soft/60" : "border-line bg-accent/[0.06]")
      }
    >
      <div className="mx-auto max-w-[720px]">
        <div className="flex items-start gap-2">
          <span
            className={
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md " +
              (ask.danger ? "bg-danger/15 text-danger" : "bg-accent/12 text-accent")
            }
          >
            {ask.danger ? <ShieldAlert size={13} /> : <HelpCircle size={13} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-fg-dim">
              {fromHost
                ? confirm
                  ? "它要动手了 —— 这一步得你先点头"
                  : "它要往下做之前得先问你"
                : "助手想问你一句"}
            </div>
            <div data-agent-ask-question="" className="mt-0.5 text-[13.5px] font-medium text-fg">
              {ask.question}
            </div>
            {ask.detail && (
              <div
                data-agent-ask-detail=""
                className="mt-1.5 whitespace-pre-wrap rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] leading-relaxed text-fg-2"
              >
                {ask.detail}
              </div>
            )}
          </div>
        </div>

        {/* 选项 */}
        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-7">
          {ask.options.map((o) => {
            // 危险确认里那个"同意"按钮单独上色；拒的一方永远保持朴素，
            // 免得两个按钮一样重、用户看一眼就点错
            const isYes = confirm && o.value === "yes" && ask.danger;
            return (
              <button
                key={o.value}
                onClick={() => runtime.answerAsk(o.value, o.label)}
                data-agent-ask-option={o.value}
                title={o.note || ""}
                className={
                  "rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors " +
                  (isYes
                    ? "border-danger/40 bg-danger text-white hover:opacity-90"
                    : "border-line bg-card text-fg-2 hover:bg-hover")
                }
              >
                {o.label}
              </button>
            );
          })}

          {!confirm && (
            <button
              onClick={() => runtime.answerAsk("__skip__", "跳过")}
              data-agent-ask-skip=""
              title="不回答 —— 它会自己定一个，并在回复里说明定了什么"
              className="rounded-lg border border-line bg-transparent px-3 py-1.5 text-[12.5px] text-fg-dim hover:bg-hover"
            >
              跳过（你看着办）
            </button>
          )}

          <div className="flex-1" />

          <button
            onClick={() => runtime.abort()}
            data-agent-ask-cancel=""
            title="不让它做了，这一轮到此为止"
            className="rounded-lg border border-line bg-transparent px-3 py-1.5 text-[12.5px] text-fg-dim hover:bg-hover"
          >
            停止这一轮
          </button>
        </div>

        {ask.allowText && (
          <div className="mt-2 flex items-center gap-1.5 pl-7">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (text.trim()) runtime.answerAsk("__text__", "自己说", text.trim());
                }
              }}
              data-agent-ask-text=""
              placeholder="都不对？你自己说…"
              className="min-w-0 flex-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12.5px] text-fg-2 outline-none placeholder:text-fg-dim focus:border-accent"
            />
            <button
              onClick={() => runtime.answerAsk("__text__", "自己说", text.trim())}
              disabled={!text.trim()}
              data-agent-ask-submit=""
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-white disabled:opacity-35"
            >
              <ArrowUp size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 未配置 / 空对话                                                     */
/* ------------------------------------------------------------------ */

function ConfigGate({ problems, onOpen }: { problems: string[]; onOpen: () => void }) {
  return (
    <div
      data-agent-gate=""
      className="mb-5 rounded-xl border border-line bg-card px-4 py-3.5"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <span className="text-[13.5px] font-medium text-fg">先接上一个模型</span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">
        助手要调用一家对话接口才能说话。它用的是 OpenAI 兼容的接口，所以 Agnes、阿里云百炼、
        DeepSeek、自建网关都能接；Key 只存在本机，对话记录也只存在本机。
        缺的那几项在下面的按钮里点进去补（<b className="font-medium">设置 → AI 助手</b>）。
      </p>
      <ul className="mt-2 space-y-0.5">
        {problems.map((p) => (
          <li key={p} className="flex items-center gap-1.5 text-[12.5px] text-fg-3">
            <span className="size-1 rounded-full bg-fg-dim" />
            {p}
          </li>
        ))}
      </ul>
      <button
        onClick={onOpen}
        data-agent-goto-settings=""
        className="mt-3 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] text-white hover:opacity-90"
      >
        <Settings2 size={14} />
        去设置里配
      </button>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div data-agent-empty="" className="mb-6">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-accent/12 text-accent">
          <Bot size={20} />
        </span>
        <div>
          <div className="text-[14px] font-medium text-fg">有什么要办的？</div>
          <div className="text-[12px] text-fg-dim">
            我能聊天、能按标准写出装得进这台工作台的小工具、也能把日程记下来。
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {OPENERS.map((t) => (
          <button
            key={t}
            onClick={() => onPick(t)}
            data-agent-opener=""
            className="rounded-full border border-line bg-card px-3 py-1.5 text-[12.5px] text-fg-2 hover:bg-hover"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 一条消息                                                            */
/* ------------------------------------------------------------------ */

function MessageBubble({ msg }: { msg: AgentMessage }) {
  if (msg.role === "user") {
    return (
      <div data-agent-msg="user" className="mb-4 flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent/12 px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div data-agent-msg="assistant" className="mb-4 flex gap-2.5">
      <Avatar />
      <div className="min-w-0 flex-1">
        {msg.content && (
          <div className="rounded-xl border border-line bg-card px-3.5 py-2.5">
            <RichText text={msg.content} />
          </div>
        )}
        {msg.error && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-danger">{msg.error}</div>
          </div>
        )}
        {msg.actions.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {msg.actions.map((a, i) => (
              <ActionCard key={`${a.tool}-${i}`} action={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
      <Bot size={15} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 动作卡                                                              */
/* ------------------------------------------------------------------ */

/**
 * 一张动作卡 = 助手真做过的一件事。
 *
 * 三条信息必须同时可见：**做了什么**（中文动作名）、**成没成**、
 * **具体结果**（装到哪个目录、建了哪几条）。只显示一句"成功"的卡片
 * 等于没显示 —— 用户没法拿它去核对。
 */
function ActionCard({ action }: { action: AgentAction }) {
  const [copied, setCopied] = useState(false);
  const html = action.tool === "install_tool" && typeof action.args.html === "string" ? action.args.html : "";

  const copy = () => {
    void navigator.clipboard?.writeText(html).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div
      data-agent-action={action.tool}
      data-agent-action-ok={action.ok ? "1" : "0"}
      className={`rounded-xl border px-3 py-2 ${
        action.ok ? "border-line bg-card" : "border-danger/30 bg-danger-soft"
      }`}
    >
      <div className="flex items-center gap-2">
        {action.ok ? (
          <Check size={13} className="shrink-0 text-[#0f6e56]" />
        ) : (
          <ShieldAlert size={13} className="shrink-0 text-danger" />
        )}
        <span className="shrink-0 text-[12px] font-medium text-fg-2">{actionLabel(action.tool)}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3" title={action.summary}>
          {action.summary}
        </span>
        {html && (
          <button
            onClick={copy}
            data-agent-copy-html=""
            className="flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-hover"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? "已复制" : "复制源码"}
          </button>
        )}
      </div>

      {(action.detail || action.error) && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11.5px] text-fg-dim hover:text-fg-3">
            看细节
          </summary>
          <pre className="mt-1.5 max-h-[320px] overflow-auto rounded-lg bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-3">
            {action.detail || action.error}
          </pre>
        </details>
      )}

      {Object.keys(action.args).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11.5px] text-fg-dim hover:text-fg-3">
            看参数
          </summary>
          <pre className="mt-1.5 max-h-[240px] overflow-auto rounded-lg bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-3">
            {JSON.stringify(argsForDisplay(action), null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

/** 参数展示版：HTML 源码动辄几十 KB，塞进 JSON 里既看不懂也卡，换一句长度说明 */
function argsForDisplay(action: AgentAction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action.args)) {
    out[k] = typeof v === "string" && v.length > 400 ? `（${v.length} 字符，见「复制源码」）` : v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 技能抽屉                                                            */
/* ------------------------------------------------------------------ */

/**
 * 技能面板。
 *
 * 助手"会什么"必须能被用户看见：一个看不见能力边界的东西，用户没法判断
 * 该不该信它。这份列表与注入给模型的**是同一份数据**（lib/agent/skills.ts），
 * 所以不存在"界面说一套、实际按另一套做"。
 */
function SkillDrawer({ onClose }: { onClose: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" data-agent-skills="">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="relative flex h-full w-[520px] max-w-[92vw] flex-col border-l border-line bg-panel shadow-[0_2px_18px_rgba(0,0,0,0.25)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <BookOpen size={15} className="text-accent" />
          <span className="text-[13.5px] font-medium text-fg">它会按这些标准干活</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            data-agent-skills-close=""
            className="grid size-7 place-items-center rounded-md text-fg-dim hover:bg-hover"
          >
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-[12px] leading-relaxed text-fg-dim">
            下面的规则是硬约束（违反了工具就装不进去、或者装进去打不开），
            所以它们**每一轮都在助手的上下文里**；每条技能还有一份全文，它动手前会自己取。
          </p>
          {SKILLS.map((s) => {
            const open = openId === s.id;
            return (
              <div
                key={s.id}
                data-agent-skill={s.id}
                className="mb-2 rounded-xl border border-line bg-card px-3.5 py-3"
              >
                <button
                  onClick={() => setOpenId(open ? null : s.id)}
                  className="flex w-full items-start gap-2 text-left"
                >
                  <ChevronRight
                    size={14}
                    className={`mt-0.5 shrink-0 text-fg-dim transition-transform ${open ? "rotate-90" : ""}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-fg">{s.title}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-dim">{s.summary}</span>
                  </span>
                </button>
                <ul className="mt-2 ml-5 list-disc space-y-0.5">
                  {s.rules.map((r) => (
                    <li key={r} className="text-[12px] leading-relaxed text-fg-3">
                      {r}
                    </li>
                  ))}
                </ul>
                {open && (
                  // 全文按 Markdown 渲染。不能直接把源码吐出来：这份文档里全是
                  // ``` 代码块与 # 标题，原样显示会满屏井号、反引号，用户读到的是
                  // 排版语法而不是标准本身（2026-09-23 用户截图里就是这样）。
                  <div className="mt-2.5 max-h-[420px] overflow-auto rounded-lg bg-surface px-2.5 py-2">
                    <RichText text={s.body} />
                  </div>
                )}
              </div>
            );
          })}

          <div className="mt-3 flex items-start gap-2 rounded-xl border border-line bg-card px-3.5 py-2.5">
            <Wrench size={13} className="mt-0.5 shrink-0 text-fg-dim" />
            <div className="text-[11.5px] leading-relaxed text-fg-dim">
              它现在能做：查工具、读工具、装/更新工具、打开工具、给工具绑数据表、
              看清单、看日程、建日程。改不了流程任务，也不碰核心表 ——
              工具的私有表只能由那个工具自己经宿主通道访问。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 极简 Markdown 渲染                                                  */
/* ------------------------------------------------------------------ */

/**
 * 只认四种东西：围栏代码块、标题、列表、**粗体** 与 `行内代码`。
 *
 * 为什么不上一个 Markdown 库：这里渲染的是**模型输出**，而完整的 Markdown
 * 允许内联 HTML —— 那意味着要引 sanitizer，而"给一个会读你本机文件的东西
 * 加一条 HTML 注入通道"这件事，收益（表格好看一点）和代价完全不成比例。
 * 这里全部走 React 元素，不碰 dangerouslySetInnerHTML。
 */
type Block = { kind: "code"; lang: string; body: string } | { kind: "text"; lines: string[] };

function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([a-zA-Z0-9-]*)[ \t]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "text", lines: text.slice(last, m.index).split("\n") });
    out.push({ kind: "code", lang: m[1] ?? "", body: (m[2] ?? "").replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  // 未闭合的围栏留在正文里当普通文本 —— 宁可少美化一处，也不能把模型的话吞掉
  if (last < text.length) out.push({ kind: "text", lines: text.slice(last).split("\n") });
  return out.filter((b) => b.kind === "code" || b.lines.some((l) => l.trim()));
}

function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-fg-2">
      {blocks.map((b, i) =>
        b.kind === "code" ? (
          <pre
            key={i}
            className="max-h-[360px] overflow-auto rounded-lg bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg-3"
          >
            {b.body}
          </pre>
        ) : (
          <TextBlock key={i} lines={b.lines} />
        ),
      )}
    </div>
  );
}

function TextBlock({ lines }: { lines: string[] }) {
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) {
      i++;
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      out.push(
        <div key={k++} className="pt-0.5 font-medium text-fg">
          {inline(h[2])}
        </div>,
      );
      i++;
      continue;
    }

    if (/^\s*[-*•]\s+/.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={k++} className="ml-4 list-disc space-y-0.5">
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.、)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.、)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.、)]\s+/, ""));
        i++;
      }
      out.push(
        <ol key={k++} className="ml-4 list-decimal space-y-0.5">
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i].trim()) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\d+[.、)]\s+/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(<p key={k++}>{inline(para.join(" "))}</p>);
  }
  return <>{out}</>;
}

/** 行内：**粗体** 与 `代码`。两个都只走 React 元素，不解析 HTML */
function inline(s: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(
        <b key={k++} className="font-medium text-fg">
          {tok.slice(2, -2)}
        </b>,
      );
    } else {
      parts.push(
        <code key={k++} className="rounded bg-chip px-1 py-px font-mono text-[11.5px] text-fg-3">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
