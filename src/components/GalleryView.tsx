/**
 * 图库 —— 工作台里所有图片/视频的共同落点。
 *
 * 设计取向（与工作台其余部分一致）：
 * - 取数只走 lib/gallery.ts，组件不直接碰 db
 * - 不写假按钮：没有文件、删除失败这类情况都给出真实状态
 * - 关键状态写 `data-*`，e2e 靠它断言，不靠中文文案
 *
 * 与 AI 生成工具的联动是双向的，两边都落在这里：
 *   工具 → 图库：AI 出图后一键「存进图库」，产物落在本视图里
 *   图库 → 工具：AI 的参考图可直接从图库挑
 * 后者不需要本组件参与（工具在自己的界面里列图库），
 * 但**前者需要一个刷新信号** —— 工具是 iframe，写库发生在宿主进程里，
 * 本组件不知道。所以宿主写入后广播 `workbench:gallery-changed`，这里监听它。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Images,
  ImageIcon,
  Film,
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
} from "lucide-react";
import { useStore } from "../store";
import {
  addToGallery,
  deleteGalleryItem,
  fetchGallery,
  GALLERY_CHANGED,
  originLabel,
  ORIGIN_COLOR,
  summarize,
  updateGalleryItem,
  type GalleryQuery,
} from "../lib/gallery";
import { attachmentStore, errorText, pickLocalMedia } from "../lib/attachments";
import type { GalleryItem, GalleryKind, GalleryOrigin } from "../types";

const ORIGIN_ICON: Record<GalleryOrigin, typeof Images> = {
  manual: Upload,
  "ai-gen": Sparkles,
  "image-crop": Crop,
  "size-chart": Ruler,
};

type KindFilter = GalleryKind | "all";
type OriginFilter = GalleryOrigin | "all";

export default function GalleryView() {
  const { search: globalSearch } = useStore();

  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [localSearch, setLocalSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  /** 仓库根目录，用来告诉用户文件到底落在哪 */
  const [repoRoot, setRepoRoot] = useState<string>("");
  /** 预览中的条目 id，null 表示没开大图 */
  const [previewId, setPreviewId] = useState<string | null>(null);

  // 侧边栏那个搜索框对图库同样管用 —— 用户在"全部"里搜东西，
  // 切到图库却发现搜索词被无视，会以为搜索坏了
  const keyword = (localSearch || globalSearch).trim();

  const load = useCallback(async () => {
    try {
      const query: GalleryQuery = { kind, origin, search: keyword };
      const rows = await fetchGallery(query);
      setItems(rows);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [kind, origin, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  // 工具（iframe）往图库里写东西时刷新本视图，见文件头
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener(GALLERY_CHANGED, onChange);
    return () => window.removeEventListener(GALLERY_CHANGED, onChange);
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

  const importLocal = async () => {
    setBusy(true);
    try {
      const picked = await pickLocalMedia();
      if (!picked.length) return; // 用户取消，什么都不说才是对的
      let ok = 0;
      const failed: string[] = [];
      for (const src of picked) {
        try {
          await addToGallery({ local: src, origin: "manual" });
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

  const remove = async (item: GalleryItem) => {
    setBusy(true);
    try {
      const rel = await deleteGalleryItem(item.id);
      // rel 非空表示"没有别人再引用这个内容了"，物理文件可以回收。
      // 为 null 是正常情况（同一份字节被流程任务附件或另一条图库记录用着），
      // 这时只删记录、留文件 —— 绝不能想当然地把文件删掉。
      if (rel) await attachmentStore().remove(rel);
      if (previewId === item.id) setPreviewId(null);
      await load();
      setNotice({ kind: "ok", text: rel ? "已从图库移除" : "已从图库移除（文件仍被其它记录引用，保留）" });
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const rename = async (item: GalleryItem, title: string) => {
    const next = title.trim();
    if (!next || next === item.title) return;
    try {
      await updateGalleryItem(item.id, { title: next });
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    }
  };

  const previewIndex = useMemo(
    () => (previewId ? items.findIndex((i) => i.id === previewId) : -1),
    [items, previewId],
  );

  // ←/→ 翻图、Esc 关闭。挂在 window 上而不是大图容器上：
  // 预览是全屏的，焦点在哪儿都不该影响这几个键
  useEffect(() => {
    if (!previewId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewId(null);
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    const step = (d: number) => {
      setPreviewId((cur) => {
        const idx = items.findIndex((i) => i.id === cur);
        const next = idx + d;
        if (idx < 0 || next < 0 || next >= items.length) return cur;
        return items[next].id;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewId, items]);

  const counts = useMemo(() => {
    let image = 0;
    let video = 0;
    for (const i of items) {
      if (i.kind === "video") video++;
      else image++;
    }
    return { image, video };
  }, [items]);

  const previewing = previewIndex >= 0 ? items[previewIndex] : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface" data-gallery="">
      {/* 头部 */}
      <div className="shrink-0 border-b border-line px-5 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <Images size={16} className="text-fg-dim" />
          <span className="text-[15px] font-semibold text-fg">图库</span>
          <span
            className="rounded-full bg-chip px-1.5 py-px text-[11px] text-fg-3"
            data-gallery-count={items.length}
          >
            {items.length}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => void importLocal()}
            disabled={busy}
            data-gallery-import=""
            className="flex items-center gap-1.5 rounded-md bg-[#378add] px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
          >
            <Plus size={13} />
            导入图片 / 视频
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

          <span className="mx-1 h-4 w-px bg-line" />

          <Chip active={origin === "all"} onClick={() => setOrigin("all")} navKey="origin-all">
            所有来源
          </Chip>
          {(["ai-gen", "image-crop", "size-chart", "manual"] as GalleryOrigin[]).map((o) => (
            <Chip key={o} active={origin === o} onClick={() => setOrigin(o)} navKey={`origin-${o}`}>
              <span
                className="mr-1 inline-block size-1.5 rounded-full align-middle"
                style={{ background: ORIGIN_COLOR[o] }}
              />
              {originLabel(o)}
            </Chip>
          ))}

          <div className="flex-1" />
          <div className="flex h-7 min-w-[180px] items-center gap-1.5 rounded-md border border-line bg-card px-2 focus-within:border-[#378add]">
            <Search size={12} className="shrink-0 text-fg-dim" />
            <input
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="搜标题 / 提示词 / 备注"
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

      {/* 主体 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="text-[13px] text-fg-dim">正在读取图库…</p>
        ) : loadError ? (
          <div className="rounded-lg border border-line bg-card p-4 text-[13px] text-danger">
            读图库失败：{loadError}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            filtered={Boolean(keyword) || kind !== "all" || origin !== "all"}
            repoRoot={repoRoot}
            onImport={() => void importLocal()}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {items.map((item) => (
              <Card
                key={item.id}
                item={item}
                onOpen={() => setPreviewId(item.id)}
                onRemove={() => void remove(item)}
                onRename={(t) => void rename(item, t)}
              />
            ))}
          </div>
        )}
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

      {previewing && (
        <Lightbox
          item={previewing}
          index={previewIndex}
          total={items.length}
          onClose={() => setPreviewId(null)}
          onPrev={() => previewIndex > 0 && setPreviewId(items[previewIndex - 1].id)}
          onNext={() =>
            previewIndex < items.length - 1 && setPreviewId(items[previewIndex + 1].id)
          }
          onRemove={() => void remove(previewing)}
          onRename={(t) => void rename(previewing, t)}
        />
      )}
    </div>
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
          {filtered ? "没有符合条件的图片" : "图库还是空的"}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">
          {filtered
            ? "换个筛选条件或清空搜索词试试。"
            : "AI 生成的结果、图片裁剪的导出、尺码表的成品都会落到这里；也可以直接把本机图片拖进来。"}
        </p>
        {!filtered && (
          <button
            onClick={onImport}
            className="mt-3 rounded-md border border-line bg-card px-3 py-1.5 text-[12px] text-fg-2 hover:bg-hover"
          >
            导入图片 / 视频
          </button>
        )}
        {repoRoot && <p className="mt-3 break-all text-[11px] text-fg-dim">{repoRoot}</p>}
      </div>
    </div>
  );
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
  onOpen,
  onRemove,
  onRename,
}: {
  item: GalleryItem;
  onOpen: () => void;
  onRemove: () => void;
  onRename: (title: string) => void;
}) {
  const url = useMediaUrl(item.relPath);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const Icon = ORIGIN_ICON[item.origin] ?? Images;

  return (
    <div
      className="group relative overflow-hidden rounded-lg border border-line bg-card"
      data-gallery-card={item.id}
    >
      <button
        onClick={onOpen}
        className="block aspect-square w-full overflow-hidden bg-panel"
        title={item.title}
      >
        {url ? (
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
          title="从图库移除"
          onClick={onRemove}
          data-gallery-remove={item.id}
          className="grid size-6 place-items-center rounded bg-black/55 text-white hover:bg-[#c0392b]"
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
            className="w-full rounded border border-[#378add] bg-card px-1 py-0.5 text-[12px] outline-none"
          />
        ) : (
          <p className="truncate text-[12px] text-fg-2" title={item.title}>
            {item.title}
          </p>
        )}
        <p className="truncate text-[10.5px] text-fg-dim">{summarize(item)}</p>
      </div>
    </div>
  );
}

function Lightbox({
  item,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onRemove,
  onRename,
}: {
  item: GalleryItem;
  index: number;
  total: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRemove: () => void;
  onRename: (title: string) => void;
}) {
  const url = useMediaUrl(item.relPath);
  const [showInfo, setShowInfo] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const [copied, setCopied] = useState(false);
  const imgRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setDraft(item.title);
    setEditing(false);
    setCopied(false);
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

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/78"
      data-gallery-lightbox=""
      onClick={onClose}
    >
      {/* 大图区 */}
      <div className="relative flex min-w-0 flex-1 items-center justify-center p-4">
        {url ? (
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
              ref={(el) => {
                imgRef.current = el;
              }}
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
                    className="min-w-0 flex-1 rounded border border-[#378add] bg-card px-1.5 py-1 outline-none"
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
              从图库移除
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

/** 给别处用的图标映射（工具区/详情里标注来源时会用到） */
export { ImageIcon, Film };
