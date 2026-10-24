/**
 * 内置工具清单 —— 测试里那几处「写死的工具」的唯一出处。
 *
 * ============================ 它替代了什么 ============================
 *
 * 以前同一个事实散在三个测试文件里各写一遍：
 *
 *   tests/placeholder-tools.mjs   侧栏工具数   `toolCount === 5`
 *   tests/tool-browser.mjs        设置页工具数 `toolRows === 6`
 *   tests/tools-standalone.mjs    THEME_TOOLS   六行手写数组
 *
 * 每加一个内置工具要三处同步，**漏一处不报错**，只是那个套件悄悄少测一项。
 * 现在它们都从这里 import，加工具的活由 `npm run tool:new` 一并改掉。
 *
 * ------------------------------------------------------------------
 * 为什么不改成"从 tools/ 目录自动推导"
 * ------------------------------------------------------------------
 * `tool-browser.mjs` 里那句注释写得很清楚：**写死是为了让「多出一个陌生
 * 工具」能被立刻发现**，而不是悄无声息地出现在用户的侧边栏里。
 * 自动推导出来就永远相等，那道防盗门等于拆了。
 *
 * 所以这里仍然是手写的，但只有这一份，并且由 `npm run tool:audit`
 * 拿它与 tools/*\/manifest.json 对账 —— 想偷懒不改这里，审计会拦下来。
 *
 * ------------------------------------------------------------------
 * 两档数字为什么不同
 * ------------------------------------------------------------------
 * ALL_TOOL_IDS    磁盘上 tools/ 里的全部目录，含默认停用的两个示例型工具
 * ENABLED_TOOL_IDS 新库默认会显示在侧边栏里的那部分
 *                  （差集 = src/lib/settings.ts 的 DEFAULT_SETTINGS[tools.disabled]）
 *
 * 老库不适用这个差集 —— 回填由 migrations.ts 的 v24 负责（把 wpslink 幂等地
 * 合并进 tools.disabled，只合并、不动用户自己停用过/启用过的项）。
 */

/** 全部内置工具 id（含默认停用的样板） */
export const ALL_TOOL_IDS = [
  "image-crop",
  "size-chart",
  "notes",
  "ai-gen",
  "abnormal-ticket",
  "scratchpad",
  "wpslink",
];

/**
 * 新库默认启用、会出现在侧边栏里的工具 id。
 *
 * 与 ALL_TOOL_IDS 的差集必须**恰好**是 settings.ts 里默认停用的那几个，
 * 由 `npm run tool:audit` 盯着 —— 两边各改一处就会立刻对不上。
 *
 * 现在差集是两个示例型工具：scratchpad（写工具照抄的样板）和
 * wpslink（演示怎么接 WPS 能力的样本）。两者文件都随工具包分发，
 * 要用的到 设置 → 工具 里打开。
 */
export const ENABLED_TOOL_IDS = [
  "image-crop",
  "size-chart",
  "notes",
  "ai-gen",
  "abnormal-ticket",
];

/**
 * 要验深浅色的工具：[id, 短名]。
 *
 * 短名只用在日志里，跟 manifest 里的 name 不必一字不差（那边是完整名称）。
 */
export const THEME_TOOLS = [
  ["image-crop", "图片裁剪"],
  ["size-chart", "尺码表"],
  ["notes", "便签"],
  ["ai-gen", "AI 生成"],
  ["abnormal-ticket", "异常单号"],
  ["scratchpad", "模板"],
  ["wpslink", "WPS 绑定文件"],
];

/** 给断言用的期望值：侧栏工具数 / 设置页工具行数 */
export const EXPECTED_SIDEBAR_TOOLS = ENABLED_TOOL_IDS.length;
export const EXPECTED_SETTINGS_ROWS = ALL_TOOL_IDS.length;
