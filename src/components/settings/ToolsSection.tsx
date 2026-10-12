import { SectionTitle, Card, FieldRow, Switch } from "./parts";
import type { Flash } from "./parts";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import type { DragEvent as ReactDragEvent } from "react";
import {
  Trash2,
  Copy,
  Power,
  FileCode2,
  PackagePlus,
  AlertTriangle,
  Globe,
  RefreshCw,
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
  ZIP_MAX_BYTES,
  downloadToolSource,
  installFromHtml,
  installFromZip,
  planZipInstall,
  reinstallBundledTool,
  toolSubresourceFetcher,
  toolsRoot,
  uninstallTool,
} from "../../lib/toolStore";
import { describeExternalRefs, detectServerCalls, scanExternalRefs, titleFromHtml } from "../../lib/toolHtmlScan";
import { inlineExternalResources } from "../../lib/toolInline";
import { resolveIcon } from "../../lib/icons";
import type { ToolManifest } from "../../types";
import { ImportToolDialog, type PendingImport } from "./ImportToolDialog";

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
  const zipRef = useRef<HTMLInputElement>(null);
  /** 更新某个工具时，把"要更新谁"记下来（zip 里只有一个工具时按它装） */
  const targetRef = useRef<string | null>(null);
  /** 拖放计数：dragenter/dragleave 在子元素间进出会成对触发，靠深度计数才不会闪烁 */
  const dragDepth = useRef(0);
  const [busy, setBusy] = useState<string | null>(null);
  /** 选好来源、等着确认的导入（null = 当前没在导入） */
  const [pending, setPending] = useState<PendingImport | null>(null);
  /** 有工具文件正拖在整个工具区上空（显示虚线提示层） */
  const [dragOver, setDragOver] = useState(false);
  /** 正在二次确认卸载的工具 id */
  const [askUninstall, setAskUninstall] = useState<string | null>(null);
  const [root, setRoot] = useState("");
  const [url, setUrl] = useState("");

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

  /** 内联打包的进度与结果提示（显示在安装工具卡片里） */
  const [packNote, setPackNote] = useState("");

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

  /**
   * 单文件 HTML 的安装前处理：**先把外部资源抓下来内联**，让工具落地就是完整的
   * （2026-10-12 用户明确要求"别光提示，让程序抓取外部资源"）。
   * 抓不齐的转成警告走「仍要安装」那道闸；抓完超过单文件上限就整体放弃。
   */
  const packHtml = async (
    html: string,
    base: string,
  ): Promise<{ html: string; warns: string[]; packed: number; serverCalls: boolean }> => {
    const res = await inlineExternalResources(html, base, toolSubresourceFetcher(), {
      onProgress: (done) => setPackNote(`已抓取 ${done} 个外部资源…`),
    });
    if (res.html.length > HTML_MAX_BYTES) {
      throw new Error(
        `资源内联后文件 ${(res.html.length / 1048576).toFixed(1)} MB，超过单文件上限 ${(HTML_MAX_BYTES / 1048576).toFixed(0)} MB —— 这个页面不适合做成单文件工具`,
      );
    }
    // 打包解决不了的部分要说明白：页面自己会向服务器发请求的话，离线时那些功能就是用不了
    const serverCalls = detectServerCalls(res.html);
    if (res.failed.length === 0) {
      return { html: res.html, warns: [], packed: res.inlined.length, serverCalls };
    }
    const hostOf = (u: string) => {
      try {
        return new URL(u, base || "http://placeholder.invalid").hostname;
      } catch {
        return u.slice(0, 40);
      }
    };
    const hosts = [...new Set(res.failed.map((f) => hostOf(f.url)))];
    const warns = [
      `${res.failed.length} 个外部资源没能抓下来（${hosts.slice(0, 3).join("、")}${hosts.length > 3 ? ` 等 ${hosts.length} 个站点` : ""}）：${res.failed[0].reason}。`,
      "这些位置在离线的工具里加载不到，界面可能是坏的。",
    ];
    return { html: res.html, warns, packed: res.inlined.length, serverCalls };
  };

  const pickFile = async (f: File) => {
    const isZip = /\.zip$/i.test(f.name);
    // 体积先在读之前挡一道：把几百兆的东西读进内存再拒绝，白占一趟
    const cap = isZip ? ZIP_MAX_BYTES : HTML_MAX_BYTES;
    if (f.size > cap) {
      say(`文件 ${(f.size / 1024 / 1024).toFixed(1)} MB，超过 ${cap / 1024 / 1024} MB 上限`, "err");
      return;
    }
    try {
      if (isZip) {
        const zip = await f.arrayBuffer();
        const plan = await planZipInstall(zip);
        if (!plan.tools.length) {
          say("这个压缩包里没找到可以装的工具（需要有 manifest.json，或至少一个 HTML 入口）", "err");
          return;
        }
        const target = targetRef.current;
        setPending({
          kind: "zip",
          label: target ? `${f.name} → 更新「${target}」` : f.name,
          zip,
          tools: plan.tools,
          skipped: plan.skipped,
          forceId: target ?? undefined,
        });
        return;
      }
      // 单文件安装前先尝试把外部资源抓齐内联（从文件导入没有基准地址，
      // 只有绝对地址抓得到；抓不齐的转成警告，见 packHtml）。
      // 体检兜底还在：抓完再扫一遍，剩下的外部引用照样亮警告。
      const text = await f.text();
      setPackNote("分析页面…");
      const packed = await packHtml(text, "");
      setPackNote("");
      const warns = packed.warns.length
        ? packed.warns
        : describeExternalRefs(scanExternalRefs(packed.html, true));
      setPending({
        kind: "html",
        label: f.name,
        html: packed.html,
        warns,
        suggestName: titleFromHtml(packed.html) || undefined,
        packed: packed.packed || undefined,
        serverCalls: packed.serverCalls || undefined,
      });
    } catch (err) {
      setPackNote("");
      say(`读不出这个文件：${errText(err)}`, "err");
    }
  };

  /* ---------------- 拖放安装：文件直接拖到工具区上松手 ---------------- */

  const draggingFiles = (e: ReactDragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const onDragEnter = (e: ReactDragEvent) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };

  // dragover 要持续 preventDefault，浏览器才会在松手时派发 drop；但别在这里
  // 反复 setState —— 它像 mousemove 一样连续触发，每帧重渲染会把界面拖卡
  const onDragOver = (e: ReactDragEvent) => {
    if (draggingFiles(e)) e.preventDefault();
  };

  const onDragLeave = () => {
    if (dragDepth.current > 0) dragDepth.current -= 1;
    if (dragDepth.current === 0) setDragOver(false);
  };

  const onDropFiles = (e: ReactDragEvent) => {
    dragDepth.current = 0;
    setDragOver(false);
    if (!draggingFiles(e)) return;
    e.preventDefault();
    if (!canManage) {
      say("浏览器演示模式装不了工具，请在桌面版里拖入", "err");
      return;
    }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    // 导入确认框一次只伺候一份来源（zip 内部才装得下多个工具），
    // 多拖几个就明说只装了第一个 —— 悄悄吞掉剩下的更让人摸不着头脑
    const first = files[0];
    if (files.length > 1) say(`一次只装一个文件，另外 ${files.length - 1} 个忽略了`);
    if (!/\.(html?|zip)$/i.test(first.name)) {
      say(`「${first.name}」不是工具文件：要 .html 单文件或 .zip 工具包`, "err");
      return;
    }
    void pickFile(first);
  };

  /**
   * 网址入口：**先下载、后确认**。下载之前无从知道对面是 zip 还是 HTML、
   * 是不是自包含 —— 这些必须在「安装」按钮按下去之前摆到台面上。
   * 下载可能要几秒，按钮上就是"下载中…"。
   */
  const doInstallFromUrl = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy("__url");
    try {
      const src = await downloadToolSource(u);
      if (src.kind === "zip") {
        const plan = await planZipInstall(src.bytes);
        if (!plan.tools.length) {
          say("这个压缩包里没找到可以装的工具（需要有 manifest.json，或至少一个 HTML 入口）", "err");
          return;
        }
        const target = targetRef.current;
        setPending({
          kind: "zip",
          label: target ? `${u} → 更新「${target}」` : u,
          zip: src.bytes,
          tools: plan.tools,
          skipped: plan.skipped,
          forceId: target ?? undefined,
        });
      } else {
        // 网址来的 HTML：先把外部资源抓齐内联，再弹确认框（见 packHtml）
        setPackNote("分析页面…");
        const packed = await packHtml(src.text, u);
        setPackNote("");
        setPending({
          kind: "html",
          label: u,
          html: packed.html,
          warns: packed.warns,
          suggestName: titleFromHtml(packed.html) || undefined,
          packed: packed.packed || undefined,
          serverCalls: packed.serverCalls || undefined,
        });
      }
    } catch (err) {
      setPackNote("");
      say(`从网址安装失败：${errText(err)}`, "err");
    } finally {
      setBusy(null);
    }
  };

  const doInstall = async (input: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    overwrite: boolean;
  }) => {
    if (!pending) return;
    setBusy("__import");
    try {
      let installed: ToolManifest[] = [];
      let updated: ToolManifest[] = [];

      if (pending.kind === "html") {
        const r = await installFromHtml({ html: pending.html, ...input });
        installed = [r.manifest];
      } else {
        const r = await installFromZip({
          zip: pending.zip,
          overwrite: input.overwrite || !!pending.forceId,
          forceId: pending.forceId,
          fallback: { id: input.id, name: input.name, icon: input.icon, description: input.description },
        });
        installed = r.installed;
        updated = r.updated;
      }

      setPending(null);
      setUrl("");
      targetRef.current = null;
      await reloadTools();
      // 装完直接打开 —— 对"我导入的东西到底行不行"最直观的回答。
      // 不打开的话用户还得自己在侧边栏里找一遍，而那一刻的迟疑最伤信任。
      const first = installed[0] ?? updated[0];
      if (first) openTool(first.id);
      const parts = [
        installed.length ? `新装 ${installed.map((m) => m.name).join("、")}` : "",
        updated.length ? `更新 ${updated.map((m) => m.name).join("、")}` : "",
      ].filter(Boolean);
      say(parts.join("；") || "没有变化");
    } catch (err) {
      say(`安装失败：${errText(err)}`, "err");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-tools-dropzone=""
      className="relative max-w-[640px]"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropFiles}
    >
      {dragOver && (
        <div
          data-tools-drop-hint=""
          className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-primary/[0.06]"
        >
          <span className="rounded-lg bg-card px-3 py-1.5 text-[13px] text-primary shadow">
            松手就把文件装成工具（.html / .zip）
          </span>
        </div>
      )}
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
                    {tool.tags?.includes("template") && (
                      <span
                        className="rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim"
                        title="写工具时照着抄的样板，不是给你日常用的功能。它默认停用 —— 想看就在下面把它打开，文件一直都在。"
                      >
                        参考模板
                      </span>
                    )}
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
                    onClick={() => {
                      targetRef.current = tool.id;
                      zipRef.current?.click();
                    }}
                    disabled={!canManage || busy === tool.id}
                    data-tool-update={tool.id}
                    title={
                      canManage
                        ? `用 .zip 包更新「${tool.name}」（旧包里有、新包里没有的文件会删掉；数据不动）`
                        : "浏览器演示模式无法安装工具"
                    }
                    className="grid size-7 place-items-center rounded-md border border-line bg-card text-fg-dim hover:bg-hover disabled:opacity-40"
                  >
                    <RefreshCw size={13} />
                  </button>
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
            title="安装工具"
            desc="四种来源：把文件拖到本页任意位置、单个 HTML 文件、.zip 工具包、或者一个网址。zip 里可以是一个工具，也可以是一整包（比如 Release 上那份）—— 同 id 的会被就地更新。"
          />
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <button
                data-act="import-tool"
                disabled={!canManage}
                onClick={() => fileRef.current?.click()}
                title={
                  canManage
                    ? "选一个 HTML 文件或 .zip 工具包"
                    : "浏览器演示模式无法写入文件系统，请在桌面版里导入"
                }
                className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 hover:bg-hover disabled:opacity-40"
              >
                <FileCode2 size={14} />
                选择 HTML / ZIP…
              </button>
              <button
                data-act="import-zip"
                disabled={!canManage}
                onClick={() => zipRef.current?.click()}
                title="选一个 .zip 工具包：可以只装一个工具，也可以一次更新一整包"
                className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 hover:bg-hover disabled:opacity-40"
              >
                <PackagePlus size={14} />
                选择 .zip 工具包…
              </button>
            </div>

            {/* 抓取/打包进行中的动静 —— 抓几十个资源要几秒钟，不能让人对着没反应的界面猜 */}
            {packNote && (
              <div data-pack-note="" className="mt-2 text-[11.5px] text-fg-dim">
                {packNote}
              </div>
            )}

            {/* 网址这一档：下载在 Rust 侧做 —— webview 里的 fetch 会被 CORS 挡住，
                而工具包挂在 Release 上，给不给跨域头不由我们决定 */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Globe size={14} className="shrink-0 text-fg-dim" />
              <input
                value={url}
                data-import-url=""
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doInstallFromUrl();
                }}
                placeholder="https://…/tools.zip  或  https://…/tool.html"
                className="min-w-[220px] flex-1 rounded-lg border border-line bg-card px-3 py-1.5 font-mono text-[12.5px] text-fg-2 outline-none focus:border-primary"
              />
              <button
                data-act="import-url"
                disabled={!canManage || !url.trim() || busy === "__url"}
                onClick={() => void doInstallFromUrl()}
                title="从这个网址下载并安装（zip 或单个 HTML 都认）"
                className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] text-fg-2 hover:bg-hover disabled:opacity-40"
              >
                {busy === "__url" ? "下载中…" : "从网址安装"}
              </button>
            </div>
            <div className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
              单文件 HTML 里的 CSS / JS 要内联，引用外部文件的相对路径不会跟着进来；
              zip 则按 manifest.json 定位工具（一个包里可以有多个）。
            </div>

            {!canManage && (
              <div className="mt-2 text-[11.5px] text-fg-dim">
                浏览器演示模式只能试用内置工具，安装功能需要桌面版
              </div>
            )}

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
      <input
        ref={zipRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pickFile(f);
          e.target.value = "";
        }}
      />

      {pending && (
        <ImportToolDialog
          key={pending.label}
          pending={pending}
          taken={taken}
          busy={busy === "__import"}
          onCancel={() => {
            setPending(null);
            targetRef.current = null;
          }}
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

