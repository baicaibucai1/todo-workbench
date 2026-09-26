import { useEffect, useState } from "react";
import {
  X,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Star,
  Check,
  Flag,
  Timer,
  AlertTriangle,
} from "lucide-react";
import { useStore } from "../store";
import { STAGE_COLORS } from "../lib/repo";

/**
 * 流程编辑器。
 *
 * 「流程任务的流程和过程态可以自定义」这件事的落点。做成覆盖式弹层而不是新页面：
 * 用户点进来是为了改几步然后回去继续处理流程任务，不该丢掉主界面的上下文。
 *
 * 分成左右两栏，是因为这里的核心心智模型就是"流程是一套可复用的阶段序列"：
 * 左边挑流程，右边改它里面的步骤。如果做成一层平铺的列表，
 * 「阶段属于哪套流程」会很容易被看漏。
 */
export default function FlowEditor() {
  const {
    flowEditorOpen,
    flowEditorFlowId,
    openFlowEditor,
    flows,
    stages,
    addFlow,
    renameFlow,
    removeFlow,
    makeFlowDefault,
    addStage,
    editStage,
    removeStage,
    reorderStage,
  } = useStore();

  const [currentId, setCurrentId] = useState<string | null>(flowEditorFlowId);
  const [error, setError] = useState<string | null>(null);
  const [newStage, setNewStage] = useState("");
  const [newFlow, setNewFlow] = useState("");
  const [addingFlow, setAddingFlow] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");

  // 打开时定位到请求的那套流程；它被删掉时退到第一套
  useEffect(() => {
    if (!flowEditorOpen) return;
    setError(null);
    setCurrentId((prev) => {
      const want = flowEditorFlowId ?? prev;
      if (want && flows.some((f) => f.id === want)) return want;
      return flows[0]?.id ?? null;
    });
  }, [flowEditorOpen, flowEditorFlowId, flows]);

  if (!flowEditorOpen) return null;

  const flow = flows.find((f) => f.id === currentId) ?? null;
  const flowStages = stages
    .filter((s) => s.flowId === currentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const guard = async (p: Promise<string | null>) => {
    const reason = await p;
    setError(reason);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 点背景关闭 */}
      <div className="absolute inset-0 bg-black/35" onClick={() => openFlowEditor(null)} />

      <div
        data-flow-editor=""
        className="relative flex h-[560px] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.28)]"
      >
        {/* 标题栏 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Flag size={15} className="text-primary" />
          <span className="text-[14px] font-medium">流程模板</span>
          <span className="rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim">
            {flows.length} 套
          </span>
          <div className="flex-1" />
          <button
            onClick={() => openFlowEditor(null)}
            title="关闭"
            className="grid size-7 place-items-center rounded text-fg-dim hover:bg-hover"
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div
            data-flow-error=""
            className="flex shrink-0 items-center gap-2 border-b border-line bg-[#fdf6e7] px-4 py-2 text-[12.5px] text-[#7a5406]"
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-[12px] hover:underline">
              知道了
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* 左栏：流程列表 */}
          <div className="flex w-[240px] shrink-0 flex-col border-r border-line">
            <div className="px-3 pt-3 pb-1.5 text-[11px] font-medium tracking-wide text-fg-dim">
              流程模板
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {flows.map((f) => {
                const active = f.id === currentId;
                const count = stages.filter((s) => s.flowId === f.id).length;
                return (
                  <button
                    key={f.id}
                    data-flow-item={f.id}
                    onClick={() => {
                      setCurrentId(f.id);
                      setError(null);
                    }}
                    className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                      active ? "bg-chip font-medium text-fg" : "text-fg-2 hover:bg-hover"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    {f.isDefault && (
                      <span
                        title="新建流程任务时默认选中这套"
                        className="shrink-0 rounded bg-[#e1f5ee] px-1.5 py-px text-[10px] text-[#0f6e56]"
                      >
                        默认
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] text-fg-dim">{count}</span>
                  </button>
                );
              })}

              {addingFlow ? (
                <div className="mt-1 flex items-center gap-1.5 rounded-md border border-primary bg-card px-2 py-1">
                  <input
                    autoFocus
                    value={newFlow}
                    data-new-flow=""
                    onChange={(e) => setNewFlow(e.target.value)}
                    placeholder="流程名称"
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && newFlow.trim()) {
                        await addFlow(newFlow);
                        setNewFlow("");
                        setAddingFlow(false);
                      }
                      if (e.key === "Escape") {
                        setNewFlow("");
                        setAddingFlow(false);
                      }
                    }}
                    className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
                  />
                </div>
              ) : (
                <button
                  onClick={() => setAddingFlow(true)}
                  data-add-flow=""
                  className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-dim hover:bg-hover"
                >
                  <Plus size={14} />
                  新建流程
                </button>
              )}
            </div>
          </div>

          {/* 右栏：阶段编辑 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!flow ? (
              <div className="grid flex-1 place-items-center text-[13px] text-fg-dim">
                左边选一套流程
              </div>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
                  {editingName ? (
                    <input
                      autoFocus
                      value={draftName}
                      data-flow-name-input=""
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={async () => {
                        if (draftName.trim() && draftName !== flow.name) {
                          await renameFlow(flow.id, draftName);
                        }
                        setEditingName(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setEditingName(false);
                      }}
                      className="min-w-0 flex-1 rounded border border-primary bg-card px-1.5 py-0.5 text-[13.5px] outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        setEditingName(true);
                        setDraftName(flow.name);
                      }}
                      title="点击改名"
                      data-flow-name=""
                      className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[13.5px] font-medium hover:bg-hover"
                    >
                      {flow.name}
                    </button>
                  )}

                  {!flow.isDefault && (
                    <button
                      onClick={() => void makeFlowDefault(flow.id)}
                      data-make-default=""
                      title="设为新建流程任务时默认选择的流程"
                      className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[12px] text-fg-3 hover:bg-hover"
                    >
                      <Star size={12} />
                      设为默认
                    </button>
                  )}
                  <button
                    onClick={() => void guard(removeFlow(flow.id))}
                    data-remove-flow=""
                    title="删除这套流程"
                    className="grid size-7 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <div className="px-4 pt-3 text-[11px] font-medium tracking-wide text-fg-dim">
                  过程态序列（从上到下就是流程任务要走的顺序）
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                  {flowStages.map((s, i) => (
                    <StageRow
                      key={s.id}
                      name={s.name}
                      color={s.color}
                      isTerminal={s.isTerminal}
                      defaultMinutes={s.defaultMinutes}
                      first={i === 0}
                      last={i === flowStages.length - 1}
                      only={flowStages.length === 1}
                      index={i}
                      onRename={(v) => void editStage(s.id, { name: v })}
                      onColor={(c) => void editStage(s.id, { color: c })}
                      onToggleTerminal={() => void editStage(s.id, { isTerminal: !s.isTerminal })}
                      onMinutes={(v) => void editStage(s.id, { defaultMinutes: v })}
                      onUp={() => void reorderStage(s.id, -1)}
                      onDown={() => void reorderStage(s.id, 1)}
                      onRemove={() => void guard(removeStage(s.id))}
                    />
                  ))}

                  <div className="mt-1 flex items-center gap-2 rounded-lg border border-dashed border-line px-2.5 py-1.5">
                    <Plus size={14} className="shrink-0 text-fg-dim" />
                    <input
                      value={newStage}
                      data-new-stage=""
                      onChange={(e) => setNewStage(e.target.value)}
                      placeholder="新增过程态，回车确认"
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && newStage.trim()) {
                          await addStage(flow.id, newStage);
                          setNewStage("");
                        }
                      }}
                      className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-fg-dim"
                    />
                  </div>
                </div>

                <div className="shrink-0 border-t border-line px-4 py-2.5 text-[11.5px] leading-relaxed text-fg-dim">
                  从上到下就是流程任务要走的顺序。<span className="text-fg-3">终态</span>
                  的那一步走到即算流程任务完结，其余都只是途经；一套流程可以有多步终态
                  （比如「已完成」和「已取消」）。被流程任务占用的步骤和流程删不掉 ——
                  静默把流程任务挪走会让它的流转记录对不上。
                  <br />
                  <span className="text-fg-3">默认时效</span>
                  是这一步「给多久」：推进到这一步时会按它自动设好处理时效（到下一步之前），
                  建单后仍可单独改；0 或留空表示不限时，这类单子不会到期提醒。
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- 阶段行 -------------------------------- */

function StageRow({
  name,
  color,
  isTerminal,
  defaultMinutes,
  first,
  last,
  only,
  index,
  onRename,
  onColor,
  onToggleTerminal,
  onMinutes,
  onUp,
  onDown,
  onRemove,
}: {
  name: string;
  color: string;
  isTerminal: boolean;
  defaultMinutes: number;
  first: boolean;
  last: boolean;
  only: boolean;
  index: number;
  onRename: (v: string) => void;
  onColor: (c: string) => void;
  onToggleTerminal: () => void;
  onMinutes: (v: number) => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(name);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 时效用文本态：输入过程中会出现 ""、"-"、"" 这类不能当数字提交的中间值，
  // 直接拿 number 受控会很别扭
  const [mins, setMins] = useState(defaultMinutes > 0 ? String(defaultMinutes) : "");
  useEffect(() => setText(name), [name]);
  useEffect(() => setMins(defaultMinutes > 0 ? String(defaultMinutes) : ""), [defaultMinutes]);

  const commitMins = () => {
    const n = Math.max(0, Math.floor(Number(mins) || 0));
    setMins(n > 0 ? String(n) : "");
    if (n !== defaultMinutes) onMinutes(n);
  };

  return (
    <div
      data-stage-row={name}
      className="group mb-1 flex items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5"
    >
      <span className="w-4 shrink-0 text-center font-mono text-[11px] text-fg-dim">
        {index + 1}
      </span>

      {/* 颜色：点开一块调色板 */}
      <div className="relative shrink-0">
        <button
          onClick={() => setPaletteOpen((v) => !v)}
          title="换颜色"
          data-stage-color={color}
          className="block size-4 rounded-[4px] border border-black/10"
          style={{ background: color }}
        />
        {paletteOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPaletteOpen(false)} />
            <div className="absolute top-6 left-0 z-50 flex w-[132px] flex-wrap gap-1.5 rounded-lg border border-line bg-card p-2 shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
              {STAGE_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    onColor(c);
                    setPaletteOpen(false);
                  }}
                  className="grid size-5 place-items-center rounded-[4px] border border-black/10"
                  style={{ background: c }}
                >
                  {c === color && <Check size={11} className="text-white" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <input
        value={text}
        data-stage-name-input=""
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim();
          if (t && t !== name) onRename(t);
          else setText(name);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(name);
            e.currentTarget.blur();
          }
        }}
        className="min-w-0 flex-1 border-0 bg-transparent px-1 text-[13px] text-fg-2 outline-none focus:bg-hover"
      />

      <button
        onClick={onToggleTerminal}
        data-stage-terminal={isTerminal ? "1" : "0"}
        title={isTerminal ? "终态：走到这里流程任务算完结" : "非终态：只是途经的一步"}
        className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
          isTerminal ? "bg-[#e1f5ee] text-[#0f6e56]" : "text-fg-dim hover:bg-hover"
        }`}
      >
        <Flag size={11} />
        {isTerminal ? "终态" : "途经"}
      </button>

      {/* 默认时效：走到这一步"给多久"。0 / 留空 = 不限时。
          它算的是**下一步之前**的时间，所以推进时按目标步的取值重设 */}
      <label
        title="推进到这一步时，自动按这个时长设处理时效（0 或留空 = 不限时）"
        className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-fg-dim hover:bg-hover"
      >
        <Timer size={11} />
        <input
          value={mins}
          data-stage-minutes=""
          inputMode="numeric"
          onChange={(e) => setMins(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={commitMins}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setMins(defaultMinutes > 0 ? String(defaultMinutes) : "");
              e.currentTarget.blur();
            }
          }}
          placeholder="0"
          className={`w-7 border-0 bg-transparent text-right text-[11px] outline-none placeholder:text-fg-dim focus:bg-hover ${
            defaultMinutes > 0 ? "text-fg-3" : "text-fg-dim"
          }`}
        />
        <span>分</span>
      </label>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onUp}
          disabled={first}
          data-stage-up=""
          title="上移"
          className="grid size-6 place-items-center rounded text-fg-dim hover:bg-hover disabled:opacity-25 disabled:hover:bg-transparent"
        >
          <ChevronUp size={13} />
        </button>
        <button
          onClick={onDown}
          disabled={last}
          data-stage-down=""
          title="下移"
          className="grid size-6 place-items-center rounded text-fg-dim hover:bg-hover disabled:opacity-25 disabled:hover:bg-transparent"
        >
          <ChevronDown size={13} />
        </button>
        <button
          onClick={onRemove}
          disabled={only}
          data-stage-remove=""
          title={only ? "流程至少要有一步" : "删除这一步"}
          className="grid size-6 place-items-center rounded text-fg-dim hover:bg-danger-soft hover:text-danger disabled:opacity-25 disabled:hover:bg-transparent"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
