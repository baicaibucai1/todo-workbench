/**
 * 助手的工作区：一个它能写文件、也只该写这个目录的地方。
 *
 * ------------------------------------------------------------------
 * 为什么要有一个目录
 * ------------------------------------------------------------------
 * 助手干完活总要交出点东西：一份调研报告、一份改了三版的方案、一堆让它
 * 生成的 md。这些东西**不是待办、不是工具、不是数据表** —— 塞进现有的
 * 任何一个落点都是错位（拿 core_settings 存长文、拿图库存文档，都是拿
 * 一种东西当另一种用）。
 *
 * 所以给它一个自己的目录。它有两个好处：
 *   · 产出是**文件**，用户能用任何编辑器打开、能同步、能版本管理；
 *   · 边界是物理的 —— 助手能写的地方就这一个目录，别的地方它够不着。
 *
 * ------------------------------------------------------------------
 * 三条硬边界（都在这一层拦，不靠提示词）
 * ------------------------------------------------------------------
 *  1. **只能写工作区内部**。相对路径里的 `..`、绝对路径、Windows 盘符、
 *     反斜杠一律拒 —— 那是"助手把文件写到用户桌面"的唯一路径。
 *  2. **单文件有体积上限**。它是聊天模型，一口气吐出 200KB 是很正常的，
 *     而那会撑爆一次 postMessage/一次落库；超限就报清楚，让它分段写。
 *  3. **浏览器模式直接说不行**。网页版没有可写的文件系统（这条与
 *     install_tool 的处理保持一致：诚实地说做不到，而不是假装写成功了）。
 *
 * ------------------------------------------------------------------
 * 「默认落点」与「用户指定」的关系
 * ------------------------------------------------------------------
 * 默认是数据目录下的 `agent-workspace/`（toolsRoot 同级），用户可以在
 * 设置 → AI 助手里改成任何目录。**改了就用改的**，不再兜底回默认 ——
 * 用户指定了一个目录却写到了别处，比"目录不可写"更难解释。
 */

import { isTauri } from "../db";

/** 工作区默认目录名（挂在数据目录下，与 tools/ 同级） */
export const WORKSPACE_DIR_NAME = "agent-workspace";

/** 单个文件的体积上限（字符数，不是字节 —— 中文一个字 3 字节，按字符算更好解释） */
export const FILE_MAX_CHARS = 200_000;

/**
 * 路径段的字符集。
 *
 * 用**排除法**而不是白名单：中文文件名是再正常不过的需求
 * （「报告/季度总结.md」），写一套字母白名单等于禁止中文。
 * 排除的是那些在文件名里有别的含义的东西：分隔符、Windows 保留字符、
 * 通配符、控制字符。
 */
const SEG_RE = /^[^\/\\:*?"<>|\u0000-\u001f]+$/;

/**
 * 判定一个相对路径能不能写。
 *
 * 返回 null 表示可以；否则返回**可以直接回给模型**的一句话 ——
 * 它需要的不是"路径非法"，而是"改成什么样就合法"。
 */
export function checkRelPath(raw: string): string | null {
  const p = (raw ?? "").trim();
  if (!p) return "路径是空的";
  if (p.length > 200) return "路径太长了（最多 200 字符）";
  // 这几条必须在正则之前：先说人话，再谈格式
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) {
    return "只接受相对路径（相对工作区根目录），不要以 / 或盘符开头";
  }
  if (p.includes("\\")) return "路径分隔符请用 / ，不要用反斜杠";

  const segs = p.split("/");
  // 只在整段等于 `..` 时才拒：`a..b.md` 是合法文件名，不该被误伤
  if (segs.some((s) => s === "..")) return "路径里不能有 ..（不能跳出工作区）";
  if (segs.some((s) => s === "")) return "路径里不能有空的一段（别写两个连续的 / ，也别以 / 结尾）";
  if (!segs.every((s) => SEG_RE.test(s))) {
    return "文件名里不能包含 / \\ : * ? \" < > | 这些字符";
  }
  return null;
}

/**
 * 解析工作区根目录。返回空串表示"这里用不了"（浏览器模式）。
 *
 * 用户指定过就用他指定的；否则落到数据目录下的 agent-workspace/。
 */
export async function workspaceRoot(settings: Record<string, string>): Promise<string> {
  if (!isTauri()) return "";
  const custom = (settings.agentWorkspace ?? "").trim();
  if (custom) return custom.replace(/\/+$/, "");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  return join(await appDataDir(), WORKSPACE_DIR_NAME);
}

/** 浏览器模式下统一的那一句"做不到"，各处说法必须一致 */
export const NO_WORKSPACE_MSG =
  "浏览器演示模式没有可写的工作区（写文件要桌面版）。桌面版里它会写到数据目录下的 agent-workspace/，你也可以在设置 → AI 助手里改成别的目录。";

export interface WorkspaceFile {
  path: string;
  name: string;
  /** 字节数；目录是 null */
  size: number | null;
  isDir: boolean;
}

/** 列目录。返回空数组表示目录还不存在或读不出来 —— 那是"还没写过东西" */
export async function listWorkspace(
  settings: Record<string, string>,
): Promise<{ root: string; files: WorkspaceFile[] }> {
  const root = await workspaceRoot(settings);
  if (!root) return { root: "", files: [] };
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  if (!(await fs.exists(root))) return { root, files: [] };
  const entries = await fs.readDir(root);
  const files: WorkspaceFile[] = [];
  for (const e of entries) {
    const full = await join(root, e.name);
    let size: number | null = null;
    if (!e.isDirectory) {
      try {
        const st = await fs.stat(full);
        size = Number(st.size ?? 0);
      } catch {
        size = null;
      }
    }
    files.push({ path: e.name, name: e.name, size, isDir: !!e.isDirectory });
  }
  files.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { root, files };
}

/**
 * 写一个文件。
 *
 * 覆盖是**显式**的：默认拒绝覆盖已有文件。原因与 install_tool 那条一样 ——
 * "把用户已有的东西冲掉"必须让他自己走一次 overwrite，而不是默认就冲。
 *
 * ------------------------------------------------------------------
 * 为什么要有 append
 * ------------------------------------------------------------------
 * 一次回复的输出长度是有上限的（见 providers 的 maxTokens）。写一份几千行
 * 的 HTML 工具时，模型经常在写到一半时被掐断 —— 掐断的那个代码块是不闭合
 * 的，宿主什么也拿不到，于是它只能从头再写一遍，然后又断在同一个地方。
 *
 * 给它"接着写"的能力，这个死循环就断了：第一段 write_file 正常写，后面
 * 每段带 append: true 追加。分段的上限是 FILE_MAX_CHARS 这一条在管，
 * 所以追加也不会把文件撑爆。
 */
export async function writeWorkspaceFile(
  settings: Record<string, string>,
  relPath: string,
  content: string,
  overwrite: boolean,
  append = false,
): Promise<{ ok: true; path: string; total: number } | { ok: false; message: string }> {
  const root = await workspaceRoot(settings);
  if (!root) return { ok: false, message: NO_WORKSPACE_MSG };
  const bad = checkRelPath(relPath);
  if (bad) return { ok: false, message: bad };
  if (content.length > FILE_MAX_CHARS) {
    return {
      ok: false,
      message: `这一段有 ${content.length} 字符，超过单次上限 ${FILE_MAX_CHARS}。把它再切小一点分几次写（后续几段用 append: true）`,
    };
  }

  const fs = await import("@tauri-apps/plugin-fs");
  const { join, dirname } = await import("@tauri-apps/api/path");
  const full = await join(root, relPath);

  // 中间目录要自己建：助手写 "reports/2026-09/x.md" 是很自然的动作
  const parent = await dirname(full);
  if (parent && parent !== root && !(await fs.exists(parent))) {
    await fs.mkdir(parent, { recursive: true });
  }

  const exists = await fs.exists(full);
  if (!append && exists && !overwrite) {
    return {
      ok: false,
      message: `「${relPath}」已经存在。要覆盖就带上 overwrite: true；要接着写就带 append: true；不确定就先 read_file 看一眼`,
    };
  }

  const prev = append && exists ? await fs.readTextFile(full) : "";
  const next = prev + content;
  if (next.length > FILE_MAX_CHARS) {
    return {
      ok: false,
      message: `加上这一段后文件会有 ${next.length} 字符，超过单文件上限 ${FILE_MAX_CHARS}（已写 ${prev.length}）。请拆成另一个文件，或者精简后再写`,
    };
  }
  await fs.writeTextFile(full, next);
  return { ok: true, path: full, total: next.length };
}

export async function readWorkspaceFile(
  settings: Record<string, string>,
  relPath: string,
): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
  const root = await workspaceRoot(settings);
  if (!root) return { ok: false, message: NO_WORKSPACE_MSG };
  const bad = checkRelPath(relPath);
  if (bad) return { ok: false, message: bad };
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const full = await join(root, relPath);
  if (!(await fs.exists(full))) return { ok: false, message: `工作区里没有「${relPath}」这个文件` };
  return { ok: true, content: await fs.readTextFile(full) };
}

/** 删一个文件（不是目录）。删除不可逆，所以调用方必须走确认门 */
export async function deleteWorkspaceFile(
  settings: Record<string, string>,
  relPath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const root = await workspaceRoot(settings);
  if (!root) return { ok: false, message: NO_WORKSPACE_MSG };
  const bad = checkRelPath(relPath);
  if (bad) return { ok: false, message: bad };
  const fs = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const full = await join(root, relPath);
  if (!(await fs.exists(full))) return { ok: false, message: `工作区里没有「${relPath}」` };
  await fs.remove(full);
  return { ok: true };
}

/** 在资源管理器里打开工作区目录（给"写完了，文件在哪"一个落点） */
export async function revealWorkspace(settings: Record<string, string>): Promise<string> {
  const root = await workspaceRoot(settings);
  if (!root) return NO_WORKSPACE_MSG;
  const fs = await import("@tauri-apps/plugin-fs");
  if (!(await fs.exists(root))) await fs.mkdir(root, { recursive: true });
  const { openExternal } = await import("../attachments");
  await openExternal(root);
  return root;
}
