import { useMemo, useState } from "react";
import { FileCode2, PackagePlus, AlertTriangle, ArrowUpRight, ShieldAlert } from "lucide-react";
import { checkToolId, suggestToolId } from "../../lib/toolStore";
import { ICONS } from "../../lib/icons";
import type { ZipToolPlan } from "../../lib/toolStore";

/** 从文件名取一个默认的工具名（去扩展名） */
function defaultToolName(fileName: string): string {
  return fileName.replace(/\.(html?|htm|zip)$/i, "").trim() || "新工具";
}

/** 两种来源：单个 HTML 文件 / 一个 .zip 工具包（从网址来的也在这里 —— 下载后已经分流好了） */
export type PendingImport =
  | {
      kind: "html";
      label: string;
      html: string;
      /** 打包后仍加载不到的外部资源 / 自包含体检警告。非空时必须勾「仍要安装」才能继续 */
      warns?: string[];
      /** 页面 <title> 抠出来的建议名（从网址安装时比文件名段更像人话） */
      suggestName?: string;
      /** 已经抓进来内联掉的外部资源个数 —— 让用户知道"程序替我干了活" */
      packed?: number;
      /** 页面代码会向它自己的服务器发请求 —— 打包解决不了的部分，得说明白 */
      serverCalls?: boolean;
    }
  | {
      kind: "zip";
      label: string;
      zip: ArrayBuffer;
      tools: ZipToolPlan[];
      skipped: string[];
      /** 从某个工具的「更新」按钮进来：把包里那个工具装到这个 id 上 */
      forceId?: string;
    };

/**
 * 导入确认框。
 *
 * 为什么要有这一步而不是选完文件直接装：工具的 id 会变成它私有表的表名前缀，
 * 而且**装错了要卸载才能改**，所以让用户过一眼比"先装了再说"省事。
 * 但默认值全部预填（名称来自文件名、id 从文件名推、图标给个通用值），
 * 所以想省事的人直接点「安装」即可 —— 这就是"快速导入"。
 *
 * zip 那一档不一样：**先看清楚这个包会动哪几个工具**。同一个包可能装一个新的，
 * 也可能顺手把三个旧的顶掉，不动声色地做后者是这里最不能犯的错 ——
 * 所以只要包里有已存在的 id，就必须勾一下「覆盖」才给继续。
 */
export function ImportToolDialog({
  pending,
  taken,
  busy,
  onCancel,
  onInstall,
}: {
  pending: PendingImport;
  taken: string[];
  busy: boolean;
  onCancel: () => void;
  onInstall: (input: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    overwrite: boolean;
  }) => void;
}) {
  const { label, kind } = pending;

  const [name, setName] = useState(() =>
    pending.kind === "html" && pending.suggestName ? pending.suggestName : defaultToolName(label),
  );
  const [id, setId] = useState(() => suggestToolId(label, taken));
  const [icon, setIcon] = useState("package");
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  // 从「更新」按钮进来时默认是覆盖 —— 用户点的就是更新，
  // 再让他勾一次等于把同一个决定问两遍
  const [overwrite, setOverwrite] = useState(
    pending.kind === "zip" && !!pending.forceId,
  );
  // 自包含体检没过（引用了外部脚本/样式/图片）：必须显式认下「知道可能是坏的」才放行。
  // 这是 2026-10-12 的真事换来的 —— tool.lu 整页装进来一片狼藉，用户以为程序坏了。
  const warns = pending.kind === "html" ? (pending.warns ?? []) : [];
  const [force, setForce] = useState(false);

  // zip：包里有没有已经装着的 id —— 有就必须显式勾选覆盖
  const zipInfo = useMemo(() => {
    if (pending.kind !== "zip") return null;
    const tools = pending.tools;
    const updates = tools.filter((t) => t.replacing);
    const broken = tools.filter((t) => t.error && !(t.root === "" && id));
    return { tools, updates, broken, needOverwrite: updates.length > 0 };
  }, [pending, id]);

  const idNeeded = kind !== "zip";
  const idError = idNeeded ? checkToolId(id, taken) : null;
  const nameError = idNeeded && !name.trim() ? "名称不能为空" : null;
  const bad =
    (idNeeded ? idError ?? nameError : null) ??
    (zipInfo?.broken.length ? `包里有 ${zipInfo.broken.length} 个工具装不了` : null) ??
    (zipInfo?.needOverwrite && !overwrite ? "包里有已存在的工具，要更新请勾上「覆盖已有工具」" : null) ??
    (warns.length > 0 && !force ? "这个页面引用了外部资源，看清楚上面的警告并勾选确认后才能装" : null);

  return (
    <div
      data-tool-import-dialog=""
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-[480px] rounded-xl border border-line bg-card p-5 shadow-xl">
        <div className="flex items-center gap-2">
          {kind === "zip" ? (
            <PackagePlus size={16} className="text-primary" />
          ) : (
            <FileCode2 size={16} className="text-primary" />
          )}
          <h3 className="text-[14px] font-medium text-fg">
            {kind === "zip" ? "导入工具包" : "导入为工具"}
          </h3>
        </div>
        <p className="mt-1 break-all font-mono text-[11.5px] text-fg-dim">{label}</p>

        {/* 打包成功的交代：让用户知道程序替他干了活；有服务端调用的再说明白极限在哪 */}
        {pending.kind === "html" && !!pending.packed && (
          <div
            data-import-packed=""
            className={`mt-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${
              pending.serverCalls
                ? "border-tip-line bg-tip-bg text-tip-text"
                : "border-line bg-ok-soft text-ok"
            }`}
          >
            已把 {pending.packed} 个外部资源抓下来内联进这个文件 —— 界面离线也能正常显示。
            {pending.serverCalls &&
              " 但页面代码会向它自己的服务器发请求（统计、接口、服务端生成的东西）：这类功能在离线的工具里可能用不了，这不是安装出了问题。"}
          </div>
        )}

        {/* ---------------- zip：先把包里有什么摆出来 ---------------- */}
        {zipInfo && (
          <div className="mt-4">
            <div className="text-[12px] text-fg-dim">这个包里有：</div>
            <div className="mt-1.5 space-y-1.5">
              {zipInfo.tools.map((t, i) => (
                <div
                  key={`${t.root}#${i}`}
                  data-zip-tool={t.id}
                  className="rounded-lg border border-line bg-chip px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[13px] text-fg-2">{t.name}</span>
                    <span className="font-mono text-[11px] text-fg-dim">{t.id || "(没有 id)"}</span>
                    <span className="rounded bg-card px-1.5 py-px text-[10.5px] text-fg-dim">
                      {t.files.length} 个文件
                    </span>
                    {t.replacing ? (
                      <span
                        data-zip-kind="update"
                        className="flex items-center gap-1 rounded bg-warn-soft px-1.5 py-px text-[10.5px] text-warn"
                      >
                        <ArrowUpRight size={10} />
                        更新 v{t.replacing.version} → v{t.version}
                      </span>
                    ) : (
                      <span
                        data-zip-kind="new"
                        className="rounded bg-ok-soft px-1.5 py-px text-[10.5px] text-ok"
                      >
                        新装
                      </span>
                    )}
                  </div>
                  {t.error && <div className="mt-1 text-[11.5px] text-danger">{t.error}</div>}
                </div>
              ))}
            </div>

            {pending.kind === "zip" && pending.skipped.length > 0 && (
              <div className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
                有 {pending.skipped.length} 个条目被跳过了（路径里带 <span className="font-mono">..</span>{" "}
                或反斜杠，不能往工具目录之外写）。
              </div>
            )}

            {/* 包里没有 manifest 时，id / 名称只能让人填 */}
            {zipInfo.tools.some((t) => !t.manifest) && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="text-[12px] text-fg-dim">
                  包里没有 manifest.json，得给它一个 id（会成为它私有表的表名前缀）
                </div>
                <input
                  value={id}
                  data-import-id=""
                  onChange={(e) => setId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 font-mono text-[13px] text-fg-2 outline-none focus:border-primary"
                />
                <input
                  value={name}
                  data-import-name=""
                  onChange={(e) => setName(e.target.value)}
                  placeholder="工具名称"
                  className="mt-2 w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
                />
              </div>
            )}
          </div>
        )}

        {/* ---------------- 单文件 / 网址：名称与 id ---------------- */}
        {!zipInfo && (
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
              {touched && idError && <span className="mt-1 block text-[11.5px] text-danger">{idError}</span>}
              {/* 中文文件名推不出 id 时给出解释，否则用户会以为界面在乱填 */}
              {!/[a-z]/i.test(label) && (
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
        )}

        {/* ---------------- 自包含体检没过：把话说透，再让人显式认下 ---------------- */}
        {warns.length > 0 && (
          <div
            data-import-warns=""
            className="mt-4 rounded-lg border border-danger/40 bg-danger/[0.06] px-3 py-2.5"
          >
            <div className="flex items-start gap-2">
              <ShieldAlert size={15} className="mt-px shrink-0 text-danger" />
              <div className="space-y-1 text-[12px] leading-relaxed text-fg-2">
                {warns.map((w, i) => (
                  <p key={i} className={i === 0 ? "font-medium text-danger" : ""}>
                    {w}
                  </p>
                ))}
              </div>
            </div>
            <label className="mt-2 flex cursor-pointer items-center gap-2 border-t border-danger/20 pt-2">
              <input
                type="checkbox"
                data-import-force=""
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span className="text-[12px] text-fg-2">我明白外部资源加载不到，仍要安装</span>
            </label>
          </div>
        )}

        {/* ---------------- 覆盖确认 ---------------- */}
        <label className="mt-4 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            data-import-overwrite=""
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[12px] leading-relaxed text-fg-2">
            覆盖已有工具
            <span className="block text-[11.5px] text-fg-dim">
              同 id 的工具会被整个换掉（旧包里有、新包里没有的文件会删掉）。它存的数据不动。
            </span>
          </span>
        </label>

        {zipInfo?.needOverwrite && !overwrite && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-tip-line bg-tip-bg px-3 py-2 text-[11.5px] leading-relaxed text-tip-text">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span>这个包会更新 {zipInfo.updates.length} 个已装的工具，勾上「覆盖」才会继续。</span>
          </div>
        )}

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
            title={typeof bad === "string" ? bad : undefined}
            onClick={() =>
              onInstall({
                id: id.trim(),
                name: name.trim(),
                icon,
                description: description.trim() || undefined,
                overwrite,
              })
            }
            className="rounded-lg bg-primary px-3 py-1.5 text-[13px] text-white disabled:opacity-40"
          >
            {busy ? "安装中…" : zipInfo?.updates.length ? "更新" : "安装"}
          </button>
        </div>
      </div>
    </div>
  );
}
