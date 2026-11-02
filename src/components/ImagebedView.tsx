/**
 * 多媒体文件 —— 工作台里所有图片/视频的共同落点。
 *
 * 设计取向（与工作台其余部分一致）：
 * - 取数只走 lib/imagebed.ts，组件不直接碰 db
 * - 不写假按钮：没有文件、删除失败这类情况都给出真实状态
 * - 关键状态写 `data-*`，e2e 靠它断言，不靠中文文案
 *
 * ============================ 为什么要分文件夹 ============================
 * 原来是一页平铺：一排来源 chip + 一个网格，图一多就"认不出是谁的、也翻不到"。
 * 现在左侧是分类栏：
 *   · **工具文件夹**（虚拟）：按 origin 分组，工具传上来的图自动落进去，零维护；
 *   · **我的文件夹**（真表）：用户自己建，图可以挪进来；
 *   · **标签**：一张图可以挂几个词，跨文件夹找东西用。
 * 一张图要么在工具文件夹里、要么在某个自建文件夹里 —— 移动就是移动，
 * 不会同时出现在两处（否则用户会怀疑自己删错了）。
 *
 * 与 AI 生成工具的联动是双向的，两边都落在这里：
 *   工具 → 多媒体文件：AI 出图后一键「存进多媒体文件」，产物落在本视图里
 *   多媒体文件 → 工具：AI 的参考图可直接从多媒体文件挑
 * 后者不需要本组件参与（工具在自己的界面里列多媒体文件），
 * 但**前者需要一个刷新信号** —— 工具是 iframe，写库发生在宿主进程里，
 * 本组件不知道。所以宿主写入后广播 `workbench:gallery-changed`，这里监听它。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Images,
  Plus,
  Search,
  X,
  Trash2,
  Pencil,
  ChevronLeft,
  ChevronRight,
  Info,
  Check,
  FolderOpen,
  Sparkles,
  Crop,
  Ruler,
  Upload,
  Receipt,
  StickyNote,
  Layers,
  Folder,
  FolderPlus,
  FolderInput,
  Tag,
  Music,
  AudioLines,
} from "lucide-react";
import { useStore } from "../store";
import {
  addToImagebed,
  createImagebedFolder,
  deleteImagebedFolder,
  deleteImagebedItem,
  fetchImagebed,
  fetchImagebedFolders,
  folderKeyOf,
  IMAGEBED_CHANGED,
  joinTags,
  matchesImagebed,
  originLabel,
  ORIGIN_COLOR,
  renameImagebedFolder,
  setImagebedFolder,
  setImagebedTags,
  formatDuration,
  summarize,
  toolFolderKey,
  updateImagebedItem,
} from "../lib/imagebed";
import { attachmentStore, errorText, pickLocalMedia } from "../lib/attachments";
import type { ImagebedFolder, ImagebedItem, ImagebedKind, ImagebedOrigin } from "../types";

const ORIGIN_ICON: Record<ImagebedOrigin, typeof Images> = {
  manual: Upload,
  "ai-gen": Sparkles,
  "image-crop": Crop,
  "size-chart": Ruler,
  "abnormal-ticket": Receipt,
  scratchpad: StickyNote,
};

/**
 * 工具文件夹的排列顺序：**常用的、有具体业务含义的在前**，`manual` 垫底。
 * 只列有图的（见下面的 `originRows`），否则侧栏会挂一串 0 的文件夹。
 */
const ORIGIN_ORDER: ImagebedOrigin[] = [
  "abnormal-ticket",
  "scratchpad",
  "image-crop",
  "ai-gen",
  "size-chart",
  "manual",
];

type KindFilter = ImagebedKind | "all";

/** 侧栏选中的格子："all" | "tool:<origin>" | "folder:<id>" */
type Scope = string;

export default function ImagebedView() {
  const { search: globalSearch } = useStore();

  /** 全量条目：文件夹计数、标签计数、以及过滤都在内存里做 */
  const [items, setItems] = useState<ImagebedItem[]>([]);
  const [folders, setFolders] = useState<ImagebedFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [scope, setScope] = useState<Scope>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [localSearch, setLocalSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  /** 仓库根目录，用来告诉用户文件到底落在哪 */
  const [repoRoot, setRepoRoot] = useState<string>("");
  /** 预览中的条目 id，null 表示没开大图 */
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** 卡片上的「移到文件夹」浮层：固定定位，坐标按触发按钮算 */
  const [picker, setPicker] = useState<{ itemId: string; top: number; left: number } | null>(null);

  // 侧边栏那个搜索框对多媒体文件同样管用 —— 用户在"全部"里搜东西，
  // 切到多媒体文件却发现搜索词被无视，会以为搜索坏了
  const keyword = (localSearch || globalSearch).trim();

  const load = useCallback(async () => {
    try {
      // 一次取全量：内存库里筛比在 SQL 里拼字符串稳（见 lib/imagebed.ts 文件头），
      // 而且侧栏的计数本来就需要全量 —— 分两次查只会多一次往返
      const [rows, fs] = await Promise.all([fetchImagebed({}), fetchImagebedFolders()]);
      setItems(rows);
      setFolders(fs);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 工具（iframe）往多媒体文件里写东西时刷新本视图，见文件头
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener(IMAGEBED_CHANGED, onChange);
    return () => window.removeEventListener(IMAGEBED_CHANGED, onChange);
  }, [load]);

  useEffect(() => {
    void attachmentStore()
      .root()
      .then(setRepoRoot)
      .catch(() => setRepoRoot(""));
  }, []);

  // 提示自动消失。错误留久一点，用户可能要照着它去处理
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), notice.kind === "err" ? 7000 : 3000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /* ---------------- 计数 ---------------- */

  const counts = useMemo(() => {
    const byFolder = new Map<string, number>();
    const byTag = new Map<string, number>();
    let image = 0;
    let video = 0;
    let audio = 0;
    for (const i of items) {
      const k = folderKeyOf(i);
      byFolder.set(k, (byFolder.get(k) ?? 0) + 1);
      for (const t of i.tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
      if (i.kind === "video") video++;
      else if (i.kind === "audio") audio++;
      else image++;
    }
    const tags = Array.from(byTag.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
    return { byFolder, tags, image, video, audio };
  }, [items]);

  /**
   * 工具文件夹只列有图的（外加当前选中的那个）。
   * 全列出来的话，六个文件夹里四个写着 0 —— 比不分类还乱。
   */
  const originRows = useMemo(
    () =>
      ORIGIN_ORDER.filter(
        (o) => (counts.byFolder.get(toolFolderKey(o)) ?? 0) > 0 || scope === toolFolderKey(o),
      ),
    [counts.byFolder, scope],
  );

  /* ---------------- 过滤 ---------------- */

  const visible = useMemo(
    () =>
      items.filter((i) => {
        if (kind !== "all" && i.kind !== kind) return false;
        if (scope !== "all" && folderKeyOf(i) !== scope) return false;
        if (tag && !i.tags.includes(tag)) return false;
        if (keyword && !matchesImagebed(i, keyword)) return false;
        return true;
      }),
    [items, kind, scope, tag, keyword],
  );

  const filtered = Boolean(keyword) || kind !== "all" || scope !== "all" || Boolean(tag);

  /**
   * 音/视频补时长：只对"还没有时长"的条目做一次。
   *
   * 串行而不是 Promise.all：一次并行解码十几段音频会把主线程压满；
   * 而且这条链路只是"把卡片上的字变好看"，慢一点没人在意。
   */
  const probed = useRef<Set<string>>(new Set());
  useEffect(() => {
    const todo = items.filter(
      (i) =>
        (i.kind === "audio" || i.kind === "video") &&
        i.durationMs == null &&
        i.relPath &&
        !probed.current.has(i.id),
    );
    if (!todo.length) return;
    let alive = true;
    void (async () => {
      for (const it of todo) {
        probed.current.add(it.id);
        try {
          const url = await attachmentStore().url(it.relPath as string);
          const ms = await probeDuration(url, it.kind);
          if (!alive || !ms) continue;
          await updateImagebedItem(it.id, { durationMs: ms });
          setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, durationMs: ms } : x)));
        } catch {
          // 读不到就算了（文件缺失 / 编码不支持），不打扰用户
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [items]);

  /* ---------------- 操作 ---------------- */

  const importLocal = async () => {
    setBusy(true);
    try {
      // 多媒体文件：图片 / 视频 / 音频都能收（壁纸那种场景仍然只给图）
      const picked = await pickLocalMedia({ audio: true });
      if (!picked.length) return; // 用户取消，什么都不说才是对的
      // 正站在自建文件夹里导入 = 用户就是想把它们放进这个文件夹
      const target = scope.startsWith("folder:") ? scope.slice("folder:".length) : "";
      let ok = 0;
      const failed: string[] = [];
      for (const src of picked) {
        try {
          const it = await addToImagebed({ local: src, origin: "manual" });
          if (target) await setImagebedFolder(it.id, target);
          ok++;
        } catch (e) {
          failed.push(errorText(e));
        }
      }
      await load();
      if (failed.length) {
        setNotice({ kind: "err", text: `${ok} 个已导入，${failed.length} 个失败：${failed[0]}` });
      } else {
        setNotice({ kind: "ok", text: `已导入 ${ok} 个` });
      }
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: ImagebedItem) => {
    setBusy(true);
    try {
      const rel = await deleteImagebedItem(item.id);
      // rel 非空表示"没有别人再引用这个内容了"，物理文件可以回收。
      // 为 null 是正常情况（同一份字节被流程任务附件或另一条多媒体文件记录用着），
      // 这时只删记录、留文件 —— 绝不能想当然地把文件删掉。
      if (rel) await attachmentStore().remove(rel);
      if (previewId === item.id) setPreviewId(null);
      await load();
      setNotice({ kind: "ok", text: rel ? "已从多媒体文件移除" : "已从多媒体文件移除（文件仍被其它记录引用，保留）" });
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const rename = async (item: ImagebedItem, title: string) => {
    const next = title.trim();
    if (!next || next === item.title) return;
    try {
      await updateImagebedItem(item.id, { title: next });
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    }
  };

  const moveTo = async (item: ImagebedItem, folderId: string) => {
    setPicker(null);
    try {
      await setImagebedFolder(item.id, folderId);
      await load();
      const target = folderId
        ? folders.find((f) => f.id === folderId)?.name ?? "文件夹"
        : `工具默认（${originLabel(item.origin)}）`;
      setNotice({ kind: "ok", text: `已移到「${target}」` });
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    }
  };

  const saveTags = async (item: ImagebedItem, tags: string[]) => {
    const next = joinTags(tags);
    if (next === joinTags(item.tags)) return;
    try {
      await setImagebedTags(item.id, tags);
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    }
  };

  const createFolder = async (name: string) => {
    const clean = name.trim();
    if (!clean) return false;
    try {
      const f = await createImagebedFolder(clean);
      await load();
      setScope(`folder:${f.id}`);
      setNotice({ kind: "ok", text: `已新建文件夹「${f.name}」` });
      return true;
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
      return false;
    }
  };

  const renameFolder = async (folder: ImagebedFolder, name: string) => {
    const clean = name.trim();
    if (!clean || clean === folder.name) return;
    try {
      await renameImagebedFolder(folder.id, clean);
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    }
  };

  const removeFolder = async (folder: ImagebedFolder) => {
    try {
      const moved = await deleteImagebedFolder(folder.id);
      if (scope === `folder:${folder.id}`) setScope("all");
      await load();
      setNotice({
        kind: "ok",
        text: moved
          ? `已删除文件夹「${folder.name}」，其中 ${moved} 张图回到了各自的工具文件夹`
          : `已删除文件夹「${folder.name}」`,
      });
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    }
  };

  /* ---------------- 预览 ---------------- */

  const previewIndex = useMemo(
    () => (previewId ? visible.findIndex((i) => i.id === previewId) : -1),
    [visible, previewId],
  );

  // ←/→ 翻图、Esc 关闭。挂在 window 上而不是大图容器上：
  // 预览是全屏的，焦点在哪儿都不该影响这几个键
  useEffect(() => {
    if (!previewId) return;
    const step = (d: number) => {
      setPreviewId((cur) => {
        const idx = visible.findIndex((i) => i.id === cur);
        const next = idx + d;
        if (idx < 0 || next < 0 || next >= visible.length) return cur;
        return visible[next].id;
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewId(null);
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewId, visible]);

  const previewing = previewIndex >= 0 ? visible[previewIndex] : null;
  const pickerItem = picker ? items.find((i) => i.id === picker.itemId) ?? null : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface" data-gallery="">
      {/* 头部 */}
      <div className="shrink-0 border-b border-line px-5 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <Images size={16} className="text-fg-dim" />
          <span className="text-[15px] font-semibold text-fg">多媒体文件</span>
          <span
            className="rounded-full bg-chip px-1.5 py-px text-[11px] text-fg-3"
            data-gallery-count={visible.length}
          >
            {filtered ? `${visible.length} / ${items.length}` : items.length}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => void importLocal()}
            disabled={busy}
            data-gallery-import=""
            className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
          >
            <Plus size={13} />
            导入文件
          </button>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Chip active={kind === "all"} onClick={() => setKind("all")} navKey="all">
            全部 {items.length}
          </Chip>
          <Chip active={kind === "image"} onClick={() => setKind("image")} navKey="image">
            图片 {counts.image}
          </Chip>
          <Chip active={kind === "video"} onClick={() => setKind("video")} navKey="video">
            视频 {counts.video}
          </Chip>
          <Chip active={kind === "audio"} onClick={() => setKind("audio")} navKey="audio">
            音频 {counts.audio}
          </Chip>

          {tag && (
            <button
              onClick={() => setTag(null)}
              data-gallery-tag-active={tag}
              className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[12px] text-primary"
              title="取消标签筛选"
            >
              <Tag size={10} />#{tag}
              <X size={10} />
            </button>
          )}

          <div className="flex-1" />
          <div className="flex h-7 min-w-[180px] items-center gap-1.5 rounded-md border border-line bg-card px-2 focus-within:border-primary">
            <Search size={12} className="shrink-0 text-fg-dim" />
            <input
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="搜标题 / 标签 / 备注"
              data-gallery-search=""
              className="min-w-0 flex-1 border-0 bg-transparent text-[12px] outline-none placeholder:text-fg-dim"
            />
            {localSearch && (
              <button onClick={() => setLocalSearch("")} className="text-fg-dim">
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 提示条 */}
      {notice && (
        <div
          data-gallery-notice={notice.kind}
          className={`shrink-0 px-5 py-1.5 text-[12px] ${
            notice.kind === "err" ? "bg-danger-soft text-danger" : "bg-chip text-fg-2"
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* 主体：左分类栏 + 右网格 */}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          total={items.length}
          counts={counts.byFolder}
          tags={counts.tags}
          tag={tag}
          onTag={setTag}
          scope={scope}
          onScope={setScope}
          originRows={originRows}
          folders={folders}
          onCreate={createFolder}
          onRename={renameFolder}
          onDelete={removeFolder}
        />

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="text-[13px] text-fg-dim">正在读取多媒体文件…</p>
          ) : loadError ? (
            <div className="rounded-lg border border-line bg-card p-4 text-[13px] text-danger">
              读多媒体文件失败：{loadError}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              filtered={filtered}
              repoRoot={repoRoot}
              onImport={() => void importLocal()}
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {visible.map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  folders={folders}
                  onOpen={() => setPreviewId(item.id)}
                  onRemove={() => void remove(item)}
                  onRename={(t) => void rename(item, t)}
                  onMove={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    // 从按钮左缘往下展开：右对齐的话面板会盖住卡片本身（实测）
                    setPicker({ itemId: item.id, top: r.bottom + 6, left: r.left - 4 });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 底部：仓库位置。用户问"我的图到底存哪了"时，答案要能直接看见 */}
      {repoRoot && (
        <div className="shrink-0 border-t border-line px-5 py-1.5">
          <span className="flex items-center gap-1.5 text-[11px] text-fg-dim">
            <FolderOpen size={11} />
            文件仓库：{repoRoot}
          </span>
        </div>
      )}

      {picker && pickerItem && (
        <FolderPicker
          item={pickerItem}
          folders={folders}
          top={picker.top}
          left={picker.left}
          onPick={(folderId) => void moveTo(pickerItem, folderId)}
          onClose={() => setPicker(null)}
        />
      )}

      {previewing && (
        <Lightbox
          item={previewing}
          folders={folders}
          index={previewIndex}
          total={visible.length}
          onClose={() => setPreviewId(null)}
          onPrev={() => previewIndex > 0 && setPreviewId(visible[previewIndex - 1].id)}
          onNext={() =>
            previewIndex < visible.length - 1 && setPreviewId(visible[previewIndex + 1].id)
          }
          onRemove={() => void remove(previewing)}
          onRename={(t) => void rename(previewing, t)}
          onMove={(folderId) => void moveTo(previewing, folderId)}
          onTags={(tags) => void saveTags(previewing, tags)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 左分类栏                                                            */
/* ------------------------------------------------------------------ */

function Sidebar({
  total,
  counts,
  tags,
  tag,
  onTag,
  scope,
  onScope,
  originRows,
  folders,
  onCreate,
  onRename,
  onDelete,
}: {
  total: number;
  counts: Map<string, number>;
  tags: { name: string; count: number }[];
  tag: string | null;
  onTag: (t: string | null) => void;
  scope: Scope;
  onScope: (s: Scope) => void;
  originRows: ImagebedOrigin[];
  folders: ImagebedFolder[];
  onCreate: (name: string) => Promise<boolean>;
  onRename: (f: ImagebedFolder, name: string) => void;
  onDelete: (f: ImagebedFolder) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <aside
      className="flex w-[172px] shrink-0 flex-col border-r border-line bg-surface"
      data-gallery-sidebar=""
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <SideRow
          active={scope === "all"}
          icon={Layers}
          label="全部素材"
          count={total}
          onClick={() => onScope("all")}
          navKey="all"
        />

        {originRows.length > 0 && <SideSection>工具</SideSection>}
        {originRows.map((o) => (
          <SideRow
            key={o}
            active={scope === toolFolderKey(o)}
            icon={ORIGIN_ICON[o] ?? Images}
            dot={ORIGIN_COLOR[o]}
            label={originLabel(o)}
            count={counts.get(toolFolderKey(o)) ?? 0}
            onClick={() => onScope(toolFolderKey(o))}
            navKey={`tool-${o}`}
          />
        ))}

        <div className="mt-3 flex items-center justify-between px-2 pb-1">
          <span className="text-[10.5px] font-medium tracking-wide text-fg-dim">我的文件夹</span>
          <button
            onClick={() => {
              setDraft("");
              setCreating(true);
            }}
            title="新建文件夹"
            data-gallery-new-folder=""
            className="grid size-5 place-items-center rounded text-fg-dim hover:bg-hover hover:text-fg"
          >
            <FolderPlus size={12} />
          </button>
        </div>

        {folders.map((f) => (
          <FolderRow
            key={f.id}
            folder={f}
            count={counts.get(`folder:${f.id}`) ?? 0}
            active={scope === `folder:${f.id}`}
            onSelect={() => onScope(`folder:${f.id}`)}
            onRename={(name) => onRename(f, name)}
            onDelete={() => onDelete(f)}
          />
        ))}

        {creating && (
          <div className="px-1 py-1">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="文件夹名，回车确定"
              data-gallery-folder-input=""
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setCreating(false);
                  setDraft("");
                }
                if (e.key === "Enter") {
                  const name = draft;
                  void onCreate(name).then((ok) => {
                    // 失败（重名）时留着输入框让用户改，别把刚打的字清掉
                    if (ok) {
                      setCreating(false);
                      setDraft("");
                    }
                  });
                }
              }}
              className="w-full rounded border border-primary bg-card px-1.5 py-1 text-[12px] outline-none"
            />
          </div>
        )}

        {!folders.length && !creating && (
          <p className="px-2 pb-1 text-[11px] leading-relaxed text-fg-dim">
            还没有自建文件夹。点右上角 +
          </p>
        )}

        {tags.length > 0 && <SideSection>标签</SideSection>}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1.5 pb-1" data-gallery-tags="">
            {tags.map((t) => (
              <button
                key={t.name}
                onClick={() => onTag(tag === t.name ? null : t.name)}
                data-gallery-tag={t.name}
                className={`max-w-full truncate rounded-full px-1.5 py-0.5 text-[10.5px] transition-colors ${
                  tag === t.name
                    ? "bg-primary/12 font-medium text-primary"
                    : "bg-chip text-fg-3 hover:text-fg"
                }`}
                title={`#${t.name} · ${t.count} 张`}
              >
                #{t.name}
                <span className="ml-0.5 opacity-60">{t.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function SideSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 px-2 pb-1 text-[10.5px] font-medium tracking-wide text-fg-dim">
      {children}
    </div>
  );
}

function SideRow({
  active,
  icon: Icon,
  dot,
  label,
  count,
  onClick,
  navKey,
}: {
  active: boolean;
  icon?: typeof Images;
  dot?: string;
  label: string;
  count: number;
  onClick: () => void;
  navKey?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-gallery-scope={navKey}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors ${
        active ? "bg-chip font-medium text-fg" : "text-fg-3 hover:bg-hover"
      }`}
    >
      {dot ? (
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} />
      ) : Icon ? (
        <Icon size={12} className="shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10.5px] text-fg-dim">{count}</span>
    </button>
  );
}

function FolderRow({
  folder,
  count,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  folder: ImagebedFolder;
  count: number;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  /** 删除要按两下：垃圾桶很小，误点一下就把文件夹名丢了 */
  const [confirming, setConfirming] = useState(false);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== folder.name) onRename(draft);
    else setDraft(folder.name);
  };

  if (editing) {
    return (
      <div className="px-1 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-gallery-folder-rename=""
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(folder.name);
              setEditing(false);
            }
          }}
          className="w-full rounded border border-primary bg-card px-1.5 py-1 text-[12px] outline-none"
        />
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1 rounded-md bg-danger-soft px-2 py-1 text-[11.5px] text-danger">
        <span className="min-w-0 flex-1 truncate">删除「{folder.name}」？</span>
        <button
          onClick={() => {
            setConfirming(false);
            onDelete();
          }}
          data-gallery-folder-delete-confirm={folder.id}
          className="shrink-0 rounded px-1 font-medium"
        >
          删
        </button>
        <button onClick={() => setConfirming(false)} className="shrink-0 rounded px-1 text-fg-2">
          留
        </button>
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center rounded-md transition-colors ${
        active ? "bg-chip" : "hover:bg-hover"
      }`}
      data-gallery-folder-row={folder.id}
    >
      <button
        onClick={onSelect}
        onDoubleClick={() => {
          setDraft(folder.name);
          setEditing(true);
        }}
        title="双击重命名"
        className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-[12px] ${
          active ? "font-medium text-fg" : "text-fg-3"
        }`}
      >
        <Folder size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <span className="shrink-0 text-[10.5px] text-fg-dim group-hover:hidden">{count}</span>
      </button>
      <span className="hidden shrink-0 gap-0.5 pr-1 group-hover:flex">
        <button
          onClick={() => {
            setDraft(folder.name);
            setEditing(true);
          }}
          title="重命名"
          className="grid size-4 place-items-center rounded text-fg-dim hover:bg-chip hover:text-fg"
        >
          <Pencil size={10} />
        </button>
        <button
          onClick={() => setConfirming(true)}
          title="删除文件夹（图片会回到工具文件夹）"
          data-gallery-folder-delete={folder.id}
          className="grid size-4 place-items-center rounded text-fg-dim hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 size={10} />
        </button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 移到文件夹                                                          */
/* ------------------------------------------------------------------ */

/**
 * 卡片上的「移到文件夹」浮层。
 *
 * 用 fixed 定位（不是 absolute）：卡片本身 `overflow-hidden`，absolute 面板会被裁掉；
 * 而且网格在滚动容器里，absolute 还会跟着内容跑。坐标按触发按钮算并钳进视口 ——
 * 这是这个项目里踩过的坑（见 MEMORY 的「弹出面板」）。
 */
function FolderPicker({
  item,
  folders,
  top,
  left,
  onPick,
  onClose,
}: {
  item: ImagebedItem;
  folders: ImagebedFolder[];
  top: number;
  left: number;
  onPick: (folderId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const W = 196;
  const H = 268;
  const x = Math.round(Math.min(window.innerWidth - W - 8, Math.max(8, left)));
  const y = Math.round(Math.min(window.innerHeight - H - 8, Math.max(8, top)));

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 overflow-y-auto rounded-lg border border-line bg-card p-1 shadow-lg"
        style={{ top: y, left: x, width: W, maxHeight: H }}
        data-gallery-move-menu=""
      >
        <p className="px-2 py-1 text-[10.5px] text-fg-dim">移到文件夹</p>
        <button
          onClick={() => onPick("")}
          className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-hover ${
            item.folderId ? "text-fg-3" : "font-medium text-fg"
          }`}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: ORIGIN_COLOR[item.origin] }}
          />
          <span className="min-w-0 flex-1 truncate">工具默认（{originLabel(item.origin)}）</span>
          {!item.folderId && <Check size={11} className="shrink-0 text-primary" />}
        </button>
        {folders.length > 0 && <div className="my-1 h-px bg-line" />}
        {folders.map((f) => (
          <button
            key={f.id}
            onClick={() => onPick(f.id)}
            data-gallery-move-to={f.id}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-hover ${
              item.folderId === f.id ? "font-medium text-fg" : "text-fg-3"
            }`}
          >
            <Folder size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            {item.folderId === f.id && <Check size={11} className="shrink-0 text-primary" />}
          </button>
        ))}
        {!folders.length && (
          <p className="px-2 py-1.5 text-[11px] leading-relaxed text-fg-dim">
            还没有自建文件夹。在左侧「我的文件夹」旁点 +
          </p>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 子组件                                                              */
/* ------------------------------------------------------------------ */

function Chip({
  active,
  onClick,
  children,
  navKey,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  navKey?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-gallery-filter={navKey}
      className={`rounded-full px-2.5 py-1 text-[12px] transition-colors ${
        active ? "bg-chip font-medium text-fg" : "text-fg-3 hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({
  filtered,
  repoRoot,
  onImport,
}: {
  filtered: boolean;
  repoRoot: string;
  onImport: () => void;
}) {
  return (
    <div className="grid place-items-center py-16 text-center" data-gallery-empty="">
      <div className="max-w-[380px]">
        <Images size={28} className="mx-auto mb-3 text-fg-dim" />
        <p className="text-[13px] text-fg-2">
          {filtered ? "这个分类里没有内容" : "多媒体文件还是空的"}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">
          {filtered
            ? "换个文件夹、标签或清空搜索词试试。"
            : "AI 生成的结果、图片编辑的导出都会落到这里；本机的图片、视频、音频也可以直接拖进来。"}
        </p>
        {!filtered && (
          <button
            onClick={onImport}
            className="mt-3 rounded-md border border-line bg-card px-3 py-1.5 text-[12px] text-fg-2 hover:bg-hover"
          >
            导入文件
          </button>
        )}
        {repoRoot && <p className="mt-3 break-all text-[11px] text-fg-dim">{repoRoot}</p>}
      </div>
    </div>
  );
}

/**
 * 读一段音/视频的时长（毫秒）。
 *
 * 为什么要在宿主侧读：上传时工具只给字节，容器里的时长得解码才知道；
 * 而卡片上"3:07"比"音频"有用得多。读不到就返回 null（不阻塞、不报错）——
 * 文件被手动清掉、编码奇怪都是真实会发生的，界面不该因此红一片。
 */
function probeDuration(url: string, kind: ImagebedKind): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.preload = "metadata";
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      el.removeAttribute("src");
      resolve(v);
    };
    el.onloadedmetadata = () => {
      const d = (el as HTMLMediaElement).duration;
      finish(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null);
    };
    el.onerror = () => finish(null);
    // 兜底：某些容器在 WebView2 里永远不触发 loadedmetadata，别让队列卡死
    window.setTimeout(() => finish(null), 4000);
    el.src = url;
  });
}

/**
 * 缩略图 URL 解析。
 *
 * 两个驱动都可能是异步的（桌面是 asset 协议转路径，浏览器要先去
 * IndexedDB 取 blob），所以做成本地状态的异步解析，而不是同步拼串。
 */
function useMediaUrl(relPath: string | null) {
  const [url, setUrl] = useState<string>("");
  useEffect(() => {
    if (!relPath) {
      setUrl("");
      return;
    }
    let alive = true;
    attachmentStore()
      .url(relPath)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        // 文件被用户手动清理过是真实会发生的事，这里保持空 URL，
        // 卡片显示"文件缺失"而不是一张破图
        if (alive) setUrl("");
      });
    return () => {
      alive = false;
    };
  }, [relPath]);
  return url;
}

function Card({
  item,
  folders,
  onOpen,
  onRemove,
  onRename,
  onMove,
}: {
  item: ImagebedItem;
  folders: ImagebedFolder[];
  onOpen: () => void;
  onRemove: () => void;
  onRename: (title: string) => void;
  onMove: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const url = useMediaUrl(item.relPath);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const Icon = ORIGIN_ICON[item.origin] ?? Images;
  const folderName = item.folderId
    ? folders.find((f) => f.id === item.folderId)?.name ?? "文件夹"
    : originLabel(item.origin);

  return (
    <div
      className="group relative overflow-hidden rounded-lg border border-line bg-card"
      data-gallery-card={item.id}
      data-gallery-item-folder={folderKeyOf(item)}
    >
      <button
        onClick={onOpen}
        className="block aspect-square w-full overflow-hidden bg-panel"
        title={item.title}
      >
        {item.kind === "audio" ? (
          // 音频没有画面：画一块"声波"占位，附时长。不渲染 <audio> ——
          // 一页几十个 <audio preload=metadata> 会同时去读文件，白白拖慢滚动
          <span className="flex size-full flex-col items-center justify-center gap-1.5 bg-panel text-fg-dim">
            <Music size={22} />
            <span className="text-[11px]">{formatDuration(item.durationMs) || "音频"}</span>
          </span>
        ) : url ? (
          item.kind === "video" ? (
            <video src={url} preload="metadata" muted className="size-full object-cover" />
          ) : (
            <img src={url} alt={item.title} loading="lazy" className="size-full object-cover" />
          )
        ) : (
          <span className="grid size-full place-items-center text-[11px] text-fg-dim">
            {item.relPath ? "文件缺失" : "无文件"}
          </span>
        )}
      </button>

      {/* 来源徽标 */}
      <span
        className="pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-px text-[10px] text-white"
        data-gallery-origin={item.origin}
      >
        <Icon size={9} />
        {originLabel(item.origin)}
      </span>

      {/* 悬浮操作 */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          title="移到文件夹"
          onClick={onMove}
          data-gallery-move={item.id}
          className="grid size-6 place-items-center rounded bg-black/55 text-white hover:bg-black/75"
        >
          <FolderInput size={11} />
        </button>
        <button
          title="重命名"
          onClick={() => {
            setDraft(item.title);
            setEditing(true);
          }}
          className="grid size-6 place-items-center rounded bg-black/55 text-white hover:bg-black/75"
        >
          <Pencil size={11} />
        </button>
        <button
          title="从多媒体文件移除"
          onClick={onRemove}
          data-gallery-remove={item.id}
          className="grid size-6 place-items-center rounded bg-black/55 text-white hover:bg-danger"
        >
          <Trash2 size={11} />
        </button>
      </div>

      <div className="px-2 py-1.5">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onRename(draft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-full rounded border border-primary bg-card px-1 py-0.5 text-[12px] outline-none"
          />
        ) : (
          <p className="truncate text-[12px] text-fg-2" title={item.title}>
            {item.title}
          </p>
        )}
        <p className="truncate text-[10.5px] text-fg-dim">
          {item.folderId ? `${folderName} · ` : ""}
          {summarize(item)}
        </p>
        {item.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-0.5">
            {item.tags.slice(0, 2).map((t) => (
              <span
                key={t}
                className="max-w-full truncate rounded bg-chip px-1 text-[10px] text-fg-3"
                title={`#${t}`}
              >
                #{t}
              </span>
            ))}
            {item.tags.length > 2 && (
              <span className="text-[10px] text-fg-dim">+{item.tags.length - 2}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Lightbox({
  item,
  folders,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onRemove,
  onRename,
  onMove,
  onTags,
}: {
  item: ImagebedItem;
  folders: ImagebedFolder[];
  index: number;
  total: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRemove: () => void;
  onRename: (title: string) => void;
  onMove: (folderId: string) => void;
  onTags: (tags: string[]) => void;
}) {
  const url = useMediaUrl(item.relPath);
  const [showInfo, setShowInfo] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const [copied, setCopied] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  useEffect(() => {
    setDraft(item.title);
    setEditing(false);
    setCopied(false);
    setTagDraft("");
  }, [item.id, item.title]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      setCopied(true);
    } catch {
      // 非安全上下文下 clipboard 不可用。不弹"复制成功"骗人
      setCopied(false);
    }
  };

  const openSource = () => {
    if (item.sourceUrl) window.open(item.sourceUrl, "_blank", "noopener,noreferrer");
  };

  const addTag = () => {
    const v = tagDraft.trim();
    if (!v) return;
    onTags([...item.tags, v]);
    setTagDraft("");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/78"
      data-gallery-lightbox=""
      onClick={onClose}
    >
      {/* 大图区 */}
      <div className="relative flex min-w-0 flex-1 items-center justify-center p-4">
        {item.kind === "audio" ? (
          <div
            className="flex w-[340px] max-w-full flex-col items-center gap-3 rounded-xl border border-white/15 bg-white/10 px-6 py-7"
            onClick={(e) => e.stopPropagation()}
          >
            <AudioLines size={40} className="text-white/80" />
            <p className="max-w-full truncate text-[13px] text-white/85" title={item.title}>
              {item.title}
            </p>
            {url ? (
              <audio src={url} controls autoPlay className="w-full" />
            ) : (
              <p className="text-[12px] text-white/70">文件不在仓库里（可能被手动清理过）</p>
            )}
            <p className="text-[11px] text-white/55">{summarize(item)}</p>
          </div>
        ) : url ? (
          item.kind === "video" ? (
            <video
              src={url}
              controls
              autoPlay
              className="max-h-full max-w-full rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={url}
              alt={item.title}
              className="max-h-full max-w-full rounded-lg object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )
        ) : (
          <p className="text-[13px] text-white/80">文件不在仓库里（可能被手动清理过）</p>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          disabled={index <= 0}
          title="上一张（←）"
          className="absolute left-2 grid size-9 place-items-center rounded-full bg-black/50 text-white disabled:opacity-25"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          disabled={index >= total - 1}
          title="下一张（→）"
          className="absolute right-2 grid size-9 place-items-center rounded-full bg-black/50 text-white disabled:opacity-25"
        >
          <ChevronRight size={18} />
        </button>

        <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">
          {index + 1} / {total}
        </span>
      </div>

      {/* 信息栏 */}
      {showInfo ? (
        <div
          className="flex w-[280px] shrink-0 flex-col bg-card"
          onClick={(e) => e.stopPropagation()}
          data-gallery-info=""
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Info size={13} className="text-fg-dim" />
            <span className="text-[12px] font-medium text-fg">信息</span>
            <div className="flex-1" />
            <button
              onClick={() => setShowInfo(false)}
              className="grid size-6 place-items-center rounded text-fg-dim hover:bg-hover"
              title="收起信息栏"
            >
              <X size={13} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3 text-[12px]">
            <div>
              <p className="mb-0.5 text-[11px] text-fg-dim">标题</p>
              {editing ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onRename(draft);
                        setEditing(false);
                      }
                      if (e.key === "Escape") setEditing(false);
                    }}
                    className="min-w-0 flex-1 rounded border border-primary bg-card px-1.5 py-1 outline-none"
                  />
                  <button
                    onClick={() => {
                      onRename(draft);
                      setEditing(false);
                    }}
                    className="grid size-6 place-items-center rounded bg-chip text-fg-2"
                  >
                    <Check size={12} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-fg-2 hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 break-all">{item.title}</span>
                  <Pencil size={11} className="shrink-0 text-fg-dim" />
                </button>
              )}
            </div>

            {/* 文件夹：工具默认 or 自建。图片要么在这儿、要么在那儿，不会两处都在 */}
            <div>
              <p className="mb-0.5 text-[11px] text-fg-dim">文件夹</p>
              <select
                value={item.folderId}
                onChange={(e) => onMove(e.target.value)}
                data-gallery-folder-select=""
                className="w-full rounded border border-line bg-card px-1.5 py-1 text-[12px] text-fg-2 outline-none focus:border-primary"
              >
                <option value="">工具默认（{originLabel(item.origin)}）</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="mb-0.5 flex items-center gap-1 text-[11px] text-fg-dim">
                <Tag size={10} />
                标签
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {item.tags.map((t) => (
                  <span
                    key={t}
                    className="flex max-w-full items-center gap-0.5 rounded bg-chip px-1.5 py-0.5 text-[11px] text-fg-2"
                    data-gallery-item-tag={t}
                  >
                    <span className="min-w-0 truncate">#{t}</span>
                    <button
                      onClick={() => onTags(item.tags.filter((x) => x !== t))}
                      title="移除这个标签"
                      className="shrink-0 text-fg-dim hover:text-danger"
                    >
                      <X size={9} />
                    </button>
                  </span>
                ))}
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      addTag();
                      e.preventDefault();
                    }
                  }}
                  onBlur={addTag}
                  placeholder="加标签…"
                  data-gallery-tag-input=""
                  className="min-w-[70px] flex-1 rounded border border-line bg-card px-1.5 py-0.5 text-[11.5px] outline-none placeholder:text-fg-dim focus:border-primary"
                />
              </div>
            </div>

            <Row label="来源">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: ORIGIN_COLOR[item.origin] }}
                />
                {originLabel(item.origin)}
              </span>
            </Row>
            <Row label="类型">{item.mime || item.kind}</Row>
            <Row label="规格">{summarize(item)}</Row>
            <Row label="大小">{item.size ? `${item.size} 字节` : "—"}</Row>
            <Row label="存入时间">{item.createdAt.replace("T", " ").slice(0, 16)}</Row>
            {item.hash && (
              <Row label="指纹">
                <span className="font-mono text-[11px]">{item.hash.slice(0, 16)}…</span>
              </Row>
            )}

            {item.prompt && (
              <div>
                <p className="mb-0.5 flex items-center gap-1 text-[11px] text-fg-dim">
                  提示词
                  <button
                    onClick={() => void copyPrompt()}
                    className="rounded px-1 text-[10px] text-fg-3 hover:bg-hover"
                  >
                    {copied ? "已复制" : "复制"}
                  </button>
                </p>
                <p className="rounded bg-panel px-2 py-1.5 leading-relaxed break-all text-fg-2">
                  {item.prompt}
                </p>
              </div>
            )}

            {item.sourceUrl && (
              <div>
                <p className="mb-0.5 text-[11px] text-fg-dim">原始地址</p>
                <button
                  onClick={openSource}
                  className="w-full break-all rounded bg-panel px-2 py-1.5 text-left text-fg-2 hover:bg-hover"
                >
                  {item.sourceUrl}
                </button>
              </div>
            )}
          </div>

          <div className="border-t border-line p-3">
            <button
              onClick={onRemove}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-2 hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 size={12} />
              从多媒体文件移除
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowInfo(true);
          }}
          className="absolute top-3 right-3 grid size-8 place-items-center rounded-full bg-black/55 text-white"
          title="显示信息"
        >
          <Info size={15} />
        </button>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-[54px] shrink-0 text-[11px] text-fg-dim">{label}</span>
      <span className="min-w-0 flex-1 break-all text-fg-2">{children}</span>
    </div>
  );
}
