import { SectionTitle, Card, ActionButton } from "./parts";
import type { Flash } from "./parts";
import { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  KeyRound,
  LogOut,
  RefreshCw,
  Table2,
} from "lucide-react";
import { SETTINGS } from "../../lib/settings";
import { isTauri } from "../../lib/db";
import {
  accountInfo,
  listSpaces,
  loginPoll,
  loginStart,
  readKwikiConfig,
} from "../../lib/kwiki";
import { WpsMcpAuth } from "./WpsMcpAuth";

/* ---------------------------- 分区：WPS 授权 ---------------------------- */

/**
 * 这个分区**只管授权**（2026-10-19 起再瘦一刀：挑表 / 推送 / 拉取整块搬进了
 * 「异常单号登记」工具自己的设置卡 —— 表格是那个工具的事，设置页不该替它管）：
 *
 *  1. **授权卡（WpsMcpAuth）** —— MCP 设备码授权 + 「确认启用」。
 *     令牌是账号级的，能碰全部云文档，所以启用那一步单独要用户按一次。
 *     授权用户、令牌到期、清点规模都摆在这张卡上。
 *  2. **WPS 登录（知识库）** —— 另一套授权，只给「WPS 绑定文件」工具
 *     进知识库用（MCP 只列得出「我的云文档」根目录）。与 MCP 互不通用。
 */

/** 轮询间隔。2 秒：服务端 pending 时返回的是 code=0 的正常应答，刷太快没意义 */
const POLL_MS = 2000;
/** 轮询上限（次）。2s × 90 ≈ 3 分钟，够用户去浏览器里点同意的了 */
const POLL_MAX = 90;

type Busy = "login" | "refresh" | null;

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
  const [spaces, setSpaces] = useState<WpsSpaceLite[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
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

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <div className="space-y-3">
      <SectionTitle
        title="WPS 授权"
        desc="授权一次 WPS 账号，程序就能直接读写你「我的云文档」里的表格与文档 —— 不用在 WPS 里建任何东西，也不产生副本。具体接哪张表、怎么推拉，去用它的工具里设置。"
      />

      {!desktop ? (
        <Card>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] text-fg-2">
            <Table2 size={14} />
            网页端用不了这条路
          </div>
          <p className="text-[11.5px] leading-relaxed text-fg-dim">
            读写云文档要请求 <code>mcp-center.wps.cn</code>，浏览器过不去它的跨域限制 ——
            这是那条服务器的规矩，不是我们没做。授权与同步只在<strong>桌面版</strong>里可用
            （打包出来的那个）。网页版里可以正常登记、查看异常单，数据都在本机。
          </p>
        </Card>
      ) : (
        <>
          {/* ---------------- 授权（账号级令牌 + 用户信息） ---------------- */}
          <WpsMcpAuth settings={settings} saveSettings={saveSettings} say={say} />

          <Card>
            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              授权完之后这里不用再做什么 —— 要把「异常单号登记」的台账接到在线表格：
              打开那个工具 →<b className="text-fg-2">设置 → 在线表格（WPS）</b>，
              粘一条分享链接就行，用的就是上面这同一份授权。
            </p>
          </Card>

          {/* ---------------------- WPS 登录（知识库） ---------------------- */}
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
              这是另一套授权，与上面那张卡互不通用：MCP 只列得出「我的云文档」根目录，
              <b>知识库</b>里的东西得靠这个账号进去。只用「异常单号登记」的话不需要登录它。
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

/* 登录区里只用到知识库的三个字段 —— 不为此把 kwiki 的整组类型都 import 进来 */
type WpsSpaceLite = { kuid: string; drive_id: string; name: string };
