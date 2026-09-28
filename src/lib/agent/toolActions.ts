/**
 * 工具注册给助手的动作 —— **命名与反解**，以及"这一刻哪些工具是停用的"。
 *
 * ------------------------------------------------------------------
 * 为什么函数名要能反解
 * ------------------------------------------------------------------
 * 模型看到的是一串函数名（`tool_scratchpad_add-note`），宿主拿到这串名字后
 * 必须**无条件**知道它是哪个工具的哪个动作 —— 靠另存一张表来记是行不通的：
 * 那张表会在"工具刚装好 / 刚被停用 / 刚被卸载"这三种时刻与真实状态错位，
 * 而错位时的表现是"模型调了一个没人能执行的动作"，最难查的那一类。
 *
 * 所以规则是：`tool_` + 工具 id + `_` + 动作名，**两边都不含下划线**
 * （id 的正则 `^[a-z][a-z0-9-]{1,31}$` 与动作名 `^[a-z][a-z0-9-]{0,23}$`
 * 都只允许小写字母数字与连字符）。因此按下划线切开恒为三段，反解无歧义。
 *
 * 长度：5 + 32 + 1 + 24 = 62，落在各家 64 字符的函数名上限之内。
 *
 * ------------------------------------------------------------------
 * 为什么"停用的工具"要在这里记一份
 * ------------------------------------------------------------------
 * 停用了的工具不该出现在助手的能力清单里 —— 它是用户亲手关掉的，
 * 助手再去驱动它等于绕过用户的决定。而"哪些被停用"存在设置里（异步读库），
 * 拼工具清单却是**同步**的（toolsForModel 在发请求那一刻调用）。
 * 所以这里留一份模块级快照，由 runtime 在每一轮开始前刷一次。
 */

import type { ToolManifest } from "../../types";

/** 模型看到的工具动作函数名前缀 */
export const TOOL_ACTION_PREFIX = "tool_";

/** 工具自带技能（skill）的 id 前缀。加了前缀才不会和内置技能撞名 */
export const TOOL_SKILL_PREFIX = "tool-use-";

/** 拼出模型看到的函数名 */
export function toolActionName(toolId: string, action: string): string {
  return `${TOOL_ACTION_PREFIX}${toolId}_${action}`;
}

/**
 * 反解一个函数名。不是工具动作的（前缀不对、段数不对、字符集不对）返回 null。
 *
 * 段数必须是 3：动作名里没有下划线，所以 `a_b_c_d` 这种必然是别人家的函数名。
 */
export function parseToolActionName(
  name: string,
): { toolId: string; action: string } | null {
  if (!name.startsWith(TOOL_ACTION_PREFIX)) return null;
  const parts = name.slice(TOOL_ACTION_PREFIX.length).split("_");
  if (parts.length !== 2) return null;
  const [toolId, action] = parts;
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(toolId)) return null;
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(action)) return null;
  return { toolId, action };
}

export function isToolActionName(name: string): boolean {
  return parseToolActionName(name) !== null;
}

/** 这个工具自带的技能 id */
export function toolSkillId(toolId: string): string {
  return `${TOOL_SKILL_PREFIX}${toolId}`;
}

/**
 * 这个 id 是不是"工具技能"的命名空间。
 *
 * add_skill / delete_skill 要用它挡一道：那份说明是**随工具一起装卸**的，
 * 助手自己存一条同 id 的技能，会在工具卸载之后留下一份指向空气的说明。
 */
export function isToolSkillId(id: string): boolean {
  return id.startsWith(TOOL_SKILL_PREFIX);
}

/**
 * 这个工具当前能被驱动的动作名列表。
 *
 * 优先取 actions（完整声明）；没声明 actions 的老工具退回 commands。
 * 两处都没有就是空数组 —— "不接受助手驱动"是默认状态。
 */
export function toolActionNames(tool: Pick<ToolManifest, "actions" | "commands">): string[] {
  if (tool.actions?.length) return tool.actions.map((a) => a.name);
  return tool.commands ?? [];
}

/* ------------------------------------------------------------------ */
/* 停用快照                                                            */
/* ------------------------------------------------------------------ */

/**
 * 被用户停用的工具 id。
 *
 * 默认空集（"没停用任何工具"）而不是"未知"：单测里没人来刷它，
 * 而单测要验的是"装了就有动作"这件正常事 —— 默认挡掉会让所有相关断言一起红。
 */
let disabledIds: ReadonlySet<string> = new Set();

/** 由 runtime 在每一轮开始前刷新（它也顺手刷了 skills 那一份） */
export function setDisabledTools(ids: Iterable<string> | null | undefined): void {
  disabledIds = new Set(ids ?? []);
}

export function isToolDisabled(id: string): boolean {
  return disabledIds.has(id);
}

/**
 * 当前**应当暴露给助手**的工具。
 *
 * 两个条件：装在这台机器上，且没被用户停用。顺序按注册表（扫描顺序），
 * 不去重不排序 —— 助手看到的就是用户侧边栏里看到的那一批。
 */
export function exposedTools(tools: ToolManifest[] = []): ToolManifest[] {
  return tools.filter((t) => !disabledIds.has(t.id));
}
