/**
 * 一次性脚本：给设置页加「同步」分区。
 *
 * Settings.tsx 是 CRLF，所以一律「读进来转 LF → 匹配 → 写回去转 CRLF」，
 * 否则多行 old-string 一条都命不中。
 */
import fs from "node:fs";

const FILE = "src/components/Settings.tsx";
const raw = fs.readFileSync(FILE, "utf8");
const crlf = raw.includes("\r\n");
let s = raw.replace(/\r\n/g, "\n");

const edits = [];
function rep(name, oldStr, newStr, expect = 1) {
  const hits = s.split(oldStr).length - 1;
  if (hits !== expect) {
    edits.push(`✗ ${name}：期望 ${expect} 次，命中 ${hits} 次`);
    return false;
  }
  s = s.replace(oldStr, newStr);
  edits.push(`✓ ${name}（${hits} 次）`);
  return true;
}

/* ---------------- 1. 文件头注释 ---------------- */

rep(
  "头注释分区清单",
  ` * 六个分区：个人资料 / 外观 / 工具 / 数据与备份 / 行为偏好 / 关于与更新。`,
  ` * 八个分区：个人资料 / 外观 / 工具 / 数据库 / 数据与备份 / 同步 / 行为偏好 / 关于与更新。`,
);

/* ---------------- 2. lucide 图标 ---------------- */

rep(
  "lucide 加 Cloud",
  `  Save,\n  Table2,\n} from "lucide-react";`,
  `  Save,\n  Cloud,\n  Table2,\n} from "lucide-react";`,
);

/* ---------------- 3. 同步模块导入 ---------------- */

rep(
  "导入 syncClient",
  `} from "../lib/wallpapers";\n`,
  `} from "../lib/wallpapers";
import {
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
} from "../lib/syncClient";
import { SHARD_LABELS, type SyncShardId } from "../lib/sync";
`,
);

/* ---------------- 4. NAV ---------------- */

rep(
  "NAV 加同步",
  `  { key: "data", label: "数据与备份", icon: Save },\n  { key: "behavior", label: "行为偏好", icon: SlidersHorizontal },`,
  `  { key: "data", label: "数据与备份", icon: Save },\n  { key: "sync", label: "同步", icon: Cloud },\n  { key: "behavior", label: "行为偏好", icon: SlidersHorizontal },`,
);

/* ---------------- 5. 分区渲染 ---------------- */

rep(
  "渲染同步分区",
  `              onClear={() => void doClear()}\n            />\n          )}\n          {section === "behavior" && (`,
  `              onClear={() => void doClear()}\n            />\n          )}\n          {section === "sync" && (\n            <SyncSection\n              settings={settings}\n              saveSettings={saveSettings}\n              say={say}\n              refresh={refresh}\n            />\n          )}\n          {section === "behavior" && (`,
);

/* ---------------- 6. TextField 支持 type / testId / hint ---------------- */

rep(
  "TextField 签名",
  `function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {`,
  `function TextField({
  label,
  value,
  placeholder,
  onCommit,
  testId,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  testId?: string;
  type?: string;
  hint?: string;
}) {`,
);

rep(
  "TextField input 属性",
  `      <input
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}`,
  `      <input
        value={v}
        type={type}
        placeholder={placeholder}
        data-field={testId}
        onChange={(e) => setV(e.target.value)}`,
);

rep(
  "TextField 尾部提示",
  `        className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
      />
    </label>
  );
}`,
  `        className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-[#378add]"
      />
      {hint && <span className="mt-1 block text-[11.5px] leading-relaxed text-fg-dim">{hint}</span>}
    </label>
  );
}`,
);

/* ---------------- 7. SyncSection 组件 ---------------- */

const SYNC_SECTION = `/* -------------------------------- 分区：同步 -------------------------------- */

/**
 * 坚果云（WebDAV）同步。
 *
 * 三条硬规则写在这里，免得以后被"顺手改掉"：
 *  1. \`dir\` 下的每个分片是一个独立 JSON，**按分片各自合并**，不是整库覆盖；
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

function SyncSection({
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
  const [busy, setBusy] = useState<"check" | "sync" | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const desktop = isTauri();

  const lastAt = settings[SETTINGS.syncLastAt] ?? "";
  const lastSummary = settings[SETTINGS.syncLastSummary] ?? "";
  const configured = isSyncConfigured(cfg);

  const commit = (key: string) => (v: string) => {
    void saveSettings({ [key]: v });
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
        say(\`同步完成：\${summarizeReport(r)}\`, "err");
      } else {
        say(\`同步完成：\${summarizeReport(r)}\`);
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
        desc="用坚果云的 WebDAV 在两台机器之间对齐数据。合并是双向的：两边都改过同一条时，谁后改听谁的。"
      />

      {!desktop && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-[#a32d2d]/30 bg-danger-soft px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <div className="text-[12px] leading-relaxed text-danger">
            当前是浏览器演示模式，同步在这里用不了：演示数据存在 localStorage，跟桌面版的数据库是两套；而且 WebDAV
            要用的 PROPFIND / MKCOL 浏览器自己也发不出去。下面的设置可以先填，到桌面版里再点同步。
          </div>
        </div>
      )}

      <Card>
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
                    borderColor: on ? "#378add" : "var(--color-line)",
                    background: on ? "#378add" : "transparent",
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
        <p className="mt-2 text-[12px] text-fg-dim">账号和应用密码都填上之后，这两个按钮才会亮。</p>
      )}

      {report && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] font-medium text-fg">本次结果</div>
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
    if (r.stats.added) bits.push(\`取回 \${r.stats.added}\`);
    if (r.stats.updated) bits.push(\`更新 \${r.stats.updated}\`);
    if (r.stats.pushed) bits.push(\`上传 \${r.stats.pushed}\`);
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

`;

rep(
  "插入 SyncSection",
  `/* -------------------------------- 通用零件 -------------------------------- */`,
  SYNC_SECTION + `/* -------------------------------- 通用零件 -------------------------------- */`,
);

/* ---------------- 收尾 ---------------- */

const stale = s.split("\n").filter((l) => /^\s{2}(Cloud|Table2),$/.test(l));
console.log(edits.join("\n"));
console.log("Cloud/Table2 行数检查：", stale.length);

const out = crlf ? s.replace(/\n/g, "\r\n") : s;
fs.writeFileSync(FILE, out);
console.log(`已写入 ${FILE}（CRLF=${crlf}，${out.length} 字节）`);
