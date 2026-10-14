import { SectionTitle, Card, TextField, ActionButton } from "./parts";
import type { Flash } from "./parts";
import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, KeyRound, LogOut, RefreshCw, Table2, Upload } from "lucide-react";
import { SETTINGS } from "../../lib/settings";
import { isTauri } from "../../lib/db";
import {
  accountInfo,
  applyPull,
  listFiles,
  listSpaces,
  loginPoll,
  loginStart,
  planPull,
  pullLedger,
  pushLedger,
  readKwikiConfig,
  readLedger,
  type LedgerRow,
  type PullPlan,
  type WpsFile,
  type WpsPull,
  type WpsSpace,
} from "../../lib/kwiki";

/* ---------------------------- 分区：WPS 在线表格联动 ---------------------------- */

/**
 * 把异常单台账接到 **WPS 知识库的在线表格**上，推拉都全自动。
 *
 * 走的是 WPS 自家的 kwiki 接口（设备码登录，个人账号就能用）—— 金山文档
 * 开放平台那套要企业资质，个人认证不开放，见 lib/kwiki.ts 顶部。
 * 传输层在 Rust（src-tauri/src/wps.rs），浏览器跨不过 CORS，所以整个分区
 * **只属于桌面版**，网页端进来只看到一句说明。
 *
 * 三件事必须摆在界面上（不藏在 tooltip 里）：
 *   1. 令牌**明文存在本机数据库**，和同步密码一个待遇；
 *   2. 推送是「传新 → 删旧 → 改名」—— 线上旧的那份进回收站（7 天可恢复），
 *      不是原地覆盖；
 *   3. 每次推送都**按标题找表**（推送后表的节点 id 必然变，存死它会删错）。
 */

/** 轮询间隔。2 秒：服务端 pending 时返回的是 code=0 的正常应答，刷太快没意义 */
const POLL_MS = 2000;
/** 轮询上限（次）。2s × 90 ≈ 3 分钟，够用户去浏览器里点同意的了 */
const POLL_MAX = 90;

type Busy = "login" | "refresh" | "push" | "pull" | "apply" | null;

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
  const desktop = isTauri();
  const [login, setLogin] = useState<{ deviceCode: string; loginUrl: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [spaces, setSpaces] = useState<WpsSpace[]>([]);
  const [files, setFiles] = useState<WpsFile[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
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
    say("WPS 已连接");
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
    setFiles([]);
    setPreview(null);
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

  async function refreshFiles(token: string, spaceKuid: string) {
    const list = await listFiles(token, spaceKuid);
    setFiles(list);
  }

  async function refreshSpaces(token: string) {
    const list = await listSpaces(token);
    setSpaces(list);
    if (!list.length) {
      setFiles([]);
      say("这个 WPS 账号下还没有知识库 —— 去 WPS 建一个再回来", "err");
      return;
    }
    // 已选的那个不在列表里（被删/改名了）就落到第一个：总比留一个
    // 指向空气的选项强 —— 那种情况下推送会报"找不到表"，用户看不出原因
    const keep = list.find((s) => s.kuid === cfg.spaceKuid) ?? list[0];
    if (keep.kuid !== cfg.spaceKuid || keep.drive_id !== cfg.driveId) {
      await saveSettings({
        [SETTINGS.kwikiSpaceKuid]: keep.kuid,
        [SETTINGS.kwikiDriveId]: keep.drive_id,
      });
    }
    await refreshFiles(token, keep.kuid);
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

  // 挂载时把知识库列表拉一次。只在 desktop + 已登录时做；
  // token 失效时这里会报错，让用户点「刷新」再试（不自动重试，
  // 免得界面上一进场就弹一片红）
  useEffect(() => {
    if (!desktop || !cfg.token) return;
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
  }, [desktop]);

  /* ------------------------------ 推送 ------------------------------ */

  async function doPush() {
    setBusy("push");
    try {
      // 先读一遍：一条都没有就别推了 —— 空表推送会把线上那份移进回收站，
      // 换回来的只有一张光表头的表，得不偿失
      const rows = await readLedger();
      if (!rows.length) {
        say("本地一条异常单都没有 —— 先登记几例再推", "err");
        return;
      }
      const r = await pushLedger(cfg.token, spaceKuid, driveId, cfg.tableTitle, rows);
      await saveSettings({
        [SETTINGS.kwikiLastAt]: String(Date.now()),
        [SETTINGS.kwikiLastSummary]: `推送 ${r.count} 条`,
      });
      say(`已推送 ${r.count} 条到「${cfg.tableTitle}」`);
      await refreshFiles(cfg.token, spaceKuid);
    } catch (err) {
      say(`推送失败：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /* ------------------------------ 拉取 ------------------------------ */

  async function doPull() {
    setBusy("pull");
    try {
      const res = await pullLedger(cfg.token, spaceKuid, cfg.tableTitle);
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

  // 已选的库不在列表里时（设置是旧的、库被删了）退回第一个，
  // 与 refreshSpaces 里的兜底同一个方向
  const spaceKuid = cfg.spaceKuid || spaces[0]?.kuid || "";
  const driveId = cfg.driveId || spaces.find((s) => s.kuid === spaceKuid)?.drive_id || "";
  const theTable = files.find((f) => f.title === cfg.tableTitle);
  const ready = !!cfg.token && !!spaceKuid && !!driveId;

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
        desc="把异常单台账接到 WPS 知识库的在线表格上。登录一次，之后推送、拉取都是点一下的事 —— 找表、下载、拼表、上传、删旧、改名全由程序自己做。"
      />

      {!desktop ? (
        <Card>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] text-fg-2">
            <Table2 size={14} />
            网页端用不了这条路
          </div>
          <p className="text-[11.5px] leading-relaxed text-fg-dim">
            同步 WPS 在线表格要直连 <code>zhishi.wps.cn</code>，浏览器过不去它的跨域限制 ——
            这是那条服务器的规矩，不是我们没做。整个联动只在<strong>桌面版</strong>里可用
            （打包出来的那个）。网页版里可以正常登记、查看异常单，数据都在本机。
          </p>
        </Card>
      ) : (
        <>
          {/* ------------------------------ 登录 ------------------------------ */}
          <Card>
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-2">
              <KeyRound size={14} />
              登录 WPS
              {cfg.token && (
                <span className="ml-1 text-[12px] text-fg-dim">
                  已连接（{cfg.account || "WPS 账号"}）
                  {cfg.expiry
                    ? ` · 令牌约用到 ${new Date(cfg.expiry).toLocaleDateString("zh-CN")}`
                    : ""}
                </span>
              )}
            </div>

            {cfg.token ? (
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  icon={<RefreshCw size={14} />}
                  label={busy === "refresh" ? "刷新中…" : "刷新知识库列表"}
                  onClick={() => void refreshAll()}
                  disabled={busy === "refresh"}
                />
                <ActionButton icon={<LogOut size={14} />} label="退出登录" onClick={logout} />
              </div>
            ) : (
              <>
                <ActionButton
                  icon={<KeyRound size={14} />}
                  label={busy === "login" ? "正在取授权页…" : "登录 WPS"}
                  onClick={() => void startLogin()}
                  disabled={busy === "login"}
                />
                {login && (
                  <div className="mt-2.5 space-y-1.5 rounded-lg border border-line bg-card p-2.5">
                    <div className="text-[12.5px] text-fg-2">
                      {waiting ? "等着你点同意…" : "授权页已打开"}（设备码{" "}
                      <code className="text-[12px]">{login.deviceCode}</code>）
                    </div>
                    <div className="flex items-center gap-2">
                      <a
                        href={login.loginUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 break-all text-[12.5px] text-primary underline"
                      >
                        <ExternalLink size={12} />
                        {login.loginUrl}
                      </a>
                    </div>
                    <p className="text-[11.5px] leading-relaxed text-fg-dim">
                      要在<strong>已经登录了 WPS 的浏览器</strong>里打开这个网址，点「同意」。
                      窗口没自动跳出来就把上面这条链接复制过去。令牌管一年左右，
                      到期再来这一趟。
                    </p>
                  </div>
                )}
                <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
                  ⚠️ 令牌<strong>明文存在本机数据库</strong>里，没有加密 ——
                  和同步密码、网盘令牌一个待遇（密钥也得存本机才能自动同步）。
                  别在公用电脑上登。
                </p>
              </>
            )}
          </Card>

          {/* ---------------------------- 表格在哪 ---------------------------- */}
          {cfg.token && (
            <Card>
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-2">
                <Table2 size={14} />
                表格在哪
                {lastText && <span className="ml-1 text-[12px] text-fg-dim">上次：{lastText}</span>}
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-fg-dim">知识库</span>
                  <select
                    value={spaceKuid}
                    onChange={(e) => {
                      const s = spaces.find((x) => x.kuid === e.target.value);
                      if (s) {
                        void saveSettings({
                          [SETTINGS.kwikiSpaceKuid]: s.kuid,
                          [SETTINGS.kwikiDriveId]: s.drive_id,
                        });
                        void refreshFiles(cfg.token, s.kuid);
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
                <TextField
                  label="表格标题"
                  value={cfg.tableTitle}
                  onCommit={commit(SETTINGS.kwikiTableTitle)}
                  placeholder="异常台账"
                  hint="要和知识库里的文件名一模一样。推送时按这个标题找表 —— 推送后节点 id 会变，存死它会删错。"
                />
              </div>
              {!!files.length && (
                <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
                  {theTable ? (
                    <>
                      这个库里有「{theTable.title}」（{Math.round(theTable.size / 1024)} KB）
                      —— 推送会替换它，拉取会读它。
                    </>
                  ) : (
                    <>
                      这个库里还没有叫「{cfg.tableTitle}」的表。第一次推送会按在线表格的
                      包结构新建一份；想先有一张，去 WPS 里建一个同名空表再推送也行。
                    </>
                  )}
                </p>
              )}
            </Card>
          )}

          {/* ------------------------------ 推送 ------------------------------ */}
          {cfg.token && (
            <Card>
              <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-2">
                <Upload size={14} />
                推送到在线表格
              </div>
              <ActionButton
                icon={<Upload size={14} />}
                label={busy === "push" ? "推送中…" : "推送"}
                onClick={() => void doPush()}
                disabled={!ready || busy === "push"}
              />
              <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
                整表替换：程序先下载线上那份当模板，把本地台账拼进去，再
                <strong>上传新表 → 旧表移入回收站 → 新表改回原名</strong>
                （上传是新建不是覆盖，这是服务端的规矩）。回收站里躺 7 天，
                推错了能捞回来。
              </p>
            </Card>
          )}

          {/* ------------------------------ 拉取 ------------------------------ */}
          {cfg.token && (
            <Card>
              <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-2">
                <Download size={14} />
                从在线表格拉取
              </div>
              <ActionButton
                icon={<Download size={14} />}
                label={busy === "pull" ? "拉取中…" : "拉取一次"}
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
          )}
        </>
      )}
    </div>
  );
}
