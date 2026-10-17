import { SectionTitle, Card, TextField, ActionButton } from "./parts";
import type { Flash } from "./parts";
import { useEffect, useRef, useState } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Link2,
  LogOut,
  PlugZap,
  RefreshCw,
  Table2,
  Upload,
} from "lucide-react";
import { SETTINGS } from "../../lib/settings";
import { isTauri } from "../../lib/db";
import {
  COLUMNS,
  accountInfo,
  applyPull,
  linkInfo,
  listSpaces,
  loginPoll,
  loginStart,
  planPull,
  readKwikiConfig,
  readLedger,
  type LedgerRow,
  type PullPlan,
  type WpsPull,
} from "../../lib/kwiki";
import {
  AIRSCRIPT_SNIPPET,
  cloudProbe,
  cloudPull,
  cloudPush,
  cloudReady,
  readCloudConfig,
  type CloudConfig,
  type CloudInfo,
} from "../../lib/wpsCloud";

/* ---------------------------- 分区：WPS 在线表格联动 ---------------------------- */

/**
 * 两条路，界面上一前一后摆清楚：
 *
 *  1. **云端表格（直连）** —— 用户贴自己那张表的链接 + AirScript 的 webhook/令牌，
 *     程序直接读写原表。不登录、不选知识库、不产生副本。这是默认走法。
 *  2. **WPS 登录（知识库）** —— 只留给「WPS 绑定文件」工具读知识库里的文档用。
 *     台账同步**不再**走这条路，所以它被放在最下面，且写明用途。
 *
 * 为什么直连要建脚本：WPS 对个人账号没有直接写云文档的开放接口（开放平台
 * 只对企业资质开放，2026-10-13 查证）。AirScript 是个人号唯一能"程序改原表"
 * 的路 —— 脚本跑在表格里，读写它自己的单元格。代价是一次性建脚本。
 */

/** 轮询间隔。2 秒：服务端 pending 时返回的是 code=0 的正常应答，刷太快没意义 */
const POLL_MS = 2000;
/** 轮询上限（次）。2s × 90 ≈ 3 分钟，够用户去浏览器里点同意的了 */
const POLL_MAX = 90;

type Busy = "login" | "refresh" | "push" | "pull" | "apply" | "probe" | "link" | null;

type Preview = {
  pull: WpsPull;
  plan: PullPlan;
};

export function WpsSection({
  settings,
  saveSettings,
  say,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  say: (text: string, tone?: Flash["tone"]) => void;
}) {
  const cfg = readKwikiConfig(settings);
  const cloud: CloudConfig = readCloudConfig(settings);
  const desktop = isTauri();
  const [login, setLogin] = useState<{ deviceCode: string; loginUrl: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [spaces, setSpaces] = useState<WpsSpaceLite[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [probe, setProbe] = useState<CloudInfo | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const timer = useRef<number | null>(null);

  const stopPolling = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    setWaiting(false);
  };

  // 分区被卸载（切走设置页）时绝不能把轮询留着 —— 它会对着一个
  // 已经不在界面上的登录流程一直打接口
  useEffect(() => stopPolling, []);

  /* ------------------------------ 登录 ------------------------------ */

  async function finishLogin(token: string) {
    const acc = await accountInfo(token);
    await saveSettings({
      [SETTINGS.kwikiToken]: acc.token,
      // 令牌到期只能重新登录（kwiki 没有刷新接口），所以到期时刻要记下来
      [SETTINGS.kwikiTokenExpiry]: String(Date.now() + acc.expires_in * 1000),
      // 账号接口不给昵称，只给"是不是个人账号"—— 就显示这个，别编一个名字
      [SETTINGS.kwikiAccount]: acc.is_personal ? "个人账号" : "企业账号",
    });
    say("WPS 已连接 —— 「WPS 绑定文件」工具现在可以读知识库里的文件了");
    await refreshSpaces(acc.token);
  }

  function beginPolling(deviceCode: string) {
    stopPolling();
    setWaiting(true);
    let ticks = 0;
    timer.current = window.setInterval(() => {
      ticks += 1;
      void (async () => {
        try {
          const st = await loginPoll(deviceCode);
          if (st.status === "ok") {
            stopPolling();
            setLogin(null);
            await finishLogin(st.token);
            return;
          }
          if (ticks >= POLL_MAX) {
            stopPolling();
            say("等超时了（约 3 分钟）—— 再点一次「登录 WPS」重来", "err");
          }
        } catch (err) {
          // 轮询出错**不打断等待**：网络抖一下很常见，用户还在浏览器里点同意呢。
          // 但错误要算进 ticks，否则一个一直失败的轮询会永远转下去。
          if (ticks >= POLL_MAX) {
            stopPolling();
            say(`登录没成：${(err as Error).message}`, "err");
          }
        }
      })();
    }, POLL_MS);
  }

  async function startLogin() {
    setBusy("login");
    try {
      const l = await loginStart();
      setLogin({ deviceCode: l.device_code, loginUrl: l.login_url });
      // 授权页要在**已登录 WPS 的浏览器**里打开。窗口打不开也不要紧 ——
      // 下面把完整网址摆出来了，用户自己粘过去一样能授权
      try {
        globalThis.open(l.login_url, "_blank", "noopener,noreferrer");
      } catch {
        /* 打不开就算了，网址在卡片里 */
      }
      say("已打开授权页 —— 在已登录 WPS 的浏览器里点同意，然后回来等着");
      beginPolling(l.device_code);
    } catch (err) {
      say(`登录没起来：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  function logout() {
    stopPolling();
    setLogin(null);
    setSpaces([]);
    void saveSettings({
      [SETTINGS.kwikiToken]: "",
      [SETTINGS.kwikiTokenExpiry]: "",
      [SETTINGS.kwikiAccount]: "",
      [SETTINGS.kwikiSpaceKuid]: "",
      [SETTINGS.kwikiDriveId]: "",
    });
    say("已退出 WPS 登录");
  }

  /* ---------------------------- 列表刷新 ---------------------------- */

  async function refreshSpaces(token: string) {
    const list = await listSpaces(token);
    setSpaces(list);
    if (!list.length) {
      say("这个 WPS 账号下还没有知识库 —— 去 WPS 建一个再回来", "err");
      return;
    }
    // 已选的那个不在列表里（被删/改名了）就落到第一个：总比留一个
    // 指向空气的选项强
    const keep = list.find((s) => s.kuid === cfg.spaceKuid) ?? list[0];
    if (keep.kuid !== cfg.spaceKuid || keep.drive_id !== cfg.driveId) {
      await saveSettings({
        [SETTINGS.kwikiSpaceKuid]: keep.kuid,
        [SETTINGS.kwikiDriveId]: keep.drive_id,
      });
    }
  }

  async function refreshAll() {
    setBusy("refresh");
    try {
      await refreshSpaces(cfg.token);
      say("已刷新知识库列表");
    } catch (err) {
      say(`刷新失败：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  // 挂载时把知识库列表拉一次。只在 desktop + 已登录 + 展开登录区时做；
  // token 失效时这里会报错，让用户点「刷新」再试（不自动重试）
  useEffect(() => {
    if (!desktop || !cfg.token || !showLogin) return;
    setBusy("refresh");
    void (async () => {
      try {
        await refreshSpaces(cfg.token);
      } catch {
        /* 静默：多半是令牌过期，用户点刷新或重新登录即可 */
      } finally {
        setBusy(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, showLogin]);

  /* --------------------------- 云端表格直连 --------------------------- */

  async function resolveLink() {
    setBusy("link");
    try {
      const info = await linkInfo(cloud.link);
      if (info.kind !== "sheet") {
        say(`这条链接指向的是「${info.name}」，不是表格（表格才是能推拉的）`, "err");
        return;
      }
      await saveSettings({ [SETTINGS.wpsCloudName]: info.name });
      say(`链接指向「${info.name}」${info.owner ? `（${info.owner}）` : ""}`);
    } catch (err) {
      say(`解析链接失败：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function testCloud() {
    setBusy("probe");
    try {
      const info = await cloudProbe(cloud.webhook, cloud.token);
      setProbe(info);
      await saveSettings({
        [SETTINGS.wpsCloudSheet]: info.sheet,
        [SETTINGS.wpsCloudHeader]: info.header.filter((h) => h.trim()).join(" / "),
      });
      say(`连通了：工作表「${info.sheet}」· ${info.rows} 行 × ${info.cols} 列`);
    } catch (err) {
      say(`连不上：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(AIRSCRIPT_SNIPPET);
      say("脚本已复制 —— 粘到 AirScript 编辑器里，保存后建脚本令牌");
    } catch {
      say("剪贴板被系统拦了 —— 展开下面的代码手动全选复制", "err");
    }
  }

  async function doPush() {
    setBusy("push");
    try {
      // 先读一遍：一条都没有就别推了 —— 别把线上那张表清成光表头
      const rows = await readLedger();
      if (!rows.length) {
        say("本地一条异常单都没有 —— 先登记几例再推", "err");
        return;
      }
      const r = await cloudPush(cloud.webhook, cloud.token, cloud.sheet, rows);
      await saveSettings({
        [SETTINGS.kwikiLastAt]: String(Date.now()),
        [SETTINGS.kwikiLastSummary]: `直连推送 ${r.count} 条`,
      });
      say(
        `已推送 ${r.count} 条到「${settings[SETTINGS.wpsCloudName] || "云端表格"}」` +
          (r.appended ? `（末尾补了 ${r.appended} 列台账表头）` : ""),
      );
    } catch (err) {
      say(`推送失败：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function doPull() {
    setBusy("pull");
    try {
      const res = await cloudPull(cloud.webhook, cloud.token, cloud.sheet);
      const local = await readLedger();
      const plan = planPull(res.rows, local);
      setPreview({ pull: res, plan });
      if (!plan.adds.length && !plan.updates.length) {
        say("在线表格和本地一样，没有要改的");
      }
    } catch (err) {
      say(`拉取失败：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function doApply() {
    if (!preview) return;
    setBusy("apply");
    try {
      const r = await applyPull(preview.plan);
      await saveSettings({
        [SETTINGS.kwikiLastAt]: String(Date.now()),
        [SETTINGS.kwikiLastSummary]: `拉取：新增 ${r.added} 条、更新 ${r.updated} 条`,
      });
      say(`已写库：新增 ${r.added} 条、更新 ${r.updated} 条`);
      setPreview(null);
    } catch (err) {
      say(`写库失败：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  const ready = cloudReady(cloud);
  const linkName = settings[SETTINGS.wpsCloudName] || "";
  const headerText = settings[SETTINGS.wpsCloudHeader] || "";

  const commit = (key: string) => (v: string) => {
    void saveSettings({ [key]: v });
  };

  const lastText = settings[SETTINGS.kwikiLastAt]
    ? `${new Date(Number(settings[SETTINGS.kwikiLastAt])).toLocaleString("zh-CN")}${
        settings[SETTINGS.kwikiLastSummary] ? ` · ${settings[SETTINGS.kwikiLastSummary]}` : ""
      }`
    : "";

  return (
    <div className="space-y-3">
      <SectionTitle
        title="WPS 在线表格联动"
        desc="把异常单台账直接接到你自己那张云端表格上：贴链接 + 一次性的脚本令牌，之后推送、拉取都直接改原表 —— 不登录、不经过知识库、不产生任何副本。"
      />

      {!desktop ? (
        <Card>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] text-fg-2">
            <Table2 size={14} />
            网页端用不了这条路
          </div>
          <p className="text-[11.5px] leading-relaxed text-fg-dim">
            直连云表格要 POST 到 <code>kdocs.cn</code> 的脚本地址，浏览器过不去它的跨域限制 ——
            这是那条服务器的规矩，不是我们没做。整个联动只在<strong>桌面版</strong>里可用
            （打包出来的那个）。网页版里可以正常登记、查看异常单，数据都在本机。
          </p>
        </Card>
      ) : (
        <>
          {/* --------------------------- 云端表格 --------------------------- */}
          <Card>
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-2">
              <Link2 size={14} />
              云端表格（直连）
              {ready ? (
                <span className="ml-1 rounded-full bg-chip px-2 py-0.5 text-[11.5px] text-fg-dim">
                  已配置
                </span>
              ) : (
                <span className="ml-1 rounded-full bg-chip px-2 py-0.5 text-[11.5px] text-fg-dim">
                  待配置
                </span>
              )}
              {lastText && <span className="ml-1 text-[12px] text-fg-dim">上次：{lastText}</span>}
            </div>

            <div className="grid gap-2.5 sm:grid-cols-[1fr_auto]">
              <TextField
                label="表格链接"
                value={cloud.link}
                onCommit={commit(SETTINGS.wpsCloudLink)}
                placeholder="https://www.kdocs.cn/l/xxxx"
                hint="你那张台账的分享链接。链接只用来确认是哪张表；真正同步靠下面的 webhook。"
              />
              <div className="flex items-end gap-2 pb-0.5">
                <ActionButton
                  icon={<PlugZap size={14} />}
                  label={busy === "link" ? "解析中…" : "解析链接"}
                  onClick={() => void resolveLink()}
                  disabled={!cloud.link.trim() || busy === "link"}
                />
                {!!cloud.link.trim() && (
                  <ActionButton
                    icon={<ExternalLink size={14} />}
                    label="在 WPS 打开"
                    onClick={() => globalThis.open(cloud.link, "_blank", "noopener,noreferrer")}
                  />
                )}
              </div>
            </div>

            {!!linkName && (
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-dim">
                链接指向「<b className="text-fg-2">{linkName}</b>」
                {cloud.sheet ? ` · 工作表「${cloud.sheet}」` : ""}
                {headerText ? ` · 上次读到的表头：${headerText}` : ""}
              </p>
            )}

            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <TextField
                label="AirScript Webhook"
                value={cloud.webhook}
                onCommit={commit(SETTINGS.wpsCloudWebhook)}
                placeholder="https://www.kdocs.cn/api/v3/ide/file/…/sync_task"
                hint="在表格的 AirScript 编辑器里，脚本「更多」菜单 →「复制脚本 webhook」。"
              />
              <TextField
                label="AirScript 脚本令牌"
                value={cloud.token}
                type="password"
                onCommit={commit(SETTINGS.wpsCloudToken)}
                placeholder="点「脚本令牌」创建后复制"
                hint="⚠️ 明文存在本机数据库（与同步密码同等待遇）。别在公用电脑上填。"
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ActionButton
                icon={<PlugZap size={14} />}
                label={busy === "probe" ? "连接中…" : "测试连接"}
                onClick={() => void testCloud()}
                disabled={!ready || busy === "probe"}
              />
              <button
                type="button"
                onClick={() => setShowSetup((v) => !v)}
                className="text-[12px] text-primary underline-offset-2 hover:underline"
              >
                {showSetup ? "收起「怎么拿到 webhook 和令牌」" : "怎么拿到 webhook 和令牌？"}
              </button>
            </div>

            {probe && (
              <div className="mt-2 rounded-lg border border-line bg-card p-2.5 text-[11.5px] leading-relaxed text-fg-dim">
                连上了：工作表「<b className="text-fg-2">{probe.sheet}</b>」（共 {probe.sheets} 张
                sheet）· {probe.rows} 行 × {probe.cols} 列
                {probe.header.filter((h) => h.trim()).length ? (
                  <>
                    <br />
                    表头：{probe.header.filter((h) => h.trim()).join(" / ")}
                  </>
                ) : (
                  <>
                    <br />
                    第一行还是空的 —— 第一次推送会把台账表头写进去。
                  </>
                )}
              </div>
            )}

            {showSetup && (
              <div className="mt-2.5 space-y-2 rounded-lg border border-line bg-card p-3">
                <div className="text-[12.5px] text-fg-2">一次性设置（约 2 分钟）</div>
                <ol className="list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-fg-dim">
                  <li>在 WPS 里打开那张台账表格，点顶部「效率 → 高级开发 → AirScript 脚本编辑器」。</li>
                  <li>新建一个脚本，把下面这段代码整段粘进去，保存。</li>
                  <li>点工具栏「脚本令牌」，创建并复制令牌（需实名认证；一个账号只有一个令牌）。</li>
                  <li>在脚本的「更多」菜单里复制「脚本 webhook」，连同令牌一起填到上面两格。</li>
                  <li>点「测试连接」——能读出工作表名和表头就通了。</li>
                </ol>
                <div className="flex flex-wrap items-center gap-2">
                  <ActionButton icon={<Copy size={14} />} label="复制脚本" onClick={() => void copyScript()} />
                  <span className="text-[11px] text-fg-dim">
                    脚本只读写它所在的那张表，不联网、不碰别处。
                  </span>
                </div>
                <textarea
                  readOnly
                  value={AIRSCRIPT_SNIPPET}
                  spellCheck={false}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-40 w-full resize-y rounded-lg border border-line bg-app px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-2 outline-none"
                />
              </div>
            )}
          </Card>

          {/* ------------------------------ 推送 ------------------------------ */}
          <Card>
            <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-2">
              <Upload size={14} />
              推送到云端表格
            </div>
            <ActionButton
              icon={<Upload size={14} />}
              label={busy === "push" ? "推送中…" : "推送"}
              onClick={() => void doPush()}
              disabled={!ready || busy === "push"}
            />
            <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
              <strong>只写台账那 14 列</strong>：按中文表头找到对应的列，你在这张表里自己加的
              备注列 / 公式列一律不动；表里还没有的列会补在末尾。比新数据多的旧行会被清空，
              但只清台账这几列。
            </p>
          </Card>

          {/* ------------------------------ 拉取 ------------------------------ */}
          <Card>
            <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-2">
              <Download size={14} />
              云端表格 · 查看与拉取
            </div>
            <ActionButton
              icon={<Download size={14} />}
              label={busy === "pull" ? "拉取中…" : "拉取并预览"}
              onClick={() => void doPull()}
              disabled={!ready || busy === "pull"}
            />
            <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
              拉下来先算一遍差异给你看，<strong>确认了才写库</strong>。
              按订单号认人（没有订单号就用快递单号）；本地已有的行只补空格、
              不改已有的值，也不动流程和提醒。
            </p>

            {preview && (
              <div className="mt-3 space-y-2 rounded-lg border border-line bg-card p-2.5">
                <div className="text-[12.5px] text-fg-2">
                  将新增 <b>{preview.plan.adds.length}</b> 条，将更新{" "}
                  <b>{preview.plan.updates.length}</b> 条
                  <span className="ml-1 text-fg-dim">
                    （表头 {preview.pull.header.length} 列，认不出的列会被忽略）
                  </span>
                </div>
                {!!preview.plan.adds.length && (
                  <div className="space-y-0.5 text-[11.5px] leading-relaxed text-fg-dim">
                    {preview.plan.adds.slice(0, 8).map((r: LedgerRow, i: number) => (
                      <div key={i}>
                        + {r.order_sn || r.tracking_no}
                        {r.store ? ` · ${r.store}` : ""}
                        {r.category ? ` · ${r.category}` : ""}
                      </div>
                    ))}
                    {preview.plan.adds.length > 8 && (
                      <div>… 还有 {preview.plan.adds.length - 8} 条新增</div>
                    )}
                  </div>
                )}
                {!!preview.plan.updates.length && (
                  <div className="space-y-0.5 text-[11.5px] leading-relaxed text-fg-dim">
                    {preview.plan.updates.slice(0, 8).map((u, i) => (
                      <div key={i}>
                        ~ {u.row.order_sn || u.row.tracking_no}：
                        {Object.entries(u.patch)
                          .map(([k, v]) => `${k} ${u.row[k] || "（空）"} → ${v}`)
                          .join("；")}
                      </div>
                    ))}
                    {preview.plan.updates.length > 8 && (
                      <div>… 还有 {preview.plan.updates.length - 8} 条更新</div>
                    )}
                  </div>
                )}

                {/* 「在程序里看见那张表」：拉下来的原始内容，只读 */}
                <OnlineTable pull={preview.pull} />

                <div className="flex flex-wrap gap-2 pt-1">
                  <ActionButton
                    icon={<Download size={14} />}
                    label={busy === "apply" ? "写库中…" : "确认写库"}
                    onClick={() => void doApply()}
                    disabled={
                      busy === "apply" ||
                      (!preview.plan.adds.length && !preview.plan.updates.length)
                    }
                  />
                  <ActionButton label="取消" icon={<></>} onClick={() => setPreview(null)} />
                </div>
              </div>
            )}
          </Card>

          {/* ------------------------ WPS 登录（知识库） ------------------------ */}
          <Card>
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-2">
              <KeyRound size={14} />
              WPS 登录（只给「WPS 绑定文件」工具用）
              <button
                type="button"
                onClick={() => setShowLogin((v) => !v)}
                className="ml-auto text-[12px] text-primary underline-offset-2 hover:underline"
              >
                {showLogin ? "收起" : "展开"}
              </button>
            </div>
            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              台账直连<strong>不需要登录</strong>。这一块只在你要用「WPS 绑定文件」工具
              读写知识库里的表格 / 文档时才需要 —— 它没有 webhook，只能走账号。
            </p>

            {showLogin && (
              <div className="mt-2.5 space-y-2">
                {cfg.token ? (
                  <>
                    <div className="text-[12px] text-fg-dim">
                      已连接（{cfg.account || "WPS 账号"}）
                      {cfg.expiry
                        ? ` · 令牌约用到 ${new Date(cfg.expiry).toLocaleDateString("zh-CN")}`
                        : ""}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        icon={<RefreshCw size={14} />}
                        label={busy === "refresh" ? "刷新中…" : "刷新知识库列表"}
                        onClick={() => void refreshAll()}
                        disabled={busy === "refresh"}
                      />
                      <ActionButton icon={<LogOut size={14} />} label="退出登录" onClick={logout} />
                    </div>
                    <label className="block">
                      <span className="mb-1 block text-[12px] text-fg-dim">
                        「WPS 绑定文件」默认用哪个知识库
                      </span>
                      <select
                        value={cfg.spaceKuid || spaces[0]?.kuid || ""}
                        onChange={(e) => {
                          const s = spaces.find((x) => x.kuid === e.target.value);
                          if (s) {
                            void saveSettings({
                              [SETTINGS.kwikiSpaceKuid]: s.kuid,
                              [SETTINGS.kwikiDriveId]: s.drive_id,
                            });
                          }
                        }}
                        className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
                      >
                        {!spaces.length && <option value="">（还没拉到知识库）</option>}
                        {spaces.map((s) => (
                          <option key={s.kuid} value={s.kuid}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <ActionButton
                      icon={<KeyRound size={14} />}
                      label={busy === "login" ? "正在取授权页…" : "登录 WPS"}
                      onClick={() => void startLogin()}
                      disabled={busy === "login"}
                    />
                    {login && (
                      <div className="space-y-1.5 rounded-lg border border-line bg-card p-2.5">
                        <div className="text-[12.5px] text-fg-2">
                          {waiting ? "等着你点同意…" : "授权页已打开"}（设备码{" "}
                          <code className="text-[12px]">{login.deviceCode}</code>）
                        </div>
                        <a
                          href={login.loginUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 break-all text-[12.5px] text-primary underline"
                        >
                          <ExternalLink size={12} />
                          {login.loginUrl}
                        </a>
                        <p className="text-[11.5px] leading-relaxed text-fg-dim">
                          要在<strong>已经登录了 WPS 的浏览器</strong>里打开这个网址，点「同意」。
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 在线表格的只读预览                                                    */
/* ------------------------------------------------------------------ */

/**
 * 台账列：中文表头 → SQLite 列名。
 *
 * 线上表头就是按 COLUMNS 写上去的，所以这张表能把拉回来的行**按原来的
 * 列名、原来的列序**摆出来。用户自己在 WPS 里加过的列（认不出来的表头）
 * 也照样显示表头，只是格子空着 —— 藏掉反而让人以为漏列了。
 */
const KEY_BY_LABEL = new Map(COLUMNS.map(([key, label]) => [label, key]));

/**
 * 一次最多渲染多少行。
 *
 * 台账上千行时，把整张表塞进 DOM 会让设置页卡住；真实行数照实写在标题里，
 * 不给「看起来只有 500 行」的错觉。
 */
const PREVIEW_ROWS = 500;

/**
 * 把 `wps_pull` 拉回来的东西原样摊成一张表。
 *
 * 这是「在程序里看见那张在线表」的唯一入口：只读预览，不写库 ——
 * 写库要用户单独点「确认写库」（见调用处）。列头用**线上那份表头**，
 * 不是本地列定义，所以 WPS 里改过名字的列在这里立刻就能看出来。
 */
function OnlineTable({ pull }: { pull: WpsPull }) {
  const rows = pull.rows.slice(0, PREVIEW_ROWS);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-fg-dim">
        <span>在线表格内容（只读）</span>
        <span>
          共 <b className="text-fg-2">{pull.rows.length}</b> 行 · {pull.header.length} 列
        </span>
        {pull.rows.length > PREVIEW_ROWS && <span>（只显示前 {PREVIEW_ROWS} 行）</span>}
      </div>

      {pull.rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-card px-4 py-3 text-[12.5px] text-fg-dim">
          在线表格里还没有数据 —— 先点上面的「推送」把本地台账传上去
        </div>
      ) : (
        <div className="max-h-[360px] overflow-auto rounded-lg border border-line bg-card">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-chip">
              <tr className="text-left text-[11.5px] text-fg-dim">
                {pull.header.map((h, i) => (
                  <th key={i} className="whitespace-nowrap px-3 py-1.5 font-normal">
                    {h || `第 ${i + 1} 列`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-line">
                  {pull.header.map((h, j) => {
                    const key = KEY_BY_LABEL.get(h);
                    const text = key ? row[key] ?? "" : "";
                    return (
                      <td
                        key={j}
                        className="max-w-[260px] truncate px-3 py-1.5 text-[11.5px] text-fg-2"
                        title={text}
                      >
                        {text || <span className="text-fg-dim">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* 登录区里只用到知识库的三个字段 —— 不为此把 kwiki 的整组类型都 import 进来 */
type WpsSpaceLite = { kuid: string; drive_id: string; name: string };
