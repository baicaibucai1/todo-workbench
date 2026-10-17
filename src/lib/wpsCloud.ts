/**
 * 云端表格直连（AirScript 脚本令牌）—— 宿主侧编排。
 *
 * 与 `kwiki.ts` 那套的区别：
 *   · 不登录、不选知识库、不复制、不删旧 —— **直接读写用户自己那张云表格**；
 *   · 凭证是「脚本 webhook + 脚本令牌」，都来自用户表格里的那个 AirScript；
 *   · 传输层在 Rust（见 src-tauri/src/wps.rs 的「云端表格直连」一节）。
 *
 * 为什么必须借脚本：WPS 对个人账号没有直接写云文档的开放接口（开放平台只对
 * 企业资质开放）。AirScript 是个人号唯一能"程序改原表"的路 —— 脚本在表里跑，
 * 读写的是它自己的单元格。代价是**一次性**建脚本，界面给出现成代码。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";
import { SETTINGS } from "./settings";
import type { LedgerRow, WpsPull } from "./kwiki";

/** 点一下「复制脚本」拿到的东西。**与 Rust 侧的协议严格对应**，改一边必须改另一边。 */
export const AIRSCRIPT_SNIPPET = `/* 云表格直连脚本 —— 整段粘进 AirScript 编辑器，保存后建「脚本令牌」 */
var A = (typeof Context !== "undefined" && Context.argv) || {};
var op = A.op || "ping";
var sh = null;
try { if (A.sheet) sh = Application.Sheets(A.sheet); } catch (e) {}
if (!sh) { try { sh = Application.ActiveSheet; } catch (e) {} }
if (!sh) sh = Application.Sheets(1);

/* 单元格一律取「显示文本」：Value2 是 double，19 位订单号会被吃掉末尾几位 */
function cellText(r, c) {
  var t = "";
  try { t = sh.Cells(r, c).Text; } catch (e) { t = sh.Cells(r, c).Value2; }
  return t === null || t === undefined ? "" : String(t);
}

function lastRow() {
  var u = sh.UsedRange;
  return u.Row + u.Rows.Count - 1;
}

function lastCol() {
  var u = sh.UsedRange;
  return u.Column + u.Columns.Count - 1;
}

function grid() {
  var out = [];
  var lr = lastRow(), lc = lastCol();
  for (var r = 1; r <= lr; r++) {
    var line = [];
    for (var c = 1; c <= lc; c++) line.push(cellText(r, c));
    out.push(line);
  }
  return out;
}

/* 整块赋值快，但不同版本对二维数组的支持不一样 —— 失败就逐格写，慢但一定成 */
function putCol(col, start, vals) {
  var done = false;
  if (vals.length > 1) {
    try {
      var mat = [];
      for (var k = 0; k < vals.length; k++) mat.push([vals[k]]);
      sh.Range(sh.Cells(start, col), sh.Cells(start + vals.length - 1, col)).Value2 = mat;
      done = true;
    } catch (e) { done = false; }
  }
  if (!done) {
    for (var i = 0; i < vals.length; i++) sh.Cells(start + i, col).Value2 = vals[i];
  }
}

function clearRect(r1, c1, r2, c2) {
  try { sh.Range(sh.Cells(r1, c1), sh.Cells(r2, c2)).ClearContents(); }
  catch (e) {
    for (var r = r1; r <= r2; r++) {
      for (var c = c1; c <= c2; c++) sh.Cells(r, c).Value2 = "";
    }
  }
}

if (op === "ping") {
  /* 只读第一行和尺寸，不整表扫 —— 大表上「测试连接」要秒回 */
  var lc = lastCol(), head = [];
  for (var c = 1; c <= lc; c++) head.push(cellText(1, c));
  var n = 1;
  try { n = Application.Sheets.Count; } catch (e) {}
  return { ok: true, sheet: sh.Name, sheets: n, rows: lastRow(), cols: lc, header: head };
}

if (op === "read") {
  return { ok: true, sheet: sh.Name, rows: grid() };
}

if (op === "write") {
  var cols = A.cols || [];
  for (var i = 0; i < cols.length; i++) {
    var vals = cols[i].values || [];
    if (vals.length) putCol(cols[i].col, cols[i].from || 1, vals);
  }
  var clears = A.clear || [];
  for (var j = 0; j < clears.length; j++) {
    if (clears[j].to >= clears[j].from) {
      clearRect(clears[j].from, clears[j].col, clears[j].to, clears[j].col);
    }
  }
  return { ok: true, cols: cols.length };
}

if (op === "writeGrid") {
  var rows = A.rows || [], width = 0;
  for (var i2 = 0; i2 < rows.length; i2++) if (rows[i2].length > width) width = rows[i2].length;
  var old = lastRow();
  for (var c2 = 1; c2 <= width; c2++) {
    var col = [];
    for (var k2 = 0; k2 < rows.length; k2++) {
      var v = rows[k2][c2 - 1];
      col.push(v === null || v === undefined ? "" : v);
    }
    putCol(c2, 1, col);
  }
  if (width && old > rows.length) clearRect(rows.length + 1, 1, old, width);
  return { ok: true, rows: rows.length };
}

return { ok: false, error: "未知操作：" + op };
`;

export type CloudConfig = {
  link: string;
  webhook: string;
  token: string;
  /** 上次探测到的工作表名。空 = 用当前活动工作表 */
  sheet: string;
};

export type CloudInfo = {
  sheet: string;
  sheets: number;
  rows: number;
  cols: number;
  header: string[];
};

export type CloudPushResult = {
  count: number;
  columns: number;
  appended: number;
  file_kuid: string;
};

export type CloudSheet = {
  sheet: string;
  header: string[];
  rows: string[][];
};

export function readCloudConfig(settings: Record<string, string>): CloudConfig {
  return {
    link: settings[SETTINGS.wpsCloudLink] || "",
    webhook: settings[SETTINGS.wpsCloudWebhook] || "",
    token: settings[SETTINGS.wpsCloudToken] || "",
    sheet: settings[SETTINGS.wpsCloudSheet] || "",
  };
}

/** 直连三件套齐不齐（链接只是给人看的，同步真正需要的是 webhook + 令牌） */
export function cloudReady(cfg: CloudConfig): boolean {
  return !!cfg.webhook.trim() && !!cfg.token.trim();
}

function desktopOnly(): never {
  throw new Error("云端表格直连只在桌面版里可用 —— 网页端跨不过金山文档的跨域限制");
}

function need(v: string | undefined, what: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(what);
  return s;
}

/** 试一下脚本通不通，顺便把工作表名 / 表头读回来 */
export async function cloudProbe(webhook: string, token: string): Promise<CloudInfo> {
  if (!isTauri()) desktopOnly();
  return invoke<CloudInfo>("wps_cloud_probe", {
    webhook: need(webhook, "先填 AirScript 的 webhook 地址"),
    token: need(token, "先填 AirScript 脚本令牌"),
  });
}

/** 拉取台账（整表读 → 按表头映射成 SQLite 列名） */
export async function cloudPull(
  webhook: string,
  token: string,
  sheet = "",
): Promise<WpsPull> {
  if (!isTauri()) desktopOnly();
  return invoke<WpsPull>("wps_cloud_pull", {
    webhook: need(webhook, "还没配 webhook —— 去上面「云端表格」里填"),
    token: need(token, "还没配脚本令牌 —— 去上面「云端表格」里填"),
    sheet: sheet || null,
  });
}

/** 推送台账（只写台账那 14 列，表里其它列不动） */
export async function cloudPush(
  webhook: string,
  token: string,
  sheet: string,
  rows?: LedgerRow[],
): Promise<CloudPushResult> {
  if (!isTauri()) desktopOnly();
  const body = rows ?? [];
  return invoke<CloudPushResult>("wps_cloud_push", {
    webhook: need(webhook, "还没配 webhook —— 去上面「云端表格」里填"),
    token: need(token, "还没配脚本令牌 —— 去上面「云端表格」里填"),
    sheet: sheet || null,
    rows: body,
  });
}

/** 整表读（原样二维数组）—— 「WPS 绑定文件」工具用 */
export async function cloudSheetRead(
  webhook: string,
  token: string,
  sheet = "",
): Promise<CloudSheet> {
  if (!isTauri()) desktopOnly();
  return invoke<CloudSheet>("wps_cloud_sheet_read", {
    webhook: need(webhook, "还没配 webhook"),
    token: need(token, "还没配脚本令牌"),
    sheet: sheet || null,
  });
}

/** 整表覆盖写（保留格式，只改值）—— 「WPS 绑定文件」工具用 */
export async function cloudSheetWrite(
  webhook: string,
  token: string,
  sheet: string,
  header: string[],
  rows: string[][],
): Promise<number> {
  if (!isTauri()) desktopOnly();
  return invoke<number>("wps_cloud_sheet_write", {
    webhook: need(webhook, "还没配 webhook"),
    token: need(token, "还没配脚本令牌"),
    sheet: sheet || null,
    header,
    rows,
  });
}
