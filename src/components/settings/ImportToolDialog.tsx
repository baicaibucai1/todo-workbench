import { useState } from "react";
import { FileCode2 } from "lucide-react";
import {
  checkToolId,
  suggestToolId,
} from "../../lib/toolStore";
import { ICONS } from "../../lib/icons";

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
export function ImportToolDialog({
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
          <FileCode2 size={16} className="text-primary" />
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
              className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
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
                touched && idError ? "border-danger" : "border-line focus:border-primary"
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
              className="w-[180px] rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-primary"
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
              className="w-full resize-none rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
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
            className="rounded-lg bg-primary px-3 py-1.5 text-[13px] text-white disabled:opacity-40"
          >
            {busy ? "安装中…" : "安装"}
          </button>
        </div>
      </div>
    </div>
  );
}
