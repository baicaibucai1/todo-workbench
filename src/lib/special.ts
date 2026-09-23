/**
 * 「特殊单号」记录视图的自定义能力。
 *
 * 三件事放在同一个文件里，是因为它们本质是**同一批数据的三种出口**：
 * 复制（贴进聊天窗口）、自定义列（在表里看）、导出（落到 Excel 里对账）。
 * 各写一遍的下场是"表上看到的和复制出来的不是同一份东西"，
 * 而这种不一致没有自动检查能拦住。
 *
 * 具体的键名与默认值在 lib/settings.ts，这里只管"值怎么解释、怎么拼出来"。
 */

import type { DueState } from "./due";

/* ------------------------------------------------------------------ */
/* 复制模板                                                            */
/* ------------------------------------------------------------------ */

/**
 * 相关信息的复制格式。
 *
 * 之所以要可配：同一批信息要贴去的地方不一样 ——
 * 发给客户要带字段名（他不知道 YT0000… 是什么），
 * 粘进内部表格只要值，发给快递公司要一行流（他们那边是一行一个单）。
 * 写死一种格式等于每次都要手动删掉那几个字。
 */
export type CopyTemplate = "label-cn" | "label-en" | "value" | "line";

export const COPY_TEMPLATES: Array<{
  value: CopyTemplate;
  label: string;
  hint: string;
}> = [
  {
    value: "label-cn",
    label: "字段名：值（逐行）",
    hint: "补发单号：YT001\n客户：张三",
  },
  { value: "label-en", label: "字段名: 值（逐行）", hint: "补发单号: YT001\n客户: 张三" },
  { value: "value", label: "只要值（逐行）", hint: "YT001\n张三" },
  { value: "line", label: "一行流（分号分隔）", hint: "补发单号：YT001；客户：张三" },
];

export function isCopyTemplate(v: string | undefined): v is CopyTemplate {
  return COPY_TEMPLATES.some((t) => t.value === v);
}

/** 一条「字段名 + 值」按模板拼出来。没有字段名时退化成只给值 */
export function formatField(
  f: { label: string; value: string },
  tpl: CopyTemplate = "label-cn",
): string {
  const label = f.label.trim();
  const value = f.value ?? "";
  if (tpl === "value" || !label) return value;
  if (tpl === "line") return `${label}：${value}`;
  // label-en 用半角冒号 + 空格：那是粘进英文系统/表格时不会显得突兀的写法
  return tpl === "label-en" ? `${label}: ${value}` : `${label}：${value}`;
}

/** 一组相关信息按模板拼成一段文本（空值整条丢掉，不留空行） */
export function formatFields(
  fields: Array<{ label: string; value: string }>,
  tpl: CopyTemplate = "label-cn",
): string {
  const parts = fields
    .map((f) => formatField(f, tpl))
    .filter((s) => s.trim() !== "");
  if (!parts.length) return "";
  return tpl === "line" ? parts.join("；") : parts.join("\n");
}

/**
 * 多张单一起复制时的拼法：多于一张就在每段前面加一行单号。
 *
 * 不带单号的话，复制五张单出来就是五段长得一样的"客户：张三"，
 * 谁是谁根本分不出来 —— 批量复制的意义也就没了。
 */
export function formatOrdersFields(
  groups: Array<{ no: string; fields: Array<{ label: string; value: string }> }>,
  tpl: CopyTemplate = "label-cn",
): string {
  const blocks = groups.map((g) => formatFields(g.fields, tpl));
  if (groups.length === 1) return blocks[0] ?? "";
  return groups
    .map((g, i) => {
      const body = blocks[i] ?? "";
      return body ? `# ${g.no || "（无单号）"}\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/* ------------------------------------------------------------------ */
/* 自定义列                                                            */
/* ------------------------------------------------------------------ */

/**
 * 表格上最多挂几个自定义列。
 *
 * 上限不是随便定的：主区在详情面板打开时只剩 580px 上下，
 * 超过三个自定义列后「处理时效」这一列（这类单子最该看的东西）
 * 就会被挤出可视区 —— 首版做六列时实测就是这样。
 */
export const MAX_SPECIAL_COLUMNS = 3;

/** 从库里读出来的配置是个字符串，可能是手改过的；一律夹回合法范围 */
export function parseSpecialColumns(raw: string | undefined): string[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const label = v.trim();
    if (!label || out.includes(label)) continue;
    out.push(label);
    if (out.length >= MAX_SPECIAL_COLUMNS) break;
  }
  return out;
}

export function formatSpecialColumns(labels: string[]): string {
  return JSON.stringify(labels.slice(0, MAX_SPECIAL_COLUMNS));
}

/** 读复制模板。认不出的值（手改过、旧版本残留）一律退回默认格式 */
export function parseCopyTemplate(raw: string | undefined): CopyTemplate {
  return isCopyTemplate(raw) ? raw : "label-cn";
}

/** 记录表的行高密度 */
export type SpecialDensity = "comfortable" | "compact";

export function parseSpecialDensity(raw: string | undefined): SpecialDensity {
  return raw === "compact" ? "compact" : "comfortable";
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/** 导出的一行。视图层负责把流程任务摊平成这个形状，这里只管拼 CSV */
export interface SpecialExportRow {
  no: string;
  /** 快递商中文名（认不出时为空） */
  courier: string;
  /** 查询链接。导出的是**拼好的网址**，拿到表的人点开就是这一单的轨迹 */
  trackUrl: string;
  title: string;
  flowName: string;
  stageName: string;
  status: string;
  important: boolean;
  createdAt: string;
  dueAt: string | null;
  dueState: DueState;
  note: string;
  fields: Array<{ label: string; value: string }>;
}

/** CSV 单元格：引号、逗号、换行都要转义，否则 Excel 会把一行撕成好几行 */
export function csvCell(v: string): string {
  const s = v ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 拼 CSV。
 *
 * 自定义列**逐个占一列**（而不是塞进"相关信息"那一格里），
 * 因为导出就是为了在 Excel 里按客户、按补发单号排序筛 ——
 * 挤在一格里就只剩人眼能看，机器没法用。列的顺序跟着用户在表上调的顺序。
 */
export function buildSpecialCsv(rows: SpecialExportRow[], columns: string[]): string {
  const head = [
    "快递单号",
    "快递商",
    "说明",
    "流程",
    "当前步骤",
    "状态",
    "重要",
    "登记时间",
    "处理时效截止",
    "时效状态",
    "备注",
    "查询链接",
    ...columns,
  ];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    const valueOf = (label: string) =>
      r.fields.find((f) => f.label.trim() === label)?.value ?? "";
    lines.push(
      [
        r.no,
        r.courier,
        r.title,
        r.flowName,
        r.stageName,
        r.status,
        r.important ? "是" : "",
        r.createdAt,
        r.dueAt ?? "",
        dueStateLabel(r.dueState),
        r.note,
        r.trackUrl,
        ...columns.map(valueOf),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

function dueStateLabel(s: DueState): string {
  if (s === "overdue") return "已超时";
  if (s === "soon") return "临期";
  if (s === "ok") return "正常";
  return "未设时效";
}

/**
 * 把一段文本存成文件下载下来。
 *
 * 开头那个 BOM 不是多余的：没有它，Excel 会按本地 ANSI 编码打开，
 * 中文整片变乱码 —— 而"导出来是乱码"在用户看来就是导出功能坏了。
 * 与设置页导出备份 JSON 用的是同一套写法。
 */
export function downloadTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([`\uFEFF${text}`], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
