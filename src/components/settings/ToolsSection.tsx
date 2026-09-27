import { SectionTitle, Card, FieldRow, Switch } from "./parts";
import type { Flash } from "./parts";
import { ImportToolDialog } from "./ImportToolDialog";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Trash2,
  Copy,
  Power,
  FileCode2,
  PackagePlus,
  AlertTriangle,
} from "lucide-react";
import { useStore } from "../../store";
import {
  parseDisabledTools,
  parseToolKeepState,
  SETTINGS,
  toggleDisabledTool,
} from "../../lib/settings";
import {
  canInstallTools,
  HTML_MAX_BYTES,
  installFromHtml,
  reinstallBundledTool,
  toolsRoot,
  uninstallTool,
} from "../../lib/toolStore";
import { resolveIcon } from "../../lib/icons";
import type { ToolManifest } from "../../types";

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
export function ToolsSection({
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
                          ? "bg-ok-soft text-ok"
                          : "bg-warn-soft text-warn"
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
                      <span className="rounded bg-ok-soft px-1.5 py-px text-[10.5px] text-ok">
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
      <Icon size={16} className="text-primary" />
    </span>
  );
}

