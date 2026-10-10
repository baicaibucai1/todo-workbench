import { useEffect, useMemo, useState } from "react";
import {
  X,
  ClipboardList,
  Star,
  Settings2,
  AlertTriangle,
  Plus,
  Trash2,
} from "lucide-react";
import { useStore } from "../store";
import { addDays, today } from "../lib/repo";
import DateTimePicker from "./DateTimePicker";

/**
 * 新建流程任务：一次把参数填全。
 *
 * 之前是「底部输入标题回车 → 建出一张只有标题的单 → 再回右侧详情补流程/日期/备注」，
 * 问题是那张半成品单**已经落库并出现在列表里**了 —— 手一抖回车，列表里就多一条
 * 得再点进去删的垃圾数据。开流程任务本来就不是一件"随手记一笔"的事，
 * 所以这里走弹窗：填完再建，取消就什么都不留。
 *
 * 流程任务填的是「描述」而不是单号 —— 从 schema v13 起不再自动编号
 * （那个 WO- 号用户手上没有对应的单据，对不上账，见 types.ts）。
 * 「特殊单号」删掉后，快递单号与处理时效这两个入口也一并没了。
 */
export default function OrderCreateDialog({
  initialTitle = "",
  onClose,
  onCreated,
}: {
  /** 底部输入框里已经打的字，带进来免得重打一遍 */
  initialTitle?: string;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const {
    flows,
    stages,
    allWoFields,
    createOrder,
    openFlowEditor,
  } = useStore();

  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [flowId, setFlowId] = useState("");
  const [stageId, setStageId] = useState("");
  const [startDate, setStartDate] = useState(today());
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [important, setImportant] = useState(false);
  const [note, setNote] = useState("");
  /**
   * 建单时一起绑上的相关信息。
   *
   * 预置两行空行而不是一个"添加"按钮：这类单子几乎总是要绑点什么
   * （另一个快递单号、用户名），让人先点一次按钮再填是白多一步。
   * 空行提交时会被丢掉（见 repo.createWorkOrder），不会留在库里。
   */
  const [fields, setFields] = useState<Array<{ label: string; value: string }>>([
    { label: "", value: "" },
    { label: "", value: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowStages = useMemo(
    () =>
      stages
        .filter((s) => s.flowId === flowId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [stages, flowId],
  );

  /**
   * 相关信息的字段名候选：从**已经绑过的**那些里长出来，按用过的次数降序。
   *
   * 不做成一份"字段字典"让人先去别处维护：他登记时随手起的那些名字就是字典，
   * 再维护一份只会多出一处会和实际数据漂移的东西。
   */
  const labelOptions = useMemo(() => {
    const count = new Map<string, number>();
    for (const f of allWoFields) {
      const label = f.label.trim();
      if (label) count.set(label, (count.get(label) ?? 0) + 1);
    }
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24)
      .map(([label]) => label);
  }, [allWoFields]);


  // 流程是异步加载的，第一次渲染时可能还没有。等它到了再定默认，
  // 而不是在 useState 初始值里赌一把 —— 那样首次打开会停在空选项上。
  //
  // 第一次渲染时流程可能还没加载完。等它到了再定默认，
  // 而不是在 useState 初始值里赌一把 —— 那样首次打开会停在空选项上。
  useEffect(() => {
    if (flowId || !flows.length) return;
    setFlowId((flows.find((f) => f.isDefault) ?? flows[0]).id);
  }, [flows, flowId]);

  // 换流程后原来选的过程态多半不存在了。这里不写 effect 去重置，
  // 而是每次渲染算一个"有效值"——少了来回 setState，也不会闪一下错值。
  const effectiveStageId =
    stageId && flowStages.some((s) => s.id === stageId) ? stageId : (flowStages[0]?.id ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setFieldAt = (i: number, patch: Partial<{ label: string; value: string }>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((prev) => [...prev, { label: "", value: "" }]);
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    const t = title.trim();

    if (!t) {
      setError("流程任务标题不能为空");
      return;
    }

    if (!flowId || !effectiveStageId) {
      setError("还没有任何流程，先去「编辑流程」建一套");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createOrder({
        title: t,
        description: description.trim(),
        kind: "normal",
        flowId,
        stageId: effectiveStageId,
        startDate,
        dueDate,
        stageDueAt: null,
        important,
        note: note.trim(),
        // 建单时就一起绑上。分两步（先建单、再回详情里一条条加）
        // 在连着登记好几张单的时候格外烦。
        // 两种流程任务都支持 —— 字段名由用户定，宿主不预设一套。
        fields,
      });
      onCreated?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/35" onClick={onClose} />

      <form
        data-order-create=""
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="relative flex max-h-[88vh] w-[520px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.28)]"
      >
        {/* 标题栏 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <ClipboardList size={15} className="text-primary" />
          <span className="text-[14px] font-medium">新建流程任务</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            data-oc-cancel=""
            className="grid size-7 place-items-center rounded text-fg-dim hover:bg-hover"
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div
            data-oc-error=""
            className="flex shrink-0 items-center gap-2 border-b border-line bg-tip-bg px-4 py-2 text-[12.5px] text-tip-text"
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 text-[12px] hover:underline"
            >
              知道了
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* 「特殊单号」的类型切换、快递单号输入框、快递商识别、重复登记提醒
              这四块随该功能一起删除（2026-10-10）。删掉后这个弹窗
              只剩「普通流程任务」一种形态，不再有第二种种类的入口。 */}
          {/* 标题 */}
          <Field label="标题" required>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-oc-title=""
              placeholder="这张单要解决什么"
              className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13.5px] text-fg outline-none placeholder:text-fg-dim focus:border-primary"
            />
          </Field>

          {/* 描述。
              标题只有一行 —— 那是用来扫列表的，写长了会被截断；
              真正要交代清楚的（"空调不制冷，去年换过一次压缩机"）写在这里。 */}
          <Field label="描述">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-oc-desc=""
              rows={2}
              placeholder="这件事要办什么（可选；标题写不下的放这里）"
              className="mt-1.5 w-full resize-none rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] leading-relaxed text-fg-2 outline-none placeholder:text-fg-dim focus:border-primary"
            />
          </Field>

          {/* 流程 + 起始过程态。两个联动，放同一行省一次纵向滚动 */}
          <div className="mt-3 flex gap-2">
            <div className="min-w-0 flex-1">
              <Field label="流程" required>
                <select
                  value={flowId}
                  onChange={(e) => {
                    setFlowId(e.target.value);
                    setStageId("");
                  }}
                  data-oc-flow=""
                  className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
                >
                  {flows.length === 0 && <option value="">（还没有流程）</option>}
                  {flows.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label="起始过程态">
                <select
                  value={effectiveStageId}
                  onChange={(e) => setStageId(e.target.value)}
                  data-oc-stage=""
                  className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
                >
                  {flowStages.length === 0 && <option value="">（这套流程没有过程态）</option>}
                  {flowStages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {/* 把默认时效写在选项里：用户不用点进去才知道"这一步给多久" */}
                      {s.defaultMinutes > 0 ? `${s.name}（默认 ${s.defaultMinutes} 分钟）` : s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          {flows.length > 0 && flowStages.length > 0 && (
            <div className="mt-1 px-0.5 text-[11.5px] text-fg-dim">
              流转路径：{flowStages.map((s) => s.name).join(" → ")}
            </div>
          )}

          {/* 处理时效（到下一步之前）的输入框原来是特殊单号的核心参数，
              随该功能一起删除。普通流程任务不设时效，
              所以流程任务详情里那块「时效」也只在老数据上才看得到。 */}
          {/* 相关信息：字段名由用户定，所以这里只是几行"名字 + 值"。
              两种流程任务都开放 —— 它本来就是同一张表里的同一批单，
              给普通单单独砍掉这个能力，只会逼着人把键值对写进描述里去。 */}
          <Field label="相关信息（字段名自己定）">
              <div
                data-oc-fields=""
                className="mt-1 overflow-hidden rounded-lg border border-line bg-card"
              >
                {fields.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 border-b border-line px-1.5 py-1 last:border-0"
                  >
                    <input
                      value={f.label}
                      data-oc-field-label={i}
                      onChange={(e) => setFieldAt(i, { label: e.target.value })}
                      // 下拉里是以前用过的字段名："补发单号""客户"这类词每次重打一遍很烦
                      list="sp-field-labels"
                      placeholder={i === 0 ? "如 补发单号" : "字段名"}
                      className="w-[104px] shrink-0 rounded px-1 py-0.5 text-[12.5px] text-fg-2 outline-none placeholder:text-fg-dim focus:bg-panel"
                    />
                    <input
                      value={f.value}
                      data-oc-field-value={i}
                      onChange={(e) => setFieldAt(i, { value: e.target.value })}
                      placeholder="值"
                      className="min-w-0 flex-1 rounded px-1 py-0.5 font-mono text-[12.5px] text-fg-2 outline-none placeholder:font-sans placeholder:text-fg-dim focus:bg-panel"
                    />
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      title="删掉这一行"
                      className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <datalist id="sp-field-labels" data-oc-field-options="">
                {labelOptions.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={addField}
                data-oc-field-add=""
                className="mt-1 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-fg-3 hover:bg-hover"
              >
                <Plus size={12} />
                再加一行
              </button>
          </Field>

          {/* 日期 */}
          <div className="mt-3 flex gap-2">
            <div className="min-w-0 flex-1">
              <Field label="开始">
                <DateInput value={startDate} onChange={setStartDate} dataKey="data-oc-start" />
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label="交付">
                <DateInput
                  value={dueDate ?? ""}
                  onChange={(d) => setDueDate(d || null)}
                  dataKey="data-oc-due"
                  allowEmpty
                />
              </Field>
            </div>
          </div>

          {/* 备注 */}
          <Field label="备注">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-oc-note=""
              rows={3}
              placeholder="补充信息（可选）"
              className="mt-1.5 w-full resize-none rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] leading-relaxed text-fg-2 outline-none placeholder:text-fg-dim focus:border-primary"
            />
          </Field>

          {/* 重要 + 去编辑流程 */}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setImportant((v) => !v)}
              data-oc-important=""
              className={`flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[13px] transition-colors ${
                important ? "bg-card font-medium text-warn" : "text-fg-3 hover:bg-card"
              }`}
            >
              <Star size={15} fill={important ? "var(--color-warn)" : "none"} />
              {important ? "已标记为重要" : "标记为重要"}
            </button>

            <div className="flex-1" />

            <button
              type="button"
              onClick={() => {
                onClose();
                openFlowEditor(flowId || null);
              }}
              data-oc-edit-flows=""
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-fg-3 hover:bg-hover"
            >
              <Settings2 size={13} />
              编辑流程
            </button>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-dim">
            {flows.length === 0 ? "还没有任何流程，先去「编辑流程」建一套" : "回车即可创建"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-fg-3 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            data-oc-submit=""
            className="rounded-lg bg-primary px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {busy ? "创建中…" : "创建流程任务"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 flex items-center gap-1 text-[11.5px] font-medium tracking-wide text-fg-dim">
        {label}
        {required && <span className="text-danger">*</span>}
      </div>
      {children}
    </div>
  );
}

/** 日期：今天/明天快捷键 + 自绘日历。原生的弹层长相不受控，见 DateTimePicker 的注释 */
function DateInput({
  value,
  onChange,
  dataKey,
  allowEmpty,
}: {
  value: string;
  onChange: (d: string) => void;
  dataKey: string;
  allowEmpty?: boolean;
}) {
  const t = today();
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(t)}
        className={`rounded px-1.5 py-0.5 text-[12px] ${
          value === t ? "bg-primary text-white" : "text-fg-3 hover:bg-hover"
        }`}
      >
        今天
      </button>
      <button
        type="button"
        onClick={() => onChange(addDays(t, 1))}
        className={`rounded px-1.5 py-0.5 text-[12px] ${
          value === addDays(t, 1) ? "bg-primary text-white" : "text-fg-3 hover:bg-hover"
        }`}
      >
        明天
      </button>
      <div className="min-w-0 flex-1">
        <DateTimePicker
          mode="date"
          value={value || null}
          onChange={(v) => onChange(v ?? "")}
          align="right"
          inputAttrs={{ [dataKey]: "" }}
        />
      </div>
      {allowEmpty && value && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="清空"
          className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
