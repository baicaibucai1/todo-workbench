/**
 * 本地时刻与 `<input type="datetime-local">` 之间的转换，以及它的人话写法。
 *
 * 单独一个文件不是洁癖：待办详情里的「提醒」、子任务行的「到期时间」、
 * 列表展开里的子任务胶囊，三处都要把同一个 ISO 串变成「今天 14:30」，
 * 各写一份的话，改一次文案就要翻三个文件。
 */

import { today } from "./repo";

/**
 * ISO → datetime-local 的 value 格式（"YYYY-MM-DDTHH:mm"）。
 *
 * 这个格式**没有时区后缀**，浏览器按本地时区解析，正好和我们要的语义一致：
 * 用户填的是他墙上的钟点，不是 UTC。
 */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local 的 value → ISO。空值返回 null（表示"没设"） */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 时刻的人话：「今天 14:30」/「9月22日 14:30」。
 *
 * 同一天只给钟点不说日期 —— 说的是"几点"，不是"哪一天几点"，
 * 今天的日期对用户是冗余信息，占了宽度反而把时间挤没了。
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return isoToLocalInput(iso).slice(0, 10) === today()
    ? `今天 ${hm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
