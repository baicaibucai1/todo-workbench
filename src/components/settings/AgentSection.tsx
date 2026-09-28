import { SectionTitle, Card, FieldRow, TextField, Switch, ActionButton } from "./parts";
import type { Flash } from "./parts";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Check,
  AlertTriangle,
  Bot,
  Plug,
  ShieldCheck,
  Eraser,
  Eye,
  EyeOff,
  FolderOpen,
  HelpCircle,
  KeyRound,
  BookOpen,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { isTauri } from "../../lib/db";
import {
  parseAgentPermissions,
  readAgentConfig,
  SETTINGS,
  withDefaults,
} from "../../lib/settings";
import {
  togglePatch,
  agentEnabled,
  AGENT_EXT_ID,
} from "../../lib/extensions/registry";
import { SKILLS } from "../../lib/agent/skills";
import {
  AGENT_PROVIDERS,
  agentConfigProblems,
  agentProvider,
  agentVisionSupport,
  chatEndpoint,
  recommendedProvider,
} from "../../lib/agent/providers";
import { openExternal } from "../../lib/attachments";
import { chat } from "../../lib/agent/client";
import * as agentRuntime from "../../lib/agent/runtime";

/* -------------------------------- 通用零件 -------------------------------- */

/* ------------------------------ 分区：AI 助手 ------------------------------ */

/**
 * 三项权限。
 *
 * 每一项都必须写清"它具体能碰到什么"——「写工具」这三个字对用户来说
 * 太抽象了，而它实际意味着"能在你的磁盘上建目录、写文件"。
 * 关掉时的文案也要一致（见 lib/agent/actions.ts 的 gate，两边说的必须是同一句话）。
 */
const PERM_ROWS = [
  {
    key: "writeTools",
    setting: SETTINGS.agentPermWriteTools,
    label: "写工具",
    desc: "按标准写出单 HTML 工具，装进工具目录（会在这台机器上建文件）",
  },
  {
    key: "schedules",
    setting: SETTINGS.agentPermSchedules,
    label: "建日程",
    desc: "往待办里写条目与子任务（会改数据库里的日程）",
  },
  {
    key: "database",
    setting: SETTINGS.agentPermDatabase,
    label: "绑数据表",
    desc: "改写某个工具 manifest 里的表声明（会改那个工具的文件）",
  },
] as const;

type PermKey = (typeof PERM_ROWS)[number]["key"];

/**
 * 「还没接上模型」时的引导卡。
 *
 * 为什么要这一张，而不是继续用那句"去 xxx 里配 Key"：
 * 没接过 API 的人卡住的从来不是"填哪一格"，而是**Key 从哪儿来**。
 * 只告诉他缺什么，他得自己去找注册入口 —— 这一步流失的人最多。
 * 所以卡片给的是一条完整路径：注册 → 建 Key → 粘回来，并且推荐的那一家
 * 必须自己登记了 signup（providers.ts 的 recommendedProvider 守着这条约束）。
 *
 * 「用别家」没有藏起来：助手接的是 OpenAI 兼容接口，任何人手上有 Key 都能用，
 * 推荐只是给还没有的人一个起点，不是绑定。
 */
function SignupGuide({ onUseOther }: { onUseOther: () => void }) {
  const p = recommendedProvider();
  const steps = [
    "注册并登录（邮箱即可）",
    "进控制台的 API 密钥页面，创建一把 Key",
    "把 Key 复制下来，粘到下面的「API Key」里",
  ];
  return (
    <div
      data-agent-signup-guide=""
      className="mb-4 rounded-xl border border-accent/30 bg-card px-4 py-3.5"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <span className="text-[13.5px] font-medium text-fg">还差一把 API Key</span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">
        助手要调用对话接口才能说话，而调用接口需要一把 Key。没有的话推荐用{" "}
        <b className="font-medium">{p.name}</b> —— 它和助手走的都是 OpenAI 兼容接口，
        注册就能拿 Key：
      </p>
      <ol className="mt-2 space-y-1">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-2 text-[12.5px] leading-relaxed text-fg-3">
            <span className="mt-[1px] grid size-[18px] shrink-0 place-items-center rounded-full bg-hover text-[11px] text-fg-2">
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {p.signup && (
          <button
            onClick={() => void openExternal(p.signup!)}
            data-agent-signup={p.signup}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] text-white hover:opacity-90"
          >
            去注册 {p.name}
            <ExternalLink size={12} />
          </button>
        )}
        <button
          onClick={onUseOther}
          data-agent-signup-skip=""
          className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-fg-2 hover:bg-hover"
        >
          我手上已经有别的 Key
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
        Key 只写进本机数据库的 core_settings，请求直接从这里发到你选的那家，不经过任何中转。
      </p>
    </div>
  );
}

export function AgentSection({
  settings,
  saveSettings,
  say,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  say: (text: string, tone?: Flash["tone"]) => void;
}) {
  const cfg = readAgentConfig(withDefaults(settings));
  const provider = agentProvider(cfg.provider);
  const problems = agentConfigProblems(cfg);
  const desktop = isTauri();
  /** 与服务商按钮里那个 `on` 同名容易看混，这里叫 enabled */
  const enabled = agentEnabled(settings);
  const providersRef = useRef<HTMLDivElement | null>(null);

  /** 用系统对话框挑一个目录。手填路径容易打错，而打错的目录会让"写了文件找不到" */
  const pickWorkspaceDir = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选一个目录作为助手的工作区",
    });
    if (typeof picked === "string" && picked) {
      await saveSettings({ [SETTINGS.agentWorkspace]: picked });
    }
  };

  const [busy, setBusy] = useState<"test" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // 订阅运行时的对话状态只为显示条数 —— 清空之后要能立刻看到 0 条，
  // 否则用户按完按钮不确定到底清掉没有
  const agentState = useSyncExternalStore(
    agentRuntime.subscribe,
    agentRuntime.getState,
    agentRuntime.getState,
  );

  const commit = (key: string) => (v: string) => {
    void saveSettings({ [key]: v });
  };

  /**
   * 换服务商。
   *
   * 模型名跟着换成新家的默认值 —— 沿用它上一家填的模型名几乎必然 404，
   * 而这会在用户点了"测试连接"之后才暴露出来。地址**刻意不动**：
   * 自定义地址是用户手填的，来回切一次就丢掉太亏。
   */
  const pickProvider = (id: string) => {
    if (id === cfg.provider) return;
    const next = agentProvider(id);
    void saveSettings({
      [SETTINGS.agentProvider]: id,
      [SETTINGS.agentModel]: next.defaultModel || cfg.model,
    });
  };

  const togglePerm = (key: PermKey, on: boolean) => {
    const row = PERM_ROWS.find((r) => r.key === key)!;
    void saveSettings({ [row.setting]: on ? "1" : "0" });
  };

  /**
   * 测试连接。
   *
   * 真发一次对话请求，而不是只 ping 一下地址 —— 地址能通但 Key 不对、
   * 或者模型名不存在，是三个**完全不同**的错，只有真发一次才区分得出来
   * （错误文案由 providers.ts 按状态码给出）。
   */
  const doTest = async () => {
    setBusy("test");
    try {
      const r = await chat(cfg, {
        messages: [{ role: "user", content: "只回两个字：收到" }],
        tools: [],
      });
      const t = (r.text ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      say(t ? `连接成功，它回了一句：${t}` : "连接成功（模型回了空内容，但接口是通的）");
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };

  /**
   * 清空**全部**历史（所有会话）。
   *
   * ⚠️ 它与对话界面右上角那颗「新对话」是两回事：那颗只是新开一段，
   * 旧的都留在右侧历史里（2026-09-23 的多会话改造）。这里才是真删 ——
   * 所以入口只在设置里，而且必须两段式确认。
   */
  const doClear = async () => {
    const n = await agentRuntime.clearAllChats();
    setConfirmClear(false);
    say(n ? `已清空 ${n} 条对话记录` : "对话记录本来就是空的");
  };

  return (
    <div className="max-w-[560px]">
      <SectionTitle
        title="AI 助手"
        desc="工作台内置的助手：能对话、能按单 HTML 工具的标准写出工具并装进来、能把日程记到待办里，也能给工具绑定数据表。它用的是 OpenAI 兼容接口，Key 只存在本机。"
      />

      {/* 总闸：关掉之后助手整个不在（悬浮球不渲染、不加载、不联网） */}
      <div
        data-agent-enabled-row=""
        data-on={enabled ? "1" : "0"}
        className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-line bg-card px-3.5 py-3"
      >
        <span className="min-w-0">
          <span className="block text-[13px] text-fg">启用 AI 助手</span>
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-dim">
            关掉之后左下角的悬浮球会消失，助手也不会再联网。聊过的记录都留着，
            把开关打开就原样回来。
          </span>
        </span>
        <Switch
          on={enabled}
          onToggle={() => void saveSettings(togglePatch(settings, AGENT_EXT_ID))}
          testId="agent-enabled"
        />
      </div>

      {!enabled ? (
        <div data-agent-off="" className="rounded-xl border border-dashed border-line px-4 py-5 text-center">
          <Bot size={18} className="mx-auto text-fg-dim" />
          <p className="mt-2 text-[12.5px] leading-relaxed text-fg-3">
            AI 助手已关闭，悬浮球已经收起。
            <br />
            任何时候把上面的开关打开，它都会带着原来的对话记录回来。
          </p>
        </div>
      ) : (
        <>
          {problems.length > 0 && (
            <SignupGuide
              onUseOther={() =>
                providersRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
              }
            />
          )}

          {!desktop && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
              <div className="text-[12px] leading-relaxed text-danger">
                浏览器演示模式：可以对话（接口允许跨源的话），但装工具、绑数据表这类要写文件的事做不到。
                助手会如实告诉你，并把生成好的源码留在动作卡上让你复制走。
              </div>
            </div>
          )}

          {/* 服务商 */}
          <div className="mb-4" ref={providersRef}>
        <div className="mb-2 text-[13px] font-medium text-fg">用哪家的模型</div>
        <div className="flex flex-wrap gap-2">
          {AGENT_PROVIDERS.map((p) => {
            const on = cfg.provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() => pickProvider(p.id)}
                aria-pressed={on}
                data-agent-provider={p.id}
                data-on={on ? "1" : "0"}
                className={`max-w-[260px] rounded-lg border px-3 py-2 text-left ${
                  on ? "border-accent bg-card" : "border-line bg-card hover:bg-hover"
                }`}
              >
                <span className="block text-[13px] text-fg-2">{p.name}</span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-dim">{p.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Card>
        <div className="space-y-3">
          {/* 地址：预设下拉 + 手填。自建网关与 OpenAI 官方都靠这一格 */}
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg-dim">接口地址（Base URL）</span>
            <div className="flex gap-2">
              <input
                value={cfg.baseUrl}
                placeholder={provider.defaultBase || "https://你的网关/v1"}
                data-field="agent-base-url"
                onChange={(e) => void saveSettings({ [SETTINGS.agentBaseUrl]: e.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-accent"
              />
              {provider.basePresets.length > 0 && (
                <select
                  value=""
                  data-agent-base-preset=""
                  onChange={(e) => {
                    if (e.target.value) void saveSettings({ [SETTINGS.agentBaseUrl]: e.target.value });
                  }}
                  className="shrink-0 rounded-lg border border-line bg-card px-2 py-2 text-[12.5px] text-fg-3 outline-none"
                >
                  <option value="">常用地址…</option>
                  {provider.basePresets.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <span className="mt-1 block text-[11.5px] leading-relaxed text-fg-dim">
              留空就用 {provider.name} 的默认地址{provider.defaultBase ? `（${provider.defaultBase}）` : ""}。
              把完整端点整条粘进来也能用。
            </span>
          </label>

          <ModelField
            value={cfg.model}
            placeholder={provider.defaultModel || "填模型名，如 gpt-4o-mini"}
            models={provider.models}
            providerId={cfg.provider}
            visionOverride={withDefaults(settings)[SETTINGS.agentVisionOverride] ?? ""}
            onCommit={commit(SETTINGS.agentModel)}
            onToggleOverride={(on) => commit(SETTINGS.agentVisionOverride)(on ? "1" : "0")}
          />

          <TextField
            label="API Key"
            value={cfg.apiKey}
            type="password"
            placeholder="sk-…"
            onCommit={commit(SETTINGS.agentApiKey)}
            testId="agent-key"
            hint="只存在本机数据库的 core_settings 里，请求直接从这里发到服务商，不经过任何中转。"
          />

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <ActionButton
              icon={<Plug size={14} />}
              label={busy === "test" ? "测试中…" : "测试连接"}
              onClick={() => void doTest()}
              disabled={busy !== null || problems.length > 0}
              data-agent-test
            />
            <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-fg-dim">
              {problems.length
                ? problems.join("；")
                : `会向 ${chatEndpoint(cfg)} 真发一次短对话`}
            </span>
          </div>
          {problems.length === 0 && (
            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              申请地址见{" "}
              <a
                href={provider.docs}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline"
              >
                {provider.name} 文档
              </a>
              。
            </p>
          )}
        </div>
      </Card>

      {/*
        工作区：助手写文件的目录。
        默认落在数据目录下的 agent-workspace/（留空即用默认），想放同步盘
        或自己的项目目录就在这里改 —— 那是只有用户自己知道的事。
      */}
      <div className="mt-6">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <FolderOpen size={14} className="text-fg-dim" />
          工作区（它写文件的地方）
        </div>
        <Card>
          <div className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[12px] text-fg-dim">目录</span>
              <div className="flex gap-2">
                <input
                  value={settings[SETTINGS.agentWorkspace] ?? ""}
                  placeholder={desktop ? "留空 = 数据目录下的 agent-workspace/" : "浏览器模式没有工作区"}
                  data-field="agent-workspace"
                  disabled={!desktop}
                  onChange={(e) => void saveSettings({ [SETTINGS.agentWorkspace]: e.target.value })}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 font-mono text-[12.5px] text-fg-2 outline-none focus:border-accent disabled:opacity-50"
                />
                {desktop && (
                  <button
                    onClick={() => void pickWorkspaceDir()}
                    data-agent-workspace-pick=""
                    className="shrink-0 rounded-lg border border-line px-2.5 py-2 text-[12.5px] text-fg-2 hover:bg-hover"
                  >
                    选择…
                  </button>
                )}
              </div>
              <span className="mt-1 block text-[11.5px] leading-relaxed text-fg-dim">
                助手写的报告、方案、markdown 都落在这里。它**只能**写这个目录里面的文件
                —— 相对路径里的 <code className="font-mono">..</code> 会被拒绝。
                想看这些文件：设置 → 行为 → 模块里打开「工作区」。
              </span>
            </label>
          </div>
        </Card>
      </div>

      {/* 权限 */}
      <div className="mt-6">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <ShieldCheck size={14} className="text-fg-dim" />
          它被允许做的事
        </div>
        <Card>
          <div className="space-y-3">
            {PERM_ROWS.map((row) => (
              <FieldRow
                key={row.key}
                label={row.label}
                hint={row.desc}
              >
                <Switch
                  on={parseAgentPermissions(withDefaults(settings))[row.key]}
                  onToggle={() =>
                    togglePerm(row.key, !parseAgentPermissions(withDefaults(settings))[row.key])
                  }
                  testId={`agent-perm-${row.key}`}
                />
              </FieldRow>
            ))}
          </div>
          <p className="mt-3 border-t border-line pt-3 text-[11.5px] leading-relaxed text-fg-dim">
            关掉之后助手不会绕过它，也不会假装做完 —— 它会告诉你哪一项关了、去哪儿开，
            然后等你打开。这三项默认都是开的：一个不能干活的助手就只是个更贵的输入框。
          </p>
        </Card>
      </div>

      {/* 技能 */}
      <div className="mt-6">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <BookOpen size={14} className="text-fg-dim" />
          它会照着做的标准
        </div>
        <Card>
          {SKILLS.map((s, i) => (
            <div
              key={s.id}
              data-agent-skill-row={s.id}
              className={i ? "mt-2.5 border-t border-line pt-2.5" : ""}
            >
              <div className="text-[12.5px] text-fg-2">{s.title}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-fg-dim">
                {s.rules.length} 条硬规则 · {s.summary}
              </div>
            </div>
          ))}
          <p className="mt-3 border-t border-line pt-3 text-[11.5px] leading-relaxed text-fg-dim">
            这些标准打包在程序里，和工具的运行机制是同一份约定（不是一份会过期的说明）。
            每条技能还有一份全文，助手真要动手写工具时会自己去取；全文在对话界面右上角的「技能」里能看到。
          </p>
        </Card>
      </div>

      {/* 对话记录 */}
      <div className="mt-6">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <Eraser size={14} className="text-fg-dim" />
          对话记录
        </div>
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              icon={confirmClear ? <Check size={14} /> : <Eraser size={14} />}
              label={confirmClear ? "确认清空" : "清空对话"}
              onClick={() => (confirmClear ? void doClear() : setConfirmClear(true))}
              data-agent-clear
              data-agent-clear-confirm={confirmClear ? "1" : "0"}
            />
            <span className="text-[11.5px] leading-relaxed text-fg-dim">
              当前共 {agentState.chats.length} 段对话、{agentState.messages.length} 条消息，存在本机数据库（
              <code className="font-mono">core_agent_chats</code> /{" "}
              <code className="font-mono">core_agent_messages</code>）。
              这里是<b className="font-medium">真删全部</b>——对话界面里那颗「新对话」只是新开一段，
              旧的会留在右侧历史里。清空不影响任何待办或工具。
            </span>
          </div>
        </Card>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2.5">
        <KeyRound size={13} className="mt-0.5 shrink-0 text-fg-dim" />
        <div className="text-[11.5px] leading-relaxed text-fg-dim">
           助手能看到待办与清单（读得到你手上有什么），但<b className="font-medium">碰不到流程任务</b>，
            也没有直接执行 SQL 的通道 —— 工具的私有数据只能由那个工具自己经宿主通道访问。
          </div>
        </div>
        </>
      )}
    </div>
  );
}

/** 模型名：下拉里给推荐值，但**始终允许手填** —— 新模型发布总比这里更新得快 */
function ModelField({
  value,
  placeholder,
  models,
  providerId,
  visionOverride,
  onCommit,
  onToggleOverride,
}: {
  value: string;
  placeholder?: string;
  models: Array<{ id: string; label: string }>;
  providerId: string;
  /** "1"/"0"。见 SETTINGS.agentVisionOverride 的说明 */
  visionOverride: string;
  onCommit: (v: string) => void;
  onToggleOverride: (on: boolean) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const listId = "agent-model-options";
  const vision = agentVisionSupport(providerId, v);
  const forced = (visionOverride ?? "").trim() === "1";

  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-fg-dim">模型</span>
      <input
        list={models.length ? listId : undefined}
        value={v}
        placeholder={placeholder}
        data-field="agent-model"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v !== value) onCommit(v.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setV(value);
            e.currentTarget.blur();
          }
        }}
        className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-accent"
      />
      {models.length > 0 && (
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </datalist>
      )}
      <span className="mt-1 block text-[11.5px] leading-relaxed text-fg-dim">
        可以从下拉里挑，也可以直接填。写工具是它的主力活，选一个编程向的模型效果差别很明显。
      </span>

      {/*
        这个型号看不看得图。

        三态都要能分辨，因为它们的**成因与下一步动作完全不同**：
          · 能看 —— 解除顾虑，用户可以直接粘截图进来；
          · 不能 —— 必须给出"换哪一个"，否则用户只能自己去翻文档；
          · 不确定 —— 只有用户自己知道，所以给一个开关让他回答。

        ⚠️ 开关只在"不确定"时出现：一个用户声明不该有能力推翻名单上写明的事实，
        那只会让人搞不清这个开关什么时候管用。
      */}
      <div
        data-agent-vision={vision.support}
        className={`mt-2 flex items-start gap-2 rounded-lg px-2.5 py-2 text-[11.5px] leading-relaxed ${
          vision.support === "yes"
            ? "bg-ok-soft text-ok"
            : vision.support === "no"
              ? "bg-warn-soft text-warn"
              : "bg-chip text-fg-3"
        }`}
      >
        {vision.support === "yes" ? (
          <Eye size={13} className="mt-0.5 shrink-0" />
        ) : vision.support === "no" ? (
          <EyeOff size={13} className="mt-0.5 shrink-0" />
        ) : (
          <HelpCircle size={13} className="mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <span data-agent-vision-note>{vision.note}</span>
          {vision.support === "yes" && !vision.base64 && (
            <span className="mt-1 block">
              图片仍会照常发出去。拒收的话模型会在对话里直接报错，那时换一个文档里明确写了
              base64 的型号或服务商 —— 官方只对公网 URL 做过承诺，同一家换个型号通常也没用。
            </span>
          )}
          {vision.support === "unknown" && (
            <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 select-none">
              <input
                type="checkbox"
                checked={forced}
                onChange={(e) => onToggleOverride(e.target.checked)}
                data-agent-vision-override=""
                className="size-3.5 accent-[var(--color-accent)]"
              />
              这个型号能看图，把图片照发出去
            </label>
          )}
        </div>
      </div>
    </label>
  );
}
