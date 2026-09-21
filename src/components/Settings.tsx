/**
 * 设置界面。
 *
 * 五个分区：个人资料 / 外观 / 数据与备份 / 行为偏好 / 关于与更新。
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
} from "lucide-react";
import { useStore } from "../store";
import * as repo from "../lib/repo";
import { isTauri } from "../lib/db";
import {
  AVATAR_COLORS,
  DEFAULT_PROFILE,
  isThemeMode,
  parseUrgentMinutes,
  SETTINGS,
  STARTUP_VIEWS,
  URGENT_MINUTES,
  URGENT_PRESETS,
  type ThemeMode,
} from "../lib/settings";
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

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
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
