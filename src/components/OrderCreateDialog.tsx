import { useEffect, useMemo, useState } from "react";
import {
  X,
  ClipboardList,
  Star,
  Settings2,
  AlertTriangle,
  Timer,
  Plus,
  Trash2,
} from "lucide-react";
import { useStore } from "../store";
import { addDays, today, nextOrderNo } from "../lib/repo";
import { SETTINGS, parseSpecialEnabled } from "../lib/settings";
import { DUE_PRESETS, dueAtText } from "../lib/due";
import { COURIERS, courierName, detectCourier } from "../lib/couriers";
import type { WorkOrderKind } from "../types";
import DateTimePicker from "./DateTimePicker";

/**
 * 新建流程任务：一次把参数填全。
 *
 * 之前是「底部输入标题回车 → 建出一张只有标题的单 → 再回右侧详情补流程/日期/备注」，
 * 问题是那张半成品单**已经落库并出现在列表里**了 —— 手一抖回车，列表里就多一条
 * 得再点进去删的垃圾数据。开流程任务本来就不是一件"随手记一笔"的事，
 * 所以这里走弹窗：填完再建，取消就什么都不留。
 *
 * 单号留空仍会自动生成（WO-YYYYMMDD-NNN），填了就用填的。
 */
export default function OrderCreateDialog({
  initialTitle = "",
  initialNo = "",
  initialKind = "normal",
  onClose,
  onCreated,
}: {
  /** 底部输入框里已经打的字，带进来免得重打一遍 */
  initialTitle?: string;
  /**
   * 底部输入框里的字该落到哪个字段上。
   *
   * 在「特殊单号」视图里，人在那个框里粘的是**快递单号**（那是这类单子的起点），
   * 不是标题 —— 同一个输入框，两种视图下语义不同，所以由调用方决定往哪灌。
   */
  initialNo?: string;
  /** 按哪种单来开：从「特殊单号」视图进来就是 special */
  initialKind?: WorkOrderKind;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const {
    flows,
    stages,
    allWoFields,
    orders,
    createOrder,
    openFlowEditor,
    openOrder,
    settings,
  } = useStore();

  const specialOn = parseSpecialEnabled(settings[SETTINGS.specialEnabled]);

  /**
   * 关掉「特殊单号」后不该还能开出这类单子。
   *
   * initialKind 由调用方（从哪个视图点进来的）决定，关掉后那个视图本来就不该
   * 存在，但这里仍要自己挡一道：一个过期的调用点、或者以后新加的入口，
   * 就能绕过开关造出一张界面上再也看不见的单。
   */
  const [kind, setKind] = useState<WorkOrderKind>(
    initialKind === "special" && !specialOn ? "normal" : initialKind,
  );
  const [title, setTitle] = useState(initialTitle);
  const [no, setNo] = useState(initialNo);
  const [autoNo, setAutoNo] = useState("");
  const [flowId, setFlowId] = useState("");
  const [stageId, setStageId] = useState("");
  const [startDate, setStartDate] = useState(today());
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [important, setImportant] = useState(false);
  const [note, setNote] = useState("");
  /** 处理时效（ISO）。空字符串表示还没设 */
  const [stageDueAt, setStageDueAt] = useState("");
  /** 用户是否手动碰过时效。碰过之后换过程态就不再自动覆盖 */
  const [dueTouched, setDueTouched] = useState(false);
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
  /**
   * 用户**手动指定**的快递商。空串 = 跟着识别结果走。
   *
   * 只存"手动指定"的那一半：自动识别是每次算的，把猜测结果存进库里，
   * 以后规则修好了老数据也还是错的。
   */
  const [courierCode, setCourierCode] = useState("");

  const isSpecial = kind === "special";

  /** 当前单号认出来是谁家的（不落库，只用来显示与兜底） */
  const guess = useMemo(
    () => (isSpecial ? detectCourier(no) : null),
    [isSpecial, no],
  );

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

  /**
   * 同一个快递单号是不是已经登记过。
   *
   * 只**提醒**不拦：同一张单隔两周又出问题、需要再记一张是完全正常的，
   * 硬拦下来反而逼着人去改单号。但"我到底登记过没有"是翻记录时最常问的一句，
   * 顺手答掉能省一次搜索。
   */
  const duplicate = useMemo(() => {
    const n = no.trim().toLowerCase();
    if (!isSpecial || !n) return null;
    return (
      orders.find((o) => o.kind === "special" && o.no.trim().toLowerCase() === n) ?? null
    );
  }, [no, isSpecial, orders]);

  // 流程是异步加载的，第一次渲染时可能还没有。等它到了再定默认，
  // 而不是在 useState 初始值里赌一把 —— 那样首次打开会停在空选项上。
  //
  // 特殊单号优先选名字里带"特殊单号"的那套流程（首次运行会种一套，
  // 它的过程态带着默认时效）；没有就退回默认流程，不硬造一套出来。
  useEffect(() => {
    if (flowId || !flows.length) return;
    const preferred = isSpecial ? flows.find((f) => f.name.includes("特殊单号")) : undefined;
    setFlowId((preferred ?? flows.find((f) => f.isDefault) ?? flows[0]).id);
  }, [flows, flowId, isSpecial]);

  // 换流程后原来选的过程态多半不存在了。这里不写 effect 去重置，
  // 而是每次渲染算一个"有效值"——少了来回 setState，也不会闪一下错值。
  const effectiveStageId =
    stageId && flowStages.some((s) => s.id === stageId) ? stageId : (flowStages[0]?.id ?? "");

  const effectiveStage = flowStages.find((s) => s.id === effectiveStageId);

  /**
   * 把这一步的默认时效带进输入框。
   *
   * 只在用户**没手动碰过**时效时覆盖：他要是先把手填的 10 分钟填好了，
   * 再回头换个过程态就把输入冲掉，那是很讨厌的行为。
   */
  useEffect(() => {
    if (!isSpecial || dueTouched) return;
    const min = effectiveStage?.defaultMinutes ?? 0;
    setStageDueAt(min > 0 ? new Date(Date.now() + min * 60_000).toISOString() : "");
    // effectiveStage 每次渲染都是新算出来的对象，依赖它的两个字段就够了
  }, [isSpecial, dueTouched, effectiveStage?.id, effectiveStage?.defaultMinutes]);

  // 单号占位符显示"不填会是什么"，比写一句"留空自动生成"有用得多。
  // 特殊单号的单号就是快递单号（不自动编号），所以这里不必去算那个号。
  useEffect(() => {
    if (isSpecial) return;
    let alive = true;
    void nextOrderNo().then((v) => {
      if (alive) setAutoNo(v);
    });
    return () => {
      alive = false;
    };
  }, [isSpecial]);

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
    const orderNo = no.trim();

    if (isSpecial) {
      // 起点是快递单号，没有它就无从对账 —— 这里不要自动生成一个 WO- 号顶上，
      // 那只会让人以为"随便填也行"
      if (!orderNo) {
        setError("特殊单号以快递单号为起点，这一项必填");
        return;
      }
      // 时效是这类单子的意义所在：没有时效，"等不起"就无从谈起，
      // 它也就退化成了一张普通流程任务。宁可拦在这里，也不要悄悄建一张没时效的
      // ——那种单子不会提醒、排序也排在最后，等于白建。
      if (!stageDueAt) {
        setError("特殊单号必须填处理时效（到下一步之前还剩多久）");
        return;
      }
    } else if (!t) {
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
        // 特殊单号允许留空标题，退化成快递单号 —— 这类单子本来就是靠号认的
        title: t || (isSpecial ? orderNo : ""),
        no: orderNo || undefined,
        kind,
        flowId,
        stageId: effectiveStageId,
        startDate,
        dueDate,
        stageDueAt: isSpecial ? stageDueAt : null,
        important,
        note: note.trim(),
        // 只存用户手动指定的那次；留空表示"以后按单号自动识别"
        courier: courierCode || undefined,
        // 建单时就一起绑上。分两步（先建单、再回详情里一条条加）
        // 在连着登记好几张单的时候格外烦
        fields: isSpecial ? fields : undefined,
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
          {isSpecial ? (
            <Timer size={15} className="text-[#d85a30]" />
          ) : (
            <ClipboardList size={15} className="text-[#378add]" />
          )}
          <span className="text-[14px] font-medium">
            {isSpecial ? "登记特殊单号" : "新建流程任务"}
          </span>
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
            className="flex shrink-0 items-center gap-2 border-b border-line bg-[#fdf6e7] px-4 py-2 text-[12.5px] text-[#7a5406]"
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
          {/* 类型：普通流程任务 / 特殊单号。跟着进入时的视图预选，
              但仍然留在这里可切 —— 建错类型不用关掉重开一遍。

              模块关掉时整条切换栏收掉：只剩一项可选时，一个点了也不会有
              别的结果的 tab，比没有它更让人困惑。 */}
          {specialOn && (
            <div className="mb-3 flex items-center rounded-lg bg-chip p-0.5">
              <KindTab
                active={!isSpecial}
                onClick={() => setKind("normal")}
                icon={<ClipboardList size={12} />}
                label="普通流程任务"
                kind="normal"
                accent="#378add"
              />
              <KindTab
                active={isSpecial}
                onClick={() => setKind("special")}
                icon={<Timer size={12} />}
                label="特殊单号"
                kind="special"
                accent="#d85a30"
              />
            </div>
          )}

          {/* 特殊单号的起点：快递单号。它就是这张单的单号，所以排在最前面 */}
          {isSpecial && (
            <Field label="快递单号（起点）" required>
              <input
                autoFocus
                value={no}
                onChange={(e) => setNo(e.target.value)}
                data-oc-no=""
                placeholder="粘贴快递单号"
                className="w-full rounded-lg border border-line bg-card px-2.5 py-2 font-mono text-[13.5px] text-fg outline-none placeholder:font-sans placeholder:text-fg-dim focus:border-[#d85a30]"
              />
            </Field>
          )}

          {/* 快递商：自动识别 + 认错了能改一次。
              识别结果**不落库**（只在库里记"手动指定过谁"），
              所以规则以后修好了，这批老数据也会跟着变对 */}
          {isSpecial && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span
                data-oc-courier-guess={guess?.code ?? ""}
                className="shrink-0 text-[11.5px] text-fg-dim"
              >
                {!no.trim()
                  ? "粘贴单号后自动识别快递商"
                  : guess
                    ? `${guess.certain ? "识别为" : "可能是"} ${courierName(guess.code)}${
                        !guess.certain && guess.candidates.length > 1
                          ? `（也可能是 ${guess.candidates
                              .slice(1, 3)
                              .map((c) => courierName(c))
                              .join(" / ")}）`
                          : ""
                      }`
                    : "没认出是哪家，可手动指定"}
              </span>
              <select
                value={courierCode}
                onChange={(e) => setCourierCode(e.target.value)}
                data-oc-courier=""
                title="认错了就在这里改一次，改完按你说的算"
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11.5px] text-fg-2 outline-none"
              >
                <option value="">
                  {guess ? `跟随识别（${courierName(guess.code)}）` : "跟随识别"}
                </option>
                {COURIERS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 重复登记提醒：不拦，但给一条直接去那张单的路 */}
          {isSpecial && duplicate && (
            <div
              data-oc-dup=""
              className="mt-1 flex items-center gap-1.5 rounded-md bg-[#fdf6e7] px-2 py-1 text-[11.5px] text-[#7a5406]"
            >
              <AlertTriangle size={12} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                这个单号已经登记过（
                {stages.find((s) => s.id === duplicate.stageId)?.name ?? "未知步骤"}
                {duplicate.closed ? " · 已完结" : ""}）
              </span>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  openOrder(duplicate.id);
                }}
                data-oc-dup-open=""
                className="shrink-0 rounded px-1.5 py-0.5 hover:bg-[#f5e6c8]"
              >
                打开那条
              </button>
            </div>
          )}

          {/* 标题 */}
          <Field label="标题" required={!isSpecial}>
            <input
              autoFocus={!isSpecial}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-oc-title=""
              placeholder={isSpecial ? "留空就用快递单号当标题" : "这张单要解决什么"}
              className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13.5px] text-fg outline-none placeholder:text-fg-dim focus:border-[#378add]"
            />
          </Field>

          {/* 单号。特殊单号的单号就是上面那个快递单号，这里不再问第二遍 */}
          {!isSpecial && (
            <Field label="单号">
              <input
                value={no}
                onChange={(e) => setNo(e.target.value)}
                data-oc-no=""
                placeholder={autoNo ? `留空自动生成 ${autoNo}` : "留空自动生成"}
                className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-fg-2 outline-none placeholder:text-fg-dim focus:border-[#378add]"
              />
            </Field>
          )}

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
                  className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
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
                  className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
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

          {/* 处理时效 —— 特殊单号的核心参数，所以紧跟在流程后面，
              不和日期挤在一起（它俩是两件事：日期是"什么时候交"，
              时效是"这一步到下一步之前还剩多久"） */}
          {isSpecial && (
            <Field label="处理时效（到下一步之前）" required>
              <div className="mt-1 flex flex-wrap items-center gap-1.5" data-oc-due-presets="">
                {DUE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    data-oc-due-preset={p.label}
                    onClick={() => {
                      setDueTouched(true);
                      setStageDueAt(p.at(Date.now()));
                    }}
                    className="rounded-md border border-line bg-card px-2 py-1 text-[12px] text-fg-3 hover:bg-hover"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <DateTimePicker
                    mode="datetime"
                    value={stageDueAt || null}
                    onChange={(v) => {
                      setDueTouched(true);
                      setStageDueAt(v ?? "");
                    }}
                    align="right"
                    inputAttrs={{ "data-oc-due-input": "" }}
                    inputClassName="min-w-0 flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-[12.5px] text-fg-2 outline-none hover:bg-hover focus:bg-hover"
                  />
                </div>
                {stageDueAt && (
                  <button
                    type="button"
                    data-oc-due-clear=""
                    onClick={() => {
                      setDueTouched(true);
                      setStageDueAt("");
                    }}
                    title="清空时效"
                    className="grid size-7 shrink-0 place-items-center rounded text-fg-dim hover:bg-danger-soft hover:text-danger"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <div className="mt-1 px-0.5 text-[11.5px] text-fg-dim">
                {stageDueAt
                  ? `时效至 ${dueAtText(stageDueAt)}`
                  : "还没设时效 —— 没有时效的特殊单号不会提醒，排序也排在最后"}
                {effectiveStage && effectiveStage.defaultMinutes > 0 && !dueTouched
                  ? ` · 沿用「${effectiveStage.name}」的默认时效 ${effectiveStage.defaultMinutes} 分钟`
                  : ""}
              </div>
            </Field>
          )}

          {/* 相关信息：字段名由用户定，所以这里只是几行"名字 + 值" */}
          {isSpecial && (
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
          )}

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
              className="mt-1.5 w-full resize-none rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] leading-relaxed text-fg-2 outline-none placeholder:text-fg-dim focus:border-[#378add]"
            />
          </Field>

          {/* 重要 + 去编辑流程 */}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setImportant((v) => !v)}
              data-oc-important=""
              className={`flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[13px] transition-colors ${
                important ? "bg-card font-medium text-[#ba7517]" : "text-fg-3 hover:bg-card"
              }`}
            >
              <Star size={15} fill={important ? "#ba7517" : "none"} />
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
            {flows.length === 0
              ? "还没有任何流程，先去「编辑流程」建一套"
              : isSpecial
                ? "回车即可登记"
                : "回车即可创建"}
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
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-50 ${
              isSpecial ? "bg-[#d85a30]" : "bg-[#378add]"
            }`}
          >
            {busy ? "创建中…" : isSpecial ? "登记单号" : "创建流程任务"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * 类型切换钮。跟列表顶部那排 segmented 控件同源：选中态用浅色底 + 主色字，
 * 不整块反白 —— 反白在两个选项并排时会显得很重。
 */
function KindTab({
  active,
  onClick,
  icon,
  label,
  kind,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  /**
   * 自动化验证用的稳定标识。
   *
   * 不拿 label 顶，理由同 TaskList 的 ComposeTab：界面文案是会变的
   * （「工单」刚改成了「流程任务」），拿文案当选择器，等于每改一个字就弄红一批用例。
   */
  kind: WorkOrderKind;
  accent: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-oc-kind={kind}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] transition-colors ${
        active ? "bg-panel font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]" : "text-fg-3 hover:text-fg-2"
      }`}
      style={active ? { color: accent } : undefined}
    >
      {icon}
      {label}
    </button>
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
          value === t ? "bg-[#378add] text-white" : "text-fg-3 hover:bg-hover"
        }`}
      >
        今天
      </button>
      <button
        type="button"
        onClick={() => onChange(addDays(t, 1))}
        className={`rounded px-1.5 py-0.5 text-[12px] ${
          value === addDays(t, 1) ? "bg-[#378add] text-white" : "text-fg-3 hover:bg-hover"
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
