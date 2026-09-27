import { SectionTitle, Card, InfoCell } from "./parts";
import type { Flash } from "./parts";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Trash2,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Table2,
} from "lucide-react";
import { useStore } from "../../store";
import {
  inspectDatabases,
  inspectTable,
  type DbOverview,
  type NamespaceStat,
} from "../../lib/dbInspect";
import { dropToolNamespace } from "../../lib/toolSchema";
import { postToTool } from "../../lib/toolLink";
import { HOST_SOURCE } from "../../lib/toolBridge";

/* ------------------------------ 分区：数据库 ------------------------------ */

/**
 * 数据库分区。
 *
 * 放在设置里而不是藏在某个按钮后面，是因为**工具的数据本来就属于用户**：
 * 他装了个工具、存了三个月记录、然后卸了 —— 那些数据在哪儿、能不能删，
 * 得由他自己能看见、能决定，而不是取决于某个工具作者实现了没有。
 */
export function DatabaseSection({ say }: { say: (text: string, tone?: Flash["tone"]) => void }) {
  const tools = useStore((s) => s.tools);
  const [overview, setOverview] = useState<DbOverview | null>(null);
  const [busy, setBusy] = useState(true);
  /** 展开的命名空间 id */
  const [openId, setOpenId] = useState<string | null>("core");
  /** 正在预览的表 */
  const [preview, setPreview] = useState<{
    name: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
    total: number;
  } | null>(null);
  /** 等待二次确认的清理目标 */
  const [wipe, setWipe] = useState<NamespaceStat | null>(null);

  // say 是父组件每次渲染新建的函数。直接把它写进依赖数组的话，
  // setState 引起重渲染 -> 依赖变了 -> effect 重跑 -> 又 setState，
  // 形成一个不停扫全表的循环（设置页会一直在"正在读取"之间闪）。
  // 用 ref 接住它，依赖就只剩真正会变的 tools。
  const sayRef = useRef(say);
  sayRef.current = say;

  // 只在切进这个分区时扫一次。每个命名空间逐表 COUNT，
  // 每次渲染都扫的话设置页会明显卡一下。
  useEffect(() => {
    let alive = true;
    setBusy(true);
    void inspectDatabases(tools)
      .then((o) => {
        if (alive) setOverview(o);
      })
      .catch((err) => {
        // 体检失败不该让整个设置页白屏：说出原因，别的分区还能用
        if (alive) sayRef.current(`读取数据库失败：${err instanceof Error ? err.message : String(err)}`, "err");
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [tools]);

  const openTable = async (name: string) => {
    try {
      const r = await inspectTable(name, 50);
      setPreview({ name, ...r });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), "err");
    }
  };

  const doWipe = async (ns: NamespaceStat) => {
    try {
      const r = await dropToolNamespace(ns.id);
      setWipe(null);
      setPreview(null);
      // 这个工具要是正开着，它手上的表刚刚被删掉了 ——
      // 通知挂载层重跑一次建表，否则它会一直撞"表不存在"
      useStore.getState().bustToolSchema(ns.id);

      // 再给工具本身发一件事，让它自己重新拉一次列表。
      // 少了这一步，界面上还摆着被删掉的那两行，用户会以为清理没生效 ——
      // 而数据库里其实已经空了，两种真相对不上是最容易让人怀疑数据丢了的场景。
      postToTool(ns.id, {
        source: HOST_SOURCE,
        type: "tool:event",
        event: "schema:reset",
        data: { toolId: ns.id },
      });
      const fresh = await inspectDatabases(tools);
      setOverview(fresh);
      say(
        r.tables.length
          ? `已清理 ${r.tables.length} 张表（${r.rows} 行）与 ${r.kvRows} 条配置`
          : `已清理 ${r.kvRows} 条工具配置`,
      );
    } catch (err) {
      say(`清理失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
  };

  return (
    <div className="max-w-[620px]" data-db-section="">
      <SectionTitle
        title="数据库"
        desc="工作台只有一个数据库文件。宿主与每个工具在里面各占一段命名空间 —— 前缀 core_ 的是工作台自己的，tool_<工具 id>_ 的是某个工具私有的。"
      />

      <Card>
        <div className="grid grid-cols-2 gap-y-2.5 text-[13px]">
          <InfoCell
            label="驱动"
            value={overview?.driver === "sqlite" ? "SQLite" : "内存库（演示）"}
          />
          <InfoCell label="Schema 版本" value={`v${overview?.schemaVersion ?? "-"}`} />
          <InfoCell label="表数量" value={overview ? String(overview.tableCount) : "…"} />
          <InfoCell label="总行数" value={overview ? overview.rowCount.toLocaleString() : "…"} />
        </div>
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-center gap-1.5 text-[11.5px] text-fg-dim">
            <HardDrive size={12} />
            文件位置
          </div>
          <div className="mt-0.5 break-all text-[12.5px] text-fg-2" data-db-location="">
            {overview?.location ?? "-"}
          </div>
        </div>
      </Card>

      {busy && <div className="mt-4 text-[13px] text-fg-dim">正在读取各个命名空间…</div>}

      {overview && (
        <div className="mt-4 space-y-2">
          {overview.namespaces.map((ns) => (
            <NamespaceCard
              key={ns.id}
              ns={ns}
              open={openId === ns.id}
              previewName={preview?.name ?? null}
              onToggle={() => {
                setPreview(null);
                setOpenId(openId === ns.id ? null : ns.id);
              }}
              onOpenTable={(name) => void openTable(name)}
              onWipe={() => setWipe(ns)}
            />
          ))}
        </div>
      )}

      {preview && (
        <div className="mt-4" data-table-preview={preview.name}>
          <div className="mb-1.5 flex items-center gap-2">
            <Table2 size={14} className="text-fg-dim" />
            <span className="font-mono text-[12.5px] text-fg-2">{preview.name}</span>
            <span className="text-[11.5px] text-fg-dim">
              共 {preview.total} 行，预览前 {preview.rows.length} 行
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setPreview(null)}
              data-act="close-preview"
              className="rounded px-2 py-0.5 text-[12px] text-fg-dim hover:bg-hover"
            >
              收起
            </button>
          </div>
          {preview.rows.length === 0 ? (
            <div className="rounded-lg border border-line bg-card px-4 py-3 text-[12.5px] text-fg-dim">
              这张表是空的
            </div>
          ) : (
            <div className="max-h-[320px] overflow-auto rounded-lg border border-line bg-card">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-chip">
                  <tr className="text-left text-[11.5px] text-fg-dim">
                    {preview.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-1.5 font-normal">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="border-t border-line">
                      {preview.columns.map((c) => (
                        <td
                          key={c}
                          className="max-w-[260px] truncate px-3 py-1.5 font-mono text-[11.5px] text-fg-2"
                          title={String(row[c] ?? "")}
                        >
                          {String(row[c] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {wipe && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger-soft p-3">
          <div className="text-[13px] leading-relaxed text-danger">
            将删除「{wipe.name}」名下 {wipe.tables.length} 张表（{wipe.rows} 行）与它的配置项，
            无法撤销。工具本身不会被删除，
            {wipe.installed
              ? "下次打开它时表会按它的声明重新建出来。"
              : "它已经被卸载了，重装之后这些数据不会回来。"}
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => void doWipe(wipe)}
              data-act="confirm-wipe-ns"
              className="rounded-md bg-danger px-3 py-1.5 text-[13px] text-white hover:opacity-90"
            >
              确认清理
            </button>
            <button
              onClick={() => setWipe(null)}
              className="rounded-md border border-line bg-card px-3 py-1.5 text-[13px] text-fg-3"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NamespaceCard({
  ns,
  open,
  previewName,
  onToggle,
  onOpenTable,
  onWipe,
}: {
  ns: NamespaceStat;
  open: boolean;
  previewName: string | null;
  onToggle: () => void;
  onOpenTable: (name: string) => void;
  onWipe: () => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-line bg-card"
      data-ns={ns.id}
      data-ns-tables={ns.tables.length}
      data-ns-rows={ns.rows}
    >
      <button
        onClick={onToggle}
        data-ns-toggle={ns.id}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-hover"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-fg-dim" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] text-fg">{ns.name}</span>
            {ns.kind === "core" ? (
              <span className="shrink-0 rounded bg-chip px-1.5 py-px text-[10.5px] text-fg-dim">
                宿主
              </span>
            ) : (
              <span
                className={`shrink-0 rounded px-1.5 py-px text-[10.5px] ${
                  ns.installed
                    ? "bg-chip text-fg-dim"
                    : ns.known
                      ? "bg-tip-bg text-tip-text"
                      : "bg-danger-soft text-danger"
                }`}
                data-ns-installed={ns.installed ? "1" : "0"}
              >
                {ns.installed ? "已安装" : ns.known ? "已卸载 · 数据仍在" : "归属不明"}
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-fg-dim">
            {ns.prefix} · {ns.tables.length} 张表 · {ns.rows.toLocaleString()} 行
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-line">
          {ns.tables.length === 0 ? (
            <div className="px-3.5 py-2.5 text-[12px] leading-relaxed text-fg-dim">
              {ns.kind === "core"
                ? "没有核心表 —— 这不该发生，请检查数据库是否完好"
                : "这个工具还没建立数据表。它的设置存在宿主的 core_tool_kv 里（见上面「宿主」那段），数据则要等工具自己在 manifest 里声明了 schema 才会有。"}
            </div>
          ) : (
            <div className="divide-y divide-line">
              {ns.tables.map((t) => (
                <div
                  key={t.name}
                  className="flex items-center gap-2 px-3.5 py-2"
                  data-ns-table={t.name}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-fg-2">{t.label}</div>
                    <div className="truncate font-mono text-[11px] text-fg-dim">
                      {t.name} · {t.rows.toLocaleString()} 行
                      {t.columns > 0 ? ` · ${t.columns} 列` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => onOpenTable(t.name)}
                    data-view-table={t.name}
                    disabled={t.rows === 0}
                    className={`shrink-0 rounded px-2 py-0.5 text-[12px] ${
                      previewName === t.name
                        ? "bg-chip text-fg"
                        : "text-fg-3 hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent"
                    }`}
                  >
                    查看
                  </button>
                </div>
              ))}
            </div>
          )}

          {ns.kind === "tool" && (ns.tables.length > 0 || ns.installed) && (
            <div className="border-t border-line px-3.5 py-2">
              {ns.known ? (
                <button
                  onClick={onWipe}
                  data-wipe-ns={ns.id}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-danger hover:bg-danger-soft"
                >
                  <Trash2 size={12} />
                  清理这段命名空间的数据
                </button>
              ) : (
                <div className="px-2 py-1 text-[11.5px] leading-relaxed text-fg-dim">
                  这段表前缀定位不到唯一的工具（工具 id 含连字符时前缀会有歧义），
                  因此不提供一键清理 —— 宁可留着，也不能删错别人的数据。
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
