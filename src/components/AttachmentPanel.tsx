import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FolderOpen,
  Link2,
  Loader2,
  Paperclip,
  Play,
  RefreshCw,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useStore } from "../store";
import type { WoAttachment } from "../types";
import {
  attachmentStore,
  formatBytes,
  formatDuration,
  hostOf,
  openExternal,
} from "../lib/attachments";

/**
 * 工单附件栏。
 *
 * 三条产品约定（决定了这里为什么长这样）：
 *
 * 1. **图片视频进本地仓库，文件与网址只存链接。**
 *    前者会被外链拔掉、图床限流、跨域拦，而工单里回头要反复看的正是这些图；
 *    后者（几百 MB 的安装包、在线文档）留链接比留副本合理。
 *    界限不由用户选，由**真实内容**决定 —— 贴一个地址进来，
 *    是图片/视频就下载，不是就自动降级成链接并说明原因。
 *
 * 2. **类型不由网址后缀决定。** 很多图床地址没有 `.jpg`，
 *    反过来也有把 `.jpg` 指向一个 HTML 页面的。所以是先下后判。
 *
 * 3. **本地只收图片和视频。** 本地文件没有一个"换台机器还能用"的链接，
 *    硬把它当链接存下来（存个本机路径）是最坏的选择：
 *    当场能用，换机器全失效，而且失效得毫无征兆。所以直接拒绝并说清该怎么做。
 */
export default function AttachmentPanel({ orderId }: { orderId: string }) {
  const {
    attachments,
    attachBusy,
    attachFromUrl,
    attachLocal,
    removeAttachment,
    reorderAttachment,
    probeAttachment,
    patchAttachment,
  } = useStore();

  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(
    null,
  );
  const [lightbox, setLightbox] = useState<WoAttachment | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 换工单时清掉上一条提示 —— 留着会让新工单看起来像是刚出过错
  useEffect(() => {
    setMessage(null);
    setDraft("");
  }, [orderId]);

  const submitUrl = async () => {
    const url = draft.trim();
    if (!url) return;
    const r = await attachFromUrl(url);
    if (r.status === "error") {
      setMessage({ tone: "err", text: `${r.message}（可以改存链接）` });
      return;
    }
    if (r.status === "link") {
      setMessage({
        tone: "warn",
        text: `${r.reason}，已按约定存成链接（本地不留副本）`,
      });
    } else {
      setMessage({
        tone: "ok",
        text: r.deduped
          ? `已加入：${r.title}。这份内容仓库里已经有，没有重复占空间`
          : `已下载到本地仓库：${r.title}`,
      });
    }
    setDraft("");
  };

  const submitFiles = async () => {
    const r = await attachLocal();
    if (!r) return;
    if (!r.added && r.failed.length) {
      setMessage({ tone: "err", text: r.failed.map((f) => `${f.name}：${f.reason}`).join("；") });
      return;
    }
    if (r.failed.length) {
      setMessage({
        tone: "warn",
        text: `已加入 ${r.added} 个；跳过 ${r.failed
          .map((f) => f.name || "未命名")
          .join("、")}（${r.failed[0].reason}）`,
      });
    } else {
      setMessage({ tone: "ok", text: `已加入 ${r.added} 个附件到本地仓库` });
    }
  };

  const images = attachments.filter((a) => a.kind === "image");
  const videos = attachments.filter((a) => a.kind === "video");
  const links = attachments.filter((a) => a.kind === "link");
  const media = [...images, ...videos];

  return (
    <div className="mt-4 px-4" data-attach-panel="" data-attach-count={attachments.length}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-fg-dim">
          <Paperclip size={13} />
          附件
          {attachments.length > 0 && (
            <span className="text-fg-3">
              {attachments.length}
              {media.length > 0 && links.length > 0 && `（图 ${media.length} · 链接 ${links.length}）`}
            </span>
          )}
        </div>
      </div>

      {/* 添加入口：贴网址 / 选本机文件 */}
      <div className="mt-1.5 flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-card px-2 py-1.5 focus-within:border-[#378add]">
          {attachBusy ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-fg-dim" />
          ) : (
            <Link2 size={13} className="shrink-0 text-fg-dim" />
          )}
          <input
            ref={inputRef}
            value={draft}
            data-attach-input=""
            disabled={attachBusy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitUrl();
              }
            }}
            placeholder={attachBusy ? "正在下载…" : "粘贴图片/视频网址，回车添加"}
            className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-fg-2 outline-none placeholder:text-fg-dim disabled:opacity-60"
          />
        </div>
        <button
          onClick={() => void submitFiles()}
          disabled={attachBusy}
          data-attach-files=""
          title="从本机选图片或视频复制进仓库"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-line bg-card px-2 py-1.5 text-[12px] text-fg-3 hover:bg-hover disabled:opacity-50"
        >
          <FolderOpen size={13} />
          文件
        </button>
      </div>

      {message && (
        <div
          data-attach-msg={message.tone}
          className={`mt-1.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] leading-relaxed ${
            message.tone === "ok"
              ? "bg-[#1d9e75]/10 text-[#0f6e56]"
              : message.tone === "warn"
                ? "bg-[#ba7517]/10 text-[#8a5a12]"
                : "bg-danger-soft text-danger"
          }`}
        >
          {message.tone !== "ok" && <AlertTriangle size={12} className="mt-[2px] shrink-0" />}
          <span className="min-w-0 flex-1">{message.text}</span>
          <button
            onClick={() => setMessage(null)}
            className="shrink-0 opacity-60 hover:opacity-100"
            title="关闭提示"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* 图片：两列网格 */}
      {images.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-1.5" data-attach-grid="image">
          {images.map((a) => (
            <MediaTile
              key={a.id}
              a={a}
              onOpen={() => setLightbox(a)}
              onRemove={() => void removeAttachment(a.id)}
              onUp={() => void reorderAttachment(a.id, -1)}
              onDown={() => void reorderAttachment(a.id, 1)}
              onProbed={(size) => void probeAttachment(a, size)}
            />
          ))}
        </div>
      )}

      {/* 视频：单列，能直接播 */}
      {videos.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1.5" data-attach-grid="video">
          {videos.map((a) => (
            <VideoTile
              key={a.id}
              a={a}
              onRemove={() => void removeAttachment(a.id)}
              onUp={() => void reorderAttachment(a.id, -1)}
              onDown={() => void reorderAttachment(a.id, 1)}
              onProbed={(size) => void probeAttachment(a, size)}
            />
          ))}
        </div>
      )}

      {/* 链接：整行，显示站点 */}
      {links.length > 0 && (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-card" data-attach-grid="link">
          {links.map((a) => (
            <LinkRow
              key={a.id}
              a={a}
              onRemove={() => void removeAttachment(a.id)}
              onRename={(t) => void patchAttachment(a.id, { title: t })}
              onUp={() => void reorderAttachment(a.id, -1)}
              onDown={() => void reorderAttachment(a.id, 1)}
            />
          ))}
        </div>
      )}

      {attachments.length === 0 && !attachBusy && (
        <div className="mt-1.5 rounded-lg border border-dashed border-line px-2.5 py-3 text-center text-[11.5px] leading-relaxed text-fg-dim">
          还没有附件。
          <br />
          图片和视频会下载到本地仓库，其它文件只存链接。
        </div>
      )}

      {lightbox && <Lightbox a={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/* -------------------------------- 媒体文件 -------------------------------- */

/** 把仓库相对路径解析成可用的 URL。失败说明文件真没了。 */
function useRepoUrl(a: WoAttachment) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const lastRel = useRef<string | null>(a.relPath);

  // 依赖整个 a 而不是只依赖 relPath。
  //
  // attachments 每次重新拉取都是**全新的对象**，所以这个 effect 会在
  // 数据刷新时重跑一遍 —— 这正是我们要的：仓库内容是在"重新拉取"之外
  // 被改掉的（补下载、删除、清空），不重跑就发现不了。
  //
  // 具体会踩的坑：同一份图被引用了两次，其中一条点了「重新下载」文件补回来了，
  // 另一条如果不重新解析，会一直挂着"文件缺失"，直到用户重启应用。
  // 只依赖 relPath 就必然踩这个坑 —— 补回来的路径和原来一样，effect 不会重跑。
  useEffect(() => {
    if (a.kind === "link" || !a.relPath) return;

    // 路径真的换了（补下载拿到了不同的文件）才清空，否则旧图会闪一下白
    if (lastRel.current !== a.relPath) {
      lastRel.current = a.relPath;
      setUrl(null);
      setMissing(false);
    }

    let alive = true;
    attachmentStore()
      .url(a.relPath)
      .then((u) => {
        if (!alive) return;
        setUrl(u);
        setMissing(false);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      // 刻意**不撤销** object URL：浏览器实现里它是按路径缓存的，
      // 这里撤了下次渲染又得重建，而且同一张图可能在灯箱里还用着。
      alive = false;
    };
  }, [a]);

  return { url, missing, markMissing: () => setMissing(true) };
}

function MediaTile({
  a,
  onOpen,
  onRemove,
  onUp,
  onDown,
  onProbed,
}: {
  a: WoAttachment;
  onOpen: () => void;
  onRemove: () => void;
  onUp: () => void;
  onDown: () => void;
  onProbed: (s: { width: number; height: number; durationMs: number | null }) => void;
}) {
  const { url, missing, markMissing } = useRepoUrl(a);

  return (
    <div
      data-attach-item={a.id}
      data-attach-kind="image"
      className="group relative aspect-square overflow-hidden rounded-lg border border-line bg-card"
    >
      {missing || !url ? (
        <MissingBox a={a} onRemove={onRemove} compact />
      ) : (
        <button onClick={onOpen} className="block size-full" title={`查看大图：${a.title}`}>
          <img
            src={url}
            alt={a.title}
            className="size-full object-cover"
            onError={markMissing}
            onLoad={(e) => {
              const el = e.currentTarget;
              // 量到就回填一次，之后不再重复（store 里也会判空）
              if (a.width == null && el.naturalWidth) {
                onProbed({ width: el.naturalWidth, height: el.naturalHeight, durationMs: null });
              }
            }}
          />
        </button>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-4 pb-1">
        <div className="truncate text-[10.5px] text-white/90" title={a.title}>
          {a.title}
        </div>
        <div className="text-[10px] text-white/60">
          {[a.width && a.height ? `${a.width}×${a.height}` : null, formatBytes(a.size)]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>

      <RowActions onRemove={onRemove} onUp={onUp} onDown={onDown} />
    </div>
  );
}

function VideoTile({
  a,
  onRemove,
  onUp,
  onDown,
  onProbed,
}: {
  a: WoAttachment;
  onRemove: () => void;
  onUp: () => void;
  onDown: () => void;
  onProbed: (s: { width: number; height: number; durationMs: number | null }) => void;
}) {
  const { url, missing, markMissing } = useRepoUrl(a);
  const [playing, setPlaying] = useState(false);

  if (missing || !url) {
    return (
      <div
        data-attach-item={a.id}
        data-attach-kind="video"
        className="rounded-lg border border-line bg-card p-2"
      >
        <MissingBox a={a} onRemove={onRemove} />
      </div>
    );
  }

  return (
    <div
      data-attach-item={a.id}
      data-attach-kind="video"
      className="group relative overflow-hidden rounded-lg border border-line bg-card"
    >
      <video
        src={url}
        controls={playing}
        preload="metadata"
        playsInline
        className="max-h-[220px] w-full bg-black"
        onError={markMissing}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (a.width == null && v.videoWidth) {
            onProbed({
              width: v.videoWidth,
              height: v.videoHeight,
              durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null,
            });
          }
        }}
      />
      {!playing && (
        <button
          onClick={() => setPlaying(true)}
          title="播放"
          data-attach-play=""
          className="absolute inset-0 grid place-items-center bg-black/25 transition-colors hover:bg-black/35"
        >
          <span className="grid size-11 place-items-center rounded-full bg-white/90 text-black shadow">
            <Play size={18} className="ml-[2px]" />
          </span>
        </button>
      )}

      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        <Video size={12} className="shrink-0 text-fg-dim" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-2" title={a.title}>
          {a.title}
        </span>
        <span className="shrink-0 text-[10.5px] text-fg-dim">
          {[
            formatDuration(a.durationMs),
            a.width && a.height ? `${a.width}×${a.height}` : null,
            formatBytes(a.size),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <RowActions onRemove={onRemove} onUp={onUp} onDown={onDown} />
    </div>
  );
}

/* -------------------------------- 链接 -------------------------------- */

function LinkRow({
  a,
  onRemove,
  onRename,
  onUp,
  onDown,
}: {
  a: WoAttachment;
  onRemove: () => void;
  onRename: (t: string) => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.title);
  useEffect(() => setText(a.title), [a.title]);

  const host = a.sourceUrl ? hostOf(a.sourceUrl) : "";

  return (
    <div
      data-attach-item={a.id}
      data-attach-kind="link"
      className="group flex items-center gap-2 border-b border-line px-2 py-1.5 last:border-0 hover:bg-chip"
    >
      {/* 刻意**不去抓站点图标**（favicon.ico）。两个理由：
          1) 隐私：二十条链接就是渲染时向二十个站点发请求，等于把"我关注这些站"
             广播出去；这和应用其它地方的离线优先立场也不一致（壁纸是随包的）。
          2) 写死 https 的话，内网/本机的 http 地址会在控制台刷一串 SSL 错误。
          站点名本来就显示在下面一行，信息并没有丢。 */}
      <span className="grid size-6 shrink-0 place-items-center rounded bg-chip">
        <Link2 size={12} className="text-fg-dim" />
      </span>

      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={text}
            data-attach-title-input=""
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              setEditing(false);
              const t = text.trim();
              if (t && t !== a.title) onRename(t);
              else setText(a.title);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setText(a.title);
                e.currentTarget.blur();
              }
            }}
            className="w-full rounded border border-[#378add] bg-card px-1 text-[12.5px] text-fg outline-none"
          />
        ) : (
          <button
            data-attach-link-title=""
            onDoubleClick={() => setEditing(true)}
            onClick={() => a.sourceUrl && void openExternal(a.sourceUrl)}
            title={a.sourceUrl ?? ""}
            className="block w-full truncate text-left text-[12.5px] text-fg-2 hover:text-[#378add]"
          >
            {a.title || host}
          </button>
        )}
        <div className="truncate text-[10.5px] text-fg-dim" title={a.sourceUrl ?? ""}>
          {host}
          {a.mime && a.mime !== "application/octet-stream" ? ` · ${a.mime}` : ""}
        </div>
      </div>

      {a.sourceUrl && (
        <button
          data-attach-open-external=""
          onClick={() => void openExternal(a.sourceUrl!)}
          title="用系统浏览器打开"
          className="grid size-6 shrink-0 place-items-center rounded text-fg-dim opacity-0 group-hover:opacity-100 hover:bg-hover"
        >
          <ExternalLink size={12} />
        </button>
      )}
      <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
        <button
          data-attach-up=""
          onClick={onUp}
          title="上移"
          className="grid size-6 place-items-center rounded text-fg-dim hover:bg-hover"
        >
          <ChevronUp size={12} />
        </button>
        <button
          data-attach-down=""
          onClick={onDown}
          title="下移"
          className="grid size-6 place-items-center rounded text-fg-dim hover:bg-hover"
        >
          <ChevronDown size={12} />
        </button>
        <button
          data-attach-remove=""
          onClick={onRemove}
          title="移除附件"
          className="grid size-6 place-items-center rounded text-fg-dim hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- 零件 -------------------------------- */

function RowActions({
  onRemove,
  onUp,
  onDown,
}: {
  onRemove: () => void;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        data-attach-up=""
        onClick={onUp}
        title="前移"
        className="grid size-6 place-items-center rounded bg-black/45 text-white hover:bg-black/65"
      >
        <ChevronUp size={12} />
      </button>
      <button
        data-attach-down=""
        onClick={onDown}
        title="后移"
        className="grid size-6 place-items-center rounded bg-black/45 text-white hover:bg-black/65"
      >
        <ChevronDown size={12} />
      </button>
      <button
        data-attach-remove=""
        onClick={onRemove}
        title="移除附件"
        className="grid size-6 place-items-center rounded bg-black/45 text-white hover:bg-danger"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/**
 * 文件不见了。
 *
 * 会走到这里的实际情形：换了机器（备份只带元数据）、
 * 手动清理过 %APPDATA%、同步盘把目录搞丢。
 * 所以这里给出**能自救的路**：sourceUrl 还在，就允许重新下载；
 * 本地手动加进来的没有来源，只能说明情况。
 */
function MissingBox({ a, onRemove, compact }: { a: WoAttachment; onRemove: () => void; compact?: boolean }) {
  const { reattachFromSource, attachBusy } = useStore();
  const [msg, setMsg] = useState("");

  const retry = async () => {
    const r = await reattachFromSource(a.id);
    if (r.status === "error") setMsg(r.message);
  };

  return (
    <div
      data-attach-missing=""
      className={`grid size-full place-items-center ${compact ? "" : "min-h-[80px]"} px-2 py-3`}
    >
      <div className="text-center">
        <AlertTriangle size={compact ? 16 : 18} className="mx-auto text-[#ba7517]" />
        <div className="mt-1 text-[11px] text-fg-3">文件缺失</div>
        <div className="mt-0.5 truncate text-[10.5px] text-fg-dim" title={a.relPath ?? ""}>
          {a.title}
        </div>
        {msg && <div className="mt-1 text-[10.5px] text-danger">{msg}</div>}
        <div className="mt-1.5 flex items-center justify-center gap-1">
          {a.sourceUrl && (
            <button
              data-attach-retry=""
              disabled={attachBusy}
              onClick={() => void retry()}
              className="flex items-center gap-1 rounded border border-line bg-card px-1.5 py-0.5 text-[10.5px] text-fg-3 hover:bg-hover disabled:opacity-50"
            >
              <RefreshCw size={10} className={attachBusy ? "animate-spin" : ""} />
              重新下载
            </button>
          )}
          <button
            data-attach-remove=""
            onClick={onRemove}
            title="移除这条附件"
            className="grid size-[22px] place-items-center rounded border border-line bg-card text-fg-dim hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Lightbox({ a, onClose }: { a: WoAttachment; onClose: () => void }) {
  const { url, missing, markMissing } = useRepoUrl(a);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-attach-lightbox=""
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6"
    >
      <button
        onClick={onClose}
        title="关闭"
        className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        <X size={18} />
      </button>
      <div className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        {missing || !url ? (
          <div className="rounded-lg bg-white/10 px-6 py-8 text-center text-white/80">
            <AlertTriangle size={22} className="mx-auto" />
            <div className="mt-2 text-[13px]">文件缺失，无法预览</div>
          </div>
        ) : a.kind === "video" ? (
          <video src={url} controls autoPlay className="max-h-[80vh] max-w-full rounded-lg" onError={markMissing} />
        ) : (
          <img
            src={url}
            alt={a.title}
            className="max-h-[80vh] max-w-full rounded-lg object-contain"
            onError={markMissing}
          />
        )}
      </div>
      <div className="mt-3 max-w-full truncate text-[12px] text-white/70">
        {a.title}
        {a.size ? ` · ${formatBytes(a.size)}` : ""}
        {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
      </div>
      {a.sourceUrl && (
        <button
          onClick={() => void openExternal(a.sourceUrl!)}
          className="mt-1.5 flex items-center gap-1 rounded px-2 py-0.5 text-[11.5px] text-white/60 hover:text-white"
        >
          <ExternalLink size={11} />
          打开原地址
        </button>
      )}
    </div>
  );
}
