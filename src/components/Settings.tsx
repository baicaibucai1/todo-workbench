/**
 * 设置界面。
 *
 * 八个分区：个人资料 / 外观 / 工具 / 数据库 / 数据与备份 / 同步 / 行为偏好 / 关于与更新。
 * 所有配置都落在 core_settings，改完立刻生效（主题、侧边栏、昵称同步到侧边栏）。
 *
 * 这里只做"能立刻看到效果"的设置：每一项改动都有对应的界面变化，
 * 不摆放那种"存了但不知道有没有用"的开关。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  X,
  UserRound,
  Palette,
  Package,
  Database,
  SlidersHorizontal,
  Info,
  Download,
  Upload,
  Trash2,
  Check,
  RefreshCw,
  Moon,
  Sun,
  Monitor,
  Copy,
  Power,
  FileCode2,
  PackagePlus,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  RotateCcw,
  HardDrive,
  Save,
  Cloud,
  Link2,
  LogOut,
  Table2,
  Bot,
  Plug,
  ShieldCheck,
  Eraser,
  KeyRound,
  BookOpen,
} from "lucide-react";
import { useStore } from "../store";
import * as repo from "../lib/repo";
import { isTauri } from "../lib/db";
import {
  AVATAR_COLORS,
  DEFAULT_PROFILE,
  isThemeMode,
  parseAgentPermissions,
  parseDisabledTools,
  parseSpecialEnabled,
  parseToolKeepState,
  parseUrgentMinutes,
  readAgentConfig,
  SETTINGS,
  STARTUP_VIEWS,
  toggleDisabledTool,
  URGENT_MINUTES,
  URGENT_PRESETS,
  withDefaults,
  type ThemeMode,
} from "../lib/settings";
import {
  canInstallTools,
  checkToolId,
  HTML_MAX_BYTES,
  installFromHtml,
  reinstallBundledTool,
  suggestToolId,
  toolsRoot,
  uninstallTool,
} from "../lib/toolStore";
import { ICONS, resolveIcon } from "../lib/icons";
import type { ToolManifest } from "../types";
import tauriConf from "../../src-tauri/tauri.conf.json";
import { notifyPermission, requestNotifyPermission } from "../lib/notify";
import {
  DEFAULT_DETAIL_SECTIONS,
  DETAIL_SECTIONS,
  moveDetailSection,
  parseDetailSections,
  placeDetailSection,
  type DetailSectionId,
} from "../lib/detailSections";
import {
  inspectDatabases,
  inspectTable,
  type DbOverview,
  type NamespaceStat,
} from "../lib/dbInspect";
import { dropToolNamespace } from "../lib/toolSchema";
import { postToTool } from "../lib/toolLink";
import { HOST_SOURCE } from "../lib/toolBridge";
import { attachmentStore, formatBytes } from "../lib/attachments";
import {
  SCRIM,
  SCRIM_LEVELS,
  formatBackground,
  isScrimLevel,
  loadWallpapers,
  parseBackground,
  wallpaperUrl,
  type ScrimLevel,
  type Wallpaper,
} from "../lib/wallpapers";
import {
  ALL_SHARDS,
  checkConnection,
  formatShards,
  isSyncConfigured,
  missingConfigHint,
  persistDeviceId,
  providerLabel,
  readSyncConfig,
  relativeTime,
  runSync,
  signInOneDrive,
  signOutOneDrive,
  summarizeReport,
  SYNC_PROVIDERS,
  type ShardReport,
  type SyncProvider,
  type SyncReport,
} from "../lib/syncClient";
import { SHARD_LABELS, type SyncShardId } from "../lib/sync";
import { SKILLS } from "../lib/agent/skills";
import {
  AGENT_PROVIDERS,
  agentConfigProblems,
  agentProvider,
  chatEndpoint,
} from "../lib/agent/providers";
import { chat } from "../lib/agent/client";
import * as agentRuntime from "../lib/agent/runtime";

const NAV = [
  { key: "profile", label: "个人资料", icon: UserRound },
  { key: "appearance", label: "外观", icon: Palette },
  { key: "tools", label: "工具", icon: Package },
  // AI 助手紧挨着「工具」：它最主要的一件事就是写工具、给工具绑数据表，
  // 放在一起，用户找"怎么让它干活"时不用在两个分区之间来回跳
  { key: "ai", label: "AI 助手", icon: Bot },
  { key: "database", label: "数据库", icon: Database },
  { key: "data", label: "数据与备份", icon: Save },
  { key: "sync", label: "同步", icon: Cloud },
  { key: "behavior", label: "行为偏好", icon: SlidersHorizontal },
  { key: "about", label: "关于与更新", icon: Info },
] as const;

type SectionKey = (typeof NAV)[number]["key"];

/** 深链过来的分区名要校验：store 里那一格是 string，不能直接当 key 用 */
function isSectionKey(v: string | null | undefined): v is SectionKey {
  return !!v && NAV.some((n) => n.key === v);
}

interface Flash {
  tone: "ok" | "err";
  text: string;
}

/**
 * 工具包的下载地址。
 *
 * 0.2.0 起安装包本体不带工具（工具里那份 50MB 的抠图模型不该摊到每一次更新上），
 * 工具改成 Release 里的另一份 zip 资产。所以"桌面版第一次打开没有工具"是
 * 设计好的样子，界面必须把下一步说清楚 —— 不然用户看到的就是一个空的面板。
 *
 * 不用 <a href>：Tauri 的 webview 里点外链不会跳浏览器（还没接 opener 插件），
 * 一个点了没反应的链接比一行明明白白的地址更糟。
 */
const TOOLS_PACK_URL = "https://github.com/baicaibucai1/todo-workbench/releases/latest";

export default function Settings() {
  const {
    settings,
    saveSettings,
    openSettings,
    dbInfo,
    lists,
    refresh,
    loadSettings,
    repoUsage,
    refreshRepoUsage,
    settingsSection,
  } = useStore();

  /**
   * 当前分区。
   *
   * 初值取自 settingsSection —— 它是 store 里的**一次性落点**：
   * 助手说"去设置 → AI 助手里配"时能把人直接送到那一页，而不是丢他
   * 在八个分区里自己找。从侧边栏正常进设置时它是 null，于是回到个人资料。
   */
  const [section, setSection] = useState<SectionKey>(() =>
    isSectionKey(settingsSection) ? settingsSection : "profile",
  );

  // 设置页开着的时候也要能跟着跳（比如助手把用户引过来之后又指了另一处）
  useEffect(() => {
    if (isSectionKey(settingsSection)) setSection(settingsSection);
  }, [settingsSection]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [stats, setStats] = useState<{ lists: number; tasks: number; done: number } | null>(
    null,
  );
  const [confirmClear, setConfirmClear] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const say = (text: string, tone: Flash["tone"] = "ok") => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  // 仓库路径与占用只在切到「数据与备份」时探一次。占用要把整个仓库目录
  // 走一遍，进设置就跑一次是白费。
  useEffect(() => {
    if (section !== "data") return;
    let alive = true;
    void refreshRepoUsage();
    void attachmentStore()
      .root()
      .then((p) => {
        if (alive) setRepoPath(p);
      })
      .catch(() => {
        if (alive) setRepoPath("");
      });
    return () => {
      alive = false;
    };
  }, [section, refreshRepoUsage]);

  // 统计只在切到「数据与备份」时拉一次，避免每次进设置都扫全表
  useEffect(() => {
    if (section !== "data") return;
    let alive = true;
    void repo.fetchTasks({ view: "all", includeDone: true }).then((tasks) => {
      if (!alive) return;
      setStats({
        lists: lists.length,
        tasks: tasks.length,
        done: tasks.filter((t) => t.done).length,
      });
    });
    return () => {
      alive = false;
    };
  }, [section, lists.length]);

  const doExport = async () => {
    const payload = await repo.exportBackup();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `待办工作台-备份-${repo.today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const att = payload.attachments?.length ?? 0;
    say(
      `已导出 ${payload.lists.length} 个列表、${payload.tasks.length} 条任务` +
        // 备份里只有附件的元数据，不含文件本体。这句话必须说 ——
        // 不说的话，用户换台机器导入后发现图片全是"文件缺失"，会以为是导入坏了。
        (att ? `、${att} 条附件记录（附件文件本体不在备份里，需另拷仓库目录）` : ""),
    );
  };

  const doImport = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as repo.BackupPayload;
      const r = await repo.importBackup(payload);
      await loadSettings();
      await refresh();
      say(`已导入 ${r.lists} 个列表、${r.tasks} 条任务（覆盖原有数据）`);
    } catch (err) {
      say(`导入失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
  };

  const doClear = async () => {
    // 先把仓库文件路径收集起来再清库：清完就查不到 rel_path 了，
    // 那些文件会永远留在磁盘上、也没有任何记录指向它们。
    // 顺序反了就是"删了数据但没删文件"，而且悄无声息。
    //
    // 图库和附件**共用同一个内容寻址仓库**（同一份字节只存一份），
    // 所以两边都要收，并用 Set 去重 —— 否则同一路径会被删两次
    // （第二次返回 false，白记一次"没删掉"的日志）。
    const files = [
      ...new Set(
        [
          ...(await repo.fetchAllAttachments()).map((a) => a.relPath),
          ...(await repo.fetchAllGallery()).map((g) => g.relPath),
        ].filter((p): p is string => !!p),
      ),
    ];

    await repo.clearAllData();
    await loadSettings();
    await refresh();

    const store = attachmentStore();
    let removed = 0;
    for (const p of files) {
      try {
        if (await store.remove(p)) removed++;
      } catch {
        // 单个文件删不掉不该让整个清空失败
      }
    }
    await refreshRepoUsage();
    setConfirmClear(false);
    say(removed ? `已清空全部数据，并删除仓库里的 ${removed} 个文件` : "已清空全部数据");
  };

  return (
    <div
      data-settings=""
      className="flex h-full min-w-0 flex-1 flex-col bg-surface"
    >
      {/* 头部 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <h1 className="text-[18px] font-medium text-fg">设置</h1>
        <div className="flex-1" />
        {flash && (
          <span
            data-flash=""
            className={`rounded px-2 py-1 text-[12px] ${
              flash.tone === "ok"
                ? "bg-[#e1f5ee] text-[#0f6e56]"
                : "bg-danger-soft text-danger"
            }`}
          >
            {flash.text}
          </span>
        )}
        <button
          onClick={() => openSettings(false)}
          title="关闭设置"
          data-act="close-settings"
          className="grid size-7 place-items-center rounded text-fg-dim hover:bg-hover"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 分区导航 */}
        <nav className="w-[184px] shrink-0 overflow-y-auto border-r border-line p-2">
          {NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => setSection(item.key)}
              data-section={item.key}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                section === item.key
                  ? "bg-chip font-medium text-fg"
                  : "text-fg-3 hover:bg-hover"
              }`}
            >
              <item.icon size={15} className="shrink-0 text-fg-dim" />
              {item.label}
            </button>
          ))}
        </nav>

        {/* 分区内容 */}
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {section === "profile" && (
            <ProfileSection settings={settings} saveSettings={saveSettings} />
          )}
          {section === "appearance" && (
            <AppearanceSection settings={settings} saveSettings={saveSettings} />
          )}
          {section === "tools" && <ToolsSection settings={settings} saveSettings={saveSettings} say={say} />}
          {section === "ai" && (
            <AgentSection settings={settings} saveSettings={saveSettings} say={say} />
          )}
          {section === "database" && <DatabaseSection say={say} />}
          {section === "data" && (
            <DataSection
              dbInfo={dbInfo}
              stats={stats}
              repoUsage={repoUsage}
              repoPath={repoPath}
              confirmClear={confirmClear}
              setConfirmClear={setConfirmClear}
              onExport={() => void doExport()}
              onImport={() => fileRef.current?.click()}
              onClear={() => void doClear()}
            />
          )}
          {section === "sync" && (
            <SyncSection
              settings={settings}
              saveSettings={saveSettings}
              say={say}
              refresh={refresh}
            />
          )}
          {section === "behavior" && (
            <BehaviorSection
              settings={settings}
              saveSettings={saveSettings}
              say={say}
              onRollover={async () => {
                const n = await repo.rolloverDailyTasks();
                await refresh();
                say(n ? `已重置 ${n} 条每日任务` : "没有需要重置的每日任务");
              }}
            />
          )}
          {section === "about" && <AboutSection say={say} />}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void doImport(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/* ------------------------------ 分区：个人资料 ------------------------------ */

function ProfileSection({
  settings,
  saveSettings,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
}) {
  const name = settings[SETTINGS.profileName] ?? "";
  const email = settings[SETTINGS.profileEmail] ?? "";
  const color = settings[SETTINGS.profileColor] ?? DEFAULT_PROFILE.color;

  return (
    <div className="max-w-[520px]">
      <SectionTitle
        title="个人资料"
        desc="只保存在本机，不会上传到任何地方。侧边栏顶部会实时显示这里的内容。"
      />

      <Card>
        <div className="flex items-center gap-4">
          <span
            className="grid size-16 shrink-0 place-items-center rounded-full text-[24px] font-medium text-white"
            style={{ background: color }}
          >
            {name.trim()[0] ?? "?"}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-fg">
              {name.trim() || "未设置昵称"}
            </div>
            <div className="truncate text-[12px] text-fg-dim">
              {email.trim() || "未填写邮箱"}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3">
          <TextField
            label="昵称"
            value={name}
            placeholder="想让别人怎么称呼你"
            onCommit={(v) => void saveSettings({ [SETTINGS.profileName]: v })}
          />
          <TextField
            label="邮箱"
            value={email}
            placeholder="name@example.com"
            onCommit={(v) => void saveSettings({ [SETTINGS.profileEmail]: v })}
          />
        </div>

        <div className="mt-4">
          <div className="mb-1.5 text-[12px] text-fg-dim">头像颜色</div>
          <div className="flex gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => void saveSettings({ [SETTINGS.profileColor]: c })}
                title={c}
                className="grid size-7 place-items-center rounded-full transition-transform hover:scale-110"
                style={{ background: c }}
              >
                {color === c && <Check size={14} className="text-white" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------- 分区：外观 -------------------------------- */

function AppearanceSection({
  settings,
  saveSettings,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
}) {
  const raw = settings[SETTINGS.theme];
  const theme: ThemeMode = isThemeMode(raw) ? raw : "light";

  const options: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
    { value: "light", label: "浅色", icon: Sun },
    { value: "dark", label: "深色", icon: Moon },
    { value: "system", label: "跟随系统", icon: Monitor },
  ];

  const [wallpapers, setWallpapers] = useState<Wallpaper[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadWallpapers().then((list) => {
      if (alive) setWallpapers(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const bg = parseBackground(settings[SETTINGS.background]);
  const scrimRaw = settings[SETTINGS.bgScrim];
  const scrim: ScrimLevel = isScrimLevel(scrimRaw) ? scrimRaw : "medium";
  const pick = (value: string) => void saveSettings({ [SETTINGS.background]: value });

  return (
    <div className="max-w-[560px]">
      <SectionTitle
        title="外观"
        desc="主题与背景立即生效，并记住你的选择。"
      />

      <Card>
        <FieldRow
          label="主题"
          hint="「跟随系统」会随 Windows 的浅色/深色设置自动切换"
        >
          <div className="flex gap-1.5">
            {options.map((o) => (
              <button
                key={o.value}
                data-theme-option={o.value}
                onClick={() => void saveSettings({ [SETTINGS.theme]: o.value })}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] whitespace-nowrap transition-colors ${
                  theme === o.value
                    ? "border-[#378add] bg-[#378add] text-white"
                    : "border-line bg-card text-fg-3 hover:bg-hover"
                }`}
              >
                <o.icon size={14} />
                {o.label}
              </button>
            ))}
          </div>
        </FieldRow>
      </Card>

      <div className="mt-5">
        <SectionTitle
          title="待办背景"
          desc="默认跟着视图自带的那套渐变走；也可以选一张必应壁纸铺满整个待办区。"
        />

        <Card>
          {wallpapers === null ? (
            <div className="py-6 text-center text-[13px] text-fg-dim">正在读取壁纸清单…</div>
          ) : wallpapers.length === 0 ? (
            // 空清单不是"坏掉了"，而是这个环境还没抓过图 —— 直接给出补救命令，
            // 比显示一排灰格子有用
            <div className="text-[13px] leading-relaxed text-fg-2">
              <div className="font-medium text-danger">还没有抓到壁纸图片</div>
              <div className="mt-1 text-fg-3">
                壁纸是随包发布的静态资源，需要在工程里跑一次抓取脚本：
              </div>
              <code className="mt-2 block rounded-md bg-chip px-2.5 py-1.5 font-mono text-[12.5px] text-fg-2">
                node scripts/fetch-wallpapers.mjs
              </code>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2.5">
                <button
                  data-bg-option="auto"
                  onClick={() => pick("auto")}
                  className={`group overflow-hidden rounded-lg border text-left transition-colors ${
                    bg.kind === "auto"
                      ? "border-[#378add] ring-2 ring-[#378add]/25"
                      : "border-line hover:border-fg-dim"
                  }`}
                >
                  {/* 「跟随视图」用四个视图的渐变拼一格，直观说明它是什么样子 */}
                  <span
                    className="block h-[74px] w-full"
                    style={{ background: "linear-gradient(135deg,#c2436b,#a8681a 34%,#2a6cb0 67%,#443c9a)" }}
                  />
                  <span className="flex items-center gap-1.5 px-2 py-1.5 text-[12.5px] text-fg-2">
                    {bg.kind === "auto" && <Check size={13} className="text-[#378add]" />}
                    跟随视图
                  </span>
                </button>

                {wallpapers.map((w) => (
                  <button
                    key={w.file}
                    data-bg-option={w.file}
                    title={`${w.title}\n${w.copyright}`}
                    onClick={() => pick(formatBackground({ kind: "image", file: w.file }))}
                    className={`overflow-hidden rounded-lg border text-left transition-colors ${
                      bg.kind === "image" && bg.file === w.file
                        ? "border-[#378add] ring-2 ring-[#378add]/25"
                        : "border-line hover:border-fg-dim"
                    }`}
                  >
                    <img
                      src={wallpaperUrl(w.file)}
                      alt={w.title}
                      loading="lazy"
                      className="h-[74px] w-full object-cover"
                    />
                    <span className="block truncate px-2 py-1.5 text-[12.5px] text-fg-3">
                      {w.date}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-fg-dim">
                {bg.kind === "image"
                  ? `当前：${wallpapers.find((w) => w.file === bg.file)?.title || bg.file}`
                  : "当前：跟随视图渐变"}
                <span className="ml-1">
                  · 共 {wallpapers.length} 张，来自必应每日壁纸；要换一批就再跑一次抓取脚本
                </span>
              </div>

              {/* 遮罩只在铺图时才有意义 —— 照片明暗差得远，没有它白字会糊在天空上 */}
              {bg.kind === "image" && (
                <div className="mt-3 border-t border-line pt-3">
                  <div className="text-[12.5px] text-fg-2">遮罩强度</div>
                  <div className="mt-1 text-[12px] leading-relaxed text-fg-dim">
                    壁纸越亮，越需要压暗一些才看得清文字。
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    {SCRIM_LEVELS.map((lv) => (
                      <button
                        key={lv}
                        data-bg-scrim={lv}
                        onClick={() => void saveSettings({ [SETTINGS.bgScrim]: lv })}
                        className={`flex-1 rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                          scrim === lv
                            ? "border-[#378add] bg-[#378add] text-white"
                            : "border-line bg-card text-fg-3 hover:bg-hover"
                        }`}
                      >
                        {SCRIM[lv].label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------ 分区：数据库 ------------------------------ */

/**
 * 数据库分区。
 *
 * 放在设置里而不是藏在某个按钮后面，是因为**工具的数据本来就属于用户**：
 * 他装了个工具、存了三个月记录、然后卸了 —— 那些数据在哪儿、能不能删，
 * 得由他自己能看见、能决定，而不是取决于某个工具作者实现了没有。
 */
function DatabaseSection({ say }: { say: (text: string, tone?: Flash["tone"]) => void }) {
  const tools = useStore((s) => s.tools);
  const [overview, setOverview] = useState<DbOverview | null>(null);
  const [busy, setBusy] = useState(true);
  /** 展开的命名空间 id */
  const [openId, setOpenId] = useState<string | null>("core");
  /** 正在预览的表 */
  const [preview, setPreview] = useState<{
    name: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
    total: number;
  } | null>(null);
  /** 等待二次确认的清理目标 */
  const [wipe, setWipe] = useState<NamespaceStat | null>(null);

  // say 是父组件每次渲染新建的函数。直接把它写进依赖数组的话，
  // setState 引起重渲染 -> 依赖变了 -> effect 重跑 -> 又 setState，
  // 形成一个不停扫全表的循环（设置页会一直在"正在读取"之间闪）。
  // 用 ref 接住它，依赖就只剩真正会变的 tools。
  const sayRef = useRef(say);
  sayRef.current = say;

  // 只在切进这个分区时扫一次。每个命名空间逐表 COUNT，
  // 每次渲染都扫的话设置页会明显卡一下。
  useEffect(() => {
    let alive = true;
    setBusy(true);
    void inspectDatabases(tools)
      .then((o) => {
        if (alive) setOverview(o);
      })
      .catch((err) => {
        // 体检失败不该让整个设置页白屏：说出原因，别的分区还能用
        if (alive) sayRef.current(`读取数据库失败：${err instanceof Error ? err.message : String(err)}`, "err");
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [tools]);

  const openTable = async (name: string) => {
    try {
      const r = await inspectTable(name, 50);
      setPreview({ name, ...r });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), "err");
    }
  };

  const doWipe = async (ns: NamespaceStat) => {
    try {
      const r = await dropToolNamespace(ns.id);
      setWipe(null);
      setPreview(null);
      // 这个工具要是正开着，它手上的表刚刚被删掉了 ——
      // 通知挂载层重跑一次建表，否则它会一直撞"表不存在"
      useStore.getState().bustToolSchema(ns.id);

      // 再给工具本身发一件事，让它自己重新拉一次列表。
      // 少了这一步，界面上还摆着被删掉的那两行，用户会以为清理没生效 ——
      // 而数据库里其实已经空了，两种真相对不上是最容易让人怀疑数据丢了的场景。
      postToTool(ns.id, {
        source: HOST_SOURCE,
        type: "tool:event",
        event: "schema:reset",
        data: { toolId: ns.id },
      });
      const fresh = await inspectDatabases(tools);
      setOverview(fresh);
      say(
        r.tables.length
          ? `已清理 ${r.tables.length} 张表（${r.rows} 行）与 ${r.kvRows} 条配置`
          : `已清理 ${r.kvRows} 条工具配置`,
      );
    } catch (err) {
      say(`清理失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
  };

  return (
    <div className="max-w-[620px]" data-db-section="">
      <SectionTitle
        title="数据库"
        desc="工作台只有一个数据库文件。宿主与每个工具在里面各占一段命名空间 —— 前缀 core_ 的是工作台自己的，tool_<工具 id>_ 的是某个工具私有的。"
      />

      <Card>
        <div className="grid grid-cols-2 gap-y-2.5 text-[13px]">
          <InfoCell
            label="驱动"
            value={overview?.driver === "sqlite" ? "SQLite" : "内存库（演示）"}
          />
          <InfoCell label="Schema 版本" value={`v${overview?.schemaVersion ?? "-"}`} />
          <InfoCell label="表数量" value={overview ? String(overview.tableCount) : "…"} />
          <InfoCell label="总行数" value={overview ? overview.rowCount.toLocaleString() : "…"} />
        </div>
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-center gap-1.5 text-[11.5px] text-fg-dim">
            <HardDrive size={12} />
            文件位置
          </div>
          <div className="mt-0.5 break-all text-[12.5px] text-fg-2" data-db-location="">
            {overview?.location ?? "-"}
          </div>
        </div>
      </Card>

      {busy && <div className="mt-4 text-[13px] text-fg-dim">正在读取各个命名空间…</div>}

      {overview && (
        <div className="mt-4 space-y-2">
          {overview.namespaces.map((ns) => (
            <NamespaceCard
              key={ns.id}
              ns={ns}
              open={openId === ns.id}
              previewName={preview?.name ?? null}
              onToggle={() => {
                setPreview(null);
                setOpenId(openId === ns.id ? null : ns.id);
              }}
              onOpenTable={(name) => void openTable(name)}
              onWipe={() => setWipe(ns)}
            />
          ))}
        </div>
      )}

      {preview && (
        <div className="mt-4" data-table-preview={preview.name}>
          <div className="mb-1.5 flex items-center gap-2">
            <Table2 size={14} className="text-fg-dim" />
            <span className="font-mono text-[12.5px] text-fg-2">{preview.name}</span>
            <span className="text-[11.5px] text-fg-dim">
              共 {preview.total} 行，预览前 {preview.rows.length} 行
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setPreview(null)}
              data-act="close-preview"
              className="rounded px-2 py-0.5 text-[12px] text-fg-dim hover:bg-hover"
            >
              收起
            </button>
          </div>
          {preview.rows.length === 0 ? (
            <div className="rounded-lg border border-line bg-card px-4 py-3 text-[12.5px] text-fg-dim">
              这张表是空的
            </div>
          ) : (
            <div className="max-h-[320px] overflow-auto rounded-lg border border-line bg-card">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-chip">
                  <tr className="text-left text-[11.5px] text-fg-dim">
                    {preview.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-1.5 font-normal">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="border-t border-line">
                      {preview.columns.map((c) => (
                        <td
                          key={c}
                          className="max-w-[260px] truncate px-3 py-1.5 font-mono text-[11.5px] text-fg-2"
                          title={String(row[c] ?? "")}
                        >
                          {String(row[c] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {wipe && (
        <div className="mt-4 rounded-lg border border-[#a32d2d]/30 bg-danger-soft p-3">
          <div className="text-[13px] leading-relaxed text-danger">
            将删除「{wipe.name}」名下 {wipe.tables.length} 张表（{wipe.rows} 行）与它的配置项，
            无法撤销。工具本身不会被删除，
            {wipe.installed
              ? "下次打开它时表会按它的声明重新建出来。"
              : "它已经被卸载了，重装之后这些数据不会回来。"}
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => void doWipe(wipe)}
              data-act="confirm-wipe-ns"
              className="rounded-md bg-[#a32d2d] px-3 py-1.5 text-[13px] text-white hover:opacity-90"
            >
              确认清理
            </button>
            <button
              onClick={() => setWipe(null)}
              className="rounded-md border border-line bg-card px-3 py-1.5 text-[13px] text-fg-3"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NamespaceCard({
  ns,
  open,
  previewName,
  onToggle,
  onOpenTable,
  onWipe,
}: {
  ns: NamespaceStat;
  open: boolean;
  previewName: string | null;
  onToggle: () => void;
  onOpenTable: (name: string) => void;
  onWipe: () => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-line bg-card"
      data-ns={ns.id}
      data-ns-tables={ns.tables.length}
      data-ns-rows={ns.rows}
    >
      <button
        onClick={onToggle}
        data-ns-toggle={ns.id}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-hover"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-fg-dim" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] text-fg">{ns.name}</span>
            {ns.kind === "core" ? (
              <span className="shrink-0 rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim">
                宿主
              </span>
            ) : (
              <span
                className={`shrink-0 rounded px-1.5 py-px text-[10.5px] ${
                  ns.installed
                    ? "bg-chip text-fg-dim"
                    : ns.known
                      ? "bg-[#fdf6e7] text-[#7a5406]"
                      : "bg-danger-soft text-danger"
                }`}
                data-ns-installed={ns.installed ? "1" : "0"}
              >
                {ns.installed ? "已安装" : ns.known ? "已卸载 · 数据仍在" : "归属不明"}
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-fg-dim">
            {ns.prefix} · {ns.tables.length} 张表 · {ns.rows.toLocaleString()} 行
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-line">
          {ns.tables.length === 0 ? (
            <div className="px-3.5 py-2.5 text-[12px] leading-relaxed text-fg-dim">
              {ns.kind === "core"
                ? "没有核心表 —— 这不该发生，请检查数据库是否完好"
                : "这个工具还没建立数据表。它的设置存在宿主的 core_tool_kv 里（见上面「宿主」那段），数据则要等工具自己在 manifest 里声明了 schema 才会有。"}
            </div>
          ) : (
            <div className="divide-y divide-line">
              {ns.tables.map((t) => (
                <div
                  key={t.name}
                  className="flex items-center gap-2 px-3.5 py-2"
                  data-ns-table={t.name}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-fg-2">{t.label}</div>
                    <div className="truncate font-mono text-[11px] text-fg-dim">
                      {t.name} · {t.rows.toLocaleString()} 行
                      {t.columns > 0 ? ` · ${t.columns} 列` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => onOpenTable(t.name)}
                    data-view-table={t.name}
                    disabled={t.rows === 0}
                    className={`shrink-0 rounded px-2 py-0.5 text-[12px] ${
                      previewName === t.name
                        ? "bg-chip text-fg"
                        : "text-fg-3 hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent"
                    }`}
                  >
                    查看
                  </button>
                </div>
              ))}
            </div>
          )}

          {ns.kind === "tool" && (ns.tables.length > 0 || ns.installed) && (
            <div className="border-t border-line px-3.5 py-2">
              {ns.known ? (
                <button
                  onClick={onWipe}
                  data-wipe-ns={ns.id}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-danger hover:bg-danger-soft"
                >
                  <Trash2 size={12} />
                  清理这段命名空间的数据
                </button>
              ) : (
                <div className="px-2 py-1 text-[11.5px] leading-relaxed text-fg-dim">
                  这段表前缀定位不到唯一的工具（工具 id 含连字符时前缀会有歧义），
                  因此不提供一键清理 —— 宁可留着，也不能删错别人的数据。
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- 分区：数据与备份 ----------------------------- */

function DataSection({
  dbInfo,
  stats,
  repoUsage,
  repoPath,
  confirmClear,
  setConfirmClear,
  onExport,
  onImport,
  onClear,
}: {
  dbInfo: { driver: "sqlite" | "memory"; location: string; schemaVersion: number } | null;
  stats: { lists: number; tasks: number; done: number } | null;
  repoUsage: { files: number; bytes: number } | null;
  repoPath: string;
  confirmClear: boolean;
  setConfirmClear: (v: boolean) => void;
  onExport: () => void;
  onImport: () => void;
  onClear: () => void;
}) {
  return (
    <div className="max-w-[560px]">
      <SectionTitle
        title="数据与备份"
        desc="数据全部存在本机。导出一份 JSON，换机器或重装后可以直接导回来。"
      />

      <Card>
        <div className="grid grid-cols-2 gap-y-2.5 text-[13px]">
          <InfoCell label="数据库" value={dbInfo?.driver === "sqlite" ? "SQLite" : "内存库（演示）"} />
          <InfoCell label="Schema 版本" value={`v${dbInfo?.schemaVersion ?? "-"}`} />
          <InfoCell label="列表数" value={stats ? String(stats.lists) : "…"} />
          <InfoCell
            label="任务数"
            value={stats ? `${stats.tasks}（已完成 ${stats.done}）` : "…"}
          />
        </div>
        <div className="mt-3 border-t border-line pt-3">
          <div className="text-[12px] text-fg-dim">存储位置</div>
          <div className="mt-0.5 break-all text-[12.5px] text-fg-2">
            {dbInfo?.location ?? "-"}
          </div>
        </div>
        {/* 附件仓库单独列一段：它和数据库是两个地方，占了磁盘大头的是它。
            不写清楚的话，用户看到"数据都在这"，换机器时只会拷数据库文件。 */}
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <div className="text-[12px] text-fg-dim">附件仓库（图片与视频的原文件）</div>
            <div className="text-[12.5px] text-fg-2" data-repo-usage={repoUsage ? repoUsage.files : ""}>
              {repoUsage ? `${repoUsage.files} 个文件 · ${formatBytes(repoUsage.bytes)}` : "…"}
            </div>
          </div>
          <div className="mt-0.5 break-all text-[12.5px] text-fg-2">{repoPath || "-"}</div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-fg-dim">
            备份里只有附件的记录，不含文件本体。要连文件一起搬，手动拷贝上面这个目录。
          </div>
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton icon={<Download size={14} />} label="导出备份" onClick={onExport} />
        <ActionButton
          icon={<Upload size={14} />}
          label="导入备份"
          onClick={onImport}
          data-act="import"
        />
      </div>
      <p className="mt-2 text-[12px] text-fg-dim">
        导入是覆盖式的：先清空现有数据，再写入备份内容。
      </p>

      <div className="mt-6">
        <div className="mb-2 text-[13px] font-medium text-fg">清空数据</div>
        {confirmClear ? (
          <div className="rounded-lg border border-[#a32d2d]/30 bg-danger-soft p-3">
            <div className="text-[13px] text-danger">
              将删除全部列表、任务、流程任务与配置，并清掉附件仓库里的文件，且无法撤销。确定继续？
            </div>
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={onClear}
                data-act="confirm-clear"
                className="rounded-md bg-[#a32d2d] px-3 py-1.5 text-[13px] text-white hover:opacity-90"
              >
                确认清空
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="rounded-md border border-line bg-card px-3 py-1.5 text-[13px] text-fg-3"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            data-act="clear"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-danger hover:bg-danger-soft"
          >
            <Trash2 size={14} />
            清空全部数据
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ 分区：行为偏好 ------------------------------ */

function BehaviorSection({
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
  const specialOn = parseSpecialEnabled(settings[SETTINGS.specialEnabled]);
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
            className="w-[160px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
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
              className="w-[110px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
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
              className="w-[110px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
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
                  className="w-[110px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
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
                    isTarget ? "border-[#378add] bg-hover" : "border-line bg-card"
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
          title="模块"
          desc="关掉的功能会从界面上收起，已经存下的数据仍留在数据库里，随时可以再打开。"
        />
        <Card>
          <FieldRow
            label="特殊单号"
            hint="以快递单号为起点、每一步带处理时效的那类记录。关掉后侧边栏入口、专属视图、创建时的类型选择、我的一天里那一组、以及时效提醒与紧急区都会停；已经建好的单子不受影响，仍留在「流程任务」列表里"
          >
            <Switch
              on={specialOn}
              onToggle={() =>
                void saveSettings({
                  [SETTINGS.specialEnabled]: specialOn ? "0" : "1",
                })
              }
              testId="special-enabled"
            />
          </FieldRow>
        </Card>
      </div>
    </div>
  );
}
/* ------------------------------ 分区：关于与更新 ------------------------------ */

function AboutSection({ say }: { say: (text: string, tone?: Flash["tone"]) => void }) {
  const [busy, setBusy] = useState(false);

  const checkUpdate = async () => {
    if (!isTauri()) {
      say("浏览器演示模式不支持更新检查；打包后的桌面版启动时会自行检查", "err");
      return;
    }
    setBusy(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      say(update ? `发现新版本 ${update.version}` : "当前已是最新版本");
    } catch (err) {
      say(`检查更新失败：${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[520px]">
      <SectionTitle title="关于" desc={tauriConf.productName} />

      <Card>
        <div className="grid grid-cols-2 gap-y-2.5 text-[13px]">
          <InfoCell label="版本" value={`v${tauriConf.version}`} />
          <InfoCell label="运行环境" value={isTauri() ? "桌面应用" : "浏览器演示"} />
          <InfoCell label="作者" value="Sogapopo" />
          <InfoCell label="标识符" value={tauriConf.identifier} />
        </div>

        <p
          data-about-motto
          className="mt-4 border-t border-line pt-3.5 text-[11.5px] leading-relaxed text-fg-dim"
        >
          我们的生命都相当无序甚至是荒谬，也许这款应用能帮您从中构建部分的秩序
        </p>
      </Card>

      <div className="mt-4">
        <SectionTitle title="更新" desc="桌面版打包后支持自动更新，更新包经过签名校验。" />
        <Card>
          <button
            onClick={() => void checkUpdate()}
            disabled={busy}
            data-act="check-update"
            className="rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 hover:bg-hover disabled:opacity-50"
          >
            {busy ? "检查中…" : "检查更新"}
          </button>
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------- 分区：工具 -------------------------------- */

/**
 * 工具管理。
 *
 * 这里要回答三个不同的问题，别混：
 *   · 停用/启用 —— 我还想不想在侧边栏看到它？（记在设置里，不动文件）
 *   · 安装/卸载 —— 这个工具的**文件**在不在？（动 <appData>/tools）
 *   · 关闭运行  —— 它现在是不是还挂在后台占内存？（动这次会话的挂载集合）
 *
 * 三者的入口都放在这一页，因为用户的心智是"我的工具" —— 分成三处，
 * 就会出现"我明明卸载了怎么还在侧边栏"这种问题（其实是只停用了）。
 *
 * 内置工具与导入的工具**卸载后果不同**，所以文案必须分开写：
 * 内置的删了能从安装包装回来，导入的删了就真没了。
 * 这个区别由 tools.source 决定，而 source 是扫描时由宿主盖的戳，不是工具自报的。
 */
function ToolsSection({
  settings,
  saveSettings,
  say,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  say: (text: string, tone?: Flash["tone"]) => void;
}) {
  const { tools, bundledTools, aliveToolIds, closeTool, reloadTools, openTool } = useStore();

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 选好文件、等着确认的导入（null = 当前没在导入） */
  const [pending, setPending] = useState<{ fileName: string; html: string } | null>(null);
  /** 正在二次确认卸载的工具 id */
  const [askUninstall, setAskUninstall] = useState<string | null>(null);
  const [root, setRoot] = useState("");

  const disabled = parseDisabledTools(settings[SETTINGS.toolsDisabled]);
  const keepState = parseToolKeepState(settings[SETTINGS.toolKeepState]);
  const canManage = canInstallTools();
  const taken = tools.map((t) => t.id);

  // 工具目录路径只在切到这一区时取一次
  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    void toolsRoot()
      .then((p) => {
        if (alive) setRoot(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [canManage]);

  // 「已卸载、还能装回来」= 安装包里有、注册表里没有
  const missing = bundledTools.filter((b) => !tools.some((t) => t.id === b.id));

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /**
   * 点一下启用开关 = 把当前状态取反。
   *
   * 别写成 `setEnabled(id, !has(id))` —— 这个名字下那个表达式是反的
   * （toggleDisabledTool 的第三个参数是"要不要停用"，不是"要不要启用"），
   * 而且两处取反叠起来读起来像是对的。这里直接把语义写成一个函数。
   */
  const toggleEnabled = (id: string) =>
    saveSettings({
      [SETTINGS.toolsDisabled]: toggleDisabledTool(
        settings[SETTINGS.toolsDisabled],
        id,
        !disabled.has(id), // 现在是启用 → 变成停用
      ),
    });

  const doUninstall = async (tool: ToolManifest) => {
    setBusy(tool.id);
    try {
      const msg = await uninstallTool(tool);
      await reloadTools();
      say(msg);
    } catch (err) {
      say(`卸载失败：${errText(err)}`, "err");
    } finally {
      setBusy(null);
      setAskUninstall(null);
    }
  };

  const doReinstall = async (id: string) => {
    setBusy(id);
    try {
      await reinstallBundledTool(id);
      await reloadTools();
      say("已重新安装，侧边栏里就能打开它了");
    } catch (err) {
      say(`重新安装失败：${errText(err)}`, "err");
    } finally {
      setBusy(null);
    }
  };

  const pickFile = async (f: File) => {
    // 体积先在读之前挡一道：把几百兆的东西读成字符串再拒绝，白占内存
    if (f.size > HTML_MAX_BYTES) {
      say(
        `文件 ${(f.size / 1024 / 1024).toFixed(1)} MB，超过 ${HTML_MAX_BYTES / 1024 / 1024} MB 上限`,
        "err",
      );
      return;
    }
    try {
      setPending({ fileName: f.name, html: await f.text() });
    } catch (err) {
      say(`读不出这个文件：${errText(err)}`, "err");
    }
  };

  const doInstall = async (input: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
  }) => {
    if (!pending) return;
    setBusy("__import");
    try {
      const { manifest } = await installFromHtml({ html: pending.html, ...input });
      setPending(null);
      await reloadTools();
      // 装完直接打开 —— 对"我导入的东西到底行不行"最直观的回答。
      // 不打开的话用户还得自己在侧边栏里找一遍，而那一刻的迟疑最伤信任。
      openTool(manifest.id);
      say(`已安装「${manifest.name}」`);
    } catch (err) {
      say(`安装失败：${errText(err)}`, "err");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-[640px]">
      <SectionTitle
        title="工具"
        desc="工作台右侧的工具都是可插拔的：能启用停用、能装能卸，也能把单个 HTML 文件直接导入成一个工具。"
      />

      <Card>
        <FieldRow
          label="切换后保持工具状态"
          hint={
            keepState
              ? "切走再切回来，工具还是你离开时的样子（刚调的样式、载入的数据都在）。想让它回到初始状态，按工具头部的「重置」。"
              : "每次切回工具都会重新加载，回到初始状态。开启后可以保持离开时的界面与数据。"
          }
        >
          <Switch
            testId="tool-keep-state"
            on={keepState}
            onToggle={() => void saveSettings({ [SETTINGS.toolKeepState]: keepState ? "0" : "1" })}
          />
        </FieldRow>
      </Card>

      <div className="mt-5">
        <SectionTitle
          title="已安装工具"
          desc={
            canManage
              ? "关掉开关只是停用（文件还在，随时能启用）；卸载会删掉工具文件。"
              : "浏览器演示模式没有可写的文件系统，只能启用/停用。安装与卸载请在桌面版里操作。"
          }
        />
        <Card>
          {tools.length === 0 && (
            <div className="text-[13px] leading-relaxed text-fg-dim">
              {canManage ? (
                <>
                  <div>
                    桌面版本体不自带工具 —— 工具们作为 Release 上的一份独立资产发布，
                    谁想要谁下载，不必为了一个用不上的模型多下几十兆。
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3"
                      title={TOOLS_PACK_URL}
                    >
                      {TOOLS_PACK_URL}
                    </span>
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(TOOLS_PACK_URL);
                        say("下载地址已复制");
                      }}
                      data-act="copy-tools-pack-url"
                      className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-card text-fg-dim hover:bg-hover"
                      title="复制下载地址"
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                  <div className="mt-2">
                    下载解压后，把里面的 <span className="font-mono text-[11.5px]">tools</span>{" "}
                    整个文件夹放进下面那行「工具目录」里；也可以跳过这一步 —— 让悬浮球里的助手
                    直接给你写一个工具，它会自己装好。
                  </div>
                </>
              ) : (
                "浏览器演示模式只能试用内置工具，安装与卸载请在桌面版里操作。"
              )}
            </div>
          )}
          {tools.map((tool, i) => (
            <div key={tool.id}>
              {i > 0 && <div className="my-3 border-t border-line" />}
              <div data-tool-row={tool.id} className="flex items-start gap-3">
                <ToolIcon icon={tool.icon} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[13px] font-medium text-fg-2">{tool.name}</span>
                    <span className="rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim">
                      v{tool.version}
                    </span>
                    <span
                      className={`rounded px-1.5 py-px text-[10.5px] ${
                        tool.source === "user"
                          ? "bg-[#e1f5ee] text-[#0f6e56]"
                          : "bg-[#faeeda] text-[#854f0b]"
                      }`}
                      title={
                        tool.source === "user"
                          ? "你自己导入的工具，卸载就是真删掉"
                          : "随安装包分发，卸载后还能重新安装"
                      }
                    >
                      {tool.source === "user" ? "自己导入" : "内置"}
                    </span>
                    {aliveToolIds.includes(tool.id) && (
                      <span className="rounded bg-[#e1f5ee] px-1.5 py-px text-[10.5px] text-[#0f6e56]">
                        运行中
                      </span>
                    )}
                  </div>
                  {tool.description && (
                    <div className="mt-1 text-[11.5px] leading-relaxed text-fg-dim">
                      {tool.description}
                    </div>
                  )}
                  <div className="mt-1 font-mono text-[11px] text-fg-dim">
                    tools/{tool.id}/
                  </div>

                  {askUninstall === tool.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-chip px-3 py-2">
                      <AlertTriangle size={14} className="shrink-0 text-danger" />
                      <span className="text-[12px] text-fg-2">
                        {tool.source === "user"
                          ? "自己导入的工具删掉就没法恢复了（只能重新导入一次）。确定卸载？"
                          : "内置工具卸载后仍然可以从安装包重新安装，确定卸载？"}
                      </span>
                      <div className="flex-1" />
                      <button
                        onClick={() => setAskUninstall(null)}
                        className="rounded-md border border-line bg-card px-2.5 py-1 text-[12px] text-fg-3 hover:bg-hover"
                      >
                        取消
                      </button>
                      <button
                        data-tool-uninstall-confirm={tool.id}
                        disabled={busy === tool.id}
                        onClick={() => void doUninstall(tool)}
                        className="rounded-md bg-danger px-2.5 py-1 text-[12px] text-white disabled:opacity-50"
                      >
                        {busy === tool.id ? "卸载中…" : "确认卸载"}
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  {aliveToolIds.includes(tool.id) && (
                    <button
                      onClick={() => closeTool(tool.id)}
                      data-tool-close={tool.id}
                      title="关闭它，释放内存与后台计算"
                      className="flex items-center gap-1 rounded-md border border-line bg-card px-2 py-1 text-[12px] text-fg-3 hover:bg-hover"
                    >
                      <Power size={12} />
                      关闭
                    </button>
                  )}
                  <button
                    onClick={() => setAskUninstall(tool.id)}
                    disabled={!canManage || busy === tool.id}
                    data-tool-uninstall={tool.id}
                    title={canManage ? "删除这个工具" : "浏览器演示模式无法卸载工具"}
                    className="grid size-7 place-items-center rounded-md border border-line bg-card text-fg-dim hover:bg-hover disabled:opacity-40"
                  >
                    <Trash2 size={13} />
                  </button>
                  <Switch
                    testId={`tool-enable-${tool.id}`}
                    on={!disabled.has(tool.id)}
                    onToggle={() => void toggleEnabled(tool.id)}
                  />
                </div>
              </div>
            </div>
          ))}
        </Card>

        {missing.length > 0 && (
          <div className="mt-3">
            <SectionTitle
              title="已卸载的内置工具"
              desc="这些都还能装回来 —— 它们随安装包分发，不需要联网下载。"
            />
            <Card>
              {missing.map((tool, i) => (
                <div key={tool.id}>
                  {i > 0 && <div className="my-3 border-t border-line" />}
                  <div data-tool-missing={tool.id} className="flex items-center gap-3">
                    <ToolIcon icon={tool.icon} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-fg-2">{tool.name}</span>
                        <span className="rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim">
                          v{tool.version}
                        </span>
                        <span className="rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim">
                          已卸载
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => void doReinstall(tool.id)}
                      disabled={!canManage || busy === tool.id}
                      data-tool-reinstall={tool.id}
                      className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1 text-[12px] text-fg-2 hover:bg-hover disabled:opacity-40"
                    >
                      <PackagePlus size={13} />
                      {busy === tool.id ? "安装中…" : "重新安装"}
                    </button>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}

        <div className="mt-3">
          <SectionTitle
            title="导入 HTML 单文件"
            desc="把单个 HTML 文件变成一个工具：文件里的 CSS / JS 要内联，引用外部文件的相对路径不会跟着进来。"
          />
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <button
                data-act="import-tool"
                disabled={!canManage}
                onClick={() => fileRef.current?.click()}
                title={
                  canManage
                    ? "选一个 HTML 文件装成工具"
                    : "浏览器演示模式无法写入文件系统，请在桌面版里导入"
                }
                className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 hover:bg-hover disabled:opacity-40"
              >
                <FileCode2 size={14} />
                选择 HTML 文件…
              </button>
              {!canManage && (
                <span className="text-[11.5px] text-fg-dim">
                  浏览器演示模式只能试用内置工具，安装功能需要桌面版
                </span>
              )}
            </div>

            {root && (
              <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] text-fg-dim">工具目录（也可以直接把工具文件夹丢进去）</div>
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3" title={root}>
                    {root}
                  </div>
                </div>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(root);
                    say("路径已复制");
                  }}
                  data-act="copy-tools-root"
                  className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-card text-fg-dim hover:bg-hover"
                  title="复制路径"
                >
                  <Copy size={13} />
                </button>
              </div>
            )}
          </Card>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="text/html,.html,.htm"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pickFile(f);
          e.target.value = "";
        }}
      />

      {pending && (
        <ImportToolDialog
          key={pending.fileName}
          fileName={pending.fileName}
          taken={taken}
          busy={busy === "__import"}
          onCancel={() => setPending(null)}
          onInstall={(input) => void doInstall(input)}
        />
      )}
    </div>
  );
}

function ToolIcon({ icon }: { icon?: string }) {
  const Icon = resolveIcon(icon);
  return (
    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-chip">
      <Icon size={16} className="text-[#378add]" />
    </span>
  );
}

/** 从文件名取一个默认的工具名（去扩展名） */
function defaultToolName(fileName: string): string {
  return fileName.replace(/\.(html?|htm)$/i, "").trim() || "新工具";
}

/**
 * 导入确认框。
 *
 * 为什么要有这一步而不是选完文件直接装：工具的 id 会变成它私有表的表名前缀，
 * 而且**装错了要卸载才能改**，所以让用户过一眼比"先装了再说"省事。
 * 但默认值全部预填（名称来自文件名、id 从文件名推、图标给个通用值），
 * 所以想省事的人直接点「安装」即可 —— 这就是"快速导入"。
 */
function ImportToolDialog({
  fileName,
  taken,
  busy,
  onCancel,
  onInstall,
}: {
  fileName: string;
  taken: string[];
  busy: boolean;
  onCancel: () => void;
  onInstall: (input: { id: string; name: string; description?: string; icon?: string }) => void;
}) {
  const [name, setName] = useState(() => defaultToolName(fileName));
  const [id, setId] = useState(() => suggestToolId(fileName, taken));
  const [icon, setIcon] = useState("package");
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);

  const idError = checkToolId(id, taken);
  const nameError = name.trim() ? null : "名称不能为空";
  const bad = idError ?? nameError;

  return (
    <div
      data-tool-import-dialog=""
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-[440px] rounded-xl border border-line bg-card p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <FileCode2 size={16} className="text-[#378add]" />
          <h3 className="text-[14px] font-medium text-fg">导入为工具</h3>
        </div>
        <p className="mt-1 break-all font-mono text-[11.5px] text-fg-dim">{fileName}</p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg-dim">工具名称（侧边栏里显示这个）</span>
            <input
              autoFocus
              value={name}
              data-import-name=""
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] text-fg-dim">
              id（小写字母/数字/连字符，会用作它的私有表名前缀）
            </span>
            <input
              value={id}
              data-import-id=""
              onChange={(e) => setId(e.target.value)}
              onBlur={() => setTouched(true)}
              className={`w-full rounded-lg border bg-card px-3 py-2 font-mono text-[13px] text-fg-2 outline-none ${
                touched && idError ? "border-danger" : "border-line focus:border-[#378add]"
              }`}
            />
            {touched && idError && idError !== nameError && (
              <span className="mt-1 block text-[11.5px] text-danger">{idError}</span>
            )}
            {/* 中文文件名推不出 id 时给出解释，否则用户会以为界面在乱填 */}
            {!/[a-z]/i.test(fileName) && (
              <span className="mt-1 block text-[11.5px] text-fg-dim">
                文件名里没有字母，所以先给了一个占位 id，改一个你认得出来的即可。
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] text-fg-dim">图标</span>
            <select
              value={icon}
              data-import-icon=""
              onChange={(e) => setIcon(e.target.value)}
              className="w-[180px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
            >
              {Object.keys(ICONS).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] text-fg-dim">说明（可选）</span>
            <textarea
              value={description}
              data-import-desc=""
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full resize-none rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
            />
          </label>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] text-fg-3 hover:bg-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            data-act="confirm-import-tool"
            disabled={!!bad || busy}
            onClick={() =>
              onInstall({
                id: id.trim(),
                name: name.trim(),
                icon,
                description: description.trim() || undefined,
              })
            }
            className="rounded-lg bg-[#378add] px-3 py-1.5 text-[13px] text-white disabled:opacity-40"
          >
            {busy ? "安装中…" : "安装"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- 分区：同步 -------------------------------- */

/**
 * 坚果云（WebDAV）同步。
 *
 * 三条硬规则写在这里，免得以后被"顺手改掉"：
 *  1. `dir` 下的每个分片是一个独立 JSON，**按分片各自合并**，不是整库覆盖；
 *  2. 文件本体（图片/视频）永远不上传，只走记录 —— 同步几十 MB 的原文件
 *     对着坚果云的小水管是灾难，而且它本来就是个网盘，用户自己会同步；
 *  3. 设置**完全不进同步**：设备名、主题、工具开关这些是"本机的事"，
 *     两台机器对着改会互相覆盖，而且没有任何一方是"对的"。
 */

const SHARD_HINTS: Record<SyncShardId, string> = {
  tasks: "列表、待办、子任务，以及待办之间的关联关系",
  orders: "流程模板、流程任务、自定义字段与操作记录",
  gallery: "图库记录（不含图片、视频文件本体）",
  attachments: "流程任务附件的记录（不含文件本体）",
};

function SyncSection({
  settings,
  saveSettings,
  say,
  refresh,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  say: (text: string, tone?: Flash["tone"]) => void;
  refresh: () => Promise<void>;
}) {
  const cfg = readSyncConfig(settings);
  // `signin` 是一个**会等上几分钟**的状态：命令会打开浏览器、然后一直等到
  // 用户在浏览器里登录并同意授权。界面上必须能看出来"在等浏览器"，
  // 否则看起来就像卡死了（这也正是它值得单独一个状态、而不是跟 check 合并的原因）。
  const [busy, setBusy] = useState<"check" | "sync" | "signin" | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const desktop = isTauri();
  const isOneDrive = cfg.provider === "onedrive";

  const lastAt = settings[SETTINGS.syncLastAt] ?? "";
  const lastSummary = settings[SETTINGS.syncLastSummary] ?? "";
  const configured = isSyncConfigured(cfg);

  const commit = (key: string) => (v: string) => {
    void saveSettings({ [key]: v });
  };

  // 换后端**不清空另一边的配置**：来回切换的成本必须为零。
  // 否则"先试一下 OneDrive"就变成一次要重新填账号密码的操作，
  // 用户会在犹豫里干脆不试。
  const pickProvider = (id: SyncProvider) => {
    if (id === cfg.provider) return;
    void saveSettings({ [SETTINGS.syncProvider]: id });
  };

  const doSignIn = async () => {
    setBusy("signin");
    try {
      // 先说一句"去看浏览器"，再等 —— 这个调用可能几分钟才返回
      say("已打开浏览器，请在浏览器里用微软账号登录并同意授权…");
      say(await signInOneDrive(cfg));
      await refresh();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const doSignOut = async () => {
    await signOutOneDrive();
    say("已断开 OneDrive。云端那份数据没删，重新连接后还能取回来。");
    await refresh();
  };

  // 一个分片都不勾 = 按了"立即同步"却什么都不发生，那是界面上最难解释的一种状态。
  // 所以取消最后一个时直接拦住，而不是静默回落到默认值。
  const toggleShard = (id: SyncShardId) => {
    const next = cfg.shards.includes(id)
      ? cfg.shards.filter((x) => x !== id)
      : [...cfg.shards, id];
    if (!next.length) {
      say("至少要同步一类内容", "err");
      return;
    }
    void saveSettings({ [SETTINGS.syncShards]: formatShards(next) });
  };

  const doCheck = async () => {
    setBusy("check");
    try {
      await persistDeviceId(cfg);
      say(await checkConnection(cfg));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const doSync = async () => {
    setBusy("sync");
    setReport(null);
    try {
      await persistDeviceId(cfg);
      const r = await runSync(cfg);
      setReport(r);
      await refresh();
      if (r.okCount === 0) {
        say(r.shards.find((x) => x.error)?.error ?? "同步失败", "err");
      } else if (r.failCount) {
        // 一部分成功就**不回滚**：成功的分片各自已经是完整状态，回滚反而丢东西
        say(`同步完成：${summarizeReport(r)}`, "err");
      } else {
        say(`同步完成：${summarizeReport(r)}`);
      }
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-[560px]">
      <SectionTitle
        title="同步"
        desc="在两台机器之间对齐数据。支持坚果云等 WebDAV 服务，也支持 OneDrive。合并是双向的：两边都改过同一条时，谁后改听谁的。"
      />

      {!desktop && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-[#a32d2d]/30 bg-danger-soft px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <div className="text-[12px] leading-relaxed text-danger">
            当前是浏览器演示模式，同步在这里用不了：演示数据存在 localStorage，跟桌面版的数据库是两套；而且 WebDAV
            要用的 PROPFIND / MKCOL 浏览器发不出去，OneDrive 登录要开本地端口收回调，浏览器里同样做不了。
            下面的设置可以先填，到桌面版里再连、再同步。
          </div>
        </div>
      )}

      <div className="mb-4">
        <div className="mb-2 text-[13px] font-medium text-fg">同步到哪</div>
        <div className="flex flex-wrap gap-2">
          {SYNC_PROVIDERS.map((p) => {
            const on = cfg.provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() => pickProvider(p.id)}
                aria-pressed={on}
                data-sync-provider={p.id}
                data-on={on ? "1" : "0"}
                className={`max-w-[260px] rounded-lg border px-3 py-2 text-left ${
                  on ? "border-[#378add] bg-card" : "border-line bg-card hover:bg-hover"
                }`}
              >
                <span className="block text-[13px] text-fg-2">{p.label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-dim">{p.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Card>
        {isOneDrive ? (
          <div className="space-y-3" data-sync-onedrive>
            <TextField
              label="Azure 客户端 ID"
              value={cfg.onedriveClientId}
              placeholder="在 Azure 应用注册的「概述」页复制"
              onCommit={commit(SETTINGS.onedriveClientId)}
              testId="onedrive-client"
              hint="公共客户端的 client_id 不是密钥，写错只会连不上，不会泄露别的东西。"
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {cfg.onedriveRefreshToken ? (
                <>
                  <span className="text-[12.5px] text-fg-2" data-onedrive-account>
                    已连接{cfg.onedriveAccount ? `：${cfg.onedriveAccount}` : ""}
                  </span>
                  <ActionButton
                    icon={<LogOut size={14} />}
                    label="断开"
                    onClick={() => void doSignOut()}
                    disabled={busy !== null}
                    data-onedrive-signout
                  />
                </>
              ) : (
                <ActionButton
                  icon={<Link2 size={14} />}
                  label={busy === "signin" ? "等待浏览器授权…" : "连接 OneDrive"}
                  onClick={() => void doSignIn()}
                  disabled={!desktop || !cfg.onedriveClientId || busy !== null}
                  data-onedrive-signin
                />
              )}
            </div>
            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              数据放在 OneDrive 的「应用」文件夹里（路径形如 Apps/待办工作台），网页版默认不显示它 ——
              这是正常的，那个文件夹只有这个应用看得到。首次同步时会自动建出来。
            </p>
            <details className="rounded-lg border border-line px-3 py-2.5" data-onedrive-guide>
              <summary className="cursor-pointer text-[12.5px] text-fg-2">
                怎么拿这个 ID？（注册一个 Azure 应用，约 5 分钟，免费）
              </summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11.5px] leading-relaxed text-fg-dim">
                <li>
                  打开 portal.azure.com 并用<b>要同步的那个微软账号</b>登录 → Microsoft Entra ID →
                  应用注册 → 新注册
                </li>
                <li>名称填「待办工作台」——它会变成 OneDrive 里那个文件夹的名字</li>
                <li>支持的帐户类型选「任何组织目录中的帐户和个人 Microsoft 帐户」</li>
                <li>
                  重定向 URI 的平台选「移动和桌面应用程序」，再勾选 http://localhost（列表里有这一项）
                  —— 勾了它就不必为端口操心，应用每次用随机端口都合法
                </li>
                <li>注册完在「概述」页复制「应用程序(客户端) ID」，填到上面那个框里</li>
                <li>
                  API 权限 → 添加权限 → Microsoft Graph → <b>委托的权限</b>，勾这四项：
                  Files.ReadWrite.AppFolder、offline_access、openid、profile
                </li>
                <li>
                  身份验证 → 拉到最下面 → 把「允许公共客户端流」改成「是」并保存
                  （漏了这一步，登录会报 unauthorized_client）
                </li>
              </ol>
            </details>
          </div>
        ) : (
        <div className="space-y-3">
          <TextField
            label="服务器地址"
            value={cfg.baseUrl}
            placeholder="https://dav.jianguoyun.com/dav"
            onCommit={commit(SETTINGS.syncBaseUrl)}
            testId="sync-base"
          />
          <TextField
            label="账号（坚果云登录邮箱）"
            value={cfg.username}
            placeholder="you@example.com"
            onCommit={commit(SETTINGS.syncUsername)}
            testId="sync-user"
          />
          <TextField
            label="应用密码"
            value={cfg.password}
            type="password"
            placeholder="在坚果云「安全选项 → 添加应用」里生成"
            onCommit={commit(SETTINGS.syncPassword)}
            testId="sync-pass"
            hint="不是登录密码。坚果云需要单独生成一个应用密码给第三方程序用，生成后只显示一次，记下来。"
          />
          <TextField
            label="同步目录"
            value={cfg.dir}
            placeholder="待办工作台"
            onCommit={commit(SETTINGS.syncDir)}
            testId="sync-dir"
            hint="在坚果云根目录下建这个名字的文件夹，留空就直接放根目录。两台机器要填成一样的。"
          />
        </div>
        )}
      </Card>

      <div className="mt-5">
        <div className="mb-2 text-[13px] font-medium text-fg">同步内容</div>
        <div className="space-y-2">
          {ALL_SHARDS.map((id) => {
            const on = cfg.shards.includes(id);
            return (
              <button
                key={id}
                onClick={() => toggleShard(id)}
                role="switch"
                aria-checked={on}
                data-sync-shard={id}
                data-on={on ? "1" : "0"}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2.5 text-left hover:bg-hover"
              >
                <span className="min-w-0">
                  <span className="block text-[13px] text-fg-2">{SHARD_LABELS[id]}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-dim">
                    {SHARD_HINTS[id]}
                  </span>
                </span>
                <span
                  className="flex size-[18px] shrink-0 items-center justify-center rounded border"
                  style={{
                    borderColor: on ? "#378add" : "var(--color-line)",
                    background: on ? "#378add" : "transparent",
                  }}
                >
                  {on && <Check size={12} className="text-white" />}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">
          默认只同步待办。图库和附件都只同步「记录」，图片、视频的原文件不会上传 ——
          那些按目录各同步各的就行。设置项本身不参与同步。
        </p>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[13px] font-medium text-fg">这台设备</div>
        <Card>
          <TextField
            label="设备名"
            value={cfg.deviceName}
            placeholder="书房台式机"
            onCommit={commit(SETTINGS.syncDeviceName)}
            testId="sync-device"
            hint="只用来在同步结果里区分「这份是谁写的」，两台机器最好不一样。"
          />
          <div className="mt-3 border-t border-line pt-3" data-sync-last={lastAt}>
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="text-fg-dim">上次同步</span>
              <span className="text-fg-2" data-sync-last-text>
                {relativeTime(lastAt)}
              </span>
            </div>
            {lastSummary && (
              <div className="mt-0.5 text-[11.5px] text-fg-dim" data-sync-last-summary>
                {lastSummary}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton
          icon={<Check size={14} />}
          label={busy === "check" ? "测试中…" : "测试连接"}
          onClick={() => void doCheck()}
          disabled={!desktop || !configured || busy !== null}
          data-sync-test
        />
        <ActionButton
          icon={<RefreshCw size={14} className={busy === "sync" ? "animate-spin" : ""} />}
          label={busy === "sync" ? "同步中…" : "立即同步"}
          onClick={() => void doSync()}
          disabled={!desktop || !configured || busy !== null}
          data-sync-now
        />
      </div>
      {!configured && (
        <p className="mt-2 text-[12px] text-fg-dim" data-sync-hint>
          {missingConfigHint(cfg)}。配好之后这两个按钮才会亮。
        </p>
      )}

      {report && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] font-medium text-fg">本次结果 · {providerLabel(cfg.provider)}</div>
          <Card>
            <div className="space-y-1.5">
              {report.shards.map((r) => (
                <SyncShardLine key={r.shard} r={r} />
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function SyncShardLine({ r }: { r: ShardReport }) {
  const bits: string[] = [];
  if (!r.error) {
    if (!r.hadRemote) bits.push("首次上传");
    if (r.stats.added) bits.push(`取回 ${r.stats.added}`);
    if (r.stats.updated) bits.push(`更新 ${r.stats.updated}`);
    if (r.stats.pushed) bits.push(`上传 ${r.stats.pushed}`);
    if (!bits.length) bits.push("无变化");
  }
  return (
    <div
      className="flex items-start justify-between gap-3 text-[12.5px]"
      data-sync-line={r.shard}
      data-sync-error={r.error ? "1" : "0"}
    >
      <span className="shrink-0 text-fg-2">{SHARD_LABELS[r.shard]}</span>
      <span className="min-w-0 break-all text-right text-fg-dim">{r.error ?? bits.join(" · ")}</span>
    </div>
  );
}

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

function AgentSection({
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

      {!desktop && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-[#a32d2d]/30 bg-danger-soft px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <div className="text-[12px] leading-relaxed text-danger">
            浏览器演示模式：可以对话（接口允许跨源的话），但装工具、绑数据表这类要写文件的事做不到。
            助手会如实告诉你，并把生成好的源码留在动作卡上让你复制走。
          </div>
        </div>
      )}

      {/* 服务商 */}
      <div className="mb-4">
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
            onCommit={commit(SETTINGS.agentModel)}
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
    </div>
  );
}

/** 模型名：下拉里给推荐值，但**始终允许手填** —— 新模型发布总比这里更新得快 */
function ModelField({
  value,
  placeholder,
  models,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  models: Array<{ id: string; label: string }>;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const listId = "agent-model-options";

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
    </label>
  );
}

function SectionTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-2.5">
      <h2 className="text-[14px] font-medium text-fg">{title}</h2>
      {desc && <p className="mt-0.5 text-[12px] leading-relaxed text-fg-dim">{desc}</p>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-3.5">{children}</div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 pt-1.5">
        <div className="text-[13px] text-fg-2">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-relaxed text-fg-dim">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11.5px] text-fg-dim">{label}</div>
      <div className="mt-0.5 text-[13px] text-fg-2">{value}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onCommit,
  testId,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  testId?: string;
  type?: string;
  hint?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);

  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-fg-dim">{label}</span>
      <input
        value={v}
        type={type}
        placeholder={placeholder}
        data-field={testId}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setV(value);
            e.currentTarget.blur();
          }
        }}
        className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
      />
      {hint && <span className="mt-1 block text-[11.5px] leading-relaxed text-fg-dim">{hint}</span>}
    </label>
  );
}

function Switch({ on, onToggle, testId }: { on: boolean; onToggle: () => void; testId?: string }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      data-switch={testId}
      className="relative h-[22px] w-[40px] rounded-full transition-colors"
      style={{ background: on ? "#378add" : "#c9c8c2" }}
    >
      <span
        className="absolute top-[3px] size-4 rounded-full bg-card transition-all"
        style={{ left: on ? 21 : 3 }}
      />
    </button>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  ...rest
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      {...rest}
      className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 hover:bg-hover"
    >
      {icon}
      {label}
    </button>
  );
}
