import { useEffect, useRef, useState } from "react";
import {
  X,
  Star,
  CalendarDays,
  Trash2,
  Clock,
  Check,
  ClipboardList,
  Settings2,
  Play,
  History,
  Plus,
  StickyNote,
  CornerDownRight,
  Timer,
  Copy,
  ListTree,
  ExternalLink,
} from "lucide-react";
import { useStore } from "../store";
import { addDays, today } from "../lib/repo";
import { SETTINGS } from "../lib/settings";
import { formatFields, parseCopyTemplate } from "../lib/special";
import {
  COURIERS,
  channelLabel,
  courierCodeOf,
  courierName,
  detectCourier,
  openTrackUrl,
  parseTrackChannel,
  resolveTrack,
} from "../lib/couriers";
import { DUE_PRESETS, dueAtText, dueState, dueText } from "../lib/due";
import type { WorkOrder } from "../types";
import AttachmentPanel from "./AttachmentPanel";
import DateTimePicker from "./DateTimePicker";

/**
 * 右侧流程任务详情。
 *
 * 与待办详情最大的不同：待办是"交代清楚一件事"，流程任务是"交代清楚一个流程"。
 * 所以这里的主角是**过程态进度条 + 流转记录**，其余字段都是配角。
 *
 * 所有修改直接落库，不做本地暂存（备注除外，它走防抖）。
 */
export default function OrderDetail({ order }: { order: WorkOrder }) {
  const {
    stages,
    flows,
    woLogs,
    loadWoLogs,
    loadAttachments,
    advanceOrder,
    patchOrder,
    removeOrder,
    toggleOrderImportant,
    openOrder,
    openFlowEditor,
    woFields,
    loadWoFields,
    addWoField,
    editWoField,
    removeWoField,
    settings,
  } = useStore();

  const isSpecial = order.kind === "special";
  /** 查件走哪个渠道（全局偏好，见 SETTINGS.specialTrackChannel） */
  const channel = parseTrackChannel(settings[SETTINGS.specialTrackChannel]);
  /**
   * 这张单上生效的快递商：库里指定了就用指定的，否则按单号识别。
   * 走 courierCodeOf 而不是直接读 order.courier —— 大多数单是"没指定"的，
   * 那时要按当前规则算，而不是显示"未知"。
   */
  const effectiveCourier = courierCodeOf(order.no, order.courier);
  /** 自动识别的结果（下拉里那句"跟随识别（顺丰速运）"要用） */
  const guessed = detectCourier(order.no)?.code ?? "";

  const openTrack = () => {
    const link = resolveTrack(order.no, effectiveCourier, channel);
    if (!link) return;
    openTrackUrl(link.url);
  };

  const flowStages = stages
    .filter((s) => s.flowId === order.flowId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const stage = flowStages.find((s) => s.id === order.stageId);
  const color = stage?.color ?? "#888780";
  const idx = flowStages.findIndex((s) => s.id === order.stageId);

  /* ---------------- 备注：防抖落库 ---------------- */

  const [note, setNote] = useState(order.note);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    // 只在切换到另一张流程任务时重置，同一张的刷新不该冲掉正在输入的内容
    if (idRef.current !== order.id) {
      idRef.current = order.id;
      setNote(order.note);
    }
  }, [order]);

  useEffect(() => {
    return () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, []);

  const commitNote = (v: string) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => void patchOrder(order.id, { note: v }), 400);
  };

  /* ---------------- 过程态 ---------------- */

  useEffect(() => {
    void loadWoLogs(order.id);
    void loadAttachments(order.id);
    // 相关信息也在这里取：详情面板是常驻的（切视图、关详情都不卸载），
    // 取数挂在 order.id 上，换单才会重取 —— 只写 useEffect(…, []) 的话，
    // 换了一张单，这里还挂着上一张的字段。
    void loadWoFields(order.id);
  }, [order.id, loadWoLogs, loadAttachments, loadWoFields]);

  // 流转备注：填了就跟着下一次推进走，然后清空。
  // 独立成一个输入框而不是弹窗追问 —— 大多数推进不值得写备注，
  // 每次都弹窗会让人嫌烦，最后变成无脑确认。
  const [stageNote, setStageNote] = useState("");

  const move = async (stageId: string) => {
    await advanceOrder(order.id, stageId, stageNote);
    setStageNote("");
  };

  const changeFlow = async (flowId: string) => {
    if (flowId === order.flowId) return;
    const target = stages
      .filter((s) => s.flowId === flowId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    if (!target.length) return;

    const newFlowName = flows.find((f) => f.id === flowId)?.name ?? "新流程";
    // 当前步骤在新流程里也存在时，只换流程，不动进度
    if (target.some((s) => s.id === order.stageId)) {
      await patchOrder(order.id, { flowId });
      return;
    }
    // 否则落到新流程的第一步，并留一条痕 —— 静默改掉过程态会让流转记录对不上
    await patchOrder(order.id, { flowId });
    await advanceOrder(order.id, target[0].id, `切换到「${newFlowName}」流程`);
  };

  const dueLabel = order.dueDate ? shortDate(order.dueDate) : null;
  const overdue = !!order.dueDate && order.dueDate < today() && !order.closed;

  /* ---------------- 处理时效 ---------------- */

  // 普通流程任务一般没有时效；但只要它挂着时效（比如所属流程的步骤配了默认时长），
  // 就得让它可见可改 —— 否则那段时间在详情里根本无从查看。
  const showStageDue = order.kind === "special" || !!order.stageDueAt;
  const ds = dueState(order);
  const dueHeadline = !order.stageDueAt
    ? "未设时效"
    : order.closed
      ? "已完结"
      : (dueText(order) ?? "未设时效");
  // 临期（soon）也是红的，与列表行同一套规则 —— 还剩 20 分钟和已经超了
  // 在动作上没有区别，琥珀色的"预警"在真正的紧急面前是噪音。
  // 走语义令牌：深浅主题各取各的值（styles.css）。
  const dueColor = !order.stageDueAt
    ? "#888780"
    : order.closed
      ? "#0f6e56"
      : ds === "overdue" || ds === "soon"
        ? "var(--color-danger)"
        : "#0f6e56";

  /* ---------------- 相关信息 ---------------- */

  /**
   * 新行走本地草稿，填写后才落库。
   *
   * 直接"点一下加一行"就往库里插一条空记录，会在用户只是好奇点了一下、
   * 或者填了一半又改主意时留下垃圾 —— 跟建单弹窗当初要解决的问题是同一个。
   */
  const [draftLabel, setDraftLabel] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const draftDirty = !!draftLabel.trim() || !!draftValue.trim();

  useEffect(() => {
    setDraftLabel("");
    setDraftValue("");
    // 复制成功的那个对勾也不该跨单留着
    setCopied(null);
  }, [order.id]);

  const commitDraft = async () => {
    if (!draftDirty) return;
    await addWoField(order.id, draftLabel, draftValue);
    setDraftLabel("");
    setDraftValue("");
  };

  const flashCopied = (key: string) => {
    setCopied(key);
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };

  const copyOne = async (id: string, text: string) => {
    if (!text) return;
    if (await copyText(text)) flashCopied(id);
  };

  // 只复制值（快递单号之类），不带上"字段名：" —— 粘到别处时那三个字是多余的。
  // 需要带名字的是"复制全部"，那里每行一个"字段名：值"，方便整段贴进聊天窗口。
  //
  // 格式走**记录视图里配的那套模板**：同一批信息在表上复制和在详情里复制
  // 出来两份不一样的东西，是最难解释的那类 bug。
  const copyAll = async () => {
    const text = formatFields(
      woFields,
      parseCopyTemplate(settings[SETTINGS.specialCopyTemplate]),
    );
    if (!text) return;
    if (await copyText(text)) flashCopied("__all__");
  };

  return (
    <>
      {/* 头部 */}
      <div className="flex shrink-0 items-start gap-2.5 px-4 pt-4 pb-3">
        <span
          className="mt-[3px] grid size-[20px] shrink-0 place-items-center rounded-[5px] border-[1.5px]"
          style={{ borderColor: color, background: order.closed ? color : "transparent" }}
        >
          {order.closed ? (
            <Check size={12} className="text-white" strokeWidth={3} />
          ) : (
            <span className="block size-[7px] rounded-[2px]" style={{ background: color }} />
          )}
        </span>
        <TitleEditor
          key={order.id}
          value={order.title}
          onCommit={(v) => void patchOrder(order.id, { title: v })}
        />
        <button
          onClick={() => openOrder(null)}
          title="关闭详情"
          className="mt-[3px] grid size-7 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {/* 特殊单号：单号（= 快递单号）+ 快递商 + 查件入口
            普通流程任务：描述（它没有单号，也不查物流） */}
        <div className="px-4">
          {isSpecial ? (
            <NoEditor value={order.no} onCommit={(v) => void patchOrder(order.id, { no: v })} />
          ) : (
            <DescEditor
              value={order.description}
              onCommit={(v) => void patchOrder(order.id, { description: v })}
            />
          )}
          {isSpecial && order.no && (
            <div className="mt-1 flex items-center gap-1.5">
              <select
                value={order.courier}
                onChange={(e) => void patchOrder(order.id, { courier: e.target.value })}
                data-od-courier=""
                title="认错了就在这里改一次，改完按你说的算"
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11.5px] text-fg-2 outline-none"
              >
                <option value="">
                  {guessed ? `跟随识别（${courierName(guessed)}）` : "跟随识别"}
                </option>
                {COURIERS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                onClick={openTrack}
                data-od-track=""
                title={`去${channelLabel(channel)}查 ${order.no}`}
                className="flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              >
                <ExternalLink size={11} />
                查询物流
              </button>
            </div>
          )}
        </div>

        {/* 过程态进度：流程任务的核心信息，摆在最前面 */}
        <div className="mt-3 px-4">
          <div className="flex items-center justify-between">
            <SectionLabel icon={<ClipboardList size={13} />} text="过程态" />
            <button
              onClick={() => openFlowEditor(order.flowId)}
              title="编辑这套流程"
              data-edit-flows=""
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-fg-dim hover:bg-hover"
            >
              <Settings2 size={12} />
              编辑流程
            </button>
          </div>

          <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card p-2">
            {/* 步骤条 */}
            <div className="flex items-stretch gap-1">
              {flowStages.map((s, i) => {
                const passed = idx >= 0 && i < idx;
                const current = s.id === order.stageId;
                return (
                  <button
                    key={s.id}
                    data-stage-step={s.name}
                    onClick={() => void move(s.id)}
                    title={
                      current
                        ? `当前：${s.name}`
                        : passed
                          ? `退回到「${s.name}」`
                          : `推进到「${s.name}」`
                    }
                    className="group/step relative min-w-0 flex-1 rounded-md px-1 pt-1.5 pb-2 text-center transition-colors hover:bg-hover"
                  >
                    <span
                      className="mx-auto block h-1.5 w-full rounded-full"
                      style={{
                        // 已经走过的步骤用实色，当前这一步用同色描边强调
                        background: current ? s.color : passed ? `${s.color}b0` : `${s.color}2e`,
                        outline: current ? `2px solid ${s.color}44` : "none",
                        outlineOffset: "1px",
                      }}
                    />
                    <span
                      className={`mt-1 block truncate text-[11px] ${
                        current ? "font-medium text-fg" : passed ? "text-fg-2" : "text-fg-dim"
                      }`}
                    >
                      {s.name}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-1.5 border-t border-line pt-1.5">
              <input
                value={stageNote}
                data-stage-note=""
                onChange={(e) => setStageNote(e.target.value)}
                placeholder="流转备注（可选，跟着下一次推进一起记）"
                className="w-full border-0 bg-transparent px-1 text-[12.5px] outline-none placeholder:text-fg-dim"
              />
            </div>
          </div>

          <div className="mt-1 px-0.5 text-[11.5px] text-fg-dim">
            {order.closed ? (
              <span className="text-[#0f6e56]">
                已完结{order.completedAt ? ` · ${formatWhen(order.completedAt)}` : ""}
              </span>
            ) : (
              <>
                当前第 {idx + 1} / {flowStages.length} 步
                {stage?.isTerminal === false && idx === flowStages.length - 1
                  ? " · 这是最后一步，它被标为非终态"
                  : ""}
              </>
            )}
          </div>
        </div>

        {/* 处理时效：挂在当前过程态上，推进到下一步会按目标步的默认时效重设 */}
        {showStageDue && (
          <div className="mt-4 px-4" data-order-due-block="">
            <div className="flex items-center justify-between">
              <SectionLabel icon={<Timer size={13} />} text="处理时效" />
              {order.stageDueAt && !order.closed && (
                <button
                  type="button"
                  onClick={() => {
                    void patchOrder(order.id, { stageDueAt: null });
                  }}
                  data-order-due-clear=""
                  title="清空时效"
                  className="rounded px-1.5 py-0.5 text-[11.5px] text-fg-dim hover:bg-hover"
                >
                  清空
                </button>
              )}
            </div>

            <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card p-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span
                  className="text-[15px] font-medium"
                  style={{ color: dueColor }}
                  data-order-due-state={ds}
                >
                  {dueHeadline}
                </span>
                {order.stageDueAt && (
                  <span className="text-[11.5px] text-fg-dim">
                    至 {dueAtText(order.stageDueAt)}
                  </span>
                )}
              </div>

              {!order.closed && (
                <>
                  <div
                    className="mt-2 flex flex-wrap items-center gap-1.5"
                    data-order-due-presets=""
                  >
                    {DUE_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        data-order-due-preset={p.label}
                        onClick={() => {
                          const at = p.at(Date.now());
                          void patchOrder(order.id, { stageDueAt: at });
                        }}
                        className="rounded-md border border-line px-2 py-1 text-[12px] text-fg-3 hover:bg-hover"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-1.5">
                    <DateTimePicker
                      mode="datetime"
                      value={order.stageDueAt}
                      onChange={(v) => {
                        if ((v ?? null) === order.stageDueAt) return;
                        void patchOrder(order.id, { stageDueAt: v });
                      }}
                      align="right"
                      inputAttrs={{ "data-order-due-input": "" }}
                      inputClassName="min-w-0 flex-1 rounded-lg border border-line px-2 py-1.5 text-[12.5px] text-fg-2 outline-none hover:bg-hover focus:bg-hover"
                    />
                  </div>
                </>
              )}

              <div className="mt-1.5 text-[11.5px] leading-relaxed text-fg-dim">
                {order.closed
                  ? "已完结的单子不再计时"
                  : stage && stage.defaultMinutes > 0
                    ? `本步默认 ${stage.defaultMinutes} 分钟 · 推进时按目标步的默认时效重设`
                    : "推进到下一步时会按目标步的默认时效重设（在「编辑流程」里给每一步配默认时长）"}
              </div>
            </div>
          </div>
        )}

        {/* 相关信息：字段名由用户定，列表只负责改、删、复制。
            两种流程任务都开放 —— 普通流程任务从 v13 起也能绑（见 migrations.ts） */}
        <div className="mt-4 px-4" data-wo-fields="">
          <div className="flex items-center justify-between">
            <SectionLabel icon={<ListTree size={13} />} text="相关信息" />
            {woFields.length > 0 && (
              <button
                type="button"
                onClick={() => void copyAll()}
                data-wo-copy-all=""
                title="按「字段名：值」逐行复制"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-fg-dim hover:bg-hover"
              >
                {copied === "__all__" ? (
                  <Check size={12} className="text-[#0f6e56]" />
                ) : (
                  <Copy size={12} />
                )}
                {copied === "__all__" ? "已复制" : "复制全部"}
              </button>
            )}
          </div>

          <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card">
            {woFields.length === 0 && !draftDirty && (
                <div className="px-2.5 py-2 text-[12px] text-fg-dim">
                  还没有绑定信息（字段名自己定，比如客户名、关联单号）
                </div>
            )}

            {woFields.map((f) => (
              <div
                key={f.id}
                data-wo-field={f.id}
                className="flex items-center gap-1.5 border-b border-line px-1.5 py-1 last:border-0"
              >
                {/* 非受控 + key=f.id：刷新时 React 复用同一个 DOM 节点，
                    正在输入的内容不会被重渲染擦掉，所以不需要本地态兜着 */}
                <input
                  defaultValue={f.label}
                  data-wo-field-label={f.id}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== f.label) void editWoField(f.id, { label: v });
                  }}
                  placeholder="字段名"
                  className="w-[92px] shrink-0 rounded px-1 py-0.5 text-[12.5px] text-fg-2 outline-none placeholder:text-fg-dim focus:bg-panel"
                />
                <input
                  defaultValue={f.value}
                  data-wo-field-value={f.id}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== f.value) void editWoField(f.id, { value: v });
                  }}
                  placeholder="值"
                  className="min-w-0 flex-1 rounded px-1 py-0.5 font-mono text-[12.5px] text-fg-2 outline-none placeholder:font-sans placeholder:text-fg-dim focus:bg-panel"
                />
                <button
                  type="button"
                  onClick={() => void copyOne(f.id, f.value)}
                  data-wo-field-copy={f.id}
                  title="复制这个值"
                  className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover"
                >
                  {copied === f.id ? (
                    <Check size={12} className="text-[#0f6e56]" />
                  ) : (
                    <Copy size={12} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void removeWoField(f.id)}
                  data-wo-field-del={f.id}
                  title="删掉这一行"
                  className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}

            {/* 新行：本地草稿，填写后才落库 */}
            <div className="flex items-center gap-1.5 border-t border-line px-1.5 py-1">
              <input
                value={draftLabel}
                data-wo-field-new-label=""
                onChange={(e) => setDraftLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitDraft();
                  }
                }}
                placeholder="+ 字段名"
                className="w-[92px] shrink-0 rounded px-1 py-0.5 text-[12.5px] text-fg-2 outline-none placeholder:text-fg-dim focus:bg-panel"
              />
              <input
                value={draftValue}
                data-wo-field-new-value=""
                onChange={(e) => setDraftValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitDraft();
                  }
                }}
                placeholder="值（回车绑定）"
                className="min-w-0 flex-1 rounded px-1 py-0.5 font-mono text-[12.5px] text-fg-2 outline-none placeholder:font-sans placeholder:text-fg-dim focus:bg-panel"
              />
              <button
                type="button"
                onClick={() => void commitDraft()}
                data-wo-field-new-add=""
                disabled={!draftDirty}
                title="绑定这一行"
                className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover disabled:opacity-30"
              >
                <Plus size={13} />
              </button>
            </div>
          </div>

          <div className="mt-1 px-0.5 text-[11.5px] text-fg-dim">
            点行尾图标复制该值；「复制全部」按「字段名：值」逐行复制。
          </div>
        </div>

        {/* 所属流程 */}
        <div className="mt-4 px-4">
          <SectionLabel text="所属流程" />
          <select
            value={order.flowId}
            data-order-flow=""
            onChange={(e) => void changeFlow(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
          >
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <div className="mt-1 px-0.5 text-[11.5px] text-fg-dim">
            换流程时，若当前步骤在新流程里不存在，会落到新流程的第一步并留痕。
          </div>
        </div>

        {/* 快捷开关。
            这里没有「添加到我的一天」：流程任务有专属视图，不进待办的「我的一天」，
            摆一个点了没反应的开关（或者更糟：点了真加进去）都是错的设计。 */}
        <div className="mt-4 flex flex-col gap-1.5 px-4">
          <QuickToggle
            icon={<Star size={15} />}
            label={order.important ? "已标记为重要" : "标记为重要"}
            active={order.important}
            activeColor="#ba7517"
            onClick={() => void toggleOrderImportant(order)}
          />
        </div>

        {/* 时间 */}
        <div className="mt-4 px-4">
          <SectionLabel icon={<CalendarDays size={13} />} text="开始与交付" />
          <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card">
            <DateRow
              icon={<Play size={12} />}
              label="开始"
              value={order.startDate}
              onChange={(d) => void patchOrder(order.id, { startDate: d })}
            />
            <div className="border-t border-line">
              <DateRow
                icon={<CalendarDays size={12} />}
                label="交付"
                value={order.dueDate}
                onChange={(d) => void patchOrder(order.id, { dueDate: d })}
                danger={overdue}
              />
            </div>
            <div className="border-t border-line px-3 py-1.5 text-[11.5px] text-fg-dim">
              {order.dueDate ? (
                <span className={overdue ? "text-danger" : ""}>
                  交付：{dueLabel}
                  {overdue && " · 已逾期"}
                </span>
              ) : (
                "未设置交付日期"
              )}
            </div>
          </div>
        </div>

        {/* 流转记录 */}
        <div className="mt-4 px-4">
          <SectionLabel icon={<History size={13} />} text="流转记录" />
          <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card">
            {woLogs.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px] text-fg-dim">还没有流转记录</div>
            ) : (
              woLogs.map((l) => {
                const to = flowStages.find((s) => s.id === l.toStage);
                const from = flowStages.find((s) => s.id === l.fromStage);
                return (
                  <div
                    key={l.id}
                    data-wo-log={l.id}
                    className="flex animate-fade-up items-start gap-2 border-b border-line px-2.5 py-2 last:border-0"
                  >
                    <span
                      className="mt-[5px] block size-2 shrink-0 rounded-full"
                      style={{ background: to?.color ?? "#888780" }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12.5px]">
                        {from ? (
                          <>
                            <span className="text-fg-dim">{from.name}</span>
                            <CornerDownRight size={11} className="shrink-0 text-fg-dim" />
                          </>
                        ) : (
                          <span className="text-fg-dim">创建</span>
                        )}
                        <span className="font-medium text-fg-2">{to?.name ?? "未知阶段"}</span>
                      </div>
                      {l.note && (
                        <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">
                          {l.note}
                        </div>
                      )}
                      <div className="mt-0.5 text-[11px] text-fg-dim">{formatWhen(l.at)}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 附件：图片/视频进本地仓库，文件与网址只存链接 */}
        <AttachmentPanel orderId={order.id} />

        {/* 备注 */}
        <div className="mt-4 px-4">
          <SectionLabel icon={<StickyNote size={13} />} text="备注" />
          <textarea
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              commitNote(e.target.value);
            }}
            placeholder="添加备注"
            className="mt-1.5 min-h-[90px] w-full resize-none rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] leading-relaxed text-fg-2 outline-none placeholder:text-fg-dim focus:border-[#378add]"
          />
        </div>
      </div>

      {/* 底部 */}
      <div className="shrink-0 border-t border-line px-4 py-3">
        <div className="flex items-center gap-1.5 text-[11.5px] text-fg-dim">
          <Clock size={12} />
          创建于 {formatWhen(order.createdAt)}
          {order.completedAt && ` · 完成于 ${formatWhen(order.completedAt)}`}
        </div>
        <button
          onClick={() => void removeOrder(order.id)}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-card py-2 text-[13px] text-danger hover:bg-danger-soft"
        >
          <Trash2 size={14} />
          删除此流程任务
        </button>
      </div>
    </>
  );
}

/* -------------------------------- 零件 -------------------------------- */

/** 单号编辑：等宽字体，空着显示「自动生成」提示 */
function NoEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5">
      <span className="shrink-0 text-[11.5px] text-fg-dim">单号</span>
      <input
        value={text}
        data-order-no-input=""
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim();
          if (t !== value) onCommit(t);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(value);
            e.currentTarget.blur();
          }
        }}
        placeholder="未编号"
        className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] text-fg-2 outline-none placeholder:text-fg-dim"
      />
    </div>
  );
}

/**
 * 描述编辑：普通流程任务的主要文字信息。
 *
 * 头部那行大字是标题（列表扫视用，所以要求短），这里是它的展开说明，
 * 所以给的是多行输入框。走 blur 落库而不是回车 —— 回车在这个控件里是换行，
 * 和标题的"回车即提交"不同，这一点必须区分开。
 */
function DescEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  return (
    <div className="rounded-lg border border-line bg-card px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <span className="mt-[3px] shrink-0 text-[11.5px] text-fg-dim">描述</span>
        <textarea
          value={text}
          data-order-desc-input=""
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const t = text.trim();
            if (t !== value) onCommit(t);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setText(value);
              e.currentTarget.blur();
            }
          }}
          placeholder="这件事要办什么"
          className="max-h-32 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent text-[12.5px] leading-relaxed text-fg-2 outline-none placeholder:text-fg-dim"
        />
      </div>
    </div>
  );
}

function TitleEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  return (
    <textarea
      value={text}
      rows={1}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim();
        if (t && t !== value) onCommit(t);
        else setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setText(value);
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-[15px] leading-[22px] text-fg outline-none hover:border-line focus:border-[#378add] focus:bg-card"
    />
  );
}

/** 单行日期字段：不需要时清空 */
function DateRow({
  icon,
  label,
  value,
  onChange,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  onChange: (d: string | null) => void;
  danger?: boolean;
}) {
  const t = today();
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5">
      <span className="shrink-0 text-fg-dim">{icon}</span>
      <span className="w-8 shrink-0 text-[12.5px] text-fg-3">{label}</span>
      <div className="flex flex-1 items-center gap-1">
        <button
          onClick={() => onChange(t)}
          className={`rounded px-1.5 py-0.5 text-[12px] ${
            value === t ? "bg-[#378add] text-white" : "text-fg-3 hover:bg-hover"
          }`}
        >
          今天
        </button>
        <button
          onClick={() => onChange(addDays(t, 1))}
          className={`rounded px-1.5 py-0.5 text-[12px] ${
            value === addDays(t, 1) ? "bg-[#378add] text-white" : "text-fg-3 hover:bg-hover"
          }`}
        >
          明天
        </button>
      </div>
      <div className="w-[132px] shrink-0">
        <DateTimePicker
          mode="date"
          value={value ?? null}
          onChange={(v) => onChange(v)}
          align="right"
          inputClassName={`w-full rounded px-1 py-0.5 text-[12px] outline-none hover:bg-hover focus:bg-hover ${
            danger ? "text-danger" : "text-fg-3"
          }`}
        />
      </div>
      {value && (
        <button
          onClick={() => onChange(null)}
          title="清空"
          className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function QuickToggle({
  icon,
  label,
  active,
  activeColor,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  activeColor: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] transition-colors ${
        active ? "bg-card font-medium" : "text-fg-3 hover:bg-card"
      }`}
      style={active ? { color: activeColor } : undefined}
    >
      {icon}
      {label}
    </button>
  );
}

function SectionLabel({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-fg-dim">
      {icon}
      {text}
    </div>
  );
}

/**
 * 复制一段文本。
 *
 * 优先走 clipboard API；失败时退回隐藏 textarea + execCommand —— 桌面端的
 * WebView 在某些上下文里会把 clipboard API 当不安全来源拒掉，那时如果只写
 * `navigator.clipboard.writeText` 而不接住 rejection，按钮就会毫无反应，
 * 而用户只会觉得"这复制是坏的"。返回是否成功，好让界面给出反馈。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* -------------------------------- 日期 -------------------------------- */

function shortDate(dateStr: string): string {
  const t = today();
  if (dateStr === t) return "今天";
  if (dateStr === addDays(t, 1)) return "明天";
  if (dateStr === addDays(t, -1)) return "昨天";
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${d.getHours()}:${p(d.getMinutes())}`;
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return local === today() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
