#!/usr/bin/env node
/**
 * 给设置页的「同步」分区加 OneDrive。
 *
 * ⚠️ Settings.tsx 是 **CRLF**：多行锚点必须先转 LF 才能匹配。
 * 每处替换都断言"恰好命中 1 次"，少一处就整体中止、不写文件 ——
 * 半套改动比不改更难查。
 */
import fs from 'node:fs';

const FILE = 'src/components/Settings.tsx';

const EDITS = [
  /* 1) 图标：连接 / 断开 */
  [
    `  Cloud,
  Table2,
} from "lucide-react";`,
    `  Cloud,
  Link2,
  LogOut,
  Table2,
} from "lucide-react";`,
  ],

  /* 2) syncClient 的新导出 */
  [
    `import {
  ALL_SHARDS,
  checkConnection,
  formatShards,
  isSyncConfigured,
  persistDeviceId,
  readSyncConfig,
  relativeTime,
  runSync,
  summarizeReport,
  type ShardReport,
  type SyncReport,
} from "../lib/syncClient";`,
    `import {
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
} from "../lib/syncClient";`,
  ],

  /* 3) busy 多一个"等浏览器授权"状态 */
  [
    `  const cfg = readSyncConfig(settings);
  const [busy, setBusy] = useState<"check" | "sync" | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const desktop = isTauri();`,
    `  const cfg = readSyncConfig(settings);
  // \`signin\` 是一个**会等上几分钟**的状态：命令会打开浏览器、然后一直等到
  // 用户在浏览器里登录并同意授权。界面上必须能看出来"在等浏览器"，
  // 否则看起来就像卡死了（这也正是它值得单独一个状态、而不是跟 check 合并的原因）。
  const [busy, setBusy] = useState<"check" | "sync" | "signin" | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const desktop = isTauri();
  const isOneDrive = cfg.provider === "onedrive";`,
  ],

  /* 4) 换后端 + 连接/断开 */
  [
    `  const commit = (key: string) => (v: string) => {
    void saveSettings({ [key]: v });
  };`,
    `  const commit = (key: string) => (v: string) => {
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
  };`,
  ],

  /* 5) 分区说明 */
  [
    `      <SectionTitle
        title="同步"
        desc="用坚果云的 WebDAV 在两台机器之间对齐数据。合并是双向的：两边都改过同一条时，谁后改听谁的。"
      />`,
    `      <SectionTitle
        title="同步"
        desc="在两台机器之间对齐数据。支持坚果云等 WebDAV 服务，也支持 OneDrive。合并是双向的：两边都改过同一条时，谁后改听谁的。"
      />`,
  ],

  /* 6) 演示模式的说明也要覆盖 OneDrive */
  [
    `            当前是浏览器演示模式，同步在这里用不了：演示数据存在 localStorage，跟桌面版的数据库是两套；而且 WebDAV
            要用的 PROPFIND / MKCOL 浏览器自己也发不出去。下面的设置可以先填，到桌面版里再点同步。`,
    `            当前是浏览器演示模式，同步在这里用不了：演示数据存在 localStorage，跟桌面版的数据库是两套；而且 WebDAV
            要用的 PROPFIND / MKCOL 浏览器发不出去，OneDrive 登录要开本地端口收回调，浏览器里同样做不了。
            下面的设置可以先填，到桌面版里再连、再同步。`,
  ],

  /* 7) 后端选择器 + 两个后端的字段互斥显示 */
  [
    `      <Card>
        <div className="space-y-3">
          <TextField
            label="服务器地址"`,
    `      <div className="mb-4">
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
                className={\`max-w-[260px] rounded-lg border px-3 py-2 text-left \${
                  on ? "border-[#378add] bg-card" : "border-line bg-card hover:bg-hover"
                }\`}
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
                    已连接{cfg.onedriveAccount ? \`：\${cfg.onedriveAccount}\` : ""}
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
          </div>
        ) : (
        <div className="space-y-3">
          <TextField
            label="服务器地址"`,
  ],

  /* 8) 关掉上面那个条件渲染 */
  [
    `          <TextField
            label="同步目录"
            value={cfg.dir}
            placeholder="待办工作台"
            onCommit={commit(SETTINGS.syncDir)}
            testId="sync-dir"
            hint="在坚果云根目录下建这个名字的文件夹，留空就直接放根目录。两台机器要填成一样的。"
          />
        </div>
      </Card>`,
    `          <TextField
            label="同步目录"
            value={cfg.dir}
            placeholder="待办工作台"
            onCommit={commit(SETTINGS.syncDir)}
            testId="sync-dir"
            hint="在坚果云根目录下建这个名字的文件夹，留空就直接放根目录。两台机器要填成一样的。"
          />
        </div>
        )}
      </Card>`,
  ],

  /* 9) 没配好时的提示按后端起说 */
  [
    `      {!configured && (
        <p className="mt-2 text-[12px] text-fg-dim">账号和应用密码都填上之后，这两个按钮才会亮。</p>
      )}`,
    `      {!configured && (
        <p className="mt-2 text-[12px] text-fg-dim" data-sync-hint>
          {missingConfigHint(cfg)}。配好之后这两个按钮才会亮。
        </p>
      )}`,
  ],
];

const raw = fs.readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');

let n = 0;
for (const [oldS, newS] of EDITS) {
  n++;
  const count = text.split(oldS).length - 1;
  if (count !== 1) {
    console.error(`✗ 第 ${n} 处替换命中 ${count} 次（要求恰好 1 次），已中止，文件未改`);
    process.exit(1);
  }
  text = text.replace(oldS, newS);
  console.log(`✓ 第 ${n} 处替换完成`);
}

fs.writeFileSync(FILE, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log(`已写回 ${FILE}（${crlf ? 'CRLF' : 'LF'}）`);
