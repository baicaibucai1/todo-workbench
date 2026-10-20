import { useEffect, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  KeyRound,
  LogOut,
  PlugZap,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Card, ActionButton, InfoCell } from "./parts";import type { Flash } from "./parts";
import { SETTINGS } from "../../lib/settings";
import { openExternal } from "../../lib/attachments";
import {
  mcpAuthAlive,
  mcpBegin,
  mcpCloseAuth,
  mcpOpenAuth,
  mcpPoll,
  mcpProbe,
  readMcpConfig,
  type McpProbe,
} from "../../lib/wpsMcp";

/**
 * 「WPS 授权」分区顶上的那张**授权卡**（2026-10-19 从独立分区并进来）：
 * 授权 → 确认启用 → 挑表格 → 推拉，一条线在同一个分区里读完，
 * 用户不用在两个分区之间猜"授权入口在哪"。
 *
 * 不带 SectionTitle、不做网页端拦截 —— 这两件事由外层 WpsSection 统一管
 * （标题是分区的，`!desktop` 分支整页只出一张卡）。
 * 与 kwiki 登录同一套节奏（2 秒一次、5 分钟上限）：
 * 授权这一步的瓶颈永远是"用户什么时候在浏览器里点同意"，
 * 刷得更快只会给服务端添无谓的请求。
 */
const POLL_MS = 2000;
const POLL_MAX = 150;

type Busy = "auth" | "probe" | "test" | "off" | null;

export function WpsMcpAuth({
  settings,
  saveSettings,
  say,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  say: (text: string, tone?: Flash["tone"]) => void;
}) {
  const cfg = readMcpConfig(settings);

  // 刚换回来的令牌先落在本地：saveSettings 是异步落库的，
  // 等它回灌到 settings 再渲染会有一段"看起来没连上"的空窗
  const [local, setLocal] = useState<{ token: string; clientId: string; expiry: number } | null>(
    null,
  );
  const token = local?.token ?? cfg.token;
  const clientId = local?.clientId ?? cfg.clientId;
  const expiry = local?.expiry ?? cfg.expiry;

  const [login, setLogin] = useState<{ code: string; url: string; clientId: string } | null>(null);
  const [waiting, setWaiting] = useState(false);
  /** 轮询最近一次报错。不弹全局提示（会打断"等着点同意"的节奏），但必须摆出来 ——
   *  憋到 5 分钟超时才说，用户只会看到"永远在等"（2026-10-19 code=200 被当错就是它藏的） */
  const [pollErr, setPollErr] = useState<string | null>(null);
  /** 授权页现在在哪儿：「窗口」=程序内弹出的内嵌浏览器；「browser」=系统浏览器 */
  const [opened, setOpened] = useState<"window" | "browser" | "none" | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [probe, setProbe] = useState<McpProbe | null>(null);
  /** 这次检测的时刻。别在渲染里现取 Date.now() —— 每渲染一次数字就变，像在倒计时 */
  const [probedAt, setProbedAt] = useState(0);
  const timer = useRef<number | null>(null);
  /** 授权页在哪儿。只有「窗口」这一路才需要盯着窗口有没有被叉掉 */
  const where = useRef<"window" | "browser">("window");

  const stopPolling = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    setWaiting(false);
  };

  // 切走设置页时轮询必须停 —— 否则它会对着一个已经不在界面上的流程一直打接口。
  // 顺带把授权窗口收掉：没人接的窗口留着只会让人以为流程还卡着
  useEffect(
    () => () => {
      stopPolling();
      void mcpCloseAuth();
    },
    [],
  );

  const connected = !!token && !!clientId;
  const enabled = cfg.enabled && connected;
  const tools = probe ? probe.tools : Number(cfg.tools || 0) || 0;
  const files = probe ? probe.files : Number(cfg.files || 0) || -1;
  const user = (probe ? probe.user : "") || cfg.user;
  const lastAt = probe ? probedAt : Number(cfg.lastAt || 0) || 0;

  /* ------------------------------ 授权 ------------------------------ */

  async function finishLogin(t: string, cid: string, expiresIn: number) {
    // 拿到了令牌，授权窗口的使命就结束了 —— 别让它继续占着屏幕
    void mcpCloseAuth();
    setOpened(null);
    const exp = expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
    setLocal({ token: t, clientId: cid, expiry: exp });
    await saveSettings({
      [SETTINGS.wpsMcpToken]: t,
      [SETTINGS.wpsMcpClientId]: cid,
      [SETTINGS.wpsMcpExpiry]: exp ? String(exp) : "",
      // 换令牌成功**不等于**启用：确认那一步由用户按
      [SETTINGS.wpsMcpEnabled]: "",
    });
    say("WPS 已授权 —— 先别急着走，下面点「确认启用」");
    await runProbe(t, cid, "auth");
  }

  function beginPolling(code: string, cid: string) {
    stopPolling();
    setWaiting(true);
    setPollErr(null);
    let ticks = 0;
    /** 连续几次发现窗口没了。刚建窗那一瞬可能取不到，所以连续两次才算数 */
    let gone = 0;
    timer.current = window.setInterval(() => {
      ticks += 1;
      void (async () => {
        // 窗口被叉掉之后，这个码再也不会有人确认 —— 与其空转 5 分钟，
        // 不如当场说清楚。走系统浏览器那一路不查，窗口本来就不在。
        if (where.current === "window") {
          const alive = await mcpAuthAlive();
          if (!alive) {
            gone += 1;
            if (gone >= 2) {
              stopPolling();
              setLogin(null);
              setOpened(null);
              say("授权窗口被关掉了 —— 再点一次「授权并连接」", "err");
              return;
            }
          } else {
            gone = 0;
          }
        }
        try {
          const st = await mcpPoll(code);
          if (st.status === "ok") {
            stopPolling();
            setLogin(null);
            await finishLogin(st.token, cid, st.expires_in);
            return;
          }
          if (st.status === "enterprise") {
            stopPolling();
            setLogin(null);
            setOpened(null);
            void mcpCloseAuth();
            say("企业账号用不了这条路 —— 换个人账号再试", "err");
            return;
          }
          if (st.status === "cancelled") {
            stopPolling();
            setLogin(null);
            setOpened(null);
            void mcpCloseAuth();
            say("授权被取消了", "err");
            return;
          }
          if (ticks >= POLL_MAX) {
            stopPolling();
            void mcpCloseAuth();
            say("等超时了（约 5 分钟）—— 再点一次「授权并连接」重来", "err");
          }
        } catch (err) {
          // 网络抖一下不打断等待：用户还在浏览器里点同意呢。
          // 但错误必须当场亮出来 —— 憋到超时，用户看到的就只是"永远在等"
          setPollErr((err as Error).message);
          // 失败也要记进 ticks，否则一直失败会永远转下去
          if (ticks >= POLL_MAX) {
            stopPolling();
            void mcpCloseAuth();
            say(`授权没成：${(err as Error).message}`, "err");
          }
        }
      })();
    }, POLL_MS);
  }

  /** 在程序内弹窗。建不出来就退到系统浏览器 —— 两条路都只是"把页面给人看" */
  async function showAuthPage(url: string): Promise<"window" | "browser" | "none"> {
    try {
      await mcpOpenAuth(url);
      where.current = "window";
      return "window";
    } catch {
      try {
        await openExternal(url);
        where.current = "browser";
        return "browser";
      } catch {
        where.current = "browser"; // 页面没打开，用户可能自己粘网址去授权，别按窗口判死
        return "none";
      }
    }
  }

  async function startAuth() {
    setBusy("auth");
    try {
      const b = await mcpBegin();
      setLogin({ code: b.auth_code, url: b.auth_url, clientId: b.client_id });
      setProbe(null);
      const how = await showAuthPage(b.auth_url);
      setOpened(how);
      say(
        how === "window"
          ? "授权窗口已弹出 —— 登录 WPS 后点「同意」，点完这里会自动接上"
          : how === "browser"
            ? "已用系统浏览器打开授权页 —— 点完同意回来自动接上"
            : "授权页没打开 —— 点下面的「在浏览器中打开」",
        how === "none" ? "err" : undefined,
      );
      beginPolling(b.auth_code, b.client_id);
    } catch (err) {
      say(`授权没起来：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function reopenAuthWindow() {
    if (!login) return;
    setOpened(await showAuthPage(login.url));
  }

  async function openAuthInBrowser() {
    if (!login) return;
    try {
      await openExternal(login.url);
      where.current = "browser";
      setOpened("browser");
    } catch (err) {
      say(`打开浏览器失败：${(err as Error).message}`, "err");
    }
  }

  /* ------------------------------ 检测 ------------------------------ */

  async function runProbe(t: string, cid: string, mode: "auth" | "test") {
    setBusy(mode === "auth" ? "probe" : "test");
    try {
      const r = await mcpProbe(t, cid);
      setProbe(r);
      setProbedAt(Date.now());
      await saveSettings({
        [SETTINGS.wpsMcpTools]: String(r.tools),
        [SETTINGS.wpsMcpFiles]: String(r.files),
        [SETTINGS.wpsMcpLastAt]: String(Date.now()),
        // 授权用户：MCP 没有"我是谁"接口，从列文件的 created_by 里取。
        // 空就存空 —— 界面显示「未读到」，别拿旧名字顶替
        [SETTINGS.wpsMcpUser]: r.user,
      });
      if (r.note) say(r.note, "err");
      else if (mode === "test") say(`连接正常 —— ${r.tools} 个工具都在`);
    } catch (err) {
      setProbe(null);
      say(`连接失败：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function confirmEnable() {
    await saveSettings({ [SETTINGS.wpsMcpEnabled]: "1" });
    say("WPS MCP 已启用");
  }

  async function disconnect() {
    stopPolling();
    setLogin(null);
    setProbe(null);
    setLocal(null);
    await saveSettings({
      [SETTINGS.wpsMcpToken]: "",
      [SETTINGS.wpsMcpClientId]: "",
      [SETTINGS.wpsMcpEnabled]: "",
      [SETTINGS.wpsMcpExpiry]: "",
      [SETTINGS.wpsMcpTools]: "",
      [SETTINGS.wpsMcpFiles]: "",
      [SETTINGS.wpsMcpUser]: "",
    });
    say("已断开 WPS MCP");
  }

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <div className="space-y-3">
      <Card>
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-2">
          <PlugZap size={14} />
          连接状态
          {enabled ? (
            <span className="ml-1 rounded-full bg-chip px-2 py-0.5 text-[11.5px] text-fg-dim">
              已启用
            </span>
          ) : connected ? (
            <span className="ml-1 rounded-full bg-chip px-2 py-0.5 text-[11.5px] text-fg-dim">
              已授权 · 未启用
            </span>
          ) : (
            <span className="ml-1 rounded-full bg-chip px-2 py-0.5 text-[11.5px] text-fg-dim">
              未连接
            </span>
          )}
          {lastAt > 0 && (
            <span className="ml-1 text-[12px] text-fg-dim">
              上次检测：{new Date(lastAt).toLocaleString("zh-CN")}
            </span>
          )}
        </div>

        {!connected ? (
          <>
            <p className="mb-2 text-[11.5px] leading-relaxed text-fg-dim">
              点下面这颗按钮，<strong>程序里会直接弹出金山授权页</strong>。在里面登录 WPS 并点「同意」，
              窗口自己关掉，这里接着把连接建起来（约 5 秒）。
            </p>
            <ActionButton
              icon={<KeyRound size={14} />}
              label={busy === "auth" ? "正在取授权页…" : "授权并连接"}
              onClick={() => void startAuth()}
              disabled={busy === "auth"}
            />

            {login && (
              <div className="mt-2 space-y-1.5 rounded-lg border border-line bg-card p-2.5">
                <div className="text-[12.5px] text-fg-2">
                  {waiting
                    ? opened === "window"
                      ? "授权窗口已弹出 —— 登录后点「同意」"
                      : "等着你点同意…"
                    : "授权流程已结束"}
                  （授权码 <code className="text-[12px]">{login.code}</code>）
                </div>
                {pollErr && (
                  <p className="text-[11.5px] leading-relaxed text-danger">
                    最近一次轮询报错：{pollErr}（还在继续等，不影响）
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
                  <button
                    type="button"
                    onClick={() => void reopenAuthWindow()}
                    className="inline-flex items-center gap-1 text-fg-2 underline-offset-2 hover:underline"
                  >
                    <KeyRound size={12} />
                    重新打开授权窗口
                  </button>
                  <button
                    type="button"
                    onClick={() => void openAuthInBrowser()}
                    className="inline-flex items-center gap-1 text-fg-2 underline-offset-2 hover:underline"
                  >
                    <ExternalLink size={12} />
                    在浏览器中打开
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopPolling();
                      setLogin(null);
                      setOpened(null);
                      void mcpCloseAuth();
                      say("已取消这次授权");
                    }}
                    className="text-fg-dim underline-offset-2 hover:underline"
                  >
                    取消
                  </button>
                </div>
                <p className="break-all text-[11px] leading-relaxed text-fg-dim">{login.url}</p>
              </div>
            )}
          </>
        ) : (
          <>
            {/* 清点到的东西。没跑过检测就显示上次存的数，别摆一排 0 让人以为坏了。
                授权用户摆第一个 —— 这一页现在只管授权，"授权给了谁"是第一信息 */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoCell label="授权用户" value={user || "未读到"} />
              <InfoCell label="可用工具" value={tools ? `${tools} 个` : "未检测"} />
              <InfoCell
                label="云文档（根目录）"
                value={files >= 0 ? `${files} 项` : "未读到"}
              />
              <InfoCell
                label="令牌到期"
                value={expiry ? new Date(expiry).toLocaleDateString("zh-CN") : "服务端未给"}
              />
            </div>

            {!!probe?.sample.length && (
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-dim">
                读到：{probe.sample.join(" / ")}
              </p>
            )}

            {!!probe?.note && (
              <p className="mt-1.5 rounded-lg border border-line bg-card px-2.5 py-2 text-[11.5px] leading-relaxed text-fg-dim">
                {probe.note}
              </p>
            )}

            {/* 确认环节：授权成功 ≠ 允许程序动全部云文档。
                这一步按下去只写 wps.mcp.enabled，后续读写一概以它为门 */}
            {!enabled && (
              <div className="mt-2.5 rounded-lg border border-line bg-card p-2.5">
                <div className="flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-2">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                  <span>
                    这个令牌能读写你<strong>全部云文档</strong>，不只是某一张表。确认要继续用？
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <ActionButton
                    icon={<Check size={14} />}
                    label="确认启用"
                    onClick={() => void confirmEnable()}
                  />
                  <ActionButton icon={<LogOut size={14} />} label="不启用，断开" onClick={() => void disconnect()} />
                </div>
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap gap-2">
              <ActionButton
                icon={<RefreshCw size={14} />}
                label={busy === "test" || busy === "probe" ? "检测中…" : "测试连接"}
                onClick={() => void runProbe(token, clientId, "test")}
                disabled={busy === "test" || busy === "probe"}
              />
              <ActionButton
                icon={<KeyRound size={14} />}
                label="重新授权"
                onClick={() => void startAuth()}
                disabled={busy === "auth"}
              />
              {enabled && (
                <ActionButton icon={<LogOut size={14} />} label="断开" onClick={() => void disconnect()} />
              )}
            </div>
          </>
        )}
      </Card>

      {!connected && (
        <Card>
          <div className="mb-1.5 text-[12.5px] text-fg-2">这条路能做什么，代价是什么</div>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-relaxed text-fg-dim">
            <li>
              连上之后能直接读写「我的云文档」：表格按单元格、多维表格按记录，
              还有文档与智能文档 —— 不需要你在 WPS 里预先建任何东西。
            </li>
            <li>
              <strong className="text-fg-2">令牌的权限是整个云文档</strong>，不是一张表。
              所以界面上单独有一次「确认启用」，不按它程序不会用它做任何事。
            </li>
            <li>
              令牌和 client id 与同步密码同等待遇：<strong className="text-fg-2">明文存在本机数据库</strong>里。
              公用电脑上别连；哪天不用了，点「断开」。
            </li>
            <li>只有个人账号能走这条路 —— 企业账号会被服务端拒绝（403）。</li>
          </ul>
        </Card>
      )}
    </div>
  );
}
