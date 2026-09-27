import { SectionTitle, Card, FieldRow } from "./parts";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  X,
  Check,
  Moon,
  Sun,
  Monitor,
  RotateCcw,
  ImagePlus,
  Sparkles,
} from "lucide-react";
import { useStore } from "../../store";
import {
  isThemeMode,
  SETTINGS,
  type ThemeMode,
} from "../../lib/settings";
import {
  errorText,
  formatBytes,
  pickLocalMedia,
} from "../../lib/attachments";
import {
  SCRIM,
  SCRIM_LEVELS,
  WALLPAPER_MAX_BYTES,
  formatBackground,
  isScrimLevel,
  loadWallpapers,
  parseBackground,
  parseCustomWallpapers,
  wallpaperUrl,
  type ScrimLevel,
  type Wallpaper,
} from "../../lib/wallpapers";
import { useWallpaperUrl } from "../../lib/useWallpaperUrl";
import { customWallpaperUrl } from "../../lib/customWallpaper";
import {
  DEFAULT_THEME,
  PALETTES,
  applyThemeColors,
  matchPalette,
  themeColorsFrom,
} from "../../lib/theme";
import { extractPalette } from "../../lib/palette";

/* -------------------------------- 分区：外观 -------------------------------- */

export function AppearanceSection({
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

  const addCustom = useStore((s) => s.addCustomWallpaper);
  const removeCustom = useStore((s) => s.removeCustomWallpaper);

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

  /* ---- 主题色 ---- */

  const stored = themeColorsFrom(settings);
  /**
   * 取色器拖动中的值。
   *
   * 不为 null 时界面用它（此时还没落库）—— 这是"松手才落库"那条约定的
   * 取色器版本：拖动过程中每秒能触发几十次 input 事件，次次落库的话
   * 一次调色会给数据库写上百条。
   */
  const [draft, setDraft] = useState<{ accent: string; primary: string } | null>(null);
  const shown = draft ?? stored;
  const activePalette = matchPalette(shown.accent, shown.primary);

  const previewColors = (next: { accent: string; primary: string }) => {
    setDraft(next);
    // 预览直接改 CSS 变量，跟落库走的是同一条路，所见即所得
    applyThemeColors(next);
  };

  const commitColors = () => {
    if (!draft) return;
    void saveSettings({
      [SETTINGS.accent]: draft.accent,
      [SETTINGS.primary]: draft.primary,
    });
    setDraft(null);
  };

  /* ---- 自定义壁纸 ---- */

  const custom = parseCustomWallpapers(settings[SETTINGS.customWallpapers]);
  const bgSrc = useWallpaperUrl(settings[SETTINGS.background]);
  const [busy, setBusy] = useState<"" | "upload" | "pick">("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const uploadWallpaper = async () => {
    setBusy("upload");
    setNote(null);
    try {
      const picked = await pickLocalMedia();
      const first = picked[0];
      // 没选（取消对话框）不是错误，静默收尾
      if (!first) return;
      const name =
        typeof first === "string" ? first.split(/[\\/]/).pop() || "壁纸" : first.name;
      await addCustom(first, name);
      setNote({ kind: "ok", text: `已添加并切换：${name}` });
    } catch (e) {
      setNote({ kind: "err", text: errorText(e) });
    } finally {
      setBusy("");
    }
  };

  /**
   * 从当前铺着的那张图取主题色。
   *
   * 只在铺了图时才有意义（跟随视图时取的是渐变，不是一个确定的色），
   * 所以按钮不显示；真被点到（自动化测试直接调）时给一句人话而不是静默失败。
   */
  const pickFromWallpaper = async () => {
    if (!bgSrc) {
      setNote({ kind: "err", text: "当前没有铺图，先选一张壁纸" });
      return;
    }
    setBusy("pick");
    setNote(null);
    try {
      const p = await extractPalette(bgSrc);
      if (!p) {
        setNote({ kind: "err", text: "这张图取不了色（跨域限制或图片损坏）" });
        return;
      }
      await saveSettings({
        [SETTINGS.accent]: p.accent,
        [SETTINGS.primary]: p.primary,
      });
      setNote({ kind: "ok", text: `已取样：${p.accent} / ${p.primary}` });
    } catch (e) {
      setNote({ kind: "err", text: errorText(e) });
    } finally {
      setBusy("");
    }
  };

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
                    ? "border-primary bg-primary text-white"
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
          title="主题色调"
          desc="品牌色是待办完成圈、紧急标记这类「属于本应用」的印记；主操作色是按钮、选中态这类「能点的东西」。两个一起换，换的是整套关系。"
        />

        <Card>
          <div className="text-[12.5px] text-fg-2">预设</div>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {PALETTES.map((p) => {
              const on = activePalette?.id === p.id;
              return (
                <button
                  key={p.id}
                  data-palette={p.id}
                  onClick={() =>
                    void saveSettings({
                      [SETTINGS.accent]: p.accent,
                      [SETTINGS.primary]: p.primary,
                    })
                  }
                  className={`overflow-hidden rounded-lg border text-left transition-colors ${
                    on ? "border-primary ring-2 ring-primary/25" : "border-line hover:border-fg-dim"
                  }`}
                >
                  {/* 一格里放两个色块：用户要挑的是"这两个搭不搭"，不是一个色 */}
                  <span className="flex h-8 w-full">
                    <span className="flex-1" style={{ background: p.accent }} />
                    <span className="flex-1" style={{ background: p.primary }} />
                  </span>
                  <span className="flex items-center gap-1 px-2 py-1 text-[12px] text-fg-3">
                    {on && <Check size={12} className="text-primary" />}
                    {p.name}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-end gap-4 border-t border-line pt-3">
            <ColorField
              label="品牌色"
              value={shown.accent}
              onInput={(v) => previewColors({ ...shown, accent: v })}
              onCommit={commitColors}
              testId="accent-color"
            />
            <ColorField
              label="主操作色"
              value={shown.primary}
              onInput={(v) => previewColors({ ...shown, primary: v })}
              onCommit={commitColors}
              testId="primary-color"
            />
            <button
              data-reset-colors
              onClick={() =>
                void saveSettings({
                  [SETTINGS.accent]: DEFAULT_THEME.accent,
                  [SETTINGS.primary]: DEFAULT_THEME.primary,
                })
              }
              className="mb-[3px] ml-auto flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-fg-3 hover:bg-hover"
            >
              <RotateCcw size={12} />
              恢复默认
            </button>
          </div>

          <div className="mt-2 text-[12px] leading-relaxed text-fg-dim">
            太亮或太灰的色会被自动收到能看清白字的范围里 —— 界面上按钮的字是白色的，
            给出看不清的字比不给这个选项更糟。
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <SectionTitle
          title="待办背景"
          desc="默认跟着视图自带的那套渐变走；也可以选一张必应壁纸，或者上传自己的图铺满整个待办区。"
        />

        <Card>
          {/*
           * 上传与取色放在最上面、且**不依赖内置清单**：
           * 就算这个环境一张必应壁纸都没抓过，用户照样能传自己的图。
           * 把它们塞进 wallpapers.length > 0 那个分支里，是这次最容易犯的错
           * —— 那样"没抓过图"的用户会以为这个功能根本不存在。
           */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              data-add-wallpaper
              disabled={busy === "upload"}
              onClick={() => void uploadWallpaper()}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] text-fg-2 transition-colors hover:bg-hover disabled:opacity-50"
            >
              <ImagePlus size={14} />
              {busy === "upload" ? "正在存入…" : "上传我的图片"}
            </button>

            {bg.kind !== "auto" && (
              <button
                data-pick-from-wallpaper
                disabled={busy === "pick"}
                onClick={() => void pickFromWallpaper()}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] text-fg-2 transition-colors hover:bg-hover disabled:opacity-50"
              >
                <Sparkles size={14} />
                {busy === "pick" ? "取样中…" : "取这张图的主色"}
              </button>
            )}

            <span className="ml-auto text-[12px] text-fg-dim">
              单张 ≤ {formatBytes(WALLPAPER_MAX_BYTES)}，只收图片
            </span>
          </div>

          {note && (
            <div
              data-wallpaper-note={note.kind}
              className={`mt-2 rounded-md px-2.5 py-1.5 text-[12.5px] ${
                note.kind === "err" ? "bg-danger-soft text-danger" : "bg-chip text-fg-2"
              }`}
            >
              {note.text}
            </div>
          )}

          {/* -------- 我上传的 -------- */}
          {custom.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <div className="text-[12.5px] text-fg-2">我的图片</div>
              <div className="mt-2 grid grid-cols-3 gap-2.5">
                {custom.map((c) => (
                  <div key={c.path} className="group relative">
                    <button
                      data-custom-wallpaper={c.path}
                      title={c.name}
                      onClick={() => pick(formatBackground({ kind: "custom", path: c.path }))}
                      className={`w-full overflow-hidden rounded-lg border text-left transition-colors ${
                        bg.kind === "custom" && bg.path === c.path
                          ? "border-primary ring-2 ring-primary/25"
                          : "border-line hover:border-fg-dim"
                      }`}
                    >
                      <CustomThumb path={c.path} />
                      <span className="block truncate px-2 py-1.5 text-[12.5px] text-fg-3">
                        {c.name}
                      </span>
                    </button>
                    {/*
                     * 删除按钮是**盖在缩略图上**的独立按钮，不是嵌在选择按钮里：
                     * 嵌套 button 是非法 HTML，且点删除会顺带把背景切过去。
                     */}
                    <button
                      data-remove-wallpaper={c.path}
                      title="删掉这张"
                      onClick={() => void removeCustom(c.path)}
                      className="absolute right-1 top-1 rounded-md bg-black/55 p-1 text-white opacity-0 transition-opacity hover:bg-black/75 focus:opacity-100 group-hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* -------- 必应每日壁纸 -------- */}
          {wallpapers === null ? (
            <div className="mt-3 border-t border-line py-6 text-center text-[13px] text-fg-dim">
              正在读取壁纸清单…
            </div>
          ) : wallpapers.length === 0 ? (
            // 空清单不是"坏掉了"，而是这个环境还没抓过图 —— 直接给出补救命令，
            // 比显示一排灰格子有用
            <div className="mt-3 border-t border-line pt-3 text-[13px] leading-relaxed text-fg-2">
              <div className="font-medium text-danger">还没有抓到必应壁纸</div>
              <div className="mt-1 text-fg-3">
                它是随包发布的静态资源，需要在工程里跑一次抓取脚本（不影响上传自己的图）：
              </div>
              <code className="mt-2 block rounded-md bg-chip px-2.5 py-1.5 font-mono text-[12.5px] text-fg-2">
                node scripts/fetch-wallpapers.mjs
              </code>
            </div>
          ) : (
            <div className="mt-3 border-t border-line pt-3">
              <div className="text-[12.5px] text-fg-2">必应每日壁纸</div>
              <div className="mt-2 grid grid-cols-3 gap-2.5">
                <button
                  data-bg-option="auto"
                  onClick={() => pick("auto")}
                  className={`group overflow-hidden rounded-lg border text-left transition-colors ${
                    bg.kind === "auto"
                      ? "border-primary ring-2 ring-primary/25"
                      : "border-line hover:border-fg-dim"
                  }`}
                >
                  {/* 「跟随视图」用四个视图的渐变拼一格，直观说明它是什么样子。
                      这四个色是**视图身份色**（见 TaskList 的 VIEW_META），故意写死、
                      不跟着主题走 —— 它演示的就是"四个视图各自的标志色"。 */}
                  <span
                    className="block h-[74px] w-full"
                    style={{ background: "linear-gradient(135deg,#c2436b,#a8681a 34%,#2a6cb0 67%,#443c9a)" }}
                  />
                  <span className="flex items-center gap-1.5 px-2 py-1.5 text-[12.5px] text-fg-2">
                    {bg.kind === "auto" && <Check size={13} className="text-primary" />}
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
                        ? "border-primary ring-2 ring-primary/25"
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

              <div className="mt-2 text-[12px] leading-relaxed text-fg-dim">
                共 {wallpapers.length} 张；要换一批就再跑一次抓取脚本
              </div>
            </div>
          )}

          <div className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-fg-dim">
            {bg.kind === "image"
              ? `当前：${wallpapers?.find((w) => w.file === bg.file)?.title || bg.file}`
              : bg.kind === "custom"
                ? `当前：${custom.find((c) => c.path === bg.path)?.name || "我的图片"}`
                : "当前：跟随视图渐变"}
          </div>

          {/* 遮罩只在铺图时才有意义 —— 照片明暗差得远，没有它白字会糊在天空上 */}
          {bg.kind !== "auto" && (
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
                        ? "border-primary bg-primary text-white"
                        : "border-line bg-card text-fg-3 hover:bg-hover"
                    }`}
                  >
                    {SCRIM[lv].label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ---------------------------- 外观的两个小件 ---------------------------- */

/**
 * 取色器一格。
 *
 * ⚠️ 落库时机是这里唯一 tricky 的地方：
 * React 的 onChange 绑的是原生 input 事件，拖动色板时每秒能触发几十次。
 * 所以「拖动中只预览、松手才落库」必须靠**原生 change 事件** ——
 * 它在关闭取色面板时才来一次。两者分工：
 *   onChange（= input）  → 改 CSS 变量，界面立刻变色
 *   原生 change          → 写库
 * 少绑那个原生监听的话，一次调色会给 core_settings 写上几十条。
 */
function ColorField({
  label,
  value,
  onInput,
  onCommit,
  testId,
}: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  onCommit: () => void;
  testId: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => commitRef.current();
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  }, []);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-fg-dim">{label}</span>
      <span className="flex items-center gap-2">
        <input
          ref={ref}
          type="color"
          data-color-input={testId}
          value={value}
          onChange={(e) => onInput(e.target.value)}
          className="h-8 w-12 cursor-pointer rounded border border-line bg-transparent p-0.5"
        />
        <code className="font-mono text-[12px] text-fg-3">{value}</code>
      </span>
    </label>
  );
}

/** 自定义壁纸的缩略图：地址要向仓库异步要，所以不能直接用 <img src={path}> */
function CustomThumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void customWallpaperUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);

  // 还没拿到 / 文件已被手动删掉：留一块占位，而不是一个裂开的图
  if (!url) return <span className="block h-[74px] w-full bg-chip" />;
  return <img src={url} alt="" loading="lazy" className="h-[74px] w-full object-cover" />;
}
