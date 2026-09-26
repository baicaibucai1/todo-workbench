/**
 * 工作区：助手写文件的地方，也是它产出物的陈列架。
 *
 * ------------------------------------------------------------------
 * 它存在的理由
 * ------------------------------------------------------------------
 * 助手交出来的东西（报告、方案、整理好的清单）必须**能被看见**。
 * 只把路径贴进对话是不够的 —— 用户得自己开资源管理器、找到目录、
 * 挑个编辑器打开；多数人不会做这三步，于是那份产出等于没写。
 *
 * 所以这一页做三件事：列出文件、点开就能读（md 直接渲染）、
 * 一键在资源管理器里打开整个目录。
 *
 * ------------------------------------------------------------------
 * 刻意不做的事
 * ------------------------------------------------------------------
 * · **不做编辑器**：改文件是用户自己那套工具的事（VS Code、Obsidian……），
 *   在这里再长一个编辑器是重复造轮子，而且会把"谁来改"这个边界弄糊。
 * · **不做上传**：这个目录是**助手的产出**，不是第二个图库。
 * · **浏览器模式不假装能用**：没有可写的文件系统就直接说，
 *   不给一个点了没反应的按钮。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { SETTINGS } from "../lib/settings";
import { isTauri } from "../lib/db";
import * as ws from "../lib/agent/workspace";
import type { WorkspaceFile } from "../lib/agent/workspace";
import { RichText } from "./RichText";

/** 多大的文件算"直接读"（超过就只给路径，别把界面读卡） */
const PREVIEW_MAX_BYTES = 400_000;

function isTextFile(name: string): boolean {
  return /\.(md|markdown|txt|json|csv|log|ya?ml|html?|css|js|ts|jsx|tsx)$/i.test(name);
}

export default function WorkspaceView() {
  const settings = useStore((s) => s.settings);
  const desktop = isTauri();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [root, setRoot] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await ws.listWorkspace(settings);
      setRoot(r.root);
      setFiles(r.files);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [settings]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const open = useCallback(
    async (f: WorkspaceFile) => {
      setPicked(f.path);
      setText(null);
      if (f.isDir || !isTextFile(f.name)) return;
      // 太大的不读：把 5MB 的东西塞进 React 状态只会让界面卡住，
      // 那种文件本来也该用外部编辑器看
      if ((f.size ?? 0) > PREVIEW_MAX_BYTES) return;
      const r = await ws.readWorkspaceFile(settings, f.path);
      setText(r.ok ? r.content : null);
      if (!r.ok) setErr(r.message);
    },
    [settings],
  );

  const remove = useCallback(
    async (f: WorkspaceFile) => {
      const r = await ws.deleteWorkspaceFile(settings, f.path);
      if (!r.ok) setErr(r.message);
      else {
        setPicked(null);
        setText(null);
        await reload();
      }
    },
    [settings, reload],
  );

  const customDir = (settings[SETTINGS.agentWorkspace] ?? "").trim();
  const md = useMemo(() => (picked && /\.md$/i.test(picked) ? text : null), [picked, text]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-workspace="">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <FolderOpen size={16} className="text-accent" />
        <span className="text-[14px] font-medium text-fg">工作区</span>
        <span className="text-[12px] text-fg-dim">助手写的文件都在这里</span>
        <div className="flex-1" />
        <button
          onClick={() => void reload()}
          data-workspace-reload=""
          className="grid size-7 place-items-center rounded-md text-fg-dim hover:bg-hover"
          title="重新列一遍"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
        {desktop && (
          <button
            onClick={() => void ws.revealWorkspace(settings)}
            data-workspace-reveal=""
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-fg-2 hover:bg-hover"
          >
            <ExternalLink size={12} />
            在资源管理器中打开
          </button>
        )}
      </div>

      {!desktop ? (
        <div className="px-5 py-6 text-[13px] leading-relaxed text-fg-3">
          浏览器演示模式没有工作区 —— 写文件要在桌面版里做。
          <br />
          桌面版装好后，助手写的文件会落在数据目录下的 <code className="font-mono">agent-workspace/</code>，
          你也可以在「设置 → AI 助手」里改成别的目录。
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 文件列表 */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-r border-line px-3 py-3">
            {!files.length ? (
              <p className="px-1 py-2 text-[12.5px] leading-relaxed text-fg-dim">
                还是空的。让助手写点东西（比如「把这份调研写成 md 存到工作区」），
                它就会出现在这里。
              </p>
            ) : (
              files.map((f) => (
                <div
                  key={f.path}
                  data-workspace-file={f.path}
                  className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                    picked === f.path ? "bg-hover" : "hover:bg-hover"
                  }`}
                >
                  <button onClick={() => void open(f)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <FileText size={13} className="shrink-0 text-fg-dim" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{f.name}</span>
                    {!f.isDir && f.size !== null && (
                      <span className="shrink-0 text-[11px] text-fg-dim">{fmtSize(f.size)}</span>
                    )}
                  </button>
                  <button
                    onClick={() => void remove(f)}
                    data-workspace-delete={f.path}
                    title="删掉这个文件"
                    className="grid size-6 shrink-0 place-items-center rounded text-fg-dim opacity-0 hover:bg-card hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* 预览 */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {!picked ? (
              <p className="text-[12.5px] leading-relaxed text-fg-dim">
                左边点一个文件，这里会显示它的内容（markdown 直接排版成可读的样子）。
                {root && (
                  <>
                    <br />
                    目录：
                    <code className="font-mono">{root}</code>
                    {customDir ? "（你在设置里指定的）" : "（默认落点，设置里可以改）"}
                  </>
                )}
              </p>
            ) : text === null ? (
              <p className="text-[12.5px] leading-relaxed text-fg-dim">
                「{picked}」不是文本文件，或者太大了 —— 用「在资源管理器中打开」找到它，
                用你顺手的编辑器看。
              </p>
            ) : (
              <div data-workspace-preview={picked}>
                <div className="mb-2 text-[12px] text-fg-dim">{picked}</div>
                {md !== null ? (
                  <RichText text={text} />
                ) : (
                  <pre className="max-h-[70vh] overflow-auto rounded-lg bg-surface px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg-3">
                    {text}
                  </pre>
                )}
              </div>
            )}
            {err && <div className="mt-3 text-[12.5px] text-danger">{err}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
