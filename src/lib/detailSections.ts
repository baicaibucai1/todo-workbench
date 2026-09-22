/**
 * 右侧详情面板里「一条待办的分区」有哪些、默认怎么排、顺序怎么改。
 *
 * 顺序做成可配置而不是写死，是因为**排在前面的那一块决定"打开待办先看什么"**：
 * 有人每条待办都要先落日期，有人主要拿它当便签记备注。写死顺序等于替所有人
 * 决定这件事。
 *
 * 这里只有**顺序与标签**，不包含分区怎么渲染 —— 那属于 TaskDetail。
 */

export const DETAIL_SECTION_IDS = [
  "subtasks",
  "schedule",
  "repeat",
  "list",
  "links",
  "note",
] as const;

export type DetailSectionId = (typeof DETAIL_SECTION_IDS)[number];

export const DETAIL_SECTIONS: Array<{ id: DetailSectionId; label: string }> = [
  { id: "subtasks", label: "子任务" },
  { id: "schedule", label: "日期与提醒" },
  { id: "repeat", label: "重复" },
  { id: "list", label: "所属列表" },
  { id: "links", label: "关联任务" },
  { id: "note", label: "备注" },
];

/** 默认顺序 = 面板里从上到下的排列 */
export const DEFAULT_DETAIL_SECTIONS: DetailSectionId[] = DETAIL_SECTIONS.map((s) => s.id);

function isDetailSectionId(v: unknown): v is DetailSectionId {
  return typeof v === "string" && (DETAIL_SECTION_IDS as readonly string[]).includes(v);
}

/**
 * 解析顺序。存的是 JSON 数组字符串，可能被手改过、也可能是旧版本残留，
 * 一律按下面的规则兜住：
 *
 * - 认不出来的项丢掉（未知 id 会渲染出一块空白）；
 * - 重复项只留第一次出现的位置；
 * - **缺了的补到末尾**，而不是丢弃整份配置 —— 否则新版本加一个分区，
 *   老用户那块分区就凭空消失了，且他没有任何办法把它找回来。
 */
export function parseDetailSections(raw: string | undefined): DetailSectionId[] {
  let items: unknown[] = [];
  try {
    const v = JSON.parse(raw ?? "");
    if (Array.isArray(v)) items = v;
  } catch {
    // 解析不了就当没配过，走默认
  }
  const out: DetailSectionId[] = [];
  for (const it of items) {
    if (isDetailSectionId(it) && !out.includes(it)) out.push(it);
  }
  for (const id of DEFAULT_DETAIL_SECTIONS) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function formatDetailSections(order: DetailSectionId[]): string {
  const clean = order.filter((id, i) => isDetailSectionId(id) && order.indexOf(id) === i);
  for (const id of DEFAULT_DETAIL_SECTIONS) if (!clean.includes(id)) clean.push(id);
  return JSON.stringify(clean);
}

/** 上移（-1）/ 下移（+1）；到头了返回原数组，让调用方能直接拿结果落库 */
export function moveDetailSection(
  order: DetailSectionId[],
  id: DetailSectionId,
  delta: number,
): DetailSectionId[] {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * 拖拽落位：把 fromId 插到 toId 所在的位置。
 *
 * 用"插到目标位置"而不是"两两交换"，是因为拖三格其实就是连续交换三次，
 * 中间每一次都落库的话会写三条设置、面板也会跟着抖三下。
 */
export function placeDetailSection(
  order: DetailSectionId[],
  fromId: DetailSectionId,
  toId: DetailSectionId,
): DetailSectionId[] {
  const from = order.indexOf(fromId);
  const to = order.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}
