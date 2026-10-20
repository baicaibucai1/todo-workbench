/**
 * WPS 绑定文件（知识库里的表格 / 文档）的**宿主侧**读写编排。
 *
 * 和上一版「共享链接只读预览」的区别（2026-10-17 用户要求）：
 *
 *   · 工具要**绑定一份具体文件**，然后反复读、改、存回去；
 *   · 所以必须登录（用账号的 kwiki 令牌），不是匿名解析分享链接；
 *   · 写回走「新建 → 删旧 → 改名」—— WPS 的上传只能新建，不能原地覆盖。
 *
 * 为什么单独一层、而不是直接塞进 toolBridge：
 *   · **令牌不出宿主**。工具只传 kuid / 标题 / 内容，登录态与知识库都从设置现取；
 *   · `lib/kwiki.ts` 依赖 `toolBridge`（postToTool），反过来 import 会成环。
 *     这里只依赖 db / settings，类型用 `import type`（编译期擦除）。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";
import { SETTINGS } from "./settings";
import type { WpsFile } from "./kwiki";

/** 绑定：一份知识库文件的身份。保存后 kuid 会变，界面必须用它更新绑定 */
export type WpsBinding = {
  kuid: string;
  title: string;
  /** 原始 doc_type：s / ksheet / w / o。保存时靠它决定走哪条写回路径 */
  doc_type: string;
  /** sheet / doc */
  kind: string;
  /** 给用户看的说明（比如"这是副本，原文件不会变"） */
  note?: string;
};

export type WpsFileDoc = {
  kuid: string;
  title: string;
  kind: string;
  doc_type: string;
  header: string[];
  rows: string[][];
  text: string;
};

export type WpsWriteResult = {
  /** 保存后节点 id 一定变了（上传 / 转换都是新建） */
  kuid: string;
  title: string;
  note: string;
};

export type WpsEditable = {
  header: string[];
  rows: string[][];
  text: string;
};

/** 可绑定的文件（知识库清单里的一项） */
export type BindableFile = WpsFile & { kind: string };

type Cfg = { token: string; spaceKuid: string; driveId: string };

function need(v: string | undefined, what: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(what);
  return s;
}

/**
 * 从设置里取"当前 WPS 账号 + 知识库"。
 *
 * 三样缺一不可：令牌（登录）、spaceKuid（读写的空间）、driveId（上传要它）。
 * 报错要说清**去哪个界面补**，否则工具里只会看到一句"失败"。
 */
export function wpsConfig(settings: Record<string, string>): Cfg {
  return {
    token: need(
      settings[SETTINGS.kwikiToken],
      "还没登录 WPS —— 去 设置 → WPS 在线表格联动 里点「登录 WPS」",
    ),
    spaceKuid: need(
      settings[SETTINGS.kwikiSpaceKuid],
      "还没选知识库 —— 去 设置 → WPS 在线表格联动 里选一个",
    ),
    driveId: need(
      settings[SETTINGS.kwikiDriveId],
      "这个知识库没给出 drive_id —— 去设置里重新选一次知识库",
    ),
  };
}

function desktopOnly(): never {
  throw new Error("WPS 读写只在桌面版里可用 —— 网页端跨不过 WPS 的跨域限制");
}

/** doc_type → sheet / doc（与 Rust 侧 kind_of_doc_type 同一套判定） */
export function kindOfDocType(docType: string, title = ""): "sheet" | "doc" | "other" {
  const t = String(docType || "");
  if (t === "s" || t === "ksheet" || t === "xlsx" || t === "et") return "sheet";
  if (t === "w" || t === "o" || t === "docx" || t === "otl" || t === "doc") return "doc";
  const n = title.toLowerCase();
  if (/\.(ksheet|xlsx|xls|et)$/.test(n)) return "sheet";
  if (/\.(otl|docx|doc|wps)$/.test(n)) return "doc";
  return "other";
}

/** 知识库里能绑定的文件（表格 / 文档；认不出类型的不列，绑了也编辑不了） */
export async function listBindable(settings: Record<string, string>): Promise<BindableFile[]> {
  if (!isTauri()) desktopOnly();
  const cfg = wpsConfig(settings);
  const files = await invoke<WpsFile[]>("wps_files", { token: cfg.token, kuid: cfg.spaceKuid });
  return files
    .map((f) => ({ ...f, kind: kindOfDocType(f.doc_type, f.title) }))
    .filter((f) => f.kind !== "other");
}

/**
 * 把一条分享链接复制进知识库并返回可绑定的节点。
 *
 * **这是"绑定"里唯一会产生副本的入口**：原文件在别人的空间里，我们没有
 * 写权限；复制进来的这份才是能编辑的。所以返回值里带一句 note 说明这件事，
 * 界面必须显示出来（不能让人以为在改原文件）。
 */
export async function bindByLink(
  link: string,
  settings: Record<string, string>,
): Promise<WpsBinding> {
  if (!isTauri()) desktopOnly();
  const cfg = wpsConfig(settings);
  const url = need(link, "先粘贴一个金山文档的分享链接");
  return invoke<WpsBinding>("wps_link_import", {
    token: cfg.token,
    spaceKuid: cfg.spaceKuid,
    link: url,
  });
}

/** 读绑定文件的当前内容（表格给表头 + 行，文档给正文） */
export async function readBoundFile(
  binding: WpsBinding,
  settings: Record<string, string>,
): Promise<WpsFileDoc> {
  if (!isTauri()) desktopOnly();
  const cfg = wpsConfig(settings);
  return invoke<WpsFileDoc>("wps_file_read", {
    token: cfg.token,
    kuid: binding.kuid,
    title: binding.title,
    docType: binding.doc_type,
  });
}

/**
 * 保存：新建 → 删旧 → 改名，返回新的 kuid。
 *
 * 调用方**必须**把绑定更新成返回的 kuid —— 旧节点已经进回收站了，
 * 继续用旧 kuid 读会报"文件不存在"。
 */
export async function writeBoundFile(
  binding: WpsBinding,
  doc: WpsEditable,
  settings: Record<string, string>,
): Promise<WpsWriteResult> {
  if (!isTauri()) desktopOnly();
  const cfg = wpsConfig(settings);
  return invoke<WpsWriteResult>("wps_file_write", {
    token: cfg.token,
    spaceKuid: cfg.spaceKuid,
    driveId: cfg.driveId,
    kuid: binding.kuid,
    title: binding.title,
    docType: binding.doc_type,
    header: doc.header,
    rows: doc.rows,
    text: doc.text,
  });
}

/*
 * 曾经这里还有一条「云端表格直连（AirScript）」—— 要用户在表里建脚本、
 * 复制 webhook 与脚本令牌。2026-10-19 已整套迁到官方 MCP：
 * 那条路的活现在由 `wpsMcp.ts` + 工具里的 `wps.mcpBind / mcpRead / mcpSheetWrite`
 * 接手（一次授权，挑一份文件就能读写原表，不用在 WPS 里建任何东西）。
 */
