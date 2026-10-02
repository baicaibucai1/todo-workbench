import { SectionTitle, Card, FieldRow, Switch } from "./parts";
import type { Flash } from "./parts";
import { useState } from "react";
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  GripVertical,
  RotateCcw,
} from "lucide-react";
import {
  parseUrgentMinutes,
  SETTINGS,
  STARTUP_VIEWS,
  URGENT_MINUTES,
  URGENT_PRESETS,
} from "../../lib/settings";
import {
  isEnabled,
  selectable,
  togglePatch,
} from "../../lib/extensions/registry";
import {
  notifyPermission,
  requestNotifyPermission,
} from "../../lib/notify";
import {
  DEFAULT_DETAIL_SECTIONS,
  DETAIL_SECTIONS,
  moveDetailSection,
  parseDetailSections,
  placeDetailSection,
  type DetailSectionId,
} from "../../lib/detailSections";

/* ------------------------------ 分区：行为偏好 ------------------------------ */

export function BehaviorSection({
  settings,
  saveSettings,
  say,
  onRollover,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  say: (text: string, tone?: Flash["tone"]) => void;
  onRollover: () => Promise<void>;
}) {
  const startup = settings[SETTINGS.startupView] ?? "myday";
  const sidebarDefault = (settings[SETTINGS.sidebarOpen] ?? "1") !== "0";
  // 缺键按"关"处理：与 SETTINGS.seedSampleData 的默认值同一个方向。
  // ⚠️ 不能写成 `!== "0"`（那是"默认开"的写法），这里只有显式 "1" 才算开
  const sampleData = settings[SETTINGS.seedSampleData] === "1";
  const reminderOn = (settings[SETTINGS.reminderEnabled] ?? "1") !== "0";
  const systemNotify = (settings[SETTINGS.reminderSystem] ?? "0") === "1";
  const snooze = settings[SETTINGS.reminderSnooze] ?? "10";
  const urgentMinutes = parseUrgentMinutes(settings[SETTINGS.urgentMinutes]);
  // 详情面板的分区顺序：拖拽中的两块要单独记住，松手才知道"移到哪儿去"
  const detailOrder = parseDetailSections(settings[SETTINGS.detailSectionOrder]);
  const [dragId, setDragId] = useState<DetailSectionId | null>(null);
  const [hoverId, setHoverId] = useState<DetailSectionId | null>(null);

  const commitDetailOrder = (next: DetailSectionId[]) =>
    void saveSettings({ [SETTINGS.detailSectionOrder]: JSON.stringify(next) });
  // 档位里没有当前值时（用户自定义过）才算"自定义"，否则下拉会莫名跳到那一档
  const urgentIsPreset = URGENT_PRESETS.some((p) => p.minutes === urgentMinutes);
  const [urgentCustom, setUrgentCustom] = useState(String(urgentMinutes));
  /**
   * 是否正在用自定义输入。
   *
   * 这是个**独立于设置值的状态**：选「自定义…」只是想换个输入方式，
   * 不该顺手把阈值改掉 —— 那样用户还没输入就先看到界面跳了一下。
   * 所以下拉显示什么由它决定，而不是由"当前值在不在档位里"决定。
   */
  const [urgentCustomMode, setUrgentCustomMode] = useState(!urgentIsPreset);
  const [permission, setPermission] = useState(() => notifyPermission());

  const commitUrgentCustom = () => {
    const v = parseUrgentMinutes(urgentCustom);
    setUrgentCustom(String(v));
    void saveSettings({ [SETTINGS.urgentMinutes]: String(v) });
    // 填的数字正好落在某个档位上时退回下拉显示 —— 否则下拉会一直停在
    // 「自定义…」，而旁边明明写着"1 小时"，看着像没保存上
    if (URGENT_PRESETS.some((p) => p.minutes === v)) setUrgentCustomMode(false);
  };

  const enableSystemNotify = async (on: boolean) => {
    if (!on) {
      await saveSettings({ [SETTINGS.reminderSystem]: "0" });
      return;
    }
    const p = await requestNotifyPermission();
    setPermission(p);
    if (p === "granted") {
      await saveSettings({ [SETTINGS.reminderSystem]: "1" });
    } else {
      // 拿不到授权就别把开关打开，否则用户以为开了、其实永远不会有通知
      await saveSettings({ [SETTINGS.reminderSystem]: "0" });
      say(
        `系统通知未授权（${p === "unsupported" ? "此环境不支持" : "已被拒绝"}）`,
        "err",
      );
    }
  };

  return (
    <div className="max-w-[520px]">
      <SectionTitle title="行为偏好" desc="决定应用打开时的样子。" />

      <Card>
        <FieldRow label="启动视图" hint="下次启动工作台时默认打开这个视图">
          <select
            value={startup}
            data-act="startup-view"
            onChange={(e) => void saveSettings({ [SETTINGS.startupView]: e.target.value })}
            className="w-[160px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-primary"
          >
            {STARTUP_VIEWS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </FieldRow>

        <div className="my-3 border-t border-line" />

        <FieldRow
          label="默认展开侧边栏"
          hint="关闭后每次启动都是窄侧边栏，可用标题栏的按钮展开"
        >
          <Switch
            on={sidebarDefault}
            onToggle={() =>
              void saveSettings({ [SETTINGS.sidebarOpen]: sidebarDefault ? "0" : "1" })
            }
          />
        </FieldRow>

        <div className="my-3 border-t border-line" />

        {/*
          示例数据默认关。打开它**不会**立刻种一份进来 —— 播种只在"库是空的"
          那一次发生（见 repo 的 seed*IfEmpty）。所以这个开关的实际语义是
          "下次库空的时候要不要填"，hint 必须把这件事说清楚，否则用户按了
          没反应会以为坏了。
        */}
        <FieldRow
          label="填入示例数据"
          hint={
            sampleData
              ? "库里为空时会填入两个清单、几条示例待办与两张示例流程任务"
              : "已关闭。开启后仅在库为空时填入，不会动你现有的数据"
          }
        >
          <Switch
            on={sampleData}
            onToggle={() =>
              void saveSettings({ [SETTINGS.seedSampleData]: sampleData ? "0" : "1" })
            }
            testId="seed-sample-data"
          />
        </FieldRow>
      </Card>

      <div className="mt-5">
        <SectionTitle title="提醒" desc="到点的任务会在右下角弹出卡片，可直接完成或推迟。" />
        <Card>
          <FieldRow label="启用提醒" hint="关闭后不再扫描提醒时间，已设的时间会保留">
            <Switch
              on={reminderOn}
              onToggle={() =>
                void saveSettings({ [SETTINGS.reminderEnabled]: reminderOn ? "0" : "1" })
              }
            />
          </FieldRow>

          <div className="my-3 border-t border-line" />

          <FieldRow
            label="系统通知"
            hint={
              permission === "granted"
                ? "已授权，提醒会同时发一条系统通知"
                : permission === "denied"
                  ? "已被拒绝，需在浏览器或系统设置里重新允许"
                  : "开启时会向系统申请通知权限"
            }
          >
            <Switch on={systemNotify} onToggle={() => void enableSystemNotify(!systemNotify)} />
          </FieldRow>

          <div className="my-3 border-t border-line" />

          <FieldRow label="推迟时长" hint="点「稍后」后多久再提醒一次">
            <select
              value={snooze}
              data-act="snooze-minutes"
              onChange={(e) => void saveSettings({ [SETTINGS.reminderSnooze]: e.target.value })}
              className="w-[110px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-primary"
            >
              {["5", "10", "30", "60"].map((m) => (
                <option key={m} value={m}>
                  {m} 分钟
                </option>
              ))}
            </select>
          </FieldRow>
        </Card>
      </div>

      <div className="mt-5">
        <SectionTitle
          title="紧急时间"
          desc="剩下的时间不足这个值时，待办与流程任务会自动出现在侧边栏底部的「紧急」里。"
        />
        <Card>
          <FieldRow
            label="提前多久算紧急"
            hint="待办看提醒时间或到期日，流程任务看当前步骤的时效或交付日"
          >
            <select
              value={urgentCustomMode ? "custom" : String(urgentMinutes)}
              data-act="urgent-minutes"
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") {
                  // 只是切换输入方式，不落库 —— 见 urgentCustomMode 的说明
                  setUrgentCustom(String(urgentMinutes));
                  setUrgentCustomMode(true);
                  return;
                }
                setUrgentCustomMode(false);
                void saveSettings({ [SETTINGS.urgentMinutes]: v });
              }}
              className="w-[110px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-primary"
            >
              {URGENT_PRESETS.map((p) => (
                <option key={p.minutes} value={String(p.minutes)}>
                  {p.label}
                </option>
              ))}
              <option value="custom">自定义…</option>
            </select>
          </FieldRow>

          {urgentCustomMode && (
            <>
              <div className="my-3 border-t border-line" />
              <FieldRow
                label="自定义（分钟）"
                hint={`可选 ${URGENT_MINUTES.min} – ${URGENT_MINUTES.max} 分钟（约 14 天）`}
              >
                <input
                  type="number"
                  value={urgentCustom}
                  data-act="urgent-custom"
                  min={URGENT_MINUTES.min}
                  max={URGENT_MINUTES.max}
                  onChange={(e) => setUrgentCustom(e.target.value)}
                  onBlur={commitUrgentCustom}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  className="w-[110px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-primary"
                />
              </FieldRow>
            </>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <SectionTitle
          title="详情面板分区"
          desc="右侧详情里一条待办的各块，从上到下按这里的顺序显示。"
        />
        <Card>
          <div className="flex flex-col gap-1" data-detail-order="">
            {detailOrder.map((id, i) => {
              const label = DETAIL_SECTIONS.find((s) => s.id === id)?.label ?? id;
              // 只有"正拖着别人悬停在这一行"才染色，自己悬停自己没必要提示
              const isTarget = !!dragId && dragId !== id && hoverId === id;
              return (
                <div
                  key={id}
                  data-detail-order-row={id}
                  data-detail-order-index={i}
                  draggable
                  onDragStart={() => setDragId(id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setHoverId(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setHoverId(id);
                  }}
                  onDragLeave={() => setHoverId((h) => (h === id ? null : h))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId && dragId !== id) {
                      commitDetailOrder(placeDetailSection(detailOrder, dragId, id));
                    }
                    setDragId(null);
                    setHoverId(null);
                  }}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
                    isTarget ? "border-primary bg-hover" : "border-line bg-card"
                  } ${dragId === id ? "opacity-50" : ""}`}
                >
                  <GripVertical size={13} className="shrink-0 cursor-grab text-fg-dim" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">
                    {label}
                  </span>
                  {/* 按钮不是装饰：只有一条搬动路径的话，触屏和键盘用户就改不了了 */}
                  <button
                    onClick={() => commitDetailOrder(moveDetailSection(detailOrder, id, -1))}
                    disabled={i === 0}
                    data-act="detail-up"
                    title="上移"
                    className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover disabled:opacity-30"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    onClick={() => commitDetailOrder(moveDetailSection(detailOrder, id, 1))}
                    disabled={i === detailOrder.length - 1}
                    data-act="detail-down"
                    title="下移"
                    className="grid size-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-hover disabled:opacity-30"
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0 text-[11.5px] leading-relaxed text-fg-dim">
              拖把手或点箭头都可以，改完右侧详情立刻跟着变。
            </div>
            <button
              onClick={() => commitDetailOrder(DEFAULT_DETAIL_SECTIONS)}
              data-act="detail-order-reset"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12.5px] text-fg-3 hover:bg-hover"
            >
              <RotateCcw size={12} />
              恢复默认
            </button>
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <SectionTitle title="每日任务" desc="每日任务今天勾掉后，第二天会自动变回未完成。" />
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-[12.5px] leading-relaxed text-fg-dim">
              重置在每次打开应用和刷新数据时自动执行，不需要后台常驻。
            </div>
            <button
              onClick={() => void onRollover()}
              data-act="rollover"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] text-fg-3 hover:bg-hover"
            >
              <RefreshCw size={13} />
              立即检查
            </button>
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <SectionTitle
          title="选装模块"
          desc="默认都不带 —— 只有跟单、存素材这类专门玩法才需要。打开即生效，关掉只是从界面上收起，已经存下的数据仍留在数据库里。"
        />
        <Card>
          {/*
            这个列表由注册表长出来（selectable()），不是在这里一条条列的。
            加一个选装模块的代价因此只剩「去 registry 登记一条」——
            以前每加一个模块，这里要补一行、开关键要在 settings.ts 补一个、
            侧栏要加一句过滤，漏一处不报错，只是界面有一半不对。
            AI 助手被 selectable 排除：它开不开取决于有没有配 Key，不是这个开关。
          */}
          {selectable().map((ext) => {
            const on = isEnabled(settings, ext.id);
            return (
              <FieldRow key={ext.id} label={ext.name} hint={ext.description ?? ""}>
                <Switch
                  on={on}
                  onToggle={() => void saveSettings(togglePatch(settings, ext.id))}
                  testId={`${ext.id}-enabled`}
                />
              </FieldRow>
            );
          })}
        </Card>
      </div>
    </div>
  );
}
