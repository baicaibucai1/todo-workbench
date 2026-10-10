/**
 * 流程任务「相关信息」的复制格式。
 *
 * 原来这里还放着「特殊单号」记录视图的自定义列、行高密度与 CSV 导出 ——
 * 那三样随那个功能一起删除了（2026-10-10），只剩复制这一件：
 * 它是流程任务详情里也在用的能力。
 *
 * 具体的键名与默认值在 lib/settings.ts（SETTINGS.orderCopyTemplate），
 * 这里只管"值怎么解释、怎么拼出来"。
 */


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

/** 读复制模板。认不出的值（手改过、旧版本残留）一律退回默认格式 */
export function parseCopyTemplate(raw: string | undefined): CopyTemplate {
  return isCopyTemplate(raw) ? raw : "label-cn";
}
