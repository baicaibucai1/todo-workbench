import { SectionTitle, Card, TextField, ActionButton } from "./parts";
import type { Flash } from "./parts";
import { useEffect, useState } from "react";
import { Download, ExternalLink, KeyRound, Table2 } from "lucide-react";
import { SETTINGS } from "../../lib/settings";
import {
  buildAuthUrl,
  defaultRedirectUri,
  exchangeCode,
  fetchAllRecords,
  fetchProfile,
  fieldNamesOf,
  missingConfigHint,
  readKdocsConfig,
  readKdocsToken,
  refreshToken,
  tokenLooksFresh,
} from "../../lib/kdocs";

/* ---------------------------- 分区：WPS 表格联动 ---------------------------- */

/**
 * 把异常单台账接到金山文档的**智能表格**上。
 *
 * 现阶段只做**只读打通**：授权 → 拉一次 → 看清楚对面表里有哪些列、值长什么样。
 * 之所以不一步到位写回去：字段映射没看清就写，最容易把用户的台账写花 ——
 * 而表格那边的撤销历史又不如数据库好追。先把数据摊开看一眼，再动笔。
 *
 * 两条说明必须摆在界面上（不是藏在 tooltip 里）：
 *  1. 应用密钥**明文存在本机**，跟同步密码一个待遇；
 *  2. 测试应用每天 500 次脚本 / 1 万次记录查询，手动点着用绰绰有余，
 *     但别设成几秒一次的自动轮询。
 */

const STATE_KEY = "wb:kdocs:oauth-state";

type Preview = {
  count: number;
  fields: string[];
  sample: Record<string, unknown>[];
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
  const cfg = readKdocsConfig(settings);
  const tok = readKdocsToken(settings);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"auth" | "pull" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const missing = missingConfigHint(cfg);
  const connected = !!tok.refreshToken;
  const expiryText = tok.expiry ? new Date(tok.expiry).toLocaleString("zh-CN") : "";

  // 授权跳回来时（回调地址 = 本站 /oauth/kdocs）自动接住 code。
  // 这不是主路径 —— 桌面端与生产构建没有固定回调，手动粘贴那格才是兜底。
  useEffect(() => {
    const u = new URL(globalThis.location.href);
    if (!u.pathname.endsWith("/oauth/kdocs")) return;
    const c = u.searchParams.get("code") ?? "";
    globalThis.history.replaceState({}, "", "/");
    if (!c) return;
    setCode(c);
    void submitCode(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startAuth = () => {
    if (!cfg.appId) {
      say("先填应用 ID（AppID）再授权", "err");
      return;
    }
    const state = String(Date.now());
    try {
      globalThis.localStorage.setItem(STATE_KEY, state);
    } catch {
      /* 无痕模式下存不了就算了，state 只是防串号 */
    }
    globalThis.open(
      buildAuthUrl(cfg, defaultRedirectUri(), state),
      "_blank",
      "noopener,noreferrer",
    );
    say("已打开授权页 —— 同意后把跳转过去那个网址里的 code 粘到下面（它只活 5 分钟）");
  };

  async function submitCode(raw: string) {
    const c = raw.trim();
    if (!c) {
      say("先把授权码粘进来", "err");
      return;
    }
    if (!cfg.appId || !cfg.appKey) {
      say("还差应用 ID 或应用密钥", "err");
      return;
    }
    setBusy("auth");
    try {
      const got = await exchangeCode(cfg, c);
      const account = await fetchProfile(got.accessToken);
      await saveSettings({
        [SETTINGS.kdocsAccessToken]: got.accessToken,
        [SETTINGS.kdocsRefreshToken]: got.refreshToken,
        [SETTINGS.kdocsTokenExpiry]: String(Date.now() + got.expiresIn * 1000),
        [SETTINGS.kdocsAccount]: account,
      });
      setCode("");
      say(account ? `已连接为 ${account}` : "已连接金山文档");
    } catch (err) {
      say(`授权没成：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /** 拿一个能用的短期令牌：快过期就先续，续不动就让用户重新授权 */
  async function freshToken(): Promise<string> {
    if (tokenLooksFresh(tok)) return tok.accessToken;
    if (!tok.refreshToken) throw new Error("还没授权 —— 先点「去授权」");
    const got = await refreshToken(cfg, tok.refreshToken);
    await saveSettings({
      [SETTINGS.kdocsAccessToken]: got.accessToken,
      [SETTINGS.kdocsRefreshToken]: got.refreshToken,
      [SETTINGS.kdocsTokenExpiry]: String(Date.now() + got.expiresIn * 1000),
    });
    return got.accessToken;
  }

  const pull = async () => {
    if (missing) {
      say(missing, "err");
      return;
    }
    setBusy("pull");
    try {
      const token = await freshToken();
      const records = await fetchAllRecords(cfg, token);
      const fields = fieldNamesOf(records);
      setPreview({
        count: records.length,
        fields,
        sample: records.slice(0, 3).map((r) => r.fields),
      });
      await saveSettings({
        [SETTINGS.kdocsLastAt]: String(Date.now()),
        [SETTINGS.kdocsLastSummary]: `${records.length} 条 / ${fields.length} 列`,
      });
      say(`拉到 ${records.length} 条记录，${fields.length} 个字段`);
    } catch (err) {
      say(`没拉到：${(err as Error).message}`, "err");
    } finally {
      setBusy(null);
    }
  };

  const commit = (key: string) => (v: string) => {
    void saveSettings({ [key]: v });
  };

  return (
    <div className="space-y-3">
      <SectionTitle
        title="WPS 表格联动"
        desc="把异常单台账接到金山文档的智能表格上。现在只拉不写 —— 先看清楚对面有哪些列，再决定怎么对。"
      />

      <Card>
        <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-2">
          <Table2 size={14} />
          表格在哪
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <TextField label="应用 ID（AppID）" value={cfg.appId} onCommit={commit(SETTINGS.kdocsAppId)} placeholder="SX2022…" />
          <TextField
            label="应用密钥（AppKey）"
            value={cfg.appKey}
            onCommit={commit(SETTINGS.kdocsAppKey)}
            placeholder="在开放平台后台拿"
            hint="明文存在本机数据库里，没有加密 —— 和同步密码一个待遇。别在公用电脑上填。"
          />
          <TextField
            label="表格文档 ID（file_token）"
            value={cfg.fileToken}
            onCommit={commit(SETTINGS.kdocsFileToken)}
            placeholder="G_xvUro…"
            hint="不是分享链接里 /l/ 后面那串 —— 要在金山文档里打开表格，从网址里取文档 ID。"
          />
          <TextField
            label="工作表 ID"
            value={cfg.sheetId}
            onCommit={commit(SETTINGS.kdocsSheetId)}
            placeholder="1"
            hint="新建的智能表格一般是 1。"
          />
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-2">
          <KeyRound size={14} />
          授权
          {connected && (
            <span className="ml-1 text-[12px] text-fg-dim">
              已连接{tok.account ? `为 ${tok.account}` : ""}
              {expiryText ? ` · 令牌用到 ${expiryText}` : ""}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[220px]">
            <span className="mb-1 block text-[12px] text-fg-dim">授权码（code）</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="授权跳转后，网址里 code= 后面那串"
              className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-primary"
            />
          </label>
          <ActionButton
            icon={<ExternalLink size={14} />}
            label="去授权"
            onClick={startAuth}
            disabled={busy === "auth"}
          />
          <ActionButton
            icon={<KeyRound size={14} />}
            label="用这个授权码连接"
            onClick={() => void submitCode(code)}
            disabled={busy === "auth" || !code.trim()}
          />
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
          回调地址要在开放平台后台登记成 <code>http://127.0.0.1:1420/oauth/kdocs</code>。
          登记不了也没关系 —— 手动把 code 粘进来一样能连。长期令牌管 90 天，到期再点一次。
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-2">
          <Download size={14} />
          拉取
          {settings[SETTINGS.kdocsLastAt] && (
            <span className="ml-1 text-[12px] text-fg-dim">
              上次：{new Date(Number(settings[SETTINGS.kdocsLastAt])).toLocaleString("zh-CN")}
              {settings[SETTINGS.kdocsLastSummary] ? ` · ${settings[SETTINGS.kdocsLastSummary]}` : ""}
            </span>
          )}
        </div>
        <ActionButton
          icon={<Download size={14} />}
          label={busy === "pull" ? "拉取中…" : "拉取一次"}
          onClick={() => void pull()}
          disabled={busy === "pull"}
        />
        {preview && (
          <div className="mt-3 space-y-2">
            <div className="text-[12.5px] text-fg-2">
              共 <b>{preview.count}</b> 条，字段：
            </div>
            <div className="flex flex-wrap gap-1.5">
              {preview.fields.map((f) => (
                <span
                  key={f}
                  className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-fg-dim"
                >
                  {f}
                </span>
              ))}
              {!preview.fields.length && (
                <span className="text-[12px] text-fg-dim">（一张空表 —— 还没有任何字段）</span>
              )}
            </div>
            {!!preview.sample.length && (
              <pre className="max-h-52 overflow-auto rounded-lg border border-line bg-card p-2 text-[11.5px] leading-relaxed text-fg-dim">
                {JSON.stringify(preview.sample, null, 2)}
              </pre>
            )}
          </div>
        )}
        <p className="mt-2 text-[11.5px] leading-relaxed text-fg-dim">
          测试应用每天 1 万次记录查询，手动点着用完全够。别设成几秒一次自动拉 ——
          一是撞限流，二是拉回来的数据现在还没地方落，看一眼就够了。
        </p>
      </Card>
    </div>
  );
}
