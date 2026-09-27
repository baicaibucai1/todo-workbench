import { SectionTitle, Card, TextField, ActionButton } from "./parts";
import type { Flash } from "./parts";
import { useState } from "react";
import {
  Check,
  RefreshCw,
  AlertTriangle,
  Link2,
  LogOut,
} from "lucide-react";
import { isTauri } from "../../lib/db";
import { SETTINGS } from "../../lib/settings";
import {
  ALL_SHARDS,
  checkConnection,
  formatShards,
  isSyncConfigured,
  missingConfigHint,
  persistDeviceId,
  providerLabel,
  readSyncConfig,
  relativeTime,
  runSync,
  signInOneDrive,
  signOutOneDrive,
  summarizeReport,
  SYNC_PROVIDERS,
  type ShardReport,
  type SyncProvider,
  type SyncReport,
} from "../../lib/syncClient";
import {
  SHARD_LABELS,
  type SyncShardId,
} from "../../lib/sync";

/* -------------------------------- 分区：同步 -------------------------------- */

/**
 * 坚果云（WebDAV）同步。
 *
 * 三条硬规则写在这里，免得以后被"顺手改掉"：
 *  1. `dir` 下的每个分片是一个独立 JSON，**按分片各自合并**，不是整库覆盖；
 *  2. 文件本体（图片/视频）永远不上传，只走记录 —— 同步几十 MB 的原文件
 *     对着坚果云的小水管是灾难，而且它本来就是个网盘，用户自己会同步；
 *  3. 设置**完全不进同步**：设备名、主题、工具开关这些是"本机的事"，
 *     两台机器对着改会互相覆盖，而且没有任何一方是"对的"。
 */

const SHARD_HINTS: Record<SyncShardId, string> = {
  tasks: "列表、待办、子任务，以及待办之间的关联关系",
  orders: "流程模板、流程任务、自定义字段与操作记录",
  gallery: "图库记录（不含图片、视频文件本体）",
  attachments: "流程任务附件的记录（不含文件本体）",
};

export function SyncSection({
  settings,
  saveSettings,
  say,
  refresh,
}: {
  settings: Record<string, string>;
  saveSettings: (patch: Record<string, string>) => Promise<void>;
  say: (text: string, tone?: Flash["tone"]) => void;
  refresh: () => Promise<void>;
}) {
  const cfg = readSyncConfig(settings);
  // `signin` 是一个**会等上几分钟**的状态：命令会打开浏览器、然后一直等到
  // 用户在浏览器里登录并同意授权。界面上必须能看出来"在等浏览器"，
  // 否则看起来就像卡死了（这也正是它值得单独一个状态、而不是跟 check 合并的原因）。
  const [busy, setBusy] = useState<"check" | "sync" | "signin" | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const desktop = isTauri();
  const isOneDrive = cfg.provider === "onedrive";

  const lastAt = settings[SETTINGS.syncLastAt] ?? "";
  const lastSummary = settings[SETTINGS.syncLastSummary] ?? "";
  const configured = isSyncConfigured(cfg);

  const commit = (key: string) => (v: string) => {
    void saveSettings({ [key]: v });
  };

  // 换后端**不清空另一边的配置**：来回切换的成本必须为零。
  // 否则"先试一下 OneDrive"就变成一次要重新填账号密码的操作，
  // 用户会在犹豫里干脆不试。
  const pickProvider = (id: SyncProvider) => {
    if (id === cfg.provider) return;
    void saveSettings({ [SETTINGS.syncProvider]: id });
  };

  const doSignIn = async () => {
    setBusy("signin");
    try {
      // 先说一句"去看浏览器"，再等 —— 这个调用可能几分钟才返回
      say("已打开浏览器，请在浏览器里用微软账号登录并同意授权…");
      say(await signInOneDrive(cfg));
      await refresh();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const doSignOut = async () => {
    await signOutOneDrive();
    say("已断开 OneDrive。云端那份数据没删，重新连接后还能取回来。");
    await refresh();
  };

  // 一个分片都不勾 = 按了"立即同步"却什么都不发生，那是界面上最难解释的一种状态。
  // 所以取消最后一个时直接拦住，而不是静默回落到默认值。
  const toggleShard = (id: SyncShardId) => {
    const next = cfg.shards.includes(id)
      ? cfg.shards.filter((x) => x !== id)
      : [...cfg.shards, id];
    if (!next.length) {
      say("至少要同步一类内容", "err");
      return;
    }
    void saveSettings({ [SETTINGS.syncShards]: formatShards(next) });
  };

  const doCheck = async () => {
    setBusy("check");
    try {
      await persistDeviceId(cfg);
      say(await checkConnection(cfg));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const doSync = async () => {
    setBusy("sync");
    setReport(null);
    try {
      await persistDeviceId(cfg);
      const r = await runSync(cfg);
      setReport(r);
      await refresh();
      if (r.okCount === 0) {
        say(r.shards.find((x) => x.error)?.error ?? "同步失败", "err");
      } else if (r.failCount) {
        // 一部分成功就**不回滚**：成功的分片各自已经是完整状态，回滚反而丢东西
        say(`同步完成：${summarizeReport(r)}`, "err");
      } else {
        say(`同步完成：${summarizeReport(r)}`);
      }
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-[560px]">
      <SectionTitle
        title="同步"
        desc="在两台机器之间对齐数据。支持坚果云等 WebDAV 服务，也支持 OneDrive。合并是双向的：两边都改过同一条时，谁后改听谁的。"
      />

      {!desktop && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <div className="text-[12px] leading-relaxed text-danger">
            当前是浏览器演示模式，同步在这里用不了：演示数据存在 localStorage，跟桌面版的数据库是两套；而且 WebDAV
            要用的 PROPFIND / MKCOL 浏览器发不出去，OneDrive 登录要开本地端口收回调，浏览器里同样做不了。
            下面的设置可以先填，到桌面版里再连、再同步。
          </div>
        </div>
      )}

      <div className="mb-4">
        <div className="mb-2 text-[13px] font-medium text-fg">同步到哪</div>
        <div className="flex flex-wrap gap-2">
          {SYNC_PROVIDERS.map((p) => {
            const on = cfg.provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() => pickProvider(p.id)}
                aria-pressed={on}
                data-sync-provider={p.id}
                data-on={on ? "1" : "0"}
                className={`max-w-[260px] rounded-lg border px-3 py-2 text-left ${
                  on ? "border-primary bg-card" : "border-line bg-card hover:bg-hover"
                }`}
              >
                <span className="block text-[13px] text-fg-2">{p.label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-dim">{p.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Card>
        {isOneDrive ? (
          <div className="space-y-3" data-sync-onedrive>
            <TextField
              label="Azure 客户端 ID"
              value={cfg.onedriveClientId}
              placeholder="在 Azure 应用注册的「概述」页复制"
              onCommit={commit(SETTINGS.onedriveClientId)}
              testId="onedrive-client"
              hint="公共客户端的 client_id 不是密钥，写错只会连不上，不会泄露别的东西。"
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {cfg.onedriveRefreshToken ? (
                <>
                  <span className="text-[12.5px] text-fg-2" data-onedrive-account>
                    已连接{cfg.onedriveAccount ? `：${cfg.onedriveAccount}` : ""}
                  </span>
                  <ActionButton
                    icon={<LogOut size={14} />}
                    label="断开"
                    onClick={() => void doSignOut()}
                    disabled={busy !== null}
                    data-onedrive-signout
                  />
                </>
              ) : (
                <ActionButton
                  icon={<Link2 size={14} />}
                  label={busy === "signin" ? "等待浏览器授权…" : "连接 OneDrive"}
                  onClick={() => void doSignIn()}
                  disabled={!desktop || !cfg.onedriveClientId || busy !== null}
                  data-onedrive-signin
                />
              )}
            </div>
            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              数据放在 OneDrive 的「应用」文件夹里（路径形如 Apps/待办工作台），网页版默认不显示它 ——
              这是正常的，那个文件夹只有这个应用看得到。首次同步时会自动建出来。
            </p>
            <details className="rounded-lg border border-line px-3 py-2.5" data-onedrive-guide>
              <summary className="cursor-pointer text-[12.5px] text-fg-2">
                怎么拿这个 ID？（注册一个 Azure 应用，约 5 分钟，免费）
              </summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11.5px] leading-relaxed text-fg-dim">
                <li>
                  打开 portal.azure.com 并用<b>要同步的那个微软账号</b>登录 → Microsoft Entra ID →
                  应用注册 → 新注册
                </li>
                <li>名称填「待办工作台」——它会变成 OneDrive 里那个文件夹的名字</li>
                <li>支持的帐户类型选「任何组织目录中的帐户和个人 Microsoft 帐户」</li>
                <li>
                  重定向 URI 的平台选「移动和桌面应用程序」，再勾选 http://localhost（列表里有这一项）
                  —— 勾了它就不必为端口操心，应用每次用随机端口都合法
                </li>
                <li>注册完在「概述」页复制「应用程序(客户端) ID」，填到上面那个框里</li>
                <li>
                  API 权限 → 添加权限 → Microsoft Graph → <b>委托的权限</b>，勾这四项：
                  Files.ReadWrite.AppFolder、offline_access、openid、profile
                </li>
                <li>
                  身份验证 → 拉到最下面 → 把「允许公共客户端流」改成「是」并保存
                  （漏了这一步，登录会报 unauthorized_client）
                </li>
              </ol>
            </details>
          </div>
        ) : (
        <div className="space-y-3">
          <TextField
            label="服务器地址"
            value={cfg.baseUrl}
            placeholder="https://dav.jianguoyun.com/dav"
            onCommit={commit(SETTINGS.syncBaseUrl)}
            testId="sync-base"
          />
          <TextField
            label="账号（坚果云登录邮箱）"
            value={cfg.username}
            placeholder="you@example.com"
            onCommit={commit(SETTINGS.syncUsername)}
            testId="sync-user"
          />
          <TextField
            label="应用密码"
            value={cfg.password}
            type="password"
            placeholder="在坚果云「安全选项 → 添加应用」里生成"
            onCommit={commit(SETTINGS.syncPassword)}
            testId="sync-pass"
            hint="不是登录密码。坚果云需要单独生成一个应用密码给第三方程序用，生成后只显示一次，记下来。"
          />
          <TextField
            label="同步目录"
            value={cfg.dir}
            placeholder="待办工作台"
            onCommit={commit(SETTINGS.syncDir)}
            testId="sync-dir"
            hint="在坚果云根目录下建这个名字的文件夹，留空就直接放根目录。两台机器要填成一样的。"
          />
        </div>
        )}
      </Card>

      <div className="mt-5">
        <div className="mb-2 text-[13px] font-medium text-fg">同步内容</div>
        <div className="space-y-2">
          {ALL_SHARDS.map((id) => {
            const on = cfg.shards.includes(id);
            return (
              <button
                key={id}
                onClick={() => toggleShard(id)}
                role="switch"
                aria-checked={on}
                data-sync-shard={id}
                data-on={on ? "1" : "0"}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2.5 text-left hover:bg-hover"
              >
                <span className="min-w-0">
                  <span className="block text-[13px] text-fg-2">{SHARD_LABELS[id]}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-dim">
                    {SHARD_HINTS[id]}
                  </span>
                </span>
                <span
                  className="flex size-[18px] shrink-0 items-center justify-center rounded border"
                  style={{
                    borderColor: on ? "var(--color-primary)" : "var(--color-line)",
                    background: on ? "var(--color-primary)" : "transparent",
                  }}
                >
                  {on && <Check size={12} className="text-white" />}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">
          默认只同步待办。图库和附件都只同步「记录」，图片、视频的原文件不会上传 ——
          那些按目录各同步各的就行。设置项本身不参与同步。
        </p>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[13px] font-medium text-fg">这台设备</div>
        <Card>
          <TextField
            label="设备名"
            value={cfg.deviceName}
            placeholder="书房台式机"
            onCommit={commit(SETTINGS.syncDeviceName)}
            testId="sync-device"
            hint="只用来在同步结果里区分「这份是谁写的」，两台机器最好不一样。"
          />
          <div className="mt-3 border-t border-line pt-3" data-sync-last={lastAt}>
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="text-fg-dim">上次同步</span>
              <span className="text-fg-2" data-sync-last-text>
                {relativeTime(lastAt)}
              </span>
            </div>
            {lastSummary && (
              <div className="mt-0.5 text-[11.5px] text-fg-dim" data-sync-last-summary>
                {lastSummary}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton
          icon={<Check size={14} />}
          label={busy === "check" ? "测试中…" : "测试连接"}
          onClick={() => void doCheck()}
          disabled={!desktop || !configured || busy !== null}
          data-sync-test
        />
        <ActionButton
          icon={<RefreshCw size={14} className={busy === "sync" ? "animate-spin" : ""} />}
          label={busy === "sync" ? "同步中…" : "立即同步"}
          onClick={() => void doSync()}
          disabled={!desktop || !configured || busy !== null}
          data-sync-now
        />
      </div>
      {!configured && (
        <p className="mt-2 text-[12px] text-fg-dim" data-sync-hint>
          {missingConfigHint(cfg)}。配好之后这两个按钮才会亮。
        </p>
      )}

      {report && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] font-medium text-fg">本次结果 · {providerLabel(cfg.provider)}</div>
          <Card>
            <div className="space-y-1.5">
              {report.shards.map((r) => (
                <SyncShardLine key={r.shard} r={r} />
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function SyncShardLine({ r }: { r: ShardReport }) {
  const bits: string[] = [];
  if (!r.error) {
    if (!r.hadRemote) bits.push("首次上传");
    if (r.stats.added) bits.push(`取回 ${r.stats.added}`);
    if (r.stats.updated) bits.push(`更新 ${r.stats.updated}`);
    if (r.stats.pushed) bits.push(`上传 ${r.stats.pushed}`);
    if (!bits.length) bits.push("无变化");
  }
  return (
    <div
      className="flex items-start justify-between gap-3 text-[12.5px]"
      data-sync-line={r.shard}
      data-sync-error={r.error ? "1" : "0"}
    >
      <span className="shrink-0 text-fg-2">{SHARD_LABELS[r.shard]}</span>
      <span className="min-w-0 break-all text-right text-fg-dim">{r.error ?? bits.join(" · ")}</span>
    </div>
  );
}
