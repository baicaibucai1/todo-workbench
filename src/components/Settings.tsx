/**
 * 设置界面外壳。
 *
 * 九个分区的东西都住在 ./settings/ 下各自的目录里 —— 这个文件只负责三件事：
 *   1. 左侧分区导航（顺序与图标见 settings/nav.ts）；
 *   2. 把 store 里的东西和各分区需要的回调接起来（导出 / 导入 / 清空备份）；
 *   3. 顶栏那句操作结果提示。
 *
 * 为什么要拆：这一页原本 3586 行，一个文件里塞了九个业务域，改一条关于更新
 * 的说明要在三千行里翻半天。拆完之后每个分区文件都在 100–600 行之间，
 * 而且**互相不知道对方存在** —— 想看懂「同步」只需要打开 SyncSection。
 *
 * 刻意留在壳里的：三个会动数据库的动作（导出/导入/清空）。它们跨好几个分区
 * 共用（比如清空要走 DATA_SECTION，也要 refresh），放在各分区里就得分头实现。
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../store";
import * as repo from "../lib/repo";
import { attachmentStore } from "../lib/attachments";
import { NAV, isSectionKey, type SectionKey } from "./settings/nav";
import type { Flash } from "./settings/parts";
import { ProfileSection } from "./settings/ProfileSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { DatabaseSection } from "./settings/DatabaseSection";
import { DataSection } from "./settings/DataSection";
import { BehaviorSection } from "./settings/BehaviorSection";
import { AboutSection } from "./settings/AboutSection";
import { ToolsSection } from "./settings/ToolsSection";
import { SyncSection } from "./settings/SyncSection";
import { AgentSection } from "./settings/AgentSection";

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
                ? "bg-ok-soft text-ok"
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
