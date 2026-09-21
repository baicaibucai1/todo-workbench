/**
 * 设置界面。
 *
 * 六个分区：个人资料 / 外观 / 工具 / 数据与备份 / 行为偏好 / 关于与更新。
 * 所有配置都落在 core_settings，改完立刻生效（主题、侧边栏、昵称同步到侧边栏）。
 *
 * 这里只做"能立刻看到效果"的设置：每一项改动都有对应的界面变化，
 * 不摆放那种"存了但不知道有没有用"的开关。
 */

import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { useStore } from "../store";
import * as repo from "../lib/repo";
import { isTauri } from "../lib/db";
import {
  AVATAR_COLORS,
  DEFAULT_PROFILE,
  isThemeMode,
  parseDisabledTools,
  parseToolKeepState,
  parseUrgentMinutes,
  SETTINGS,
  STARTUP_VIEWS,
  toggleDisabledTool,
  URGENT_MINUTES,
  URGENT_PRESETS,
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

const NAV = [
  { key: "profile", label: "个人资料", icon: UserRound },
  { key: "appearance", label: "外观", icon: Palette },
  { key: "tools", label: "工具", icon: Package },
  { key: "data", label: "数据与备份", icon: Database },
  { key: "behavior", label: "行为偏好", icon: SlidersHorizontal },
  { key: "about", label: "关于与更新", icon: Info },
] as const;

type SectionKey = (typeof NAV)[number]["key"];

interface Flash {
  tone: "ok" | "err";
  text: string;
}

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
  } = useStore();

  const [section, setSection] = useState<SectionKey>("profile");
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
              将删除全部列表、任务、工单与配置，并清掉附件仓库里的文件，且无法撤销。确定继续？
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
  const reminderOn = (settings[SETTINGS.reminderEnabled] ?? "1") !== "0";
  const systemNotify = (settings[SETTINGS.reminderSystem] ?? "0") === "1";
  const snooze = settings[SETTINGS.reminderSnooze] ?? "10";
  const urgentMinutes = parseUrgentMinutes(settings[SETTINGS.urgentMinutes]);
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
          desc="剩下的时间不足这个值时，待办与工单会自动出现在侧边栏底部的「紧急」里。"
        />
        <Card>
          <FieldRow
            label="提前多久算紧急"
            hint="待办看提醒时间或到期日，工单看当前步骤的时效或交付日"
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
        </div>
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
      const m = await installFromHtml({ html: pending.html, ...input });
      setPending(null);
      await reloadTools();
      // 装完直接打开 —— 对"我导入的东西到底行不行"最直观的回答。
      // 不打开的话用户还得自己在侧边栏里找一遍，而那一刻的迟疑最伤信任。
      openTool(m.id);
      say(`已安装「${m.name}」`);
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
            <div className="text-[13px] text-fg-dim">工具目录里一个工具都没有。</div>
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

/* -------------------------------- 通用零件 -------------------------------- */

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
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);

  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-fg-dim">{label}</span>
      <input
        value={v}
        placeholder={placeholder}
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
