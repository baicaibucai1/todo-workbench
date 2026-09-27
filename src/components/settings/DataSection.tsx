import { SectionTitle, Card, InfoCell, ActionButton } from "./parts";
import {
  Download,
  Upload,
  Trash2,
} from "lucide-react";
import { formatBytes } from "../../lib/attachments";

/* ----------------------------- 分区：数据与备份 ----------------------------- */

export function DataSection({
  dbInfo,
  stats,
  repoUsage,
  repoPath,
  confirmClear,
  setConfirmClear,
  onExport,
  onImport,
  onClear,
}: {
  dbInfo: { driver: "sqlite" | "memory"; location: string; schemaVersion: number } | null;
  stats: { lists: number; tasks: number; done: number } | null;
  repoUsage: { files: number; bytes: number } | null;
  repoPath: string;
  confirmClear: boolean;
  setConfirmClear: (v: boolean) => void;
  onExport: () => void;
  onImport: () => void;
  onClear: () => void;
}) {
  return (
    <div className="max-w-[560px]">
      <SectionTitle
        title="数据与备份"
        desc="数据全部存在本机。导出一份 JSON，换机器或重装后可以直接导回来。"
      />

      <Card>
        <div className="grid grid-cols-2 gap-y-2.5 text-[13px]">
          <InfoCell label="数据库" value={dbInfo?.driver === "sqlite" ? "SQLite" : "内存库（演示）"} />
          <InfoCell label="Schema 版本" value={`v${dbInfo?.schemaVersion ?? "-"}`} />
          <InfoCell label="列表数" value={stats ? String(stats.lists) : "…"} />
          <InfoCell
            label="任务数"
            value={stats ? `${stats.tasks}（已完成 ${stats.done}）` : "…"}
          />
        </div>
        <div className="mt-3 border-t border-line pt-3">
          <div className="text-[12px] text-fg-dim">存储位置</div>
          <div className="mt-0.5 break-all text-[12.5px] text-fg-2">
            {dbInfo?.location ?? "-"}
          </div>
        </div>
        {/* 附件仓库单独列一段：它和数据库是两个地方，占了磁盘大头的是它。
            不写清楚的话，用户看到"数据都在这"，换机器时只会拷数据库文件。 */}
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <div className="text-[12px] text-fg-dim">附件仓库（图片与视频的原文件）</div>
            <div className="text-[12.5px] text-fg-2" data-repo-usage={repoUsage ? repoUsage.files : ""}>
              {repoUsage ? `${repoUsage.files} 个文件 · ${formatBytes(repoUsage.bytes)}` : "…"}
            </div>
          </div>
          <div className="mt-0.5 break-all text-[12.5px] text-fg-2">{repoPath || "-"}</div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-fg-dim">
            备份里只有附件的记录，不含文件本体。要连文件一起搬，手动拷贝上面这个目录。
          </div>
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton icon={<Download size={14} />} label="导出备份" onClick={onExport} />
        <ActionButton
          icon={<Upload size={14} />}
          label="导入备份"
          onClick={onImport}
          data-act="import"
        />
      </div>
      <p className="mt-2 text-[12px] text-fg-dim">
        导入是覆盖式的：先清空现有数据，再写入备份内容。
      </p>

      <div className="mt-6">
        <div className="mb-2 text-[13px] font-medium text-fg">清空数据</div>
        {confirmClear ? (
          <div className="rounded-lg border border-danger/30 bg-danger-soft p-3">
            <div className="text-[13px] text-danger">
              将删除全部列表、任务、流程任务与配置，并清掉附件仓库里的文件，且无法撤销。确定继续？
            </div>
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={onClear}
                data-act="confirm-clear"
                className="rounded-md bg-danger px-3 py-1.5 text-[13px] text-white hover:opacity-90"
              >
                确认清空
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="rounded-md border border-line bg-card px-3 py-1.5 text-[13px] text-fg-3"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            data-act="clear"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-danger hover:bg-danger-soft"
          >
            <Trash2 size={14} />
            清空全部数据
          </button>
        )}
      </div>
    </div>
  );
}
